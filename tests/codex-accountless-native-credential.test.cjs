const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Router } = require('../core/router.cjs');
const { CodexOfficialAuth } = require('../core/codex-official-auth.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');

const localToken = 'a'.repeat(64);
const nativeGrant = 'header.payload.signature';
const injected = codexModelId('relay', 'chat');
const provider = normalizeProvider({ id: 'relay', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'provider-key',
  models: [{ model: 'chat', wireApi: 'openai-responses' }] });

async function fixture(t, { accountless = true, withNative = true } = {}) {
  const state = { providers: [provider], accountless, localToken };
  const calls = [], logs = [];
  const router = new Router({
    getState: () => state,
    getNativeCredential: withNative ? () => nativeGrant : undefined,
    log: entry => logs.push(entry),
    fetchUpstream: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ id: 'response-fixture', object: 'response', status: 'completed', output: [] });
    },
  });
  await router.start(0);
  t.after(() => router.stop());
  const base = `http://127.0.0.1:${router.port}`;
  const request = (credential, body, url = '/clients/ASS/v1/responses', method = 'POST') => fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { state, calls, logs, request };
}

test('accountless mode accepts the current native Codex grant for injected models only', async t => {
  const f = await fixture(t);
  const response = await f.request(nativeGrant, { model: injected, input: [], stream: false });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  // The native grant authenticates the local client; the upstream request must
  // use the provider credential and never echo the grant.
  assert.equal(f.calls[0].headers.authorization, 'Bearer provider-key');
  assert.equal(f.calls[0].body.model, 'chat');
  assert.ok(!JSON.stringify(f.calls).includes(nativeGrant));
  // Injected models still require the local accountless token, which a window
  // created after the switch sends instead.
  const local = await f.request(localToken, { model: injected, input: [], stream: false });
  assert.equal(local.status, 200); assert.equal(f.calls.length, 2);
});

test('accountless mode keeps rejecting unknown credentials and official models', async t => {
  const f = await fixture(t);
  const foreign = await f.request('other.header.signature', { model: injected, input: [], stream: false });
  assert.equal(foreign.status, 401);
  assert.match((await foreign.json()).error.message, /新建对话/);
  const staleLocal = await f.request('c'.repeat(64), { model: injected, input: [], stream: false });
  assert.equal(staleLocal.status, 401);
  assert.match((await staleLocal.json()).error.message, /本机接入凭据已变化/);
  const broken = await f.request('not-a-credential', { model: injected, input: [], stream: false });
  assert.equal(broken.status, 401);
  assert.match((await broken.json()).error.message, /重新启动客户端/);
  // A retained native grant never unlocks subscription routes in accountless mode.
  const official = await f.request(nativeGrant, { model: 'gpt-6.1-sol', input: [], stream: false });
  assert.equal(official.status, 403);
  assert.match((await official.json()).error.message, /仅允许使用已注入的模型/);
  assert.equal(f.calls.length, 0);
});

test('accountless mode never forwards official account requests, with or without the native grant', async t => {
  const f = await fixture(t);
  for (const credential of [localToken, nativeGrant]) {
    const response = await f.request(credential, null, '/clients/ASS/backend-api/wham/settings/user', 'GET');
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /不转发官方账户请求/);
  }
  assert.equal(f.calls.length, 0);
});

test('accountless mode accepts the native grant on scoped model discovery but not without one', async t => {
  const f = await fixture(t);
  const discovered = await f.request(nativeGrant, null, '/clients/ASS/models/v1/models', 'GET');
  assert.equal(discovered.status, 200);
  assert.ok((await discovered.json()).data.length > 0);
  const foreign = await f.request('other.header.signature', null, '/clients/ASS/models/v1/models', 'GET');
  assert.equal(foreign.status, 401);
});

test('accountless mode rejects the grant as unknown when no native grant is readable', async t => {
  const f = await fixture(t, { withNative: false });
  const response = await f.request(nativeGrant, { model: injected, input: [], stream: false });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /新建对话/);
  assert.equal(f.calls.length, 0);
});

test('native grant snapshot is read-only and only returns an existing ChatGPT access token', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-native-grant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = new CodexOfficialAuth(root);
  assert.equal(auth.currentAccessToken(), '');
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: nativeGrant, refresh_token: 'fixture' } }));
  assert.equal(auth.currentAccessToken(), nativeGrant);
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'provider-key' }));
  assert.equal(auth.currentAccessToken(), '');
  fs.writeFileSync(path.join(root, 'auth.json'), '{"tokens":');
  assert.equal(auth.currentAccessToken(), '');
});
