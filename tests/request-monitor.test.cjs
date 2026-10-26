const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { RequestMetrics } = require('../core/request-metrics.cjs');
const { RequestHistory } = require('../core/request-history.cjs');
const { Router } = require('../core/router.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const sse = event => 'data: ' + JSON.stringify(event) + '\r\n\r\n';

test('Responses measures first meaningful output and reported tokens; repeated cumulative usage never adds twice', () => {
  let now = 1000; const metrics = new RequestMetrics({ now: () => now, began: 1000 });
  now = 1500; metrics.event({ type: 'response.created', response: { usage: null } });
  assert.equal(metrics.snapshot().ttftMs, null);
  now = 2000; metrics.event({ type: 'response.output_text.delta', delta: 'hello' });
  now = 4000; metrics.event({ type: 'response.output_text.delta', delta: ' world' });
  now = 6000; const event = { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 80,
    input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 20 } } } };
  metrics.event(event); metrics.event(event);
  assert.deepEqual(metrics.snapshot(), { usage: { inputTokens: 100, outputTokens: 80, cacheReadTokens: 60, reasoningTokens: 20 },
    ttftMs: 1000, generationMs: 4000, visibleTokens: 60, visibleMs: 2000, tps: 60 / 2, tpsEstimated: false, endToEndTps: 80 / 5 });
});

test('Anthropic merges input/cache and final output snapshots, including output-only message_delta', () => {
  let now = 0; const metrics = new RequestMetrics({ now: () => now });
  metrics.event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 } } });
  now = 500; metrics.event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } });
  now = 1000; metrics.event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a'.repeat(40) } });
  now = 2000; metrics.event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'b'.repeat(40) } });
  now = 2500; metrics.event({ type: 'message_delta', usage: { output_tokens: 50 } });
  metrics.event({ type: 'message_stop' });
  assert.deepEqual(metrics.snapshot(), { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 70, cacheWriteTokens: 20 },
    ttftMs: 500, generationMs: 2000, visibleTokens: 20, visibleMs: 1000, tps: 20, tpsEstimated: true, endToEndTps: 50 / 2.5 });
});

test('live TPS advances without usage reports, marks estimates, and final accounting uses only upstream numbers', () => {
  let now = 0; const metrics = new RequestMetrics({ now: () => now });
  now = 1000; metrics.event({ type: 'response.output_text.delta', delta: 'abcdefghijklmnopqrst' });
  now = 2000; const first = metrics.snapshot({ live: true });
  assert.equal(first.tpsEstimated, true); assert.equal(first.usage.outputTokens, 5); assert.equal(first.tps, null, 'one arrival has no measurable receive interval');
  now = 3000; metrics.event({ type: 'response.output_text.delta', delta: '你好世界' });
  assert.equal(metrics.snapshot({ live: true }).usage.outputTokens, 9);
  now = 5000; assert.equal(metrics.snapshot({ live: true }).tps, 9 / 4, 'live sampling includes pauses after the first visible output');
  assert.equal(metrics.snapshot().usage, null, 'estimates do not enter completed statistics');
  metrics.event({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } } } });
  assert.equal(metrics.snapshot({ live: true }).tpsEstimated, false);
  assert.deepEqual(metrics.snapshot(), { usage: { inputTokens: 30, outputTokens: 12, reasoningTokens: 0 }, ttftMs: 1000, generationMs: 4000,
    visibleTokens: 12, visibleMs: 2000, tps: 12 / 2, tpsEstimated: false, endToEndTps: 12 / 5 });
});

