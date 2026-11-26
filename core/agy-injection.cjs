const crypto = require("node:crypto");
const path = require("node:path");
const { compactTokenLimit } = require("./context-budget.cjs");
const { modelRef } = require("./client-policy.cjs");

const MIN_CUSTOM_MODEL_VERSION = [1, 5, 13];
const MIN_GATEWAY_VERSION = [1, 5, 5];
const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

function normalizeAgyEfforts(efforts = [], defaultEffort = "") {
  const mapped = [];
  for (const raw of Array.isArray(efforts) ? efforts : []) {
    const val = raw === "middle" ? "medium" : raw === "ultra" ? "max" : String(raw || "").toLowerCase();
    if (AGY_EFFORTS.includes(val) && !mapped.includes(val)) mapped.push(val);
  }
  mapped.sort((a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b));
  const rawDefault = defaultEffort === "middle" ? "medium" : defaultEffort === "ultra" ? "max" : String(defaultEffort || "").toLowerCase();
  const chosenDefault = mapped.includes(rawDefault)
    ? rawDefault
    : mapped.includes("medium")
      ? "medium"
      : mapped[0] || "";
  return { efforts: mapped, defaultEffort: chosenDefault };
}

function agyRouteId(providerId, modelName) {
  const digest = crypto
    .createHash("sha256")
    .update(String(providerId) + "\0" + String(modelName))
    .digest("hex")
    .slice(0, 14);
  const tail = String(modelName)
    .split("/")
    .at(-1)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `ass-${digest}${tail ? "-" + tail : ""}`;
}

function extractAgyModelId(url) {
  const clean = String(url || "").split("?")[0];
  const actionMatch = /:([A-Za-z]+)$/.exec(clean);
  if (!actionMatch) return null;
  const action = actionMatch[1];
  if (!["generateContent", "streamGenerateContent"].includes(action)) return null;
  const beforeAction = clean.slice(0, actionMatch.index);
  const marker = "/models/";
  const last = beforeAction.lastIndexOf(marker);
  if (last < 0) return null;
  const raw = beforeAction.slice(last + marker.length);
  if (!raw || raw.includes("/")) return null;
  try {
    return { modelId: decodeURIComponent(raw), action, stream: action === "streamGenerateContent" };
  } catch {
    return { modelId: raw, action, stream: action === "streamGenerateContent" };
  }
}

function agyModelCatalog(providers = [], capabilities = {}, defaultRef = null) {
  const items = [];
  for (const p of providers) {
    if (!p?.enabled || !p.apiKey) continue;
    for (const m of p.models || []) {
      if (!m?.enabled) continue;
      const routeId = agyRouteId(p.id, m.model);
      const ref = modelRef(p.id, m.model);
      const displayName = m.displayName || m.model;
      const label = `ASS · ${p.name} · ${displayName}`;
      const cap = capabilities[ref] || {};
      const contextWindow =
        Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? Math.floor(m.contextWindow) : 128000;
      const maxTokens = Math.max(4096, compactTokenLimit(contextWindow));
      const maxOutputTokens =
        Number.isFinite(m.maxOutputTokens) && m.maxOutputTokens > 0 ? Math.floor(m.maxOutputTokens) : 16384;
      const { efforts, defaultEffort } = normalizeAgyEfforts(m.efforts, m.defaultEffort);
      const supportsThinking = cap.reasoning !== false && efforts.length > 0;
      items.push({
        routeId,
        ref,
        providerId: p.id,
        providerName: p.name,
        model: m.model,
        displayName,
        label,
        protocol: m.wireApi,
        contextWindow,
        maxTokens,
        maxOutputTokens,
        efforts: supportsThinking ? efforts : [],
        defaultEffort: supportsThinking ? defaultEffort : "",
        features: {
          supportsImages: cap.vision === true,
          supportsToolCalls: cap.tools !== false,
          supportsThinking,
        },
      });
    }
  }
  if (defaultRef) {
    const idx = items.findIndex((item) => item.ref === defaultRef || item.routeId === defaultRef);
    if (idx > 0) {
      const [chosen] = items.splice(idx, 1);
      items.unshift(chosen);
    }
  }
  return items;
}

function defaultAgyModelId(item) {
  if (!item) return "";
  if (Array.isArray(item.efforts) && item.efforts.length >= 2 && item.defaultEffort) {
    return `${item.routeId}-${item.defaultEffort}`;
  }
  return item.routeId;
}

