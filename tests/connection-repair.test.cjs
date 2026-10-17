const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../core/store.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { NativeConfig, locations } = require("../core/native-config.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const { Connections } = require("../core/connections.cjs");
const { ConfigManager } = require("../core/config.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const { document } = require("../core/native-fields.cjs");
const zcode = require("../core/zcode-config.cjs");
const key = crypto.randomBytes(32);
const crypt = {
  isEncryptionAvailable: () => true,
  encryptString(s) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(b) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(); },
};
function put(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2)); }
const text = (file) => fs.readFileSync(file, "utf8");
const decode = (file) => JSON.parse(crypt.decryptString(Buffer.from(JSON.parse(text(file)).encrypted, "base64")));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-repair-")), home = path.join(root, "home"), data = path.join(root, "data"), codex = path.join(home, ".codex");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(path.join(codex, "config.toml"), 'model = "native"\n[features]\nkeep = true\n');
  put(path.join(codex, "auth.json"), { tokens: { access_token: "synthetic-oauth-preserved" } });
  put(path.join(home, ".kimi-code/config.toml"), 'default_model = "native"\n[providers.kimi]\ntype = "kimi"\n[models.native]\nmodel = "kimi-test"\nprovider = "kimi"\n');
  const z = zcode.empty(); z.config.providerConfigRules.providerRules.push({ providerId: "custom", config: { keep: true } });
  put(path.join(home, ".zcode/v2/provider_config.json"), z);
  const store = new Store(data, codex, crypt);
  store.updateProvider({ id: "fixture", name: "Fixture", apiKey: "synthetic-repair-key", baseUrl: "https://original.example/v1",
    models: [{ model: "test-model", wireApi: "openai-chat", defaultEffort: "high" }] });
  const manager = new HarnessManager(data, () => store.state, store.officialModels, codex, { home, env: {}, launchEnv: {}, isConnected: () => true });
  const native = new NativeConfig(data, crypt, manager), config = new ConfigManager(codex, data);
  const proxy = new ProxyConfig(data, crypt, manager, store, config);
  Object.assign(manager.options, { nativeConfig: native, proxyConfig: proxy });
  const router = { active: 0, starts: 0, stops: 0, clientActive() { return this.active; }, async start() { this.starts++; }, async stop() { this.stops++; } };
  const processes = { stops: 0, snapshot: () => ({ sessions: [] }), refresh: async () => {}, async stop() { this.stops++; } };
  const connections = new Connections({ dataDir: data, router, processes, config, nativeConfig: native, proxyConfig: proxy, injections: new InjectionFiles(data) });
  return { root, home, data, codex, store, manager, native, config, proxy, router, processes, connections };
}
async function enable(f, id) { const p = await f.connections.preview(id, true); return f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true }); }
async function repair(f, id) { const p = await f.connections.repairPreview(id); return f.connections.repairApply({ ticket: p.ticket, acknowledged: true }); }

