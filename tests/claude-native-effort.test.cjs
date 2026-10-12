const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { claudeModels, resolveClaudeModel, claudeIdentity } = require("../core/claude-models.cjs");
const { desired, ClaudeDesktopGateway } = require("../core/claude-desktop-gateway.cjs");
const { Router } = require("../core/router.cjs");
const { claudeModelSettings } = require("../core/accountless.cjs");
const token = "a".repeat(64);
const provider = (id, model = "claude-sonnet-4-6") => ({ id, name: id, enabled: true, apiKey: "synthetic-key", baseUrl: `https://${id}.test/v1`,
  models: [{ model, enabled: true, wireApi: "anthropic", efforts: ["low", "medium", "high", "ultra"], defaultEffort: "medium" }] });

test("only exact native Claude IDs gain recognizable routes; names and vague aliases cannot impersonate Claude", () => {
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6-20260813", "anthropic/claude-opus-5", "us.anthropic.claude-haiku-4-5"])
    assert.ok(claudeIdentity(id), id);
  for (const id of ["gpt-6", "deepseek-chat", "claude-opus", "claude-opus-test", "claude-sonnet-4-6-thinking", "other/claude-opus-5", "claude-opus-5\n"])
    assert.equal(claudeIdentity(id), null, id);
  const unknown = provider("gpt-team", "gpt-6"); unknown.models[0].displayName = "Claude Opus 5";
  const row = claudeModels([unknown])[0];
  assert.match(row.discoveryId, /^claude-ass-[a-f0-9]{32}$/);
  assert.equal(row.maxEffort, undefined);
});

test("native recognition keeps provider routes unique, stable and exact including dated IDs", () => {
  const providers = [provider("a"), provider("b"), provider("c", "claude-opus-4-6-20260813")];
  const rows = claudeModels(providers);
  assert.equal(new Set(rows.map(r => r.discoveryId)).size, 3);
  for (const row of rows) {
    assert.match(row.discoveryId, /^ass-[a-f0-9]{32}\.anthropic\.claude-/);
    assert.equal(resolveClaudeModel(providers, row.discoveryId), row.model);
    assert.equal(resolveClaudeModel(providers, row.discoveryId + "[1m]"), row.model);
    const oldId = "claude-ass-" + crypto.createHash("sha256").update(row.model).digest("hex").slice(0, 32);
    assert.equal(resolveClaudeModel(providers, oldId), row.model);
    assert.equal(resolveClaudeModel(providers, oldId + "[1m]"), row.model);
  }
  providers[0].name = "renamed"; providers[0].models[0].displayName = "new label";
  assert.equal(claudeModels(providers)[0].discoveryId, rows[0].discoveryId);
  providers[0].models[0].enabled = false;
  assert.equal(resolveClaudeModel(providers, rows[0].discoveryId), rows[0].discoveryId);
  assert.equal(resolveClaudeModel(providers, rows[1].discoveryId), rows[1].model);
});

test("desktop caps follow configured native effort range without ultra; global default follows only first model", () => {
  const native = provider("a"), unknown = provider("b", "deepseek-chat");
  const configured = desired(token, 25819, [native, unknown]);
  assert.equal(configured.inferenceModels[0].maxEffort, "high");
  assert.equal(configured.defaultModelEffort, "medium");
  assert.equal(configured.inferenceModels[1].maxEffort, undefined);
  assert.equal(desired(token, 25819, [unknown, native]).defaultModelEffort, undefined);
  native.models[0].efforts = ["high", "max", "ultra"]; native.models[0].defaultEffort = "ultra";
  const changed = desired(token, 25819, [native]);
  assert.equal(changed.inferenceModels[0].maxEffort, "max");
  assert.equal(changed.defaultModelEffort, "high");
  const cli = claudeModelSettings([native], "a::claude-sonnet-4-6");
  assert.deepEqual(Object.keys(cli.modelPicker.options[0]).sort(), ["description", "label", "model"]);
});

test("desktop receives explicit 1M flags only for native Claude with configured million-token context", () => {
  const native = provider("a", "claude-opus-4-6"), other = provider("b", "deepseek-chat");
  other.models[0].contextWindow = 1000000;
  const id = claudeModels([native])[0].discoveryId;
  for (const context of [undefined, 200000, 999999, "1000000", NaN]) {
    native.models[0].contextWindow = context;
    const entry = desired(token, 25819, [native]).inferenceModels[0];
    assert.equal(entry.supports1m, undefined);
    assert.equal(entry.prefer1m, undefined);
  }
  for (const context of [1000000, 1048576, 2000000]) {
    native.models[0].contextWindow = context;
    const entries = desired(token, 25819, [native, other]).inferenceModels;
    assert.equal(entries[0].name, id);
    assert.equal(entries[0].supports1m, true);
    assert.equal(entries[0].prefer1m, true);
    assert.equal(entries[1].supports1m, undefined);
    assert.equal(entries[1].prefer1m, undefined);
    const cli = claudeModelSettings([native], "a::claude-opus-4-6");
    assert.deepEqual(Object.keys(cli.modelPicker.options[0]).sort(), ["description", "label", "model"]);
  }
});

