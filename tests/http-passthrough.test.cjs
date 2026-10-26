const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { Router } = require('../core/router.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const { forwardErrorBody, codexBootstrapRequest } = require('../core/http-passthrough.cjs');

async function start(t, options) {
  const logs = [];
  const router = new Router({ getState: () => ({ providers: [] }), log: row => logs.push(row), ...options });
  await router.start(0);
  t.after(() => router.stop());
  const url = `http://127.0.0.1:${router.port}/clients/ASS/v1/responses`;
  const request = (body = {}, headers = {}) => fetch(url, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-oauth', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gpt-fixture', input: [], stream: false, ...body }),
  });
  return { router, logs, url, request };
}

test('official requests retain native identity, extensible metadata and accept after compressed body decoding', async t => {
  let seen;
  const { router } = await start(t, { fetchUpstream: async (url, init, network) => {
    seen = { url, init, network };
    return Response.json({ id: 'fixture', output: [] });
  } });
  const payload = { model: 'gpt-fixture', stream: false, input: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'foreign' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
  ] };
  const data = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: router.port, path: '/clients/ASS/v1/responses', method: 'POST', headers: {
      authorization: 'Bearer synthetic-oauth', 'chatgpt-account-id': 'account-fixture',
      'user-agent': 'codex-desktop/0.159.2 (Windows)', accept: 'application/json',
      'accept-language': 'zh-CN', 'openai-beta': 'responses=experimental',
      session_id: 'session-fixture', conversation_id: 'conversation-fixture', originator: 'codex_desktop',
      'x-codex-turn-state': 'turn-state', 'x-codex-future-header': 'keep-new-header',
      'x-client-request-id': 'request-fixture', traceparent: '00-fixture',
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': data.length,
      connection: 'keep-alive, x-connection-only', 'x-connection-only': 'never-forward',
      'proxy-authorization': 'Basic never-forward', cookie: 'local=never-forward',
      'x-ass-probe-token': 'never-forward', 'sec-fetch-mode': 'cors', 'x-forwarded-host': 'localhost',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(data);
  });
  assert.equal(status, 200);
  assert.equal(seen.network, 'system');
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/codex/responses');
  const h = seen.init.headers;
  for (const [key, value] of Object.entries({ authorization: 'Bearer synthetic-oauth', 'chatgpt-account-id': 'account-fixture',
    'user-agent': 'codex-desktop/0.159.2 (Windows)', accept: 'application/json', 'accept-language': 'zh-CN',
    session_id: 'session-fixture', conversation_id: 'conversation-fixture', originator: 'codex_desktop',
    'openai-beta': 'responses=experimental', 'x-codex-turn-state': 'turn-state',
    'x-codex-future-header': 'keep-new-header', 'x-client-request-id': 'request-fixture', traceparent: '00-fixture' }))
    assert.equal(h[key], value, key);
  for (const key of ['host', 'connection', 'x-connection-only', 'content-encoding', 'content-length',
    'proxy-authorization', 'cookie', 'x-ass-probe-token', 'sec-fetch-mode', 'x-forwarded-host']) assert.equal(h[key], undefined, key);
  assert.deepEqual(JSON.parse(seen.init.body), { ...payload, input: [payload.input[1]] });
});

test('official JSON and compact responses preserve diagnostic, quota and extensible response headers', async t => {
  const raw = '{ "id": "fixture", "output": [], "future": { "unchanged": true } }';
  const { request, url, logs } = await start(t, { fetchUpstream: async () => new Response(raw, { headers: {
    'content-type': 'application/json', 'x-request-id': 'req-upstream', 'x-codex-primary-used-percent': '12',
    'x-ratelimit-remaining-tokens': '1234', 'x-future-header': 'preserved', 'x-ass-provider': 'spoofed',
    'content-encoding': 'gzip', 'content-length': '99999', connection: 'keep-alive, x-hop', 'x-hop': 'remove',
    'set-cookie': 'upstream=private', 'x-api-key': 'must-not-return',
  } }) });
  for (const response of [await request(), await fetch(url + '/compact', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-oauth' },
    body: JSON.stringify({ model: 'gpt-fixture', input: [] }),
  })]) {
    assert.equal(response.status, 200);
    assert.equal(await response.text(), raw);
    for (const [key, value] of Object.entries({ 'x-request-id': 'req-upstream', 'x-codex-primary-used-percent': '12',
      'x-ratelimit-remaining-tokens': '1234', 'x-future-header': 'preserved', 'x-ass-provider': 'official' }))
      assert.equal(response.headers.get(key), value, key);
    for (const key of ['content-encoding', 'content-length', 'x-hop', 'set-cookie', 'x-api-key'])
      assert.equal(response.headers.get(key), null, key);
    assert.ok(logs.some(row => row.requestId === response.headers.get('x-ass-request-id')));
  }
});