test('first-second samples stay unknown and same-event cumulative usage covers its text delta exactly once', () => {
  let now = 0; const metrics = new RequestMetrics({ now: () => now });
  now = 10; metrics.event({ choices: [{ delta: { content: 'a'.repeat(40) } }], usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } } });
  now = 11; assert.equal(metrics.snapshot({ live: true }).tps, null);
  now = 999; assert.equal(metrics.snapshot({ live: true }).tps, null);
  now = 1000; const sample = metrics.snapshot({ live: true });
  assert.equal(sample.usage.outputTokens, 10); assert.equal(sample.visibleTokens, 10); assert.equal(sample.tps, null); assert.equal(sample.tpsEstimated, false);
  now = 1010; metrics.event({ choices: [{ delta: { content: 'a'.repeat(40) } }], usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } } });
  assert.equal(metrics.snapshot({ live: true }).tps, 20, 'sampling starts one second after visible output, not request admission');
  now = 2000; metrics.event({ choices: [{ delta: { content: 'a'.repeat(40) } }] });
  assert.equal(metrics.snapshot({ live: true }).usage.outputTokens, 30); assert.equal(metrics.snapshot({ live: true }).visibleTokens, 30);
  assert.equal(metrics.snapshot({ live: true }).tpsEstimated, true);
  metrics.event({ choices: [], usage: { completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 0 } } });
  assert.equal(metrics.snapshot({ live: true }).visibleTokens, 30); assert.equal(metrics.snapshot({ live: true }).tpsEstimated, false);
});

test('visible TPS excludes hidden reasoning and its waiting time; legacy timing stays unknown without rewriting logs', t => {
  let now = 0; const metrics = new RequestMetrics({ now: () => now });
  now = 1000; metrics.event({ type: 'response.reasoning_summary_text.delta', delta: 'private reasoning summary' });
  assert.equal(metrics.snapshot({ live: true }).tps, null, 'reasoning alone does not start visible sampling');
  now = 317111; metrics.event({ type: 'response.output_text.delta', delta: 'visible answer' });
  now = 318682; metrics.event({ type: 'response.function_call_arguments.delta', delta: '{}' });
  now = 318682; metrics.event({ type: 'response.completed', response: { usage: { output_tokens: 6085, output_tokens_details: { reasoning_tokens: 5989 } } } });
  assert.equal(metrics.snapshot().visibleTokens, 96); assert.equal(metrics.snapshot().visibleMs, 1571);
  assert.equal(metrics.snapshot().tps, 96 * 1000 / 1571);
  assert.equal(metrics.snapshot().endToEndTps, 6085 * 1000 / 318682);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-monitor-legacy-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = JSON.stringify({ model: 'vendor/model', ok: true, ms: 318686, generationMs: 1571, tps: 6085 / 1.571,
    usage: { outputTokens: 6085, reasoningTokens: 5989 } }) + '\n';
  fs.writeFileSync(path.join(root, 'requests.jsonl'), log);
  const history = new RequestHistory(root);
  assert.equal(history.snapshot().rows[0].tps, null, 'old generationMs may start at reasoning and cannot be reused');
  assert.equal(history.snapshot().rows[0].visibleTokens, 96);
  assert.equal(history.snapshot().rows[0].endToEndTps, 6085 * 1000 / 318686);
  assert.equal(fs.readFileSync(history.file, 'utf8'), log);
  history.append({ model: 'vendor/model', ok: true, ms: 318686, ...metrics.snapshot() });
  assert.equal(new RequestHistory(root).snapshot().rows[1].tps, 96 * 1000 / 1571);
});

test('multiple SSE frames buffered in one transport packet never invent a visible streaming interval', async () => {
  let now = 0; const metrics = new RequestMetrics({ now: () => ++now });
  const text = [sse({ type: 'response.output_text.delta', delta: 'first' }), sse({ type: 'response.output_text.delta', delta: 'last' }),
    sse({ type: 'response.completed', response: { usage: { output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 } } } })].join('');
  assert.equal(await metrics.observe(new Response(text, { headers: { 'content-type': 'text/event-stream' } })).text(), text);
  assert.equal(metrics.snapshot().visibleTokens, 40); assert.equal(metrics.snapshot().visibleMs, null); assert.equal(metrics.snapshot().tps, null);
});

