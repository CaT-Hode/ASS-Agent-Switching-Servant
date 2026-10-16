const DEFAULT_OUTPUT_TOKENS = 131072;
const OUTPUT_DEFAULTS_VERSION = 1;
const limit = (context) => Math.min(DEFAULT_OUTPUT_TOKENS, Number(context) > 0 ? Number(context) : DEFAULT_OUTPUT_TOKENS);
function upgradeModelOutput(model) {
  if (!model || typeof model !== 'object') return model;
  if (model.maxOutputTokens !== undefined && model.maxOutputTokens !== 16384) return model;
  return { ...model, maxOutputTokens: limit(model.contextWindow) };
}
function upgradeNativeOutput(entry) {
  const value = structuredClone(entry.after.value), keys = entry.path;
  const upgrade = (model, key, context) => {
    if (model?.[key] === 16384) model[key] = limit(context);
  };
  if ((entry.harness === 'dsh' && keys[0] === 'llm-pi-ai' && keys[1] === 'providers') ||
      (entry.harness === 'pi' && keys[0] === 'providers')) {
    for (const model of value?.models || []) upgrade(model, 'maxTokens', model.contextWindow);
  } else if (entry.harness === 'opencode' && keys[0] === 'provider') {
    for (const model of Object.values(value?.models || {})) upgrade(model.limit, 'output', model.limit?.context);
  } else if (entry.harness === 'kimi' && keys[0] === 'models') {
    upgrade(value, 'max_output_size', value.max_context_size);
  } else if (entry.harness === 'zcode' && value?.config?.optionSpecs) {
    upgrade(value.config.optionSpecs.maxOutputTokens, 'max', value.config.properties?.contextWindow);
  }
  return value;
}
function withOutputLimit(body, model, protocol) {
  const ceiling = Math.min(Number(model.maxOutputTokens) || DEFAULT_OUTPUT_TOKENS,
    Number(model.contextWindow) || DEFAULT_OUTPUT_TOKENS);
  const key = protocol === 'openai-responses' ? 'max_output_tokens'
    : protocol === 'openai-chat' && body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  const requested = body[key];
  // Explicit smaller request budgets are retained; invalid values stay visible
  // to protocol validation rather than being replaced by a successful default.
  return { ...body, [key]: requested === undefined ? ceiling
    : Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, ceiling) : requested };
}
module.exports = { DEFAULT_OUTPUT_TOKENS, OUTPUT_DEFAULTS_VERSION, upgradeModelOutput, upgradeNativeOutput, withOutputLimit };
