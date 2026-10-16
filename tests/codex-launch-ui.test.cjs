// Isolated React/Electron UI: never launch a real harness or read native accounts.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron: electron } = require('playwright');
let app, page, output;
const errors = [];
before(async () => {
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-codex-launch-ui-'));
  require('esbuild').buildSync({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {Clients} from './src/clients.jsx';
    import './src/style.css';import './src/controls.css';import './src/polish.css';import './src/clients.css';import './src/theme.css';
    function Fixture(){
      const [connection,setConnection]=useState({enabled:true,applied:true,accountlessAvailable:true});
      const [busy,setBusy]=useState(''),[error,setError]=useState('');
      const [desktop,setDesktop]=useState('synthetic');
      window.setConnection=c=>flushSync(()=>setConnection(c));
      window.setCodexDesktop=value=>flushSync(()=>setDesktop(value));
      const client=(id,name)=>({id,name,detected:true,desktop:id==='codex'?desktop:'synthetic',accounts:[],credentialSources:[],launcher:{ready:true},injection:{models:[]}});
      const state={officialServices:[],nativeAccounts:[],providers:[],connections:{clients:{codex:connection,claude:{enabled:false}},processes:{sessions:[]}},harnesses:{clients:[client('codex','Codex'),client('claude','Claude Code')]}};
      const act=async(key,fn)=>{setBusy(key);setError('');try{return await fn();}catch(e){setError(e.message);}finally{setBusy('');}};
      return <main style={{maxWidth:1180,margin:'30px auto',padding:'0 24px'}}>
        <h1>客户端与账户</h1><Clients state={state} busy={busy} act={act} onManage={()=>{}}/>
        {error&&<p role="alert">{error}</p>}
      </main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' },
    bundle: true, outfile: path.join(output, 'renderer.js'), platform: 'browser', logLevel: 'silent' });
  fs.mkdirSync(path.join(output, 'providers'));
  for (const brand of ['openai','anthropic']) fs.copyFileSync(path.resolve(__dirname, '../public/providers', brand + '.svg'), path.join(output, 'providers', brand + '.svg'));
  // Test artifacts stay in the OS temp directory, not in the application package.
  const html = '<html><head><title>ASS Codex launch UI</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>';
  await fs.promises.writeFile(path.join(output, 'index.html'), html);
  await fs.promises.writeFile(path.join(output, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output,'profile'))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1440,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}).loadURL('about:blank')});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(output, 'main.cjs')], env });
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.context().route(/^https?:/, route => route.abort());
  await page.addInitScript(() => {
    window.calls = [];
    window.ass = { call: async (name, ...args) => {
      window.calls.push([name, ...args]);
      if (name === 'client-open-desktop') return new Promise((resolve,reject) => { window.launchPending={resolve,reject}; });
      if (name === 'connections-refresh') return new Promise((resolve,reject) => { window.refreshPending={resolve,reject}; });
      return {};
    } };
  });
});
after(async () => { await app?.close(); console.log('Codex launch UI screenshots: ' + output); });
beforeEach(async () => {
  errors.length = 0;
  await page.goto('file:///' + path.join(output, 'index.html').replaceAll('\\', '/'));
  await page.getByRole('group', { name: 'Codex 启动与连接修复', exact: true }).waitFor();
});
afterEach(() => assert.deepEqual(errors, [], 'no renderer or console errors'));
const launch = () => page.getByRole('button', { name: '通过 ASS 启动 Codex', exact: true });
test('Codex launch: missing desktop detection no longer hides the control', async () => {
  await page.evaluate(() => window.setCodexDesktop(null));
  assert.ok(await launch().isVisible()); assert.ok(await launch().isEnabled());
  await launch().hover();
  await page.getByText('尚未识别到 Codex 桌面端；点击启动会重新识别，也可在客户端设置中指定安装目录。', { exact: true }).waitFor();
  await launch().click();
  await page.evaluate(() => window.launchPending.resolve({ok:true,message:'Synthetic re-detection completed'}));
  await page.locator('.codex-launch-result').getByText('Synthetic re-detection completed',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c[0] === 'client-open-desktop')), [['client-open-desktop','codex']]);
});
test('Codex launch: inline control with hover/focus guidance, Escape dismissal and desktop light/dark layouts', async () => {
  const card = page.getByRole('group', { name: 'Codex 启动与连接修复', exact: true });
  assert.equal(await page.getByRole('tooltip').count(), 0, 'no permanent explanation card');
  await launch().hover(); const tip = page.getByRole('tooltip');
  assert.match(await tip.innerText(), /Couldn’t load workspace settings/);
  assert.match(await tip.innerText(), /Could not load project chats/);
  assert.match(await tip.innerText(), /不会自动关闭任务/);
  assert.match(await tip.innerText(), /不解除账号权限、订阅额度或官方网关限制/);
  await launch().focus(); await launch().press('Escape'); assert.equal(await tip.count(), 0);
  await page.getByRole('button', {name:'自动识别客户端',exact:true}).focus();
  await launch().focus(); await tip.waitFor();
  await page.mouse.move(5, 5);
  assert.ok(await tip.isVisible(), 'keyboard focus keeps guidance open after pointer leaves');
  assert.equal(await page.getByRole('button', { name: '打开 Codex 桌面端', exact: true }).count(), 0);
  for (const width of [1100, 1440]) for (const theme of ['light','dark']) {
    // Each screenshot intentionally hovers the launcher; leave it before
    // checking the next theme's idle palette rather than its hover color.
    await page.mouse.move(5, 5);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme=theme; }, theme);
    await launch().scrollIntoViewIfNeeded();
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.codex-launch-button')).backgroundColor === expected,
      theme === 'light' ? 'rgb(54, 59, 55)' : 'rgb(220, 226, 221)');
    const box = await launch().boundingBox(); assert.ok(box.width >= 90 && box.height >= 36);
    const pill = await page.getByRole('switch', {name:'Codex ASS 接入',exact:true}).boundingBox();
    assert.ok(box.x + box.width <= pill.x && Math.abs(box.y + box.height/2 - pill.y - pill.height/2) < 2,
      'launcher sits immediately left of the connection pill on the same row');
    assert.equal(await launch().evaluate(el => getComputedStyle(el).backgroundColor), theme === 'light' ? 'rgb(54, 59, 55)' : 'rgb(220, 226, 221)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.ok(await card.evaluate(el => el.parentElement === document.querySelector('.client-heading > .actions')));
    assert.equal(await page.title(), 'ASS Codex launch UI');
    assert.match(page.url(), /index\.html$/);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await launch().hover(); await tip.waitFor();
    await page.screenshot({ path: path.join(output, 'launch-' + theme + '-' + width + '.png'), animations: 'disabled' });
  }
});
test('Codex launch: calls the existing desktop IPC once, busy feedback and result stay near the button', async () => {
  await launch().click();
  await page.getByRole('button', { name: '正在打开 Codex…', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '正在打开 Codex…', exact: true }).isDisabled());
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c[0] === 'client-open-desktop')), [['client-open-desktop','codex']]);
  await page.evaluate(() => window.launchPending.resolve({ok:true,message:'Codex 已在运行；请在任务结束后完全退出，再从 ASS 打开。'}));
  const notice = page.locator('.codex-launch-result');
  await notice.waitFor(); assert.match(await notice.innerText(), /Codex 已在运行/);
  assert.ok(await launch().isEnabled());
  assert.equal(await page.getByRole('dialog').count(), 0);
  // A subsequent backend error must restore the control, not claim success.
  await launch().click(); await page.evaluate(() => window.launchPending.reject(Error('Synthetic launch failure')));
  await page.getByRole('alert').getByText('Synthetic launch failure',{exact:true}).waitFor();
  assert.ok(await launch().isEnabled()); assert.equal(await notice.count(), 0);
});
test('Codex launch: disconnected/accountless modes do not promise official repair or duplicate the desktop launcher', async () => {
  for (const accountless of [false,true]) {
    await page.evaluate(accountless => window.setConnection({enabled:accountless,accountless,accountlessAvailable:true,applied:true}), accountless);
    const card = page.locator('.codex-desktop-launch');
    await launch().hover();
    assert.doesNotMatch(await card.innerText(), /Couldn’t load workspace settings|可尝试修复/);
    assert.match(await card.innerText(), accountless ? /无账号配置/ : /未开启接入/);
    assert.equal(await launch().count(), 1);
    assert.equal(await page.getByRole('button', { name: '启动', exact: true }).count(), 0);
  }
  await page.evaluate(() => window.setConnection({enabled:true,accountless:true,accountlessAvailable:false}));
  assert.ok(await launch().isDisabled());
  await page.getByRole('button', { name: 'Claude Code', exact: true }).click();
  assert.equal(await page.locator('.codex-desktop-launch').count(), 0);
  assert.ok(await page.getByRole('button', { name: '打开 Claude Code 桌面端', exact: true }).isVisible());
});

