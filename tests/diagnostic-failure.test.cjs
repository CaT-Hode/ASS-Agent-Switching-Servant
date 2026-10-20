const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { classifyFailure, responseFailure } = require('../core/diagnostic-failure.cjs');
const { inspectConnectionResponse } = require('../core/connection-diagnostic.cjs');
const { diagnosticMetrics } = require('../core/diagnostic-metrics.cjs');
const { Router } = require('../core/router.cjs');
const { codexModelId } = require('../core/models.cjs');
const { DiagnosticHistory } = require('../core/diagnostic-history.cjs');
const { DiagnosticBatch } = require('../core/diagnostic-batch.cjs');
const { checkNativeConnection } = require('../core/native-model-diagnostics.cjs');
const { modelKey } = require('../core/model-inspection.cjs');
const synthetic = 'fixture-reflected-credential';
const json = (status, code, message = synthetic) => Response.json({ error: { code, message } }, { status });
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

test('transport failures classify Electron/Node nested causes without inventing an HTTP response', () => {
  for (const [error, kind, code] of [
    [Error('net::ERR_NAME_NOT_RESOLVED at private-url'), 'dns', 'ERR_NAME_NOT_RESOLVED'],
    [Object.assign(Error('lookup failed'), { code: 'EAI_AGAIN' }), 'dns', 'EAI_AGAIN'],
    [Error('fetch failed', { cause: Object.assign(Error(synthetic), { code: 'ENOTFOUND' }) }), 'dns', 'ENOTFOUND'],
    [Error('net::ERR_CERT_AUTHORITY_INVALID'), 'tls', 'ERR_CERT_AUTHORITY_INVALID'],
    [Error('fetch failed', { cause: Object.assign(Error(synthetic), { code: 'CERT_HAS_EXPIRED' }) }), 'tls', 'CERT_HAS_EXPIRED'],
    [Object.assign(Error('timeout'), { name: 'TimeoutError' }), 'timeout', undefined],
    [Object.assign(Error(synthetic), { code: 'ECONNREFUSED' }), 'network', 'ECONNREFUSED'],
  ]) {
    const r = classifyFailure(error);
    assert.equal(r.failure.kind, kind); assert.equal(r.failure.code, code);
    assert.equal(r.httpStatus, null); assert.doesNotMatch(JSON.stringify(r), /private-url|fixture-reflected/);
  }
});

test('upstream errors separate authentication, quota, throttling, permissions and HTML gateways', async () => {
  for (const [response, kind] of [
    [json(401, 'invalid_api_key'), 'authentication'],
    [json(401, 'invalid_api_key', 'Key invalid; check if balance is insufficient'), 'authentication'],
    [json(429, 'insufficient_quota'), 'quota'],
    [json(403, 'insufficient_balance'), 'quota'],
    [json(402, 'balance_error', '余额不足'), 'quota'],
    [json(400, 'billing_hard_limit_reached'), 'quota'],
    [json(429, 'rate_limit_exceeded'), 'rate_limit'],
    [json(429, 'unknown'), 'rate_limit'],
    [json(402, 'unknown'), 'payment'],
    [json(403, 'unknown'), 'permission'],
    [new Response('<html><title>Cloudflare</title>invalid_api_key insufficient_quota</html>', { status: 403, headers: { 'content-type': 'text/html' } }), 'gateway'],
    [json(502, 'unknown'), 'server'],
    [json(504, 'unknown'), 'timeout'],
    [json(400, 'model_not_found'), 'request'],
  ]) {
    const r = await responseFailure(response);
    assert.equal(r.failure.kind, kind); assert.equal(r.httpStatus, response.status);
    assert.equal(r.failure.layer, 'upstream');
    assert.doesNotMatch(JSON.stringify(r), /fixture-reflected|Cloudflare/);
  }
});

test('bounded provider error reading cancels streams, ignores forged local metadata and arbitrary codes', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(16384))); }, cancel() { cancelled = true; } }), { status: 502 });
  assert.equal((await responseFailure(response)).failure.kind, 'server'); assert.equal(cancelled, true);
  const fake = Response.json({ diagnostic: { failure: { kind: 'quota', layer: 'upstream' }, httpStatus: 429 }, error: { code: synthetic } }, { status: 502, headers: { 'x-ass-diagnostic-error': '1' } });
  const result = await responseFailure(fake);
  assert.equal(result.failure.kind, 'server'); assert.equal(result.failure.code, undefined);
  const old = await responseFailure(json(502, 'unknown'), { relay: true });
  assert.equal(old.failure.kind, 'local'); assert.equal(old.httpStatus, null); assert.equal(old.localStatus, 502);
});