test('Codex bootstrap settings relay preserves OAuth identity and blocks arbitrary paths', async t => {
  const gatewayToken = 'c'.repeat(64);
  const calls = [];
  const { router, logs } = await start(t, {
    getState: () => ({ providers: [], gatewayAuth: true, localToken: gatewayToken }),
    getOfficialAuth: async () => ({ authorization: 'Bearer refreshed-oauth', 'chatgpt-account-id': 'current-account' }),
    fetchUpstream: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return Response.json({ account: 'ok' }, {
        headers: { 'x-request-id': 'bootstrap-fixture', 'x-codex-primary-used-percent': '4' },
      });
    },
  });
  const base = `http://127.0.0.1:${router.port}`;
  const response = await fetch(`${base}/clients/ASS/backend-api/wham/settings/user`, {
    headers: {
      authorization: 'Bearer ' + gatewayToken,
      'chatgpt-account-id': 'stale-account',
      'user-agent': 'codex-new/26.1007.21434',
      'cache-control': 'no-cache, no-store',
      cookie: 'must-not-forward',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account: 'ok' });
  assert.equal(response.headers.get('x-request-id'), 'bootstrap-fixture');
  assert.equal(response.headers.get('x-ass-provider'), 'official');
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/settings/user');
  assert.equal(calls[0].headers.authorization, 'Bearer refreshed-oauth');
  assert.equal(calls[0].headers['chatgpt-account-id'], 'current-account');
  assert.equal(calls[0].headers['user-agent'], 'codex-new/26.1007.21434');
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(logs.at(-1).source, 'OpenAI 官方账户设置');

  assert.deepEqual(codexBootstrapRequest('/backend-api/wham/accounts/check/v4-2023-04-27'), {
    path: '/wham/accounts/check/v4-2023-04-27',
    upstreamUrl: 'https://chatgpt.com/backend-api/wham/accounts/check/v4-2023-04-27',
  });
  assert.equal(codexBootstrapRequest('/backend-api/wham/tasks'), null);
  const blocked = await fetch(`${base}/clients/ASS/backend-api/wham/tasks`);
  assert.equal(blocked.status, 404);
  assert.equal(calls.length, 1);
});

test('Codex bootstrap relay returns native 403 and never forwards accountless bearer', async t => {
  const gatewayToken = 'd'.repeat(64);
  let calls = 0;
  const { router } = await start(t, {
    getState: () => ({ providers: [], gatewayAuth: true, localToken: gatewayToken }),
    getOfficialAuth: async () => ({ authorization: 'Bearer refreshed-oauth' }),
    fetchUpstream: async () => {
      calls++;
      return new Response('<html><title>cloudflare_challenge</title></html>', {
        status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'fixture-SIN' },
      });
    },
  });
  const base = `http://127.0.0.1:${router.port}`;
  const denied = await fetch(`${base}/clients/ASS/backend-api/wham/accounts/check`, {
    headers: { authorization: 'Bearer ' + gatewayToken },
  });
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), '<html><title>cloudflare_challenge</title></html>');
  assert.equal(denied.headers.get('cf-ray'), 'fixture-SIN');
  assert.equal(calls, 1);

  const accountlessRouter = new Router({
    getState: () => ({ providers: [], accountless: true, localToken: gatewayToken }),
    fetchUpstream: async () => { throw Error('must not reach upstream'); },
  });
  await accountlessRouter.start(0);
  t.after(() => accountlessRouter.stop());
  const blocked = await fetch(`http://127.0.0.1:${accountlessRouter.port}/clients/ASS/backend-api/wham/settings/user`, {
    headers: { authorization: 'Bearer ' + gatewayToken },
  });
  assert.equal(blocked.status, 401);
});

