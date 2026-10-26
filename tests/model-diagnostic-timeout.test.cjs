const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { nativeProbe, modelKey, PROBE_TIMEOUT_MS, DIAGNOSTIC_TIMEOUT_MS } = require('../core/model-inspection.cjs');
const { inspectConnectionResponse } = require('../core/connection-diagnostic.cjs');
const { classifyFailure } = require('../core/diagnostic-failure.cjs');
const { abortable } = require('../core/abortable.cjs');
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

test('full capability probes accept slow responses and still expire when upstream stalls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const pending = nativeProbe(provider, provider.models[0], 'anthropic', async (url, init) => {
    await pause(55000, init.signal); return success('anthropic');
  });
  await advance(t, 55000);
  assert.equal((await pending).status, 'passed');
  const stalled = nativeProbe(provider, provider.models[0], 'anthropic', () => new Promise(() => {}));
  await advance(t, PROBE_TIMEOUT_MS); assert.equal((await stalled).status, 'unknown');
});

// Run the actual Electron diagnostic function with synthetic dependencies and
// a virtual clock, without launching Electron or reading the native profile.
function diagnosticHarness({ bodyStall = false, fetchStall = false, probeMs = 10000, responseMs = 10000 } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const code = source.slice(source.indexOf('async function diagnose('), source.indexOf('function invalidateReports('));
  const controllers = new Map();
  const signals = { any: signals => AbortSignal.any(signals), timeout: ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Diagnostic timeout', 'TimeoutError')), ms);
    return controller.signal;
  } };
  const context = {
    Date, AbortController, AbortSignal: signals, require,
    connections: { busy: false }, nativeDiagnosticContext: () => null,
    store: { state: { providers: [provider] } }, diagnosticControllers: controllers,
    diagnosticMetrics: () => ({ headers() {}, observe() {}, finish: () => ({ ms: 0 }) }),
    diagnosticHistory: { fingerprint: () => 'synthetic', record: () => true },
    modelKey, codexModelId: () => 'ASS_fixture::slow-fixture',
    DIAGNOSTIC_TIMEOUT_MS,
    protocols: { record() {}, ensure: (p, m, { signal }) => pause(probeMs, signal), select: () => 'anthropic' },
    router: { server: true, port: 1, clientToken: 'synthetic' }, servicePort: 1,
    fetch: async (url, init) => {
      if (bodyStall) return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      if (fetchStall) return new Promise(() => {});
      await pause(responseMs, init.signal); return success('openai-responses');
    }, inspectConnectionResponse, classifyFailure, abortable, push() {},
  };
  const diagnose = vm.runInNewContext(code + '\ndiagnose;', context);
  return { diagnose, controllers };
}
test('connection checks share one 30-second budget across protocol selection and response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = diagnosticHarness();
  const complete = f.diagnose(provider.id, 'slow-fixture');
  await advance(t, 10000); await advance(t, 10000);
  assert.equal((await complete).ok, true);
  assert.equal(f.controllers.size, 0);
  const slow = diagnosticHarness({ probeMs: 20000, responseMs: 20000 });
  const pending = slow.diagnose(provider.id, 'slow-fixture');
  await advance(t, 20000); await advance(t, 10000);
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.failure.kind, 'timeout');
  assert.equal(result.ms, 30000); assert.equal(slow.controllers.size, 0);
});
test('stalled probes, headers and bodies release diagnostics within 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  for (const options of [{ probeMs: 55000 }, { fetchStall: true }, { bodyStall: true }]) {
    const f = diagnosticHarness(options), pending = f.diagnose(provider.id, 'slow-fixture');
    await advance(t, 10000); await advance(t, 20000);
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.failure.kind, 'timeout');
    assert.equal(result.ms, DIAGNOSTIC_TIMEOUT_MS); assert.equal(f.controllers.size, 0);
  }
});
