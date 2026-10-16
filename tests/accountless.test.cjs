const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const TOML = require("@iarna/toml");
const { Store } = require("../core/store.cjs");
const { ConfigManager, atomic } = require("../core/config.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const { Connections } = require("../core/connections.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const { modelRef } = require("../core/client-policy.cjs");
const { Router } = require("../core/router.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-accountless-")), data = path.join(dir, "data"), home = path.join(dir, "home"), codex = path.join(home, ".codex");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseline = 'model = "gpt-original"\nmodel_reasoning_effort = "high"\n[features]\nkeep = true\n';
  atomic(path.join(codex, "config.toml"), baseline);
  atomic(path.join(codex, "auth.json"), '{"tokens":{"access_token":"synthetic-original"}}');
  const store = new Store(data, codex, crypt);
  store.updateProvider({ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "synthetic-provider", models: [{ model: "test-claude", wireApi: "anthropic" }, { model: "test-chat", wireApi: "openai-chat" }] });
  const injections = new InjectionFiles(data), config = new ConfigManager(codex, data);
  let connections;
  const manager = new HarnessManager(data, () => store.state, store.officialModels, codex, { home, env: {}, launchEnv: { PATH: "" }, injections, isConnected: id => connections.allow(id) });
  const proxy = new ProxyConfig(data, crypt, manager, store, config);
  manager.options.proxyConfig = proxy;
  const calls = [];
  const router = new Router({ getState: id => proxy.routingState(id), allowClient: id => connections.allow(id), fetchUpstream: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] }), { status: 200 });
  } });
  t.after(() => router.stop());
  connections = new Connections({ dataDir: data, router, config, proxyConfig: proxy, injections, port: 0,
    processes: { refresh: async () => {}, snapshot: () => ({ sessions: [] }) } });
  const apply = async (id, mode) => connections.apply({ ticket: (await connections.preview(id, true, false, mode)).ticket, mode: "safe", acknowledged: true });
  return { dir, data, codex, baseline, store, config, manager, proxy, connections, router, calls, apply };
}
test("accountless requires an applied nonempty injection; drafts and other clients cannot activate it", async t => {
  const f = fixture(t);
  await assert.rejects(f.apply("codex", true), /请先开启/);
  await f.apply("codex");
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  await assert.rejects(f.apply("codex", true), /尚未同步/);
  await f.apply("codex");
  await assert.rejects(f.apply("codex", true), /至少一个/);
  await assert.rejects(f.apply("pi", true), /请先开启/);
});
test("a fresh Codex home can inject and enter accountless mode without creating auth.json", async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.codex, "config.toml")); fs.unlinkSync(path.join(f.codex, "auth.json"));
  await f.apply("codex"); await f.apply("codex", true);
  assert.equal(f.proxy.status("codex", true).applied, true);
  assert.ok(!fs.existsSync(path.join(f.codex, "auth.json")));
});
test("desktop mode preserves OAuth bytes and shares the selected default with accountless mode", async t => {
  const f = fixture(t), auth = fs.readFileSync(path.join(f.codex, "auth.json"));
  f.manager.setInjection("codex", { excludedProviders: [], defaultModel: modelRef("relay", "test-chat") });
  await f.apply("codex");
  const desktop = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(desktop.model, "ASS_" + require("../core/models.cjs").codexModelId("relay", "test-chat").slice(4));
  assert.equal(desktop.model_reasoning_effort, "medium");
  await f.apply("codex", true);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file, "utf8")).model, desktop.model);
  const parsed = TOML.parse(fs.readFileSync(f.config.file, "utf8")), token = f.proxy.clients.codex.localToken;
  assert.equal(parsed.model_providers.ASS.requires_openai_auth, false);
  assert.equal(parsed.model_providers.ASS.experimental_bearer_token, token);
  assert.equal(parsed.model_provider, "ASS");
  assert.match(parsed.model, /^ASS_[a-f0-9]+::/);
  assert.ok(JSON.parse(fs.readFileSync(f.config.catalog)).models.every(m => m.slug.startsWith("ASS_")));
  assert.deepEqual(fs.readFileSync(path.join(f.codex, "auth.json")), auth);
  const reloaded = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.equal(reloaded.clients.codex.localToken, token); assert.equal(reloaded.status("codex", true).applied, true);
  assert.equal(f.connections.snapshot().clients.codex.accountless, true);
  assert.ok(!JSON.stringify(f.connections.snapshot()).includes(token));
  await f.apply("codex", false);
  const normal = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(normal.model, desktop.model);
  assert.equal(normal.model_reasoning_effort, "medium");
  assert.equal(normal.model_providers.ASS.requires_openai_auth, true);
  assert.equal(normal.model_providers.ASS.experimental_bearer_token, undefined);
  assert.equal(f.proxy.clients.codex.gatewayAuth, true);
  assert.equal(f.proxy.clients.codex.accountless, undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.codex, "auth.json")), auth);
});
test("Claude has a credential-isolated home, only injected model choices, no account selection and no permission bypass", async t => {
  const f = fixture(t); await f.apply("claude"); await f.apply("claude", true);
  const plan = f.manager.accountlessPlan("claude", "ephemeral-token"); f.manager.materialize(plan);
  const settings = JSON.parse(fs.readFileSync(path.join(plan.dir, "settings.json")));
  assert.deepEqual(settings.availableModels, ["relay::test-claude", "relay::test-chat"]);
  assert.equal(settings.enforceAvailableModels, true); assert.equal(settings.modelPicker.replaceBuiltInOptions, true);
  assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, f.proxy.clients.claude.localToken);
  assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(!plan.args.includes("--dangerously-skip-permissions"));
  assert.ok(!fs.existsSync(path.join(plan.dir, ".credentials.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(plan.dir, ".claude.json"))).hasCompletedOnboarding, true);
  assert.deepEqual(f.manager.state.selected, {});
  assert.throws(() => f.manager.plan("claude", "anything"), /无账号启动已开启/);
});

test("Claude terminal overlay persists, preserves OAuth and unrelated settings, and restores fields on mode off", async t => {
  const f = fixture(t), home = f.manager.nativeHome, settings = path.join(home, ".claude/settings.json"), profile = path.join(home, ".claude.json");
  const original = { model: "original", apiKeyHelper: "my-vault", permissions: { deny: ["Bash(rm *)"] },
    env: { ANTHROPIC_API_KEY: "synthetic-original-key", ANTHROPIC_BASE_URL: "https://original.example", KEEP: "keep" } };
  atomic(settings, JSON.stringify(original));
  atomic(profile, JSON.stringify({ hasCompletedOnboarding: false, oauthAccount: { emailAddress: "test@example.test" }, projects: {} }));
  const oauth = path.join(home, ".claude/.credentials.json"), credentials = '{"claudeAiOauth":{"accessToken":"synthetic-private"}}';
  atomic(oauth, credentials);
  await f.apply("claude");
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), original);
  await f.apply("claude", true);
  const injected = JSON.parse(fs.readFileSync(settings)), token = f.proxy.clients.claude.localToken;
  assert.equal(injected.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(injected.env.ANTHROPIC_API_KEY, "");
  assert.equal(injected.apiKeyHelper, undefined);
  assert.equal(injected.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:25819/clients/claude/models");
  assert.deepEqual(injected.availableModels, ["relay::test-claude", "relay::test-chat"]);
  assert.equal(fs.readFileSync(oauth, "utf8"), credentials);
  assert.equal(f.proxy.status("claude", true).runtimeStatus, "terminal-ready");
  const reloaded = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.equal(reloaded.status("claude", true).applied, true);
  const current = JSON.parse(fs.readFileSync(profile)); current.projects.test = { hasTrustDialogAccepted: true }; atomic(profile, JSON.stringify(current));
  injected.env.USER_EDIT = "survives"; atomic(settings, JSON.stringify(injected));
  await f.apply("claude", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), { ...original, env: { ...original.env, USER_EDIT: "survives" } });
  const restored = JSON.parse(fs.readFileSync(profile));
  assert.equal(restored.hasCompletedOnboarding, false); assert.equal(restored.oauthAccount.emailAddress, "test@example.test");
  assert.equal(restored.projects.test.hasTrustDialogAccepted, true);
  assert.equal(fs.readFileSync(oauth, "utf8"), credentials);
});

test("Claude native drift is visible, blocks disable/quit, and repair uses applied models rather than drafts", async t => {
  const f = fixture(t); await f.apply("claude"); await f.apply("claude", true);
  const settings = f.proxy.clients.claude.nativeClaude.targets.settings;
  const value = JSON.parse(fs.readFileSync(settings)); value.env.ANTHROPIC_BASE_URL = "https://foreign.example";
  value.theme = "dark"; atomic(settings, JSON.stringify(value));
  assert.match(f.proxy.status("claude", true).error, /外部修改/);
  await assert.rejects(f.apply("claude", false), /外部修改/);
  await assert.rejects(f.connections.preview("all", false, true), /外部修改/);
  f.store.updateProvider({ ...f.store.state.providers[0], models: [{ model: "draft-model" }] });
  f.proxy.repair("claude");
  const repaired = JSON.parse(fs.readFileSync(settings));
  assert.deepEqual(repaired.availableModels, ["relay::test-claude", "relay::test-chat"]);
  assert.equal(repaired.theme, "dark");
  f.proxy.restore(["claude"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), { theme: "dark" });
});

test("legacy Claude mode is pending until terminal injection is synced; toggles are scoped per client", async t => {
  const f = fixture(t); await f.apply("claude");
  f.proxy.persist({ claude: f.proxy.desired("claude", true) });
  assert.equal(f.proxy.status("claude", true).pending, true);
  await f.apply("claude");
  assert.equal(f.proxy.status("claude", true).applied, true);
  const settings = f.proxy.clients.claude.nativeClaude.targets.settings, cc = fs.readFileSync(settings, "utf8");
  await f.apply("codex"); await f.apply("codex", true);
  const codex = fs.readFileSync(f.config.file, "utf8");
  assert.equal(fs.readFileSync(settings, "utf8"), cc);
  await f.apply("claude", false);
  assert.equal(fs.readFileSync(f.config.file, "utf8"), codex);
  assert.equal(f.proxy.status("codex", true).applied, true);
  await f.apply("claude", true);
  const token = f.proxy.clients.claude.localToken;
  await f.apply("codex", false);
  assert.equal(JSON.parse(fs.readFileSync(settings)).env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(f.proxy.status("claude", true).applied, true);
});

test("Claude honors the actual native config home, never an account-import directory, and restores on safe exit", async t => {
  const f = fixture(t), custom = path.join(f.dir, "custom-cc"), imported = path.join(f.dir, "account-import");
  f.manager.nativeEnv.CLAUDE_CONFIG_DIR = custom; f.manager.state.credentialHomes.claude = imported;
  await f.apply("claude"); await f.apply("claude", true);
  assert.equal(f.proxy.clients.claude.nativeClaude.targets.profile, path.join(custom, ".claude.json"));
  assert.ok(!fs.existsSync(imported));
  const ticket = (await f.connections.preview("all", false, true)).ticket;
  await f.connections.apply({ ticket, mode: "safe", acknowledged: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(custom, "settings.json"))), {});
  assert.equal(f.connections.enabled.claude, false);
});

test("Claude confirmation notices native edits; external shell overrides and enforced login fail closed", async t => {
  const f = fixture(t); await f.apply("claude");
  const settings = path.join(f.manager.nativeHome, ".claude/settings.json");
  const preview = await f.connections.preview("claude", true, false, true);
  atomic(settings, '{"theme":"dark"}');
  await assert.rejects(f.connections.apply({ ticket: preview.ticket, mode: "safe", acknowledged: true }), /已变化/);
  f.manager.nativeEnv.ANTHROPIC_AUTH_TOKEN = "synthetic-conflict";
  await assert.rejects(f.apply("claude", true), /终端环境/);
  delete f.manager.nativeEnv.ANTHROPIC_AUTH_TOKEN;
  atomic(settings, '{"forceLoginMethod":"claudeai"}');
  await assert.rejects(f.apply("claude", true), /要求官方登录/);
  atomic(settings, '{"env":"invalid-parent"}');
  await assert.rejects(f.apply("claude", true), /不是对象/);
  assert.equal(f.proxy.clients.claude.accountless, undefined);
});

test("failed native Claude transaction rolls back; write-ahead recovery remains available after restart", async t => {
  const f = fixture(t); await f.apply("claude");
  const persist = f.proxy.persist.bind(f.proxy);
  let n = 0;
  f.proxy.persist = (...args) => { if (++n === 2) throw Error("synthetic-final-commit"); return persist(...args); };
  await assert.rejects(f.apply("claude", true), /synthetic-final-commit/);
  const settings = path.join(f.manager.nativeHome, ".claude/settings.json");
  assert.ok(!fs.existsSync(settings)); assert.equal(f.proxy.clients.claude.accountless, undefined);
  f.proxy.persist = persist;
  const native = require("../core/claude-native.cjs").plan(f.manager, f.proxy.desired("claude", true));
  f.proxy.persist(f.proxy.clients, { files: native.files });
  atomic(native.files[0].file, native.files[0].after);
  const restart = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.ok(restart.pending); restart.recover();
  assert.ok(!fs.existsSync(settings)); assert.equal(restart.pending, null);
});
test("in-flight requests block a mode change and configuration changes invalidate confirmation", async t => {
  const f = fixture(t); await f.apply("codex");
  const p = await f.connections.preview("codex", true, false, true);
  const active = f.router.clientActive; f.router.clientActive = () => 1;
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true }), /请求正在进行/);
  assert.equal(f.proxy.clients.codex.accountless, undefined); f.router.clientActive = active;
  const next = await f.connections.preview("codex", true, false, true);
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  await assert.rejects(f.connections.apply({ ticket: next.ticket, mode: "safe", acknowledged: true }), /已变化/);
});
test("accountless router rejects OAuth, non-injected and subscription models before network access; discovery needs its own credential", async t => {
  const f = fixture(t); await f.apply("codex"); await f.apply("codex", true); await f.apply("claude"); await f.apply("claude", true);
  const base = `http://127.0.0.1:${f.router.port}`;
  const send = (client, token, model) => fetch(base + `/clients/${client === "codex" ? "ASS" : client}/v1/responses`, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ model, input: "OK" }) });
  assert.equal((await send("codex", "synthetic-oauth", "relay::test-chat")).status, 401);
  assert.equal((await send("codex", f.proxy.clients.codex.localToken, "gpt-official")).status, 403);
  assert.equal((await send("codex", f.proxy.clients.codex.localToken, "foreign::model")).status, 404);
  assert.equal(f.calls.length, 0);
  const discovery = token => fetch(base + "/clients/claude/models/v1/models", { headers: { authorization: "Bearer " + token } });
  assert.equal((await discovery(f.proxy.clients.codex.localToken)).status, 401);
  const models = await (await discovery(f.proxy.clients.claude.localToken)).json();
  assert.deepEqual(models.data.map(m => m.id), require("../core/claude-models.cjs").claudeModels(f.proxy.clients.claude.providers).map(m => m.discoveryId));
  assert.equal(models.has_more, false); assert.equal(f.calls.length, 0);
});
