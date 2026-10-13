// Isolated Electron interaction check; does not use or stop the installed ASS.
const { _electron: electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-about-choreography-'));
const env = { ...process.env, ASS_TEST_DATA: path.join(out, 'data'), ASS_TEST_CODEX: path.join(out, 'codex'), ASS_TEST_PORT: '25867' };
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({ args: [root, '--qa'], env, timeout: 60000 });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('.theme-toggle');
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.locator('.theme-toggle').press('Home');
    await page.getByRole('button', { name: '关于 ASS', exact: true }).click();
    await page.locator('.about-playground').waitFor();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const logo = page.getByRole('button', { name: '旋转 ASS 花瓣', exact: true });
    const heroRect = await page.locator('.about-playground').boundingBox();
    const clip = Object.fromEntries(Object.entries(heroRect).map(([key, value]) => [key, Math.round(value)]));
    const capture = async name => {
      const png = await app.evaluate(async ({ BrowserWindow }, clip) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip)).toPNG().toString('base64'), clip);
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png, 'base64'));
    };
    const at = fraction => page.waitForFunction(f => {
      const motion = document.querySelector('.about-flower').getAnimations()[0];
      return motion && motion.currentTime / motion.effect.getTiming().duration >= f;
    }, fraction);
    const stats = () => page.locator('.about-playground').evaluate(n => {
      const info = sel => {
        const node = n.querySelector(sel), style = getComputedStyle(node), matrix = new DOMMatrix(style.transform);
        return { opacity: Number(style.opacity), scale: Math.hypot(matrix.a, matrix.b), angle: Math.atan2(matrix.b, matrix.a), d: style.d };
      };
      return { time: n.querySelector('.about-flower').getAnimations()[0]?.currentTime, power: Number(n.style.getPropertyValue('--about-power')), hub: info('#hub-fitted'), flower: info('.about-flower'), peach: info('.about-peach'), petal: info('path[id^="petal-"]') };
    });
    const originError = () => page.locator('.about-playground').evaluate(n => {
      const pose = n.querySelector('.about-figure-origin');
      const origin = new DOMPoint(pose.cx.baseVal.value, pose.cy.baseVal.value).matrixTransform(pose.getScreenCTM());
      const art = n.querySelector('.about-sculpture svg');
      const center = new DOMPoint(626.5, 627).matrixTransform(art.getScreenCTM());
      return Math.hypot(origin.x - center.x, origin.y - center.y);
    });
    const baseline = await stats();
    const seamAlpha = await page.locator('.about-peach svg').evaluate(async svg => {
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await image.decode();
      const box = svg.viewBox.baseVal, canvas = document.createElement('canvas');
      canvas.width = box.width; canvas.height = box.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, box.width, box.height);
      return [[375, 650], [396, 800], [378, 940], [250, 750]].map(([x, y]) => context.getImageData(x - box.x, y - box.y, 1, 1).data[3]);
    });
    assert.deepEqual(seamAlpha, [0, 255, 255, 255], 'only the central inset is open; the lower seam and body stay closed');
    await logo.click();
    await at(.1);
    const contracting = await stats();
    assert.ok(contracting.hub.scale > .1 && contracting.hub.scale < .9);
    assert.notEqual(contracting.petal.d, baseline.petal.d, 'petals and orange center must contract together');
    assert.ok(Math.abs(contracting.flower.scale - 1) < .001);
    assert.equal(await page.locator('.about-playground').evaluate(n => getComputedStyle(n, '::before').content), 'none');
    assert.equal(await page.locator('.about-peach-leaf').count(), 0);
    await at(.28);
    const hubGone = await stats();
    assert.equal(hubGone.hub.opacity, 0); assert.ok(hubGone.hub.scale < .001);
    assert.ok(Math.abs(hubGone.flower.scale - 1) < .001);
    await capture('01-hub-gone');
    const gathered = await stats();
    assert.ok(Math.abs(gathered.flower.scale - 1) < .001, 'outer flower must not scale during root gathering');
    assert.notEqual(gathered.petal.d, baseline.petal.d);
    // Coordinates on the exterior stay fixed; the inner roots move materially.
    const coords = d => [...d.matchAll(/[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g)].map(m => Number(m[0]));
    const before = coords(baseline.petal.d), after = coords(gathered.petal.d);
    assert.equal(before.length, after.length);
    let fixed = 0, pulled = 0;
    for (let i = 0; i < before.length; i += 2) {
      const radius = Math.hypot(before[i] - 626.5, before[i + 1] - 627);
      const delta = Math.hypot(before[i] - after[i], before[i + 1] - after[i + 1]);
      if (radius >= 520) { assert.ok(delta < .02, 'outer curve changed during gathering'); fixed++; }
      if (radius < 330 && delta > 100) pulled++;
    }
    assert.ok(fixed > 10 && pulled > 3);
    await capture('02-inner-edges-gathered');
    await at(.435);
    const collapsed = await stats(); assert.ok(collapsed.flower.scale < .15);
    await at(.625);
    const inflated = await stats(); assert.ok(inflated.peach.opacity > .99 && inflated.peach.scale > 1.2 && inflated.flower.opacity === 0);
    assert.equal(await page.locator('.about-peach-half').count(), 0);
    await capture('03-intact-peach-inflates');
    await at(.7);
    const emerging = await stats();
    assert.ok(emerging.flower.opacity > .1 && emerging.flower.opacity < .9 && emerging.flower.scale > .12 && emerging.flower.scale < .6);
    assert.ok(emerging.peach.opacity > .1 && emerging.peach.opacity < .9);
    assert.ok(Math.abs(emerging.flower.opacity + emerging.peach.opacity - 1) < .02, 'logo appearance and peach disappearance share the same clock');
    const emergingOriginError = await originError();
    assert.ok(emergingOriginError < .5, `logo emergence is displaced by ${emergingOriginError}px`);
    await capture('04-logo-turns-out');
    await at(.855);
    const fading = await stats(); assert.ok(fading.flower.scale > emerging.flower.scale && fading.peach.opacity < emerging.peach.opacity);
    assert.ok(Math.abs(fading.flower.opacity + fading.peach.opacity - 1) < .02);
    const fadingOriginError = await originError(); assert.ok(fadingOriginError < .5);
    await capture('05-peach-fades');
    await logo.click(); // Retarget the live presentation, including path geometry.
    await at(.2);
    assert.ok((await stats()).flower.opacity > .9);
    await page.mouse.move(100, 650);
    await page.waitForTimeout(5300);
    const rest = await stats();
    assert.equal(rest.power, 0); assert.equal(rest.peach.opacity, 0); assert.equal(rest.flower.scale, 1);
    assert.equal(rest.petal.d, baseline.petal.d);
    assert.equal(await page.locator('.about-playground').evaluate(n => n.getAnimations({ subtree: true }).length), 0);
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.locator('.theme-toggle').press('End');
    await logo.focus(); await logo.press('Enter');
    assert.equal(await page.locator('.about-playground').evaluate(n => n.getAnimations({ subtree: true }).length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await logo.press('Enter'); await at(.71);
    const darkOriginError = await originError(); assert.ok(darkOriginError < .5);
    await capture('06-dark-emergence');
    await page.getByRole('button', { name: '路由总览', exact: true }).click();
    assert.equal(await page.locator('.about-playground').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, out, geometry: { fixedExteriorPoints: fixed, pulledInnerPoints: pulled },
      phases: [contracting, hubGone, gathered, collapsed, inflated, emerging, fading].map(({ hub, flower, peach }) => ({ hub: hub.scale, flower: flower.scale, peach: peach.scale, peachOpacity: peach.opacity })),
      originErrors: [emergingOriginError, fadingOriginError, darkOriginError],
      seamAlpha, repeatedClick: true, idleStopped: true, keyboard: true, reducedMotion: true, errors }, null, 2));
  } finally { await app.evaluate(() => global.assTest.quit()).catch(() => {}); await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
