const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const TOML = require("@iarna/toml");
const { parseImport } = require("../core/models.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { NativeConfig, locations, providerId } = require("../core/native-config.cjs");
const { Connections } = require("../core/connections.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const managedToml = require("../core/toml-managed.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function fixture(t, legacy = false) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ass-kimi-")), home = path.join(data, "home");
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const dir = path.join(home, legacy ? ".kimi" : ".kimi-code"), file = path.join(dir, "config.toml");
  const original = '\uFEFF# user settings\r\ndefault_model = "native"\r\n[providers.kimi]\r\ntype = "kimi"\r\nbase_url = "https://api.kimi.com/coding/v1"\r\n[providers.kimi.oauth]\r\nstorage = "file"\r\nkey = "oauth/kimi-code"\r\n[models.native]\r\nprovider = "kimi"\r\nmodel = "kimi-test"\r\nmax_context_size = 262144';
  put(file, original);
  const token = path.join(dir, "credentials/kimi-code.json");
  put(token, { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_at: 2100000000 });
  const providers = parseImport({ providers: [{ id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1",
    apiKey: "synthetic-key", extraHeaders: { "X-Fixture": "header" }, models:
      ["openai-chat", "openai-responses", "anthropic"].map((wireApi) => ({ model: wireApi + ".test", wireApi,
        efforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 128000, maxOutputTokens: 8192 })) }] });
  const options = { home, env: {}, launchEnv: {}, isConnected: () => false };
  const manager = new HarnessManager(data, () => ({ providers }), [], path.join(home, ".codex"), options);
  const native = new NativeConfig(data, crypt, manager); options.nativeConfig = native;
  return { data, home, file, dir, original, token, providers, manager, native, options };
}

for (const legacy of [false, true]) test(`Kimi ${legacy ? "legacy" : "current"} injects all protocols, syncs provider scope and restores exact user TOML`, (t) => {
  const f = fixture(t, legacy), p = f.providers[0], token = fs.readFileSync(f.token, "utf8");
  f.native.sync("kimi");
  let text = fs.readFileSync(f.file, "utf8"), config = managedToml.parse(text);
  assert.ok(text.startsWith(f.original));
  assert.equal(config.default_model, "native");
  assert.equal(config.providers.kimi.oauth.key, "oauth/kimi-code");
  assert.equal(config.providers[providerId(p, "openai-chat")].type, legacy ? "openai_legacy" : "openai");
  assert.equal(config.providers[providerId(p, "openai-responses")].type, "openai_responses");
  assert.equal(config.providers[providerId(p, "anthropic")].base_url, "https://fixture.invalid");
  for (const m of Object.values(config.models).filter((m) => m.provider !== "kimi")) {
    assert.equal(m.max_context_size, 128000); assert.deepEqual(m.capabilities, ["thinking"]);
    assert.equal(m.default_effort, legacy ? undefined : "high");
    assert.equal(m.max_output_size, legacy ? undefined : 8192);
  }
  const client = f.manager.snapshot().clients.find((c) => c.id === "kimi");
  assert.equal(client.accounts.length, 1); assert.equal(client.injection.models.length, 3);
  assert.equal(client.modelAccounts.flatMap((a) => a.declaredModels || []).length, 1);
  assert.doesNotMatch(JSON.stringify(client), /synthetic-(?:key|access|refresh)/);
  p.models[0].displayName = "Updated";
  f.native.sync("kimi");
  config = managedToml.parse(fs.readFileSync(f.file, "utf8"));
  assert.ok(Object.values(config.models).some((m) => m.display_name === "Updated"));
  // User edits outside the owned tables survive even after restarting ASS.
  put(f.file, fs.readFileSync(f.file, "utf8").replace("# user settings", "# edited by user"));
  const restarted = new NativeConfig(f.data, crypt, f.manager);
  f.manager.setInjection("kimi", { excludedProviders: [p.id] });
  assert.equal(restarted.sync("kimi").modelCount, 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original.replace("# user settings", "# edited by user"));
  f.manager.setInjection("kimi", { excludedProviders: [] }); restarted.sync("kimi"); restarted.restore(["kimi"]);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original.replace("# user settings", "# edited by user"));
  assert.equal(fs.readFileSync(f.token, "utf8"), token);
});

