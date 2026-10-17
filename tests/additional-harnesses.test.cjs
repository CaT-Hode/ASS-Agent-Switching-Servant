const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCipheriv, createHash, randomBytes } = require("node:crypto");
const TOML = require("@iarna/toml");
const { inspect, locations } = require("../core/additional-harnesses.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { modelSources } = require("../core/model-inventory.cjs");
const { discoverLaunchers, resolveLauncher } = require("../core/client-launcher.cjs");
const { Preferences } = require("../core/preferences.cjs");
const now = Date.UTC(2026, 8, 23);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ass-native-extra-"));
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }); });
  const put = (relative, data) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    return file;
  };
  const manager = () => new HarnessManager(home, () => ({ providers: [] }), [], path.join(home, ".codex"),
    { home, env: {}, launchEnv: { PATH: "", USERPROFILE: home } });
  return { home, put, manager, check: (id, options = {}) => inspect(id, { home, env: {}, now, ...options }) };
}
const kimiProvider = (extra = {}) => ({ type: "kimi", base_url: "https://api.kimi.com/coding/v1",
  oauth: { storage: "file", key: "oauth/kimi-code" }, ...extra });
const kimiConfig = (provider = kimiProvider()) => TOML.stringify({ providers: { kimi: provider }, models: {
  example: { provider: "kimi", model: "kimi-test", max_context_size: 262144,
    max_output_size: 32000, capabilities: ["image_in"], support_efforts: ["low", "max"], default_effort: "max" } } });
function zconfig(rules, modelRules = []) {
  return { schemaVersion: 1, config: { providerConfigRules: { providerRules: rules },
    modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: [] } } };
}
function encrypt(value, secret) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "enc:v1:" + [iv, cipher.getAuthTag(), body].map((v) => v.toString("base64url")).join(".");
}