test("context changes mark desktop sync pending and remove old 1M flags only after explicit sync", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-claude-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = new ClaudeDesktopGateway(path.join(root, "ASS"), { directory: path.join(root, "Claude-3p"), policyReader: () => ({}) });
  const providers = [provider("a", "claude-opus-4-6")];
  providers[0].models[0].contextWindow = 200000;
  bridge.enable(token, 25819, providers, ["github.com"]);
  const file = bridge.profileFile(bridge.owner().id), before = fs.readFileSync(file);
  providers[0].models[0].contextWindow = 1000000;
  assert.deepEqual(bridge.status(token, 25819, providers), { configured: true, owned: true, current: false, conflict: false });
  assert.deepEqual(fs.readFileSync(file), before);
  bridge.enable(token, 25819, providers);
  const profile = JSON.parse(fs.readFileSync(file));
  assert.equal(profile.inferenceModels[0].supports1m, true);
  assert.equal(profile.inferenceModels[0].prefer1m, true);
  assert.equal(bridge.status(token, 25819, providers).current, true);
  assert.deepEqual(profile.coworkEgressAllowedHosts, ["github.com"]);
  providers[0].models[0].contextWindow = 200000;
  assert.equal(bridge.status(token, 25819, providers).current, false);
  bridge.enable(token, 25819, providers);
  const downgraded = JSON.parse(fs.readFileSync(file));
  assert.equal(downgraded.inferenceModels[0].supports1m, undefined);
  assert.equal(downgraded.inferenceModels[0].prefer1m, undefined);
  assert.deepEqual(downgraded.coworkEgressAllowedHosts, ["github.com"]);
  bridge.disable();
});

test("1M desktop suffix and beta headers reach the same exact configured upstream model", async t => {
  const providers = [provider("a", "claude-opus-4-6")], calls = [];
  providers[0].models[0].contextWindow = 1000000;
  const router = new Router({ getState: () => ({ providers }), fetchUpstream: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  } });
  await router.start(0); t.after(() => router.stop());
  const model = desired(token, 25819, providers).inferenceModels[0].name;
  const beta = "context-1m-2025-08-07,interleaved-thinking-2025-05-14";
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/claude/models/v1/messages`, {
    method: "POST", headers: { authorization: "Bearer " + router.clientToken, "anthropic-beta": beta },
    body: JSON.stringify({ model: model + "[1m]", max_tokens: 32, messages: [{ role: "user", content: "OK" }] }),
  });
  assert.equal(response.status, 200); await response.text();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "a.test");
  assert.equal(calls[0].body.model, "claude-opus-4-6");
  assert.equal(calls[0].headers["anthropic-beta"], beta);
});

test("existing owned profile upgrades explicitly, persists caps and egress, then restores original mode", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-claude-native-effort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { directory: path.join(root, "Claude-3p"), policyReader: () => ({}) };
  const data = path.join(root, "ASS"), bridge = new ClaudeDesktopGateway(data, options), providers = [provider("a")];
  bridge.enable(token, 25819, providers, ["github.com"]);
  const owner = bridge.owner(), file = bridge.profileFile(owner.id), old = desired(token, 25819, providers, ["github.com"]);
  delete old.defaultModelEffort; delete old.inferenceModels[0].maxEffort;
  old.inferenceModels[0].name = "claude-ass-" + crypto.createHash("sha256").update("a::claude-sonnet-4-6").digest("hex").slice(0, 32);
  fs.writeFileSync(file, JSON.stringify(old));
  owner.hash = crypto.createHash("sha256").update(JSON.stringify(old)).digest("hex");
  fs.writeFileSync(bridge.file, JSON.stringify(owner));
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bridge.status(token, 25819, providers), { configured: true, owned: true, current: false, conflict: false });
  assert.deepEqual(fs.readFileSync(file), bytes);
  bridge.enable(token, 25819, providers);
  const reopened = new ClaudeDesktopGateway(data, options);
  assert.equal(reopened.status(token, 25819, providers).current, true);
  const profile = JSON.parse(fs.readFileSync(file));
  assert.equal(profile.defaultModelEffort, "medium");
  assert.deepEqual(profile.coworkEgressAllowedHosts, ["github.com"]);
  reopened.disable();
  assert.equal(fs.existsSync(file), false);
});

test("native routes and effort selection reach exact upstream without affecting other providers", async t => {
  const providers = [provider("a"), provider("b")], calls = [];
  const router = new Router({ getState: () => ({ providers }), fetchUpstream: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  } });
  await router.start(0); t.after(() => router.stop());
  const base = `http://127.0.0.1:${router.port}/clients/claude/models/v1`, headers = { authorization: "Bearer " + router.clientToken };
  const directory = await (await fetch(base + "/models", { headers })).json();
  assert.equal(directory.data[0].anthropic_family_tier, "sonnet");
  for (const row of directory.data) {
    const response = await fetch(base + "/messages", { method: "POST", headers,
      body: JSON.stringify({ model: row.id, max_tokens: 32, output_config: { effort: "high" }, messages: [{ role: "user", content: "OK" }] }) });
    assert.equal(response.status, 200); await response.text();
  }
  assert.deepEqual(calls.map(c => new URL(c.url).hostname), ["a.test", "b.test"]);
  assert.ok(calls.every(c => c.body.model === "claude-sonnet-4-6" && c.body.output_config.effort === "high"));
});
