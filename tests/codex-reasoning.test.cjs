const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { CodexReasoning, PREFIX, CONTENT_LIMIT, CAPSULE_LIMIT } = require('../core/codex-reasoning.cjs');
const { Router } = require('../core/router.cjs'), { codexModelId } = require('../core/models.cjs');

const thought = 'Synthetic private thought. 中文测试。';
const reasoning = () => ({ type: 'reasoning', id: 'rs_fixture', summary: [],
  content: [{ type: 'reasoning_text', text: thought }], encrypted_content: 'native-placeholder',
  internal_chat_message_metadata_passthrough: { fixture: 'unchanged' } });
const message = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Synthetic final answer', annotations: [] }] };
const completed = () => ({ id: 'resp_fixture', status: 'completed', output: [reasoning(), message],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 15 } } });
const encryption = (key = crypto.randomBytes(32)) => ({
  isEncryptionAvailable: () => true,
  encryptString(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]); },
  decryptString(bytes) { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]).toString('utf8'); },
});
const events = (value = completed()) => [
  { type: 'response.created', response: { ...value, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...value.output[0], content: [] } },
  { type: 'response.reasoning_text.delta', item_id: 'rs_fixture', output_index: 0, content_index: 0, delta: thought.slice(0, 7) },
  { type: 'response.reasoning_text.delta', item_id: 'rs_fixture', output_index: 0, content_index: 0, delta: thought.slice(7) },
  { type: 'response.reasoning_text.done', item_id: 'rs_fixture', output_index: 0, content_index: 0, text: thought },
  { type: 'response.output_item.done', output_index: 0, item: value.output[0] },
  { type: 'response.output_item.added', output_index: 1, item: message },
  { type: 'response.output_text.delta', item_id: message.id, output_index: 1, content_index: 0, delta: message.content[0].text },
  { type: 'response.output_item.done', output_index: 1, item: message },
  { type: value.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: value },
];
const iterable = async function* (rows) { yield* rows; };
const collect = async events => { const rows = []; for await (const event of events) rows.push(event); return rows; };
const sse = rows => rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('');
const parse = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('completed thinking is hidden, encrypted and replayed exactly across instances without changing answers or usage', () => {
  const key = crypto.randomBytes(32), codec = new CodexReasoning(encryption(key)), value = completed(), original = JSON.stringify(value);
  const view = codec.view(), result = view.response(value), item = result.output[0];
  assert.equal(item.content, undefined); assert.deepEqual(item.summary, []); assert(item.encrypted_content.startsWith(PREFIX));
  assert(!JSON.stringify(result).includes(thought));
  assert.deepEqual(result.output[1], message); assert.deepEqual(result.usage, value.usage);
  assert.deepEqual(view.response(value), result, 'Same output item should have a stable capsule within one response');
  assert.deepEqual(view.response(result), result, 'Already hidden history should not be encrypted twice');
  for (let i = 0; i < 2; i++) {
    const request = { model: 'synthetic', input: result.output }, requestText = JSON.stringify(request);
    assert.deepEqual(new CodexReasoning(encryption(key)).expand(request).input, value.output);
    assert.equal(JSON.stringify(request), requestText);
  }
  assert.equal(JSON.stringify(value), original);
  const native = { model: 'native', input: [{ type: 'reasoning', summary: [], encrypted_content: 'foreign-native-state' }, message] };
  assert.equal(codec.expand(native), native, 'Foreign native state must stay untouched');
  assert.deepEqual(view.response({ output: native.input }), { output: native.input });
});