function agyGatewayModels(providers = [], capabilities = {}, defaultRef = null) {
  const catalog = agyModelCatalog(providers, capabilities, defaultRef);
  const out = [];
  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i];
    if (item.efforts.length >= 2) {
      // Order the first (default) model's defaultEffort first so Desktop selects it initially,
      // while Antigravity still groups all sibling effort variants into one model picker entry.
      const ordered =
        i === 0 && item.defaultEffort
          ? [item.defaultEffort, ...item.efforts.filter((e) => e !== item.defaultEffort)]
          : item.efforts;
      for (const effort of ordered) {
        out.push({
          ...item,
          id: `${item.routeId}-${effort}`,
          baseRouteId: item.routeId,
          displayLabel: `${item.label} (${EFFORT_LABELS[effort] || effort})`,
          effort,
          thinking: true,
        });
      }
    } else {
      out.push({
        ...item,
        id: item.routeId,
        baseRouteId: item.routeId,
        displayLabel: item.label,
        effort: item.efforts[0] || null,
        thinking: item.efforts.length === 1,
      });
    }
  }
  return out;
}

function resolveAgyModel(modelId, state, { allowFuzzy = false } = {}) {
  const clean = String(modelId || "").trim().replace(/^models\//, "");
  if (!clean) {
    throw Object.assign(Error("请求缺少模型标识"), { status: 400 });
  }
  const providers = (state?.providers || []).filter((p) => p?.enabled);
  const all = [];
  for (const p of providers) {
    for (const m of p.models || []) {
      if (!m?.enabled) continue;
      all.push({ provider: p, model: m, routeId: agyRouteId(p.id, m.model) });
    }
  }

  const exact = all.filter((entry) => entry.routeId === clean);
  if (exact.length > 1) {
    throw Object.assign(Error("Antigravity 模型路由标识冲突，请检查供应商配置"), { status: 409 });
  }
  if (exact.length === 1) {
    const { provider, model, routeId } = exact[0];
    if (!provider.apiKey) throw Object.assign(Error("供应商缺少 API Key"), { status: 401 });
    return { provider, model, routeId, baseRouteId: routeId, effort: null };
  }

  // Match effort-suffixed Gateway model IDs: <baseRouteId>-(low|medium|high|xhigh|max)
  const effortMatch = /-(low|medium|high|xhigh|max)$/.exec(clean);
  if (effortMatch) {
    const baseId = clean.slice(0, effortMatch.index);
    const requestedEffort = effortMatch[1];
    const byBase = all.filter((entry) => entry.routeId === baseId);
    if (byBase.length > 1) {
      throw Object.assign(Error("Antigravity 模型路由标识冲突，请检查供应商配置"), { status: 409 });
    }
    if (byBase.length === 1) {
      const { provider, model, routeId } = byBase[0];
      if (!provider.apiKey) throw Object.assign(Error("供应商缺少 API Key"), { status: 401 });
      return { provider, model, routeId: clean, baseRouteId: routeId, effort: requestedEffort };
    }
  }

  if (allowFuzzy) {
    const lower = clean.toLowerCase();
    const byRef = all.filter(
      ({ provider: p, model: m }) =>
        modelRef(p.id, m.model) === clean ||
        `${p.id}::${m.model}` === clean ||
        `${p.name}::${m.model}`.toLowerCase() === lower,
    );
    if (byRef.length === 1) {
      const { provider, model, routeId } = byRef[0];
      if (!provider.apiKey) throw Object.assign(Error("供应商缺少 API Key"), { status: 401 });
      return { provider, model, routeId, baseRouteId: routeId, effort: null };
    }
    const byName = all.filter(({ provider: p, model: m }) => {
      const displayName = m.displayName || m.model;
      const label = `ASS · ${p.name} · ${displayName}`;
      return (
        m.model.toLowerCase() === lower ||
        displayName.toLowerCase() === lower ||
        label.toLowerCase() === lower
      );
    });
    if (byName.length === 1) {
      const { provider, model, routeId } = byName[0];
      if (!provider.apiKey) throw Object.assign(Error("供应商缺少 API Key"), { status: 401 });
      return { provider, model, routeId, baseRouteId: routeId, effort: null };
    }
    if (byName.length > 1) {
      const hints = byName.map((e) => `${e.routeId} (${e.provider.name} / ${e.model.model})`).join(", ");
      throw Object.assign(Error(`模型名称「${clean}」匹配到多个供应商，请指定 routeId：${hints}`), { status: 409 });
    }
  }

  if (!allowFuzzy && !clean.startsWith("ass-")) {
    throw Object.assign(
      Error(`模型 ${clean} 不是 ASS 注入模型；请在 agy 中执行 /model 选择「ASS · ...」模型`),
      { status: 400 },
    );
  }
  throw Object.assign(Error("所选 ASS 模型未启用或已移除；请检查 ASS 供应商接入配置"), { status: 404 });
}

function resolveAgyRoute(url, state) {
  const parsed = extractAgyModelId(url);
  if (!parsed) throw Object.assign(Error("未知 Antigravity Gemini 路由"), { status: 404 });
  const resolved = resolveAgyModel(parsed.modelId, state);
  return { ...resolved, stream: parsed.stream };
}

function versionAtLeast(versionText, minVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(versionText || "").trim());
  if (!match) return false;
  const current = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minVersion[i]) return current[i] > minVersion[i];
  }
  return true;
}

function versionSupported(versionText) {
  return versionAtLeast(versionText, MIN_CUSTOM_MODEL_VERSION);
}

