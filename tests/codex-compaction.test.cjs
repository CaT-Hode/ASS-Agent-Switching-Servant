const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Router } = require('../core/router.cjs');
const { codexModelId } = require('../core/models.cjs');

const provider = { id: 'compact-fixture', name: 'Synthetic provider', enabled: true,
  baseUrl: 'https://provider.invalid', apiKey: 'synthetic-only',
  models: [{ model: 'flash-fixture', enabled: true, wireApi: 'openai-responses', defaultEffort: 'high', maxOutputTokens: 32768 }] };
const summary = '目标：修复隔离示例。已修改 example.js，验证通过；下一步检查 result.json。';
const completed = () => ({ id: 'resp_synthetic', status: 'completed', output: [
  { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'synthetic internal thought' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: summary }] },
], usage: { input_tokens: 120, output_tokens: 32, total_tokens: 152, input_tokens_details: { cached_tokens: 80 } } });
const events = value => [
  ...value.output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index })),
  { type: value.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: value },
];
const sse = rows => rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('');
const crypt = (key = crypto.randomBytes(32)) => ({
  isEncryptionAvailable: () => true,
  encryptString(text) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString(bytes) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  },
});
const body = (stream = true) => ({ model: codexModelId(provider.id, 'flash-fixture'), stream,
  instructions: 'Synthetic coding task', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'exec', description: 'Synthetic input', format: { type: 'text' } },
  ] }], input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the isolated example' }] },
    { type: 'custom_tool_call', name: 'exec', call_id: 'old_call', input: 'synthetic example only' },
    { type: 'custom_tool_call_output', call_id: 'old_call', output: 'synthetic result' },
    { type: 'compaction_trigger' },
  ] });
async function fixture(t, { upstream, encryption = crypt(), p = provider } = {}) {
  const calls = [], logs = [];
  const router = new Router({ getState: () => ({ providers: [p] }), compactionCrypto: encryption,
    log: row => logs.push(row), fetchUpstream: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (upstream) return upstream(calls.at(-1), init);
      return new Response(sse(events(completed())), { headers: { 'content-type': 'text/event-stream' } });
    } });
  await router.start(0); t.after(() => router.stop());
  return { router, calls, logs, encryption, send: request => fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-oauth', 'content-type': 'application/json' }, body: JSON.stringify(request),
  }) };
}
const parseSSE = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('remote v2 compaction emits exactly one checkpoint instead of ordinary reasoning and message items', async t => {
  const f = await fixture(t), request = body(), original = JSON.stringify(request);
  const r = await f.send(request), rows = parseSSE(await r.text());
  assert.equal(r.status, 200);
  const done = rows.filter(row => row.type === 'response.output_item.done');
  assert.equal(done.filter(row => row.item.type === 'compaction').length, 1);
  assert.equal(done.length, 1);
  assert.equal(rows.at(-1).type, 'response.completed');
  assert.equal(rows.at(-1).response.output.length, 1);
  assert.deepEqual(rows.at(-1).response.usage, completed().usage);
  assert.equal(JSON.stringify(request), original);
});

