// Product account policy is intentionally narrower than protocol compatibility.
// Never infer official identity from a display name, brand, or model ID.
const ACCOUNT_SERVICES = {
  codex: ["openai"],
  claude: ["anthropic"],
  dsh: ["deepseek"],
  opencode: ["opencode-go", "opencode"],
  pi: [],
  kimi: [],
  zcode: [],
};
function officialApiService(provider) {
  try {
    const u = new URL(provider.baseUrl);
    if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash)
      return null;
    const p = u.pathname.replace(/\/+$/, "");
    if (u.hostname === "api.openai.com" && ["", "/v1"].includes(p)) return "openai";
    if (u.hostname === "api.anthropic.com" && ["", "/v1"].includes(p)) return "anthropic";
    if (u.hostname === "api.deepseek.com" && ["", "/v1", "/beta"].includes(p)) return "deepseek";
    if (u.hostname === "opencode.ai" && p === "/zen/go/v1") return "opencode-go";
    if (u.hostname === "opencode.ai" && p === "/zen/v1") return "opencode";
  } catch {}
  return null;
}
function acceptsApiAccount(harness, provider) {
  return (ACCOUNT_SERVICES[harness] || []).includes(officialApiService(provider));
}
function acceptsNativeAccount(harness, account, piProviders = []) {
  const provider = account.provider || account.oauthProvider;
  if (harness === "pi")
    return account.authType === "oauth" && (!piProviders.length || piProviders.some((p) => p.id === provider));
  const aliases = { DEEPSEEK_API_KEY: "deepseek", "deepseek-official": "deepseek", "anthropic-api": "anthropic", "opencode-zen": "opencode" };
  if (!["oauth", "api"].includes(account.authType)) return false;
  if (["dsh", "opencode"].includes(harness) && account.authType !== "api") return false;
  return (ACCOUNT_SERVICES[harness] || []).includes(aliases[provider] || provider);
}
const modelRef = (provider, model) => JSON.stringify([provider, model]);
function modelIssue(harness, provider, model) {
  if (!Object.hasOwn(ACCOUNT_SERVICES, harness)) return "未知客户端";
  if (!provider.enabled) return "供应商已停用";
  if (!provider.apiKey) return "供应商缺少 API Key";
  if (!model.enabled) return "模型已停用";
  if (!["openai-chat", "openai-responses", "anthropic"].includes(model.wireApi)) return "不支持的接口协议";
  if (harness === 'dsh') { try { require('./dsh-config.cjs').reasoning(model); } catch (e) { return e.message; } }
  return "";
}
function injectionCatalog(harness, providers, settings = {}) {
  const excluded = new Set(settings.excluded || []);
  const excludedProviders = new Set(settings.excludedProviders || []);
  return providers.flatMap((p) => p.models.map((m) => {
    const ref = modelRef(p.id, m.model), issue = modelIssue(harness, p, m);
    return { ref, providerId: p.id, providerName: p.name, model: m.model,
      name: m.displayName, protocol: m.wireApi, issue,
      ...(harness === "claude" ? { adapter: require("./provider-transport.cjs").messagesTransport(p, m).adapted
        ? "Messages 转换接入" : "Messages 原生接入" } : {}),
      ...(harness === "codex" && m.wireApi !== "openai-responses" ? { adapter: "Responses 转换接入" } : {}),
      ...(harness === 'codex' ? { codexToolMode: settings.codexToolModes?.[ref] || 'auto' } : {}),
      ...(harness === 'dsh' && m.efforts?.includes('ultra') ? { adapter: 'DSH 原生档位：low / medium / high / xhigh / max；不传递 ultra' } : {}),
      included: !issue && !excludedProviders.has(p.id) && !excluded.has(ref) };
  }));
}
module.exports = { ACCOUNT_SERVICES, officialApiService, acceptsApiAccount, acceptsNativeAccount, modelRef, modelIssue, injectionCatalog };
