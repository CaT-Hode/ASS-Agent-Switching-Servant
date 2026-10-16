const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Connections } = require("../core/connections.cjs");
const { InjectionFiles, hash } = require("../core/injection-files.cjs");
const { ConfigManager, atomic } = require("../core/config.cjs");
const { Router } = require("../core/router.cjs");
const { routeConfig } = require("../core/harnesses.cjs");
const { parseImport } = require("../core/models.cjs");

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-connections-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function connectionFixture(t, overrides = {}) {
  const dataDir = temp(t), configFile = path.join(dataDir, "config.toml");
  fs.writeFileSync(configFile, "");
  const router = {
    active: Object.create(null), starts: 0, stops: 0, canceled: [],
    clientActive(id) { return id ? (this.active[id] || 0) : Object.values(this.active).reduce((a, b) => a + b, 0); },
    async start() { this.starts++; }, async stop() { this.stops++; },
    async cancelClient(id) { this.canceled.push(id); this.active[id] = 0; },
  };
  const config = {
    file: configFile, catalog: path.join(dataDir, "catalog.json"), baseUrl: "http://127.0.0.1:25819/clients/codex/v1",
    attached: false, managed: false, attachCalls: 0, detachCalls: 0, preflightCalls: 0,
    status() { return { attached: this.attached, managed: this.managed }; },
    attach() { this.attachCalls++; this.attached = this.managed = true; },
    preflightDetach() { this.preflightCalls++; },
    detach() { this.detachCalls++; this.attached = this.managed = false; },
  };
  const injections = {
    entries: [], error: "", restored: [], preflightCalls: [], version: 0,
    preflight(ids) { this.preflightCalls.push([...ids]); },
    list(ids) { return this.entries.filter((e) => ids.includes(e.harness)); },
    fingerprint(ids) { return hash(JSON.stringify([this.version, ids])); },
    restore(ids) { this.restored.push([...ids]); this.entries = this.entries.filter((e) => !ids.includes(e.harness)); },
  };
  const processes = {
    sessions: [], error: null, refreshCalls: 0, stopCalls: [],
    async refresh() { this.refreshCalls++; return this.snapshot(); },
    snapshot() { return { sessions: this.sessions.map((s) => ({ ...s })), error: this.error }; },
    async stop(ids) { this.stopCalls.push([...ids]); for (const s of this.sessions) if (ids.includes(s.id)) s.status = "gone"; return this.snapshot(); },
  };
  Object.assign(router, overrides.router); Object.assign(config, overrides.config);
  Object.assign(injections, overrides.injections); Object.assign(processes, overrides.processes);
  const connections = new Connections({ dataDir, router, config, injections, processes,
    nativeConfig: overrides.nativeConfig,
    proxyConfig: overrides.proxyConfig,
    extraActive: overrides.extraActive || (() => 0), restarter: overrides.restarter, sessionHandoff: overrides.sessionHandoff });
  return { dataDir, router, config, injections, processes, connections };
}

test('refresh all syncs only enabled clients, preserves accountless state and never restarts windows', async t => {
  const calls = [], proxy = { clients: { codex: { accountless: true } },
    supports: id => id === 'codex' || id === 'claude', preflight() {},
    fingerprint: () => 'proxy', sync: (...args) => calls.push(['proxy', ...args]) };
  const f = connectionFixture(t, { proxyConfig: proxy, nativeConfig: {
    list: () => [], isDirect: id => id === 'dsh', preflight() {}, fingerprint: () => 'native',
    sync: id => calls.push(['native', id]) }, restarter: fakeRestarter() });
  f.connections.enabled.codex = f.connections.enabled.dsh = true;
  f.processes.sessions.push({ id: 'open-task', harness: 'codex', status: 'running' });
  const before = JSON.stringify(f.connections.enabled);
  const result = await f.connections.refreshAll({ assertIdle: async id => calls.push(['idle', id]) });
  assert.deepEqual(result.refreshed.map(r => r.id), ['codex', 'dsh']);
  assert.equal(result.ok, true); assert.deepEqual(result.skipped, []);
  assert.equal(JSON.stringify(f.connections.enabled), before);
  assert.equal(proxy.clients.codex.accountless, true);
  assert.deepEqual(calls.filter(c => c[0] === 'proxy'), [['proxy','codex'],['proxy','dsh']]);
  assert.equal(f.processes.stopCalls.length, 0); assert.equal(f.processes.refreshCalls, 0);
  assert.deepEqual(f.connections.restarter.calls, []); assert.deepEqual(f.router.canceled, []);
  assert.equal(f.connections.busy, false); assert.equal(f.connections.blocked.size, 0);
});

