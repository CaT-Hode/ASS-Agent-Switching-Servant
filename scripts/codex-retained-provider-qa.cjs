// Installed app-server, isolated home, synthetic OAuth and local model endpoints.
// Exercises an existing built-in OpenAI thread after ASS injection, not just a
// newly created ASS thread. No real credentials, conversations or cloud calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { ConfigManager, atomic } = require('../core/config.cjs');
const { Router } = require('../core/router.cjs');
const { normalizeProvider, makeCatalog, codexModelId } = require('../core/models.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-retained-provider-'));
const codex = path.join(root, 'codex'), data = path.join(root, 'data');
fs.mkdirSync(codex); fs.mkdirSync(data);
const binaries = path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin');
const executable = process.env.ASS_QA_CODEX_BIN || fs.readdirSync(binaries).map(d => path.join(binaries, d, 'codex.exe')).find(fs.existsSync);
const provider = normalizeProvider({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic', models: [{ model: 'mimo', wireApi: 'openai-responses' }] });
const nativeModels = makeCatalog([], []).models.slice(0, 1).map(m => ({ ...m, slug: 'gpt-6.1-sol', display_name: 'GPT fixture' }));
const upstreamCalls = [], routed = []; let child, sequence = 0, rejectOfficial = false;
const gatewayToken = 'b'.repeat(64);
let gatewayAuth = false;
function launch() {
  const env = { ...process.env, CODEX_HOME: codex };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const handle = child, pending = new Map(), events = []; let stderr = '';
  handle.stderr.on('data', b => { stderr = (stderr + b).slice(-6000); });
  createInterface({ input: handle.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(methodLabel(p.method) + ': ' + JSON.stringify(m.error))) : p.resolve(m.result); }
    else events.push(m);
  });
  return {
    rpc: (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out: ' + stderr.slice(-600))); }, 20000);
      pending.set(id, { resolve, reject, timer, method }); handle.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }),
    notify: (method, params) => handle.stdin.write(JSON.stringify({ method, params }) + '\n'),
    completed: async id => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const e = events.find(e => e.method === 'turn/completed' && e.params.turn.id === id);
        if (e) { assert.equal(e.params.turn.status, 'completed', JSON.stringify(e.params.turn.error)); return; }
        await new Promise(r => setTimeout(r, 30));
      }
      throw Error('completion timed out: ' + stderr.slice(-600));
    },
    failed: async id => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const e = events.find(e => e.method === 'turn/completed' && e.params.turn.id === id);
        if (e) { assert.equal(e.params.turn.status, 'failed'); return; }
        await new Promise(r => setTimeout(r, 30));
      }
      throw Error('expected quota failure timed out');
    },
    close: async () => { handle.stdin.end(); await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { handle.kill(); reject(Error('fixture failed to exit')); }, 5000);
      handle.once('exit', () => { clearTimeout(timer); resolve(); });
    }); if (child === handle) child = null; },
  };
}
function methodLabel(method) { return method || 'app-server RPC'; }
const server = http.createServer(async (req, res) => {
  // Account/workspace discovery is a separate read-only surface from the
  // model catalog. Return an empty discovery document so the fixture cannot
  // accidentally make the app-server interpret catalog rows as workspace
  // routing data.
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  let bytes = Buffer.concat(chunks); const z = require('node:zlib');
  const decoder = { zstd: z.zstdDecompressSync, gzip: z.gunzipSync, br: z.brotliDecompressSync, deflate: z.inflateSync }[req.headers['content-encoding']];
  if (decoder) bytes = decoder(bytes);
  const body = JSON.parse(bytes); upstreamCalls.push({ path: req.url, body });
  const message = { type: 'message', id: 'msg_fixture_' + upstreamCalls.length, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] };
  const response = { id: 'resp_fixture_' + upstreamCalls.length, object: 'response', model: body.model, status: 'completed', output: [message], usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'fixture answer' },
    { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response }]
    .map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
});
server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
const router = new Router({ getState: () => ({ providers: [provider], gatewayAuth, localToken: gatewayToken }),
  getOfficialAuth: async () => ({ authorization: 'Bearer synthetic-official', 'chatgpt-account-id': 'fixture-account' }),
  fetchUpstream: async (url, init) => {
  routed.push({ url, model: JSON.parse(init.body).model });
  if (gatewayAuth) assert.notEqual(init.headers.authorization, 'Bearer ' + gatewayToken);
  if (rejectOfficial && url.includes('chatgpt.com')) return Response.json({ error: { message: 'Official quota exhausted', type: 'usage_limit_reached' } }, { status: 429 });
  return fetch(`http://127.0.0.1:${server.address().port}/mock/responses`, init);
} });
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await router.start(0);
  const port = server.address().port;
  atomic(path.join(codex, 'config.toml'), `model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\nchatgpt_base_url = "http://127.0.0.1:${port}/backend-api/"\n`);
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 86400,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'pro' } })).toString('base64url') + '.fixture';
  atomic(path.join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-refresh', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() }));
  atomic(path.join(codex, 'models_cache.json'), JSON.stringify({ models: nativeModels }));
  let client = launch(); await client.rpc('initialize', { clientInfo: { name: 'ass_retained_provider_qa', version: '1' } }); client.notify('initialized', {});
  const started = await client.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
  const id = started.thread.id; const first = await client.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'original fixture question' }] }); await client.completed(first.turn.id); await client.close();
  const config = new ConfigManager(codex, data, router.port); atomic(config.catalog, JSON.stringify(makeCatalog(nativeModels, [provider])));
  const attached = config.prepareAttach({ model: codexModelId(provider.id, 'mimo'), effort: 'medium' }, gatewayToken, false);
  atomic(config.record, JSON.stringify({ replaced: attached.replaced, blocks: attached.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
  atomic(config.file, attached.text);
  client = launch(); await client.rpc('initialize', { clientInfo: { name: 'ass_retained_provider_qa', version: '1' } }); client.notify('initialized', {});
  const account = await client.rpc('account/read', { refreshToken: false });
  assert.equal(account.requiresOpenaiAuth, false); assert.equal(account.account, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(codex, 'auth.json'))).tokens.access_token, token);
  const resumed = await client.rpc('thread/resume', { threadId: id });
  // This isolated model-only process exercises the retained thread without
  // asking the synthetic OAuth fixture to refresh against a real service.
  for (const model of [codexModelId(provider.id, 'mimo')]) {
    const before = routed.length;
    const turn = await client.rpc('turn/start', { threadId: id, model, input: [{ type: 'text', text: 'continue fixture question' }] }); await client.completed(turn.turn.id);
    assert.ok(routed.length > before, 'retained ' + resumed.thread.modelProvider + ' provider bypassed ASS for ' + model + '; paths=' + upstreamCalls.map(c => c.path).join(','));
    const request = upstreamCalls.findLast(c => Array.isArray(c.body.input));
    assert.ok(JSON.stringify(request?.body.input).includes('original fixture question'));
  }
  await client.close(); console.log(JSON.stringify({ passed: true, oldProvider: resumed.thread.modelProvider,
    nativeAccountRead: { accountVisible: !!account.account, requiresOpenaiAuth: account.requiresOpenaiAuth },
    resumedThirdPartyMessageCompleted: true, oauthPreserved: true, routed, realCloudCalls: 0, root }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { child?.kill(); await router.stop(); server.closeAllConnections(); server.close(); });
