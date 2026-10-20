// Main-process only. Resolve a row again at click time; the renderer supplies
// neither a file path, URL nor credential. No CLI/helper execution or refresh.
const path = require("node:path");
const TOML = require("@iarna/toml");
const YAML = require("yaml");
const { parse: parseJSONC } = require("jsonc-parser");
const { read: readFile } = require("./native-fields.cjs");
const { nativeModels, nativeTargetId, opencodeProvider } = require("./model-inventory.cjs");
const { nativeOfficialProvider } = require("./native-official.cjs");
const { nativeSubscriptionProvider } = require("./subscription-usage.cjs");
const { kimiSources, readSource, decryptZCode } = require("./additional-oauth.cjs");
const { claims } = require("./account-info.cjs");
const zcodeCatalog = require("./zcode-catalog.cjs");
const zcodeInfo = require("./zcode-account-info.cjs");
const { providerSessionHeaders } = require("./provider-transport.cjs");
const { builtinApi } = require("./native-api-defaults.cjs");
const { memoRead } = require("./read-scope.cjs");
const { inspectConnectionResponse } = require("./connection-diagnostic.cjs");
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const secret = (v) => typeof v === "string" && v.trim() && v.length <= 65536 && !/[\r\n\0]/.test(v) ? v.trim() : "";
const protocols = { kimi: "openai-chat", openai: "openai-chat", openai_legacy: "openai-chat",
  openai_responses: "openai-responses", anthropic: "anthropic", "openai-completions": "openai-chat",
  "openai-chat-completions": "openai-chat", "openai-responses": "openai-responses", "anthropic-messages": "anthropic" };
