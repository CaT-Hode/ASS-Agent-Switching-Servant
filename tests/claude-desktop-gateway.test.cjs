const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { ClaudeDesktopGateway, desired, readPolicy } = require("../core/claude-desktop-gateway.cjs");
const { claudeModels } = require("../core/claude-models.cjs");
const { atomic } = require("../core/native-fields.cjs");
const token = "a".repeat(64), otherId = "00000000-0000-4000-8000-000000000001";
const providers = [{ id: "relay", name: "Test Relay", enabled: true, apiKey: "synthetic-key", models: [
  { model: "claude-sonnet-test", displayName: "Sonnet test", enabled: true, wireApi: "anthropic" },
  { model: "gpt-test", displayName: "GPT test", enabled: true, wireApi: "openai-responses" },
] }];
const parse = file => JSON.parse(fs.readFileSync(file, "utf8"));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-claude-desktop-"));
  const data = path.join(root, "ASS"), directory = path.join(root, "Claude-3p");
  const options = { directory, policyReader: () => ({}) };
  const bridge = new ClaudeDesktopGateway(data, options);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("ass-claude-desktop-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, data, options, bridge };
}
test("local desktop setup persists without registry writes and restores a fresh user's files", t => {
  const { bridge, data, options } = fixture(t);
  assert.deepEqual(bridge.status(token, 25819), { configured: false, owned: false, current: false, conflict: false });
  bridge.enable(token, 25819);
  const owner = parse(bridge.file), meta = parse(bridge.metaFile);
  assert.equal(owner.version, 2);
  assert.equal(meta.appliedId, owner.id);
  assert.deepEqual(meta.entries, [{ id: owner.id, name: "ASS" }]);
  assert.equal(parse(bridge.settingsFile).deploymentMode, "3p");
  assert.deepEqual(parse(bridge.profileFile(owner.id)), desired(token, 25819));
  assert.ok(!fs.readFileSync(bridge.file, "utf8").includes(token));
  const restarted = new ClaudeDesktopGateway(data, options);
  assert.deepEqual(restarted.status(token, 25819), { configured: true, owned: true, current: true, conflict: false });
  restarted.enable("b".repeat(64), 25821);
  assert.equal(parse(bridge.metaFile).entries.length, 1);
  assert.equal(restarted.status("b".repeat(64), 25821).current, true);
  restarted.disable();
  for (const file of [bridge.file, bridge.metaFile, bridge.settingsFile, bridge.profileFile(owner.id)]) assert.equal(fs.existsSync(file), false);
});
test("disable preserves saved configurations and later preferences while restoring the old selection and mode", t => {
  const { bridge } = fixture(t);
  atomic(bridge.metaFile, JSON.stringify({ appliedId: "", entries: [{ id: otherId, name: "Other" }], custom: true }));
  atomic(bridge.settingsFile, JSON.stringify({ deploymentMode: "1p", preferences: { theme: "dark" }, mcpServers: { sample: {} } }));
  bridge.enable(token, 25819);
  const settings = parse(bridge.settingsFile); settings.preferences.theme = "light";
  atomic(bridge.settingsFile, JSON.stringify(settings));
  const meta = parse(bridge.metaFile); meta.custom = "new";
  atomic(bridge.metaFile, JSON.stringify(meta));
  bridge.disable();
  assert.deepEqual(parse(bridge.settingsFile), { deploymentMode: "1p", preferences: { theme: "light" }, mcpServers: { sample: {} } });
  assert.deepEqual(parse(bridge.metaFile), { appliedId: "", entries: [{ id: otherId, name: "Other" }], custom: "new" });
});
test("desktop pins every routed model with a visible name and upgrades an owned discovery-only profile", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819);
  assert.equal(bridge.status(token, 25819, providers).current, false);
  bridge.enable(token, 25819, providers);
  const owner = parse(bridge.file), profile = parse(bridge.profileFile(owner.id));
  assert.deepEqual(profile.inferenceModels, [
    { name: claudeModels(providers)[0].discoveryId, labelOverride: "Test Relay · Sonnet test" },
    { name: claudeModels(providers)[1].discoveryId, labelOverride: "Test Relay · GPT test" },
  ]);
  assert.equal(profile.modelDiscoveryEnabled, false);
  assert.equal(bridge.status(token, 25819, providers).current, true);
  bridge.disable();
  assert.equal(fs.existsSync(bridge.profileFile(owner.id)), false);
});
test("stale desktop picker remains unchanged until explicit synchronization", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819, providers);
  const owner = parse(bridge.file), file = bridge.profileFile(owner.id), profile = parse(file);
  profile.inferenceModels[1].name = "claude-ass/relay::gpt-test";
  atomic(file, JSON.stringify(profile, null, 2) + "\n");
  owner.hash = crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  atomic(bridge.file, JSON.stringify(owner, null, 2) + "\n");
  const before = fs.readFileSync(file, "utf8");
  assert.equal(bridge.status(token, 25819, providers).current, false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  bridge.enable(token, 25819, providers);
  assert.deepEqual(parse(file).inferenceModels, desired(token, 25819, providers).inferenceModels);
  assert.equal(bridge.status(token, 25819, providers).current, true);
});
test("another selected configuration is left active when removing the stored ASS entry", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819);
  const meta = parse(bridge.metaFile); meta.entries.push({ id: otherId, name: "Other" }); meta.appliedId = otherId;
  atomic(bridge.metaFile, JSON.stringify(meta));
  assert.equal(bridge.status(token, 25819).conflict, true);
  bridge.disable();
  assert.deepEqual(parse(bridge.metaFile), { entries: [{ id: otherId, name: "Other" }], appliedId: otherId });
  assert.equal(parse(bridge.settingsFile).deploymentMode, "3p");
});
test("existing management or a foreign local configuration prevents takeover", t => {
  const { bridge } = fixture(t);
  bridge.policyReader = key => key === bridge.machinePolicy ? { inferenceProvider: { type: "REG_SZ", value: "anthropic" } } : {};
  assert.throws(() => bridge.enable(token, 25819), /系统管理策略/);
  assert.equal(fs.existsSync(bridge.file), false);
  bridge.policyReader = () => ({});
  atomic(bridge.metaFile, JSON.stringify({ appliedId: otherId, entries: [{ id: otherId, name: "Other" }] }));
  assert.throws(() => bridge.enable(token, 25819), /本地第三方配置/);
  assert.equal(parse(bridge.metaFile).appliedId, otherId);
});
test("externally edited ASS profile is never overwritten or deleted", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819);
  const file = bridge.profileFile(parse(bridge.file).id), profile = parse(file);
  profile.inferenceGatewayBaseUrl = "https://other.example";
  atomic(file, JSON.stringify(profile));
  assert.equal(bridge.status(token, 25819).owned, false);
  assert.throws(() => bridge.preflightDisable(), /配置已变化/);
  assert.throws(() => bridge.enable(token, 25819), /已被其他程序修改/);
  assert.throws(() => bridge.disable(), /配置已变化/);
  assert.equal(parse(file).inferenceGatewayBaseUrl, "https://other.example");
});
test("a local permission failure rolls back every completed write and reports a secret-free error code", t => {
  const { bridge } = fixture(t);
  const original = '{"deploymentMode":"1p","preferences":{"theme":"dark"}}';
  atomic(bridge.settingsFile, original);
  bridge.writer = (file, value) => {
    if (file === bridge.metaFile) throw Object.assign(Error("synthetic detail " + token), { code: "EACCES" });
    atomic(file, value);
  };
  assert.throws(() => bridge.enable(token, 25819), error => {
    assert.match(error.message, /EACCES/); assert.match(error.message, /原设置已恢复/); assert.ok(!error.message.includes(token)); return true;
  });
  assert.equal(fs.readFileSync(bridge.settingsFile, "utf8"), original);
  assert.equal(fs.existsSync(bridge.file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(bridge.metaFile)), []);
});
test("0.1.32 owned registry settings remain removable without deleting unrelated policy", { skip: process.platform !== "win32" }, t => {
  const { bridge } = fixture(t);
  const policy = "HKCU\\SOFTWARE\\ASS-QA-Claude-" + crypto.randomBytes(8).toString("hex");
  bridge.policy = policy; bridge.machinePolicy = policy + "-machine"; bridge.policyReader = readPolicy;
  const reg = args => execFileSync("reg.exe", args, { stdio: "ignore", windowsHide: true });
  t.after(() => { try { reg(["delete", policy, "/f"]); } catch {} });
  const { coworkEgressAllowedHosts, ...values } = desired(token, 25819);
  for (const [name, value] of Object.entries(values)) reg(["add", policy, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
  reg(["add", policy, "/v", "disableAutoUpdates", "/t", "REG_SZ", "/d", "false", "/f"]);
  atomic(bridge.file, JSON.stringify({ version: 1, hash: crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex") }));
  assert.equal(bridge.status(token, 25819).owned, true);
  const before = readPolicy(policy);
  assert.throws(() => bridge.enable(token, 25819), /先移除旧版/);
  assert.deepEqual(readPolicy(policy), before);
  bridge.disable();
  assert.deepEqual(Object.keys(readPolicy(policy)), ["disableAutoUpdates"]);
});

test("tool networking remains independent from authenticated loopback inference", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819, providers);
  const profile = parse(bridge.profileFile(parse(bridge.file).id));
  assert.deepEqual(profile.coworkEgressAllowedHosts, ["*"]);
  assert.equal(new URL(profile.inferenceGatewayBaseUrl).hostname, "127.0.0.1");
  assert.equal(profile.inferenceGatewayApiKey, token);
  assert.equal(bridge.status(token, 25819, providers).current, true);
});

test("both legacy local profile shapes upgrade only on explicit sync and remain removable", t => {
  for (const modelProviders of [undefined, providers]) {
    const { bridge } = fixture(t);
    bridge.enable(token, 25819, modelProviders);
    const owner = parse(bridge.file), file = bridge.profileFile(owner.id);
    const profile = parse(file); delete profile.coworkEgressAllowedHosts;
    atomic(file, JSON.stringify(profile, null, 2) + "\n");
    owner.hash = crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex");
    atomic(bridge.file, JSON.stringify(owner, null, 2) + "\n");
    const before = fs.readFileSync(file, "utf8");
    assert.deepEqual(bridge.status(token, 25819, modelProviders), { configured: true, owned: true, current: false, conflict: false });
    assert.equal(fs.readFileSync(file, "utf8"), before);
    bridge.preflightDisable();
    bridge.enable(token, 25819, modelProviders);
    assert.equal(parse(bridge.file).id, owner.id);
    assert.deepEqual(parse(file).coworkEgressAllowedHosts, ["*"]);
    assert.equal(bridge.status(token, 25819, modelProviders).current, true);
    bridge.disable();
    assert.equal(fs.existsSync(file), false);
  }
});

test("explicit domain and deny-all policies persist across token, port and model updates", t => {
  for (const hosts of [["github.com", "*.githubusercontent.com", "api.github.com:443"], []]) {
    const { bridge, data, options } = fixture(t);
    bridge.enable(token, 25819, providers, hosts);
    const restarted = new ClaudeDesktopGateway(data, options);
    assert.equal(restarted.status(token, 25819, providers).current, true);
    restarted.enable("b".repeat(64), 25821, providers);
    assert.deepEqual(parse(restarted.profileFile(parse(restarted.file).id)).coworkEgressAllowedHosts, hosts);
    assert.equal(restarted.status("b".repeat(64), 25821, providers).current, true);
    restarted.disable();
  }
});

test("invalid egress entries fail before writes and foreign policy edits cannot be taken over", t => {
  const { bridge } = fixture(t);
  for (const hosts of ["*", ["https://github.com"], ["github.com/path"], ["a..com"], ["api.github.com:0"], ["api.github.com:65536"], ["github.com\n"], Array(501).fill("*")]) {
    assert.throws(() => bridge.enable(token, 25819, providers, hosts), /联网域名无效/);
    assert.equal(fs.existsSync(bridge.file), false);
  }
  bridge.enable(token, 25819, providers);
  const file = bridge.profileFile(parse(bridge.file).id), profile = parse(file);
  profile.coworkEgressAllowedHosts = ["example.com"];
  atomic(file, JSON.stringify(profile));
  assert.equal(bridge.status(token, 25819, providers).conflict, true);
  assert.throws(() => bridge.enable(token, 25819, providers), /其他程序修改/);
  assert.throws(() => bridge.disable(), /配置已变化/);
  assert.deepEqual(parse(file).coworkEgressAllowedHosts, ["example.com"]);
});

test("failed egress upgrade restores exact legacy profile and ownership", t => {
  const { bridge } = fixture(t);
  bridge.enable(token, 25819, providers);
  const owner = parse(bridge.file), file = bridge.profileFile(owner.id), profile = parse(file);
  delete profile.coworkEgressAllowedHosts;
  atomic(file, JSON.stringify(profile, null, 2) + "\n");
  owner.hash = crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  atomic(bridge.file, JSON.stringify(owner, null, 2) + "\n");
  const before = fs.readFileSync(file, "utf8"), beforeOwner = fs.readFileSync(bridge.file, "utf8");
  bridge.writer = (target, value) => {
    if (target === bridge.file) throw Object.assign(Error(), { code: "EACCES" });
    atomic(target, value);
  };
  assert.throws(() => bridge.enable(token, 25819, providers), /原设置已恢复/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.readFileSync(bridge.file, "utf8"), beforeOwner);
});
