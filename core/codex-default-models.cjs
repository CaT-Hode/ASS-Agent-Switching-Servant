const fs = require('node:fs'), path = require('node:path');
const { officialModel } = require('./models.cjs');
const { modelRef } = require('./client-policy.cjs');
function hasCodexOAuth(manager) {
  try {
    const dir = manager.nativeLocations?.('codex')?.[0] || manager.codexDir;
    const file = path.join(dir, 'auth.json');
    if (fs.statSync(file).size > 2 * 1024 * 1024) return false;
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    return auth.auth_mode !== 'apikey' && typeof auth.tokens?.access_token === 'string' && !!auth.tokens.access_token;
  } catch { return false; }
}
function officialDefaultModels(manager, accountless = manager.options?.proxyConfig?.clients.codex?.accountless === true) {
  if (accountless || !hasCodexOAuth(manager)) return [];
  const state = manager.getState(), overrides = state.officialOverrides || {};
  return (manager.officialModels || []).filter(m => /^gpt-[\w.-]+$/.test(m.slug) && !overrides[m.slug]?.removed && overrides[m.slug]?.enabled !== false).map(m => {
    const model = officialModel(m, overrides[m.slug], manager.officialModels);
    return { ...model, name: model.displayName, providerId: 'official', providerName: 'OpenAI 官方',
      official: true, ref: modelRef('official', model.model), included: true };
  });
}
module.exports = { hasCodexOAuth, officialDefaultModels };