function upgradedDSH(f, profile = "web") {
  put(path.join(f.home, ".dsh/desktop-link/web.json"), { coreVersion: "0.1.7-rc.2", profile });
  return locations("dsh", f.manager);
}
test("current DSH writes profile patches, preserves other plugins and credentials, and supports repair/withdrawal", async (t) => {
  const f = fixture(t), target = upgradedDSH(f);
  const plugins = '# personal plugins\n- id: keep-plugin\n  disabled: !!js "true"\n';
  put(target.config, plugins);
  put(target.auth, { version: 1, refs: { DEEPSEEK_API_KEY: "synthetic-native" } });
  await enable(f, "dsh");
  assert.equal(target.format, "dsh-patch");
  assert.match(text(target.config), /!!js "true"/);
  assert.equal(fs.existsSync(path.join(target.dir, "settings.yaml")), false);
  assert.equal(Object.keys(document(text(target.config), "dsh-patch").data["llm-pi-ai"].providers).length, 1);
  put(target.config, text(target.config).replace("https://original.example/v1", "https://changed.example/v1"));
  await repair(f, "dsh");
  assert.match(text(target.config), /original.example/);
  f.native.restore(["dsh"]);
  assert.deepEqual(document(text(target.config), "dsh-patch").data["llm-pi-ai"].providers, {});
  assert.match(text(target.config), /# personal plugins/);
  assert.equal(document(text(target.auth), "yaml").data.refs.DEEPSEEK_API_KEY, "synthetic-native");
  assert.equal(f.processes.stops, 0);
});
test("DSH upgrade repair relocates only last applied fields, persists ownership and does not apply drafts", async (t) => {
  const f = fixture(t), legacy = locations("dsh", f.manager);
  put(legacy.config, 'other-setting:\n  keep: true\n');
  await enable(f, "dsh");
  const auth = text(legacy.auth), target = upgradedDSH(f);
  put(target.config, '- id: existing-plugin\n  config:\n    value: 7\n');
  f.store.state.providers[0].baseUrl = "https://pending.example/v1";
  assert.match(f.connections.snapshot().clients.dsh.syncError, /尚未迁移/);
  await assert.rejects(f.connections.preview("dsh", true), /迁移/);
  const p = await f.connections.repairPreview("dsh"); assert.equal(p.migration, true);
  await f.connections.repairApply({ ticket: p.ticket, acknowledged: true });
  assert.match(text(target.config), /original.example/); assert.doesNotMatch(text(target.config), /pending.example/);
  assert.match(text(legacy.config), /keep: true/); assert.doesNotMatch(text(legacy.config), /original.example/);
  assert.equal(text(legacy.auth), auth);
  assert.equal(f.connections.snapshot().clients.dsh.pending, true);
  const restarted = new NativeConfig(f.data, crypt, f.manager);
  assert.ok(restarted.fields.entries.some((e) => e.format === "dsh-patch"));
  assert.equal(restarted.fields.entries.some((e) => e.file === legacy.config), false);
  assert.ok(fs.readdirSync(path.join(f.data, "backups")).some((n) => n.startsWith("native-migration-dsh-")));
  restarted.restore(["dsh"]); assert.doesNotMatch(text(target.config), /original.example/);
  assert.match(text(target.config), /existing-plugin/); assert.equal(f.processes.stops, 0);
});
test("DSH migration supports renamed legacy settings and rejects a changed target after confirmation", async (t) => {
  const f = fixture(t), legacy = locations("dsh", f.manager);
  await enable(f, "dsh"); fs.renameSync(legacy.config, legacy.config + ".imported");
  const archive = text(legacy.config + ".imported"), target = upgradedDSH(f);
  const p = await f.connections.repairPreview("dsh");
  put(target.config, '- id: custom-plugin\n');
  await assert.rejects(f.connections.repairApply({ ticket: p.ticket, acknowledged: true }), /配置已变化/);
  await repair(f, "dsh"); assert.match(text(target.config), /original.example/);
  assert.equal(text(legacy.config + ".imported"), archive); assert.equal(fs.existsSync(legacy.config), false);
});

test("DSH recognizes an already copied profile and transfers ownership for later withdrawal", async (t) => {
  const f = fixture(t), legacy = locations("dsh", f.manager);
  await enable(f, "dsh");
  const target = upgradedDSH(f), settings = document(text(legacy.config), "yaml").data;
  put(target.config, JSON.stringify([{ id: "llm-pi-ai", config: settings["llm-pi-ai"] }]));
  const profileBefore = text(target.config);
  await repair(f, "dsh");
  assert.equal(text(target.config), profileBefore, "identical active profile must not be rewritten");
  assert.equal(f.connections.snapshot().clients.dsh.syncError, "");
  assert.equal(f.connections.snapshot().clients.dsh.pending, false);
  const dsh = require("../core/dsh-config.cjs");
  const accountHome = path.join(f.data, "clients/dsh/0123456789abcdef01234567");
  f.native.syncProfile("dsh", accountHome);
  assert.equal(dsh.target(accountHome).format, "dsh-patch");
  assert.equal(Object.keys(dsh.readSettings(accountHome, () => { throw Error("legacy reader must not run"); })["llm-pi-ai"].providers).length, 1);
  new NativeConfig(f.data, crypt, f.manager).restore(["dsh"]);
  assert.doesNotMatch(text(target.config), /original.example/);
  assert.equal(f.processes.stops, 0);
});
test("DSH rejects conflicting patch providers, duplicate entries, unsafe profiles and model expressions", async (t) => {
  const f = fixture(t), legacy = locations("dsh", f.manager);
  await enable(f, "dsh"); const target = upgradedDSH(f);
  const providers = document(text(legacy.config), "yaml").data["llm-pi-ai"].providers;
  put(target.config, JSON.stringify([{ id: "llm-pi-ai", config: { providers: JSON.parse(JSON.stringify(providers).replace("original.example", "foreign.example")) } }]));
  await assert.rejects(f.connections.repairPreview("dsh"), /已有不同/);
  put(target.config, '- id: llm-pi-ai\n- id: llm-pi-ai\n');
  await assert.rejects(f.connections.repairPreview("dsh"), /重复/);
  put(target.config, '- id: llm-pi-ai\n  config:\n    providers: !!js "process.env"\n');
  await assert.rejects(f.connections.repairPreview("dsh"), /表达式/);
  put(path.join(target.dir, "desktop-link/web.json"), { coreVersion: "0.1.7-rc.2", profile: "../escape" });
  assert.throws(() => locations("dsh", f.manager), /profile 名称/);
});

for (const id of ["dsh", "opencode", "pi", "kimi", "zcode"]) test(`${id}: one-click repair restores applied fields, keeps OAuth/user settings/drafts and original withdrawal baseline`, async (t) => {
  const f = fixture(t), target = locations(id, f.manager);
  if (id === "dsh") { put(target.config, '# preserved comment\nplugins: [custom]\n'); put(target.auth, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-official\n'); }
  if (["pi", "opencode"].includes(id)) { put(target.config, { plugin: ["custom"] }); put(target.auth, { "openai-codex": { type: "oauth", access: "synthetic-official" } }); }
  const originalAuth = target.auth && text(target.auth), configBefore = text(target.config);
  await enable(f, id);
  const applied = text(target.config), entriesBefore = structuredClone(f.native.fields.entries);
  put(target.config, applied.replaceAll("https://original.example/v1", "https://changed.example/v1"));
  const changed = text(target.config);
  assert.match(f.connections.snapshot().clients[id].syncError, /外部修改/);
  // The next draft must not be applied by a repair confirmation.
  f.store.state.providers[0].baseUrl = "https://pending.example/v1";
  await assert.rejects(f.connections.preview(id, true), /外部修改/);
  const preview = await f.connections.repairPreview(id);
  assert.doesNotMatch(JSON.stringify(preview), /synthetic|original\.example|changed\.example/);
  assert.ok(preview.files > 0);
  assert.equal((await f.connections.repairApply({ ticket: preview.ticket, acknowledged: true })).ok, true);
  assert.equal(text(target.config), applied);
  assert.deepEqual(f.native.fields.entries, entriesBefore, "repair must not reset original before-values");
  const status = f.connections.snapshot().clients[id];
  assert.equal(status.syncError, ""); assert.equal(status.enabled, true); assert.equal(status.pending, true);
  const backups = fs.readdirSync(path.join(f.data, "backups")).filter((s) => s.startsWith("native-repair-"));
  assert.equal(backups.length, 1);
  const backupFile = path.join(f.data, "backups", backups[0]);
  assert.doesNotMatch(text(backupFile), /synthetic|changed\.example/);
  assert.equal(decode(backupFile).files.find((e) => e.file === target.config).before, changed);
  assert.equal(f.processes.stops, 0); assert.equal(f.router.starts, 0);
  // Reload the persisted ownership record and verify disconnect remains safe.
  const restarted = new NativeConfig(f.data, crypt, f.manager); restarted.restore([id]);
  if (id === "kimi") assert.equal(text(target.config), configBefore);
  else assert.deepEqual(document(text(target.config), id === "dsh" ? "yaml" : "jsonc").data.plugin ||
    document(text(target.config), id === "dsh" ? "yaml" : "jsonc").data.plugins ||
    document(text(target.config), "json").data.config?.providerConfigRules.providerRules,
    id === "zcode" ? [{ providerId: "custom", config: { keep: true } }] : ["custom"]);
  if (target.auth) {
    const after = document(text(target.auth), id === "dsh" ? "yaml" : "json").data;
    if (id === "dsh" && after.records && !Object.keys(after.records).length) delete after.records;
    assert.deepEqual(after, document(originalAuth, id === "dsh" ? "yaml" : "json").data);
  }
});

test("Codex repair restores managed config and catalog, preserves OAuth/user settings and does not apply drafts", async (t) => {
  const f = fixture(t); await enable(f, "codex");
  const applied = text(f.config.file), catalog = text(f.config.catalog), oauth = text(path.join(f.codex, "auth.json"));
  put(f.config.file, applied.replace("25819/clients", "25899/clients").replace("keep = true", "keep = false"));
  put(f.config.catalog, "corrupt generated catalog");
  f.store.state.providers[0].baseUrl = "https://pending.example/v1";
  await repair(f, "codex");
  assert.equal(text(f.config.file), applied.replace("keep = true", "keep = false"));
  assert.equal(text(f.config.catalog), catalog); assert.equal(text(path.join(f.codex, "auth.json")), oauth);
  assert.equal(f.proxy.routingState("codex").providers[0].baseUrl, "https://original.example/v1");
  assert.equal(f.connections.snapshot().clients.codex.syncError, "");
  f.config.detach(); assert.match(text(f.config.file), /keep = false/); assert.doesNotMatch(text(f.config.file), /ass_router/);
  assert.equal(f.router.stops, 0); assert.equal(f.processes.stops, 0);
});

test('Codex config repair stays available when optional process inspection fails', async t => {
  const f=fixture(t);await enable(f,'codex');
  f.connections.restarter={preview:async()=>{throw Error('Synthetic process inspection failure');},public:p=>p};
  const before=[text(f.config.file),text(path.join(f.codex,'auth.json'))];
  const p=await f.connections.repairPreview('codex');
  assert.equal(p.restart.available,false);assert.equal(p.restart.closeAvailable,false);
  assert.match(p.restart.reason,/仍可仅修复配置/);
  await assert.rejects(f.connections.repairApply({ticket:p.ticket,acknowledged:true,restart:true}),/重启目标/);
  assert.equal((await f.connections.repairApply({ticket:p.ticket,acknowledged:true})).ok,true);
  await repair(f,'codex');assert.deepEqual([text(f.config.file),text(path.join(f.codex,'auth.json'))],before);
  assert.equal(f.processes.stops,0);
});

test('one-click repair rolls back an interrupted Codex transaction, preserves drafts, and supports repeat repair', async t => {
  const f=fixture(t);await enable(f,'codex');
  const before=[text(f.config.file),text(f.config.catalog),text(f.config.record),text(path.join(f.codex,'auth.json'))];
  const partial=before[1].slice(0,60);
  f.proxy.persist(f.proxy.clients,{files:[{file:f.config.catalog,before:before[1],after:partial}]});put(f.config.catalog,partial);
  f.store.state.providers[0].baseUrl='https://unapplied.invalid/v1';
  const p=await f.connections.repairPreview('codex');assert.equal(p.files,1);
  assert.equal(text(f.config.catalog),partial,'preview must not write');
  assert.equal((await f.connections.repairApply({ticket:p.ticket,acknowledged:true})).ok,true);
  assert.equal(f.proxy.pending,null);await repair(f,'codex');
  assert.deepEqual([text(f.config.file),text(f.config.catalog),text(f.config.record),text(path.join(f.codex,'auth.json'))],before);
  assert.equal(f.proxy.clients.codex.providers[0].baseUrl,'https://original.example/v1');assert.equal(f.processes.stops,0);
});

test('pending repair retries disk failure, refuses external changes, and does not expand to another client', async t => {
  const f=fixture(t);await enable(f,'codex');
  const before=text(f.config.catalog),partial=before.slice(0,60);
  f.proxy.persist(f.proxy.clients,{files:[{file:f.config.catalog,before,after:partial}]});put(f.config.catalog,partial);
  const p=await f.connections.repairPreview('codex'),write=fs.writeFileSync;
  fs.writeFileSync=function(file,...args){if(String(file).startsWith(f.config.catalog+'.'))throw Error('Synthetic disk full');return write.call(this,file,...args);};
  try {await assert.rejects(f.connections.repairApply({ticket:p.ticket,acknowledged:true}),/disk full/);}finally{fs.writeFileSync=write;}
  assert.ok(f.proxy.pending);assert.equal(text(f.config.catalog),partial);
  const saved=text(f.proxy.file);put(f.config.catalog,'external new catalog');
  await assert.rejects(f.connections.repairPreview('codex'),/外部修改/);assert.equal(text(f.proxy.file),saved);
  put(f.config.catalog,partial);await repair(f,'codex');assert.equal(text(f.config.catalog),before);assert.equal(f.proxy.pending,null);
  await enable(f,'claude');
  const foreign=require('../core/claude-native.cjs').targets(f.manager).settings;
  put(foreign,'{"synthetic":true}');const value=text(foreign);
  f.proxy.persist(f.proxy.clients,{files:[{file:foreign,before:value,after:value}]});
  await assert.rejects(f.connections.repairPreview('codex'),/涉及其他客户端/);assert.ok(f.proxy.pending);
});

test('explicit repair seeds missing legacy attachment evidence without applying pending edits',async t=>{
  const f=fixture(t);await enable(f,'codex');
  const legacy=structuredClone(f.proxy.clients.codex);delete legacy.attachment;f.proxy.persist({codex:legacy});
  fs.unlinkSync(f.proxy.codexRecovery.file);
  const before=[text(f.config.file),text(f.config.record),text(path.join(f.codex,'auth.json'))];
  f.store.state.providers[0].baseUrl='https://unapplied.invalid/v1';await repair(f,'codex');
  assert.ok(f.proxy.clients.codex.attachment);assert.ok(fs.existsSync(f.proxy.codexRecovery.file));
  const checkpoint=text(f.proxy.codexRecovery.file);await repair(f,'codex');assert.equal(text(f.proxy.codexRecovery.file),checkpoint);
  assert.deepEqual([text(f.config.file),text(f.config.record),text(path.join(f.codex,'auth.json'))],before);
  assert.equal(f.proxy.clients.codex.providers[0].baseUrl,'https://original.example/v1');
});

for (const broken of [null,'{}']) test(`one-click repair restores a ${broken===null?'lost':'incomplete'} record after startup`,async t=>{
  const f=fixture(t);await enable(f,'codex');
  const before=[text(f.config.file),text(f.config.catalog),text(path.join(f.codex,'auth.json'))];
  if(broken===null)fs.unlinkSync(f.config.record);else put(f.config.record,broken);
  f.store.state.providers[0].baseUrl='https://unapplied.invalid/v1';
  await repair(f,'codex');assert.deepEqual(JSON.parse(text(f.config.record)),f.proxy.clients.codex.attachment);
  await repair(f,'codex');assert.deepEqual([text(f.config.file),text(f.config.catalog),text(path.join(f.codex,'auth.json'))],before);
  assert.equal(f.proxy.clients.codex.providers[0].baseUrl,'https://original.example/v1');assert.equal(f.processes.stops,0);
});

test("Codex repair can explicitly force restart, preserving OAuth and never applying pending drafts", async (t) => {
  const f = fixture(t); await enable(f, "codex");
  const applied = text(f.config.file), oauth = text(path.join(f.codex, "auth.json")), calls = [];
  put(f.config.file, applied.replace("25819/clients", "25899/clients"));
  f.store.state.providers[0].baseUrl = "https://pending.example/v1";
  f.connections.restarter = {
    preview: async () => ({ applicable: true, available: true }), public: (p) => p,
    stop: async () => { calls.push("stop"); assert.match(text(f.config.file), /25899/); },
    launch: async (_plan, ready) => { calls.push("launch"); assert.equal(text(f.config.file), applied); ready(); assert.equal(f.connections.allow("codex"), true); return { ok: true }; },
  };
  f.router.active = 1;
  f.router.cancelClient = async (id) => { assert.equal(id, "codex"); calls.push("cancel"); f.router.active = 0; };
  const p = await f.connections.repairPreview("codex");
  assert.equal(p.restart.available, true);
  const result = await f.connections.repairApply({ ticket: p.ticket, acknowledged: true, restart: true });
  assert.equal(result.restart.ok, true); assert.deepEqual(calls, ["stop", "cancel", "launch"]);
  assert.equal(text(path.join(f.codex, "auth.json")), oauth);
  assert.equal(f.proxy.routingState("codex").providers[0].baseUrl, "https://original.example/v1");
  assert.equal(f.processes.stops, 0);
});

test("repair refuses force restart for DSH and reports Codex relaunch failures without undoing a successful repair", async (t) => {
  const f = fixture(t); await enable(f, "dsh"); await enable(f, "codex");
  const target = locations("dsh", f.manager);
  put(target.config, text(target.config).replace("original.example", "changed.example"));
  const dsh = await f.connections.repairPreview("dsh");
  await assert.rejects(f.connections.repairApply({ ticket: dsh.ticket, acknowledged: true, restart: true }), /重启目标/);
  assert.equal(f.processes.stops, 0);
  put(f.config.file, text(f.config.file).replace("25819/clients", "25899/clients"));
  f.connections.restarter = { preview: async () => ({ available: true }), public: (p) => p,
    stop: async () => {}, launch: async () => { throw Error("launch failed"); } };
  f.router.cancelClient = async () => {};
  const p = await f.connections.repairPreview("codex");
  const result = await f.connections.repairApply({ ticket: p.ticket, acknowledged: true, restart: true });
  assert.equal(result.ok, true); assert.equal(result.restart.ok, false);
  assert.equal(f.connections.snapshot().clients.codex.syncError, "");
  assert.match(result.message, /重启未完成/);
});

test("Claude Code repair restores its trusted route without overwriting another client or restarting a window", async (t) => {
  const f = fixture(t); await enable(f, "claude"); await enable(f, "codex");
  const saved = decode(f.proxy.file), codexBefore = structuredClone(f.proxy.clients.codex);
  saved.clients.claude.providers[0].baseUrl = "https://changed.example/v1";
  put(f.proxy.file, { version: 1, encrypted: crypt.encryptString(JSON.stringify(saved)).toString("base64") });
  assert.match(f.connections.snapshot().clients.claude.syncError, /外部修改/);
  await repair(f, "claude");
  assert.equal(decode(f.proxy.file).clients.claude.providers[0].baseUrl, "https://original.example/v1");
  assert.deepEqual(decode(f.proxy.file).clients.codex, codexBefore);
  assert.equal(f.connections.snapshot().clients.claude.syncError, "");
  assert.equal(f.router.stops, 0); assert.equal(f.processes.stops, 0);
});

test("repair refuses stale confirmations, active routed requests, ticket reuse and untrusted ownership records", async (t) => {
  const f = fixture(t); await enable(f, "dsh"); const target = locations("dsh", f.manager);
  put(target.config, text(target.config).replace("original.example", "changed.example"));
  const p = await f.connections.repairPreview("dsh");
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true }), /一键修复/);
  put(target.config, text(target.config) + "\n# simultaneous user edit\n");
  await assert.rejects(f.connections.repairApply({ ticket: p.ticket, acknowledged: true }), /已变化/);
  await assert.rejects(f.connections.repairApply({ ticket: p.ticket, acknowledged: true }), /过期/);
  f.router.active = 1; await assert.rejects(repair(f, "dsh"), /请求正在进行/); f.router.active = 0;
  assert.match(text(target.config), /changed.example/);
  put(f.native.fields.file, "broken journal");
  await assert.rejects(f.connections.repairPreview("dsh"), /接入记录被外部修改/);
  assert.equal(f.connections.busy, false);
});