test('bulk refresh skips active requests, external conflicts and login activity independently', async t => {
  const writes = [];
  const f = connectionFixture(t, { nativeConfig: { list: () => [], isDirect: () => true,
    fingerprint: () => 'native', preflight: ids => { if (ids.includes('dsh')) throw Error('external edit'); },
    sync: id => writes.push(id) } });
  for (const id of ['codex','claude','opencode','pi','dsh']) f.connections.enabled[id] = true;
  f.router.active.codex = 1;
  const result = await f.connections.refreshAll({ assertIdle: async id => { if (id === 'claude') throw Error('login in progress'); } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refreshed.map(r => r.id), ['opencode','pi']);
  assert.deepEqual(result.skipped.map(r => r.id), ['codex','claude','dsh']);
  assert.match(result.skipped[0].reason, /请求正在进行/);
  assert.match(result.skipped[1].reason, /login/); assert.match(result.skipped[2].reason, /external edit/);
  assert.deepEqual(writes, ['opencode','pi']); assert.equal(f.router.active.codex, 1);
  assert.equal(f.config.attachCalls, 0); assert.equal(f.connections.blocked.size, 0);
});

test('bulk refresh locks concurrent transitions and rejects changes during an async guard', async t => {
  const f = connectionFixture(t); f.connections.enabled.codex = true;
  let release;
  const work = f.connections.refreshAll({ assertIdle: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(f.connections.busy, true); assert.equal(f.connections.allow('codex'), false);
  await assert.rejects(f.connections.refreshAll(), /已有接入操作/);
  await assert.rejects(f.connections.preview('pi', true), /正在切换/);
  await assert.rejects(f.connections.launch(() => {}), /正在切换/);
  fs.writeFileSync(f.config.file, '# concurrent user edit\n'); release();
  const result = await work;
  assert.equal(result.refreshed.length, 0); assert.match(result.skipped[0].reason, /配置已变化/);
  assert.equal(f.config.attachCalls, 0); assert.equal(f.connections.busy, false);
});

test('bulk refresh with disabled clients is a no-op; global errors and write failures remain visible', async t => {
  const f = connectionFixture(t);
  assert.deepEqual((await f.connections.refreshAll()).refreshed, []);
  assert.equal(f.router.starts, 0); assert.equal(f.config.attachCalls, 0);
  f.connections.error = 'invalid state'; await assert.rejects(f.connections.refreshAll(), /invalid state/);
  f.connections.error = ''; f.connections.enabled.codex = true;
  f.config.attach = () => { throw Error('write failed'); };
  const result = await f.connections.refreshAll();
  assert.equal(result.ok, false); assert.match(result.skipped[0].reason, /write failed/);
  assert.equal(f.connections.enabled.codex, true); assert.equal(f.connections.busy, false);
});

test('failed Codex session handoff retains the provider definition and enabled routing',async t=>{
  let restores=0;const f=connectionFixture(t,{sessionHandoff:{status:()=>({count:2}),restore:async()=>{restores++;throw Error('client still running');}}});
  f.connections.enabled.codex=true;f.config.attached=f.config.managed=true;
  const p=await f.connections.preview('codex',false);assert.equal(p.restoreSessions,2);
  await assert.rejects(f.connections.apply({ticket:p.ticket,mode:'safe',acknowledged:true}),/client still running/);
  assert.equal(restores,1);assert.equal(f.config.detachCalls,0);assert.equal(f.router.stops,0);
  assert.equal(f.connections.enabled.codex,true);assert.equal(f.config.attached,true);
});

test("initial all-false connection state is persisted and restart stays closed without starting router", async (t) => {
  const f = connectionFixture(t);
  const expected = { codex: false, claude: false, opencode: false, pi: false, dsh: false, kimi: false, zcode: false };
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, "connections.json"), "utf8")), expected);

  const restarted = new Connections({
    dataDir: f.dataDir,
    router: f.router,
    config: f.config,
    injections: f.injections,
    processes: f.processes,
  });
  assert.deepEqual(restarted.enabled, expected);
  for (const id of Object.keys(expected)) assert.equal(restarted.allow(id), false);
  assert.equal(f.router.starts, 0);

  const plan = await restarted.preview("pi", false);
  await restarted.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true });
  assert.equal(f.router.starts, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(restarted.file, "utf8")), expected);
});
function fakeRestarter() {
  return { calls: [], preview: async () => ({ available: true, applicable: true, names: ["Codex 桌面端"] }),
    public: (p) => p, async validate() { this.calls.push("validate"); }, async stop() { this.calls.push("stop"); },
    async launch(_plan, beforeLaunch) { this.calls.push("launch"); beforeLaunch?.(); return { ok: true }; },
    async restart() { this.calls.push("restart"); return { ok: true }; } };
}
for (const id of ['codex', 'claude']) test(`${id} injection force-close stops before writes and never relaunches`, async (t) => {
  const r = fakeRestarter(), f = connectionFixture(t, { restarter: r });
  r.preview = async () => ({ available: true, applicable: true, closeAvailable: true });
  r.close = async () => { r.calls.push('close'); assert.equal(f.connections.enabled[id], false); };
  f.router.active[id] = 1; const p = await f.connections.preview(id, true);
  const result = await f.connections.apply({ ticket: p.ticket, mode: 'safe', acknowledged: true, close: true });
  assert.equal(result.closed, true); assert.equal(f.connections.enabled[id], true);
  assert.deepEqual(r.calls, ['close']); assert.deepEqual(f.router.canceled, [id]);
  assert.match(result.message, /未重新启动/);
});
test('close/restart cannot both be selected, and failed close never writes injection', async (t) => {
  const r = fakeRestarter(), f = connectionFixture(t, { restarter: r });
  r.preview = async () => ({ available: true, applicable: true, closeAvailable: true });
  const p = await f.connections.preview('codex', true);
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: 'safe', acknowledged: true, close: true, restart: true }), /关闭目标/);
  r.close = async () => { throw Error('close failed'); };
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: 'safe', acknowledged: true, close: true }), /close failed/);
  assert.equal(f.config.attachCalls, 0); assert.equal(f.connections.enabled.codex, false); assert.equal(r.calls.includes('launch'), false);
});

