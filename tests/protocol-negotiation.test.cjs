const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { ProtocolNegotiation } = require("../core/protocol-negotiation.cjs");
const { nativeProbe } = require("../core/model-inspection.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const { Store } = require("../core/store.cjs");
const { ConfigManager } = require("../core/config.cjs");
const { compose } = require("../core/native-config.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const sse = events => new Response(events.map(e => "data: " + JSON.stringify(e) + "\n\n").join(""));
function success(protocol) {
  return protocol === "anthropic" ? sse([{ type: "content_block_delta", delta: { type: "text_delta", text: "437" } }, { type: "message_stop" }])
    : protocol === "openai-chat" ? sse([{ choices: [{ delta: { content: "437" }, finish_reason: "stop" }] }])
    : sse([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "437" }] }] } }]);
}
function fixture(t, fetcher) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-protocol-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir, path.join(dataDir, "codex"), crypt);
  store.updateProvider({ id: "test", baseUrl: "https://example.test/v1", apiKey: "synthetic-private", models: [{ model: "alpha", wireApi: "openai-chat" }] });
  const p = store.state.providers[0], m = p.models[0], calls = [];
  const options = { dataDir, crypto: crypt, getProviders: () => store.state.providers,
    fetcher: async (url, init) => { calls.push(url); return fetcher ? fetcher(url, init) : success(url.endsWith("/messages") ? "anthropic" : url.endsWith("/completions") ? "openai-chat" : "openai-responses"); } };
  const protocols = new ProtocolNegotiation(options);
  return { dataDir, store, p, m, options, protocols, calls };
}
test("checks all three protocols, selects per client, persists and avoids duplicate probes", async t => {
  const f = fixture(t);
  await Promise.all([f.protocols.ensure(f.p, f.m), f.protocols.ensure(f.p, f.m)]);
  assert.deepEqual(f.calls.map(u => new URL(u).pathname), ["/v1/responses", "/v1/messages", "/v1/chat/completions"]);
  assert.equal(f.protocols.get(f.p, f.m).protocols["openai-chat"].status, "passed");
  assert.equal(f.protocols.select(f.p, f.m, "claude"), "anthropic");
  for (const id of ["codex", "opencode", "pi", "dsh", "kimi", "zcode"]) assert.equal(f.protocols.select(f.p, f.m, id), "openai-responses");
  const reloaded = new ProtocolNegotiation(f.options);
  await reloaded.ensure(f.p, f.m); assert.equal(f.calls.length, 3);
  assert.equal(reloaded.get(f.p, f.m).protocols["openai-chat"].status, "passed");
  assert.equal(f.m.wireApi, "openai-chat", "initial hint is not permanently rewritten");
  assert.doesNotMatch(JSON.stringify(reloaded.public()), /synthetic-private|fingerprint/);
});
test("Chat is checked independently when either Responses or Messages succeeds", async t => {
  for (const working of ["openai-responses", "anthropic"]) {
    const f = fixture(t, url => {
      const protocol = url.endsWith("/messages") ? "anthropic" : url.endsWith("/completions") ? "openai-chat" : "openai-responses";
      return protocol === working || protocol === "openai-chat" ? success(protocol) : Response.json({}, { status: 405 });
    });
    await f.protocols.ensure(f.p, f.m);
    assert.equal(f.calls.length, 3);
    assert.equal(f.protocols.get(f.p, f.m).protocols["openai-chat"].status, "passed");
    assert.equal(f.protocols.select(f.p, f.m, "codex"), working);
  }
});
test("manual recheck fills legacy Chat evidence and persists explicit endpoint rejection", async t => {
  const f = fixture(t, url => url.endsWith("/completions") ? Response.json({ error: { message: 'This endpoint is not supported' } }, { status: 404 }) : success(url.endsWith("/messages") ? "anthropic" : "openai-responses"));
  f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { "openai-responses": { status: "passed" }, anthropic: { status: "passed" } } });
  await f.protocols.ensure(f.p, f.m);
  assert.equal(f.calls.length, 0, "Old history must not trigger unrequested background probes");
  await f.protocols.ensure(f.p, f.m, { force: true });
  assert.equal(f.calls.length, 3);
  const reloaded = new ProtocolNegotiation(f.options);
  assert.equal(reloaded.get(f.p, f.m).protocols["openai-chat"].status, "unsupported");
  assert.equal(reloaded.get(f.p, f.m).protocols["openai-chat"].httpStatus, 404);
});

