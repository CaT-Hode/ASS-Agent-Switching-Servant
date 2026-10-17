const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { HarnessManager } = require("../core/harnesses.cjs");
const { NativeConfig, compose, providerId, locations } = require("../core/native-config.cjs");
const { discoverNative } = require("../core/credential-status.cjs");
const { nativeApiProfiles, promoteNativeApiProfile, promoteNativeSupplier } = require("../core/native-suppliers.cjs");
const { nativeOfficialProvider } = require("../core/native-official.cjs");
const { apiIdentity, sameApi } = require("../core/native-api-identity.cjs");
const { loadOpenCodeConfig } = require("../core/opencode-config.cjs");
const { parseImport } = require("../core/models.cjs");
const { Store } = require("../core/store.cjs");
const additional = require("../core/additional-harnesses.cjs");
const { modelSources } = require("../core/model-inventory.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const KEY = "synthetic-key-a", OTHER = "synthetic-key-b", BASE = "https://api.deepseek.com";

for(const id of ['dsh','pi']) test(`${id}: runtime catalog cannot reimport owned providers as native source cards`,t=>{
  const f=fixture(t);configured(f,id);f.native.sync(id);
  const client=f.manager.snapshot().clients.find(c=>c.id===id);
  const account=client.modelAccounts.find(a=>a.kind==='native'); assert.ok(account);
  const owned=f.native.fields.entries.find(e=>e.harness===id&&e.credentialProvider);assert.ok(owned);
  const rows=[{model:'deepseek-audit',wireApi:'openai-chat',nativeProvider:'deepseek'},
    {model:'owned-only',wireApi:'openai-chat',nativeProvider:owned.credentialProvider}];
  account.supplierId='same';
  const make=()=>modelSources({providers:f.providers,officialModels:[]},{clients:[client]},
    {home:f.home,env:f.env,directories:{['native-'+id]:{accounts:{[account.id]:{models:rows}}}},
      nativeApiModels:[{clientId:id,accountId:account.id,nativeProvider:'deepseek',model:'deepseek-audit',supplierId:'same'}],
      ownsModel:(client,account,model)=>f.native.ownsModel(client.id,account,model)});
  for(let i=0;i<2;i++) assert.equal(make().some(s=>s.id==='native-'+id),false);
  rows.push({model:'genuine-extra',wireApi:'openai-chat',nativeProvider:'deepseek'});
  assert.deepEqual(make().find(s=>s.id==='native-'+id).models.map(m=>m.model),['genuine-extra']);
  const configEntry=f.native.fields.entries.find(e=>e.harness===id&&e.file!==owned.file&&e.path.includes(owned.credentialProvider));
  assert.ok(configEntry);const configBefore=fs.readFileSync(configEntry.file,'utf8');
  const configDoc=require('../core/native-fields.cjs').document(configBefore,configEntry.format);
  let parent=configDoc.data;for(const key of configEntry.path.slice(0,-1))parent=parent[key];
  parent[configEntry.path.at(-1)]={...parent[configEntry.path.at(-1)],baseUrl:'https://changed-native.invalid/v1'};
  put(configEntry.file,configEntry.format==='yaml'?require('yaml').stringify(configDoc.data):configDoc.data);
  assert.equal(f.native.ownsModel(id,account,rows[1]),false,'a changed native endpoint must not be hidden');
  put(configEntry.file,configBefore);assert.equal(f.native.ownsModel(id,account,rows[1]),true);
  // A native credential changed outside ASS is no longer owned; do not hide it.
  const doc=require('../core/native-fields.cjs').document(fs.readFileSync(owned.file,'utf8'),owned.format);
  let value=doc.data;for(const key of owned.path.slice(0,-1))value=value[key];
  const old=value[owned.path.at(-1)];value[owned.path.at(-1)]=typeof old==='string'?'changed-native-key':{...old,key:'changed-native-key',secret:'changed-native-key'};
  put(owned.file,owned.format==='yaml'?require('yaml').stringify(doc.data):doc.data);
  assert.equal(f.native.ownsModel(id,account,rows[1]),false);
});
test('DSH native account and identical saved API display once before/after model injection; other keys remain', (t) => {
  const f = fixture(t); configured(f, 'dsh');
  const inspect = () => f.manager.snapshot({ accountsOnly: true }).clients.find((c) => c.id === 'dsh').accounts;
  const before = inspect(); assert.equal(before.filter((a) => a.providerId === 'same' || a.providerId === 'alias').length, 0);
  assert.equal(before.filter((a) => a.kind === 'native').length, 1); assert.ok(before.some((a) => a.providerId === 'other'));
  f.manager.state.selected.dsh = 'api:same';
  const snap = f.manager.snapshot({ accountsOnly: true }).clients.find((c) => c.id === 'dsh');
  assert.equal(snap.selected, before.find((a) => a.kind === 'native').id);
  f.native.sync('dsh'); assert.equal(inspect().length, before.length);
});
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)); return file; };
function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-api-discovery-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("ass-api-discovery-")); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, "home"), data = path.join(root, "data");
  fs.mkdirSync(home); fs.mkdirSync(data);
  const providers = parseImport({ providers: [
    ["same", KEY, BASE, {}], ["other", OTHER, BASE, {}], ["tenant", KEY, BASE, { "x-tenant": "two" }],
    ["alias", KEY, BASE + "/v1/", {}], ["endpoint", KEY, "https://other.test/v1", {}],
  ].map(([id, apiKey, baseUrl, extraHeaders]) => ({ id, name: id, apiKey, baseUrl, extraHeaders,
    models: [{ model: "deepseek-audit", wireApi: "openai-chat" }] })) });
  const manager = new HarnessManager(data, () => ({ providers }), [], path.join(home, ".codex"), { home, env });
  const originalLauncher = manager.launcher.bind(manager);
  manager.launcher = id => id === 'opencode' ? { ...originalLauncher(id), version: '1.18.33' } : originalLauncher(id);
  const native = new NativeConfig(data, crypt, manager); manager.options.nativeConfig = native;
  const write = (relative, value) => put(path.join(home, relative), value);
  const profiles = (id, options = {}) => {
    const accounts = discoverNative(id, { home, env, ...options }).flatMap((s) => s.accounts);
    return nativeApiProfiles([{ id, accounts }], { home, env });
  };
  return { root, home, data, env, manager, native, providers, write, profiles };
}
function configured(f, id, key = KEY, override) {
  const dir = override || locations(id, f.manager).dir;
  if (id === "dsh") {
    put(path.join(dir, ".credentials.yaml"), { version: 1, refs: { DEEPSEEK_API_KEY: key } });
    put(path.join(dir, "settings.yaml"), { "llm-deepseek": { baseURL: BASE, models: [{ id: "deepseek-audit" }] } });
  } else if (id === "pi") {
    put(path.join(dir, "auth.json"), { deepseek: { type: "api_key", key } });
    put(path.join(dir, "models.json"), { providers: { deepseek: { baseUrl: BASE, api: "openai-completions", models: [{ id: "deepseek-audit" }] } } });
  } else {
    put(path.join(dir, "auth.json"), { deepseek: { type: "api", key } });
    f.write(".config/opencode/opencode.jsonc", { provider: { deepseek: { npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE }, models: { "deepseek-audit": {} } } } });
  }
  return dir;
}
for (const id of ["dsh", "opencode", "pi"]) {
  test(`${id}: dedup exact API only, retain other keys/endpoints/headers in the real write plan`, (t) => {
    const f = fixture(t); configured(f, id);
    const rows = f.manager.injection(id).models;
    assert.deepEqual(Object.fromEntries(rows.map((m) => [m.providerId, m.included])),
      { same: false, other: true, tenant: true, alias: false, endpoint: true });
    assert.equal(compose(id, f.manager).modelCount, 3);
    const before = fs.readFileSync(locations(id, f.manager).auth);
    f.native.sync(id);
    const fields = f.native.fields.entries.filter((e) => e.harness === id);
    assert.equal(fields.some((e) => e.path.includes(providerId(f.providers[0], "openai-chat"))), false);
    assert.equal(f.manager.injection(id).models.filter((m) => m.included).length, 3, "ASS-owned keys never feed back as native APIs");
    f.native.restore([id]);
    const restored = require("../core/native-fields.cjs").document(fs.readFileSync(locations(id, f.manager).auth, "utf8"), id === "dsh" ? "yaml" : "json").data;
    for (const [key, value] of Object.entries(JSON.parse(before))) assert.deepEqual(restored[key], value, "native credentials are preserved on withdrawal");
    if (id === "dsh") assert.deepEqual(restored.records, {});
  });
  test(`${id}: discovery spans homes but exclusions use only the actual target home`, (t) => {
    const f = fixture(t); configured(f, id);
    const active = path.join(f.root, "active", id === "opencode" ? "opencode" : "home"); configured(f, id, OTHER, active);
    f.manager.state.credentialHomes[id] = active;
    const rows = f.manager.injection(id).models;
    assert.equal(rows.find((m) => m.providerId === "same").included, true);
    assert.equal(rows.find((m) => m.providerId === "other").included, false);
    assert.equal(f.manager.nativeApis(id).length, 2);
    assert.equal(compose(id, f.manager).modelCount, 4);
  });
}
test("DeepSeek root and /v1 both remain valid official APIs; arbitrary gateway paths stay distinct", (t) => {
  const f = fixture(t); configured(f, "dsh");
  const account = discoverNative("dsh", { home: f.home }).flatMap((s) => s.accounts)[0];
  for (const baseURL of [BASE, BASE + "/v1"]) {
    f.write(".dsh/settings.yaml", { "llm-deepseek": { baseURL } });
    assert.ok(nativeOfficialProvider({ id: "dsh" }, account, { home: f.home, env: {} }));
  }
  assert.equal(sameApi({ baseUrl: BASE, apiKey: KEY }, { baseUrl: BASE + "/v1", apiKey: KEY }), true);
  assert.equal(sameApi({ baseUrl: "https://custom.test", apiKey: KEY }, { baseUrl: "https://custom.test/v1", apiKey: KEY }), false);
});
test("no catalog is required: Pi built-in auth, DSH profile API and OpenCode config/env are suppliers", (t) => {
  const f = fixture(t, { TEST_KEY: KEY });
  f.write(".pi/agent/auth.json", { openai: { type: "api_key", key: KEY } });
  let profiles = f.profiles("pi"); assert.equal(profiles.length, 1); assert.deepEqual(profiles[0].models, []);
  assert.equal(profiles[0].baseUrl, "https://api.openai.com/v1");
  f.write(".dsh/profiles/web/cordis.patch.yml", '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        apiKeyEnv: TEST_KEY\n        baseURL: https://custom.test/v1\n        api: openai-completions\n');
  profiles = f.profiles("dsh"); assert.equal(profiles.length, 1); assert.deepEqual(profiles[0].models, []);
  f.write(".config/opencode/opencode.json", { provider: { relay: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom.test/v1", apiKey: "{env:TEST_KEY}" } } } });
  profiles = f.profiles("opencode"); assert.equal(profiles.length, 1); assert.deepEqual(profiles[0].models, []);
  const store = new Store(path.join(f.root, "store"), f.home, crypt);
  const id = promoteNativeApiProfile({ store, profile: profiles[0] }); assert.ok(id);
  assert.equal(new Store(path.join(f.root, "store"), f.home, crypt).state.providers[0].models.length, 0);
});
test("OpenCode merges selected project/custom/inline/managed layers including nested options", (t) => {
  const f = fixture(t, { TEST_KEY: KEY });
  const project = path.join(f.root, "project"), workspace = path.join(project, "child"); fs.mkdirSync(path.join(project, ".git"), { recursive: true }); fs.mkdirSync(workspace);
  const base = { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom.test/v1", apiKey: "{env:TEST_KEY}", headers: { "x-tenant": "global" } }, models: { audit: {} } };
  f.write(".config/opencode/opencode.json", { provider: { relay: base } });
  put(path.join(project, "opencode.json"), { provider: { relay: { options: { baseURL: "https://project.test/v1" } } } });
  let profile = f.profiles("opencode", { workspace })[0]; assert.equal(profile.baseUrl, "https://project.test/v1"); assert.equal(profile.extraHeaders["x-tenant"], "global");
  f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { relay: { options: { apiKey: OTHER, headers: { "x-tenant": "inline" } } } } });
  profile = f.profiles("opencode", { workspace })[0]; assert.equal(profile.apiKey, OTHER); assert.equal(profile.extraHeaders["x-tenant"], "inline");
  f.env.ProgramData = path.join(f.root, "managed");
  put(path.join(f.env.ProgramData, "opencode/opencode.json"), { disabled_providers: ["relay"] });
  assert.equal(f.profiles("opencode", { workspace }).length, 0);
  assert.equal(loadOpenCodeConfig({ home: f.home, env: f.env, workspace }).data.provider.relay.models.audit !== undefined, true);
  assert.equal(f.profiles("opencode").length, 0);
});
test("OpenCode discovers project-only and inline-only APIs; malformed overrides never fall back to another key", (t) => {
  const f = fixture(t), workspace = path.join(f.root, "project");
  const config = { provider: { relay: { npm: "@ai-sdk/openai-compatible", options: { apiKey: KEY, baseURL: "https://relay.test/v1" } } } };
  put(path.join(workspace, "opencode.jsonc"), config);
  assert.equal(f.profiles("opencode", { workspace }).length, 1);
  assert.equal(f.profiles("opencode").length, 0);
  f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  assert.equal(f.profiles("opencode").length, 1);
  f.env.OPENCODE_CONFIG_CONTENT = "{broken";
  assert.equal(f.profiles("opencode", { workspace }).length, 0);
});
test("API identities ignore only equivalent auth headers, not project/tenant headers", () => {
  const a = { baseUrl: BASE, apiKey: KEY, extraHeaders: { "X-Tenant": "one" } };
  assert.equal(sameApi(a, { ...a, extraHeaders: { "x-tenant": "one", Authorization: "Bearer " + KEY } }), true);
  assert.equal(sameApi(a, { ...a, extraHeaders: { "x-tenant": "two" } }), false);
  assert.equal(apiIdentity({ ...a, extraHeaders: { authorization: "Bearer different" } }), "");
});
test("aggregation persists separate keys/headers, adds new models, preserves edits and removed models", (t) => {
  const f = fixture(t), store = new Store(path.join(f.root, "store"), f.home, crypt);
  const profile = { name: "Native", baseUrl: BASE, apiKey: KEY, wireApi: "openai-chat", models: [{ model: "a" }] };
  const id = promoteNativeApiProfile({ store, profile });
  assert.equal(promoteNativeApiProfile({ store, profile: { ...profile, baseUrl: BASE + "/v1" } }), id);
  assert.notEqual(promoteNativeApiProfile({ store, profile: { ...profile, apiKey: OTHER } }), id);
  assert.notEqual(promoteNativeApiProfile({ store, profile: { ...profile, extraHeaders: { "x-tenant": "other" } } }), id);
  store.model(id, { ...store.state.providers[0].models[0], displayName: "My name" }, "a");
  promoteNativeApiProfile({ store, profile: { ...profile, models: [{ model: "a" }, { model: "b" }] } });
  assert.equal(store.state.providers[0].models[0].displayName, "My name");
  store.removeModel(id, "a"); promoteNativeApiProfile({ store, profile });
  assert.deepEqual(store.state.providers[0].models.map((m) => m.model), ["b"]);
  const loaded = new Store(path.join(f.root, "store"), f.home, crypt);
  assert.equal(loaded.state.providers.length, 3);
  assert.doesNotMatch(JSON.stringify(loaded.public()), /synthetic-key/);
  loaded.state.nativeApiExclusions = [apiIdentity(profile)]; loaded.state.providers = [];
  assert.equal(promoteNativeApiProfile({ store: loaded, profile }), null);
});
test("Pi stored key wins over config/env; OAuth, helpers, file refs and ASS routes are not promoted", (t) => {
  const f = fixture(t, { TEST_KEY: OTHER });
  f.write(".pi/agent/models.json", { providers: { relay: { apiKey: "${TEST_KEY}", baseUrl: "https://custom.test/v1", api: "openai-completions" } } });
  assert.equal(f.profiles("pi")[0].apiKey, OTHER);
  f.write(".pi/agent/auth.json", { relay: { type: "api_key", key: KEY } });
  assert.equal(f.profiles("pi")[0].apiKey, KEY);
  for (const key of ["!external-command", "{file:/private/key}"]) {
    f.write(".pi/agent/auth.json", { relay: { type: "api_key", key } });
    assert.equal(f.profiles("pi").length, 0);
  }
  f.write(".pi/agent/auth.json", { relay: { type: "oauth", access: "fixture-oauth", refresh: "fixture-refresh", expires: 2100000000000 } });
  assert.equal(f.profiles("pi").length, 0);
  f.write(".claude/settings.json", { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "http://127.0.0.1:25819/clients/claude/models/v1" } });
  assert.equal(f.profiles("claude").length, 0);
});
test("Codex explicit credentials/headers are discovered without borrowing the official key; Claude API does not need models", (t) => {
  const f = fixture(t, { API_RELAY: KEY, ORG: "tenant-a", OPENAI_API_KEY: OTHER });
  f.write(".codex/config.toml", 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.test/v1"\nwire_api = "responses"\nenv_key = "API_RELAY"\n[model_providers.relay.env_http_headers]\nx-tenant = "ORG"\n[model_providers.no_auth]\nbase_url = "https://elsewhere.test/v1"\nwire_api = "responses"\n');
  const profiles = f.profiles("codex"); assert.equal(profiles.length, 1); assert.equal(profiles[0].apiKey, KEY); assert.equal(profiles[0].extraHeaders["x-tenant"], "tenant-a");
  f.write(".claude/settings.json", { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://relay.test/anthropic" } });
  assert.equal(f.profiles("claude").length, 1);
});
test("Kimi and ZCode API-only providers can aggregate without model declarations", (t) => {
  const f = fixture(t);
  f.write(".kimi-code/config.toml", '[providers.relay]\ntype = "openai"\nbase_url = "https://relay.test/v1"\napi_key = "synthetic-key-a"\n');
  f.write(".zcode/v2/provider_config.json", { schemaVersion: 1, config: { providerConfigRules: { providerRules: [
    { providerId: "relay", config: { api: { type: "openai-chat-completions", baseUrl: "https://relay.test/v1" }, access: { type: "api-key", apiKey: KEY } } },
  ] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } });
  for (const id of ["kimi", "zcode"]) {
    const state = additional.inspect(id, { home: f.home, env: {}, now: Date.now() });
    const groups = nativeApiProfiles([{ id, accounts: [...state.accounts, ...state.modelAccounts, ...state.apiAccounts] }], { home: f.home, env: {} });
    assert.equal(groups.length, 1, id); assert.equal(groups[0].models.length, 0);
  }
});
test("when all selected APIs are already native, enable is a no-op instead of an error", (t) => {
  const f = fixture(t); configured(f, "dsh"); f.providers.splice(1);
  f.native.sync("dsh");
  assert.equal(f.native.status("dsh", true).error, "");
  assert.equal(f.native.fields.entries.length, 0);
});
test("OpenCode official API verification and aggregation use the same effective key", (t) => {
  const f = fixture(t, { TEST_KEY: OTHER });
  f.write(".local/share/opencode/auth.json", { "opencode-go": { type: "api", key: KEY } });
  f.write(".config/opencode/opencode.json", { provider: { "opencode-go": { options: { apiKey: "{env:TEST_KEY}" } } } });
  const accounts = discoverNative("opencode", { home: f.home, env: f.env }).flatMap((s) => s.accounts);
  const provider = nativeOfficialProvider({ id: "opencode" }, accounts[0], { home: f.home, env: f.env });
  assert.equal(provider.apiKey, OTHER);
  assert.equal(f.profiles("opencode")[0].apiKey, OTHER);
});
test("explicit sync removes only an old duplicate ASS injection after native API appears", (t) => {
  const f = fixture(t); f.providers.splice(1);
  f.native.sync("pi"); assert.ok(f.native.fields.entries.length);
  const location = locations("pi", f.manager), auth = JSON.parse(fs.readFileSync(location.auth));
  auth.deepseek = { type: "api_key", key: KEY }; put(location.auth, auth);
  f.native.sync("pi");
  const restored = JSON.parse(fs.readFileSync(location.auth));
  assert.deepEqual(restored, { deepseek: { type: "api_key", key: KEY } });
  assert.equal(f.native.fields.entries.length, 0);
});
test("independent profile inheritance checks that profile's native key, not the default home", (t) => {
  const f = fixture(t); f.providers.splice(1); f.native.sync("pi");
  const dir = path.join(f.data, "clients/pi", "a".repeat(24));
  put(path.join(dir, "auth.json"), { deepseek: { type: "api_key", key: KEY } });
  f.native.syncProfile("pi", dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"))), { deepseek: { type: "api_key", key: KEY } });
  assert.equal(fs.existsSync(path.join(dir, "models.json")), false);
});
test("partial aggregation hides only promoted models, not unsupported models belonging to that account", () => {
  const sources = modelSources({ officialModels: [], providers: [{ id: "supplier", models: [{ model: "good" }] }] },
    { clients: [{ id: "pi", name: "pi", accounts: [{ id: "account", kind: "native", supplierId: "supplier" }] }] },
    { directories: { "native-pi": { accounts: { account: { models: [
      { model: "good", nativeProvider: "relay" }, { model: "native-only", nativeProvider: "relay" },
    ] } } } }, nativeApiModels: [{ clientId: "pi", accountId: "account", nativeProvider: "relay", model: "good", supplierId: "supplier" }] });
  assert.deepEqual(sources.find((s) => s.id === "native-pi").models.map((m) => m.model), ["native-only"]);
});
test("native DSH catalog aliases do not create a second card for the same key and model", () => {
  const supplier = { id: "deepseek-key", models: [{ model: "deepseek-flash" }, { model: "deepseek-v4-pro" }] };
  const client = { id: "dsh", name: "DeepSeek Harness", accounts: [{
    id: "native-dsh", kind: "native", authType: "api", supplierId: supplier.id,
  }] };
  const directories = { "native-dsh": { accounts: { "native-dsh": { models: [
    { model: "deepseek-flash", nativeProvider: "deepseek" },
    { model: "deepseek-v4-pro", nativeProvider: "deepseek" },
  ] } } } };
  const nativeApiModels = [{ clientId: "dsh", accountId: "native-dsh", nativeProvider: "deepseek-official",
    model: "deepseek-flash", supplierId: supplier.id }];
  const sources = modelSources({ officialModels: [], providers: [supplier] }, { clients: [client] },
    { directories, nativeApiModels });
  assert.equal(sources.some(s => s.id === "native-dsh"), false);
  assert.equal(sources.find(s => s.id === supplier.id).models.length, 2);
  directories["native-dsh"].accounts["native-dsh"].models.push({ model: "native-only", nativeProvider: "deepseek" });
  const unpromoted = modelSources({ officialModels: [], providers: [supplier] }, { clients: [client] },
    { directories, nativeApiModels }).find(s => s.id === "native-dsh");
  assert.deepEqual(unpromoted.models.map(m => m.model), ["native-only"]);
});