test("direct exit preserves configuration and sessions even with active requests or broken inspection", t => {
  const f = connectionFixture(t, { router: { active: { codex: 1 } }, processes: { error: "inspection unavailable" } });
  f.connections.enabled.codex = f.connections.enabled.claude = true;
  f.config.attached = f.config.managed = true;
  f.processes.sessions = [{ id: "keep-window", harness: "claude", status: "running" }];
  f.injections.entries = [{ harness: "claude", relative: "keep.json" }];
  fs.writeFileSync(f.connections.file, JSON.stringify(f.connections.enabled));
  const before = fs.readFileSync(f.connections.file);
  f.injections.preflight = () => { throw Error("external edit"); };
  let quits = 0;
  assert.deepEqual(f.connections.directExit(true, () => { quits++; }), { ok: true, quit: true, preserved: true });
  assert.equal(quits, 1);
  assert.deepEqual(fs.readFileSync(f.connections.file), before);
  assert.equal(f.config.detachCalls, 0); assert.equal(f.router.stops, 0);
  assert.equal(f.processes.refreshCalls, 0); assert.equal(f.processes.stopCalls.length, 0);
  assert.equal(f.injections.restored.length, 0); assert.equal(f.connections.enabled.codex, true);
  assert.equal(f.processes.sessions[0].status, "running");
});

test("direct exit requires confirmation and never interrupts a configuration transaction", t => {
  const f = connectionFixture(t);
  let quits = 0;
  assert.throws(() => f.connections.directExit(false, () => { quits++; }), /确认直接退出/);
  f.connections.busy = true;
  assert.throws(() => f.connections.directExit(true, () => { quits++; }), /配置正在写入/);
  assert.equal(quits, 0);
});

test("safe exit is offered only for proxy configuration, proxy windows, or unresolved state", t => {
  const f = connectionFixture(t, { nativeConfig: { isDirect: id => id === "dsh", list: () => [] } });
  assert.equal(f.connections.exitStatus().safeNeeded, false);
  f.connections.enabled.dsh = true;
  f.processes.sessions = [{ id: "native-window", harness: "dsh", status: "running", transport: "native" }];
  assert.equal(f.connections.exitStatus().safeNeeded, false);
  f.connections.enabled.claude = true;
  assert.deepEqual(f.connections.exitStatus().names, ["Claude Code"]);
  f.connections.enabled.claude = false;
  f.injections.entries = [{ harness: "codex", relative: "old-config.json" }];
  assert.deepEqual(f.connections.exitStatus().names, ["Codex"]);
  f.injections.entries = [];
  f.connections.error = "unreadable state";
  assert.equal(f.connections.exitStatus().safeNeeded, true);
  assert.equal(f.processes.refreshCalls, 0);
});

