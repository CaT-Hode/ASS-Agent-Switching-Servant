const BALANCE_PRESETS = [
  {
    id: "auto",
    name: "自动识别",
    path: "",
    field: "",
    unit: "",
    description:
      "官方域名优先；通用中转尝试 NewAPI、Sub2API。仅向当前供应商同源地址发送 Key。",
  },
  {
    id: "newapi",
    name: "NewAPI · Token Usage",
    path: "/api/usage/token",
    field: "data.total_available",
    unit: "USD",
    description: "读取 token 的可用额度，不是整个账户余额。",
  },
  {
    id: "sub2api",
    name: "Sub2API · Usage",
    path: "/v1/usage",
    field: "remaining",
    unit: "",
    description:
      "兼容 remaining、data.remaining、quota.remaining、usage.remaining；单位以响应为准。",
  },
  {
    id: "deepseek",
    name: "DeepSeek · 官方余额",
    path: "/user/balance",
    field: "balance_infos",
    unit: "",
    description: "按货币分别显示 total_balance，不混加不同币种。",
  },
  {
    id: "stepfun",
    name: "StepFun · 官方余额",
    path: "/v1/accounts",
    field: "balance",
    unit: "CNY",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow · 官方余额",
    path: "/v1/user/info",
    field: "data.balance",
    unit: "CNY",
    description: "兼容 totalBalance；国际站使用 USD。",
  },
  {
    id: "openrouter",
    name: "OpenRouter · Credits",
    path: "/api/v1/credits",
    field: "data.total_credits - data.total_usage",
    unit: "USD",
    description: "总购入额度减已用额度；可能需要管理 Key。",
  },
  {
    id: "novita",
    name: "Novita AI · 官方余额",
    path: "/openapi/v1/billing/balance/detail",
    field: "availableBalance",
    scale: 0.0001,
    unit: "USD",
  },
  {
    id: "kimi",
    name: "Kimi · 官方余额",
    path: "/v1/users/me/balance",
    field: "data.available_balance",
    unit: "CNY",
  },
  {
    id: "kimi-plan",
    name: "Kimi Coding Plan · 用量",
    path: "/coding/v1/usages",
    field: "usage / limits",
    unit: "%",
    description: "显示套餐剩余百分比，不代表现金余额。",
  },
  {
    id: "minimax-plan",
    name: "MiniMax Token Plan · 用量",
    path: "/v1/api/openplatform/coding_plan/remains",
    field: "model_remains",
    unit: "%",
    description: "显示 5 小时 / 周剩余比例，不代表现金余额。",
  },
  {
    id: "custom",
    name: "自定义 GET 接口",
    path: "",
    field: "total_available",
    unit: "USD",
  },
];
function isOpenAIApi(provider) {
  try {
    const u = new URL(provider.baseUrl);
    return u.origin === 'https://api.openai.com' &&
      !u.username && !u.password && !u.search && !u.hash && /^\/(?:v1\/?)?$/.test(u.pathname);
  } catch { return false; }
}
function canQueryBalance(provider) {
  const config = normalizeBalance(provider.balance);
  return config.preset !== 'auto' || !isOpenAIApi(provider);
}
const preset = (id) => BALANCE_PRESETS.find((p) => p.id === id);
function normalizeBalance(raw = {}) {
  const id = raw.preset || (raw.path ? "custom" : "auto");
  if (!preset(id)) throw new Error("余额预设无效");
  const p = preset(id);
  const b = {
    preset: id,
    path: raw.path ?? p.path,
    field: raw.field ?? p.field,
    unit: raw.unit ?? p.unit,
    scale: Number(raw.scale ?? p.scale ?? 1),
    auth: raw.auth || "bearer",
  };
  if (
    typeof b.path !== "string" ||
    (b.path &&
      (!b.path.startsWith("/") ||
        b.path.startsWith("//") ||
        b.path.includes("\\") ||
        /[\r\n]/.test(b.path)))
  )
    throw new Error("余额接口须为当前供应商域名下的绝对路径");
  if (!Number.isFinite(b.scale) || b.scale <= 0)
    throw new Error("余额换算系数须大于 0");
  if (!["bearer", "x-api-key"].includes(b.auth))
    throw new Error("余额认证方式无效");
  return b;
}
function detect(provider) {
  const u = new URL(provider.baseUrl),
    h = u.hostname;
  if (h === "api.deepseek.com") return ["deepseek"];
  if (h === "api.stepfun.com") return ["stepfun"];
  if (["api.siliconflow.cn", "api.siliconflow.com"].includes(h))
    return ["siliconflow"];
  if (h === "openrouter.ai") return ["openrouter"];
  if (h === "api.novita.ai") return ["novita"];
  if (["api.moonshot.cn", "api.moonshot.ai"].includes(h)) return ["kimi"];
  if (h === "api.kimi.com" && u.pathname.startsWith("/coding"))
    return ["kimi-plan"];
  if (["api.minimaxi.com", "api.minimax.io"].includes(h))
    return ["minimax-plan"];
  return ["newapi", "sub2api"];
}
function read(data, path) {
  return path
    .split(".")
    .filter(Boolean)
    .reduce(
      (v, k) =>
        ["__proto__", "constructor", "prototype"].includes(k)
          ? undefined
          : v?.[k],
      data,
    );
}
function number(value) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === "" ||
    !Number.isFinite(Number(value))
  )
    throw new Error("接口缺少有效数值，未将缺失字段视为 0");
  return Number(value);
}
function first(data, paths) {
  for (const p of paths) {
    const v = read(data, p);
    if (v !== undefined && v !== null) return v;
  }
}
function parseBalance(id, data, config, host = "") {
  if (data?.success === false || data?.base_resp?.status_code)
    throw new Error("余额接口返回业务错误");
  const rows = [];
  const add = (label, value, unit) =>
    rows.push({ label, value: number(value), unit: unit || "" });
  const p = preset(id);
  let unit = p.unit;
  if (
    (id === "kimi" && host.endsWith(".ai")) ||
    (id === "siliconflow" && host.endsWith(".com"))
  )
    unit = "USD";
  switch (id) {
    case "deepseek":
      for (const row of data.balance_infos || [])
        add("可用余额", row.total_balance, row.currency);
      break;
    case "newapi":
      add(
        "Token 可用额度",
        first(data, ["data.total_available", "total_available"]),
        unit,
      );
      break;
    case "sub2api":
      add(
        "剩余额度",
        first(data, [
          "remaining",
          "data.remaining",
          "quota.remaining",
          "usage.remaining",
        ]),
        first(data, ["unit", "quota.unit", "data.unit"]) || "额度",
      );
      break;
    case "stepfun":
      add("可用余额", data.balance, unit);
      break;
    case "siliconflow":
      add("可用余额", first(data, ["data.balance", "data.totalBalance"]), unit);
      break;
    case "kimi":
      add("可用余额", read(data, "data.available_balance"), unit);
      break;
    case "novita":
      add("可用余额", number(data.availableBalance) / 10000, unit);
      break;
    case "openrouter": {
      const d = data.data || data;
      add(
        "剩余 Credits",
        number(d.total_credits) - number(d.total_usage),
        unit,
      );
      break;
    }
    case "minimax-plan": {
      for (const r of data.model_remains || []) {
        if (r.current_interval_remaining_percent !== undefined)
          add(
            `${r.model_name || "套餐"} · 5h 剩余`,
            r.current_interval_remaining_percent,
            "%",
          );
      }
      const week = data.current_weekly_status?.current_weekly_remaining_percent;
      if (week !== undefined) add("周剩余", week, "%");
      break;
    }
    case "kimi-plan": {
      const tiers = [
        ...(data.usage ? [{ label: "套餐", detail: data.usage }] : []),
        ...(data.limits || []).map((r, i) => ({
          label: r.window?.duration
            ? `${r.window.duration}${r.window.timeUnit || ""}`
            : `窗口 ${i + 1}`,
          detail: r.detail || r.usage || r,
        })),
      ];
      for (const r of tiers) {
        const d = r.detail,
          limit = number(d.limit);
        if (limit > 0)
          add(`${r.label} · 剩余`, (number(d.remaining) / limit) * 100, "%");
      }
      break;
    }
    case "custom":
      add("余额", number(read(data, config.field)) * config.scale, config.unit);
      break;
    default:
      throw new Error("未知余额适配器");
  }
  if (!rows.length) throw new Error("接口未返回可识别的余额或套餐用量");
  return {
    ok: true,
    value: rows[0].value,
    unit: rows[0].unit,
    rows,
    adapter: id,
  };
}
async function queryBalance(provider, fetcher) {
  const config = normalizeBalance(provider.balance);
  if (!provider.apiKey) throw new Error("请先填写此供应商的 API Key");
  if (config.preset === 'auto' && isOpenAIApi(provider))
    throw new Error('OpenAI API Key 不提供自动余额查询接口；请查看 OpenAI API 用量或账单');
  const ids = config.preset === "auto" ? detect(provider) : [config.preset];
  let last;
  for (const id of ids) {
    const def = preset(id);
    const route = id === "custom" ? config.path : def.path;
    if (!route) throw new Error("请填写余额接口路径");
    const u = new URL(route, provider.baseUrl);
    if (u.origin !== new URL(provider.baseUrl).origin)
      throw new Error("余额接口必须与供应商同源");
    const headers = { ...provider.extraHeaders, accept: "application/json" };
    headers[config.auth === "x-api-key" ? "x-api-key" : "authorization"] =
      config.auth === "x-api-key"
        ? provider.apiKey
        : "Bearer " + provider.apiKey;
    try {
      const r = await fetcher(
        u.toString(),
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
        provider.network,
      );
      if (!r.ok) throw new Error(`${def.name} HTTP ${r.status}`);
      const text = await r.text();
      if (text.length > 1024 * 1024) throw new Error("余额响应过大");
      return {
        ...parseBalance(id, JSON.parse(text), config, u.hostname),
        time: new Date().toISOString(),
      };
    } catch (e) {
      last = e;
    }
  }
  let message =
    last instanceof SyntaxError
      ? "余额接口返回无效 JSON"
      : last?.message || "查询失败";
  message = message.split(provider.apiKey).join("[REDACTED]");
  throw new Error(message + "；请确认接口类型和 Key 权限");
}
module.exports = {
  BALANCE_PRESETS,
  canQueryBalance,
  isOpenAIApi,
  normalizeBalance,
  detect,
  parseBalance,
  queryBalance,
};