async function routerFixture(t, fetchUpstream) {
  const provider = { id: 'fixture', name: 'Fixture', enabled: true, apiKey: synthetic, baseUrl: 'https://unit.invalid/v1', network: 'direct',
    models: [{ model: 'alpha', enabled: true, wireApi: 'openai-responses' }] };
  const logs = [], router = new Router({ getState: () => ({ providers: [provider] }), fetchUpstream, log: e => logs.push(e) });
  await router.start(0); t.after(() => router.stop());
  const request = (diagnostic = true) => fetch(`http://127.0.0.1:${router.port}/${diagnostic ? 'diagnostics' : 'clients/ASS'}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer fixture-local', 'content-type': 'application/json', ...(diagnostic ? { 'x-ass-probe-token': router.clientToken } : {}) },
    body: JSON.stringify({ model: codexModelId('fixture', 'alpha'), input: [], stream: true }),
  });
  return { router, request, logs, provider };
}

test('private loopback diagnostics retain DNS, 401 and quota evidence through the actual router', async t => {
  for (const [fetchUpstream, kind, httpStatus, localStatus] of [
    [async () => { throw Error('net::ERR_NAME_NOT_RESOLVED'); }, 'dns', null, 502],
    [async () => json(401, 'invalid_api_key'), 'authentication', 401, 401],
    [async () => json(429, 'insufficient_quota'), 'quota', 429, 429],
    [async () => json(429, 'rate_limit_error'), 'rate_limit', 429, 429],
    [async () => new Response('<html>Forbidden</html>', { status: 403 }), 'gateway', 403, 403],
  ]) {
    const f = await routerFixture(t, fetchUpstream), metrics = diagnosticMetrics('openai-responses', 'router');
    const response = await f.request();
    await assert.rejects(inspectConnectionResponse(response, 'openai-responses', metrics, { relay: true }), error => {
      const result = { ...metrics.finish(false), ...error.diagnostic };
      assert.equal(result.failure.kind, kind); assert.equal(result.httpStatus, httpStatus);
      assert.equal(result.localStatus, localStatus); assert.doesNotMatch(JSON.stringify(result), /fixture-reflected/);
      return true;
    });
    assert.equal(f.logs.at(-1).diagnostic.failure.kind, kind);
  }
});

test('native and translated streams retain explicit quota errors even with HTTP 200', async t => {
  const events = [{ type: 'error', error: { type: 'insufficient_quota', message: synthetic } }];
  const context = { request: { url: 'https://unit.invalid', protocol: 'anthropic', body: {}, headers: {} } };
  await assert.rejects(checkNativeConnection(context, async () => sse(events)), error => error.diagnostic.failure.kind === 'quota' && error.diagnostic.httpStatus === 200);
  const f = await routerFixture(t, async () => sse(events));
  f.provider.models[0].wireApi = 'anthropic';
  await assert.rejects(inspectConnectionResponse(await f.request(), 'openai-responses', diagnosticMetrics('anthropic', 'router'), { relay: true }), error => {
    assert.equal(error.diagnostic.failure.kind, 'quota'); assert.equal(error.diagnostic.httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /fixture-reflected/); return true;
  });
});

test('official SSE quota errors and successful responses keep real HTTP status and timing', async t => {
  let fail = true;
  const f = await routerFixture(t, async () => fail ? sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: synthetic } } }]) :
    sse([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed' }]));
  const request = () => fetch(`http://127.0.0.1:${f.router.port}/diagnostics/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer fixture-oauth', 'x-ass-probe-token': f.router.clientToken, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'official-test', input: [] }) });
  await assert.rejects(inspectConnectionResponse(await request(), 'openai-responses', null, { relay: true }), error => error.diagnostic.failure.kind === 'quota' && error.diagnostic.httpStatus === 200);
  fail = false; const metrics = diagnosticMetrics('openai-responses', 'router');
  await inspectConnectionResponse(await request(), 'openai-responses', metrics, { relay: true });
  const r = metrics.finish(true); assert.equal(r.phase, 'complete'); assert.equal(r.httpStatus, 200); assert.equal(r.localStatus, 200); assert.ok(r.firstTextMs >= 0);
});

test('diagnosing a failing model neither cancels an ongoing request nor changes normal upstream error passthrough', async t => {
  let fail = false, finish, liveSignal;
  const f = await routerFixture(t, async (url, init) => {
    if (fail) throw Error('net::ERR_NAME_NOT_RESOLVED');
    liveSignal = init.signal;
    return new Response(new ReadableStream({ start(c) { finish = () => { c.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); c.close(); }; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const live = await f.request(false); fail = true;
  await assert.rejects(inspectConnectionResponse(await f.request(), 'openai-responses', null, { relay: true }), error => error.diagnostic.failure.kind === 'dns');
  assert.equal(liveSignal.aborted, false); assert.equal(f.router.active, 1);
  finish(); assert.match(await live.text(), /response.completed/);
  const officialBody = '<html>original upstream forbidden</html>';
  f.router.fetch = async () => new Response(officialBody, { status: 403, headers: { 'content-type': 'text/html' } });
  const official = await fetch(`http://127.0.0.1:${f.router.port}/clients/ASS/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer fixture-oauth', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'official-test', input: [] }) });
  assert.equal(official.status, 403); assert.equal(await official.text(), officialBody);
  assert.equal(official.headers.get('x-ass-diagnostic-error'), null);
});

test('single and batch classifications survive encrypted history reload without raw provider content', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-failure-history-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const crypto = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const options = { dataDir, crypto, getContext: () => ({ provider: { id: 'p', apiKey: synthetic }, model: { model: 'alpha' } }) };
  const history = new DiagnosticHistory(options);
  const result = { providerId: 'p', model: 'alpha', ok: false, time: new Date().toISOString(), ms: 123,
    ...classifyFailure(Error('net::ERR_NAME_NOT_RESOLVED'), { localStatus: 502 }), raw: synthetic };
  assert.equal(history.record(result, history.fingerprint('p', 'alpha')), true);
  const batch = new DiagnosticBatch({ targets: () => [{ providerId: 'p', model: 'alpha', key: modelKey('p', 'alpha') }], run: async () => result });
  batch.start(); await batch.finished; history.recordBatch(batch.snapshot());
  const restored = new DiagnosticHistory(options);
  assert.equal(restored.public()[modelKey('p', 'alpha')].failure.kind, 'dns');
  assert.equal(restored.public()[modelKey('p', 'alpha')].httpStatus, null);
  assert.equal(restored.batch.entries[0].failure.code, 'ERR_NAME_NOT_RESOLVED');
  assert.equal(restored.batch.entries[0].localStatus, 502);
  assert.doesNotMatch(JSON.stringify(restored.public()) + fs.readFileSync(history.file, 'utf8'), /fixture-reflected/);
  assert.equal(restored.public()[modelKey('p', 'alpha')].raw, undefined);
});
