// Continuous, real Electron painting. Never pause/seek/finish the animations.
const {test,before,after,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron:electron}=require('playwright');
let app,page,output;const errors=[];
before(async()=>{
  output=fs.mkdtempSync(path.join(os.tmpdir(),'ass-theme-control-renderer-'));
  require('esbuild').buildSync({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ThemeControl,applyTheme} from './src/theme.jsx';import './src/theme.css';
    const initial=new URL(location.href).searchParams.get('mode')||'light';applyTheme(initial);
    function Fixture(){const [theme,setTheme]=useState(initial);return <div className="app-shell" data-input="pointer"><h1>ASS theme motion regression</h1><ThemeControl value={theme} onChange={setTheme}/><dialog><p>Modal remains above theme control</p></dialog></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:path.resolve(__dirname,'..'),loader:'jsx'},bundle:true,outfile:path.join(output,'renderer.js'),logLevel:'silent'});
  fs.writeFileSync(path.join(output,'index.html'),'<html><head><title>ASS theme motion regression</title><link rel="stylesheet" href="renderer.css"><style>.theme-control{position:fixed;left:16px;bottom:16px;width:184px}body{margin:0}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  fs.writeFileSync(path.join(output,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output,'profile'))});app.disableHardwareAcceleration();app.whenReady().then(()=>{new BrowserWindow({show:false,width:1100,height:760,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}).loadURL('about:blank')});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[...(process.platform==='linux'?['--no-sandbox']:[]),path.join(output,'main.cjs')],env});page=await app.firstWindow();page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.context().route(/^https?:/,route=>route.abort());
});
after(async()=>{await app?.close();console.log('Theme motion screenshots/samples: '+output);});
afterEach(()=>assert.deepEqual(errors,[]));
async function load(mode='light') {
  errors.length=0;await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
  await page.goto('file:///'+path.join(output,'index.html').replaceAll('\\','/')+'?mode='+mode);
  await page.locator('.theme-orbit').waitFor();
  await page.waitForFunction(mode=>document.querySelector('.theme-toggle').dataset.mode===mode,mode);
}
async function choose(mode) {
  const b=await page.locator('.theme-toggle').boundingBox();
  await page.mouse.click(b.x+(mode==='light'?19:mode==='dark'?b.width-19:b.width/2),b.y+20);
}
async function presented() {
  return page.locator('.theme-orbit').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
}
async function settle(mode) {
  await page.waitForFunction(mode=>{const b=document.querySelector('.theme-toggle');return b.dataset.mode===mode&&!b.hasAttribute('data-moving');},mode);
}
test('cross-color switching paints the thumb at its live position in both directions, not a frozen root screenshot',async()=>{
  for(const [from,to] of [['light','dark'],['dark','light']]) {
    await load(from);
    // A test-only marker makes actual painted position measurable, not just DOM
    // transforms. Native capturePage preserves OS/page scaling; normalize below.
    await page.addStyleTag({content:'.theme-orbit{background:rgb(235,40,120)!important;color:rgb(235,40,120)!important;box-shadow:none!important}.theme-orbit::after,.theme-ripples{display:none!important}'});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const box=await page.locator('.theme-toggle').boundingBox();
    const region={x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)};
    await choose(to);
    await page.waitForFunction(()=>document.documentElement.hasAttribute('data-theme-reveal'));
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.theme-control')).viewTransitionName),'ass-theme-control');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement,'::view-transition-old(ass-theme-control)').opacity),'0');
    const frames=[];
    for(let i=0;i<20;i++) {
      const before=await presented();
      const pixel=await app.evaluate(async({BrowserWindow},region)=>{
        const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage(region),{width,height}=image.getSize(),bytes=image.toBitmap();
        let count=0,total=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const j=(y*width+x)*4;
          if(bytes[j+2]>200&&bytes[j+1]<80&&bytes[j]>80&&bytes[j]<170){count++;total+=x;}}
        return {x:count?region.x+total/count/(width/region.width):null,count,width,height};
      },region);
      const after=await presented();
      frames.push({before:before.x,after:after.x,pixel:pixel.x,count:pixel.count});
      assert.ok(pixel.count>100,'thumb remains visibly painted: '+JSON.stringify({pixel,frames}));
      // Native capture may return the previously presented compositor frame,
      // not the newest DOM frame. Allow one prior sample, not a frozen old view.
      const previous=frames.at(-2)?.after??before.x;
      assert.ok(pixel.x>=Math.min(previous,before.x,after.x)-3&&pixel.x<=Math.max(previous,before.x,after.x)+3,
        'painted thumb must track the live spring throughout the snapshot: '+JSON.stringify(frames));
      await page.evaluate(()=>new Promise(requestAnimationFrame));
    }
    fs.writeFileSync(path.join(output,from+'-to-'+to+'.json'),JSON.stringify(frames,null,2));
    assert.ok(new Set(frames.map(f=>Math.round(f.pixel))).size>3,'continuous motion is visible, not only the endpoints');
    await settle(to);assert.equal(await page.title(),'ASS theme motion regression');
    assert.match(page.url(),/index\.html\?mode=/);assert.equal(await page.locator('vite-error-overlay').count(),0);
  }
});
test('same-color automatic selection, rapid reversal, drag release and keyboard retain the latest mode',async()=>{
  await load();await choose('system');await settle('system');
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme-reveal')),false);
  await choose('dark');await page.waitForFunction(()=>document.documentElement.hasAttribute('data-theme-reveal'));
  await choose('light');await settle('light');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.colorTheme),'light');
  const b=await page.locator('.theme-toggle').boundingBox();
  await page.mouse.move(b.x+19,b.y+20);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+20,{steps:6});
  assert.ok(Math.abs(await page.locator('.theme-toggle').evaluate(el=>Number(el.style.getPropertyValue('--theme-position')))-.5)<.03);
  await page.mouse.up();await settle('system');
  await page.locator('.theme-toggle').press('End');await settle('dark');
  await page.locator('.theme-toggle').press('Home');await settle('light');
  await page.emulateMedia({reducedMotion:'reduce'});await choose('dark');await settle('dark');
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme-reveal')),false);
});
test('automatic OS change keeps the thumb centered and modal blocking does not lift the control above the dialog',async()=>{
  await load('system');await settle('system');const before=await presented();
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.colorTheme==='dark');
  assert.ok(Math.abs((await presented()).x-before.x)<1);
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-theme-reveal'));
  await page.evaluate(()=>document.querySelector('dialog').showModal());
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.colorTheme==='light');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.theme-control')).viewTransitionName),'none');
  assert.ok(await page.getByRole('dialog').isVisible());
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-theme-reveal'));
  await page.evaluate(()=>document.querySelector('dialog').close());
  await page.locator('.theme-control').screenshot({path:path.join(output,'capsule-light.png')});
  await choose('dark');await settle('dark');await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-theme-reveal'));
  await page.locator('.theme-control').screenshot({path:path.join(output,'capsule-dark.png')});
});
test('reduced motion disables decorative theme animations',async()=>{
  await load('system');
  await page.emulateMedia({reducedMotion:'reduce'});await settle('system');
  for(const selector of ['.theme-dawn-sun','.theme-sea-wave','.theme-sun-idle','.theme-ripples i'])
    assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
});
