// Browser plugin not available. Real React DOM in an isolated Electron profile;
// every HTTP request is blocked and all results are synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron: electron } = require('playwright');
const { classifyFailure } = require('../core/diagnostic-failure.cjs');
let app, page, output; const errors = [];
before(async () => {
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-diagnostic-failure-ui-'));
  require('esbuild').buildSync({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {DiagnosticDetails} from './src/diagnostic-details.jsx';import {ModelCheckButton} from './src/model-inspection.jsx';
    import './src/style.css';import './src/controls.css';import './src/theme.css';
    function Fixture(){const [results,setResults]=useState([]);window.showResults=values=>flushSync(()=>setResults(values));
      return <main style={{maxWidth:1040,margin:'30px auto',padding:24}}><h1>连接诊断</h1><div className="diagnostic-list">
        {results.map((r,i)=><div className="diagnostic" key={i}><div className="diagnostic-content"><h3>{r.model}</h3><p className="danger">{r.message}</p><DiagnosticDetails result={r}/></div>
          <ModelCheckButton provider={{id:'p',enabled:true}} model={{model:r.model}} state={{diagnostics:{[JSON.stringify(['p',r.model])]:r}}} busy="" act={(_,fn)=>fn()}/></div>)}
      </div></main>;
    }createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' },
    bundle: true, outfile: path.join(output, 'renderer.js'), platform: 'browser', logLevel: 'silent' });
  fs.writeFileSync(path.join(output, 'index.html'), '<html><head><meta charset="UTF-8"><title>ASS diagnostic classification</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  fs.writeFileSync(path.join(output, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output,'profile'))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1280,height:1100,webPreferences:{sandbox:true,contextIsolation:true}}).loadURL('about:blank')});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(output, 'main.cjs')], env });
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if(e.type() === 'error') errors.push(e.text()); });
  await page.context().route(/^https?:/, r => r.abort());
  await page.addInitScript(() => { window.calls=[]; window.ass={call:async(...args)=>window.calls.push(args)}; });
  await page.goto('file:///' + path.join(output, 'index.html').replaceAll('\\', '/'));
  await page.getByRole('heading', { name: '连接诊断', exact: true }).waitFor();
});
after(async () => { await app?.close(); console.log('Diagnostic classification screenshots: ' + output); });
test('failure labels, safe guidance, upstream/local status, lightning tooltip and recheck render in light/dark', async () => {
  const dns = classifyFailure(Error('net::ERR_NAME_NOT_RESOLVED'), { localStatus: 502 });
  const auth = classifyFailure(null, { httpStatus: 401, body: { error: { code: 'invalid_api_key' } } });
  const quota = classifyFailure(null, { httpStatus: 429, body: { error: { code: 'insufficient_quota' } } });
  const results = [dns, auth, quota].map((r,i) => ({...r, model:['DNS 模型','认证模型','额度模型'][i], ok:false, route:'router', phase:'headers', protocol:'openai-responses', ms:123, time:'2026-10-19T02:10:00Z'}));
  await page.evaluate(r => window.showResults(r), results);
  assert.equal(await page.title(), 'ASS diagnostic classification');
  const cards = page.locator('.diagnostic');
  assert.equal(await cards.count(), 3);
  for (const label of ['DNS 解析失败','认证失败','额度或余额耗尽']) assert.ok(await page.getByText(label,{exact:true}).isVisible());
  assert.equal(await cards.nth(0).locator('.diagnostic-measurements').first().innerText().then(t=>t.includes('未收到')), true);
  await cards.nth(0).getByText('测试详情',{exact:true}).click();
  await cards.nth(0).getByText('ERR_NAME_NOT_RESOLVED',{exact:true}).waitFor();
  assert.match(await cards.nth(0).innerText(), /ASS 本地 HTTP\s+502/);
  assert.match(await cards.nth(1).innerText(), /上游 HTTP\s+401/);
  assert.match(await cards.nth(2).innerText(), /上游 HTTP\s+429/);
  const button = page.getByRole('button',{name:'检测模型 DNS 模型',exact:true});
  assert.match(await button.getAttribute('title'), /ERR_NAME_NOT_RESOLVED.*未收到上游 HTTP/);
  await button.click(); assert.deepEqual(await page.evaluate(()=>window.calls), [['diagnose','p','DNS 模型']]);
  for (const theme of ['dark','light']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme, theme);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('vite-error-overlay').count(),0);
    await page.screenshot({path:path.join(output,theme+'.png'),animations:'disabled',fullPage:true});
  }
  await page.evaluate(()=>window.showResults([{ok:false,model:'旧模型',ms:100,httpStatus:502,message:'HTTP 502',time:'2026-10-19T02:10:00Z'}]));
  assert.ok(await page.getByText('旧版检测记录',{exact:true}).isVisible());
  assert.ok(await page.getByText('HTTP（旧记录）',{exact:true}).isVisible());
  assert.match(await page.locator('main').innerText(), /通用 502 不能判断 DNS、密钥或额度/);
  assert.deepEqual(errors, []);
});
