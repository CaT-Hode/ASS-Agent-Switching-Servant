// Installed Codex image tool against synthetic OAuth and local transports only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), zlib = require('node:zlib');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { makeCatalog } = require('../core/models.cjs');
const { Router } = require('../core/router.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-codex-images-'));
const home = path.join(root, 'home'), codex = path.join(home, '.codex');
fs.mkdirSync(codex, { recursive: true });
const executable = process.env.ASS_QA_CODEX_BIN;
assert.ok(executable && fs.existsSync(executable), 'Set ASS_QA_CODEX_BIN to the installed Codex binary');
const requests = [], events = [], pending = new Map();
const incoming = [], routed = [];
const customProvider = process.argv.includes('--custom-provider');
let child, router, serial = 0, stderr = '', toolName, operation = 'generations';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout: ' + stderr.slice(-2000))); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    const decode = { zstd: zlib.zstdDecompressSync, gzip: zlib.gunzipSync }[req.headers['content-encoding']];
    if (decode) bytes = decode(bytes);
    const body = bytes.length ? JSON.parse(bytes) : {};
    requests.push({ path: req.url, body, headers: req.headers });
    if (req.url.includes('/images/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ created: 1760000000, data: [{ b64_json: png }], output_format: 'png' })); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"data":[],"models":[]}'); return; }
    const tools = body.tools || body.input?.filter(i => i.type === 'additional_tools').flatMap(i => i.tools) || [];
    const imageTool = tools.find(t => /image/.test(t.name || ''));
    if (imageTool) {
      toolName = imageTool.tools ? imageTool.name + '.' + imageTool.tools[0].name : imageTool.name;
      fs.writeFileSync(path.join(root, 'tool.json'), JSON.stringify(imageTool, null, 2));
    }
    const callId = 'call_image_' + operation;
    const used = body.input?.some(i => i.call_id === callId && (i.type === 'function_call_output' || i.type === 'custom_tool_call_output'));
    const codeMode = !toolName && JSON.stringify(body).includes('image_gen__imagegen');
    const args = { prompt: 'A single blue square', transparent_background: false,
      ...(operation === 'edits' ? { referenced_image_paths: [path.join(root, 'source.png')] } : {}) };
    const item = !used && (toolName || codeMode)
      ? codeMode ? { type: 'custom_tool_call', id: 'fc_image_' + operation, call_id: callId, name: 'exec', namespace: 'functions', input: 'const r = await tools.image_gen__imagegen(' + JSON.stringify(args) + '); generatedImage(r);' }
      : { type: 'function_call', id: 'fc_image_' + operation, call_id: callId, name: toolName, arguments: JSON.stringify(args) }
      : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
    const response = { id: 'resp_' + requests.length, object: 'response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 } };
    const stream = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    res.setHeader('content-type', 'text/event-stream'); res.end(stream.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  router = new Router({ getState: () => ({ providers: [] }), fetchUpstream: async (url, init, network) => {
    assert.ok(url.startsWith('https://chatgpt.com/backend-api/codex/'), 'Unexpected upstream ' + url);
    routed.push({ url, network });
    return fetch(base + new URL(url).pathname, init);
  } });
  const handle = router.handle.bind(router);
  router.handle = (req, res) => { incoming.push(req.url); return handle(req, res); };
  await router.start(0);
  const modelBase = `http://127.0.0.1:${router.port}/clients/ASS/v1`;
  fs.writeFileSync(path.join(codex, 'config.toml'), `model="gpt-6.1-sol"\nopenai_base_url="${modelBase}"\nchatgpt_base_url="${base}/backend-api/"\n` +
    (customProvider ? `model_provider="ASS"\n[model_providers.ASS]\nname="ASS"\nbase_url="${modelBase}"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n` : '') +
    `[features]\nimage_generation=true\n`);
  fs.writeFileSync(path.join(root, 'source.png'), Buffer.from(png, 'base64'));
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'fixture', exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'qa-account', chatgpt_plan_type: 'pro' } })).toString('base64url') + '.fixture';
  fs.writeFileSync(path.join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-refresh', account_id: 'qa-account' }, last_refresh: new Date().toISOString() }));
  fs.writeFileSync(path.join(codex, 'models_cache.json'), JSON.stringify({ models: makeCatalog([], []).models }));
  const env = { ...process.env, CODEX_HOME: codex, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'),
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-20000); });
  createInterface({ input: child.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } else events.push(m);
  });
  await rpc('initialize', { clientInfo: { name: 'ass_image_qa', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const thread = await rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  for (operation of ['generations', 'edits']) {
    const turn = await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Use image_gen.imagegen: ' + operation }] });
    const deadline = Date.now() + 45000;
    while (!events.some(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id)) {
      if (Date.now() > deadline) throw Error('Turn timeout: ' + stderr.slice(-2000));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id).params.turn.status, 'completed');
    const output = requests.filter(r => r.path.endsWith('/responses')).at(-1).body.input.find(i => i.call_id === 'call_image_' + operation && /call_output/.test(i.type));
    assert.ok(output, 'Missing image tool output');
    assert.ok(!JSON.stringify(output).includes('Script error'), JSON.stringify(output));
  }
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ incoming, routed, requests, events }, null, 2));
  for (const endpoint of ['generations', 'edits']) {
    assert.ok(incoming.includes('/clients/ASS/v1/images/' + endpoint));
    const image = requests.find(r => r.path === '/backend-api/codex/images/' + endpoint);
    assert.ok(image, 'Native image request did not reach official endpoint');
    assert.equal(image.body.model, 'gpt-image-2');
    assert.equal(image.headers['chatgpt-account-id'], 'qa-account');
    assert.ok(image.headers['x-codex-image-turn-id']);
    if (endpoint === 'edits') assert.ok(image.body.images[0].image_url.startsWith('data:image/png;base64,'));
  }
  const generated = path.join(codex, 'generated_images');
  const files = fs.readdirSync(generated, { recursive: true }).filter(f => f.endsWith('.png'));
  assert.equal(files.length, 2);
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(generated, file)), Buffer.from(png, 'base64'));
  console.log(JSON.stringify({ passed: true, root, modelProvider: thread.thread.modelProvider, customProvider, generation: true, editing: true, savedImages: 2, realCloudCalls: 0 }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const p of pending.values()) clearTimeout(p.timer);
  child?.stdin.end();
  if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); });
  await router?.stop(); server.closeAllConnections(); server.close();
});
