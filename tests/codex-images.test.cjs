const { test } = require('node:test'), assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Router } = require('../core/router.cjs');
const { codexImagesRequest } = require('../core/http-passthrough.cjs');

async function start(t, options = {}) {
  const calls = [], logs = [], state = { providers: [], ...options.state };
  const router = new Router({ getState: () => state, log: row => logs.push(row),
    getOfficialAuth: options.getOfficialAuth,
    fetchUpstream: async (url, init, network) => {
      calls.push({ url, init, network });
      return options.response ? options.response(init) : Response.json({ data: [{ b64_json: 'fixture-image' }] });
    } });
  await router.start(0); t.after(() => router.stop());
  const base = `http://127.0.0.1:${router.port}/clients/ASS`;
  const request = (endpoint = '/v1/images/generations', init = {}) => fetch(base + endpoint, {
    method: 'POST', ...init, headers: { authorization: 'Bearer native-oauth', 'content-type': 'application/json', ...init.headers },
    body: init.method === 'GET' ? undefined : init.body || '{ "model": "gpt-image-2", "prompt": "fixture" }',
  });
  return { router, calls, logs, state, request, base };
}

test('Codex image generation and editing preserve native requests and large image results on the official route', async t => {
  const image = 'a'.repeat(2 * 1024 * 1024), raw = `{ "data": [{ "b64_json": "${image}" }], "output_format": "png" }`;
  const { request, calls, logs } = await start(t, { response: () => new Response(raw, { headers: {
    'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '1', 'x-request-id': 'image-request',
  } }) });
  for (const endpoint of ['generations', 'edits']) {
    const body = Buffer.from('{ "prompt": "图片", "model": "gpt-image-2", "background": "transparent", "images": [{"image_url":"data:image/png;base64,AAAA"}] }');
    const result = await request('/v1/images/' + endpoint, { body: zlib.gzipSync(body), headers: {
      'content-encoding': 'gzip', 'chatgpt-account-id': 'native-account', 'user-agent': 'native-codex',
      'x-codex-image-turn-id': 'turn-fixture', 'openai-beta': 'image-fixture', cookie: 'local-only',
    } });
    assert.equal(result.status, 200); assert.equal(await result.text(), raw);
    assert.equal(result.headers.get('x-request-id'), 'image-request');
    assert.equal(result.headers.get('content-encoding'), null); assert.equal(result.headers.get('content-length'), null);
    const call = calls.at(-1);
    assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/images/' + endpoint);
    assert.equal(call.network, 'system'); assert.equal(call.init.method, 'POST'); assert.deepEqual(call.init.body, body);
    assert.equal(call.init.headers.authorization, 'Bearer native-oauth');
    assert.equal(call.init.headers['chatgpt-account-id'], 'native-account');
    assert.equal(call.init.headers['x-codex-image-turn-id'], 'turn-fixture');
    assert.equal(call.init.headers['user-agent'], 'native-codex'); assert.equal(call.init.headers.cookie, undefined);
  }
  assert.equal(logs.length, 2); assert.ok(logs.every(row => row.source === 'OpenAI 官方图片' && row.ok));
  assert.ok(!JSON.stringify(logs).includes('native-oauth')); assert.ok(!JSON.stringify(logs).includes(image));
});

test('image edits preserve multipart boundaries and binary bytes without Responses conversion', async t => {
  const { request, calls } = await start(t);
  const bytes = Buffer.concat([Buffer.from('--boundary\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\n\r\n'),
    Buffer.from([0, 255, 128, 13, 10]), Buffer.from('\r\n--boundary--\r\n')]);
  const result = await request('/v1/images/edits', { body: bytes, headers: { 'content-type': 'multipart/form-data; boundary=boundary' } });
  assert.equal(result.status, 200); await result.text();
  assert.deepEqual(calls[0].init.body, bytes);
  assert.equal(calls[0].init.headers['content-type'], 'multipart/form-data; boundary=boundary');
});

test('official image OAuth replacement never leaks local credentials or stale account identity', async t => {
  const token = 'd'.repeat(64);
  const { request, calls } = await start(t, { state: { gatewayAuth: true, localToken: token },
    getOfficialAuth: async () => ({ authorization: 'Bearer current-oauth', 'chatgpt-account-id': 'current-account' }) });
  const result = await request(undefined, { headers: { authorization: 'Bearer ' + token, 'chatgpt-account-id': 'stale-account' } });
  assert.equal(result.status, 200); await result.text();
  assert.equal(calls[0].init.headers.authorization, 'Bearer current-oauth');
  assert.equal(calls[0].init.headers['chatgpt-account-id'], 'current-account');
  assert.ok(!JSON.stringify(calls[0]).includes(token));
});

test('accountless, missing, API-only and stale local credentials cannot invoke official images', async t => {
  const { request, calls, state, router } = await start(t);
  for (const [authorization, status] of [['', 401], ['Bearer ' + router.clientToken, 403], ['Bearer ' + 'a'.repeat(64), 401]]) {
    const response = await request(undefined, { headers: { authorization } });
    assert.equal(response.status, status); await response.text();
  }
  state.accountless = true;
  const response = await request(); assert.equal(response.status, 401); await response.text();
  assert.equal(calls.length, 0);
});

test('an unavailable official grant cannot forward the local gateway bearer to images', async t => {
  const token = 'c'.repeat(64);
  const { request, calls } = await start(t, { state: { gatewayAuth: true, localToken: token },
    getOfficialAuth: async () => ({ authorization: 'Bearer ' + token }) });
  const response = await request(undefined, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 401); await response.text(); assert.equal(calls.length, 0);
});

test('image errors retain upstream status, complete body and diagnostics with credentials redacted', async t => {
  const token = 'b'.repeat(64), oauth = 'private-image-oauth';
  const { request, logs } = await start(t, { state: { gatewayAuth: true, localToken: token },
    getOfficialAuth: async () => ({ authorization: 'Bearer ' + oauth }),
    response: () => new Response(`<html><title>Denied</title>${token}|${oauth}</html>`, {
      status: 429, headers: { 'content-type': 'text/html', 'retry-after': '60', 'x-request-id': 'upstream-image' },
    }) });
  const result = await request(undefined, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '60');
  assert.equal(await result.text(), '<html><title>Denied</title>[REDACTED]|[REDACTED]</html>');
  assert.equal(logs[0].ok, false); assert.equal(logs[0].httpStatus, 429);
  assert.ok(!JSON.stringify(logs).includes(oauth));
});

test('image routing is limited to exact native POST endpoints and the Codex client', async t => {
  const { request, calls, base } = await start(t);
  for (const endpoint of ['/v1/images', '/v1/images/generations?target=other', '/v1/images/generations/extra', '/v1/images/../responses'])
    assert.equal(codexImagesRequest(endpoint, 'POST'), null);
  assert.equal(codexImagesRequest('/v1/images/generations', 'GET'), null);
  assert.equal((await request('/v1/images/generations', { method: 'GET' })).status, 404);
  assert.equal((await fetch(base.replace('/clients/ASS', '/clients/claude') + '/v1/images/generations', {
    method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}',
  })).status, 404);
  assert.equal(calls.length, 0);
});