test('model-specific 404 errors are unknown observations and cannot erase a previous protocol success', async t => {
  const f = fixture(t);
  f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { anthropic: { status: 'passed' } } });
  for (let i = 0; i < 2; i++) {
    const result = await nativeProbe(f.p, f.m, 'anthropic', async () => Response.json({ error: {
      code: 'model_not_found', message: 'This model is temporarily unavailable in this channel',
    } }, { status: 404 }));
    assert.equal(result.unsupported, false);
    f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { anthropic: result, 'openai-responses': result } });
    const saved = new ProtocolNegotiation(f.options).get(f.p, f.m);
    assert.equal(saved.protocols.anthropic.status, 'passed');
    assert.equal(saved.protocols.anthropic.lastStatus, 'unknown');
    assert.equal(saved.protocols['openai-responses'].status, 'unknown');
    assert.equal(saved.protocols['openai-responses'].httpStatus, 404);
  }
});

test('legacy unsupported 404 cache is corrected without file writes or background requests, and can be rechecked', async t => {
  const f = fixture(t);
  f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { anthropic: { status: 'passed' } } });
  const row = f.protocols.get(f.p, f.m);
  row.protocols = {
    anthropic: { status: 'unsupported', lastStatus: 'unsupported', httpStatus: 404, time: row.time },
    'openai-responses': { status: 'unsupported', httpStatus: 404, lastSuccess: row.time },
    'openai-chat': { status: 'unsupported', httpStatus: 405 },
  };
  fs.writeFileSync(f.protocols.file, JSON.stringify({ version: 1, encrypted: crypt.encryptString(JSON.stringify(f.protocols.records)).toString('base64') }));
  const before = fs.readFileSync(f.protocols.file);
  for (let i = 0; i < 2; i++) {
    const reloaded = new ProtocolNegotiation(f.options), r = reloaded.get(f.p, f.m);
    assert.equal(r.protocols.anthropic.status, 'unknown');
    assert.equal(r.protocols.anthropic.httpStatus, 404);
    assert.equal(r.protocols['openai-responses'].status, 'passed');
    assert.equal(r.protocols['openai-chat'].status, 'unsupported');
    await reloaded.ensure(f.p, f.m);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readFileSync(f.protocols.file), before);
  }
  const fresh = new ProtocolNegotiation(f.options);
  await fresh.ensure(f.p, f.m, { force: true });
  assert.equal(f.calls.length, 3);
  assert.equal(new ProtocolNegotiation(f.options).get(f.p, f.m).protocols.anthropic.status, 'passed');
});
test("later protocol rate limits stop the remaining probes", async t => {
  for (const limitAt of ["anthropic", "openai-chat"]) {
    const f = fixture(t, url => {
      const protocol = url.endsWith("/messages") ? "anthropic" : url.endsWith("/completions") ? "openai-chat" : "openai-responses";
      return protocol === limitAt ? Response.json({}, { status: 429 }) : success(protocol);
    });
    await f.protocols.ensure(f.p, f.m, { force: true });
    assert.equal(f.calls.length, limitAt === "anthropic" ? 2 : 3);
    assert.equal(f.protocols.get(f.p, f.m).protocols[limitAt].lastStatus, "unknown");
  }
});
test("Chat is tested when neither native protocol works; 502 does not mean unsupported", async t => {
  const f = fixture(t, (url) => url.endsWith("completions") ? success("openai-chat") : Response.json({}, { status: url.endsWith("responses") ? 502 : 405 }));
  await f.protocols.ensure(f.p, f.m);
  assert.equal(f.calls.length, 3);
  const r = f.protocols.get(f.p, f.m);
  assert.equal(r.protocols["openai-responses"].status, "unknown");
  assert.equal(r.protocols.anthropic.status, "unsupported");
  assert.equal(f.protocols.select(f.p, f.m, "claude"), "openai-chat");
});
test("transient failures retain last success, explicit endpoint rejection invalidates it", async t => {
  const f = fixture(t); await f.protocols.ensure(f.p, f.m);
  f.protocols.fetcher = async () => Response.json({}, { status: 502 });
  await f.protocols.ensure(f.p, f.m, { force: true });
  assert.equal(f.protocols.select(f.p, f.m, "codex"), "openai-responses");
  assert.equal(f.protocols.get(f.p, f.m).protocols["openai-responses"].lastStatus, "unknown");
  f.protocols.fetcher = async url => url.endsWith("messages") ? success("anthropic") : Response.json({}, { status: 405 });
  await f.protocols.ensure(f.p, f.m, { force: true });
  assert.equal(f.protocols.select(f.p, f.m, "codex"), "anthropic");
});
test("identity, endpoint, model, network and header edits invalidate evidence; presentation edits do not", async t => {
  const f = fixture(t); await f.protocols.ensure(f.p, f.m);
  for (const changes of [{ apiKey: "new" }, { baseUrl: "https://other.test/v1" }, { network: "direct" }, { extraHeaders: { tag: "new" } }])
    assert.equal(f.protocols.get({ ...f.p, ...changes }, f.m), null);
  assert.equal(f.protocols.get(f.p, { ...f.m, model: "other" }), null);
  assert.ok(f.protocols.get({ ...f.p, name: "Renamed" }, { ...f.m, displayName: "Renamed", wireApi: "anthropic" }));
});
test("aborted probes and results from replaced credentials never get persisted", async t => {
  const f = fixture(t); const controller = new AbortController();
  f.protocols.fetcher = async () => { controller.abort(); return success("openai-responses"); };
  await assert.rejects(f.protocols.ensure(f.p, f.m, { signal: controller.signal }));
  assert.equal(f.protocols.get(f.p, f.m), null);
  const old = structuredClone(f.p); f.p.apiKey = "changed";
  assert.equal(f.protocols.record(old, f.m, { time: new Date().toISOString(), protocols: { anthropic: { status: "passed" } } }), false);
});
test("even rate-limit/unknown observations persist indefinitely; only manual force retries", async t => {
  const f = fixture(t, () => Response.json({}, { status: 429 }));
  await f.protocols.ensure(f.p, f.m); assert.equal(f.calls.length, 1);
  f.protocols.fetcher = async url => success(url.endsWith("messages") ? "anthropic" : "openai-responses");
  f.protocols.now = () => Date.now() + 365 * 24 * 3600000;
  await f.protocols.ensure(f.p, f.m); assert.equal(f.calls.length, 1);
  const reloaded = new ProtocolNegotiation({ ...f.options, now: f.protocols.now });
  await reloaded.ensure(f.p, f.m); assert.equal(f.calls.length, 1);
  await f.protocols.ensure(f.p, f.m, { force: true }); assert.equal(f.protocols.select(f.p, f.m, "codex"), "openai-responses");
});
test("DeepSeek probe and native injection share its actual Messages endpoint", async t => {
  const f = fixture(t); f.p.baseUrl = "https://api.deepseek.com/v1";
  await nativeProbe(f.p, f.m, "anthropic", async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(init.headers["x-api-key"], f.p.apiKey); return success("anthropic");
  });
});
test("verified protocol updates an applied route without publishing draft models or rewriting its snapshot", async t => {
  const f = fixture(t); await f.protocols.ensure(f.p, f.m);
  const manager = new HarnessManager(f.dataDir, () => f.store.state, [], f.store.codexDir,
    { home: path.join(f.dataDir, "home"), env: {}, protocols: f.protocols });
  const proxy = new ProxyConfig(f.dataDir, crypt, manager, f.store, new ConfigManager(f.store.codexDir, f.dataDir));
  assert.equal(proxy.desired("codex").providers[0].models[0].wireApi, "openai-responses");
  assert.equal(proxy.desired("claude").providers[0].models[0].wireApi, "anthropic");
  proxy.sync("claude");
  f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { anthropic: { status: "rejected", unsupported: true } } });
  const before = fs.readFileSync(proxy.file);
  f.p.models.push({ ...f.m, model: 'unpublished', enabled: true, wireApi: 'openai-chat' });
  assert.equal(proxy.routingState("claude").providers[0].models[0].wireApi, "openai-responses");
  assert.equal(proxy.routingState("claude").providers[0].models.length, 1);
  assert.deepEqual(fs.readFileSync(proxy.file), before);
  assert.equal(proxy.clients.claude.providers[0].models[0].wireApi, 'anthropic');
  assert.equal(proxy.desired("claude").providers[0].models[0].wireApi, "openai-responses");
  const native = compose("pi", manager);
  assert.ok(native.fields.some(f => f.value?.api === "openai-responses"));
});