test('passive stream measurement preserves split UTF8, CRLF, heartbeats and raw bytes for all protocols', async () => {
  const events = [': heartbeat\r\n\r\n', sse({ choices: [{ delta: { content: '你好' } }] }), sse({ choices: [{ delta: { content: '世界' } }] }),
    sse({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } }), 'data: [DONE]\r\n\r\n'].join('');
  const source = Buffer.from(events); let now = 0;
  const body = new ReadableStream({ start(controller) { for (const byte of source) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const metrics = new RequestMetrics({ now: () => ++now });
  const response = metrics.observe(new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-fixture': 'keep' } }));
  assert.equal(await response.text(), events); assert.equal(response.headers.get('x-fixture'), 'keep');
  assert.equal(metrics.snapshot().usage.inputTokens, 40); assert.equal(metrics.snapshot().usage.cacheReadTokens, 30);
  assert.ok(metrics.snapshot().tps > 0); assert.equal(JSON.stringify(metrics.snapshot()).includes('你好'), false);
});

test('JSON reports whole-request throughput without inventing streaming timings; invalid streams do not change transport', async () => {
  let now = 0; const metrics = new RequestMetrics({ now: () => now }); const json = JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2 } });
  now = 2000;
  assert.equal(await metrics.observe(new Response(json, { headers: { 'content-type': 'application/json' } })).text(), json);
  assert.equal(metrics.snapshot().usage.inputTokens, 3); assert.equal(metrics.snapshot().tps, null); assert.equal(metrics.snapshot().endToEndTps, 2 / 2);
  assert.equal(metrics.snapshot().ttftMs, null); assert.equal(metrics.snapshot().generationMs, null);
  for (const text of ['data: {broken}\n\n', sse({ type: 'response.failed', error: { message: 'fixture' } }), ': just a heartbeat\n\n']) {
    const value = new RequestMetrics(); assert.equal(await value.observe(new Response(text, { headers: { 'content-type': 'text/event-stream' } })).text(), text);
    assert.deepEqual(value.snapshot(), { usage: null, ttftMs: null, generationMs: null,
      visibleTokens: null, visibleMs: null, tps: null, tpsEstimated: false, endToEndTps: null });
  }
});

test('history reloads current and rotated logs, tolerates one incomplete record and exposes no payload or headers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-monitor-history-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'requests.jsonl.previous'), JSON.stringify({ time: '2026-10-25', model: 'vendor/model', source: 'A', ok: true }) + '\n');
  fs.writeFileSync(path.join(root, 'requests.jsonl'), '{partial\n' + JSON.stringify({ model: '', source: 'official bootstrap' }) + '\n');
  const history = new RequestHistory(root); history.append({ time: '2026-10-26', model: 'ASS_x::vendor/model', source: 'B', ok: true,
    visibleTokens: 2, visibleMs: 1000, tpsEstimated: true,
    prompt: 'PRIVATE', input: 'PRIVATE', upstream: { headers: { authorization: 'PRIVATE' } }, usage: { inputTokens: 100, outputTokens: 3, extra: 'PRIVATE' } });
  assert.equal(history.snapshot().rows.length, 2); assert.equal(history.revision, 1); assert.match(history.error, /部分旧请求/);
  const reloaded = new RequestHistory(root).snapshot(); assert.equal(reloaded.rows.length, 2); assert.doesNotMatch(JSON.stringify(reloaded), /PRIVATE|authorization|prompt|extra/);
  assert.deepEqual(reloaded.rows[1].usage, { inputTokens: 100, outputTokens: 3 });
  assert.equal(reloaded.rows[1].tps, 2); assert.equal(reloaded.rows[1].tpsEstimated, true);
});