function gatewayVersionSupported(versionText) {
  return versionAtLeast(versionText, MIN_GATEWAY_VERSION);
}

function agyGatewayEnv({ port = 25819, localToken, wireProtocol = "genai" }) {
  if (!localToken || typeof localToken !== "string") {
    throw Error("缺少本机路由凭据");
  }
  if (!["genai", "openai"].includes(wireProtocol)) {
    throw Error("无效 Gateway 协议：" + wireProtocol);
  }
  return {
    AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${port}/clients/agy`,
    AGY_LLM_GATEWAY_API_KEY: localToken,
    AGY_LLM_GATEWAY_WIRE_PROTOCOL: wireProtocol,
  };
}

function agyLaunch({
  port = 25819,
  localToken,
  providers = [],
  defaultRef = null,
  capabilities = {},
  wireProtocol = "genai",
}) {
  if (!localToken || typeof localToken !== "string") {
    throw Error("缺少本机路由凭据");
  }
  const base = `http://127.0.0.1:${port}/clients/agy`;
  const catalog = agyModelCatalog(providers, capabilities, defaultRef);
  if (!catalog.length) {
    throw Error("Antigravity 接入列表中没有可用的已启用模型；请先添加供应商并开启接入");
  }

  const customModels = {};
  const defaultEntry = catalog[0];
  for (const item of catalog) {
    customModels[item.routeId] = {
      modelName: `gemini-api://127.0.0.1:${port}/clients/agy/models/${item.routeId}`,
      label: item.label,
      maxTokens: item.maxTokens,
      toolFormatterType: "TOOL_FORMATTER_TYPE_NONE",
      modelFeatures: {
        supportsImages: item.features.supportsImages,
        supportsVideo: false,
        supportsPdf: false,
        supportsAudio: false,
        supportsToolCalls: item.features.supportsToolCalls,
        supportsThinking: item.features.supportsThinking,
        zeroShotCapable: true,
      },
    };
  }

  const settings = {
    modelProvider: "gemini",
    customModelsConfig: { customModels },
  };
  const gatewayEnv = agyGatewayEnv({ port, localToken, wireProtocol });
  const defaultGatewayRouteId = defaultAgyModelId(defaultEntry);

  return {
    env: {
      GEMINI_API_KEY: localToken,
      GOOGLE_GEMINI_BASE_URL: base,
    },
    gatewayEnv,
    settings,
    args: ["--settings", JSON.stringify(settings), "--model", defaultEntry.routeId],
    gatewayArgs: ["--model", defaultGatewayRouteId],
    defaultModel: defaultEntry.label,
    defaultRouteId: defaultEntry.routeId,
    defaultGatewayRouteId,
    modelCount: catalog.length,
    models: catalog,
  };
}

function agyDesktopLaunch({
  executable,
  dataDir,
  port = 25819,
  localToken,
  providers = [],
  defaultRef = null,
  capabilities = {},
  wireProtocol = "genai",
  launchEnv = process.env,
}) {
  if (!executable || !path.isAbsolute(executable)) {
    throw Error("未找到 Antigravity 桌面版（Antigravity.exe），请先安装并重新自动识别");
  }
  const baseName = path.basename(executable).toLowerCase();
  if (baseName !== "antigravity.exe") {
    throw Error("仅 Antigravity 桌面版（Antigravity.exe）支持官方 Gateway 模型下拉框；独立 Antigravity IDE 暂不支持");
  }
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw Error("缺少有效的 ASS 数据目录");
  }
  const launch = agyLaunch({
    port,
    localToken,
    providers,
    defaultRef,
    capabilities,
    wireProtocol,
  });
  const profileDir = path.join(dataDir, "antigravity-desktop-gateway");
  const env = { ...(launchEnv || {}) };
  for (const key of Object.keys(env)) {
    if (/^(AGY_LLM_GATEWAY_|GEMINI_API_KEY$|GOOGLE_GEMINI_BASE_URL$|ELECTRON_RUN_AS_NODE$|NODE_TLS_REJECT_UNAUTHORIZED$)/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, launch.gatewayEnv);
  return {
    executable,
    args: [`--user-data-dir=${profileDir}`],
    env,
    profileDir,
    defaultModel: launch.defaultModel,
    defaultRouteId: launch.defaultRouteId,
    defaultGatewayRouteId: launch.defaultGatewayRouteId,
    modelCount: launch.modelCount,
  };
}

module.exports = {
  MIN_CUSTOM_MODEL_VERSION,
  MIN_GATEWAY_VERSION,
  AGY_EFFORTS,
  EFFORT_LABELS,
  normalizeAgyEfforts,
  agyRouteId,
  extractAgyModelId,
  agyModelCatalog,
  agyGatewayModels,
  defaultAgyModelId,
  resolveAgyModel,
  resolveAgyRoute,
  versionSupported,
  gatewayVersionSupported,
  agyGatewayEnv,
  agyLaunch,
  agyDesktopLaunch,
};