for (const protocol of ['openai-responses', 'openai-chat', 'anthropic']) {
  for (const stream of [false, true]) test(`compaction and repeated requests work for ${protocol} (${stream ? 'SSE' : 'JSON'})`, async t => {
    const p = { ...provider, models: provider.models.map(m => ({ ...m, wireApi: protocol })) };
    const f = await fixture(t, { p, upstream: ({ body: sent }) => {
      assert.match(JSON.stringify(sent), /synthetic example only/);
      assert.match(JSON.stringify(sent), /synthetic result/);
      assert.doesNotMatch(JSON.stringify(sent), /compaction_trigger/);
      assert.equal(sent.tools, undefined);
      if (protocol === 'openai-responses') {
        assert.equal(sent.max_output_tokens, 16384);
        assert.equal(sent.store, false);
        assert.match(sent.instructions, /continuation checkpoint/);
        return new Response(stream ? sse(events(completed())) : JSON.stringify(completed()), {
          headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
        });
      }
      if (protocol === 'openai-chat') return new Response([
        { choices: [{ delta: { content: summary }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 32 } },
      ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
      return new Response(sse([
        { type: 'message_start', message: { usage: { input_tokens: 120 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: summary } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 32 } },
        { type: 'message_stop' },
      ]), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const request = body(stream), original = JSON.stringify(request);
    for (let i = 0; i < 2; i++) {
      const r = await f.send(request), text = await r.text(); assert.equal(r.status, 200, text);
      const rows = stream ? parseSSE(text) : [], value = stream ? rows.at(-1).response : JSON.parse(text);
      assert.equal(value.output.length, 1); assert.equal(value.output[0].type, 'compaction');
      assert.match(value.output[0].encrypted_content, /^ass-compaction-v1:/);
      assert.doesNotMatch(text, /目标|internal thought|reasoning_text/);
      assert.equal(value.model, request.model);
      if (stream) assert.deepEqual(rows.map(row => row.sequence_number), rows.map((_, i) => i));
      assert.equal(f.logs.at(-1).operation, 'compaction'); assert.equal(f.logs.at(-1).taskOk, true);
    }
    assert.equal(JSON.stringify(request), original); assert.equal(f.calls.length, 2);
  });
}

test('checkpoint survives a new router and later compaction, and supports a switch to official models', async t => {
  const key = crypto.randomBytes(32), first = await fixture(t, { encryption: crypt(key) });
  const r = await first.send(body(false)), checkpoint = (await r.json()).output[0];
  await first.router.stop();
  const second = await fixture(t, { encryption: crypt(key), upstream: ({ body: sent }) => {
    assert.match(JSON.stringify(sent.input), /example\.js/);
    assert.match(JSON.stringify(sent.input), /result\.json/);
    assert.doesNotMatch(JSON.stringify(sent.input), /ass-compaction-v1:|"type":"compaction"/);
    return new Response(JSON.stringify(completed()), { headers: { 'content-type': 'application/json' } });
  } });
  const input = [checkpoint, { role: 'user', content: 'Continue the isolated task' }];
  const snapshot = JSON.stringify(input);
  for (const model of [body().model, 'gpt-official-fixture']) {
    const reply = await second.send({ model, stream: false, input });
    assert.equal(reply.status, 200); await reply.text();
    assert.equal(second.calls.at(-1).headers.authorization, model.includes('::') ? 'Bearer synthetic-only' : 'Bearer synthetic-oauth');
    assert.equal(second.logs.at(-1).operation, undefined);
  }
  const repeated = await second.send({ model: body().model, stream: false, input: [...input, { type: 'compaction_trigger' }] });
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).output[0].type, 'compaction');
  assert.equal(JSON.stringify(input), snapshot);
});

test('native official compaction triggers and encrypted checkpoints retain their original request and response', async t => {
  const native = { id: 'native_checkpoint', type: 'compaction', encrypted_content: 'synthetic-native-opaque-state' };
  const output = { ...completed(), output: [native] }, responseText = JSON.stringify(output);
  const request = { model: 'gpt-official-fixture', stream: false,
    input: [native, { role: 'user', content: 'continue' }, { type: 'compaction_trigger' }],
    tools: [{ type: 'custom', name: 'native_tool', format: { type: 'text' } }], instructions: 'preserve official' };
  const f = await fixture(t, { encryption: null, upstream: call => {
    assert.deepEqual(call.body, request);
    assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/responses');
    return new Response(responseText, { headers: { 'content-type': 'application/json', 'x-request-id': 'official-original' } });
  } });
  for (let i = 0; i < 2; i++) {
    const r = await f.send(request); assert.equal(r.status, 200); assert.equal(await r.text(), responseText);
    assert.equal(r.headers.get('x-request-id'), 'official-original'); assert.equal(f.logs.at(-1).operation, undefined);
  }
});

test('failed, incomplete, empty, oversized or tool-producing summaries never install a checkpoint or log task success', async t => {
  let value, raw;
  const f = await fixture(t, { upstream: () => new Response(raw ?? JSON.stringify(value), {
    headers: { 'content-type': raw?.startsWith('event:') ? 'text/event-stream' : 'application/json' },
  }) });
  for (const patch of [
    { status: 'failed' }, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { output: [] }, { output: [completed().output[0]] },
    { output: [{ type: 'function_call', name: 'synthetic', arguments: '{}' }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'synthetic refusal' }] }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(256 * 1024 + 1) }] }] },
  ]) {
    value = { ...completed(), ...patch }; raw = undefined;
    const r = await f.send(body(false)), text = await r.text();
    assert.equal(r.status, 502, JSON.stringify(patch).slice(0, 60));
    assert.doesNotMatch(text, /encrypted_content|internal thought|synthetic refusal/);
    assert.equal(f.logs.at(-1).httpStatus, 200); assert.equal(f.logs.at(-1).httpOk, true);
    assert.equal(f.logs.at(-1).taskOk, false); assert.equal(f.logs.at(-1).operation, 'compaction');
  }
  for (raw of ['{not JSON', sse(events(completed()).slice(0, -1)),
    sse(events({ ...completed(), status: 'incomplete', incomplete_details: { reason: 'model_context_window_exceeded' } }))]) {
    const r = await f.send(body()), text = await r.text();
    assert.equal(r.status, 502); assert.doesNotMatch(text, /encrypted_content|event: response.completed/);
    assert.equal(f.logs.at(-1).taskOk, false);
  }
});

