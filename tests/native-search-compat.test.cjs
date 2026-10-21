const { test } = require('node:test'), assert = require('node:assert/strict');
const { convertRequest } = require('../core/adapters.cjs');
const { Router } = require('../core/router.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const body = { model: 'gemini-fixture', instructions: 'Keep the document facts.', input: 'Rewrite the document.',
  tools: [{ type: 'web_search' }, { type: 'function', name: 'read_file', parameters: { type: 'object' } }] };

test('optional native search does not block cross-protocol document work and is explicitly marked unavailable', () => {
  const before = structuredClone(body);
  for (const protocol of ['anthropic', 'openai-chat']) {
    const request = convertRequest(body, {}, protocol);
    assert.equal(request.tools.length, 1);
    assert.equal(protocol === 'anthropic' ? request.tools[0].name : request.tools[0].function.name, 'read_file');
    const instructions = protocol === 'anthropic' ? request.system : request.messages[0].content;
    assert.match(instructions, /Keep the document facts/);
    assert.match(instructions, /Native web search is unavailable/);
    assert.match(instructions, /do not claim to have searched/);
  }
  assert.deepEqual(body, before);
});

test('forced search and unknown native tools return capability errors rather than pretending to execute them', () => {
  for (const protocol of ['anthropic', 'openai-chat']) {
    for (const choice of [{ type: 'web_search' }, { type: 'web_search_preview' }, 'required']) {
      const request = { ...body, tools: [{ type: 'web_search' }], tool_choice: choice };
      assert.throws(() => convertRequest(request, {}, protocol), error => error.status === 400 && /网页搜索/.test(error.message));
    }
    assert.throws(() => convertRequest({ ...body, tools: [{ type: 'image_generation' }] }, {}, protocol), error => error.status === 400);
  }
});

test('Gemini Anthropic route reaches upstream, keeps client tools, and records the unavailable search capability', async t => {
  const provider = normalizeProvider({ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-api',
    models: [{ model: 'gemini-fixture', wireApi: 'anthropic' }] });
  let sent; const logs = [];
  const router = new Router({ getState: () => ({ providers: [provider] }), log: row => logs.push(row), fetchUpstream: async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    const events = [{ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Rewritten document' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  await router.start(0); t.after(() => router.stop());
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-oauth' }, body: JSON.stringify({ ...body,
      model: codexModelId(provider.id, 'gemini-fixture'), tools: [...body.tools, {type:'namespace',name:'files',tools:[{type:'custom',name:'patch'}]}] }),
  });
  assert.equal(response.status, 200); assert.match(await response.text(), /Rewritten document/);
  assert.equal(response.headers.get('x-ass-unavailable-tools'), 'web_search');
  assert.equal(sent.url, 'https://fixture.invalid/v1/messages'); assert.equal(sent.headers['x-api-key'], 'synthetic-api');
  assert.equal(sent.headers.authorization, undefined); assert.equal(sent.body.tools.length, 2);
  assert.match(sent.body.system, /Native web search is unavailable/); assert.deepEqual(logs[0].omittedTools, ['web_search']);
});

test('Responses providers keep native search declarations and choices unchanged', async t => {
  const provider = normalizeProvider({ id: 'responses', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-api', models: [{ model: 'gemini-fixture', wireApi: 'openai-responses' }] });
  let sent;
  const router = new Router({ getState: () => ({ providers: [provider] }), fetchUpstream: async (_, init) => {
    sent = JSON.parse(init.body); return Response.json({ status: 'completed', output: [] });
  } });
  await router.start(0); t.after(() => router.stop());
  const request = { ...body, model: codexModelId(provider.id, 'gemini-fixture'), stream: false, tool_choice: { type: 'web_search' } };
  const result = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {method:'POST',headers:{authorization:'Bearer synthetic-oauth'},body:JSON.stringify(request)});
  assert.equal(result.status, 200); await result.text(); assert.deepEqual(sent.tools, body.tools);
  assert.deepEqual(sent.tool_choice, request.tool_choice); assert.equal(sent.instructions, body.instructions);
  assert.equal(result.headers.get('x-ass-unavailable-tools'), null);
});