test("automatic direct exit is available only without dependencies, requests, or an in-flight configuration write", t => {
  const f = connectionFixture(t);
  assert.equal(f.connections.exitStatus().canDirectExit, true);
  f.router.active.diagnostics = 1;
  assert.equal(f.connections.exitStatus().canDirectExit, false);
  f.router.active.diagnostics = 0;
  f.connections.busy = true;
  assert.equal(f.connections.exitStatus().canDirectExit, false);
  f.connections.busy = false;
  f.connections.enabled.codex = true;
  assert.equal(f.connections.exitStatus().canDirectExit, false);
  f.connections.enabled.codex = false;
  f.connections.error = "unresolved state";
  assert.equal(f.connections.exitStatus().canDirectExit, false);
});
test("connection enable and disable restart only with explicit per-operation opt-in", async (t) => {
  const r = fakeRestarter(), f = connectionFixture(t, { restarter: r });
  const first = await f.connections.preview("codex", true);
  await f.connections.apply({ ticket: first.ticket, mode: "safe", acknowledged: true }); assert.deepEqual(r.calls, []);
  const off = await f.connections.preview("codex", false);
  await f.connections.apply({ ticket: off.ticket, mode: "safe", acknowledged: true, restart: true }); assert.deepEqual(r.calls, ["validate", "stop", "launch"]);
  r.calls = []; const on = await f.connections.preview("codex", true);
  await f.connections.apply({ ticket: on.ticket, mode: "safe", acknowledged: true, restart: true }); assert.deepEqual(r.calls, ["validate", "stop", "launch"]);
});
test("DSH native sync reports the browser catalog refresh boundary", async (t) => {
  const nativeConfig = {
    isDirect: (id) => id === "dsh",
    list: () => [],
    preflight() {},
    fingerprint: () => "native-dsh",
    sync() {},
    status: (id, enabled) => id === "dsh" ? {
      mode: "native",
      modelCount: 15,
      applied: enabled,
      runtimeStatus: enabled ? "client-refresh-required" : "inactive",
    } : {},
  };
  const f = connectionFixture(t, { nativeConfig });
  const plan = await f.connections.preview("dsh", true);
  const result = await f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true });
  assert.match(result.message, /已打开页面需刷新/);
  assert.equal(f.connections.snapshot().clients.dsh.runtimeStatus, "client-refresh-required");
  assert.equal(f.connections.snapshot().clients.dsh.modelCount, 15);
});
test("restart rejects unsupported selection and changed processes before configuration writes", async (t) => {
  const f = connectionFixture(t); const p = await f.connections.preview("codex", true);
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true, restart: true }), /重启目标/);
  assert.equal(f.config.attachCalls, 0);
  const r = fakeRestarter(); r.validate = async () => { throw Error("process changed"); };
  const g = connectionFixture(t, { restarter: r }), q = await g.connections.preview("codex", true);
  await assert.rejects(g.connections.apply({ ticket: q.ticket, mode: "safe", acknowledged: true, restart: true }), /changed/);
  assert.equal(g.config.attachCalls, 0); assert.equal(g.router.starts, 0);
});
test("restart failure reports applied configuration separately; default choice never interrupts requests", async (t) => {
  const r = fakeRestarter(); r.launch = async () => { throw Error("failed"); };
  const f = connectionFixture(t, { restarter: r }), p = await f.connections.preview("codex", true);
  const result = await f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true, restart: true });
  assert.equal(result.restart.ok, false); assert.equal(f.connections.enabled.codex, true); assert.match(result.message, /配置已更新.*重启未完成/);
  f.router.active.codex = 1; const q = await f.connections.preview("codex", false);
  await assert.rejects(f.connections.apply({ ticket: q.ticket, mode: "safe", acknowledged: true }), /请求正在进行/);
});

test("Codex force enable/sync/disable stops before writing and cancels only its requests", async (t) => {
  for (const [initial, enabled] of [[false, true], [true, true], [true, false]]) {
    const order = [], r = fakeRestarter(), f = connectionFixture(t, { restarter: r });
    f.connections.enabled.codex = initial; f.connections.enabled.claude = true;
    f.router.active.codex = 2; f.router.active.claude = 3;
    r.stop = async () => { order.push("stop"); assert.equal(f.connections.allow("codex"), false); };
    f.router.cancelClient = async (id) => { order.push("cancel:" + id); f.router.active[id] = 0; };
    f.config.attach = () => { order.push("write"); };
    f.config.detach = () => { order.push("write"); };
    r.launch = async (_plan, ready) => {
      assert.equal(JSON.parse(fs.readFileSync(f.connections.file)).codex, enabled);
      ready(); order.push("launch"); assert.equal(f.connections.allow("codex"), enabled); return { ok: true };
    };
    const p = await f.connections.preview("codex", enabled);
    const result = await f.connections.apply({ ticket: p.ticket, mode: enabled ? "safe" : "terminate", acknowledged: true, restart: true });
    assert.equal(result.restart.ok, true);
    assert.deepEqual(order, ["stop", "cancel:codex", "write", "launch"]);
    assert.equal(f.router.active.claude, 3); assert.equal(f.router.stops, 0);
    assert.deepEqual(f.processes.stopCalls, []);
  }
});