test('bulk injection refresh: one call, disabled while pending, partial failures visible and zero client launch calls', async () => {
  const refresh = page.getByRole('button', {name:'刷新全部注入',exact:true});
  assert.ok(await refresh.isEnabled()); await refresh.click();
  assert.ok(await page.getByRole('button', {name:'正在刷新注入…',exact:true}).isDisabled());
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c[0] === 'connections-refresh')), [['connections-refresh']]);
  await page.evaluate(() => window.refreshPending.resolve({ok:false,refreshed:[{id:'codex',name:'Codex'}],
    skipped:[{id:'claude',name:'Claude Code',reason:'配置存在外部修改'}],message:'已刷新 1 个接入，跳过 1 个；未重启客户端。'}));
  await page.locator('.clients-refresh-result').getByText('Claude Code：配置存在外部修改',{exact:true}).waitFor();
  assert.ok(await refresh.isEnabled());
  assert.equal(await page.evaluate(() => window.calls.filter(c => /launch|open-desktop|connection-apply/.test(c[0])).length), 0);
  await refresh.click(); await page.evaluate(() => window.refreshPending.reject(Error('Synthetic refresh failure')));
  await page.getByRole('alert').getByText('Synthetic refresh failure',{exact:true}).waitFor();
  assert.ok(await refresh.isEnabled());
  await page.evaluate(() => window.setConnection({enabled:false})); assert.ok(await refresh.isDisabled());
});
