const crypto = require("node:crypto");
const { codexApiMetadata } = require('./deepseek-compat.cjs');
const { DEFAULT_OUTPUT_TOKENS } = require('./output-tokens.cjs');
const { CONFIG_LIMITS, checkSize, validateProviders } = require('./config-limits.cjs');
const { tail, inferProtocol, contextDefault } = require("./presets.cjs");
const { normalizeBalance } = require("./balance.cjs");
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const PROTOCOLS = ["openai-responses", "openai-chat", "anthropic"];
const normalizeEffort = (x) => (x === "middle" ? "medium" : x);
const displayEffort = (x) => (x === "middle" ? "medium" : x);
// Public gateway model IDs use ASS branding. Keep storage IDs stable so account
// bindings, key identity, test history and old conversations remain intact.
const codexProviderId = (id) => "ASS_" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 24);
const codexModelId = (provider, model) => codexProviderId(provider) + "::" + model;
function defaults(
  provider,
  model,
  officialModels = [],
  wireApi = inferProtocol(provider, model),
) {
  const cached =
    provider.id === "official"
      ? officialModels.find((m) => m.slug === model)
      : null;
  if (cached)
    return {
      contextWindow: cached.context_window || 272000,
      contextSource: "Codex 本机模型目录",
      efforts: (
        cached.supported_reasoning_levels || [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
        ]
      )
        .map((x) => displayEffort(x.effort || x))
        .filter((x) => EFFORTS.includes(x)),
      defaultEffort: displayEffort(cached.default_reasoning_level || "medium"),
    };
  return {
    contextWindow: contextDefault(provider, model, wireApi),
    contextSource: "供应商 / 模型默认值",
    efforts: tail(model).startsWith("gpt") ? [...EFFORTS] : EFFORTS.slice(0, 5),
    defaultEffort: "medium",
  };
}
function normalizeModel(raw, provider, officialModels = []) {
  if (typeof raw === "string") raw = { model: raw };
  if (
    !raw ||
    typeof raw.model !== "string" ||
    !raw.model.trim() ||
    raw.model.length > 250 ||
    /[\x00-\x1f\x7f]/.test(raw.model)
  )
    throw new Error("模型名称无效");
  const wireApi = raw.wireApi || inferProtocol(provider, raw.model);
  const base = defaults(provider, raw.model, officialModels, wireApi);
  if (!PROTOCOLS.includes(wireApi)) throw new Error(`不支持的协议：${wireApi}`);
  const efforts = [
    ...new Set((raw.efforts || base.efforts).map(displayEffort)),
  ].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  if (!efforts.length || efforts.some((x) => !EFFORTS.includes(x)))
    throw new Error("至少选择一个有效思维强度");
  const contextWindow = Number(raw.contextWindow ?? base.contextWindow);
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 4096 ||
    contextWindow > 10000000
  )
    throw new Error("上下文长度须为 4096～10000000 的整数");
  const selected = displayEffort(raw.defaultEffort || base.defaultEffort);
  if (
    raw.displayName != null &&
    (typeof raw.displayName !== "string" ||
      raw.displayName.length > 250 ||
      /[\x00-\x1f\x7f]/.test(raw.displayName))
  )
    throw new Error("显示名称无效");
  return {
    model: raw.model.trim(),
    displayName: raw.displayName?.trim() || raw.model.trim(),
    wireApi,
    contextWindow,
    contextSource:
      raw.contextSource ||
      (raw.contextWindow ? "导入 / 手动配置" : base.contextSource),
    efforts,
    defaultEffort: efforts.includes(selected) ? selected : efforts[0],
    enabled: raw.enabled !== false,
    maxOutputTokens: Math.min(
      contextWindow,
      Math.max(1024, Number(raw.maxOutputTokens) || DEFAULT_OUTPUT_TOKENS),
    ),
  };
}
function normalizeHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error("额外请求头须为 JSON 对象");
    }
  }
  if (Array.isArray(raw) || typeof raw !== "object")
    throw new Error("额外请求头须为 JSON 对象");
  const forbidden =
    /^(host|connection|content-length|transfer-encoding|authorization|proxy-authorization|cookie|chatgpt-account-id|x-api-key)$/i;
  for (const [k, v] of Object.entries(raw))
    if (
      !/^[\w-]+$/.test(k) ||
      forbidden.test(k) ||
      typeof v !== "string" ||
      /[\r\n]/.test(v)
    )
      throw new Error(`无效或受保护的请求头：${k}`);
  return raw;
}
function officialModel(native, override = {}, officialModels = []) {
  return normalizeModel({ model: native.slug, displayName: override.displayName || native.display_name,
    enabled: override.enabled !== false }, { id: 'official', wireApi: 'openai-responses' }, officialModels);
}
function normalizeProvider(raw, officialModels = []) {
  if (!raw || typeof raw !== "object") throw new Error("供应商配置无效");
  if (/[\x00-\x1f\x7f]/.test(String(raw.apiKey || ''))) throw Error('API Key 含无效控制字符');
  const id = raw.id || "ass_" + crypto.randomBytes(6).toString("hex");
  if (!/^[\w-]{1,100}$/.test(id) || id === "official")
    throw new Error("供应商 ID 无效");
  const url = new URL(raw.baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("远程供应商必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("基础地址不能包含凭据、查询或片段");
  const wireApi =
    raw.wireApi === "responses"
      ? "openai-responses"
      : raw.wireApi || "openai-responses";
  if (!PROTOCOLS.includes(wireApi)) throw new Error("供应商协议不支持");
  const p = {
    id,
    name: String(raw.name || id).slice(0, 80),
    brand: String(raw.brand || "generic"),
    baseUrl: url.toString().replace(/\/$/, ""),
    apiKey: String(raw.apiKey || "").trim(),
    wireApi,
    network: ["direct", "direct-doh"].includes(raw.network) ? raw.network : "system",
    extraHeaders: normalizeHeaders(raw.extraHeaders),
    enabled: raw.enabled !== false,
  };
  const list = raw.models?.length
    ? raw.models
    : raw.model
      ? [{ model: raw.model }]
      : [];
  if (!Array.isArray(list) || list.length > CONFIG_LIMITS.models) throw Error('每个供应商的模型数量超过 10000 上限');
  p.models = list.map((m) => normalizeModel(m, p, officialModels));
  p.balance = normalizeBalance(raw.balance);
  if (raw.nativeCatalogInitialized === true) p.nativeCatalogInitialized = true;
  if (Array.isArray(raw.nativeImportedModels)) p.nativeImportedModels = [...new Set(raw.nativeImportedModels
    .filter((m) => typeof m === "string" && m.length <= 250 && !/[\x00-\x1f]/.test(m)))].slice(0, 10000);
  if (new Set(p.models.map((m) => m.model)).size !== p.models.length)
    throw new Error("同一供应商中存在重复模型");
  return p;
}
function parseImport(raw, officialModels = []) {
  if (!raw || !Array.isArray(raw.providers))
    throw new Error("请选择包含 providers 列表的配置 JSON 文件");
  if (raw.providers.length > CONFIG_LIMITS.providers) throw Error('供应商数量超过 100 上限');
  checkSize(JSON.stringify(raw, null, 2));
  const providers = raw.providers.map((p) =>
    normalizeProvider(p, officialModels),
  );
  if (new Set(providers.map((p) => p.id)).size !== providers.length)
    throw new Error("导入文件包含重复供应商 ID");
  validateProviders(providers);
  return providers;
}
function endpoint(base, protocol, suffix = "") {
  const u = new URL(base);
  const root = u.pathname.replace(/\/$/, "");
  const tail =
    protocol === "anthropic"
      ? "messages"
      : protocol === "openai-chat"
        ? "chat/completions"
        : "responses";
  u.pathname = `${/\/v\d+(?:beta\d*)?(?:\/openai)?$/.test(root) ? root : root + "/v1"}/${tail}${suffix}`;
  return u.toString();
}
const DEFAULT_CATALOG_INSTRUCTIONS = 'You are a coding assistant. Follow user instructions and use the provided tools when needed.';
function catalogInstructions(model) {
  const legacy = model.base_instructions, modern = model.model_messages?.instructions_template;
  if ((legacy != null && typeof legacy !== 'string') || (modern != null && typeof modern !== 'string'))
    throw Error(`模型 ${model.slug} 的指令字段必须为字符串`);
  // Older CLIs require the legacy field even when the desktop cache supplies a
  // modern template. Mirror its literal text, including intentional emptiness;
  // never replace native prompts or change their structured metadata.
  if (typeof legacy === 'string') return model;
  return { ...model, base_instructions: typeof modern === 'string' ? modern : DEFAULT_CATALOG_INSTRUCTIONS };
}
function compatibleCatalogModel(model) {
  const entry = catalogInstructions(model);
  // Codex 0.146 requires this flag; newer catalogs no longer emit it. Keep an
  // explicit native value, and use the conservative legacy value when absent.
  if (entry.supports_parallel_tool_calls == null) return { ...entry, supports_parallel_tool_calls: false };
  if (typeof entry.supports_parallel_tool_calls !== 'boolean')
    throw Error(`模型 ${entry.slug} 的 supports_parallel_tool_calls 必须为布尔值`);
  return entry;
}
function makeCatalog(officialModels, providers, overrides = {}) {
  const baseline = {
    slug: "gpt-6-astra",
    display_name: "GPT-6-Astra",
    description: null,
    context_window: 272000,
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    supported_reasoning_levels: ["low", "medium", "high"].map((e) => ({
      effort: e,
      description: e,
    })),
    default_reasoning_level: "medium",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_reasoning_summaries: false,
    supports_parallel_tool_calls: false,
    tool_mode: "direct",
    base_instructions: DEFAULT_CATALOG_INSTRUCTIONS,
  };
  const templates = (officialModels.length ? officialModels : [baseline]).map(
    (m) => ({ ...baseline, ...m }),
  );
  // Native subscription metadata belongs to Codex, including fields added by
  // a newer release. ASS overrides are local UI preferences, never a catalog
  // replacement for official models (even a stale disabled/renamed override).
  // Add only missing legacy fields required by older CLI consumers.
  const models = structuredClone(officialModels.length ? officialModels : templates).map(compatibleCatalogModel);
  const apply = (entry, m) => ({
    ...entry,
    context_window: m.contextWindow,
    max_context_window: m.contextWindow,
    default_reasoning_level: normalizeEffort(m.defaultEffort),
    supported_reasoning_levels: m.efforts.map((e) => ({
      effort: normalizeEffort(e),
      description: `${e}（按上游实际能力）`,
    })),
  });
  const template = { ...baseline,
    ...(models.find((x) => x.slug === "gpt-6-astra") || models[0] || templates[0]) };
  for (const p of providers.filter((p) => p.enabled))
    for (const m of p.models.filter((m) => m.enabled)) {
      const nativeGPT =
        tail(m.model).startsWith("gpt") && m.wireApi === "openai-responses";
      const entry = {
        ...template,
        slug: codexModelId(p.id, m.model),
        display_name: p.name + " / " + m.displayName,
        description: `${p.name} · ${m.wireApi}`,
        visibility: "list",
        supported_in_api: true,
        priority: models.length + 100,
        experimental_supported_tools: [],
        supports_search_tool: false,
        available_access_programs: { cyber: [] },
        upgrade: null,
        model_messages: null,
        base_instructions: DEFAULT_CATALOG_INSTRUCTIONS,
      };
      if (!nativeGPT) {
        entry.tool_mode = "direct";
        entry.apply_patch_tool_type = null;
        entry.shell_type = "shell_command";
        entry.supports_parallel_tool_calls = false;
        entry.input_modalities = ["text"];
        entry.supports_reasoning_summaries = false;
        entry.support_verbosity = false;
        entry.supports_image_detail_original = false;
      }
      models.push(codexApiMetadata(apply(entry, m), p, m));
    }
  return { models };
}
module.exports = {
  officialModel,
  EFFORTS,
  PROTOCOLS,
  normalizeEffort,
  displayEffort,
  defaults,
  normalizeModel,
  normalizeProvider,
  parseImport,
  endpoint,
  makeCatalog,
  catalogInstructions,
  compatibleCatalogModel,
  codexProviderId,
  codexModelId,
};