test('connection checks stop at a completed stream and leave untested protocols unknown', async t => {
  const f = fixture(t);
  await f.protocols.ensure(f.p, f.m, { force: true, untilAvailable: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.protocols.get(f.p, f.m).protocols['openai-responses'].status, 'passed');
  assert.equal(f.protocols.get(f.p, f.m).protocols.anthropic, undefined);
  assert.equal(f.protocols.get(f.p, f.m).protocols['openai-chat'], undefined);
  f.protocols.fetcher = () => { throw Error('unused slow protocol must not be contacted'); };
  f.calls.length = 0;
  await f.protocols.ensure(f.p, f.m);
  assert.equal(f.calls.length, 0);
});

test('quick recheck starts with the working protocol, falls back on failure and prefers newly confirmed evidence', async t => {
  const f = fixture(t);
  f.protocols.record(f.p, f.m, { time: new Date().toISOString(), protocols: { 'openai-chat': { status: 'passed' } } });
  await f.protocols.ensure(f.p, f.m, { force: true, untilAvailable: true });
  assert.deepEqual(f.calls.map(u=>new URL(u).pathname), ['/v1/chat/completions']);
  f.calls.length = 0;
  f.protocols.fetcher = url => { f.calls.push(url); return url.endsWith('completions') ? Response.json({}, { status: 502 }) : success('openai-responses'); };
  await f.protocols.ensure(f.p, f.m, { force: true, untilAvailable: true });
  assert.deepEqual(f.calls.map(u=>new URL(u).pathname), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(f.protocols.select(f.p, f.m, 'codex'), 'openai-responses');
  f.protocols.fetcher = url => url.endsWith('responses') ? Response.json({}, { status: 502 }) : success('anthropic');
  await f.protocols.ensure(f.p, f.m, { force: true, untilAvailable: true });
  assert.equal(f.protocols.get(f.p, f.m).protocols['openai-responses'].status, 'passed', 'retain previous success as history');
  assert.equal(f.protocols.select(f.p, f.m, 'codex'), 'anthropic', 'a current completed stream wins over retained unknown evidence');
});

test('a successful check repairs the actual Codex Gemini route but never crosses changed credentials or headers', async t => {
  const f = fixture(t);
  f.m.model = 'gemini-fixture'; f.m.wireApi = 'anthropic';
  const manager = new HarnessManager(f.dataDir, () => f.store.state, [], f.store.codexDir,
    { home: path.join(f.dataDir, 'home'), env: {}, protocols: f.protocols });
  const proxy = new ProxyConfig(f.dataDir, crypt, manager, f.store, new ConfigManager(f.store.codexDir, f.dataDir));
  proxy.sync('codex');
  const { Router } = require('../core/router.cjs');
  const { codexModelId } = require('../core/models.cjs');
  const calls = [];
  const router = new Router({ getState: () => proxy.routingState('codex'), fetchUpstream: async (url, init) => {
    calls.push({url, headers:init.headers}); return success('openai-responses');
  }, log() {} });
  t.after(()=>router.stop()); await router.start(0);
  const applied = proxy.clients.codex.providers[0];
  assert.equal(applied.models[0].wireApi, 'anthropic');
  await f.protocols.ensure(f.p, f.m, { force: true, untilAvailable: true });
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method:'POST', headers:{authorization:'Bearer synthetic-client', 'content-type':'application/json'},
    body:JSON.stringify({ model:codexModelId(f.p.id,f.m.model), input:'Reply OK', stream:true }),
  });
  assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
  assert.equal(calls[0].url, 'https://example.test/v1/responses');
  assert.equal(calls[0].headers.authorization, 'Bearer '+applied.apiKey);
  assert.equal(applied.models[0].wireApi, 'anthropic');
  for (const edit of [{apiKey:'changed'}, {baseUrl:'https://changed.invalid'}, {extraHeaders:{'x-identity':'changed'}}]) {
    const original = structuredClone(f.p); Object.assign(f.p, edit);
    await f.protocols.ensure(f.p, f.m, { force:true, untilAvailable:true });
    assert.equal(proxy.routingState('codex').providers[0].models[0].wireApi, 'anthropic');
    Object.assign(f.p, original);
  }
});
