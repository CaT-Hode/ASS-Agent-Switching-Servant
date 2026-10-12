const http = require('node:http');
async function mock({ multiBlock = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    let body; try { body = JSON.parse(text); } catch { body = {}; }
    requests.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], body });
    const content = 'ASS_CONTRACT_OK';
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [] })); return; }
    if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":8}'); return; }
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl_contract', object: 'chat.completion', created: 1760000000, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })); return;
    }
    res.setHeader('content-type', 'text/event-stream');
    if (req.url.includes('messages')) {
      emit('message_start', { message: { id: 'msg_contract', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
      for (const [index, text] of (multiBlock ? ['NATIVE_BLOCK_ZERO 中文', 'NATIVE_BLOCK_ONE'] : [content]).entries()) {
        emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index, delta: { type: 'text_delta', text } });
        emit('content_block_stop', { index });
      }
      emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }); emit('message_stop', {});
    } else if (req.url.includes('responses')) {
      const response = { id: 'resp_contract', object: 'response', status: 'completed', model: body.model,
        output: [{ id: 'msg_contract', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } };
      const events = [['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } }],
        ['response.content_part.added', { item_id: 'msg_contract', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
        ['response.output_text.delta', { item_id: 'msg_contract', output_index: 0, content_index: 0, delta: content }],
        ['response.output_text.done', { item_id: 'msg_contract', output_index: 0, content_index: 0, text: content }],
        ['response.output_item.done', { output_index: 0, item: response.output[0] }], ['response.completed', { response }]];
      events.forEach(([type, data], sequence_number) => emit(type, { ...data, sequence_number }));
    } else {
      for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) res.write('data: ' + JSON.stringify({
        id: 'chatcmpl_contract', object: 'chat.completion.chunk', created: 1760000000, model: body.model,
        choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, requests, base: `http://127.0.0.1:${server.address().port}/v1` };
}
module.exports = { mock };