test("last-client force disable refuses unrelated diagnostics before stopping Codex", async (t) => {
  const r = fakeRestarter(), f = connectionFixture(t, { restarter: r, extraActive: () => 1 });
  f.connections.enabled.codex = true; f.router.active.codex = 2;
  const p = await f.connections.preview("codex", false);
  await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: "terminate", acknowledged: true, restart: true }), /其他客户端或连接诊断/);
  assert.deepEqual(r.calls, ["validate"]); assert.equal(f.config.detachCalls, 0); assert.deepEqual(f.router.canceled, []);
});

test("failed stop writes nothing; concurrent config edits after stop never get overwritten or relaunched", async (t) => {
  for (const fail of ["stop", "config", "concurrent"]) {
    const r = fakeRestarter(), f = connectionFixture(t, { restarter: r });
    if (fail === "stop") r.stop = async () => { throw Error("stop failed"); };
    if (fail === "config") f.config.attach = () => { throw Error("write failed"); };
    if (fail === "concurrent") r.stop = async () => { fs.writeFileSync(f.config.file, "# user changed config\n"); };
    const p = await f.connections.preview("codex", true);
    await assert.rejects(f.connections.apply({ ticket: p.ticket, mode: "safe", acknowledged: true, restart: true }), fail === "stop" ? /stop failed/ : /Codex 已关闭.*未完成/);
    assert.equal(r.calls.includes("launch"), false); assert.equal(f.config.attachCalls, 0);
    assert.equal(f.connections.busy, false); assert.equal(f.connections.enabled.codex, false);
  }
});

test("preview is read-only and tickets are one-use, missing, and expiry checked", async (t) => {
  const f = connectionFixture(t);
  const before = { enabled: { ...f.connections.enabled }, revision: f.connections.revision, starts: f.router.starts, stops: f.router.stops };
  const plan = await f.connections.preview("pi", true);
  assert.deepEqual({ enabled: f.connections.enabled, revision: f.connections.revision, starts: f.router.starts, stops: f.router.stops }, before);
  await f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true });
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true }), /过期/);
  await assert.rejects(f.connections.apply({ ticket: "missing", mode: "safe", acknowledged: true }), /过期/);
  const expired = await f.connections.preview("claude", true);
  f.connections.tickets.get(expired.ticket).expires = 0;
  await assert.rejects(f.connections.apply({ ticket: expired.ticket, mode: "safe", acknowledged: true }), /过期/);
});

test("apply requires explicit acknowledgement and enabling can never terminate", async (t) => {
  const f = connectionFixture(t), plan = await f.connections.preview("pi", true);
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe" }), /确认/);
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "terminate", acknowledged: true }), /不允许终止/);
  assert.equal(f.router.starts, 0);
});

test("safe off blocks active requests, running sessions, and unverifiable identities", async (t) => {
  for (const setup of [
    (f) => { f.router.active.pi = 1; },
    (f) => { f.processes.sessions = [{ id: "p", harness: "pi", status: "running" }]; },
    (f) => { f.processes.sessions = [{ id: "p", harness: "pi", status: "unverifiable" }]; },
  ]) {
    const f = connectionFixture(t); f.connections.enabled.pi = true; setup(f);
    const plan = await f.connections.preview("pi", false);
    await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true }), /请求正在进行|仍有 ASS|身份无法确认/);
    assert.equal(f.connections.enabled.pi, true);
    assert.equal(f.injections.restored.length, 0);
  }
});

test("terminate stops only selected scope and rechecks files before cleanup", async (t) => {
  const f = connectionFixture(t);
  f.connections.enabled.pi = f.connections.enabled.claude = true;
  f.processes.sessions = [
    { id: "pi-1", harness: "pi", status: "running" },
    { id: "claude-1", harness: "claude", status: "running" },
  ];
  const plan = await f.connections.preview("pi", false);
  await f.connections.apply({ ticket: plan.ticket, mode: "terminate", acknowledged: true });
  assert.deepEqual(f.processes.stopCalls, [["pi-1"]]);
  assert.deepEqual(f.injections.preflightCalls, [["pi"], ["pi"], ["pi"]]);
  assert.equal(f.connections.enabled.pi, false);
  assert.equal(f.connections.enabled.claude, true);
  assert.equal(f.router.stops, 0);
});

