// Actual React DOM and clicks in a private Electron profile; no native accounts.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron: electron } = require('playwright');
let app, page, output; const errors = [];
before(async () => {
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-repair-ui-'));
  require('esbuild').buildSync({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {ConnectionDialog} from './src/connections.jsx';
    import './src/style.css';import './src/controls.css';import './src/theme.css';
    function Fixture(){
      const [value,setValue]=useState(null);window.mountRepair=next=>flushSync(()=>setValue(next));
      if(!value)return <main>Connection repair fixture</main>;
      const {id='codex',issue='Synthetic connection issue',ambiguous=false,enabled=true,pending=false}=value;
      const client={id,name:id==='codex'?'Codex':'pi',launcher:{ambiguous},injection:{models:[]}};
      return <ConnectionDialog request={value.request} state={{harnesses:{clients:[client]},connections:{busy:false,clients:{[id]:{enabled,pending,syncError:issue}}}}}
        onComplete={(...args)=>window.completed.push(args)} onClose={()=>window.closedCount++}/>;
    }createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' },
    bundle: true, outfile: path.join(output, 'renderer.js'), platform: 'browser', logLevel: 'silent' });
  fs.writeFileSync(path.join(output,'index.html'), `<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'"><title>ASS connection repair UI</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  fs.writeFileSync(path.join(output,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output,'profile'))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}).loadURL('about:blank')});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[...(process.platform==='linux'?['--no-sandbox']:[]),path.join(output,'main.cjs')],env});page=await app.firstWindow();page.setDefaultTimeout(3500);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  await page.context().route(/^https?:/,route=>route.abort());
  await page.addInitScript(()=>{
    window.calls=[];window.completed=[];window.closedCount=0;window.pending={};window.previews=0;
    window.wait=key=>new Promise((resolve,reject)=>{window.pending[key]={resolve,reject};});
    window.normalPreview=async()=>{throw Error('Synthetic normal preview failure');};
    window.repairPreview=async()=>({ticket:'repair-'+(++window.previews),names:['Codex'],files:1});
    window.applyRepair=async()=>window.wait('apply');
    window.ass={call:async(name,...args)=>{window.calls.push([name,...args]);
      if(name==='connection-preview')return window.normalPreview(...args);
      if(name==='connection-repair-preview')return window.repairPreview(...args);
      if(name==='connection-repair')return window.applyRepair(...args);
      return {};
    }};
  });
});
after(async()=>{await app?.close();console.log('Connection repair UI evidence: '+output);});
beforeEach(async()=>{errors.length=0;await page.goto('file:///'+path.join(output,'index.html').replaceAll('\\','/'));});
afterEach(async()=>{assert.deepEqual(errors,[],'no renderer or console errors');assert.equal(await page.locator('vite-error-overlay').count(),0);});
const mount = (args={})=>page.evaluate(args=>{const id=args.id||'codex';window.mountRepair({...args,request:{scope:id,enabled:false,name:id==='codex'?'Codex':'pi'}});},args);
const repair = ()=>page.getByRole('button',{name:/^(一键修复|重试修复)$/});
const settle = ()=>page.evaluate(()=>window.pending.apply.resolve({ok:true,message:'Synthetic repair completed'}));

test('repair preview failure leaves a clickable retry which inspects again and prevents double apply',async()=>{
  await page.evaluate(()=>{const next=window.repairPreview;let first=true;window.repairPreview=async()=>{if(first){first=false;throw Error('Synthetic unavailable checkpoint');}return next();};});
  await mount();await page.getByText(/Synthetic unavailable checkpoint/).waitFor();
  assert.ok(await repair().isEnabled(),'repair must remain retryable after inspection failure');
  await repair().click();await page.getByRole('button',{name:'修复中…',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'修复中…',exact:true}).isDisabled());await settle();
  await page.waitForFunction(()=>window.closedCount===1);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='connection-repair').length),1);
  assert.deepEqual(await page.evaluate(()=>window.completed),[['Synthetic repair completed',false]]);
});

test('a slow ordinary preview never blocks an independently available repair',async()=>{
  await page.evaluate(()=>{window.normalPreview=()=>window.wait('normal');});await mount();
  await page.waitForFunction(()=>window.calls.some(c=>c[0]==='connection-repair-preview'));
  assert.ok(await repair().isEnabled(),'ordinary process inspection cannot lock repair');
  await repair().click();await page.waitForFunction(()=>!!window.pending.apply);
  await page.evaluate(()=>window.pending.normal.reject(Error('Late normal preview failure')));await settle();
  await page.waitForFunction(()=>window.closedCount===1);assert.equal(await page.getByText('Late normal preview failure',{exact:true}).count(),0);
});

test('failed apply can be retried in the same dialog with a fresh ticket',async()=>{
  await mount();await page.waitForFunction(()=>window.previews===1);await repair().click();
  await page.evaluate(()=>window.pending.apply.reject(Error('Synthetic disk full')));await page.getByText('Synthetic disk full',{exact:true}).waitFor();
  assert.ok(await repair().isEnabled());await repair().click();await page.waitForFunction(()=>window.previews===2);await settle();
  await page.waitForFunction(()=>window.closedCount===1);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c[0]==='connection-repair').map(c=>c[1])),[
    {ticket:'repair-1',acknowledged:true,restart:false,close:false},{ticket:'repair-2',acknowledged:true,restart:false,close:false}]);
});

test('ambiguous executable location still allows config-only repair with no process stop',async()=>{
  await mount({ambiguous:true});await repair().waitFor();assert.ok(await repair().isEnabled());await repair().click();await page.waitForFunction(()=>!!window.pending.apply);await settle();
  await page.waitForFunction(()=>window.closedCount===1);assert.equal(await page.evaluate(()=>window.calls.some(c=>/open-desktop|client-launch|client-stop/.test(c[0]))),false);
});

test('healthy enabled, disabled and pending-draft connections hide repair and skip repair inspection',async()=>{
  await page.evaluate(()=>{window.normalPreview=async()=>({ticket:'normal',names:['Codex'],sessions:[],enabled:false});});
  for(const [enabled,pending] of [[true,false],[false,false],[true,true],[true,false]]) {
    await mount({issue:'',enabled,pending});await page.getByRole('button',{name:'断开接入',exact:true}).waitFor();
    await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='断开接入')?.disabled);
    assert.equal(await repair().count(),0);assert.equal(await page.locator('.connection-repair-note').count(),0);
  }
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='connection-repair-preview').length),0);
  assert.equal(await page.title(),'ASS connection repair UI');assert.match(page.url(),/index\.html$/);
  for(const width of [1100,1440]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(output,'healthy-'+width+'.png'),animations:'disabled',timeout:15000});}
});

test('a late repair preview cannot reveal repair on a newly opened healthy connection',async()=>{
  await page.evaluate(()=>{window.normalPreview=async()=>({ticket:'normal',names:['Codex'],sessions:[],enabled:false});window.repairPreview=()=>window.wait('inspection');});
  await mount();await page.waitForFunction(()=>!!window.pending.inspection);assert.equal(await repair().count(),1);
  await mount({issue:''});await page.getByRole('button',{name:'断开接入',exact:true}).waitFor();
  await page.evaluate(()=>window.pending.inspection.resolve({ticket:'old-repair',names:['Codex'],files:1}));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await repair().count(),0);assert.equal(await page.locator('.connection-repair-note').count(),0);
});

test('a late repair completion cannot close or overwrite a newly opened client dialog',async()=>{
  await mount();await page.waitForFunction(()=>window.previews===1);await repair().click();await page.waitForFunction(()=>!!window.pending.apply);
  await mount({id:'pi'});await page.waitForFunction(()=>window.calls.some(c=>c[0]==='connection-preview'&&c[1]==='pi'));
  await settle();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.closedCount),0);assert.deepEqual(await page.evaluate(()=>window.completed),[]);
  assert.ok(await repair().isEnabled());
});