test('live thinking deltas remain visible while completed items and terminal output are cleared and deduplicated', async () => {
  const codec = new CodexReasoning(encryption()), rows = events(), original = JSON.stringify(rows);
  rows.splice(6, 0, structuredClone(rows[5]));
  const output = await collect(codec.view().restore(iterable(rows)));
  assert.equal(output.filter(e => e.type === 'response.reasoning_text.delta').map(e => e.delta).join(''), thought);
  const done = output.filter(e => e.type === 'response.output_item.done' && e.item.type === 'reasoning');
  assert.equal(done.length, 1); assert.equal(done[0].item.content, undefined);
  assert.deepEqual(done[0].item, output.at(-1).response.output[0]);
  assert.deepEqual(codec.expand({ input: [done[0].item] }).input, [reasoning()]);
  assert.deepEqual(output.at(-1).response.output[1], message); assert.deepEqual(output.at(-1).response.usage, completed().usage);
  assert.deepEqual(output.map(e => e.sequence_number), output.map((_, i) => i));
  rows.splice(6, 1); assert.equal(JSON.stringify(rows), original, 'Upstream objects must not be mutated');
});

test('sparse completion uses streamed thinking, and terminal-only output closes the live item', async () => {
  const codec = new CodexReasoning(encryption());
  for (const variant of ['sparse', 'terminal-only', 'added-only', 'content-part']) {
    const rows = events();
    if (variant === 'sparse') { delete rows[5].item.content; delete rows.at(-1).response.output[0].content; }
    if (variant === 'terminal-only') rows.splice(5, 1);
    if (variant === 'added-only') { rows[1].item = reasoning(); rows.splice(2, 3); delete rows[2].item.content; delete rows.at(-1).response.output[0].content; }
    if (variant === 'content-part') rows.splice(2, 3, { type: 'response.content_part.done', item_id: 'rs_fixture', output_index: 0,
      content_index: 0, part: { type: 'reasoning_text', text: thought } });
    const output = await collect(codec.view().restore(iterable(rows))), item = output.at(-1).response.output[0];
    assert.equal(item.content, undefined, variant);
    assert.equal(codec.expand({ input: [item] }).input[0].content[0].text, thought, variant);
    assert.equal(output.filter(e => e.type === 'response.output_item.done' && e.item.type === 'reasoning').length, 1, variant);
  }
});

test('invalid, oversized or unavailable encrypted thinking fails without silently discarding history', () => {
  const codec = new CodexReasoning(encryption()), sealed = codec.view().response(completed()).output[0];
  for (const value of ['', 'bad!', 'A'.repeat(CAPSULE_LIMIT + 1), sealed.encrypted_content.slice(PREFIX.length).slice(0, -4) + 'AAAA'])
    assert.throws(() => codec.expand({ input: [{ ...sealed, encrypted_content: PREFIX + value }] }), /无法解密或已损坏/);
  assert.throws(() => new CodexReasoning(encryption()).expand({ input: [sealed] }), /无法解密或已损坏/);
  for (const value of [undefined, { ...encryption(), isEncryptionAvailable: () => false }]) {
    const unavailable = new CodexReasoning(value);
    assert.throws(() => unavailable.view().response(completed()), /加密不可用/);
    assert.throws(() => unavailable.expand({ input: [sealed] }), /加密不可用/);
  }
  assert.throws(() => codec.view().response({ output: [{ ...reasoning(), content: [{ type: 'reasoning_text', text: 'x'.repeat(CONTENT_LIMIT) }] }] }), /超过大小限制/);
  assert.throws(() => codec.view().response({ output: [{ ...reasoning(), content: [{ type: 'unknown', text: thought }] }] }), /格式无效/);
});

const provider = { id: 'deepseek-fixture', name: 'Synthetic DeepSeek', enabled: true, apiKey: 'synthetic-key', baseUrl: 'https://api.deepseek.com',
  models: [{ model: 'flash-fixture', enabled: true, wireApi: 'openai-responses', defaultEffort: 'high' }] };
