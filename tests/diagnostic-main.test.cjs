// End-to-end diagnose IPC, protocol probes, persistence and renderer in a private
// app profile. Upstream requests are intercepted in-process, never sent to cloud.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron: electron } = require('playwright');
test('main-process diagnostic reasons survive restart and quick checks repair applied routes', { timeout: 90000 }, async t => {
  const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-diagnostic-main-'));
  const codex = path.join(data, 'test-home', '.codex'); fs.mkdirSync(codex, { recursive: true });
  const env = { ...process.env, ASS_TEST_DATA: data, ASS_TEST_CODEX: codex, ASS_TEST_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const close = async () => { if(app) { await app.evaluate(() => global.assTest.quit()).catch(()=>{}); await app.close().catch(()=>{}); app = null; } };
  t.after(close);
  const launch = () => electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), root, '--qa'], env, timeout: 45000 });
  app = await launch(); let page = await app.firstWindow(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('h1');
  // A headless Linux runner can render the app without a desktop secret
  // service. This integration test persists encrypted state across restarts;
  // keep the native Windows path mandatory rather than weakening OS crypto.
  if (process.platform === 'linux' && !await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())) {
    t.skip('Native credential encryption is unavailable on this headless Linux runner');
    return;
  }
  const results = await app.evaluate(async () => {
    const t = global.assTest;
    const codes = { auth: 'invalid_api_key', quota: 'insufficient_quota', rate: 'rate_limit_exceeded' };
    t.setFetch(async url => {
      const name = new URL(url).hostname.split('.')[0];
      if (name === 'dns') throw Error('net::ERR_NAME_NOT_RESOLVED');
      if (!codes[name]) throw Error('Unexpected synthetic upstream request');
      return Response.json({ error: { code: codes[name], message: 'fixture-private-error' } }, { status: name === 'auth' ? 401 : 429 });
    });
    for (const id of ['dns','auth','quota','rate']) t.store.updateProvider({ id, name: id, baseUrl: `https://${id}.invalid/v1`, apiKey: 'fixture-synthetic', enabled: true,
      models: [{ model: 'alpha', displayName: id, wireApi: 'openai-responses', enabled: true }] });
    const single = [];
    for (const id of ['dns','auth','quota','rate']) single.push(await t.diagnose(id, 'alpha'));
    t.diagnosticBatch.start(); await t.diagnosticBatch.finished;
    return { single, diagnostics: t.snapshot().diagnostics, batch: t.snapshot().diagnosticBatch };
  });
  assert.deepEqual(results.single.map(r => r.failure.kind), ['dns','authentication','quota','rate_limit']);
  assert.deepEqual(results.single.map(r => r.httpStatus), [null,401,429,429]);
  assert.deepEqual(results.single.map(r => r.localStatus), [502,401,429,429]);
  assert.equal(results.batch.failed, 4);
  assert.deepEqual(results.batch.entries.filter(e=>e.status==='failed').map(e=>e.failure.kind).sort(), ['authentication','dns','quota','rate_limit']);
  assert.doesNotMatch(JSON.stringify(results), /fixture-private-error|fixture-synthetic/);
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await page.locator('.diagnostic-failure strong').getByText('DNS 解析失败', { exact: true }).waitFor();
  assert.ok(await page.locator('.diagnostic-failure strong').getByText('额度或余额耗尽', { exact: true }).isVisible());
  const dnsCard = page.locator('.diagnostic').filter({has:page.getByText('DNS 解析失败',{exact:true})});
  await dnsCard.getByText('测试详情',{exact:true}).click();
  assert.match(await dnsCard.innerText(), /ASS 路由/);
  assert.match(await dnsCard.innerText(), /Responses/);
  assert.equal(await page.locator('.request-table .request-row:not(.table-head)').filter({hasText:'DNS 解析失败'}).count(), 2);
  assert.match(await page.locator('.request-table').innerText(), /认证失败/);
  assert.match(await page.locator('.request-table').innerText(), /额度或余额耗尽/);
  await page.screenshot({ path: path.join(data,'diagnostics-app.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  await close(); app = await launch(); page = await app.firstWindow(); await page.waitForSelector('h1');
  const restored = await app.evaluate(() => ({ diagnostics: global.assTest.snapshot().diagnostics, batch: global.assTest.snapshot().diagnosticBatch }));
  assert.deepEqual(restored.diagnostics, results.diagnostics);
  assert.equal(restored.batch.failed, 4); assert.equal(restored.batch.restored, true);
  assert.equal(fs.existsSync(path.join(codex,'config.toml')), false);
  const quick = await app.evaluate(async () => {
    const t = global.assTest, calls = [], budgets = [];
    t.store.updateProvider({ id:'quick', name:'Quick Gemini', enabled:true, baseUrl:'https://quick.invalid/v1', apiKey:'synthetic-quick-key',
      models:[{model:'gemini-fixture', wireApi:'anthropic', enabled:true}] });
    const proxy = t.connections.proxyConfig;
    const plan = await t.connections.preview('codex',true);
    await t.connections.apply({ticket:plan.ticket,mode:'safe',acknowledged:true});
    const before = proxy.clients.codex.providers.find(p=>p.id==='quick').models[0].wireApi;
    t.setFetch(async (url, init) => {
      calls.push(new URL(url).pathname);
      budgets.push(JSON.parse(init.body).max_output_tokens);
      if (!url.endsWith('/responses')) throw Error('unused protocol must not delay a successful connection check');
      return new Response('data: '+JSON.stringify({type:'response.completed', response:{output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}})+'\n\n');
    });
    const result = await t.diagnose('quick','gemini-fixture');
    const response = await fetch(`http://127.0.0.1:${t.router.port}/clients/ASS/v1/responses`, {
      method:'POST', headers:{authorization:'Bearer '+proxy.clients.codex.localToken,'content-type':'application/json'},
      body:JSON.stringify({model:proxy.clients.codex.catalog.models.find(m=>m.slug.endsWith('::gemini-fixture')).slug,input:'Reply OK',stream:true}),
    });
    return {before, result, status:response.status, completed:(await response.text()).includes('response.completed'), calls, budgets,
      unchangedSnapshot:proxy.clients.codex.providers.find(p=>p.id==='quick').models[0].wireApi};
  });
  assert.equal(quick.before,'anthropic'); assert.equal(quick.result.ok,true);
  assert.equal(quick.status,200); assert.equal(quick.completed,true); assert.equal(quick.unchangedSnapshot,'anthropic');
  assert.deepEqual(quick.calls,['/v1/responses','/v1/responses','/v1/responses']);
  assert.deepEqual(quick.budgets,[512,512,131072]);
  assert.ok(Number.isFinite(quick.result.protocolMs)); assert.ok(quick.result.ms>=quick.result.protocolMs);
  console.log('Main-process diagnostic QA evidence: ' + data);
});