test('HTML 403 preserves full body/status and gateway headers, logs only bounded diagnostics, and is not retried by ASS', async t => {
  const page = '<!DOCTYPE html><HTML><head><TITLE>Gateway denied</TITLE></head><body>' + '大'.repeat(10000) + '</body></HTML>';
  let calls = 0;
  const { request, logs } = await start(t, { fetchUpstream: async () => {
    calls++;
    return new Response(page, { status: 403, headers: {
      'content-type': 'text/html; charset=utf-8', server: 'openresty', 'cf-ray': 'fixture-SIN',
      'cf-mitigated': 'challenge', 'x-mife-upstream-status': '403', 'x-oai-request-id': 'req-fixture',
      'retry-after': '3', 'set-cookie': 'private=fixture', 'x-private-debug': 'body-not-for-logs',
    } });
  } });
  const response = await request();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cf-ray'), 'fixture-SIN');
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), page);
  assert.equal(calls, 1);
  assert.equal(logs.length, 1);
  const row = logs[0];
  assert.equal(row.requestId, response.headers.get('x-ass-request-id'));
  assert.equal(row.status, 403); assert.equal(row.httpStatus, 403); assert.equal(row.taskOk, false);
  assert.equal(row.upstream.errorKind, 'html_gateway'); assert.equal(row.upstream.title, 'Gateway denied');
  assert.equal(row.upstream.headers['x-mife-upstream-status'], '403');
  assert.equal(row.upstream.headers['x-oai-request-id'], 'req-fixture');
  assert.equal(row.upstream.headers['x-private-debug'], undefined);
  assert.ok(!JSON.stringify(row).includes('大'.repeat(10)));
});

test('official JSON 429 preserves quota error shape and retry/rate headers instead of wrapping it', async t => {
  const raw = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Quota exhausted', resets_at: 1800000000 } });
  const { request, logs } = await start(t, { fetchUpstream: async () => new Response(raw, { status: 429, headers: {
    'content-type': 'application/json', 'retry-after': '3600', 'x-request-id': 'req-limit',
    'x-ratelimit-reset-requests': '1h',
  } }) });
  const response = await request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3600');
  assert.equal(response.headers.get('x-ratelimit-reset-requests'), '1h');
  assert.equal(await response.text(), raw);
  assert.equal(logs[0].error, 'Quota exhausted');
});

test('official SSE preserves split UTF8, CRLF, heartbeat, event IDs and retry fields byte for byte', async t => {
  const raw = ': heartbeat\r\n\r\nid: event-1\r\nretry: 2500\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n' +
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';
  const bytes = Buffer.from(raw);
  const { request } = await start(t, { fetchUpstream: async () => new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'stream-fixture', 'x-codex-primary-used-percent': '20' } }) });
  const response = await request({ stream: true });
  assert.equal(response.headers.get('x-request-id'), 'stream-fixture');
  assert.equal(response.headers.get('x-codex-primary-used-percent'), '20');
  assert.equal(await response.text(), raw);
});

test('native SSE failure events reach Codex intact and remain failed in the request log', async t => {
  const raw = 'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"quota","message":"Native reason"}}}\n\n';
  const { request, logs } = await start(t, { fetchUpstream: async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await request({ stream: true });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), raw);
  assert.equal(logs[0].httpOk, true); assert.equal(logs[0].taskOk, false);
});

test('gateway OAuth replacement is isolated and error echoes are redacted across chunk boundaries', async t => {
  const gatewayToken = 'b'.repeat(64), oauth = 'fixture-private-oauth-token';
  const raw = `<html><title>Denied ${oauth}</title><body>${gatewayToken}|${oauth}|你好</body></html>`;
  const bytes = Buffer.from(raw);
  let seen;
  const { request, logs } = await start(t, {
    getState: () => ({ providers: [], gatewayAuth: true, localToken: gatewayToken }),
    getOfficialAuth: async () => ({ authorization: 'Bearer ' + oauth, 'chatgpt-account-id': 'current-account' }),
    fetchUpstream: async (_, init) => {
      seen = init.headers;
      return new Response(new ReadableStream({ start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close();
      } }), { status: 403, headers: { 'content-type': 'text/html', 'x-request-id': 'echo-' + oauth } });
    },
  });
  const response = await request({}, { authorization: 'Bearer ' + gatewayToken, 'chatgpt-account-id': 'stale-account', 'user-agent': 'native-codex' });
  assert.equal(seen.authorization, 'Bearer ' + oauth);
  assert.equal(seen['chatgpt-account-id'], 'current-account');
  assert.equal(seen['user-agent'], 'native-codex');
  assert.equal(response.headers.get('x-request-id'), 'echo-[REDACTED]');
  assert.equal(await response.text(), raw.replaceAll(gatewayToken, '[REDACTED]').replaceAll(oauth, '[REDACTED]'));
  assert.ok(!JSON.stringify(logs).includes(oauth));
  assert.ok(!JSON.stringify(logs).includes(gatewayToken));
});

