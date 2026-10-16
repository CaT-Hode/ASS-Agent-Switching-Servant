const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const TOML = require('@iarna/toml');
const { Router } = require('../core/router.cjs');
const { CodexOfficialAuth, refreshNative } = require('../core/codex-official-auth.cjs');
const { prepareConfig, ConfigManager, atomic } = require('../core/config.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const token = 'a'.repeat(64);
const jwt = (exp, account = 'account-a') => 'fixture.' + Buffer.from(JSON.stringify({ exp, account })).toString('base64url') + '.signature';
function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-gateway-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('gateway keeps native OAuth visible while routing official and injected model defaults', t => {
  const root = home(t), data = path.join(root, 'data'), file = path.join(root, 'config.toml');
  const baseline = 'model="gpt-original"\n'; atomic(file, baseline);
  const config = new ConfigManager(root, data);
  const authFile = path.join(root, 'auth.json'), auth = '{"tokens":{"access_token":"preserve-exactly"}}'; atomic(authFile, auth);
  const plan = config.prepareAttach({ model: 'gpt-6.1-sol', effort: 'medium' }, token, true);
  const parsed = TOML.parse(plan.text);
  assert.equal(parsed.model_providers.ASS.requires_openai_auth, true);
  assert.equal(parsed.model_providers.ASS.experimental_bearer_token, undefined);
  assert.equal(parsed.model, 'gpt-6.1-sol');
  atomic(config.record, JSON.stringify({ replaced: plan.replaced, blocks: plan.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
  atomic(file, plan.text); config.detach();
  assert.deepEqual(TOML.parse(fs.readFileSync(file, 'utf8')), TOML.parse(baseline));
  assert.equal(fs.readFileSync(authFile, 'utf8'), auth);
  assert.throws(() => prepareConfig('', 'catalog', undefined, { model: 'gpt-6.1-sol', effort: 'medium' }, token), /默认模型/);
});
test('gateway official grant is request-scoped, refreshes through native helper and follows account switches', async t => {
  const root = home(t), file = path.join(root, 'auth.json'); let refreshed = 0;
  const save = (access, account_id) => atomic(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'synthetic-refresh', account_id } }));
  save(jwt(1), 'old');
  const auth = new CodexOfficialAuth(root, { now: () => 100000, refresh: async () => {
    refreshed++; await new Promise(r => setTimeout(r, 10)); save(jwt(999999, 'new'), 'new');
  } });
  const headers = await Promise.all([auth.headers(), auth.headers()]);
  assert.equal(refreshed, 1); assert.equal(headers[0]['chatgpt-account-id'], 'new');
  save(jwt(999999, 'switched'), 'switched');
  assert.equal((await auth.headers())['chatgpt-account-id'], 'switched');
  const failing = new CodexOfficialAuth(root, { now: () => 9999999999999, refresh: async () => { throw Error('private refresh detail'); } });
  await assert.rejects(failing.headers(), e => e.status === 401 && !e.message.includes('private'));
});
test('native grant refresh is bounded to a temporary auth-only helper with conflicting credentials removed', async t => {
  const root = home(t), { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
  let killed = 0, requests = [];
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, 'fixture-codex'); assert.ok(args.includes('model_provider="openai"'));
    assert.equal(options.env.CODEX_HOME, root); assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CUSTOM_CA, 'keep'); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { killed++; child.emit('exit', 0); };
    require('node:readline').createInterface({ input: child.stdin }).on('line', line => {
      const m = JSON.parse(line); requests.push(m);
      if (m.id) child.stdout.write(JSON.stringify({ id: m.id, ...(m.id === 2 ? { error: { message: 'private workspace failure' } } : { result: {} }) }) + '\n');
    });
    child.stdin.on('end', () => setImmediate(() => child.emit('exit', 0)));
    return child;
  };
  await refreshNative(root, { binary: 'fixture-codex', spawnProcess, env: { OPENAI_API_KEY: 'never-propagate', CUSTOM_CA: 'keep' } });
  assert.equal(requests.at(-1).method, 'account/read'); assert.equal(requests.at(-1).params.refreshToken, true);
  assert.ok(!requests.some(r => r.method.startsWith('turn/') || r.method.startsWith('thread/')));
  assert.equal(killed, 0);
});
test('depleted official quota never blocks third-party routes; no gateway credential or OAuth leaks between routes', async t => {
  const provider = normalizeProvider({ id: 'third', name: 'Third', baseUrl: 'https://third.example/v1', apiKey: 'third-party-key',
    models: [{ model: 'model-b', wireApi: 'openai-responses' }] });
  let officialReads = 0; const calls = [];
  const state = { providers: [provider], gatewayAuth: true, localToken: token };
  const router = new Router({ getState: () => state, getOfficialAuth: async () => {
    officialReads++; return { authorization: 'Bearer official-secret', 'chatgpt-account-id': 'real-account' };
  }, fetchUpstream: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return url.includes('chatgpt.com') ? Response.json({ error: { message: 'Real subscription quota exhausted' } }, { status: 429 })
      : Response.json({ id: 'response-fixture', output: [] });
  } });
  await router.start(0); t.after(() => router.stop());
  const request = model => fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'chatgpt-account-id': 'stale-client-account' },
    body: JSON.stringify({ model, input: [], stream: false }),
  });
  assert.equal((await request('gpt-6.1-sol')).status, 429);
  assert.equal(officialReads, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer official-secret');
  assert.equal(calls[0].headers['chatgpt-account-id'], 'real-account');
  assert.equal((await request(codexModelId('third', 'model-b'))).status, 200);
  assert.equal(officialReads, 1); assert.equal(calls[1].headers.authorization, 'Bearer third-party-key');
  assert.equal(calls[1].headers['chatgpt-account-id'], undefined);
  assert.equal(calls[1].body.model, 'model-b'); assert.ok(!JSON.stringify(calls).includes(token));
  state.accountless = true;
  assert.equal((await request('gpt-6.1-sol')).status, 403);
  assert.equal(calls.length, 2);
  state.accountless = false;
  const stale = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer ' + 'c'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: false }),
  });
  assert.equal(stale.status, 401); assert.equal(calls.length, 2);
});
