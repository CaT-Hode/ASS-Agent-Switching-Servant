// Native Electron renderer with synthetic request history; no user profile or network.
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron: electron } = require('playwright');
let app, page, root; const errors = [];
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-monitor-renderer-'));
  require('esbuild').buildSync({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import'./src/style.css';import'./src/controls.css';import'./src/polish.css';import'./src/clients.css';import'./src/sidebar.css';import'./src/theme.css';import'./src/motion.css';
    import{RequestMonitor}from'./src/request-monitor.jsx';
    let revision=0;const root=createRoot(document.getElementById('root'));
    window.render=()=>flushSync(()=>root.render(<main style={{margin:0,padding:32}}><RequestMonitor state={{requestRevision:revision,service:{active:2}}}/></main>));
    window.bump=()=>{revision++;window.render();};window.render();`, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' },
    bundle: true, outfile: path.join(root, 'renderer.js'), platform: 'browser', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="UTF-8"><title>ASS request monitor QA</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.loadURL('about:blank');});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(root, 'main.cjs')], env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route(/^https?:/, route => route.abort());
  await page.addInitScript(() => {
    window.rows = Array.from({ length: 31 }, (_, i) => ({ time: new Date(Date.now() - i * 30000).toISOString(), requestId: 'fixture-' + i,
      model: i % 2 ? 'vendor/gemini-4-argon' : 'ASS_fixture::another/vendor/gemini-4-argon', source: i % 2 ? 'WOYAO' : 'MIFY', client: 'codex',
      protocol: i % 2 ? 'anthropic' : 'openai-responses', ok: i !== 2, taskOk: i !== 2, httpStatus: i === 2 ? 502 : 200,
      error: i === 2 ? 'Synthetic upstream failure' : '', ms: 4200, ttftMs: 1200, generationMs: 3000,
      visibleTokens: 100, visibleMs: 3000, tps: 100 / 3, endToEndTps: 120 / 4.2,
      usage: { inputTokens: 1000, outputTokens: 120, reasoningTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 0 } }));
    window.reads = 0;
    window.ass = { call: async name => { if (name !== 'request-monitor') throw Error('Unexpected IPC'); window.reads++;
      return { rows: structuredClone(window.rows), active: structuredClone(window.active || []), limit: 5000, error: '' }; } };
  });
  await page.goto('file:///' + path.join(root, 'index.html').replaceAll('\\', '/'));
});
after(async () => { await app?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('monitor filters, pages, inspects, merges leaf names and pauses/resumes real updates without renderer errors', async () => {
  assert.equal(await page.title(), 'ASS request monitor QA');
  await page.getByText('31 个请求', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody > tr').count(), 25);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await page.locator('tbody > tr').count(), 6);
  await page.getByRole('button', { name: '查看 gemini-4-argon 请求详情', exact: true }).first().click();
  await page.getByRole('region', { name: '请求详情' }).waitFor();
  assert.match(await page.getByRole('region', { name: '请求详情' }).textContent(), /缓存读取600/);
  await page.getByRole('button', { name: '关闭请求详情', exact: true }).click();
  await page.getByRole('button', { name: '模型汇总', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.monitor-summary-table tbody')?.children.length === 1);
  assert.equal(await page.locator('tbody > tr').count(), 1);
  assert.equal(await page.locator('tbody > tr > td').first().textContent(), 'gemini-4-argon');
  await page.getByRole('combobox', { name: '筛选供应商' }).selectOption('WOYAO');
  await page.getByText('15 个请求', { exact: true }).waitFor();
  await page.getByRole('button', { name: '供应商汇总', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.monitor-summary-table tbody tr td')?.textContent === 'WOYAO');
  assert.equal(await page.locator('tbody > tr > td').first().textContent(), 'WOYAO');
  await page.getByRole('combobox', { name: '筛选供应商' }).selectOption('all');
  await page.getByRole('combobox', { name: '筛选请求状态' }).selectOption('failed');
  await page.getByText('1 个请求', { exact: true }).waitFor();
  await page.getByRole('button', { name: '请求明细', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.monitor-summary-table'));
  await page.getByRole('button', { name: '查看 gemini-4-argon 请求详情', exact: true }).click();
  await page.getByText('Synthetic upstream failure', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: '筛选请求状态' }).selectOption('all');
  await page.getByRole('textbox', { name: '搜索模型或供应商' }).fill('no-match');
  await page.getByText('没有符合条件的请求', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索模型或供应商' }).fill('');
  await page.getByRole('button', { name: '暂停刷新', exact: true }).click();
  const reads = await page.evaluate(() => window.reads);
  await page.evaluate(() => { window.rows.unshift({ ...window.rows[0], requestId: 'new' }); window.bump(); });
  assert.equal(await page.evaluate(() => window.reads), reads);
  await page.getByText('31 个请求', { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续刷新', exact: true }).click();
  await page.getByText('32 个请求', { exact: true }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
});

test('desktop light/dark at 1280/1440 render without page overflow and legacy records remain unknown', async () => {
  const output = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ASS-validation'); fs.mkdirSync(output, { recursive: true });
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const search = page.getByRole('textbox', { name: '搜索模型或供应商' });
      const appearance = await search.evaluate(input => {
        const style = getComputedStyle(input), wrapper = input.closest('.monitor-search');
        return { background: style.backgroundColor, border: style.borderWidth, shadow: style.boxShadow, radius: style.borderRadius,
          paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
          heightDifference: wrapper.getBoundingClientRect().height - document.querySelector('.monitor-filters select').getBoundingClientRect().height };
      });
      assert.deepEqual(appearance, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', radius: '0px', paddingLeft: '0px', paddingRight: '0px', heightDifference: 0 });
      await search.focus();
      assert.deepEqual(await search.evaluate(input => ({ inner: getComputedStyle(input).outlineStyle,
        outer: getComputedStyle(input.closest('.monitor-search')).outlineWidth })), { inner: 'none', outer: '2px' });
      await search.evaluate(input => input.blur());
      await page.screenshot({ path: path.join(output, `request-monitor-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  await page.evaluate(() => { window.rows = [{ time: new Date().toISOString(), model: 'old/vendor/model', source: 'Historical', ms: 1000, ok: true }]; window.bump(); });
  await page.getByText('1 个请求', { exact: true }).waitFor();
  const cells = await page.locator('tbody > tr > td').allTextContents();
  assert.equal(cells[1].startsWith('model'), true); assert.equal(cells[3], '——'); assert.equal(cells[5], '—'); assert.equal(cells[6], '—');
  await page.getByRole('button', { name: '近 1 小时', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '近 1 小时' && button.getAttribute('aria-pressed') === 'true'));
  assert.equal(await page.getByRole('button', { name: '近 1 小时', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('ongoing row updates TPS/elapsed and selected details every second, freezes on pause, and completes without duplicate rows', async () => {
  await page.evaluate(() => {
    window.active = [{ time: new Date().toISOString(), requestId: 'live-row', model: 'ASS_x::vendor/live-model', source: 'Live Provider', client: 'codex',
      inProgress: true, phase: 'waiting-upstream', ms: 1000, usage: null, tps: null }]; window.bump();
  });
  await page.getByText('等待上游', { exact: true }).waitFor();
  const row = page.locator('tr[data-in-progress]');
  await page.getByRole('button', { name: '查看 live-model 请求详情', exact: true }).click();
  await page.getByRole('region', { name: '请求详情' }).waitFor();
  await page.evaluate(() => { window.active[0] = { ...window.active[0], phase: 'streaming', ms: 6000,
    visibleTokens: 120, visibleMs: 4000, tps: 120 / 4, endToEndTps: 120 / 6, tpsEstimated: true,
    outputEstimated: true, ttftMs: 1000, usage: { outputTokens: 120 } }; });
  await page.waitForFunction(() => document.querySelector('tr[data-in-progress]')?.textContent.includes('6.00 s'));
  assert.match(await row.textContent(), /≈ 30/);
  assert.match(await page.getByRole('region', { name: '请求详情' }).textContent(), /可见输出 TPS≈ 30/);
  assert.match(await page.getByRole('region', { name: '请求详情' }).textContent(), /全程吞吐≈ 20 tok\/s/);
  assert.equal(await row.evaluate(el => el.getAnimations().length), 0, 'per-second updates do not reanimate request rows');
  await page.getByRole('button', { name: '暂停刷新', exact: true }).click();
  await page.evaluate(() => { window.active[0].ms = 9000; window.active[0].visibleMs = 7000; window.active[0].tps = 120 / 7; });
  await page.waitForTimeout(1100); assert.match(await row.textContent(), /6\.00 s/);
  await page.getByRole('button', { name: '继续刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('tr[data-in-progress]')?.textContent.includes('9.00 s'));
  await page.evaluate(() => {
    window.rows.unshift({ ...window.active[0], time: new Date().toISOString(), inProgress: false, phase: undefined,
      ok: true, taskOk: true, httpStatus: 200, visibleTokens: 160, visibleMs: 6000, tps: 160 / 6, endToEndTps: 160 / 9,
      tpsEstimated: false, outputEstimated: false, usage: { inputTokens: 500, outputTokens: 160, reasoningTokens: 0 } });
    window.active = []; window.bump();
  });
  await page.waitForFunction(() => !document.querySelector('tr[data-in-progress]'));
  assert.equal(await page.getByRole('button', { name: '查看 live-model 请求详情', exact: true }).count(), 1);
  assert.match(await page.getByRole('region', { name: '请求详情' }).textContent(), /可见输出 TPS26\.7/);
  assert.deepEqual(errors, []);
});