function read(file, format = "json") {
  return memoRead(read, [file, format], () => readUncached(file, format));
}
function readUncached(file, format) {
  try {
    const raw = readFile(file);
    if (raw === null) return {};
    if (raw.length > 2 * 1024 * 1024) throw Error();
    const errors = [], text = raw.replace(/^\uFEFF/, "");
    const data = format === "toml" ? TOML.parse(text) : format === "yaml"
      ? YAML.parse(text, { maxAliasCount: 20 }) : parseJSONC(text, errors, { allowTrailingComma: true });
    if (errors.length || !object(data)) throw Error();
    return data;
  } catch { throw Error("原生模型配置或凭据无法读取，请在客户端检查"); }
}
function value(raw, env, mode = "literal") {
  if (object(raw) && typeof raw.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.env))
    return secret(env[raw.env]);
  const v = secret(raw);
  if (!v) return "";
  if (v.startsWith("!") || v.includes("{file:") || v.startsWith("$") && mode !== "pi")
    throw Error("此凭据依赖外部命令或文件引用，请在原生客户端测试");
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
  if (match) return secret(env[match[1]]);
  if (mode === "pi" && v.includes("$")) {
    let missing = false;
    const result = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, a, b) => { if (!secret(env[a || b])) missing = true; return secret(env[a || b]); });
    return missing || result.includes("$") ? "" : result;
  }
  if (mode === "pi" && Object.hasOwn(env, v)) return secret(env[v]);
  return v;
}
function headers(raw, env, mode) {
  if (raw == null) return {};
  if (!object(raw)) throw Error("原生模型请求头格式无法识别");
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(k) || typeof v !== "string" || /[\r\n\0]/.test(v))
      throw Error("原生模型请求头格式无法识别");
    if (/^(host|cookie|proxy-authorization|content-length|transfer-encoding|connection)$/i.test(k))
      throw Error("原生模型含不可用于独立检测的请求头");
    result[k.toLowerCase()] = value(v, env, mode);
  }
  return result;
}
function validUrl(base) {
  let u;
  try { u = new URL(base); } catch { throw Error("原生模型未配置有效接口地址"); }
  if (u.username || u.password || u.hash || u.search ||
      !(u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    throw Error("原生模型检测需要 HTTPS 或本机回环接口");
  return u;
}
function requestUrl(base, protocol) {
  const u = validUrl(base), root = u.pathname.replace(/\/+$/, "");
  const prefix = protocol === "anthropic" && !root.endsWith("/v1") ? root + "/v1" : root;
  u.pathname = prefix + (protocol === "anthropic" ? "/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions");
  return u.toString();
}
function notExpired(token, seconds) {
  const expiry = Number(seconds ?? claims(token).exp);
  if (Number.isFinite(expiry) && expiry > 0 && expiry * 1000 <= Date.now())
    throw Error("OAuth 访问令牌已到期，请先在原生客户端刷新登录");
}
function kimiTarget(a, m, env) {
  const config = require('./kimi-model-config.cjs').normalize(read(a.sourcePath, "toml")), p = config.providers?.[m.nativeProvider];
  const rows = config.models.filter((r) => r?.provider === m.nativeProvider && r.model === m.model && (!m.nativeAlias || r.alias === m.nativeAlias));
  if (!object(p) || (m.model && rows.length !== 1)) throw Error("Kimi 模型配置已变化或有重复声明，请刷新目录");
  const environmentIssue = require('./kimi-model-config.cjs').environmentIssue(env);
  if (environmentIssue) throw Error(environmentIssue);
  if ([!!secret(p.api_key), !!secret(p.api_key_env), !!p.oauth].filter(Boolean).length > 1)
    throw Error("Kimi 同一供应商声明了多种凭据，无法确定检测账户");
  let key, base = p.base_url;
  if (p.oauth) {
    const ref = kimiSources({ dir: a.nativeDir }, env).find((r) =>
      r.slot === String(p.oauth.key).replace(/^oauth\//, "") && r.base === String(base).replace(/\/+$/, ""));
    if (!ref) throw Error("Kimi OAuth 区域、地址或凭据存储无法确认");
    const expected = { KIMI_CODE_BASE_URL: ref.base, KIMI_CODE_OAUTH_HOST: ref.host, KIMI_OAUTH_HOST: ref.host };
    if (Object.entries(expected).some(([k, v]) => env[k] && env[k].replace(/\/+$/, "") !== v))
      throw Error("Kimi OAuth 环境地址与此模型不一致，未发送凭据");
    const grant = read(ref.authFile);
    key = secret(grant.access_token); notExpired(key, grant.expires_at);
  } else key = secret(p.api_key) || secret(env[p.api_key_env]);
  const protocol = protocols[rows[0]?.protocol || p.type];
  const extraHeaders = { "user-agent": "ASS/native-model-check", ...headers(p.custom_headers, env) };
  if (p.oauth && Object.keys(extraHeaders).some((k) => /authorization|api-key/i.test(k)))
    throw Error("Kimi OAuth 配置含冲突的认证请求头");
  return { baseUrl: base, apiKey: key, protocol, extraHeaders,
    nativeAuthType: p.oauth ? "oauth" : "api", nativeProvider: m.nativeProvider,
    nativeProviderName: p.name,
    thinkingOff: p.type === "kimi" };
}
function zcodeTarget(client, a, m, env) {
  const stored = read(a.sourcePath), privateFile = path.join(a.nativeDir, "credentials.json");
  const credentials = read(privateFile), decrypt = (key) => decryptZCode(credentials[key], env);
  const active = decrypt("oauth:active_provider");
  const catalog = zcodeCatalog.inspect({ dir: a.nativeDir, env, override: client.credentialHome, launcher: client.launcher },
    stored.schemaVersion === 1 ? stored.config : undefined, (file) => {
      try { return readFile(file) === null ? { file, status: "missing" } : { file, data: read(file), status: "detected" }; }
      catch { return { file, status: "unreadable" }; }
    }, ["zai", "bigmodel"].includes(active) ? [active] : []);
  const p = catalog.providers.find((r) => r.providerId === m.nativeProvider && (!m.model || r.models.some((r) => r.modelId === m.model)))?.config;
  if (!p) throw Error("ZCode 模型配置已变化，请刷新目录");
  const access = p.access || {}, protocol = protocols[p.api?.type];
  let key = secret(access.apiKey);
  if (access.type === "zhipu-account") {
    if (access.accountType !== active) throw Error("此模型不属于 ZCode 当前登录账户");
    const state = readSource({ dir: a.nativeDir, harness: "zcode", env });
    const grant = state.grants.find((g) => g.row.provider === active);
    if (!grant?.query) throw Error("ZCode 官方登录信息或服务地址无法确认");
    const start = access.mode === "start-plan", kind = access.mode === "individual-coding-plan" ? "personal" : access.mode === "team-coding-plan" ? "team" : "";
    const expected = start ? "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
      : active === "zai" ? "https://api.z.ai/api/anthropic" : "https://open.bigmodel.cn/api/anthropic";
    if ((!start && !kind) || String(p.api?.baseUrl).replace(/\/+$/, "") !== expected || protocol !== "anthropic")
      throw Error("ZCode OAuth 模型接口与套餐不匹配，未发送凭据");
    if (start) { key = secret(grant.grant.session_token); notExpired(key); }
    else {
      if (!zcodeInfo.official(env, active)) throw Error("ZCode Coding Plan 环境地址无法确认");
      key = secret(grant.grant.coding?.find((c) => c.kind === kind)?.apiKey);
      if (!key) throw Error("请先在 ZCode 使用此套餐，生成当前账户对应的原生 API Key 后再测试");
    }
  } else if (!["api-key", "zhipu-coding-plan-api-key"].includes(access.type))
    throw Error("此 ZCode 凭据类型暂不支持独立检测");
  const extraHeaders = headers(p.api?.headers, env);
  // Native ZCode sends both forms for Anthropic-compatible gateways.
  if (protocol === "anthropic" && key) {
    if (access.type === "zhipu-account" && Object.keys(extraHeaders).some((k) => /authorization|api-key/i.test(k)))
      throw Error("ZCode OAuth 配置含冲突的认证请求头");
    extraHeaders.authorization ||= "Bearer " + key;
  }
  return { baseUrl: p.api?.baseUrl, apiKey: key, protocol, extraHeaders,
    nativeAuthType: access.type === "api-key" || access.type === "zhipu-coding-plan-api-key" ? "api" : "oauth",
    nativeProvider: m.nativeProvider, nativeProviderName: p.name || p.providerName };
}
function dshSettings(dir) { return require("./dsh-config.cjs").readSettings(dir, read); }
function classicTarget(client, a, m, home, env) {
  const id = a.provider || a.oauthProvider || a.providers?.[0], dir = a.nativeDir || path.dirname(a.sourcePath);
  const data = client.id === 'opencode' && a.sourcePath.endsWith('.db')
    ? a.credentialId ? { [id]: { ...require('./opencode-version.cjs').selected(a).value } } : {}
    : read(a.sourcePath, client.id === "dsh" ? "yaml" : "json");
  const record = data.records?.["llm-pi-ai/" + id];
  const credential = client.id === "dsh" ? record?.payload || record : client.id === "claude" ? data.claudeAiOauth : data[id];
  const subscription = nativeSubscriptionProvider(client, a);
  if (subscription) {
    const access = subscription.apiKey;
    notExpired(access, credential?.expires ? credential.expires / 1000 : credential?.expiresAt ? credential.expiresAt / 1000 : undefined);
    const openai = subscription.subscriptionKind === "openai";
    const baseUrl = openai ? "https://chatgpt.com/backend-api/codex" : "https://api.anthropic.com";
    const config = client.id === "pi" ? read(path.join(dir, "models.json")).providers?.[id]
      : client.id === "dsh" ? dshSettings(dir)["llm-pi-ai"]?.providers?.[id]
      : client.id === "opencode" ? opencodeProvider(a, dir, id, home, env, read).options
      : read(path.join(dir, "settings.json")).env;
    const override = config?.baseURL || config?.baseUrl || config?.ANTHROPIC_BASE_URL;
    if (override && String(override).replace(/\/+$/, "").replace(/\/v1$/, "") !== baseUrl)
      throw Error("此原生 OAuth 模型含自定义接口覆盖，请在客户端测试");
    return { baseUrl,
      apiKey: access, protocol: openai ? "openai-responses" : "anthropic", codexOAuth: openai,
      extraHeaders: { ...subscription.extraHeaders, "user-agent": "ASS native-model-check",
        authorization: "Bearer " + access }, bearerOnly: !openai };
  }
  if (a.authType === "oauth") throw Error("此原生 OAuth 协议暂不支持独立检测，请在客户端测试");
  let p = {}, raw = {}, key, mode;
  const official = nativeOfficialProvider(client, a, { home, env });
  const builtin = builtinApi(id);
  if (client.id === "opencode") {
    p = opencodeProvider(a, dir, id, home, env, read);
    raw = Object.values(p.models || {}).find((r) => (r?.id || r?.model) === m.model) || p.models?.[m.model] || {};
    if (!p.enabled) throw Error("此原生供应商已停用");
    key = a.credentialId ? value(data[id]?.key, env) : p.options?.apiKey !== undefined ? value(p.options.apiKey, env) : value(data[id]?.key, env) ||
      (p.env || [builtin.envKey]).map((name) => secret(env[name])).find(Boolean);
    const npm = raw.provider?.npm || p.npm || p.package;
    const packageProtocol = { "@ai-sdk/openai": "openai-responses", "@ai-sdk/anthropic": "anthropic",
      "@ai-sdk/openai-compatible": "openai-chat", "@opencode/ai/providers/openai": "openai-responses",
      "@opencode/ai/providers/anthropic": "anthropic", "@opencode/ai/providers/openai-compatible": "openai-chat" }[npm];
    return { baseUrl: p.options?.baseURL || raw.provider?.api || p.api || official?.baseUrl || builtin.baseUrl,
      apiKey: key, protocol: m.wireApi || packageProtocol || builtin.protocol,
      nativeAuthType: "api", nativeProvider: m.nativeProvider, nativeProviderName: p.name,
      extraHeaders: headers({ ...p.options?.headers, ...raw.headers }, env) };
  }
  if (client.id === "codex") {
    const config = read(path.join(dir, "config.toml"), "toml");
    p = config.model_providers?.[id] || {};
    if (p.auth || Object.keys(p.query_params || {}).length) throw Error("此 Codex API 使用命令凭据或查询参数，继续由客户端管理");
    const rows = Array.isArray(p.models) ? p.models : [];
    raw = rows.find((r) => (r?.slug || r?.id || r?.model) === m.model) || {};
    const envKey = typeof p.env_key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.env_key)
      ? secret(env[p.env_key]) : "";
    key = envKey || value(p.experimental_bearer_token, env) || value(p.api_key, env) ||
      ((id === "openai" || p.requires_openai_auth) ? value(data.OPENAI_API_KEY, env) || secret(env.OPENAI_API_KEY) : "");
    const extraHeaders = headers({ ...p.headers, ...p.http_headers }, env);
    for (const [name, variable] of Object.entries(p.env_http_headers || {}))
      if (secret(env[variable])) Object.assign(extraHeaders, headers({ [name]: secret(env[variable]) }, {}));
    const protocol = protocols[p.wire_api] || (p.wire_api === "responses" ? "openai-responses" : "");
    return { baseUrl: p.base_url || p.baseURL || (id === "openai" ? "https://api.openai.com/v1" : official?.baseUrl), apiKey: key,
      protocol: protocol || m.wireApi, nativeAuthType: "api", nativeProvider: id,
      nativeProviderName: p.name || id, extraHeaders };
  }
  if (client.id === "claude") {
    const settings = read(path.join(dir, "settings.json"));
    const runtime = object(settings.env) ? settings.env : {};
    key = secret(runtime.ANTHROPIC_API_KEY) || secret(env.ANTHROPIC_API_KEY) || secret(data.primaryApiKey);
    return { baseUrl: runtime.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey: key, protocol: "anthropic", nativeAuthType: "api", nativeProvider: "anthropic-api",
      nativeProviderName: "Anthropic", extraHeaders: {} };
  }
  if (client.id === "pi") { p = read(path.join(dir, "models.json")).providers?.[id] || {}; mode = "pi"; }
  else if (client.id === "dsh") {
    const settings = dshSettings(dir);
    if (id === "DEEPSEEK_API_KEY" || id === (settings["llm-deepseek"]?.apiKeyEnv || "DEEPSEEK_API_KEY")) {
      p = settings["llm-deepseek"] || {};
      const keyName = p.apiKeyEnv || "DEEPSEEK_API_KEY";
      const storedKey = value(data.refs?.[keyName] || (!data.version && data[keyName]), env), envKey = secret(env[keyName]);
      if (storedKey && envKey && storedKey !== envKey) throw Error("DSH 的环境密钥与已存账户不一致，请在客户端确认后测试");
      return { baseUrl: p.baseURL || p.baseUrl || "https://api.deepseek.com", apiKey: storedKey || envKey,
        protocol: "openai-chat", nativeAuthType: "api", nativeProvider: m.nativeProvider,
        nativeProviderName: p.displayName || "DeepSeek", extraHeaders: headers(p.headers, env) };
    }
    p = settings["llm-pi-ai"]?.providers?.[id] || {}; mode = "pi";
  }
  const rows = Array.isArray(p.models) ? p.models : Object.values(p.models || {});
  raw = rows.find((r) => (r?.id || r?.model) === m.model) || {};
  if (credential?.type === "oauth" || record?.kind === "grant") throw Error("原生 OAuth 优先，未使用被覆盖的 API Key");
  key = value(credential?.key, env, mode) || value(p.apiKey, env, mode) ||
    (client.id === "dsh" && p.apiKeyEnv ? secret(env[p.apiKeyEnv]) : "") || official?.apiKey || secret(env[builtin.envKey]);
  return { baseUrl: raw.baseURL || raw.baseUrl || p.baseURL || p.baseUrl || official?.baseUrl || builtin.baseUrl, apiKey: key,
    nativeAuthType: a.authType === "api" || record?.kind === "api-key" ? "api" : undefined,
    nativeProvider: m.nativeProvider, nativeProviderName: p.displayName || p.name,
    protocol: protocols[raw.api || p.api] || m.wireApi || official?.wireApi || builtin.protocol,
    extraHeaders: headers({ ...p.headers, ...raw.headers }, env, mode) };
}
function resolveNativeApiTarget(client, account, model, { home, env = {} } = {}) {
  const target = client.id === "kimi" ? kimiTarget(account, model, env)
    : client.id === "zcode" ? zcodeTarget(client, account, model, env)
      : classicTarget(client, account, model, home, env);
  return { ...target, protocol: target.protocol || model.wireApi,
    nativeAuthType: target.nativeAuthType || (account.authType === "api" ? "api" : "oauth") };
}
function resolveNativeDiagnostic(id, name, snapshot, { home, env = {}, directories = {} } = {}) {
  for (const client of snapshot.clients) for (const a of (client.modelAccounts || client.accounts || []).filter((a) => a.kind !== "api")) {
    const models = directories["native-" + client.id]?.accounts?.[a.id]?.models || nativeModels(client, a, home, env);
    const m = models.find((m) => m.model === name && nativeTargetId(client, a, m) === id);
    if (!m || m.enabled === false) continue;
    const target = resolveNativeApiTarget(client, a, m, { home, env });
    if (!["openai-chat", "openai-responses", "anthropic"].includes(target.protocol))
      throw Error("此模型的原生协议尚未确认，请先在客户端刷新目录");
    if (!secret(target.apiKey)) throw Error("未找到此模型对应的有效原生凭据，请先在客户端登录");
    const extraHeaders = { ...target.extraHeaders };
    if (target.protocol === "anthropic") {
      if (!target.bearerOnly) extraHeaders["x-api-key"] ||= target.apiKey;
      extraHeaders["anthropic-version"] ||= "2023-06-01";
    } else extraHeaders.authorization ||= "Bearer " + target.apiKey;
    const url = requestUrl(target.baseUrl, target.protocol);
    const body = target.protocol === "openai-responses"
      ? { model: name, instructions: "Reply concisely.", input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }], stream: true, store: false,
        ...(target.codexOAuth ? { reasoning: { effort: "low" } } : { max_output_tokens: 512 }) }
      : { model: name, messages: [{ role: "user", content: "Reply exactly OK." }], stream: true, max_tokens: 512,
        ...(target.thinkingOff ? { thinking: { type: "disabled" } } : {}) };
    return { model: { ...m, wireApi: target.protocol }, native: true, client, account: a,
      provider: { id, baseUrl: url, apiKey: target.apiKey, network: "system", extraHeaders, enabled: true,
        nativeBaseUrl: target.baseUrl, nativeAuthType: target.nativeAuthType,
        nativeProvider: target.nativeProvider || m.nativeProvider, nativeProviderName: target.nativeProviderName || a.label,
        nativeProtocol: target.protocol,
        nativeRequest: body }, request: { url, body, headers: extraHeaders, protocol: target.protocol } };
  }
  throw Error("原生模型已变化或不存在，请刷新目录后重试");
}
async function checkNativeConnection(context, fetchUpstream, signal, metrics) {
  const { url, body, headers: auth, protocol } = context.request;
  signal?.throwIfAborted();
  const response = await fetchUpstream(url, { method: "POST", headers: { ...auth,
    ...providerSessionHeaders(context.provider || { baseUrl: url }, { "user-agent": "ASS/native-model-check", "x-opencode-session": "ass-diagnostic-" + require("node:crypto").randomUUID() }),
    "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body),
    redirect: "error", credentials: "omit", signal }, "system");
  return inspectConnectionResponse(response, protocol, metrics, { signal });
}
module.exports = { resolveNativeDiagnostic, resolveNativeApiTarget, checkNativeConnection };
