// Real Electron session.fetch against loopback fixtures. No production route,
// credentials, userData, client configuration or model calls are touched.
const { app, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), zlib = require('node:zlib'), assert = require('node:assert/strict');
const load = require('node:module').createRequire(path.join(process.env.ASS_QA_RUNTIME_ROOT || path.resolve(__dirname, '..'), 'package.json'));
const { Router } = load('./core/router.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-passthrough-qa-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
let router, upstream;
const calls = [], logs = [];
const stream = ': heartbeat\r\n\r\nid: fixture\r\nretry: 3000\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n' +
  'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';
const html = '<html><title>MiFE fixture rejected</title><body>Forbidden</body></html>';
const json = '{ "id": "fixture", "output": [] }';

function request(mode, port) {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify({ model: 'gpt-fixture', input: [], stream: mode === 'stream', mode })));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/clients/ASS/v1/responses', method: 'POST', headers: {
      authorization: 'Bearer synthetic-qa', 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': bytes.length,
      'user-agent': 'codex-desktop/fixture (Windows)', accept: mode === 'stream' ? 'text/event-stream' : 'application/json',
      'x-codex-new-header': 'preserved', session_id: 'fixture-session', 'x-client-request-id': 'fixture-client-request',
      'proxy-authorization': 'never-forward', cookie: 'local=never-forward', 'x-ass-probe-token': 'never-forward',
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(Error('Fixture request timed out')));
    req.on('error', reject); req.end(bytes);
  });
}

app.whenReady().then(async () => {
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/bootstrap') {
      calls.push({ path: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'fixture-bootstrap' });
      res.end(JSON.stringify({ account: 'fixture' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ headers: req.headers, body });
    res.setHeader('x-request-id', 'fixture-upstream-' + body.mode);
    res.setHeader('x-codex-primary-used-percent', '15');
    res.setHeader('set-cookie', 'private=fixture');
    if (body.mode === 'stream') {
      res.setHeader('content-type', 'text/event-stream');
      for (const byte of Buffer.from(stream)) res.write(Buffer.from([byte]));
      res.end();
    } else {
      const error = body.mode === 'error';
      const bytes = zlib.gzipSync(Buffer.from(error ? html : json));
      res.statusCode = error ? 403 : 200;
      res.setHeader('content-type', error ? 'text/html' : 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-length', bytes.length);
      if (error) { res.setHeader('cf-ray', 'fixture-SIN'); res.setHeader('x-mife-upstream-status', '403'); res.setHeader('retry-after', '2'); }
      res.end(bytes);
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const transport = session.fromPartition('ass-passthrough-qa');
  await transport.setProxy({ mode: 'direct' });
  router = new Router({ getState: () => ({ providers: [] }), log: row => logs.push(row),
    fetchUpstream: async (url, init, network) => {
      assert.ok([
        'https://chatgpt.com/backend-api/codex/responses',
        'https://chatgpt.com/backend-api/wham/settings/user',
      ].includes(url));
      assert.equal(network, 'system');
      const fixturePath = url.endsWith('/settings/user') ? '/bootstrap' : '/fixture';
      return transport.fetch(`http://127.0.0.1:${upstream.address().port}${fixturePath}`, { ...init, credentials: 'omit', redirect: 'error' });
    } });
  await router.start(0);
  for (const mode of ['json', 'stream', 'error']) {
    const response = await request(mode, router.port);
    assert.equal(response.status, mode === 'error' ? 403 : 200);
    assert.equal(response.body, mode === 'error' ? html : mode === 'stream' ? stream : json);
    assert.equal(response.headers['x-request-id'], 'fixture-upstream-' + mode);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['x-codex-primary-used-percent'], '15');
    const call = calls.at(-1);
    assert.equal(call.headers['user-agent'], 'codex-desktop/fixture (Windows)');
    assert.equal(call.headers['x-codex-new-header'], 'preserved');
    assert.equal(call.headers['x-client-request-id'], 'fixture-client-request');
    assert.equal(call.headers.session_id, 'fixture-session');
    assert.equal(call.headers['content-encoding'], undefined);
    assert.equal(call.headers['proxy-authorization'], undefined);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['x-ass-probe-token'], undefined);
    assert.equal(logs.at(-1).requestId, response.headers['x-ass-request-id']);
  }
  const gatewayLog = logs.at(-1);
  const bootstrap = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/backend-api/wham/settings/user`, {
    headers: { authorization: 'Bearer synthetic-oauth', 'user-agent': 'codex-desktop/fixture (Windows)' },
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { account: 'fixture' });
  assert.equal(calls.at(-1).path, '/bootstrap');
  assert.equal(calls.at(-1).headers['user-agent'], 'codex-desktop/fixture (Windows)');
  assert.equal(gatewayLog.upstream.errorKind, 'html_gateway');
  assert.equal(gatewayLog.upstream.title, 'MiFE fixture rejected');
  assert.equal(gatewayLog.upstream.headers['x-mife-upstream-status'], '403');
  console.log(JSON.stringify({ ok: true, transport: 'Electron session.fetch', cases: ['gzip request', 'native User-Agent', 'JSON response',
    'raw SSE', 'gzip HTML 403', 'gateway diagnostics', 'credential isolation', 'Codex bootstrap settings relay'], requests: calls.length }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (router) await router.stop();
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  // Electron can retain cache handles until exit; retain only this isolated
  // temporary directory if Windows has not released them yet.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  app.exit(process.exitCode || 0);
});