test("external file edits discovered after termination block restore", async (t) => {
  const f = connectionFixture(t); f.connections.enabled.pi = true;
  f.processes.sessions = [{ id: "pi-1", harness: "pi", status: "running" }];
  let calls = 0;
  f.injections.preflight = () => { if (++calls === 3) throw Error("注入文件已被外部修改"); };
  const plan = await f.connections.preview("pi", false);
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "terminate", acknowledged: true }), /外部修改/);
  assert.deepEqual(f.processes.stopCalls, [["pi-1"]]);
  assert.equal(f.injections.restored.length, 0);
  assert.equal(f.connections.enabled.pi, true);
});

test("stale config ticket is rejected and launch cannot overlap a transition", async (t) => {
  const f = connectionFixture(t), plan = await f.connections.preview("codex", true);
  fs.writeFileSync(f.config.file, "# concurrent user edit\n");
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true }), /已变化/);
  f.connections.busy = true;
  await assert.rejects(f.connections.launch(async () => "never"), /切换/);
});

test("last disconnect stops shared router; retained clients leave it running", async (t) => {
  const retained = connectionFixture(t); retained.connections.enabled.pi = retained.connections.enabled.claude = true;
  let plan = await retained.connections.preview("pi", false);
  assert.deepEqual(plan.retained, ["Claude Code"]);
  await retained.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true });
  assert.equal(retained.router.stops, 0);
  const last = connectionFixture(t); last.connections.enabled.pi = true;
  plan = await last.connections.preview("pi", false);
  assert.equal(plan.stopService, true);
  await last.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true });
  assert.equal(last.router.stops, 1);
});

test("process inspection errors never become silent success; all/quit validates scope", async (t) => {
  const f = connectionFixture(t); f.connections.enabled.pi = true; f.processes.error = "inventory unavailable";
  const plan = await f.connections.preview("all", false, true);
  assert.equal(plan.quit, true); assert.equal(plan.processError, "inventory unavailable");
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true }), /进程身份检查失败/);
  await assert.rejects(f.connections.preview("pi", false, true), /无效/);
  await assert.rejects(f.connections.preview("all", true), /无效/);
});

function accountDir(root, harness = "pi", id = "0123456789abcdef01234567") {
  const dir = path.join(root, "clients", harness, id); fs.mkdirSync(dir, { recursive: true }); return dir;
}

test("InjectionFiles restores originals and deletes only owned generated files", (t) => {
  const root = temp(t), dir = accountDir(root), auth = path.join(dir, "auth.json"), model = path.join(dir, "models.json");
  fs.writeFileSync(auth, '{"session":"keep"}'); fs.writeFileSync(model, '{"user":true}');
  const injections = new InjectionFiles(root);
  injections.write("pi", { dir, files: [["models.json", '{"ass":1}'], ["catalog.json", '{"owned":1}']] });
  injections.restore(["pi"]);
  assert.equal(fs.readFileSync(model, "utf8"), '{"user":true}');
  assert.equal(fs.readFileSync(auth, "utf8"), '{"session":"keep"}');
  assert.equal(fs.existsSync(path.join(dir, "catalog.json")), false);
});

