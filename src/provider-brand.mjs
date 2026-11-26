const known = new Set([
  "openai",
  "anthropic",
  "claude",
  "deepseek",
  "kimi",
  "zai",
  "opencode",
  "openrouter",
  "cursor",
  "gemini",
  "minimax",
  "siliconcloud",
  "ollama",
  "githubcopilot",
  "qwen",
  "groq",
  "mistral",
  "grok",
  "stepfun",
  "doubao",
  "hunyuan",
]);
const aliases = {
  google: "gemini",
  moonshot: "kimi",
  "z.ai": "zai",
  zhipu: "zai",
  "z-ai": "zai",
  siliconflow: "siliconcloud",
  xai: "grok",
  "github-copilot": "githubcopilot",
  "opencode-go": "opencode",
  bytedance: "doubao",
  tencent: "hunyuan",
};
const harnessBrands = {
  codex: "openai",
  claude: "anthropic",
  opencode: "opencode",
  dsh: "deepseek",
  pi: "pi",
  kimi: "kimi",
  zcode: "zai",
  antigravity: "antigravity",
};

export function harnessLogo(id) {
  return Object.hasOwn(harnessBrands, id) ? `./providers/${harnessBrands[id]}.svg` : null;
}

export function providerBrand(p, service) {
  if (p.id === "official") return "openai";
  const native = {
    "native-claude": "claude",
    "native-dsh": "deepseek",
    "native-opencode": "opencode",
    "native-pi": "pi",
  }[p.id];
  if (native) return native;
  const match = aliases[service] || service;
  if (known.has(match)) return match;
  // Match names, never a model ID: a relay selling GPT is not OpenAI.
  const name = String(p.name || "")
    .trim()
    .toLowerCase();
  const first = name.split(/[\s/·（(]/)[0];
  const normalized = aliases[first] || first;
  return known.has(normalized) ? normalized : null;
}
