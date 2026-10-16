// Isolated Codex app-server probe. Verifies whether the account-visible
// provider mode can still switch to an injected model after a quota response.
// Uses only synthetic OAuth and a loopback Responses endpoint.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { prepareConfig, atomic } = require('../core/config.cjs');
const { makeCatalog, normalizeProvider, codexModelId } = require('../core/models.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-account-gateway-'));
const codex = path.join(root, 'codex');
fs.mkdirSync(codex);
const binaryRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
const binary = process.argv[2] || fs.readdirSync(binaryRoot)
  .map(entry => path.join(binaryRoot, entry, 'codex.exe'))
  .find(fs.existsSync);
if (!binary) throw Error('Codex binary not found');

const jwt = 'fixture.' + Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 86400,
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'pro' },
})).toString('base64url') + '.fixture';
fs.writeFileSync(path.join(codex, 'auth.json'), JSON.stringify({
  auth_mode: 'chatgpt',
  // Deliberately omit a selected workspace ID. Codex still reads the ChatGPT
  // account from the token but does not require workspace routing discovery.
  tokens: { id_token: jwt, access_token: jwt, refresh_token: 'synthetic-refresh' },
}));

const calls = [];
const discovery = [];
let server;
server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    discovery.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
  calls.push({ model: body.model, authorization: Boolean(req.headers.authorization) });
  if (body.model === 'gpt-6.1-sol') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'usage limit has been reached', type: 'usage_limit_reached' } }));
    return;
  }
  const response = {
    id: 'resp_fixture', object: 'response', model: body.model, status: 'completed', output: [],
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
  };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});

function writeConfig(port) {
  const providers = [normalizeProvider({ id: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic',
    models: [{ model: 'mimo', wireApi: 'openai-responses' }] })];
  const catalog = path.join(root, 'catalog.json');
  atomic(catalog, JSON.stringify(makeCatalog([{ slug: 'gpt-6.1-sol' }], providers)));
  atomic(path.join(codex, 'config.toml'), prepareConfig('', catalog,
    `http://127.0.0.1:${port}/clients/ASS/v1`,
    { model: codexModelId('fixture', 'mimo'), effort: 'medium' }, 'a'.repeat(64), true).text);
}

function launch() {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    env: { ...process.env, CODEX_HOME: codex, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map(), events = [];
  let id = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else events.push(message);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`${method} timed out`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
  const completed = async (turnId, expected) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const event = events.find(item => item.method === 'turn/completed' && item.params?.turn?.id === turnId);
      if (event) { assert.equal(event.params.turn.status, expected); return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`turn ${turnId} did not complete`);
  };
  return { child, rpc, completed };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  writeConfig(port);
  const client = launch();
  const cleanup = () => { try { client.child.kill(); } catch {} try { server.close(); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
  try {
    await client.rpc('initialize', { clientInfo: { name: 'ass_account_gateway_qa', version: '1' } });
    client.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const account = await client.rpc('account/read', { refreshToken: false });
    assert.equal(account.requiresOpenaiAuth, true);
    assert.equal(account.account?.type, 'chatgpt');
    const thread = await client.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
    const quotaTurn = await client.rpc('turn/start', { threadId: thread.thread.id, model: 'gpt-6.1-sol', input: [{ type: 'text', text: 'quota fixture' }] });
    await client.completed(quotaTurn.turn.id, 'failed');
    const thirdPartyTurn = await client.rpc('turn/start', { threadId: thread.thread.id, model: codexModelId('fixture', 'mimo'), input: [{ type: 'text', text: 'third party fixture' }] });
    await client.completed(thirdPartyTurn.turn.id, 'completed');
    assert.deepEqual(calls.filter(call => call.model).map(call => call.model), ['gpt-6.1-sol', codexModelId('fixture', 'mimo')]);
    console.log(JSON.stringify({ passed: true, fullGeneratedConfig: true, accountVisible: true,
      selectedWorkspace: false, officialQuotaFailed: true, thirdPartyAfterQuota: true, calls, realCloudInferenceCalls: 0 }));
  } finally { cleanup(); }
})().catch(error => { console.error(JSON.stringify({ error: error.message, discovery })); process.exitCode = 1; });