test("Kimi requires an explicit version for two detected homes or an unknown custom home; selection persists", (t) => {
  const f = fixture(t), old = path.join(f.home, ".kimi/config.toml"); put(old, f.original);
  assert.throws(() => f.native.sync("kimi"), /新旧两套/);
  f.manager.setNativeVariant("kimi", "legacy"); assert.equal(locations("kimi", f.manager).config, old);
  const restored = new HarnessManager(f.data, () => ({ providers: f.providers }), [], undefined, f.options);
  assert.equal(restored.state.nativeVariants.kimi, "legacy");
  f.native.sync("kimi");
  assert.throws(() => f.manager.setNativeVariant("kimi", "current"), /先断开/);
  f.manager.nativeEnv.KIMI_SHARE_DIR = path.join(f.home, "changed");
  assert.throws(() => f.native.sync("kimi"), /目标目录已变化/);
  f.native.restore(["kimi"]); assert.equal(fs.readFileSync(old, "utf8"), f.original);
  f.manager.setCredentialHome("kimi", f.home); f.manager.setNativeVariant("kimi", "auto");
  assert.throws(() => f.native.sync("kimi"), /选择 Kimi 配置版本/);
  f.manager.setNativeVariant("kimi", "current"); assert.equal(locations("kimi", f.manager).config, path.join(f.home, "config.toml"));
});

test("Kimi preserves externally edited managed fields and missing ownership markers", (t) => {
  const f = fixture(t); f.native.sync("kimi");
  const applied = fs.readFileSync(f.file, "utf8");
  for (const changed of [applied.replace("synthetic-key", "external-key"), applied.replace("# >>> ASS", "# changed ASS"),
    applied.replace('api_key = "synthetic-key"', 'api_key = "synthetic-key" # user annotation')]) {
    put(f.file, changed);
    assert.throws(() => f.native.sync("kimi"), /外部修改|标记/);
    assert.throws(() => f.native.restore(["kimi"]), /外部修改|标记/);
    assert.equal(fs.readFileSync(f.file, "utf8"), changed);
  }
});

test("TOML writes reject sealed tables and markers embedded in unrelated multiline strings", () => {
  const keys = ["providers", "ass-test"], value = { type: "openai", api_key: "synthetic" };
  const field = { exists: true, value };
  assert.throws(() => managedToml.edit("providers = {}\n", keys, field), /TOML/);
  const block = managedToml.edit("", keys, field);
  const trapped = 'note = """' + block + '"""\n' + TOML.stringify({ providers: { "ass-test": value } });
  assert.throws(() => managedToml.edit(trapped, keys, { exists: false }), /非 ASS 字段/);
  assert.equal(managedToml.edit(block, keys, { exists: false }), "");
});

test("native Kimi reserialization still permits withdrawal without touching new defaults or OAuth", (t) => {
  const f = fixture(t, true); f.native.sync("kimi");
  const config = managedToml.parse(fs.readFileSync(f.file, "utf8"));
  config.user_setting = { note: 'multi\n[providers.ass-fake]\nnot a table', values: [[1, 2], [3, 4]] };
  const alias = Object.keys(config.models).find((key) => key.startsWith("ASS-"));
  config.default_model = alias;
  put(f.file, TOML.stringify(config));
  assert.throws(() => f.native.restore(["kimi"]), /先在 Kimi 切换模型/);
  config.default_model = "native";
  const text = TOML.stringify(config); put(f.file, text);
  f.native.sync("kimi"); assert.equal(fs.readFileSync(f.file, "utf8"), text);
  f.native.restore(["kimi"]);
  const result = managedToml.parse(fs.readFileSync(f.file, "utf8"));
  const expected = managedToml.parse(f.original); expected.user_setting = config.user_setting;
  assert.deepEqual(result, expected);
});

test("Kimi connection migrates the five-client state and never starts the ASS router", async (t) => {
  const f = fixture(t), saved = { codex: false, claude: false, opencode: false, pi: false, dsh: false };
  put(path.join(f.data, "connections.json"), saved);
  const connections = new Connections({ dataDir: f.data, nativeConfig: f.native,
    config: { status: () => ({}), file: path.join(f.home, "unused.toml") },
    injections: new InjectionFiles(f.data), router: { clientActive: () => 0, start: async () => assert.fail("must be native"), stop: async () => {} },
    processes: { refresh: async () => {}, snapshot: () => ({ sessions: [] }) } });
  f.options.isConnected = (id) => connections.enabled[id];
  assert.equal(connections.error, ""); assert.equal(connections.enabled.kimi, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(connections.file)), saved);
  const on = await connections.preview("kimi", true);
  await connections.apply({ ticket: on.ticket, mode: "safe", acknowledged: true });
  assert.equal(connections.snapshot().clients.kimi.mode, "native");
  assert.equal(connections.routerEnabled(), false);
  assert.equal(JSON.parse(fs.readFileSync(connections.file)).kimi, true);
  assert.throws(() => f.manager.setCredentialHome("kimi", f.home), /先断开/);
  const off = await connections.preview("kimi", false);
  await connections.apply({ ticket: off.ticket, mode: "safe", acknowledged: true });
  assert.equal(connections.enabled.kimi, false);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});