test("multiple injection writes retain the first baseline", (t) => {
  const root = temp(t), dir = accountDir(root), file = path.join(dir, "models.json");
  fs.writeFileSync(file, "original");
  const injections = new InjectionFiles(root);
  injections.write("pi", { dir, files: [["models.json", "first"]] });
  injections.write("pi", { dir, files: [["models.json", "second"]] });
  assert.equal(injections.entries[0].before, "original");
  injections.restore(["pi"]);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("malformed journals, traversal paths, and linked account trees fail closed", (t) => {
  const malformed = temp(t); fs.writeFileSync(path.join(malformed, "route-injections.json"), "{broken");
  const bad = new InjectionFiles(malformed);
  assert.ok(bad.error); assert.throws(() => bad.write("pi", { dir: accountDir(malformed), files: [["models.json", "x"]] }), /损坏/);
  const root = temp(t), injections = new InjectionFiles(root);
  assert.throws(() => injections.target("clients/pi/../../models.json", "pi"), /不在/);
  const outside = temp(t), clients = path.join(root, "clients"); fs.mkdirSync(clients);
  fs.symlinkSync(outside, path.join(clients, "pi"), "junction");
  assert.throws(() => injections.target("clients/pi/0123456789abcdef01234567/models.json", "pi"), /链接/);
});

test("external editing blocks restore and leaves both file and journal intact", (t) => {
  const root = temp(t), dir = accountDir(root), file = path.join(dir, "models.json"), injections = new InjectionFiles(root);
  injections.write("pi", { dir, files: [["models.json", "managed"]] });
  fs.writeFileSync(file, "user edit");
  assert.throws(() => injections.restore(["pi"]), /外部修改/);
  assert.equal(fs.readFileSync(file, "utf8"), "user edit");
  assert.equal(injections.entries.length, 1);
});

test("restore rechecks each target immediately before mutation and retains conflicted ledger entry", (t) => {
  const root = temp(t), dir = accountDir(root);
  const first = path.join(dir, "models.json"), second = path.join(dir, "catalog.json");
  fs.writeFileSync(first, "first original");
  fs.writeFileSync(second, "second original");
  const injections = new InjectionFiles(root);
  injections.write("pi", { dir, files: [["models.json", "first managed"], ["catalog.json", "second managed"]] });

  const renameSync = fs.renameSync;
  t.after(() => { fs.renameSync = renameSync; });
  let edited = false;
  fs.renameSync = function interceptedRename(oldPath, newPath) {
    const result = renameSync.call(fs, oldPath, newPath);
    if (!edited && path.resolve(newPath) === path.resolve(first)) {
      edited = true;
      fs.writeFileSync(second, "second external edit");
    }
    return result;
  };

  assert.throws(() => injections.restore(["pi"]), /恢复期间注入文件被修改/);
  assert.equal(edited, true);
  assert.equal(fs.readFileSync(first, "utf8"), "first original");
  assert.equal(fs.readFileSync(second, "utf8"), "second external edit");
  assert.deepEqual(injections.entries.map((entry) => entry.relative), [
    "clients/pi/0123456789abcdef01234567/catalog.json",
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(injections.file, "utf8")).map((entry) => entry.relative), [
    "clients/pi/0123456789abcdef01234567/catalog.json",
  ]);
});

test("unmanaged historical injection is untouched and explicit writes restore its exact original", (t) => {
  const root = temp(t), dir = accountDir(root), file = path.join(dir, "models.json");
  const original = JSON.stringify({ providers: { ass: { baseUrl: "http://127.0.0.1:25819/harness/deep/v1", apiKey: "$ASS_LOCAL_TOKEN" } } });
  fs.writeFileSync(file, original);
  const injections = new InjectionFiles(root);
  assert.equal(injections.entries.length, 0);
  assert.equal(injections.restore(["pi"]), 0);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(injections.file), false);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
  injections.write("pi", { dir, files: [["models.json", '{"managed":true}']] });
  assert.equal(injections.entries[0].before, original);
  assert.equal(JSON.parse(fs.readFileSync(injections.file, "utf8"))[0].before, original);
  const restarted = new InjectionFiles(root);
  assert.equal(restarted.restore(["pi"]), 1);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});

const providers = parseImport({ providers: [{ id: "deep", name: "Deep", baseUrl: "https://example.test", apiKey: "upstream-key", models: [{ model: "chat", wireApi: "openai-chat" }] }] });
function request(port, url, options = {}) {
  return fetch(`http://127.0.0.1:${port}${url}`, options);
}

test("scoped routeConfig paths isolate pi from disabled dsh", async (t) => {
  const allowed = new Set(["pi"]), calls = [];
  const router = new Router({ getState: () => ({ providers }), allowClient: (id) => allowed.has(id), fetchUpstream: async (url) => { calls.push(url); return new Response('{"ok":true}'); } });
  await router.start(0); router.port = router.server.address().port; t.after(() => router.stop());
  const p = providers[0], pi = routeConfig("pi", p, p.models[0], "C:\\fake", router.clientToken, {}, router.port);
  const piBase = JSON.parse(pi.files[0][1]).providers.ass.baseUrl;
  assert.match(piBase, new RegExp(`/clients/pi/harness/deep/v1$`));
  const body = JSON.stringify({ model: "chat", messages: [] });
  let response = await fetch(piBase + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${router.clientToken}`, "content-type": "application/json" }, body });
  assert.equal(response.status, 200); assert.equal(calls.length, 1);
  response = await request(router.port, "/clients/dsh/harness/deep/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${router.clientToken}`, "content-type": "application/json" }, body });
  assert.equal(response.status, 503); assert.equal(calls.length, 1);
});

