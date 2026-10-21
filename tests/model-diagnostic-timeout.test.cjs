const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { nativeProbe, inspectStream, modelKey, PROBE_TIMEOUT_MS, DIAGNOSTIC_TIMEOUT_MS } = require('../core/model-inspection.cjs');
const { inspectConnectionResponse } = require('../core/connection-diagnostic.cjs');
const { classifyFailure } = require('../core/diagnostic-failure.cjs');
const provider = { id: 'synthetic', name: 'Synthetic', enabled: true, apiKey: 'synthetic-only', baseUrl: 'https://provider.invalid',
  models: [{ model: 'slow-fixture', enabled: true, wireApi: 'anthropic', defaultEffort: 'high' }] };
const sse = rows => new Response(rows.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join(''));
const success = protocol => protocol === 'anthropic'
  ? sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '437' } }, { type: 'message_stop' }])
  : sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '437' }] }] } }]);
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
async function advance(t, ms) { t.mock.timers.tick(ms); await flush(); }
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

test('default protocol deadline accepts 55-second completed streams; short overrides, stalls and cancellation stay bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  for (const protocol of ['anthropic', 'openai-responses']) for (let repeat = 0; repeat < 2; repeat++) {
    const result = nativeProbe(provider, provider.models[0], protocol, async (url, init) => {
      await pause(55000, init.signal); return success(protocol);
    });
    await advance(t, 55000);
    const value = await result;
    assert.equal(value.status, 'passed'); assert.equal(value.ms, 55000);
  }
  const short = nativeProbe(provider, provider.models[0], 'anthropic', async (url, init) => {
    await pause(55000, init.signal); return success('anthropic');
  }, { timeoutMs: 20000 });
  await advance(t, 20000); assert.equal((await short).status, 'unknown');
  const stalled = nativeProbe(provider, provider.models[0], 'anthropic', () => new Promise(() => {}));
  await advance(t, PROBE_TIMEOUT_MS); assert.equal((await stalled).status, 'unknown');
  const controller = new AbortController();
  const cancelled = nativeProbe(provider, provider.models[0], 'anthropic', () => new Promise(() => {}), { signal: controller.signal });
  controller.abort(); await flush(); assert.equal((await cancelled).message, '检测已取消');
});

// Run the actual Electron diagnostic function with synthetic dependencies and
// a virtual clock, without launching Electron or reading the native profile.
function diagnosticHarness({ bodyStall = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const code = source.slice(source.indexOf('async function diagnose('), source.indexOf('function invalidateReports('));
  const controllers = new Map(), calls = [], timeouts = [], saved = [];
  const signals = { any: signals => AbortSignal.any(signals), timeout: ms => {
    timeouts.push(ms); const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Diagnostic timeout', 'TimeoutError')), ms);
    return controller.signal;
  } };
  const context = {
    Date, AbortController, AbortSignal: signals, require,
    connections: { busy: false }, nativeDiagnosticContext: () => null,
    store: { state: { providers: [provider] } }, diagnosticControllers: controllers,
    diagnosticMetrics: () => ({ headers() {}, observe() {}, finish: () => ({ ms: 0 }) }),
    diagnosticHistory: { fingerprint: () => 'synthetic', record: result => { saved.push(result); return true; } },
    modelKey, codexModelId: () => 'ASS_fixture::slow-fixture',
    PROBE_TIMEOUT_MS, DIAGNOSTIC_TIMEOUT_MS,
    protocols: { ensure: async (p, m, { signal, untilAvailable }) => { assert.equal(untilAvailable, true); for (let i = 0; i < 3; i++) { calls.push('probe'); await pause(55000, signal); } }, select: () => 'anthropic' },
    router: { server: true, port: 1, clientToken: 'synthetic' }, servicePort: 1,
    fetch: async (url, init) => {
      calls.push('connection');
      if (bodyStall) return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      await pause(70000, init.signal); return success('openai-responses');
    }, inspectStream, inspectConnectionResponse, classifyFailure, push() {},
  };
  const diagnose = vm.runInNewContext(code + '\ndiagnose;', context);
  return { diagnose, calls, timeouts, controllers, saved };
}
test('three slow protocol probes cannot consume the following connection check deadline; repeated checks release their controller', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = diagnosticHarness();
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = f.diagnose(provider.id, 'slow-fixture');
    for (let i = 0; i < 3; i++) await advance(t, 55000);
    await advance(t, 70000);
    const value = await result;
    assert.equal(value.ok, true); assert.equal(value.ms, 235000);
    assert.equal(value.protocolMs, 165000);
    assert.equal(f.controllers.size, 0);
  }
  assert.deepEqual(f.calls, ['probe', 'probe', 'probe', 'connection', 'probe', 'probe', 'probe', 'connection']);
  assert.deepEqual(f.timeouts, [DIAGNOSTIC_TIMEOUT_MS, PROBE_TIMEOUT_MS, DIAGNOSTIC_TIMEOUT_MS, PROBE_TIMEOUT_MS]);
});
test('connection body stalls and user cancellation remain bounded after slow probes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = diagnosticHarness({ bodyStall: true });
  const stalled = f.diagnose(provider.id, 'slow-fixture');
  for (let i = 0; i < 3; i++) await advance(t, 55000);
  await advance(t, PROBE_TIMEOUT_MS);
  const result = await stalled;
  assert.equal(result.ok, false); assert.equal(result.failure.kind, 'timeout'); assert.equal(f.controllers.size, 0);
  const controller = new AbortController(), cancelled = f.diagnose(provider.id, 'slow-fixture', controller.signal);
  controller.abort(); await flush();
  assert.equal((await cancelled).cancelled, true);
  assert.equal(f.controllers.size, 0); assert.equal(f.saved.length, 1, 'Cancelled check must not overwrite history');
});
