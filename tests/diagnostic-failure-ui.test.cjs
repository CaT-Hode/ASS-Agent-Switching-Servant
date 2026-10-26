// Browser plugin not available. Real React DOM in an isolated Electron profile;
// every HTTP request is blocked and all results are synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron: electron } = require('playwright');
let app, page, output; const errors = [];
before(async () => {
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-diagnostic-failure-ui-'));
  require('esbuild').buildSync({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {ModelCheckButton,ModelProtocolBadges} from './src/model-inspection.jsx';
    import './src/style.css';import './src/controls.css';import './src/theme.css';
    function Fixture(){const [results,setResults]=useState([]);window.showResults=values=>flushSync(()=>setResults(values));
      return <main style={{maxWidth:1040,margin:'30px auto',padding:24}}><h1>连接诊断</h1><div className="diagnostic-list">
        {results.map((r,i)=>{const state={diagnostics:r.protocolOnly?{}:{[JSON.stringify(['p',r.model])]:r},protocolResults:{[JSON.stringify(['p',r.model])]:r.protocols?{protocols:r.protocols}:undefined}};
          return <div className="diagnostic" key={i}><div className="diagnostic-content"><h3>{r.model}</h3>
          <ModelProtocolBadges provider={{id:'p'}} model={{model:r.model}} state={state}/></div>
          <ModelCheckButton provider={{id:'p',enabled:true}} model={{model:r.model}} state={state} busy="" act={(_,fn)=>fn()}/></div>})}
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

test('an HTTP 400 recheck cannot display historical Responses success as a current green badge', async () => {
  await page.evaluate(() => window.showResults([{model:'claude-haiku-5-5',protocolOnly:true,ms:400,
    protocols:{'openai-responses':{status:'passed',lastStatus:'unknown',httpStatus:400,lastSuccess:'2026-10-20T02:00:00Z'}}}]));
  const badge=page.locator('.model-protocol-badges > span').first();
  assert.equal(await badge.getAttribute('data-status'),'unknown');
  assert.match(await badge.getAttribute('title'),/曾通过，本次未确认.*HTTP 400/);
  assert.doesNotMatch(await page.getByRole('button',{name:'检测模型 claude-haiku-5-5',exact:true}).getAttribute('class'),/passed/);
  await page.evaluate(() => window.showResults([{model:'claude-haiku-5-5',ok:false,protocol:'openai-responses',httpStatus:400,ms:400,time:'2026-10-21T07:12:30Z',
    protocols:{'openai-responses':{status:'passed',lastStatus:'passed',httpStatus:200,time:'2026-10-21T07:12:29Z'}}}]));
  assert.equal(await badge.getAttribute('data-status'),'unknown','a newer connection failure overrides a successful preliminary probe');
  assert.match(await badge.getAttribute('title'),/HTTP 400/);
  await page.evaluate(() => window.showResults([{model:'claude-haiku-5-5',protocolOnly:true,ms:40,
    protocols:{'openai-responses':{status:'passed',lastStatus:'passed',httpStatus:200}}}]));
  assert.equal(await badge.getAttribute('data-status'),'passed');
  assert.deepEqual(errors,[]);
});
after(async () => { await app?.close(); });
