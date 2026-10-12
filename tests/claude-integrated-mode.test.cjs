const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Store } = require("../core/store.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { ConfigManager } = require("../core/config.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const { ClaudeDesktopGateway } = require("../core/claude-desktop-gateway.cjs");
const { claudeModels } = require("../core/claude-models.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-claude-integrated-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), home = path.join(root, "home"), codex = path.join(home, ".codex");
  const store = new Store(data, codex, crypt);
  store.updateProvider({ id: "relay", baseUrl: "https://relay.test/v1", apiKey: "synthetic-upstream",
    models: [{ model: "kimi-messages", wireApi: "anthropic" }, { model: "gpt-fixture", wireApi: "openai-responses" }] });
  const manager = new HarnessManager(data, () => store.state, [], codex, { home, env: {}, launchEnv: { PATH: "" }, port: 25839 });
  const desktop = new ClaudeDesktopGateway(data, { directory: path.join(root, "Claude-3p"), policyReader: () => ({}) });
  const config = new ConfigManager(codex, data), proxy = new ProxyConfig(data, crypt, manager, store, config, desktop);
  const settings = path.join(home, ".claude/settings.json");
  return { data, home, store, manager, desktop, config, proxy, settings };
}
test("one accountless sync applies terminal and desktop; off restores both and preserves login", t => {
  const f = fixture(t), auth = path.join(f.home, ".claude/.credentials.json");
  fs.mkdirSync(path.dirname(auth), { recursive: true }); fs.writeFileSync(auth, '{"keep":"synthetic-oauth"}');
  f.proxy.sync("claude"); assert.equal(f.desktop.owner(), null);
  f.proxy.sync("claude", true);
  const token = f.proxy.clients.claude.localToken;
  assert.equal(f.desktop.status(token, 25839, f.proxy.clients.claude.providers).current, true);
  assert.equal(f.proxy.status("claude", true).applied, true);
  const profile = JSON.parse(fs.readFileSync(f.desktop.profileFile(f.desktop.owner().id)));
  assert.deepEqual(profile.coworkEgressAllowedHosts, ["*"]);
  assert.deepEqual(profile.inferenceModels.map(m => m.name), [
    ...claudeModels(f.proxy.clients.claude.providers).map(m => m.discoveryId),
  ]);
  const settings = JSON.parse(fs.readFileSync(f.settings));
  assert.deepEqual(settings.availableModels, ["relay::kimi-messages", "relay::gpt-fixture"]);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, token);
  const loaded = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config, f.desktop);
  assert.equal(loaded.status("claude", true).applied, true);
  loaded.sync("claude", false);
  assert.equal(f.desktop.owner(), null); assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), {});
  assert.equal(fs.readFileSync(auth, "utf8"), '{"keep":"synthetic-oauth"}');
});
test("an older terminal-only setup reports pending until a single sync adds desktop", t => {
  const f = fixture(t);
  const legacy = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  legacy.sync("claude", true);
  const upgraded = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config, f.desktop);
  assert.equal(upgraded.status("claude", true).pending, true);
  upgraded.sync("claude");
  assert.equal(upgraded.status("claude", true).applied, true);
  assert.equal(f.desktop.status(upgraded.clients.claude.localToken, 25839, upgraded.clients.claude.providers).current, true);
});
test("foreign desktop settings block the entire operation before any terminal writes", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.desktop.metaFile), { recursive: true });
  fs.writeFileSync(f.desktop.metaFile, '{"appliedId":"other-profile","entries":[]}');
  assert.throws(() => f.proxy.sync("claude", true), /第三方配置/);
  assert.equal(fs.existsSync(f.settings), false); assert.equal(f.proxy.clients.claude, undefined);
});
test("failure at final journal commit restores both CLI and desktop; no half-enabled mode", t => {
  const f = fixture(t), persist = f.proxy.persist.bind(f.proxy);
  let writes = 0;
  f.proxy.persist = (...args) => { if (++writes === 2) throw Error("synthetic disk failure"); return persist(...args); };
  assert.throws(() => f.proxy.sync("claude", true), /disk failure/);
  assert.equal(fs.existsSync(f.settings), false); assert.equal(f.desktop.owner(), null);
  assert.equal(fs.existsSync(f.desktop.metaFile), false); assert.equal(f.proxy.clients.claude, undefined);
  assert.equal(f.proxy.pending, null);
});
test("crash during desktop removal is recovered from the encrypted journal", t => {
  const f = fixture(t); f.proxy.sync("claude", true);
  const token = f.proxy.clients.claude.localToken, changes = f.desktop.plan();
  f.proxy.persist(f.proxy.clients, { files: changes });
  for (const c of changes) c.after === null ? fs.unlinkSync(c.file) : fs.writeFileSync(c.file, c.after);
  const recovered = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config, f.desktop);
  assert.equal(recovered.error, ""); recovered.recover();
  assert.equal(f.desktop.status(token, 25839, f.proxy.clients.claude.providers).current, true);
  assert.equal(recovered.status("claude", true).applied, true);
  recovered.restore(["claude"]); assert.equal(f.desktop.owner(), null);
});
