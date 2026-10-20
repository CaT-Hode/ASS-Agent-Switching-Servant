// Reproduce the reported accountless Codex failure with the installed app-server
// binary: a conversation started while the built-in OpenAI provider owned it
// (prediction compatibility, or any pre-accountless attempt) keeps that provider
// after ASS switches to accountless mode, so its later turns reach ASS with the
// ChatGPT OAuth bearer instead of the local accountless token. ASS used to
// reject that request before routing, leaving the UI with
// "unexpected status 401 Unauthorized: 无账号模式已启用…".
//
// Requires an installed Codex binary; no real accounts, conversations or cloud
// calls (synthetic OAuth fixture, refresh/upstream mocks, blocked network).
//   node scripts/codex-accountless-retained-qa.cjs [--keep]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { mock } = require('./native-contract/mock.cjs');
const { Router } = require('../core/router.cjs');
const { ConfigManager } = require('../core/config.cjs');
const { normalizeProvider, makeCatalog, codexModelId } = require('../core/models.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-accountless-retained-'));
const home = path.join(root, 'home'), codex = path.join(home, '.codex'), data = path.join(root, 'data'), work = path.join(root, 'work');
for (const dir of [codex, data, work]) fs.mkdirSync(dir, { recursive: true });
const binaries = path.join(process.env.LOCALAPPDATA || '', 'OpenAI/Codex/bin');
const executable = process.env.ASS_QA_CODEX_BIN || fs.readdirSync(binaries)
  .map(dir => path.join(binaries, dir, 'codex.exe')).filter(file => fs.existsSync(file))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.ok(executable, 'Installed Codex binary not found');

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let grantSerial = 0;
function nativeToken() {
  const serial = ++grantSerial;
  return b64({ alg: 'RS256', typ: 'JWT', kid: 'qa' }) + '.' + b64({ sub: 'qa-user', exp: 4102444800, iat: 1760000000 + serial,
    email: 'qa@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'qa-account', chatgpt_plan_type: 'plus', chatgpt_user_id: 'qa-user' } }) + '.qa-signature-' + serial;
}
const provider = normalizeProvider({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-provider-key',
  models: [{ model: 'fixture-model', wireApi: 'openai-responses', defaultEffort: 'medium', contextWindow: 64000, maxOutputTokens: 1024 }] });
const model = codexModelId(provider.id, 'fixture-model');
const localToken = crypto.randomBytes(32).toString('hex');
const gatewayToken = 'b'.repeat(64);
const state = { providers: [provider], gatewayAuth: true, localToken: gatewayToken };
const incoming = [], routed = [], requestLog = [], refreshes = [];
let router, mockServer, authServer, client;

function currentGrant() {
  try { return JSON.parse(fs.readFileSync(path.join(codex, 'auth.json'), 'utf8')).tokens.access_token || ''; } catch { return ''; }
}
function environment(refreshUrl) {
  const env = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    CODEX_HOME: codex, CI: '1', NO_COLOR: '1', TERM: 'dumb', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: refreshUrl,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
  };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  fs.mkdirSync(env.TEMP, { recursive: true });
  return env;
}
function launch(refreshUrl) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env: environment(refreshUrl), cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), events = []; let sequence = 0, stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-200000); });
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Error(request.method + ': ' + JSON.stringify(message.error))) : request.resolve(message.result);
    } else events.push(message);
  });
  return {
    rpc: (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out: ' + stderr.slice(-3000))); }, 45000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }),
    notify: (method, params) => child.stdin.write(JSON.stringify({ method, params }) + '\n'),
    completed: async id => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const event = events.find(e => e.method === 'turn/completed' && e.params.turn.id === id);
        if (event) { assert.equal(event.params.turn.status, 'completed', JSON.stringify(event.params.turn.error) + '\n' + stderr.slice(-4000)); return event; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error('turn completion timed out: ' + stderr.slice(-4000));
    },
    events,
    stderr: () => stderr,
    close: async () => {
      child.stdin.end();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('app-server did not exit')); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
async function startSession(refreshUrl) {
  const session = launch(refreshUrl);
  await session.rpc('initialize', { clientInfo: { name: 'ass_accountless_retained_qa', version: '1' } });
  session.notify('initialized', {});
  return session;
}
const output = value => path.join(root, 'evidence-' + Date.now() + '-' + value + '.json');
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
(async () => {
  mockServer = await mock();
  authServer = http.createServer(async (request, response) => {
    let raw = ''; for await (const bytes of request) raw += bytes;
    refreshes.push({ url: request.url, body: raw.slice(0, 2000) });
    const token = nativeToken();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: token, id_token: token, refresh_token: 'qa-refresh-' + grantSerial, expires_in: 3600, token_type: 'Bearer' }));
  });
  await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
  const refreshUrl = `http://127.0.0.1:${authServer.address().port}/oauth/token`;
  router = new Router({
    getState: () => state,
    log: entry => requestLog.push(entry),
    fetchUpstream: async (url, init) => {
      const body = JSON.parse(init.body);
      routed.push({ phase: state.accountless ? 'accountless' : 'gateway', url, authorization: init.headers.authorization, model: body.model });
      return fetch(`http://127.0.0.1:${mockServer.server.address().port}/mock/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body });
    },
    // Read-only view of the current native grant, exactly like the app wiring.
    getNativeCredential: () => currentGrant(),
    getOfficialAuth: async () => ({ authorization: 'Bearer ' + currentGrant(), 'chatgpt-account-id': 'qa-account' }),
  });
  const handle = router.handle.bind(router);
  router.handle = (request, response) => {
    incoming.push({ url: request.url, authorization: request.headers.authorization });
    return handle(request, response);
  };
  await router.start(0);
  const initialGrant = nativeToken();
  write(path.join(codex, 'auth.json'), { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: initialGrant, access_token: initialGrant, refresh_token: 'qa-refresh', account_id: 'qa-account' },
    last_refresh: new Date().toISOString() });
  // A native baseline, then the gateway + prediction-compatibility attachment:
  // the model is an injected ASS model, but the built-in OpenAI provider owns
  // the conversation's provider id.
  write(path.join(codex, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n');
  const config = new ConfigManager(codex, data, router.port);
  // Only the injected model: this Codex version validates every catalog row and
  // the fixture has no real official model metadata.
  const catalog = makeCatalog([], [provider]);
  catalog.models = catalog.models.filter(entry => entry.slug.includes('::'));
  write(config.catalog, JSON.stringify(catalog));
  const save = attachment => write(config.record, { replaced: attachment.replaced,
    blocks: attachment.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) });
  const gateway = config.prepareAttach({ model, effort: 'medium' }, gatewayToken, true, true);
  save(gateway); write(config.file, gateway.text);

  client = await startSession(refreshUrl);
  const started = await client.rpc('thread/start', { cwd: work, model, approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started.thread.id;
  assert.equal(started.thread.modelProvider, 'openai', 'fixture conversation did not start on the built-in provider');
  const first = await client.rpc('turn/start', { threadId, model, input: [{ type: 'text', text: 'first fixture question' }] });
  await client.completed(first.turn.id);
  const firstStderr = client.stderr();
  await client.close(); client = null;
  write(output('phase1'), { threadId, started, routed, refreshes, stderr: firstStderr });

  // ASS switches this client to accountless mode; the conversation is unchanged.
  state.gatewayAuth = false; state.accountless = true; state.localToken = localToken;
  const attachment = config.prepareAttach({ model, effort: 'medium' }, localToken, false, false);
  save(attachment); write(config.file, attachment.text);

  client = await startSession(refreshUrl);
  const resumed = await client.rpc('thread/resume', { threadId });
  assert.equal(resumed.thread.modelProvider, 'openai', 'fixture conversation lost its retained provider on resume');
  const second = await client.rpc('turn/start', { threadId, model, input: [{ type: 'text', text: 'continue fixture question' }] });
  await client.completed(second.turn.id);
  const stderr = client.stderr(); await client.close(); client = null;
  write(output('phase2'), { threadId, resumed, routed, incoming, refreshes, stderr });

  const accountless = routed.filter(row => row.phase === 'accountless');
  const rejection = requestLog.findLast(entry => entry.status === 401);
  assert.ok(accountless.length, 'resumed conversation never reached ASS' + (rejection ? ': ' + rejection.error : '\n' + stderr.slice(-4000)));
  assert.equal(accountless[0].model, 'fixture-model', 'resumed turn was not rerouted to the injected upstream');
  // The retained conversation authenticates with the native ChatGPT grant from
  // auth.json (refreshed through the native path), never with the local token.
  const resumedRequest = incoming.filter(row => /\/v1\/responses$/.test(row.url)).at(-1);
  assert.ok(resumedRequest, 'resumed turn never reached the ASS /v1/responses route');
  assert.equal(resumedRequest.authorization, 'Bearer ' + currentGrant(), 'retained conversation did not present the current native credential');
  assert.notEqual(resumedRequest.authorization, 'Bearer ' + localToken, 'fixture unexpectedly used the accountless token');
  // That credential authenticates only the local client. The upstream request
  // must use the provider key and the native credential must never be forwarded.
  assert.ok(accountless.every(row => row.authorization === 'Bearer synthetic-provider-key'), 'upstream did not receive the provider key');
  assert.ok(!JSON.stringify(routed).includes(currentGrant()), 'native credential leaked upstream');
  console.log(JSON.stringify({ passed: true, model, threadId, retainedProvider: resumed.thread.modelProvider,
    accountlessCredential: 'current native ChatGPT OAuth (refreshed natively)', refreshes: refreshes.length,
    routed: routed.map(({ phase, model, url }) => ({ phase, model, url })), cloudCalls: 0, root }, null, 2));
})().catch(error => { console.error(error.message); if (root) console.error('Evidence: ' + root); process.exitCode = 1; })
  .finally(async () => {
    process.argv.includes('--keep') ? console.log('Kept: ' + root) : fs.rmSync(root, { recursive: true, force: true });
    try { await client?.close(); } catch {}
    await router?.stop();
    mockServer?.server.close(); mockServer?.server.closeAllConnections?.();
    authServer?.close(); authServer?.closeAllConnections?.();
  });
