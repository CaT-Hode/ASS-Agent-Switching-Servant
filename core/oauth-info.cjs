// Official read-only account endpoints. This module never refreshes/replaces a
// grant, redeems credits, creates API keys, or changes the selected native user.
const path = require("node:path");
const { readDesktopJson } = require("./desktop-metadata.cjs");
const { subscriptionProvider } = require("./subscription-usage.cjs");
const zcodeInfo = require("./zcode-account-info.cjs");
const antigravityQuota = require("./antigravity-quota.cjs");
const KIMI_BASES = new Set(["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"]);
const version = (v) => typeof v === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(v) ? v : null;
const number = (v) => (typeof v === "number" || typeof v === "string" && v.trim() !== "") && Number.isFinite(Number(v)) ? Number(v) : null;
const positive = (v) => { const n = number(v); return n !== null && n >= 0 ? n : null; };
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const list = (v) => Array.isArray(v) ? v.slice(0, 100) : [];
const startPlanSuccess = (payload) => object(payload) && payload.success !== false &&
  (payload.code === undefined || payload.code === 0 || payload.code === 200);
const time = (v) => {
  const ms = typeof v === "number" || typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) * 1000 : Date.parse(v);
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : undefined;
};
const OFFICIAL_GLM_IDS = ["GLM-5.3", "GLM-5.3-Flash", "GLM-5V-Turbo", "GLM-5.2", "GLM-5.1",
  "GLM-5.1-Highspeed", "GLM-5", "GLM-5-Turbo", "GLM-4.7", "GLM-4.7-FlashX", "GLM-4.7-Flash",
  "GLM-4.6", "GLM-4.5-Air", "GLM-4.5", "GLM-4.6V", "GLM-4.6V-Flash", "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX", "GLM-4.1V-Thinking-Flash", "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414", "GLM-4V-Flash"];
