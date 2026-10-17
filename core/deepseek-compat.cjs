// Codex's custom/namespace tools can require adaptation on Responses APIs.
// Automatic detection uses service identity; explicit choices belong to the
// client's injection draft, never the shared supplier model configuration.
const TOOL_MODES = ['auto', 'compatible', 'native'];
function validToolRef(ref) {
  try {
    const value = JSON.parse(ref);
    return Array.isArray(value) && value.length === 2 && value[0] !== 'official' &&
      value.every(s => typeof s === 'string' && s.length > 0 && s.length <= 250 && !/[\x00-\x1f\x7f]/.test(s)) &&
      JSON.stringify(value) === ref;
  } catch { return false; }
}
function validToolModes(modes) {
  return modes && typeof modes === 'object' && !Array.isArray(modes) &&
    Object.keys(modes).length <= 5000 && Object.entries(modes).every(([ref, mode]) =>
      validToolRef(ref) && TOOL_MODES.includes(mode));
}
function nativeDeepSeek(provider) {
  try {
    const url = new URL(provider?.baseUrl);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password &&
      !url.search && !url.hash && ['', '/v1', '/beta'].includes(url.pathname.replace(/\/$/, ''));
  } catch { return false; }
}

function compatibleResponsesTools(provider, model) {
  if (model?.codexToolMode === 'native') return false;
  return model?.codexToolMode === 'compatible' || nativeDeepSeek(provider);
}
function needsResponsesToolBridge(provider, body, model) {
  return compatibleResponsesTools(provider, model) && (
    (body.tools || []).some(t => ['namespace', 'custom'].includes(t.type) || t.namespace) ||
    Array.isArray(body.input) && body.input.some(i => i?.namespace || ['custom_tool_call', 'custom_tool_call_output'].includes(i?.type))
  );
}

function codexApiMetadata(entry, provider, model) {
  // Responses Lite is an OpenAI backend optimization, not a capability proved
  // by an API model's name or inherited official template.
  const portable = { ...entry, use_responses_lite: false };
  if (model?.wireApi !== 'openai-responses' || !compatibleResponsesTools(provider, model)) return portable;
  const compatible = { ...portable, prefer_websockets: false, tool_mode: null,
    apply_patch_tool_type: 'freeform', shell_type: 'shell_command' };
  if (!nativeDeepSeek(provider)) return compatible;
  // Tool-protocol fields from DeepSeek's official Codex integration catalog.
  // Preserve the user's model ID, context size, effort and default selection.
  return { ...compatible,
    supports_parallel_tool_calls: true, supports_reasoning_summaries: true,
    reasoning_summary_format: 'experimental', default_reasoning_summary: 'none',
    support_verbosity: true, default_verbosity: 'low' };
}

module.exports = { TOOL_MODES, validToolRef, validToolModes, nativeDeepSeek, needsResponsesToolBridge, codexApiMetadata };
