// Endpoint defaults, not model entitlements. Custom declarations always win.
// API-key providers only: OAuth, cloud IAM and unknown extensions stay native.
// Sources: pi env-api-keys.ts, provider docs linked in docs/NATIVE-CONFIG.md.
const BUILTINS = {
  openai: ["https://api.openai.com/v1", "openai-responses", "OPENAI_API_KEY"],
  anthropic: ["https://api.anthropic.com", "anthropic", "ANTHROPIC_API_KEY"],
  deepseek: ["https://api.deepseek.com", "openai-chat", "DEEPSEEK_API_KEY"],
  openrouter: ["https://openrouter.ai/api/v1", "openai-chat", "OPENROUTER_API_KEY"],
  opencode: ["https://opencode.ai/zen/v1", "openai-chat", "OPENCODE_API_KEY"],
  "opencode-go": ["https://opencode.ai/zen/go/v1", "openai-chat", "OPENCODE_API_KEY"],
  "kimi-coding": ["https://api.kimi.com/coding/v1", "anthropic", "KIMI_API_KEY"],
};
const aliases = { "DEEPSEEK_API_KEY": "deepseek", "deepseek-official": "deepseek", "opencode-zen": "opencode" };
const nativeProtocols = {
  kimi: "openai-chat", openai: "openai-chat", openai_legacy: "openai-chat",
  openai_responses: "openai-responses", anthropic: "anthropic",
  "openai-completions": "openai-chat", "openai-chat-completions": "openai-chat",
  "openai-responses": "openai-responses", "anthropic-messages": "anthropic",
};
function builtinApi(id) {
  const row = BUILTINS[aliases[id] || id];
  return row ? { baseUrl: row[0], protocol: row[1], envKey: row[2] } : {};
}
module.exports = { builtinApi, BUILTINS, nativeProtocols };
