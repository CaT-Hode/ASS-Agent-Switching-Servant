const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron: electron } = require('playwright');
let app, page, directory; const errors = [];
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-surface-motion-'));
  require('esbuild').buildSync({ stdin: { contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{transitionUI,Presence}from'./src/surface-motion.jsx';import'./src/style.css';import'./src/theme.css';import'./src/motion.css';
    const nativeTransition=document.startViewTransition.bind(document);
    document.startViewTransition=update=>{window.lastTransition=nativeTransition(update);return window.lastTransition;};
    function Fixture(){const[pane,setPane]=useState('A'),[notice,setNotice]=useState(true);
      window.move=(name,direction)=>transitionUI(()=>setPane(name),{direction});window.notice=setNotice;
      return <div className="app-shell" data-input="pointer" onPointerDownCapture={e=>e.currentTarget.dataset.input='pointer'} onKeyDownCapture={e=>e.currentTarget.dataset.input='keyboard'}>
        <main className="page-content" style={{margin:0,padding:32}}><nav>{['A','B','C'].map(name=><button key={name} onClick={()=>window.move(name)}>Show {name}</button>)}</nav>
          <section key={pane}><h1>Pane {pane}</h1><div className="token-stack" style={{height:70,width:20,background:'#68b69b'}}/></section>
          <Presence show={notice}>{notice&&<section aria-label="Transient surface">Notice</section>}</Presence></main></div>;}
    createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' },
    bundle: true, outfile: path.join(directory, 'renderer.js'), platform: 'browser', logLevel: 'silent' });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><title>ASS motion QA</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{sandbox:true,backgroundThrottling:false}}).loadURL('about:blank'));`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(directory, 'main.cjs')], env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('file:///' + path.join(directory, 'index.html').replaceAll('\\', '/'));
});
after(async () => { await app?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test('native page entry/exit is interruptible; keyboard navigation and theme reveal commit immediately', async () => {
  await page.getByRole('heading', { name: 'Pane A', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof document.startViewTransition), 'function');
  await page.evaluate(() => { window.move('B'); window.move('C'); window.move('A'); });
  await page.getByRole('heading', { name: 'Pane A', exact: true }).waitFor();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-transition'));
  await page.getByRole('button', { name: 'Show B', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('heading', { name: 'Pane B', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-ui-transition')), false);
  await page.evaluate(() => { document.querySelector('.app-shell').dataset.input = 'pointer'; document.documentElement.dataset.themeReveal = 'circle'; window.move('C'); });
  assert.equal(await page.getByRole('heading', { name: 'Pane C', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-ui-transition')), false);
  await page.evaluate(() => delete document.documentElement.dataset.themeReveal);
  assert.deepEqual(errors, []);
});

test('navigation directions reverse entry/exit; detail depth moves horizontally and peers only fade', async () => {
  const output = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ASS-validation'); fs.mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [direction, pane, enterX, enterY, exitX, exitY] of [
    ['down', 'A', 0, 1, 0, -1], ['up', 'B', 0, -1, 0, 1],
    ['forward', 'C', 1, 0, -1, 0], ['back', 'B', -1, 0, 1, 0], ['fade', 'C', 0, 0, 0, 0],
  ]) {
    const motion = await page.evaluate(async ({ direction, pane }) => {
      document.querySelector('.app-shell').dataset.input = 'pointer';
      window.move(pane, direction); await window.lastTransition.ready;
      const animations = document.getAnimations().filter(a => ['surface-in', 'surface-out'].includes(a.animationName));
      const sample = name => {
        const animation = animations.find(a => a.animationName === name), frames = animation.effect.getKeyframes();
        const frame = name === 'surface-in' ? frames[0] : frames.at(-1);
        const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;pointer-events:none'; probe.style.transform = frame.transform;
        document.body.append(probe); const matrix = new DOMMatrix(getComputedStyle(probe).transform); probe.remove();
        return [Math.sign(matrix.m41), Math.sign(matrix.m42)];
      };
      const result = { direction: document.documentElement.dataset.uiTransition, enter: sample('surface-in'), exit: sample('surface-out') };
      window.surfaceAnimations = animations;
      for (const animation of animations) { animation.pause(); animation.currentTime = 70; }
      return result;
    }, { direction, pane });
    assert.equal(motion.direction, direction);
    assert.deepEqual(motion.enter, [enterX, enterY]);
    assert.deepEqual(motion.exit, [exitX, exitY]);
    if (['up', 'down'].includes(direction)) await page.screenshot({ path: path.join(output, `ass-nav-motion-${direction}.png`) });
    await page.evaluate(async () => { for (const animation of window.surfaceAnimations) animation.finish(); await window.lastTransition.finished; });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-transition'));
  }
  assert.deepEqual(errors, []);
});

test('bars rise once, reduced motion uses a short fade, and transient surfaces remain through exit', async () => {
  await page.getByRole('button', { name: 'Show A', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Pane A' && !document.documentElement.hasAttribute('data-ui-transition'));
  const bar = await page.locator('.token-stack').evaluate(node => {
    const animation = node.getAnimations().find(value => value.animationName === 'bars-rise');
    if (!animation) return null;
    animation.currentTime = 0;
    const start = getComputedStyle(node).transform; animation.finish();
    return { duration: animation.effect.getTiming().duration, start, end: getComputedStyle(node).transform };
  });
  assert.equal(bar.duration, 260); assert.notEqual(bar.start, bar.end);
  await page.evaluate(() => window.notice(false));
  assert.equal(await page.locator('.motion-presence').count(), 1, 'real DOM remains while exiting');
  await page.waitForFunction(() => !document.querySelector('.motion-presence'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.querySelector('.app-shell').dataset.input = 'pointer'; window.move('C', 'down'); });
  await page.getByRole('heading', { name: 'Pane C', exact: true }).waitFor();
  const reduced = await page.locator('.token-stack').evaluate(node => ({
    input: document.querySelector('.app-shell').dataset.input, matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration,
    animations: node.getAnimations().map(animation => ({ name: animation.animationName, duration: animation.effect.getTiming().duration,
      transforms: animation.effect.getKeyframes().map(frame => frame.transform || 'none') })),
  }));
  assert.ok(reduced.animations.some(animation => animation.name === 'surface-soft' && animation.duration === 80), JSON.stringify(reduced));
  assert.ok(reduced.animations.every(animation => animation.transforms.every(value => value === 'none')));
  assert.deepEqual(errors, []);
});
