const crypto = require("node:crypto");
// Claude Desktop checks the entire gateway route, including provider and model
// segments, for non-Anthropic vendor names. Keep the picker ID opaque; the
// visible label and the upstream model remain the actual provider/model.
const PREFIX = "claude-ass-";
const qualified = (provider, model) => provider.id + "::" + model.model;
const alias = model => PREFIX + crypto.createHash("sha256").update(model).digest("hex").slice(0, 32);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function claudeIdentity(value) {
  if (typeof value !== "string" || value.length > 250 || /\s/.test(value)) return null;
  // Exact native model spellings only. Display labels and vague tier aliases
  // are not evidence of a particular model's capabilities.
  const match = /^(?:anthropic\/|(?:[a-z][a-z0-9-]*\.)?anthropic\.)?(claude-(opus|sonnet|haiku|fable|mythos)-\d+(?:-\d{1,2})?(?:-20\d{6})?)$/.exec(value);
  return match ? { canonical: match[1], tier: match[2] } : null;
}
function claudeModels(providers) {
  return providers.filter(p => p.enabled && p.apiKey).flatMap(p => p.models
    .filter(m => m.enabled && ["anthropic", "openai-responses", "openai-chat"].includes(m.wireApi))
    .map(m => {
      const model = qualified(p, m);
      const identity = claudeIdentity(m.model);
      const context1m = Number.isSafeInteger(m.contextWindow) && m.contextWindow >= 1000000;
      // Claude Desktop strips <region>.anthropic. before matching its model
      // catalog. A stable opaque ASS region keeps native recognition AND exact
      // provider routing; no provider name can trigger its vendor exclusion.
      const discoveryId = identity ? `ass-${alias(model).slice(PREFIX.length)}.anthropic.${identity.canonical}` : alias(model);
      const efforts = identity && Array.isArray(m.efforts) ? EFFORTS.filter(e => m.efforts.includes(e)) : [];
      return { model, cliModel: model + (context1m ? '[1m]' : ''), discoveryId,
        label: p.name + " · " + (m.displayName || m.model), description: m.model,
        ...(identity ? { claudeIdentity: identity } : {}),
        // This is the deployment's configured capability, not a claim that we
        // have tested a million-token request. Desktop does not read our numeric
        // contextWindow; it requires these explicit picker flags instead.
        ...(identity && context1m
          ? { supports1m: true, prefer1m: true } : {}),
        ...(efforts.length ? { maxEffort: efforts.at(-1),
          defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : efforts[0] } : {}),
      };
    }));
}
function resolveClaudeModel(providers, value) {
  if (typeof value !== "string") return value;
  const rows = claudeModels(providers);
  // An exact real ID wins; never strip arbitrary text and silently pick a model.
  if (rows.some(m => m.model === value)) return value;
  // Existing desktop conversations can still hold the previous exact ASS ID.
  // Resolve it only against enabled configured models, never arbitrary aliases.
  const matches = (row, id) => row.discoveryId === id || alias(row.model) === id;
  const entry = rows.find(m => matches(m, value));
  if (entry) return entry.model;
  if (/\[1m\]$/i.test(value)) {
    const base = value.slice(0, -4), row = rows.find(m => m.model === base || matches(m, base));
    if (row) return row.model;
  }
  return value;
}
module.exports = { claudeModels, resolveClaudeModel, claudeIdentity };