async function fixture(t, { p = provider, key = encryption(), upstream } = {}) {
  const calls = [], logs = [];
  const router = new Router({ compactionCrypto: key, getState: () => ({ providers: [p] }), log: row => logs.push(row),
    fetchUpstream: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return upstream(body, calls.length); } });
  await router.start(0); t.after(() => router.stop());
  return { calls, logs, send: body => fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer synthetic-local', 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
for (const stream of [false, true]) test(`DeepSeek reasoning works without tools and with custom tools, repeated continuation and official switching (${stream ? 'SSE' : 'JSON'})`, async t => {
  let tools = false;
  const f = await fixture(t, { upstream: body => {
    assert(!JSON.stringify(body).includes(PREFIX));
    if (tools && body.model === 'flash-fixture') assert.equal(body.tools[0].type, 'function');
    const value = completed();
    if (tools && body.model === 'flash-fixture') value.output.push({ type: 'function_call', id: 'tool_fixture', call_id: 'call_fixture',
      name: body.tools[0].name, arguments: JSON.stringify({ input: 'synthetic tool input' }), status: 'completed' });
    const rows = events(value); if (value.output[2]) rows.splice(-1, 0, { type: 'response.output_item.done', output_index: 2, item: value.output[2] });
    return new Response(stream ? sse(rows) : JSON.stringify(value), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
  } });
  for (tools of [false, true]) {
    const request = { model: codexModelId(provider.id, 'flash-fixture'), stream, input: [{ role: 'user', content: 'Synthetic request' }],
      ...(tools ? { tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] }] } : {}) };
    for (let i = 0; i < 2; i++) {
      const response = await f.send(request); assert.equal(response.status, 200);
      const text = await response.text(), rows = stream ? parse(text) : [], value = stream ? rows.at(-1).response : JSON.parse(text);
      assert.equal(value.output[0].content, undefined); assert.deepEqual(value.output[1], message);
      if (stream) assert.equal(rows.filter(e => e.type === 'response.reasoning_text.delta').map(e => e.delta).join(''), thought);
      assert.deepEqual(value.usage, completed().usage);
      if (tools) { assert.equal(value.output[2].type, 'custom_tool_call'); assert.equal(value.output[2].namespace, 'functions'); assert.equal(value.output[2].input, 'synthetic tool input'); }
      if (i) assert.deepEqual(f.calls.at(-1).body.input[0], reasoning(), 'Continuation must receive the exact provider state');
      request.input = value.output.slice(0, 2);
      assert.equal(f.logs.at(-1).taskOk, true);
    }
    await (await f.send({ ...request, model: 'native-official' })).text();
    assert.equal(f.calls.at(-1).body.input.some(item => item.type === 'reasoning'), false, 'Foreign reasoning must not reach official subscription');
  }
});

for (const stream of [false, true]) test(`DeepSeek failed or interrupted tasks do not become successful completions (${stream ? 'SSE' : 'JSON'})`, async t => {
  let failed = false;
  const f = await fixture(t, { upstream: () => {
    const value = { ...completed(), status: 'failed' };
    return new Response(stream ? sse(failed ? [{ type: 'response.failed', response: value }] : events().slice(0, 5)) : JSON.stringify(value),
      { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
  } });
  for (failed of [false, true]) {
    const response = await f.send({ model: codexModelId(provider.id, 'flash-fixture'), stream, input: 'synthetic request' }), text = await response.text();
    if (stream) { assert.doesNotMatch(text, /event: response.completed/); assert.match(text, /event: error/); }
    else assert.equal(response.status, 502);
    assert.equal(f.logs.at(-1).taskOk, false);
  }
});

test('unrelated native providers preserve response reasoning byte for byte', async t => {
  const value = JSON.stringify(completed());
  for (const baseUrl of ['https://relay.invalid', 'https://api.deepseek.com.evil.invalid']) {
    const p = { ...provider, baseUrl };
    const f = await fixture(t, { p, upstream: () => new Response(value, { headers: { 'content-type': 'application/json' } }) });
    const response = await f.send({ model: codexModelId(p.id, 'flash-fixture'), stream: false, input: 'synthetic request' });
    assert.equal(await response.text(), value);
  }
});