const OFFICIAL_GLM_BY_LOWER = new Map(OFFICIAL_GLM_IDS.map((id) => [id.toLowerCase(), id]));
const cleanModelId = (value) => {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > 250 || /[\x00-\x1f\x7f]/.test(id)) return "";
  return OFFICIAL_GLM_BY_LOWER.get(id.toLowerCase()) || id;
};
function startPlanEntitlement(payload, { now = Date.now(), responseTime } = {}) {
  if (!startPlanSuccess(payload) || !object(payload.data) || !Array.isArray(payload.data.plans) ||
      !Array.isArray(payload.data.balances)) throw Error("Start Plan 接口未返回完整套餐资料");
  const d = payload.data;
  const timestamp = Number.isFinite(responseTime) ? responseTime : number(d.server_time) !== null
    ? Number(d.server_time) * 1000 : now;
  const plans = list(d.plans).map((plan) => {
    if (!object(plan)) return plan;
    const end = time(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" && end && Date.parse(end) <= timestamp
      ? { ...plan, status: "expired" } : plan;
  });
  const active = plans.filter((plan) => {
    if (plan?.status?.trim().toLowerCase() !== "active") return false;
    const planId = typeof plan.plan_id === "string" ? plan.plan_id.trim().toLowerCase() : "";
    const name = typeof plan.name === "string" ? plan.name.trim().toLowerCase() : "";
    return !planId && !name || [planId, name].some((value) => value.includes("start-plan") || value.includes("start plan"));
  });
  if (!active.length) return { status: "unavailable", models: [] };
  const balances = list(d.balances).filter((balance) => {
    if (!object(balance)) return false;
    const owners = plans.filter((plan) => balance.user_plan_id && plan?.user_plan_id
      ? plan.user_plan_id === balance.user_plan_id : plan?.plan_id === balance.plan_id);
    return !owners.length || owners.some((plan) => plan?.status?.trim().toLowerCase() !== "expired");
  });
  const seen = new Set(), models = [];
  for (const balance of balances) {
    const fromCapabilities = (Array.isArray(balance.capabilities) ? balance.capabilities : [])
      .map((capability) => typeof capability === "string" && capability.trim().toLowerCase().startsWith("model:")
        ? capability.trim().slice("model:".length).trim() : "").filter(Boolean);
    const candidates = fromCapabilities.length ? fromCapabilities : [balance.show_name || ""];
    for (const candidate of candidates) {
      const id = cleanModelId(candidate), key = id.toLowerCase();
      if (!id || seen.has(key)) continue;
      seen.add(key); models.push(id);
    }
  }
  const effectiveTimes = active.flatMap((plan) => Array.isArray(plan.entitlements) && plan.entitlements.length
    ? plan.entitlements.map((entry) => entry?.effective_at) : [plan.starts_at])
    .map((value) => value === null || value === undefined || value === "" ? undefined : Number(value));
  if (!models.length && effectiveTimes.length && effectiveTimes.every((value) =>
    value !== undefined && Number.isFinite(value) && value * 1000 > timestamp)) {
    return { status: "pending", models: [], effectiveAt: new Date(Math.min(...effectiveTimes) * 1000).toISOString() };
  }
  return models.length ? { status: "available", models } : { status: "available" };
}
function zcodeVersion(manager) {
  // Bypass Electron's cached ASAR handles, including during path checks. Do not
  // run an executable or invent an app_version for the entitlement request.
  const launcher = manager.launcher("zcode") || {};
  if (version(launcher.version)) return launcher.version;
  const exe = launcher.desktopExecutable;
  if (!exe) return null;
  for (const relative of ["resources/app.asar/out/metadata/build-meta.json", "resources/app/out/metadata/build-meta.json"]) {
    const file = path.join(path.dirname(exe), relative);
    const v = readDesktopJson(file, 128 * 1024).appVersion;
    if (version(v)) return v;
  }
  for (const relative of ["resources/app.asar/package.json", "resources/app/package.json"]) {
    const file = path.join(path.dirname(exe), relative);
    const manifest = readDesktopJson(file, 128 * 1024);
    if (manifest.name === "@zcode/desktop" && version(manifest.version)) return manifest.version;
  }
  return null;
}
function historyProvider(history, manager, harness, recordId) {
  if (!history) return null;
  let entry;
  try { entry = history.lookup(harness, recordId); } catch { return null; }
  const id = `native-info:${harness}:oauth-record:${recordId}`, grant = entry.grant;
  if (!["kimi", "zcode"].includes(harness)) return subscriptionProvider(harness, entry.provider, grant, id);
  const q = entry.query;
  if (!q || (harness === "kimi" ? q.kind !== "kimi-code" || !KIMI_BASES.has(q.baseUrl)
    : !["zcode-start", "zcode-account"].includes(q.kind) || q.baseUrl !== "https://zcode.z.ai")) return null;
  const apiKey = harness === "kimi" ? grant.access_token : grant.session_token;
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 65536) return null;
  const appVersion = harness === "zcode" ? zcodeVersion(manager) : undefined;
  const extra = q.kind === "zcode-account" ? { family: entry.provider, oauthAccess: grant.access_token,
    coding: (Array.isArray(grant.coding) ? grant.coding : []).map(zcodeInfo.context).filter(Boolean).slice(0, 2) } : {};
  const p = { id, subscriptionKind: q.kind, baseUrl: q.baseUrl, apiKey, network: "system", models: [], appVersion, ...extra };
  p.queryBlocked = harness === "zcode" && !appVersion && !zcodeInfo.requests(p).length
    ? "识别 ZCode Desktop 版本或 Coding Plan 连接后可查询额度" : "";
  return p;
}
function adapter(p) {
  if (p.subscriptionKind === antigravityQuota.KIND && p.executable) return antigravityQuota.KIND;
  return p.subscriptionKind === "kimi-code" && KIMI_BASES.has(p.baseUrl) ? "kimi-code"
    : ["zcode-start", "zcode-account"].includes(p.subscriptionKind) && p.baseUrl === "https://zcode.z.ai" ? p.subscriptionKind : null;
}
function profile(p) {
  const kind = adapter(p);
  if (!kind) return null;
  if (kind === antigravityQuota.KIND)
    return { source: "Antigravity CLI · 上次查询", fields: [], docs: ["antigravity"], canRefresh: true };
  return { source: "官方接口 · 上次查询", fields: [], docs: [kind === "kimi-code" ? "kimi-info" : "zcode-info"],
    canRefresh: !!p.apiKey && !p.queryBlocked && (kind === "kimi-code" || !!version(p.appVersion) || kind === "zcode-account" && zcodeInfo.requests(p).length > 0),
    note: p.queryBlocked || (kind.startsWith("zcode-") ? "Start Plan、个人 / 团队 Coding Plan 和 MCP 额度分别读取，不合并计量单位。" : "按当前授权查询账户资料与编程额度，不发送模型请求。") };
}
function requests(p) {
  const kind = adapter(p);
  if (kind === antigravityQuota.KIND) return antigravityQuota.requests(p);
  if (kind === "kimi-code") return [{ section: "identity", url: p.baseUrl + "/me" }, { section: "usage", url: p.baseUrl + "/usages" }];
  if (kind?.startsWith("zcode-")) {
    const result = version(p.appVersion) ? [{ section: "usage", label: "Start Plan 额度", url:
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=" + encodeURIComponent(p.appVersion) }] : [];
    if (kind === "zcode-account") result.push(...zcodeInfo.requests(p));
    if (result.length) return result;
  }
  throw Error("账户接口或客户端版本尚未适配");
}
function parseResponse(kind, request, response, options) {
  if (kind === antigravityQuota.KIND) return antigravityQuota.parseQuota(request.section, response.data);
  return request.run ? zcodeInfo.parse(request, response, options)
    : parse(kind === "zcode-account" ? "zcode-start" : kind, request.section, response.data, { ...options, responseTime: response.responseTime });
}
function modelEntitlement(kind, request, response, options) {
  if (!["zcode-start", "zcode-account"].includes(kind) || request.run || request.section !== "usage") return null;
  return startPlanEntitlement(response.data, { ...options, responseTime: response.responseTime });
}
function parse(kind, section, payload, { safeText, now = Date.now(), responseTime } = {}) {
  if (!object(payload)) throw Error("账户资料格式无效");
  const fields = [], add = (id, label, value, extra = {}) => {
    const v = safeText(value); if (v !== undefined && v !== null && v !== "") fields.push({ id, label, value: v, ...extra });
  };
  const amount = (id, label, value, unit = "") => {
    const n = positive(value); if (n !== null) add(id, label, String(n), { kind: "amount", unit: safeText(unit) || "" });
  };
  const date = (id, label, value) => { const iso = time(value); if (iso) add(id, label, iso, { kind: "date" }); };
  const quota = (id, label, usedPercent, reset) => fields.push({ id: "quota-" + id, label, kind: "quota", value: String(usedPercent),
    usedPercent, remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)), resetsAt: time(reset) });
  if (kind === "kimi-code" && section === "identity") {
    if (!safeText(payload.user_id)) throw Error("账户资料缺少用户 ID");
    for (const [id, label, key] of [["accountId", "用户 ID", "user_id"], ["email", "邮箱", "email"], ["name", "名称", "nickname"],
      ["plan", "会员等级", "user_level_name"], ["region", "服务区域", "region"], ["status", "账户状态", "status"]]) add(id, label, payload[key]);
    date("created", "注册时间", payload.created_time); date("lastLogin", "上次登录", payload.last_login_time);
  } else if (kind === "kimi-code") {
    for (const [key, label] of [["limit_5h", "5h"], ["limit_7d", "周"], ["limit_month_total", "月度总额度"], ["limit_month_code", "月度编程额度"]]) {
      const w = payload.usages?.[key], ratio = positive(w?.used_ratio);
      if (ratio !== null && Number.isFinite(ratio * 100)) quota(key, label, ratio * 100, w.reset_time);
    }
    const wallet = payload.boosterWallet;
    if (wallet?.balance?.type === "BOOSTER") {
      // The wire amount is fixed-point cents (1e6 units per cent). Missing
      // amountLeft is unknown, never zero; do not invent a default currency.
      const currency = safeText(wallet.monthlyChargeLimit?.currency || wallet.monthlyUsed?.currency);
      if (currency) {
        const left = positive(wallet.balance.amountLeft), total = positive(wallet.balance.amount);
        if (left !== null) amount("balance-booster", "加量包余额", left / 1e8, currency);
        if (total !== null) amount("booster-total", "加量包总额", total / 1e8, currency);
        const used = positive(wallet.monthlyUsed?.priceInCents);
        if (used !== null) amount("booster-used", "本月加量支出", used / 100, currency);
        if (wallet.monthlyChargeLimitEnabled === true) {
          const cap = positive(wallet.monthlyChargeLimit?.priceInCents);
          if (cap !== null) amount("booster-limit", "每月加量上限", cap / 100, currency);
        }
      }
    }
  } else if (kind === "zcode-start") {
    if (!startPlanSuccess(payload) || !object(payload.data) || !Array.isArray(payload.data.plans) || !Array.isArray(payload.data.balances))
      throw Error("Start Plan 接口未返回完整套餐资料");
    const d = payload.data, timestamp = Number.isFinite(responseTime) ? responseTime : number(d.server_time) !== null ? Number(d.server_time) * 1000 : now;
    const plans = list(d.plans).filter((p) => p?.status?.trim().toLowerCase() === "active" &&
      (!time(p.ends_at) || Date.parse(time(p.ends_at)) > timestamp));
    if (!plans.length) add("plan-status", "Start Plan", "无有效套餐");
    for (const [i, p] of plans.entries()) {
      const label = safeText(p.name) || "Start Plan";
      add(i === 0 ? "plan" : "plan-" + i, "套餐", label);
      date("plan-expiry-" + i, label + "到期", p.ends_at);
    }
    for (const [i, b] of list(d.balances).entries()) {
      if (!object(b)) continue;
      const owners = plans.filter((p) => b.user_plan_id && p.user_plan_id ? p.user_plan_id === b.user_plan_id : !!b.plan_id && b.plan_id === p.plan_id);
      if (owners.length !== 1) continue;
      const expiry = time(b.expires_at); if (expiry && Date.parse(expiry) <= timestamp) continue;
      const label = safeText(b.show_name) || safeText(b.entitlement_id) || `额度 ${i + 1}`;
      const total = positive(b.total_units), remaining = positive(b.remaining_units);
      amount("balance-bucket-" + i, label + "剩余", b.remaining_units, b.unit_type);
      amount("bucket-total-" + i, label + "总额", b.total_units, b.unit_type);
      amount("bucket-used-" + i, label + "已用", b.used_units, b.unit_type);
      // available_units deducts in-flight reservations and is NOT remaining.
      if (total > 0 && remaining !== null) quota("bucket-" + i, label, Math.max(0, (1 - remaining / total) * 100), b.expires_at);
    }
    const entitlement = startPlanEntitlement(payload, { now, responseTime });
    if (entitlement.status === "pending") {
      add("start-model-status", "模型权益", "待生效");
      date("start-model-effective", "权益生效", entitlement.effectiveAt);
    } else if (entitlement.status === "available" && Array.isArray(entitlement.models)) {
      add("start-model-count", "可用模型", entitlement.models.length + " 个");
      add("start-models", "模型范围", entitlement.models.join(" · "));
    } else if (entitlement.status === "available") {
      add("start-model-status", "模型权益", "有效（接口未限定模型白名单）");
    }
  }
  if (!fields.length) throw Error("接口未返回可识别的账户资料");
  return fields;
}
module.exports = { historyProvider, zcodeVersion, adapter, profile, requests, parse, parseResponse,
  modelEntitlement, startPlanEntitlement };
