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
test('sunset rotates exposed rays with stronger ripples and no capsule rim, pauses on drag and respects reduced motion',async()=>{
  await load('system');await settle('system');
  const samples=await page.evaluate(async()=>{
    const result=[];for(let i=0;i<12;i++){
      await new Promise(requestAnimationFrame);const b=document.querySelector('.theme-orbit');
      result.push({x:b.getBoundingClientRect().x,sun:getComputedStyle(document.querySelector('.theme-dawn-sun')).transform,
        rays:getComputedStyle(document.querySelector('.theme-sun-idle')).transform,
        ripple:getComputedStyle(document.querySelector('.theme-ripples i')).transform,
        ember:getComputedStyle(b,'::before').opacity,horizon:getComputedStyle(document.querySelector('.theme-horizon > path')).transform,
        sea:getComputedStyle(document.querySelector('.theme-sea-wave')).transform,reflection:getComputedStyle(document.querySelector('.theme-sea-reflection')).opacity});
    }return result;
  });
  assert.ok(new Set(samples.map(s=>s.sun)).size>3,'sun sinks/rises behind the fixed horizon');
  assert.ok(new Set(samples.map(s=>s.rays)).size>3,'exposed rays rotate in automatic mode, not only in light mode');
  assert.ok(new Set(samples.map(s=>s.ripple)).size>3,'larger concentric ripples expand under the thumb');
  const decoration=await page.evaluate(()=>{
    const toggle=getComputedStyle(document.querySelector('.theme-toggle'));
    const ripples=[...document.querySelectorAll('.theme-ripples i')].map(el=>el.getAnimations()[0]);
    const orbit=new DOMMatrix(getComputedStyle(document.querySelector('.theme-orbit')).transform);
    return {border:toggle.borderColor,shadow:toggle.boxShadow,orbit:[orbit.a,orbit.b,orbit.c,orbit.d],
      rayDuration:document.querySelector('.theme-sun-idle').getAnimations()[0].effect.getTiming().duration,
      rippleDuration:ripples[0].effect.getTiming().duration,
      ripplePeak:Math.max(...ripples[0].effect.getKeyframes().map(f=>Number(f.opacity))),
      rippleScale:new DOMMatrix(ripples[0].effect.getKeyframes().at(-1).transform).a,
      waveStroke:parseFloat(getComputedStyle(document.querySelector('.theme-sea-wave')).strokeWidth)};
  });
  assert.equal(decoration.border,'rgba(0, 0, 0, 0)');assert.equal(decoration.shadow,'none');
  assert.deepEqual(decoration.orbit,[1,0,0,1],'ray rotation never rotates the draggable thumb');
  assert.equal(decoration.rayDuration,26400,'sunset rays rotate at one third of the previous speed');
  assert.ok(decoration.rippleDuration<=5000&&decoration.ripplePeak>=.25&&decoration.rippleScale>=4);
  assert.ok(decoration.waveStroke>=1);
  assert.ok(new Set(samples.map(s=>s.ember)).size>3,'warm inner light breathes');
  assert.ok(new Set(samples.map(s=>s.horizon)).size>3,'reflection lines have their own motion');
  assert.ok(new Set(samples.map(s=>s.sea)).size>3,'sea waves drift naturally');
  assert.ok(new Set(samples.map(s=>s.reflection)).size>3,'sunset reflection shimmers');
  assert.equal(await page.locator('.theme-sea').evaluate(el=>getComputedStyle(el).opacity),'1');
  const seaIsBlue = () => page.locator('.theme-sea-stop-near').evaluate(el => {
    const [r,g,b] = getComputedStyle(el).stopColor.match(/\d+/g).map(Number);
    return b > r + 30 && b > g + 15;
  });
  assert.ok(await seaIsBlue(), 'light-system sunset retains blue water, not gray-green');
  assert.ok(Math.max(...samples.map(s=>s.x))-Math.min(...samples.map(s=>s.x))<.1,'decoration must not animate the draggable position');
  await page.locator('.theme-control').screenshot({path:path.join(output,'capsule-sunset-enhanced.png')});
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-theme-reveal'));
  await page.waitForFunction(()=>document.documentElement.dataset.colorTheme==='dark');
  assert.ok(await seaIsBlue(), 'dark-system sea remains visibly blue');
  await page.locator('.theme-control').screenshot({path:path.join(output,'capsule-sea-dusk.png')});
  const thumb=await presented();await page.mouse.move(thumb.x,thumb.y);await page.mouse.down();await page.mouse.move(thumb.x+8,thumb.y,{steps:3});
  const paused=await page.evaluate(async()=>{
    const sun=document.querySelector('.theme-dawn-sun'),orbit=document.querySelector('.theme-orbit'),animation=sun.getAnimations()[0];
    const before=animation.currentTime;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    return {sun:getComputedStyle(sun).animationPlayState,ember:getComputedStyle(orbit,'::before').animationPlayState,
      rays:getComputedStyle(document.querySelector('.theme-sun-idle')).animationPlayState,
      ripples:[...document.querySelectorAll('.theme-ripples i')].map(el=>getComputedStyle(el).animationPlayState),
      sea:getComputedStyle(document.querySelector('.theme-sea-wave')).animationPlayState,before,after:animation.currentTime};
  });
  assert.equal(paused.sun,'paused');assert.equal(paused.ember,'paused');assert.ok(Math.abs(paused.after-paused.before)<1);
  assert.equal(paused.sea,'paused');
  assert.equal(paused.rays,'paused');assert.ok(paused.ripples.every(value=>value==='paused'));
  await page.mouse.up();await settle('system');
  assert.equal(await page.locator('.theme-dawn-sun').evaluate(el=>getComputedStyle(el).animationPlayState),'running');
  assert.equal(await page.locator('.theme-sun-idle').evaluate(el=>getComputedStyle(el).animationPlayState),'running');
  for(const mode of ['light','dark']) {
    await choose(mode);await settle(mode);
    assert.equal(await page.locator('.theme-dawn-sun').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m42),0);
    assert.equal(await page.locator('.theme-orbit').evaluate(el=>getComputedStyle(el,'::before').opacity),'0');
    assert.equal(await page.locator('.theme-sea').evaluate(el=>getComputedStyle(el).opacity),'0');
    assert.equal(await page.locator('.theme-sun-idle').evaluate(el=>getComputedStyle(el).animationPlayState),mode==='light'?'running':'paused');
    assert.equal(await page.locator('.theme-toggle').evaluate(el=>getComputedStyle(el).borderColor),'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.theme-toggle').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  }
  await page.emulateMedia({reducedMotion:'reduce'});await choose('system');await settle('system');
  assert.equal(await page.locator('.theme-dawn-sun').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.locator('.theme-orbit').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
  assert.equal(await page.locator('.theme-sea-wave').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.locator('.theme-sun-idle').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.locator('.theme-ripples i').first().evaluate(el=>getComputedStyle(el).animationName),'none');
});
