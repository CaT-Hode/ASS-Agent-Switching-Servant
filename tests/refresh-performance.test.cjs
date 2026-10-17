const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { withReadScope, memoRead } = require("../core/read-scope.cjs");
const { SnapshotPublisher } = require("../core/snapshot-publisher.cjs");
const { ClientSnapshot } = require('../core/snapshot-publisher.cjs');

test('native update read failure preserves account cache without hiding newly saved providers',()=>{
  let broken=false;
  const cache=new ClientSnapshot(()=>{if(broken)throw Error('native update');return{clients:[{id:'codex',accounts:[{id:'native'}]}]}});
  cache.current().state.clients[0].accounts=[];broken=true;
  const result={providers:[{id:'woyao'}],...cache.current()};
  assert.equal(result.providers[0].id,'woyao');assert.equal(result.state.clients[0].accounts.length,1);assert.ok(result.error);
  result.state.clients[0].accounts=[];assert.equal(cache.current().state.clients[0].accounts.length,1);
  broken=false;assert.equal(cache.current().error,'');
});

test("read scope reuses nested synchronous work but expires between operations", () => {
  let calls = 0;
  const read = () => memoRead(read, ["file"], () => ({ generation: ++calls }));
  const first = withReadScope(() => { const a = read(); assert.equal(withReadScope(read), a); return a; });
  assert.notEqual(withReadScope(read), first);
  assert.equal(calls, 2);
  read(); read(); assert.equal(calls, 4, "unscoped reads are fresh");
});
test("read scope isolates reader/options identities, undefined values and failures", () => {
  let calls = 0;
  const owner = {}, options = {}, nextOptions = {};
  const read = (key) => memoRead(owner, [key], () => { calls++; return undefined; });
  withReadScope(() => { read(options); read(options); read(nextOptions); assert.equal(calls, 2);
    assert.equal(memoRead({}, [options], () => "other reader"), "other reader");
    assert.throws(() => memoRead(owner, ["bad"], () => { throw Error("failed"); }));
    assert.equal(memoRead(owner, ["bad"], () => "recovered"), "recovered");
  });
  assert.throws(() => withReadScope(() => { read(options); throw Error("abort scope"); }));
  read(options); assert.equal(calls, 4);
});
test("read scope never retains credentials across asynchronous continuations", async () => {
  let calls = 0;
  const read = () => memoRead(read, [], () => ++calls);
  await withReadScope(async () => {
    assert.equal(read(), 1); assert.equal(read(), 1);
    await Promise.resolve(); assert.equal(read(), 2); assert.equal(read(), 3);
  });
});
function publisherFixture() {
  let visible = true, reads = 0, count = 0;
  const timers = new Map(), sent = [];
  const publisher = new SnapshotPublisher({ read: () => ({ sequence: ++reads }), send: (s) => sent.push(s),
    canSend: () => visible, schedule: (fn) => { const id = ++count; timers.set(id, fn); return id; }, cancel: (id) => timers.delete(id) });
  return { publisher, sent, timers, reads: () => reads, visible: (value) => { visible = value; },
    tick: () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((fn) => fn()); } };
}
test("state bursts build once and snapshot replies are broadcast without rebuilding", () => {
  const f = publisherFixture();
  for (let i = 0; i < 20; i++) f.publisher.push();
  assert.equal(f.timers.size, 1); f.tick(); assert.equal(f.reads(), 1); assert.equal(f.sent.length, 1);
  f.publisher.push(); const reply = { sequence: 20 };
  f.publisher.publish(reply); f.tick();
  assert.equal(f.reads(), 1); assert.equal(f.sent.length, 2); assert.equal(f.sent[1], reply);
});
test("hidden/minimized windows do not read or send, restoration gets fresh state", () => {
  const f = publisherFixture();
  f.publisher.push(); f.visible(false); f.tick();
  f.publisher.push(); f.publisher.publish(); assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  f.visible(true); f.publisher.push(); f.tick(); assert.equal(f.reads(), 1);
  f.publisher.push(); f.publisher.clear(); f.tick(); assert.equal(f.reads(), 1);
});
test("background state failures do not reject completed actions, crash timers or block recovery", () => {
  let readFailure = true, sendFailure = false, reports = 0;
  const sent = [];
  const publisher = new SnapshotPublisher({ read: () => { if (readFailure) throw Error("bad config"); return { sequence: 1 }; },
    send: (s) => { if (sendFailure) throw Error("closed window"); sent.push(s); },
    onError: () => { reports++; } });
  assert.doesNotThrow(() => publisher.publish()); assert.equal(reports, 1);
  readFailure = false; publisher.publish(); assert.equal(sent.length, 1);
  sendFailure = true; assert.doesNotThrow(() => publisher.publish({ sequence: 2 })); assert.equal(reports, 2);
  publisher.onError = () => { throw Error("closed reporter"); }; assert.doesNotThrow(() => publisher.publish());
});
test("IPC sharing preserves usage/model identities and rejects duplicate or stale replies", async () => {
  const { latestSnapshot } = await import("../src/state-snapshot.mjs");
  const current = { sequence: 2, usage: { rows: [{ tokens: 10 }] }, models: [{ id: "demo" }], profile: { updatedAt: "old" } };
  const next = structuredClone(current); next.sequence++; next.profile.updatedAt = "new";
  const merged = latestSnapshot(current, next);
  assert.equal(merged.usage, current.usage); assert.equal(merged.models, current.models);
  assert.equal(merged.profile, next.profile); assert.equal(merged.profile.updatedAt, "new");
  assert.equal(latestSnapshot(merged, structuredClone(merged)), merged);
  assert.equal(latestSnapshot(merged, current), merged);
  const changed = structuredClone(merged); changed.sequence++; changed.usage.rows[0].tokens++;
  assert.equal(latestSnapshot(merged, changed).usage.rows[0].tokens, 11);
  assert.equal(current.usage.rows[0].tokens, 10);
});
test("IPC sharing handles removed fields, array length and special property names without mutation", async () => {
  const { shareUnchanged } = await import("../src/state-snapshot.mjs");
  const previous = { a: { value: 1 }, removed: true }, next = { a: { value: 1 } };
  assert.deepEqual(shareUnchanged(previous, next), next);
  assert.equal(shareUnchanged(previous, next).a, previous.a);
  assert.notEqual(next.a, previous.a);
  assert.deepEqual(shareUnchanged([1, 2], [1]), [1]);
  assert.equal(shareUnchanged([], new Array(2)).length, 2);
  const special = JSON.parse('{"__proto__":{"marker":true},"list":[]}');
  const shared = shareUnchanged(special, structuredClone(special));
  assert.equal(shared, special); assert.equal({}.marker, undefined);
});
test("native catalog scans are bounded per file and account-only reads skip injection", (t) => {
  const { HarnessManager } = require("../core/harnesses.cjs");
  const { NativeConfig } = require("../core/native-config.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-refresh-perf-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^ass-refresh-perf-/); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, "home"), data = path.join(root, "data"), config = path.join(home, ".config/opencode/opencode.json");
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.mkdirSync(data);
  const write = (key) => fs.writeFileSync(config, JSON.stringify({ provider: { relay: { npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://example.test/v1", apiKey: key }, models: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["demo-" + i, {}])) } } }));
  write("synthetic-one");
  const manager = new HarnessManager(data, () => ({ providers: [] }), [], path.join(home, ".codex"), { home, env: {}, launchEnv: {} });
  manager.options.nativeConfig = new NativeConfig(data, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }, manager);
  let reads = 0; const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) { if (file === config) reads++; return original.call(this, file, ...args); };
  try { manager.snapshot(); } finally { fs.readFileSync = original; }
  assert.ok(reads <= 6, `catalog read ${reads} times for 100 models`);
  const profiles = manager.nativeApis("opencode"); assert.equal(profiles[0].models.length, 100);
  const injection = manager.injection; manager.injection = () => { throw Error("account refresh attempted injection scan"); };
  const accounts = manager.snapshot({ accountsOnly: true });
  assert.ok(accounts.clients.find((c) => c.id === "opencode").modelAccounts.length);
  assert.equal(manager.nativeApis("opencode"), profiles, "lightweight reads preserve the full model discovery cache");
  manager.injection = injection;
  write("synthetic-two"); manager.snapshot();
  assert.equal(manager.nativeApis("opencode")[0].apiKey, "synthetic-two", "next operation observes credential changes");
});