test("missing native clients stay absent from the detected overview and do not create files", async (t) => {
  const f = fixture(t), manager = f.manager();
  await manager.refreshOAuth();
  const { detectedClients } = await import("../src/usage-view.mjs");
  const state = manager.snapshot();
  assert.equal(state.clients.length, 7);
  assert.equal(state.clients.filter((c) => !c.nativeLoginOnly).length, 5);
  assert.equal(state.clients.some((c) => c.id === "antigravity"), false);
  assert.equal(detectedClients({ harnesses: state }).length, 0);
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test("Kimi new and legacy homes remain separate; only public metadata leaves the reader", (t) => {
  const f = fixture(t);
  const before = [];
  for (const [dir, access] of [[".kimi-code", "new-access-secret"], [".kimi", "old-access-secret"]]) {
    before.push(f.put(dir + "/config.toml", kimiConfig(kimiProvider({ oauth: { storage: "file", key: dir === ".kimi" ? "oauth/kimi-code" : "kimi-code" } }))));
    before.push(f.put(dir + "/credentials/kimi-code.json", { access_token: access, refresh_token: access + "-refresh", expires_at: now / 1000 + 3600 }));
  }
  const originals = before.map((p) => fs.readFileSync(p, "utf8"));
  const result = f.check("kimi");
  assert.equal(result.accounts.length, 2);
  assert.notEqual(result.accounts[0].id, result.accounts[1].id);
  assert.equal(result.accounts[0].expiresAt, now + 3600000);
  assert.equal(result.accounts[1].label, "Kimi CLI（旧版）");
  assert.equal(result.modelAccounts.length, 2);
  const m = result.modelAccounts[0].declaredModels[0];
  assert.equal(m.contextWindow, 262144);
  assert.deepEqual(m.efforts, ["low", "max"]);
  assert.equal(m.declared.vision, true);
  assert.ok(!JSON.stringify(result).includes("access-secret"));
  assert.deepEqual(before.map((p) => fs.readFileSync(p, "utf8")), originals);
});
test("Kimi environment roots and explicit directory override do not borrow another home's OAuth", (t) => {
  const f = fixture(t);
  f.put(".kimi-code/config.toml", kimiConfig());
  f.put(".kimi-code/credentials/kimi-code.json", { access_token: "old-home-token" });
  f.put("custom/config.toml", kimiConfig());
  const result = f.check("kimi", { env: { KIMI_CODE_HOME: path.join(f.home, "custom") } });
  assert.equal(result.accounts.length, 0);
  assert.equal(result.modelAccounts.length, 1);
  assert.deepEqual(locations("kimi", { home: f.home, env: {}, override: path.join(f.home, "custom") }),
    [{ dir: path.join(f.home, "custom"), legacy: null }]);
});
for (const [label, token, status, ready] of [
  ["revoked", { access_token: "", refresh_token: "", expires_at: 0 }, null, false],
  ["expired", { access_token: "expired-access", expires_at: now / 1000 - 1 }, "expired", false],
  ["refreshable", { access_token: "expired-access", refresh_token: "refresh", expires_at: now / 1000 - 1 }, "refresh-required", true],
  ["incomplete", { refresh_token: "only-refresh" }, "incomplete", false],
]) test("Kimi OAuth " + label + " is not reported as a fresh valid token", (t) => {
  const f = fixture(t); f.put(".kimi-code/config.toml", kimiConfig());
  f.put(".kimi-code/credentials/kimi-code.json", token);
  const result = f.check("kimi");
  if (!status) assert.equal(result.accounts.length, 0);
  else { assert.equal(result.accounts[0].status, status); assert.equal(result.accounts[0].ready, ready); }
});
for (const ref of [{ storage: "file", key: "../escape" }, { storage: "file", key: "C:escape" },
  { storage: "file", key: "nested\\escape" }, { storage: "keyring", key: "kimi-code" }])
  test("Kimi refuses unsafe/file-incompatible OAuth reference " + JSON.stringify(ref), (t) => {
    const f = fixture(t); f.put(".kimi-code/config.toml", kimiConfig(kimiProvider({ oauth: ref })));
    f.put(".kimi-code/credentials/kimi-code.json", { access_token: "must-not-load" });
    const result = f.check("kimi"); assert.equal(result.accounts.length, 0);
    assert.ok(result.sources.some((s) => ["unreadable", "external"].includes(s.status)));
  });
test("Kimi only associates official API credentials with accounts, not third-party providers", (t) => {
  const f = fixture(t), config = TOML.parse(kimiConfig());
  config.providers.kimi = { type: "openai_responses", base_url: "https://third.example/v1", api_key: "third-secret" };
  config.providers.official = { type: "kimi", base_url: "https://api.kimi.com/coding/v1", api_key_env: "KIMI_TEST_KEY" };
  config.models.example.overrides = { provider: "official", model: "wrong", max_context_size: 123456, display_name: "third-secret" };
  f.put(".kimi-code/config.toml", TOML.stringify(config));
  const result = f.check("kimi", { env: { KIMI_TEST_KEY: "official-secret" } });
  assert.deepEqual(result.accounts.map((a) => a.provider), ["official"]);
  const m = result.modelAccounts[0].declaredModels[0];
  assert.equal(m.nativeProvider, "kimi"); assert.equal(m.model, "kimi-test");
  assert.equal(m.contextWindow, 123456); assert.equal(m.displayName, "kimi-test");
  assert.equal(m.wireApi, "openai-responses");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("Kimi conflicting credentials fail closed instead of guessing which auth is active", (t) => {
  const f = fixture(t); f.put(".kimi-code/config.toml", kimiConfig(kimiProvider({ api_key: "conflict-secret" })));
  f.put(".kimi-code/credentials/kimi-code.json", { access_token: "oauth-secret" });
  const result = f.check("kimi"); assert.equal(result.accounts.length, 0);
  assert.ok(result.sources.some((s) => s.status === "unreadable"));
});
test("Kimi scoped logical OAuth references select only their own storage slot", (t) => {
  const f = fixture(t), slot = "kimi-code-env-0123456789abcdef";
  f.put(".kimi-code/config.toml", kimiConfig(kimiProvider({ oauth: { storage: "file", key: "oauth/" + slot } })));
  f.put(".kimi-code/credentials/kimi-code.json", { access_token: "default-slot-not-selected" });
  assert.equal(f.check("kimi").accounts.length, 0);
  f.put(".kimi-code/credentials/" + slot + ".json", { access_token: "scoped-access-token", expires_at: now / 1000 + 10 });
  const a = f.check("kimi").accounts[0]; assert.equal(a.ready, true);
  assert.ok(a.sourcePath.endsWith(slot + ".json")); assert.equal(a.expiresAt, now + 10000);
});
test("native readers refuse directory links rather than following credentials outside the selected root", (t) => {
  const f = fixture(t);
  f.put("real/config.toml", kimiConfig());
  fs.symlinkSync(path.join(f.home, "real"), path.join(f.home, ".kimi-code"), process.platform === "win32" ? "junction" : "dir");
  const result = f.check("kimi");
  assert.equal(result.accounts.length, 0); assert.equal(result.modelAccounts.length, 0);
  assert.equal(result.sources[0].status, "unreadable");
});
test("ZCode encrypted OAuth reads allowlisted cached identity without returning tokens", (t) => {
  const f = fixture(t), secret = "fixture-cipher-key", records = {};
  for (const [key, value] of Object.entries({ access_token: "fixture-access", refresh_token: "fixture-refresh",
    user_info: JSON.stringify({ email: "someone@example.test", name: "Demo User", user_id: "id-42", admin: "fixture-sensitive-extra", avatar: "https://no-fetch.example" }) }))
    records["oauth:zai:" + key] = encrypt(value, secret);
  f.put(".zcode/v2/credentials.json", records);
  const result = f.check("zcode", { env: { ZCODE_CREDENTIAL_SECRET: secret } });
  assert.equal(result.accounts[0].label, "Z.ai"); assert.equal(result.accounts[0].ready, true);
  assert.deepEqual(result.accounts[0].profile.fields.map((f) => f.value), ["someone@example.test", "Demo User", "id-42"]);
  for (const sensitive of [secret, "fixture-access", "fixture-refresh", "fixture-sensitive-extra", "no-fetch.example", "enc:v1:"])
    assert.ok(!JSON.stringify(result).includes(sensitive));
});
test("ZCode fallback encryption uses OS identity, not the overridden data directory", (t) => {
  let username = "unknown";
  try { username = os.userInfo().username; } catch {}
  const f = fixture(t), secret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  f.put("custom/.zcode/v2/credentials.json", { "oauth:bigmodel:access_token": encrypt("identity-token", secret),
    "oauth:bigmodel:user_info": encrypt(JSON.stringify({ id: "big-42", displayName: "Local User" }), secret) });
  const result = f.check("zcode", { env: { ZCODE_DATA_BASE_DIR: path.join(f.home, "custom") } });
  assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].provider, "bigmodel");
  assert.equal(result.accounts[0].profile.fields[0].value, "Local User");
});
test("ZCode wrong cipher secret and corrupted flat records do not become logged-in accounts", (t) => {
  const f = fixture(t); f.put(".zcode/v2/credentials.json", { "oauth:zai:access_token": encrypt("private-token", "correct-key") });
  let result = f.check("zcode", { env: { ZCODE_CREDENTIAL_SECRET: "wrong-key" } });
  assert.equal(result.accounts.length, 0); assert.ok(result.sources.some((s) => s.status === "unreadable"));
  f.put(".zcode/v2/credentials.json", { "oauth:zai:access_token": "legacy-token", unexpected: {} });
  result = f.check("zcode"); assert.equal(result.accounts.length, 0); assert.equal(result.sources[0].status, "unreadable");
});
test("ZCode explicit model inventory is independent from official accounts and preserves unknown limits", (t) => {
  const f = fixture(t);
  f.put(".zcode/v2/provider_config.json", zconfig([
    { providerId: "third", enabled: true, config: { api: { type: "openai-responses", baseUrl: "https://third.example/v1" },
      access: { type: "api-key", apiKey: "third-key-secret" }, personalModelIds: ["m1", "m2", "off"] } },
    { providerId: "official", providerName: "Z.ai API", config: { api: { baseUrl: "https://api.z.ai/api/paas/v4" }, access: { type: "api-key", apiKey: "official-key-secret" } } },
    { providerId: "account:invalid-override", config: { api: { baseUrl: "https://api.z.ai/api/paas/v4" }, access: { type: "api-key", apiKey: "forbidden-account-override" } } },
  ], [{ providerId: "third", modelId: "m1", config: { properties: { contextWindow: 150000, inputFormat: { supportsImage: true } } } },
    { providerId: "third", modelId: "off", config: { enabled: false } }]));
  const result = f.check("zcode");
  assert.deepEqual(result.accounts.map((a) => a.provider), ["official"]);
  const models = result.modelAccounts[0].declaredModels;
  assert.deepEqual(models.map((m) => m.model), ["m1", "m2"]);
  assert.equal(models[0].contextWindow, 150000); assert.equal(models[1].contextWindow, null);
  assert.ok(!JSON.stringify(result).includes("key-secret"));
});
test("ZCode unknown config version never produces guessed models", (t) => {
  const f = fixture(t), c = zconfig([]); c.schemaVersion = 999;
  f.put(".zcode/v2/provider_config.json", c);
  const result = f.check("zcode"); assert.deepEqual(result.modelAccounts, []);
  assert.ok(result.sources.some((s) => s.status === "unreadable"));
});
test("Antigravity does not confuse Gemini CLI OAuth or a lone environment key with an agy login", (t) => {
  const f = fixture(t); f.put(".gemini/oauth_creds.json", { access_token: "unrelated-gemini-token" });
  assert.equal(f.check("antigravity", { env: { GEMINI_API_KEY: "lone-key" } }).accounts.length, 0);
  f.put(".gemini/antigravity-cli/settings.json", {});
  const result = f.check("antigravity"); assert.equal(result.accounts.length, 0);
  assert.ok(result.sources.some((s) => s.status === "external"));
  assert.ok(!JSON.stringify(result).includes("unrelated-gemini-token"));
});
test("Antigravity API mode requires modelProvider and the exact supported variable", (t) => {
  const f = fixture(t); f.put(".gemini/antigravity-cli/settings.json", { modelProvider: "gemini" });
  assert.equal(f.check("antigravity", { env: { GOOGLE_API_KEY: "wrong-variable" } }).accounts.length, 0);
  const result = f.check("antigravity", { env: { GEMINI_API_KEY: "supported-api-secret" } });
  assert.equal(result.accounts[0].provider, "gemini");
  assert.ok(!JSON.stringify(result).includes("supported-api-secret"));
  assert.equal(f.check("antigravity", { env: { GEMINI_API_KEY: "key", GOOGLE_GEMINI_BASE_URL: "https://third.example" } }).accounts.length, 0);
});
test("malformed and oversized native files remain intact and never disclose contents in errors", (t) => {
  const f = fixture(t), bad = f.put(".kimi-code/config.toml", 'api_key = "secret-with-invalid-syntax');
  assert.ok(f.check("kimi").sources.some((s) => s.status === "unreadable"));
  f.put(".zcode/v2/credentials.json", "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(f.check("zcode").sources[0].status, "unreadable");
  assert.equal(fs.readFileSync(bad, "utf8"), 'api_key = "secret-with-invalid-syntax');
  assert.ok(!JSON.stringify(f.check("kimi")).includes("secret-with-invalid"));
});
test("native-login clients reject account mutations while retired clients stay outside the product surface", (t) => {
  const f = fixture(t), manager = f.manager();
  for (const id of ["kimi", "zcode"]) {
    for (const action of [() => manager.add(id, "test"), () => manager.select(id, "native:x"),
      () => manager.bindApi(id, "x", false),
      () => manager.plan(id, "native:x"), () => manager.modelPlan(id, "x")]) assert.throws(action, /仅支持原生识别/);
    assert.equal(manager.oauthHistoryAllows(id, "test"), false);
  }
  assert.equal(manager.snapshot().clients.some((c) => c.id === "antigravity"), false);
  assert.equal(manager.oauthHistoryAllows("antigravity", "google-antigravity"), false);
  assert.doesNotThrow(() => manager.setInjection("kimi", { excludedProviders: [] }));
  assert.doesNotThrow(() => manager.setInjection("zcode", { excludedProviders: [] }));
  for (const action of [
    () => manager.spec("antigravity"),
    () => manager.detect("antigravity"),
    () => manager.setInjection("antigravity", { excludedProviders: [] }),
    () => manager.setCredentialHome("antigravity", f.home),
  ]) assert.throws(action, /未知客户端/);
  assert.deepEqual(new Set(manager.oauthHistorySources().map((s) => s.harness)), new Set(["codex", "claude", "pi", "zcode"]));
  assert.equal(manager.oauthHistoryAllows("zcode", "zai"), true);
  assert.deepEqual(fs.readdirSync(f.home), ['backups', "clients.json"]);
  assert.deepEqual(fs.readdirSync(path.join(f.home,'backups')), ['clients.previous.json']);
});
test("model catalogs aggregate without inflating official account counts and client preference persists", (t) => {
  const f = fixture(t); f.put(".kimi-code/config.toml", kimiConfig({ type: "openai", base_url: "https://third.example/v1", api_key: "third-party" }));
  const clientState = f.manager().snapshot();
  const client = clientState.clients.find((c) => c.id === "kimi");
  assert.equal(client.detected, true); assert.equal(client.accounts.length, 0);
  const sources = modelSources({ providers: [], officialModels: [] }, clientState);
  const source = sources.find((s) => s.id === "native-kimi");
  assert.equal(source.accountCount, 0); assert.equal(source.models.length, 1);
  const preferences = new Preferences(f.home);
  preferences.update({ client: "kimi", usage: { client: "zcode" } });
  const restored = new Preferences(f.home); assert.equal(restored.state.client, "kimi"); assert.equal(restored.state.usage.client, "zcode");
});
test("native CLI discovery recognizes kimi/zcode PATH without launching anything", (t) => {
  const f = fixture(t), bin = path.join(f.home, "bin");
  for (const name of ["kimi", "zcode"]) f.put("bin/" + name + ".cmd", "synthetic, never execute");
  const env = { PATH: bin, USERPROFILE: f.home };
  assert.equal(discoverLaunchers("kimi", env)[0].ready, true);
  assert.equal(discoverLaunchers("zcode", env)[0].ready, true);
  f.put("bin/node.exe", "synthetic node");
  f.put("package/package.json", { name: "@moonshot-ai/kimi-code", bin: { kimi: "dist/main.mjs" } });
  const entry = f.put("package/dist/main.mjs", "// synthetic");
  assert.equal(resolveLauncher("kimi", path.join(f.home, "package"), env).entryPoint, entry);
});