test("repair rejects malformed documents and Codex blocks with foreign fields", async (t) => {
  const f = fixture(t); await enable(f, "dsh"); await enable(f, "codex");
  const target = locations("dsh", f.manager); put(target.config, "a: [unterminated");
  await assert.rejects(f.connections.repairPreview("dsh"), /无法解析/);
  const bad = text(f.config.file).replace('name = "ASS"', 'name = "changed"\nforeign_setting = true'); put(f.config.file, bad);
  await assert.rejects(f.connections.repairPreview("codex"), /非 ASS 字段/); assert.equal(text(f.config.file), bad);
});

test("failed multi-file native repair rolls back to externally edited files while retaining encrypted backup", async (t) => {
  const f = fixture(t); await enable(f, "dsh"); const target = locations("dsh", f.manager);
  put(target.config, text(target.config).replace("original.example", "changed.example"));
  put(target.auth, text(target.auth).replace("synthetic-repair-key", "synthetic-external-key"));
  const before = [text(target.config), text(target.auth)], p = await f.connections.repairPreview("dsh");
  const rename = fs.renameSync; let fail = true;
  fs.renameSync = (a, b) => { if (b === target.auth && fail) { fail = false; throw Error("synthetic disk failure"); } return rename(a, b); };
  try { await assert.rejects(f.connections.repairApply({ ticket: p.ticket, acknowledged: true }), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual([text(target.config), text(target.auth)], before); assert.equal(f.native.fields.state.pending, null);
  assert.equal(fs.readdirSync(path.join(f.data, "backups")).filter((s) => s.startsWith("native-repair-")).length, 1);
});

test("Codex can regenerate a missing managed config but cannot erase another client's concurrent route edit", async (t) => {
  const f = fixture(t); await enable(f, "codex"); await enable(f, "claude");
  fs.unlinkSync(f.config.file);
  await repair(f, "codex");
  assert.equal(f.config.status().attached, true);
  const saved = decode(f.proxy.file);
  saved.clients.codex.providers[0].name = "externally-edited-other-client";
  put(f.proxy.file, { version: 1, encrypted: crypt.encryptString(JSON.stringify(saved)).toString("base64") });
  await assert.rejects(f.connections.repairPreview("claude"), /无法安全归属/);
  assert.equal(decode(f.proxy.file).clients.codex.providers[0].name, "externally-edited-other-client");
});