test('monitor uses existing leaf-name merging, weighted TPS/cache denominators and excludes diagnostics by default', async () => {
  const { monitorRows, summarizeRequests, aggregateTps, cacheRate, requestTimeline, meanTtft } = await import('../src/request-monitor-view.mjs');
  const time = '2026-10-26T01:00:00Z', now = Date.parse(time) + 1000;
  const rows = [
    { time, model: 'ASS_one::vendor/model', source: 'A', client: 'codex', ok: true, ms: 2000, visibleMs: 1000, visibleTokens: 10, tps: 10, ttftMs: 100,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
    { time, model: 'model', source: 'B', client: 'claude', ok: true, ms: 6000, visibleMs: 3000, visibleTokens: 90, tps: 30, tpsEstimated: true, ttftMs: 300,
      usage: { inputTokens: 300, outputTokens: 90, cacheReadTokens: 250 } },
    { time, model: 'vendor/model', source: 'A', ok: false },
    { time, model: 'other', client: 'diagnostics', ok: true },
    { time, model: 'other', operation: 'count_tokens', ok: true },
  ];
  const options = { range: 'day', client: 'all', provider: 'all', status: 'all' };
  const selected = monitorRows(rows, options, now), result = summarizeRequests(selected);
  assert.equal(selected.length, 3); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].name, 'model');
  assert.equal(aggregateTps(result.total), (10 + 90) / (1 + 3)); assert.equal(result.total.tpsEstimated, true);
  assert.equal(cacheRate(result.total), 75); assert.equal(meanTtft(result.total), 200);
  assert.equal(monitorRows(rows, { ...options, provider: 'B' }, now).length, 1);
  assert.equal(monitorRows(rows, { ...options, status: 'failed' }, now).length, 1);
  assert.equal(monitorRows(rows, { ...options, search: 'model' }, now).length, 3);
  assert.equal(monitorRows(rows, { ...options, diagnostics: true }, now).length, 4);
  assert.equal(summarizeRequests(selected, 'provider').groups.length, 2);
  assert.equal(requestTimeline(selected, 'day', now).reduce((n, r) => n + r.calls, 0), 3);
  const legacy = summarizeRequests([rows[2]]).total;
  assert.equal(cacheRate(legacy), null); assert.equal(aggregateTps(legacy), null); assert.equal(legacy.inputSamples, 0);
  assert.equal(aggregateTps(summarizeRequests([{ ...rows[0], visibleMs: undefined, visibleTokens: undefined }]).total), null);
  const live = { time, requestId: 'live', model: 'new/vendor/model', source: 'B', client: 'codex', inProgress: true,
    tps: 45, tpsEstimated: true, usage: { outputTokens: 900 } };
  const withLive = monitorRows([...rows, live], options, now), liveSummary = summarizeRequests(withLive);
  assert.equal(withLive[0].requestId, 'live'); assert.equal(liveSummary.groups.length, 1);
  assert.equal(liveSummary.total.running, 1); assert.equal(liveSummary.total.completed, 3);
  assert.equal(liveSummary.total.output, 100, 'estimated live tokens never inflate historical totals');
  assert.equal(liveSummary.total.liveTps, 45);
  assert.equal(monitorRows(withLive, { ...options, status: 'running' }, now).length, 1);
  assert.equal(monitorRows(withLive, { ...options, status: 'failed' }, now).length, 1);
  assert.equal(requestTimeline(withLive, 'day', now).reduce((n, r) => n + r.calls, 0), 3);
});