test('tampered, unavailable and oversized checkpoints fail before forwarding without discarding input', async t => {
  const { CodexCompaction } = require('../core/codex-compaction.cjs');
  const encryption = crypt(), f = await fixture(t, { encryption });
  const r = await f.send(body(false)), item = (await r.json()).output[0];
  f.calls.length = 0;
  for (const encrypted_content of [item.encrypted_content.replace(/.$/, '!'),
    'ass-compaction-v1:' + crypt().encryptString('{}').toString('base64'),
    'ass-compaction-v1:' + 'A'.repeat(1024 * 1024 + 4),
    'ass-compaction-v1:' + encryption.encryptString(JSON.stringify({ kind: 'ass-codex-compaction', version: 2, summary })).toString('base64')]) {
    const request = { model: body().model, stream: false, input: [{ ...item, encrypted_content }] }, before = JSON.stringify(request);
    const reply = await f.send(request); assert.equal(reply.status, 400); await reply.text();
    assert.equal(JSON.stringify(request), before); assert.equal(f.calls.length, 0);
  }
  const codec = new CodexCompaction(encryption), ordinary = { input: [{ role: 'user', content: 'hello' }] };
  assert.equal(codec.expand(ordinary), ordinary);
  assert.equal(new CodexCompaction(null).expand(ordinary), ordinary);
  const unavailable = await fixture(t, { encryption: null });
  const reply = await unavailable.send(body(false)); assert.equal(reply.status, 503); await reply.text();
  assert.equal(unavailable.calls.length, 0);
});

test('malformed compaction triggers or partial history fail before the model request', async t => {
  const f = await fixture(t);
  for (const request of [
    { ...body(false), input: [{ type: 'compaction_trigger' }, { role: 'user', content: 'later' }] },
    { ...body(false), input: [...body().input, { type: 'compaction_trigger' }] },
    { ...body(false), previous_response_id: 'cannot-summarize-missing-history' },
  ]) {
    const reply = await f.send(request); assert.equal(reply.status, 400); await reply.text();
    assert.equal(f.calls.length, 0); assert.equal(f.logs.at(-1).taskOk, false);
  }
});
