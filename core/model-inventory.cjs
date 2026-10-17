const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const TOML = require("@iarna/toml");
const { parse: parseJSONC } = require("jsonc-parser");
const { EFFORTS } = require("./models.cjs");
const { createHash } = require("node:crypto");
const dsh = require("./dsh-config.cjs");
const { loadOpenCodeConfig, merge } = require("./opencode-config.cjs");
const { builtinApi } = require("./native-api-defaults.cjs");
const { memoRead } = require("./read-scope.cjs");
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const APIs = {
  "openai-completions": "openai-chat",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic",
};
const cache = new Map();
function read(file) {
  return memoRead(read, [file], () => readUncached(file));
}
function readUncached(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 8 * 1024 * 1024) return {};
    const stamp = stat.mtimeMs + ":" + stat.ctimeMs + ":" + stat.size;
    if (cache.get(file)?.stamp === stamp) return cache.get(file).data;
    const content = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const errors = [];
    const parsed = file.endsWith(".yaml")
      ? YAML.parse(content, { maxAliasCount: 20 })
      : parseJSONC(content, errors, { allowTrailingComma: true });
    const data =
      !errors.length &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
        ? parsed
        : {};
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(file, { stamp, data });
    return data;
  } catch {
    return {};
  }
}
// Only allowlisted display metadata leaves this module. Never evaluate auth helpers or commands.
function model(raw, id, protocol) {
  const name = raw?.id || raw?.model || id;
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 250 ||
    /[\x00-\x1f]/.test(name)
  )
    return null;
  const context = Number(
    raw.contextWindow || raw.context_window || raw.limit?.context,
  );
  const api = APIs[raw.api] || APIs[protocol] || protocol;
  const efforts = (
    Array.isArray(raw.efforts)
      ? raw.efforts
      : Object.keys(raw.reasoningEfforts || raw.variants || {})
  ).filter((e) => EFFORTS.includes(e));
  return {
    model: name,
    displayName: String(raw.name || raw.displayName || name).slice(0, 250),
    wireApi: ["openai-responses", "openai-chat", "anthropic"].includes(api)
      ? api
      : "",
    contextWindow:
      Number.isSafeInteger(context) && context > 0 ? context : null,
    efforts,
    defaultEffort: efforts.includes(raw.defaultEffort)
      ? raw.defaultEffort
      : null,
    enabled: true,
    declared: {
      vision: Array.isArray(
        raw.input || raw.inputModalities || raw.modalities?.input,
      )
        ? (raw.input || raw.inputModalities || raw.modalities.input).includes(
            "image",
          )
        : undefined,
    },
  };
}
const packages = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-chat",
  "@opencode/ai/providers/anthropic": "anthropic",
  "@opencode/ai/providers/openai": "openai-responses",
  "@opencode/ai/providers/openai-compatible": "openai-chat",
};
function opencodeProvider(account, dir, provider, home, env, readConfig = read) {
  return memoRead(opencodeProvider, [account.kind, account.workspace, dir, provider, home, env, readConfig],
    () => resolveOpenCodeProvider(account, dir, provider, home, env, readConfig));
}
function resolveOpenCodeProvider(account, dir, provider, home, env, readConfig) {
  const native = account.kind === "native";
  const configDir = native
    ? path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
    : path.resolve(dir, "../../config/opencode");
  const cacheFile = path.join(
    native
      ? env.XDG_CACHE_HOME || path.join(home, ".cache")
      : path.resolve(dir, "../../cache"),
    "opencode/models.json",
  );
  const builtin = read(cacheFile)[provider] || {};
  const loaded = loadOpenCodeConfig({ home, env: native ? env : {}, configDir,
    workspace: native ? account.workspace : undefined, read: readConfig });
  const c = loaded.data, p = merge(builtin, c.provider?.[provider]);
  const blocked = c.disabled_providers?.includes(provider) ||
    (Array.isArray(c.enabled_providers) && !c.enabled_providers.includes(provider));
  const custom = new Set([...loaded.custom].filter((id) => id.startsWith(provider + "\0")).map((id) => id.slice(provider.length + 1)));
  return { ...p, enabled: !blocked && p.enabled !== false, custom };
}
function opencodeModels(account, dir, provider, home, env) {
  const p = opencodeProvider(account, dir, provider, home, env);
  if (!p.enabled) return [];
  return Object.entries(p.models || {}).flatMap(([id, raw]) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.enabled === false ||
      p.blacklist?.includes(id) ||
      (Array.isArray(p.whitelist) && !p.whitelist.includes(id))
    )
      return [];
    const m = model(raw, id, packages[raw.provider?.npm || p.npm || p.package] || builtinApi(provider).protocol);
    return m
      ? [
          {
            ...m,
            nativeProvider: provider,
            catalogSource: p.custom.has(id)
              ? "OpenCode 本机配置"
              : "OpenCode 本机模型缓存",
          },
        ]
      : [];
  });
}
function nativeModels(client, account, home, env) {
  return memoRead(nativeModels, [client.id, account, home, env], () => readNativeModels(client, account, home, env));
}
function readNativeModels(client, account, home, env) {
  if (["kimi", "zcode", "antigravity"].includes(client.id))
    return account.declaredModels || [];
  const dir = account.nativeDir || path.dirname(account.sourcePath || "");
  if (!path.isAbsolute(dir)) return [];
  const provider =
    account.oauthProvider || account.provider || account.providers?.[0];
  let configured = {},
    flat = [];
  if (client.id === "pi")
    configured = read(path.join(dir, "models.json")).providers || {};
  if (client.id === "codex") {
    let config = {};
    try {
      const file = path.join(dir, "config.toml");
      if (fs.statSync(file).size <= 2 * 1024 * 1024)
        config = TOML.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const selectedProvider = config.model_provider || "openai";
    const p = config.model_providers?.[provider] || {};
    const api = p.wire_api === "responses" ? "openai-responses" :
      p.wire_api === "chat" || p.wire_api === "openai_legacy" ? "openai-chat" :
        provider === "openai" ? "openai-responses" : "";
    const rows = Array.isArray(p.models) ? p.models : object(p.models)
      ? Object.entries(p.models).map(([id, raw]) => ({ ...(object(raw) ? raw : {}), id: typeof raw === "string" ? raw : raw?.id || id })) : [];
    for (const raw of rows) {
      if (!raw || (typeof raw !== "object" && typeof raw !== "string")) continue;
      const name = typeof raw === "string" ? raw : raw.slug || raw.id || raw.model;
      const m = model(typeof raw === "string" ? {} : { ...raw, id: name }, name, api);
      if (m) flat.push(m);
    }
    if (!flat.length && provider === selectedProvider && typeof config.model_catalog_json === "string") {
      const catalogPath = path.isAbsolute(config.model_catalog_json)
        ? config.model_catalog_json : path.resolve(dir, config.model_catalog_json);
      const catalog = read(catalogPath);
      for (const raw of Array.isArray(catalog.models) ? catalog.models : []) {
        if (!object(raw)) continue;
        const name = raw.slug || raw.id || raw.model;
        const m = model({ ...raw, id: name }, name, api);
        if (m) flat.push(m);
      }
    }
    if (!flat.length && typeof config.model === "string" && provider === selectedProvider) {
      const m = model({}, config.model, api || "openai-responses");
      if (m) flat.push(m);
    }
    return flat.filter(Boolean).map((m) => ({ ...m, nativeProvider: provider || "openai" }));
  }
  if (client.id === "dsh") {
    let settings;
    try { settings = dsh.readSettings(dir, read); } catch { return []; }
    configured = settings["llm-pi-ai"]?.providers || {};
    const deep = settings["llm-deepseek"] || {};
    if (
      ["DEEPSEEK_API_KEY", "deepseek", "deepseek-official", deep.apiKeyEnv]
        .filter(Boolean)
        .includes(provider)
    ) {
      const entries = Array.isArray(deep.models)
        ? deep.models
        : [];
      flat.push(
        ...entries
          .filter((m) => m && typeof m === "object")
          .map((raw) => {
            const m = model(raw, raw.id, "openai-chat");
            return (
              m && {
                ...m,
                nativeProvider: "deepseek-official",
                catalogSource: "DSH 本机配置",
              }
            );
          }),
      );
    }
  }
  if (client.id === "opencode") {
    return opencodeModels(account, dir, provider, home, env);
  }
  if (client.id === "claude") {
    const selected = read(path.join(dir, "settings.json")).model;
    if (typeof selected === "string")
      flat.push(model({}, selected, "anthropic"));
  }
  // A logged-in provider's custom/native model declarations; unrelated providers are not attributed to it.
  for (const [id, p] of Object.entries(configured)) {
    if (provider !== id || !p || typeof p !== "object") continue;
    const protocol = p.api || packages[p.npm || p.package];
    for (const [key, raw] of Object.entries(p.models || {})) {
      if (raw && typeof raw === "object")
        flat.push(
          model(raw, Array.isArray(p.models) ? undefined : key, protocol),
        );
    }
  }
  return flat.filter(Boolean).map((m) => ({ ...m, nativeProvider: m.nativeProvider || provider || "" }));
}
// A native model belongs to a specific local account/catalog and provider, not
// just a harness. Never share a test record between same-named models or homes.
function nativeTargetId(client, account, model) {
  return "native-test:" + client.id + ":" + createHash("sha256")
    .update(JSON.stringify([account.id, account.sourcePath, model.nativeProvider || "", model.nativeAlias || ""]))
    .digest("hex").slice(0, 32);
}
const nativeScope = (account) => createHash("sha256")
  .update(String(account.nativeDir || path.dirname(account.sourcePath || "")))
  .digest("hex").slice(0, 20);
function applyZCodeEntitlement(client, rows) {
  if (client.id !== "zcode") return { rows };
  const current = client.accounts.find((account) => account.oauthCurrent === true &&
    ["zai", "bigmodel"].includes(account.provider) && account.profile?.modelEntitlement);
  const entitlement = current?.profile?.modelEntitlement;
  if (!current || !entitlement || !["available", "pending", "unavailable"].includes(entitlement.status)) return { rows };
  const target = `account:${current.provider}-start-plan`, scope = nativeScope(current);
  const applies = (row) => row.nativeProvider === target && row.nativeScope === scope;
  if (entitlement.status !== "available") return {
    rows: rows.filter((row) => !applies(row)),
    entitlement,
    caption: entitlement.status === "pending" ? "当前账户 Start Plan 模型权益待生效" : "当前账户没有有效 Start Plan",
  };
  if (!Array.isArray(entitlement.models)) return {
    rows,
    entitlement,
    caption: "当前账户 Start Plan 有效；接口未限定模型白名单",
  };
  const wanted = new Map(entitlement.models.map((id, index) => [id.toLowerCase(), index]));
  const matched = new Set();
  const selected = rows.filter((row) => {
    if (!applies(row)) return true;
    const key = row.model.toLowerCase(), keep = wanted.has(key);
    if (keep) matched.add(key);
    return keep;
  }).map((row) => applies(row) ? { ...row, entitled: true,
    nativeAccountLabel: current.label || row.nativeAccountLabel,
    catalogSource: "ZCode 当前账户 Start Plan 权益 · 上次成功查询" } : row);
  selected.sort((a, b) => applies(a) && applies(b)
    ? wanted.get(a.model.toLowerCase()) - wanted.get(b.model.toLowerCase()) : 0);
  const unresolved = entitlement.models.filter((id) => !matched.has(id.toLowerCase()));
  return { rows: selected, entitlement, unresolved,
    caption: `当前账户 Start Plan 权益 · ${matched.size}/${entitlement.models.length} 个模型已匹配本机目录` };
}
function modelSources(
  store,
  harnesses,
  { home, env = {}, directories = {}, nativeApiModels = [], ownsModel = () => false } = {},
) {
  const officialClient = harnesses.clients.find((c) => c.id === "codex");
  const sources = [
    {
      id: "official",
      name: "OpenAI 官方",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      kind: "subscription",
      readOnly: true,
      enabled: true,
      models: store.officialModels,
      accountCount:
        officialClient?.accounts.filter(
          (a) => a.kind !== "api" && a.authType === "oauth",
        ).length || 0,
    },
    ...store.providers,
  ];
  for (const client of harnesses.clients.filter((c) => c.id !== "codex")) {
    const accounts = (client.modelAccounts || client.accounts).filter((a) => a.kind !== "api" &&
      (!store.providers.some((p) => p.id === a.supplierId) ||
        (client.id === 'dsh' && directories['native-dsh']?.accounts?.[a.id]) ||
        nativeApiModels.some((row) => row.clientId === client.id && row.accountId === a.id)));
    if (!accounts.length) continue;
    const models = new Map();
    const visibleAccounts = [];
    const directory = directories["native-" + client.id];
    const assigned = new Map(nativeApiModels.filter((row) => row.clientId === client.id)
      .map((row) => [JSON.stringify([row.accountId, row.nativeProvider, row.model]), row.supplierId]));
    for (const a of accounts) {
      const before = models.size;
      let cached = directory?.accounts?.[a.id];
      if (client.id === 'dsh' && cached?.context) {
        try {if(cached.context !== dsh.catalogStamp(a.nativeDir || path.dirname(a.sourcePath || ''))) cached = undefined;}
        catch {cached = undefined;}
      }
      for (const m of cached?.models || nativeModels(client, a, home || "", env)) {
        // Runtime pickers may combine the native and ASS-injected catalogs
        // under one account. Exclude only still-owned entries, not every
        // provider whose name happens to start with ASS.
        if (ownsModel(client, a, m)) continue;
        const sameModelInSupplier = a.authType === "api" && a.supplierId &&
          store.providers.some((p) => p.id === a.supplierId && p.models.some((item) => item.model === m.model));
        // The model directory may call this account "deepseek" while the API
        // resolver calls it "deepseek-official". A confirmed same-key supplier
        // already owns that model; do not show a second native-account card.
        if (sameModelInSupplier || assigned.has(JSON.stringify([a.id, m.nativeProvider || "", m.model]))) continue;
        const diagnosticProviderId = nativeTargetId(client, a, m);
        models.set(diagnosticProviderId + "::" + m.model, {
          ...m, diagnosticProviderId, nativeAccountLabel: a.label || "", nativeScope: nativeScope(a),
        });
      }
      // A saved supplier already represents this credential. An unavailable or
      // fully assigned catalog must not turn it into another empty account.
      const represented = store.providers.some((p) => p.id === a.supplierId) ||
        nativeApiModels.some((row) => row.clientId === client.id && row.accountId === a.id);
      if (!represented || models.size > before) visibleAccounts.push(a);
    }
    const runtime = applyZCodeEntitlement(client, [...models.values()]);
    const rows = runtime.rows.map(({ nativeScope: _nativeScope, ...model }) => model);
    if (!rows.length && !visibleAccounts.length) continue;
    const directoryError = directory?.error;
    const entitlementNotice = runtime.unresolved?.length
      ? `当前权益中的 ${runtime.unresolved.length} 个模型缺少本机目录元数据；请更新或刷新 ZCode 模型目录。` : undefined;
    sources.push({
      id: "native-" + client.id,
      name: client.name + " · 原生账户",
      kind: "native",
      readOnly: true,
      enabled: true,
      accountCount: visibleAccounts.filter((a) => !a.catalogOnly).length,
      catalogError: directoryError,
      entitlementNotice,
      modelEntitlement: runtime.entitlement,
      catalogSource:
        [runtime.caption,
          ...new Set(
            rows.map((m) => m.catalogSource || "本机配置声明"),
          ),
        ].filter(Boolean).join(" · ") || "本机目录未找到，可在原生客户端刷新模型后重试",
      models: rows,
    });
  }
  return sources;
}
module.exports = { modelSources, nativeModels, nativeTargetId, opencodeProvider };