test('ongoing Codex and Harness requests expose wait/stream states, grow elapsed time, then become one completed record', async t => {
  const provider = normalizeProvider({ id: 'live', name: 'Live Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-key',
    models: [{ model: 'vendor/model', wireApi: 'openai-responses' }] });
  const logs = []; let admitted, resolveResponse;
  const router = new Router({ getState: () => ({ providers: [provider] }), log: row => logs.push(row), fetchUpstream: async () => {
    admitted(); return new Promise(resolve => { resolveResponse = resolve; });
  } });
  await router.start(0); t.after(() => router.stop());
  for (const [url, client, model, authorization] of [
    ['/clients/ASS/v1/responses', 'codex', codexModelId('live', 'vendor/model'), 'native-fixture'],
    ['/clients/claude/harness/live/v1/responses', 'claude', 'vendor/model', router.clientToken],
  ]) {
    const upstreamStarted = new Promise(resolve => { admitted = resolve; });
    const request = fetch(`http://127.0.0.1:${router.port}${url}`, { method: 'POST',
      headers: { authorization: 'Bearer ' + authorization, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: [], stream: true }) });
    await upstreamStarted;
    const waiting = router.monitorSnapshot()[0]; assert.equal(waiting.client, client); assert.equal(waiting.phase, 'waiting-upstream');
    assert.equal(waiting.tps, null); assert.equal(waiting.source, 'Live Fixture'); assert.ok(waiting.requestId);
    let controller;
    resolveResponse(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } }));
    // A real client read confirms that observation has seen the complete frame.
    controller.enqueue(Buffer.from(sse({ type: 'response.output_text.delta', delta: 'hello ' })));
    const response = await request, reader = response.body.getReader(); await reader.read();
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.enqueue(Buffer.from(sse({ type: 'response.output_text.delta', delta: 'world' }))); await reader.read();
    await new Promise(resolve => setTimeout(resolve, 1050)); // First full sampling interval.
    const streaming = router.monitorSnapshot()[0]; assert.equal(streaming.phase, 'streaming');
    assert.ok(streaming.ms > waiting.ms); assert.ok(streaming.tps > 0); assert.equal(streaming.tpsEstimated, true);
    assert.doesNotMatch(JSON.stringify(streaming), /hello world|synthetic-key|native-fixture/);
    controller.enqueue(Buffer.from(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 } } } }))); controller.close();
    while (!(await reader.read()).done) {}
    assert.equal(router.monitorSnapshot().length, 0);
    const completed = logs.at(-1); assert.equal(completed.requestId, waiting.requestId);
    assert.equal(completed.usage.outputTokens, 6); assert.equal(completed.visibleTokens, 6); assert.ok(completed.visibleMs > 0);
    assert.equal(completed.tpsEstimated, false); assert.equal(completed.taskOk, true);
  }
});

test('both Codex and Harness requests persist upstream protocol/cache even when their client-facing protocol is converted', async t => {
  const provider = normalizeProvider({ id: 'monitor', name: 'Synthetic Provider', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-upstream',
    models: [{ model: 'vendor/model', wireApi: 'anthropic' }] });
  const rows = [], stream = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }, { type: 'message_stop' },
  ].map(sse).join('');
  const router = new Router({ getState: () => ({ providers: [provider] }), log: row => rows.push(row),
    fetchUpstream: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  await router.start(0); t.after(() => router.stop());
  for (const [url, model, auth] of [['/clients/ASS/v1/responses', codexModelId(provider.id, 'vendor/model'), 'synthetic-native'],
    ['/clients/claude/harness/monitor/v1/messages', 'vendor/model', router.clientToken]]) {
    const response = await fetch(`http://127.0.0.1:${router.port}${url}`, { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 32, input: [], messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 200); await response.text();
  }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.client), ['codex', 'claude']);
  for (const row of rows) {
    assert.equal(row.taskOk, true); assert.equal(row.protocol, 'anthropic'); assert.equal(row.providerId, 'monitor');
    assert.equal(row.usage.inputTokens, 100); assert.equal(row.usage.cacheReadTokens, 60); assert.equal(row.usage.cacheWriteTokens, 30);
    assert.equal(row.usage.outputTokens, 8); assert.ok(row.requestId); assert.equal(typeof row.ttftMs, 'number');
    assert.doesNotMatch(JSON.stringify(row), /synthetic-upstream|hello/);
  }
});