test('a gateway transport failure never logs the resolved official credential', async t => {
  const gatewayToken = 'b'.repeat(64), oauth = 'fixture-private-oauth-token';
  const { request, logs } = await start(t, {
    getState: () => ({ providers: [], gatewayAuth: true, localToken: gatewayToken }),
    getOfficialAuth: async () => ({ authorization: 'Bearer ' + oauth }),
    fetchUpstream: async () => { throw Error('Network rejected ' + oauth); },
  });
  const response = await request({}, { authorization: 'Bearer ' + gatewayToken });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(oauth));
  assert.ok(!JSON.stringify(logs).includes(oauth));
});

test('official header passthrough never forwards OAuth, account or private Codex metadata to third-party providers', async t => {
  const provider = normalizeProvider({ id: 'fixture', name: 'Third party', baseUrl: 'https://third.invalid/v1', apiKey: 'fixture-api',
    models: [{ model: 'model-b', wireApi: 'openai-responses' }] });
  let seen;
  const { request } = await start(t, { getState: () => ({ providers: [provider] }), fetchUpstream: async (_, init) => {
    seen = init.headers; return Response.json({ output: [] });
  } });
  const response = await request({ model: codexModelId(provider.id, 'model-b') }, {
    'chatgpt-account-id': 'account-fixture', 'x-codex-private': 'official-only', cookie: 'never-forward',
  });
  assert.equal(response.status, 200); await response.text();
  assert.equal(seen.authorization, 'Bearer fixture-api');
  assert.equal(seen['chatgpt-account-id'], undefined);
  assert.equal(seen['x-codex-private'], undefined);
  assert.equal(seen.cookie, undefined);
});

test('error redaction handles overlapping secret prefixes without losing surrounding bytes', async () => {
  const raw = 'aaa TOKEN-LONG TOKEN 你好 TOKEN-LONG tail';
  let output = '';
  const sample = await forwardErrorBody(new Response(new ReadableStream({ start(c) {
    for (const byte of Buffer.from(raw)) c.enqueue(Uint8Array.of(byte)); c.close();
  } })), async chunk => { output += chunk; }, ['TOKEN', 'TOKEN-LONG']);
  assert.equal(output, 'aaa [REDACTED] [REDACTED] 你好 [REDACTED] tail');
  assert.equal(sample, output);
});

test('third-party SSE errors retain the upstream message and parameter without exposing credentials',async t=>{
  const provider=normalizeProvider({id:'fixture-sse',baseUrl:'https://fixture.invalid/v1',apiKey:'private-"fixture-key',models:[{model:'x',wireApi:'openai-responses'}]});
  const detail=JSON.stringify({error:{code:'400',message:'Invalid request '+provider.apiKey,param:'404 NOT_FOUND'}}).replace('{"error":','{"error":\r\ndata:');
  const {request,logs}=await start(t,{getState:()=>({providers:[provider]}),fetchUpstream:async()=>new Response(
    ': heartbeat\r\n\r\ndata:'+detail+'\r\n\r\n',
    {status:400,headers:{'content-type':'text/event-stream;charset=UTF-8'}})});
  const response=await request({model:codexModelId(provider.id,'x')});
  assert.equal(response.status,400);const body=await response.json();
  assert.equal(body.error.code,'upstream_http_error');assert.match(body.error.message,/Invalid request/);assert.match(body.error.message,/404 NOT_FOUND/);
  assert.ok(!body.error.message.includes(provider.apiKey));assert.ok(!logs[0].error.includes(provider.apiKey));
  assert.equal(logs[0].upstream.errorKind,'sse_error');assert.equal(logs[0].taskOk,false);
});