test("request is counted at admission while body uploads; disable gate refuses the next request without cancelling current", async (t) => {
  let enabled = true, releaseUpstream;
  const router = new Router({ getState: () => ({ providers }), allowClient: (id) => id === "pi" && enabled, fetchUpstream: () => new Promise((resolve) => { releaseUpstream = () => resolve(new Response('{"ok":true}')); }) });
  await router.start(0); router.port = router.server.address().port; t.after(() => router.stop());
  let firstError, first;
  const firstDone = new Promise((resolve) => {
    first = http.request({ host: "127.0.0.1", port: router.port, path: "/clients/pi/harness/deep/v1/chat/completions", method: "POST", headers: { authorization: `Bearer ${router.clientToken}`, "content-type": "application/json" } });
    first.on("error", (error) => { firstError = error; resolve(); });
    first.on("response", (res) => { res.resume(); res.on("end", resolve); });
    first.write('{"model":"chat","messages":[');
  });
  for (let tries = 0; router.clientActive("pi") === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(router.clientActive("pi"), 1);
  enabled = false;
  const blocked = await request(router.port, "/clients/pi/harness/deep/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${router.clientToken}`, "content-type": "application/json" }, body: '{"model":"chat"}' });
  assert.equal(blocked.status, 503); assert.equal(router.clientActive("pi"), 1);
  first.end(']}');
  while (!releaseUpstream) await new Promise((resolve) => setImmediate(resolve));
  releaseUpstream(); await firstDone; assert.equal(firstError, undefined);
});

test("diagnostics routes require the private local probe token", async (t) => {
  const router = new Router({ getState: () => ({ providers }), allowClient: () => true, fetchUpstream: async () => new Response('{"ok":true}') });
  await router.start(0); router.port = router.server.address().port; t.after(() => router.stop());
  const body = JSON.stringify({ model: "chat", messages: [] }), headers = { authorization: `Bearer ${router.clientToken}`, "content-type": "application/json" };
  assert.equal((await request(router.port, "/diagnostics/harness/deep/v1/chat/completions", { method: "POST", headers, body })).status, 401);
  assert.equal((await request(router.port, "/diagnostics/harness/deep/v1/chat/completions", { method: "POST", headers: { ...headers, "x-ass-probe-token": router.clientToken }, body })).status, 200);
});

test("cancelClient drains Codex uploads and upstreams without touching other clients or diagnostics", async (t) => {
  const pending = new Map();
  const router = new Router({ getState: () => ({ providers: [] }), fetchUpstream: (_url, options) => new Promise((resolve, reject) => {
    pending.set(JSON.parse(options.body).model, { signal: options.signal, resolve });
    options.signal.addEventListener("abort", () => reject(Error("canceled")), { once: true });
  }) });
  await router.start(0); t.after(() => router.stop());
  const headers = { authorization: "Bearer synthetic-local-test", "content-type": "application/json", "x-ass-probe-token": router.clientToken };
  const send = (client) => request(router.port, client === "diagnostics" ? "/diagnostics/v1/responses" : `/clients/${client === "codex" ? "ASS" : client}/v1/responses`, {
    method: "POST", headers, body: JSON.stringify({ model: client, stream: false }),
  }).catch((e) => e);
  const codex = send("codex"), claude = send("claude"), diagnostics = send("diagnostics");
  let upload;
  const uploadDone = new Promise((resolve) => {
    upload = http.request({ hostname: "127.0.0.1", port: router.port, path: "/clients/ASS/v1/responses", method: "POST", headers });
    upload.on("error", resolve); upload.write('{"model":"unfinished');
  });
  t.after(() => upload.destroy());
  for (let i = 0; i < 200 && (pending.size !== 3 || router.clientActive("codex") !== 2); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pending.size, 3); assert.equal(router.clientActive("codex"), 2);
  await router.cancelClient("codex");
  assert.ok(await codex instanceof Error); assert.ok(await uploadDone instanceof Error);
  assert.equal(router.clientActive("codex"), 0);
  assert.equal(router.clientActive("claude"), 1); assert.equal(router.clientActive("diagnostics"), 1);
  assert.equal(pending.get("claude").signal.aborted, false); assert.equal(pending.get("diagnostics").signal.aborted, false);
  for (const id of ["claude", "diagnostics"]) pending.get(id).resolve(Response.json({ ok: true }));
  assert.deepEqual(await (await claude).json(), { ok: true }); assert.deepEqual(await (await diagnostics).json(), { ok: true });
  await assert.rejects(router.cancelClient(), /无效/);
});

test("ConfigManager detach rejects changed managed blocks but preserves later user edits", (t) => {
  const root = temp(t), codex = path.join(root, "codex"), data = path.join(root, "data"); fs.mkdirSync(codex);
  const file = path.join(codex, "config.toml"); fs.writeFileSync(file, 'model = "user"\n[features]\nfoo = true\n');
  const config = new ConfigManager(codex, data, 32123); config.attach();
  let attached = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, attached.replace('name = "ASS"', 'name = "tampered"'));
  assert.throws(() => config.preflightDetach(), /管理区段已被外部修改/);
  fs.writeFileSync(file, attached.replace("foo = true", "foo = false"));
  config.detach();
  const final = fs.readFileSync(file, "utf8");
  assert.match(final, /foo = false/); assert.match(final, /model = "user"/); assert.doesNotMatch(final, /ass managed|32123/);
});
