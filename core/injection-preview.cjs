const { codexModelId } = require('./models.cjs');
const { modelRef } = require('./client-policy.cjs');
const { providerId } = require('./native-config.cjs');

const protocols = { responses: 'openai-responses', chat: 'openai-chat', messages: 'anthropic' };
const nativeProvider = value => /^ass-([a-f\d]{16})-(responses|chat|messages)$/i.exec(value || '');

function proxyModels(plan) {
  return (plan?.providers || []).flatMap(provider => provider.models.map(model => ({
    key: modelRef(provider.id, model.model), selector: codexModelId(provider.id, model.model),
    provider: provider.name, model: model.model, protocol: model.wireApi,
    mode: model.nativeMessages ? 'native' : model.protocolOverride ? 'fixed' : 'auto',
  })));
}

function nativeModels(fields, providers) {
  const names = new Map(providers.map(provider => [nativeProvider(providerId(provider, 'openai-responses'))[1], provider.name]));
  const rows = [];
  function add(id, model, provider) {
    const parts = nativeProvider(id);
    if (!parts || typeof model !== 'string') return;
    const [, rawOwner, protocol] = parts, owner = rawOwner.toLowerCase();
    rows.push({ key: modelRef(owner, model), provider: provider || names.get(owner) || id, model, protocol: protocols[protocol.toLowerCase()] });
  }
  for (const field of fields) {
    const value = field.after?.value ?? field.value;
    if (!value || typeof value !== 'object') continue;
    const id = field.path.at(-1), kind = field.path.at(-2);
    if (kind === 'providers' || kind === 'provider') {
      const models = Array.isArray(value.models) ? value.models.map(model => model.id) : Object.keys(value.models || {});
      for (const model of models) add(id, model, value.name || value.displayName);
    } else if (kind === 'models') {
      add(value.provider, value.model);
    } else if (id === 'providerRules') {
      for (const model of value.config?.personalModelIds || []) add(value.providerId, model, value.providerName);
    }
  }
  return rows;
}

function modelChanges(before, after) {
  const previous = new Map(before.map(row => [row.key, row]));
  const next = new Map(after.map(row => [row.key, row]));
  const added = [], removed = [], protocolChanges = [];
  for (const [key, row] of next) {
    const { model, provider, protocol } = row, old = previous.get(key);
    if (!old) added.push({ model, provider, protocol });
    else if (old.protocol !== protocol || old.mode !== row.mode)
      protocolChanges.push({ model, provider, from: old.protocol, to: protocol, fromMode: old.mode, toMode: row.mode });
  }
  for (const [key, { model, provider, protocol }] of previous)
    if (!next.has(key)) removed.push({ model, provider, protocol });
  return { added, removed, protocols: protocolChanges };
}

function displaySelection(value, models) {
  if (!value) return null;
  const match = models.find(row => row.selector === value);
  return match ? match.provider + ' / ' + match.model : value;
}

function selectionChanges(before, after, requested, previousModels, nextModels, settings) {
  let expected, requestedLabel;
  if (requested) {
    const row = settings.models.find(model => model.ref === requested) || settings.officialModels?.find(model => model.ref === requested);
    try {
      const [id, model] = JSON.parse(requested);
      if (typeof id === 'string' && typeof model === 'string') {
        expected = id === 'official' ? model : codexModelId(id, model);
        requestedLabel = row?.providerName ? row.providerName + ' / ' + model : model;
      }
    } catch {}
  }
  const fallback = !!expected && expected !== after;
  if (before === after && !fallback) return null;
  return { from: displaySelection(before, previousModels), to: displaySelection(after, nextModels),
    ...(fallback ? { fallback, requested: requestedLabel } : {}) };
}

function previewInjection(id, enabled, accountless, proxyConfig, nativeConfig) {
  if (proxyConfig?.supports(id)) {
    const before = proxyConfig.clients[id], after = enabled ? proxyConfig.desired(id, accountless) : null;
    const previousModels = proxyModels(before), nextModels = proxyModels(after);
    const settings = enabled ? proxyConfig.manager.injection(id) : { models: [] };
    const defaultModel = selectionChanges(before?.defaultModel?.model, after?.defaultModel?.model, settings.defaultModel,
      previousModels, nextModels, settings);
    const reviewModel = id === 'claude' ? selectionChanges(before?.autoModeModel, after?.autoModeModel, settings.autoModeModel,
      previousModels, nextModels, settings) : null;
    const claudeGateway = before?.accountless || after?.accountless;
    return { ...modelChanges(previousModels, nextModels), defaultModel, reviewModel, transport: 'proxy',
      surfaces: id === 'codex' ? ['desktop', 'cli'] : claudeGateway ? ['cli', 'desktop-gateway'] : ['ass-cli'],
      reload: id === 'codex' ? 'restart' : claudeGateway ? 'claude-gateway' : 'new-launch' };
  }
  if (!nativeConfig?.isDirect(id)) return null;
  const before = nativeConfig.fields.entries.filter(field => field.harness === id);
  const after = enabled ? nativeConfig.desired(id).fields : [];
  const providers = nativeConfig.manager.effectiveProviders?.(id) || nativeConfig.manager.getState().providers;
  return { ...modelChanges(nativeModels(before, providers), nativeModels(after, providers)),
    defaultModel: null, reviewModel: null, transport: 'native',
    surfaces: ['native'], reload: id === 'dsh' ? 'page-refresh' : 'reload' };
}

module.exports = { previewInjection };
