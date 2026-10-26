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
    t.setFetch(async url => {
      const name = new URL(url).hostname.split('.')[0];
      if (name === 'dns') throw Error('net::ERR_NAME_NOT_RESOLVED');
      if (name !== 'auth') throw Error('Unexpected synthetic upstream request');
      return Response.json({ error: { code: 'invalid_api_key', message: 'fixture-private-error' } }, { status: 401 });
    });
    for (const id of ['dns','auth']) t.store.updateProvider({ id, name: id, baseUrl: `https://${id}.invalid/v1`, apiKey: 'fixture-synthetic', enabled: true,
      models: [{ model: 'alpha', displayName: id, wireApi: 'openai-responses', enabled: true }] });
    const single = [];
    for (const id of ['dns','auth']) single.push(await t.diagnose(id, 'alpha'));
    t.diagnosticBatch.start(); await t.diagnosticBatch.finished;
    return { single, diagnostics: t.snapshot().diagnostics, batch: t.snapshot().diagnosticBatch };
  });
  assert.deepEqual(results.single.map(r => r.failure.kind), ['dns','authentication']);
  assert.deepEqual(results.single.map(r => r.httpStatus), [null,401]);
  assert.deepEqual(results.single.map(r => r.localStatus), [502,401]);
  assert.equal(results.batch.failed, 2);
  assert.doesNotMatch(JSON.stringify(results), /fixture-private-error|fixture-synthetic/);
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await page.locator('.diagnostic-failure strong').getByText('DNS 解析失败', { exact: true }).waitFor();
  const dnsCard = page.locator('.diagnostic').filter({has:page.getByText('DNS 解析失败',{exact:true})});
  await dnsCard.getByText('测试详情',{exact:true}).click();
  assert.match(await dnsCard.innerText(), /ASS 路由/);
  assert.match(await dnsCard.innerText(), /Responses/);
  assert.match(await page.locator('.request-table').innerText(), /认证失败/);
  assert.deepEqual(errors, []);
  await close(); app = await launch(); page = await app.firstWindow(); await page.waitForSelector('h1');
  const restored = await app.evaluate(() => ({ diagnostics: global.assTest.snapshot().diagnostics, batch: global.assTest.snapshot().diagnosticBatch }));
  assert.deepEqual(restored.diagnostics, results.diagnostics);
  assert.equal(restored.batch.failed, 2); assert.equal(restored.batch.restored, true);
  assert.equal(fs.existsSync(path.join(codex,'config.toml')), false);
  const quick = await app.evaluate(async () => {
    const t = global.assTest, calls = [], budgets = [], bodies = [];
    t.store.updateProvider({ id:'quick', name:'Quick Gemini', enabled:true, baseUrl:'https://quick.invalid/v1', apiKey:'synthetic-quick-key',
      models:[{model:'gemini-fixture', wireApi:'anthropic', enabled:true}] });
    const proxy = t.connections.proxyConfig;
    const plan = await t.connections.preview('codex',true);
    await t.connections.apply({ticket:plan.ticket,mode:'safe',acknowledged:true});
    const before = proxy.clients.codex.providers.find(p=>p.id==='quick').models[0].wireApi;
    t.setFetch(async (url, init) => {
      calls.push(new URL(url).pathname);
      budgets.push(JSON.parse(init.body).max_output_tokens);
      bodies.push(JSON.parse(init.body));
      if (!url.endsWith('/responses')) throw Error('unused protocol must not delay a successful connection check');
      return new Response('data: '+JSON.stringify({type:'response.completed', response:{output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}})+'\n\n');
    });
    const result = await t.diagnose('quick','gemini-fixture');
    const response = await fetch(`http://127.0.0.1:${t.router.port}/clients/ASS/v1/responses`, {
      method:'POST', headers:{authorization:'Bearer '+proxy.clients.codex.localToken,'content-type':'application/json'},
      body:JSON.stringify({model:proxy.clients.codex.catalog.models.find(m=>m.slug.endsWith('::gemini-fixture')).slug,input:'Reply OK',stream:true}),
    });
    return {before, result, status:response.status, completed:(await response.text()).includes('response.completed'), calls, budgets, bodies,
      unchangedSnapshot:proxy.clients.codex.providers.find(p=>p.id==='quick').models[0].wireApi};
  });
  assert.equal(quick.before,'anthropic'); assert.equal(quick.result.ok,true);
  assert.equal(quick.status,200); assert.equal(quick.completed,true); assert.equal(quick.unchangedSnapshot,'anthropic');
  assert.deepEqual(quick.calls,['/v1/responses','/v1/responses','/v1/responses']);
  assert.deepEqual(quick.budgets,[512,512,131072]);
  assert.deepEqual(quick.bodies[0],quick.bodies[1],'protocol probe and routed connection check must use the same request parameters');
  assert.ok(Number.isFinite(quick.result.protocolMs)); assert.ok(quick.result.ms>=quick.result.protocolMs);
  const split = await app.evaluate(async () => {
    const t=global.assTest; let call=0;
    t.setFetch(async () => ++call === 1
      ? new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}})+'\n\n')
      : Response.json({error:{message:'Unsupported request parameter'}},{status:400}));
    const result=await t.diagnose('quick','gemini-fixture');
    return {result,protocol:t.protocols.public()[JSON.stringify(['quick','gemini-fixture'])].protocols['openai-responses']};
  });
  assert.equal(split.result.ok,false); assert.equal(split.result.httpStatus,400);
  assert.equal(split.protocol.lastStatus,'unknown'); assert.equal(split.protocol.httpStatus,400);
  await app.evaluate(() => {
    const t=global.assTest;
    t.store.updateProvider({id:'parallel',name:'Parallel checks',baseUrl:'https://parallel.invalid/v1',apiKey:'synthetic-parallel',enabled:true,
      models:['gemini-stall','other-model','second-stall'].map(model=>({model,wireApi:'openai-responses',enabled:true}))});
    t.setFetch(async (_,init) => {
      if(JSON.parse(init.body).model.endsWith('stall')) return new Promise(()=>{});
      return new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}})+'\n\n');
    });
  });
  await page.evaluate(()=>window.ass.call('snapshot'));
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();
  await page.getByRole('button',{name:'检测模型 gemini-stall',exact:true}).click();
  await page.getByRole('button',{name:'取消检测 gemini-stall',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'检测模型 other-model',exact:true}).isEnabled());
  await page.getByRole('button',{name:'检测模型 other-model',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[aria-label="检测模型 other-model"]')?.classList.contains('passed'));
  await page.getByRole('button',{name:'检测模型 second-stall',exact:true}).click();
  await page.getByRole('button',{name:'取消检测 second-stall',exact:true}).waitFor();
  await page.getByRole('button',{name:'取消检测 gemini-stall',exact:true}).click();
  await page.getByRole('button',{name:'检测模型 gemini-stall',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'取消检测 second-stall',exact:true}).isEnabled());
  await page.getByRole('button',{name:'取消检测 second-stall',exact:true}).click();
  await page.getByRole('button',{name:'检测模型 second-stall',exact:true}).waitFor();
  const parallel=await app.evaluate(()=>({jobs:global.assTest.snapshot().diagnosticJobs,results:global.assTest.snapshot().diagnostics}));
  assert.equal(Object.keys(parallel.jobs).length,0);
  assert.equal(parallel.results[JSON.stringify(['parallel','other-model'])].ok,true);
  assert.equal(parallel.results[JSON.stringify(['parallel','gemini-stall'])],undefined);
  assert.deepEqual(errors,[]);
  console.log('Main-process diagnostic QA evidence: ' + data);
});
