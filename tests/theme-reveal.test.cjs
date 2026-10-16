const { test } = require('node:test'), assert = require('node:assert/strict');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(options = {}) {
  const { createThemeReveal } = await import(options.module || '../src/theme-reveal.mjs');
  const attributes = new Map(), transitions = [], animations = [];
  const root = { setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    animate: (frames, timing) => { if (options.animationThrows) throw Error('unsupported');
      const animation = { frames, timing, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(animation); return animation; } };
  const doc = { documentElement: root, hidden: !!options.hidden };
  if (options.snapshot) doc.defaultView = { getComputedStyle: () => options.snapshot };
  if (!options.unsupported) doc.startViewTransition = update => {
    if (options.startThrows) throw Error('capture');
    const ready = deferred(), finished = deferred();
    const transition = { update, ready: ready.promise, finished: finished.promise, skipped: false,
      readyNow: () => ready.resolve(), done: () => finished.resolve(), fail: () => ready.reject(Error('capture')),
      skipTransition: () => { transition.skipped = true; ready.reject(Error('skipped')); finished.resolve(); } };
    transitions.push(transition); return transition;
  };
  const size = { width: 1440, height: 960 };
  const controller = createThemeReveal({ document: doc, viewport: () => size, reducedMotion: () => !!options.reduce });
  return { controller, attributes, animations, transitions, size };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('the complete generated radius track has one peak and never accelerates again after 80 percent', async () => {
  const f = await fixture();
  f.controller.run(() => {}, { x: 108, y: 922 });
  f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  const { frames, timing } = f.animations[0];
  const bezier = text => {
    if (!text || text === 'linear') return time => time;
    const [x1, y1, x2, y2] = text.match(/[\d.]+/g).map(Number);
    const coordinate = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    return time => {
      let lo = 0, hi = 1;
      for (let i = 0; i < 45; i++) { const t = (lo + hi) / 2; if (coordinate(t, x1, x2) < time) lo = t; else hi = t; }
      return coordinate((lo + hi) / 2, y1, y2);
    };
  };
  // Evaluate all emitted keyframe segments, including the final 10%. Testing
  // only the first easing previously missed the 54ms overscan speed spike.
  const radius = frame => Number(frame.clipPath.match(/circle\(([\d.]+)px/)[1]);
  const sampleTrack = track => {
    const at = ms => {
      const t = bezier(timing.easing)(ms / timing.duration);
      const end = track.findIndex((frame, i) => i && t <= frame.offset);
      if (end < 0) return radius(track.at(-1));
      const a = track[end - 1], b = track[end];
      return radius(a) + (radius(b) - radius(a)) * bezier(a.easing)((t - a.offset) / (b.offset - a.offset));
    };
    return Array.from({ length: timing.duration }, (_, i) => ({ radius: at(i + 1), speed: at(i + 1) - at(i) }));
  };
  const samples = sampleTrack(frames), maxSpeed = Math.max(...samples.map(s => s.speed));
  const peakIndex = samples.findIndex(s => s.speed === maxSpeed);
  assert.ok(peakIndex > samples.length * .15 && peakIndex < samples.length * .4);
  assert.ok(maxSpeed < 3.5, 'full-track peak must not include a fast overscan leg');
  for (let i = peakIndex + 1; i < samples.length; i++) assert.ok(samples[i].speed <= samples[i - 1].speed + 1e-7, 'entire tail must continuously slow down');
  const finalRadius = radius(frames.at(-1));
  const at80 = samples.findIndex(s => s.radius >= finalRadius * .8);
  const at99 = samples.findIndex(s => s.radius >= finalRadius * .99);
  assert.ok(at99 - at80 >= 300, 'last visible radius portion needs a real slow tail');
  assert.ok(samples[at99].speed < samples[at80].speed * .25);
  assert.ok(samples[0].speed < .03 && samples.at(-1).speed === 0);
  assert.ok(samples[99].radius > 60, 'start should still respond promptly');
  const legacy = sampleTrack([
    { offset: 0, clipPath: 'circle(0px)', easing: 'cubic-bezier(.28,0,.45,1)' },
    { offset: .9, clipPath: 'circle(1800px)', easing: 'cubic-bezier(.28,0,.45,1)' },
    { offset: .95, clipPath: 'circle(3557px)' },
    { offset: 1, clipPath: 'circle(3557px)' },
  ]);
  assert.ok(Math.max(...legacy.slice(Math.floor(legacy.length * .8)).map(s => s.speed)) > maxSpeed * 10,
    'regression oracle must expose the former second acceleration, not just check endpoint coverage');
});

test('reveal geometry covers every corner from bottom-left, top-right and keyboard button centers', async () => {
  const { themeRevealGeometry } = await import('../src/theme-reveal.mjs');
  for (const [width, height] of [[1440, 960], [3840, 2160], [1100, 740]]) {
    for (const origin of [{ x: 60, y: height - 30 }, { x: width - 22, y: 22 },
      { getBoundingClientRect: () => ({ left: 20, top: height - 70, width: 180, height: 40 }) }]) {
      const p = themeRevealGeometry(origin, width, height);
      for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) assert.ok(p.radius > Math.hypot(p.x - x, p.y - y));
      const farthest = Math.max(...[[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => Math.hypot(p.x - x, p.y - y)));
      assert.ok(p.radius >= farthest + 32, 'final mask includes overscan without a second expansion');
    }
    const keyboard = themeRevealGeometry({ getBoundingClientRect: () => ({ left: 20, top: height - 70, width: 180, height: 40 }) }, width, height);
    assert.equal(keyboard.x, 110); assert.equal(keyboard.y, height - 50);
    assert.ok(Math.abs(keyboard.xPercent / 100 * width - keyboard.x) < .00001);
    assert.ok(Math.abs(keyboard.yPercent / 100 * height - keyboard.y) < .00001);
  }
  const invalid = themeRevealGeometry({ x: Infinity, y: NaN }, NaN, -5);
  assert.ok(Object.values(invalid).every(Number.isFinite));
});

test('both directions use a single expansion anchored to the trigger and then hold the complete mask', async () => {
  const { THEME_REVEAL_DURATION, THEME_REVEAL_EASING, THEME_REVEAL_HOLD_OFFSET } = await import('../src/theme-reveal.mjs');
  for (const theme of ['light', 'dark']) {
    const f = await fixture(), commits = [];
    f.controller.run(() => commits.push(theme), { getBoundingClientRect: () => ({ left: 1310, top: 2, width: 100, height: 44 }) });
    assert.deepEqual(commits, []); f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
    assert.deepEqual(commits, [theme]);
    const a = f.animations[0];
    const center = `${1360 / 1440 * 100}% ${24 / 960 * 100}%`;
    assert.equal(a.frames[0].clipPath, `circle(0px at ${center})`);
    assert.ok(a.frames[1].clipPath.endsWith(`at ${center})`));
    assert.equal(a.frames[2].clipPath, a.frames[1].clipPath, 'final frame holds the already complete mask');
    assert.deepEqual(a.frames.map(frame => frame.offset), [0, THEME_REVEAL_HOLD_OFFSET, 1]);
    assert.equal(a.timing.pseudoElement, '::view-transition-new(root)');
    assert.equal(a.timing.duration, THEME_REVEAL_DURATION); assert.equal(a.frames[0].easing, THEME_REVEAL_EASING);
    assert.notEqual(a.frames[0].easing, 'linear');
    f.transitions[0].done(); await flush(); assert.equal(f.attributes.size, 0);
    assert.ok(a.cancelled, 'finished fill:both effects must not survive into the next reveal');
  }
});

test('final radius always exceeds the full window diagonal, including a central trigger', async () => {
  const { themeRevealGeometry } = await import('../src/theme-reveal.mjs');
  for (const [width, height] of [[1, 1], [1440, 960], [1725, 1162.5], [3840, 2160], [7680, 4320]]) {
    const diagonal = Math.hypot(width, height);
    for (const origin of [undefined, { x: width / 2, y: height / 2 }, { x: 0, y: 0 },
      { x: width, y: height }, { x: width - 40, y: 24 }, { x: 100, y: height - 38 }]) {
      const { radius } = themeRevealGeometry(origin, width, height);
      assert.equal(radius, diagonal * 2 + 96);
    }
  }
});

test('single expansion target exceeds the actual snapshot diagonal, not only the requested viewport', async () => {
  const f = await fixture({ snapshot: { width: '2400px', height: '1600px' } });
  f.controller.run(() => {}, { x: 720, y: 480 });
  f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  const frames = f.animations[0].frames;
  const diagonal = Math.hypot(2400, 1600);
  const radius = frame => Number(frame.clipPath.match(/circle\(([\d.]+)px/)[1]);
  assert.ok(radius(frames[1]) > diagonal, 'expansion must exceed the entire snapshot diagonal');
  assert.ok(frames[0].clipPath.includes('at 30% 30%'));
  assert.equal(frames[2].clipPath, frames[1].clipPath);
});

test('same-color echoes after commit preserve the mask and cannot cause an instant corner fill', async () => {
  const f = await fixture(), commits = [];
  const transition = f.controller.run(() => commits.push('dark'));
  f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  assert.equal(f.controller.run(() => commits.push('system-dark'), undefined, { animate: false }), transition);
  assert.deepEqual(commits, ['dark', 'system-dark']); assert.equal(f.transitions.length, 1);
  assert.equal(f.transitions[0].skipped, false); assert.equal(f.animations[0].cancelled, false);
  assert.equal(f.attributes.get('data-theme-reveal'), 'circle');
  f.transitions[0].done(); await flush(); assert.equal(f.attributes.size, 0);
});

test('same-color choice before commit still supersedes the old uncommitted color change', async () => {
  const f = await fixture(), commits = [];
  f.controller.run(() => commits.push('dark'));
  f.controller.run(() => commits.push('stay-light'), undefined, { animate: false });
  f.transitions[0].update(); await flush();
  assert.deepEqual(commits, ['stay-light']); assert.equal(f.transitions[0].skipped, true);
});

test('unchanged-size resize notifications cannot end a reveal, real viewport changes still clean up', async () => {
  const f = await fixture(); f.controller.run(() => {});
  f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  f.controller.resize(); assert.equal(f.transitions[0].skipped, false); assert.equal(f.animations[0].cancelled, false);
  f.size.width += 1; f.controller.resize(); assert.equal(f.transitions[0].skipped, false, 'minor rounding cannot tear down the mask');
  f.size.width += 100; f.controller.resize(); await flush();
  assert.equal(f.transitions[0].skipped, true); assert.ok(f.animations[0].cancelled); assert.equal(f.attributes.size, 0);
});

test('portable skill reveal preserves mask lifetime, pacing and single-commit interruption', async () => {
  const f = await fixture({ module: '../skills/best-light-dark-switching/assets/theme-reveal.mjs' });
  let count = 0;
  f.controller.run(() => count++, { x: 40, y: 920 });
  f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  assert.equal(f.animations[0].timing.duration, 2000);
  f.controller.cancel(); f.transitions[0].update(); await flush();
  assert.equal(count, 1); assert.ok(f.animations[0].cancelled); assert.equal(f.attributes.size, 0);
});

test('latest input wins before capture; skipped callbacks cannot apply an obsolete theme', async () => {
  const f = await fixture(), commits = [];
  f.controller.run(() => commits.push('dark'));
  f.controller.run(() => commits.push('light'));
  f.transitions[0].update(); await flush();
  assert.deepEqual(commits, ['light']); assert.equal(f.transitions.length, 1);
  assert.equal(f.attributes.size, 0); assert.equal(f.animations.length, 0);
});

test('input remains usable during reveal, cancels the compositor animation and commits last choice once', async () => {
  const f = await fixture(), commits = [];
  f.controller.run(() => commits.push('dark')); f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
  f.controller.run(() => commits.push('light')); await flush();
  assert.deepEqual(commits, ['dark', 'light']); assert.ok(f.animations[0].cancelled); assert.equal(f.attributes.size, 0);
});

test('reduced motion, hidden app, same effective color and absent API apply directly without snapshots', async () => {
  for (const options of [{ reduce: true }, { hidden: true }, { unsupported: true }, { animate: false }]) {
    const f = await fixture(options); let count = 0;
    f.controller.run(() => count++, undefined, options);
    assert.equal(count, 1); assert.equal(f.transitions.length, 0); assert.equal(f.attributes.size, 0);
  }
});

test('capture and animation failures leave the chosen theme applied and no residual mask', async () => {
  for (const options of [{ startThrows: true }, { animationThrows: true }, { readyFails: true }]) {
    const f = await fixture(options); let count = 0; f.controller.run(() => count++);
    if (f.transitions.length) {
      f.transitions[0].update(); options.readyFails ? f.transitions[0].fail() : f.transitions[0].readyNow();
    }
    await flush(); assert.equal(count, 1); assert.equal(f.attributes.size, 0);
  }
});

test('resize/hide cancellation finishes an uncommitted request exactly once and leaves no stale callback', async () => {
  const f = await fixture(); let count = 0; f.controller.run(() => count++);
  f.controller.cancel(); f.transitions[0].update(); await flush(); f.controller.cancel();
  assert.equal(count, 1); assert.equal(f.attributes.size, 0);
});

test('snapshot hit-testing hands rapid pointer input to the existing control without duplicate delivery', async () => {
  const { bindRevealInput } = await import('../src/theme-reveal.mjs');
  const handlers = new Map(), delivered = [], root = { active: true, hasAttribute() { return this.active; } };
  class Event { constructor(type, props) { this.type = type; Object.assign(this, props); } }
  const doc = { documentElement: root, defaultView: { PointerEvent: Event, MouseEvent: Event }, querySelector: () => null,
    addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: type => handlers.delete(type) };
  let cancelled = 0, focused = 0;
  const button = { ownerDocument: doc, contains: target => target === button,
    getBoundingClientRect: () => ({ left: 10, right: 210, top: 880, bottom: 920 }),
    focus: () => focused++, dispatchEvent: e => { e.target = button; handlers.get(e.type)?.(e); delivered.push(e); } };
  const dispose = bindRevealInput(button, () => { root.active = false; cancelled++; }, { forwardPointer: true });
  const input = { target: root, clientX: 30, clientY: 900, button: 0, detail: 1,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, preventDefault() {}, stopImmediatePropagation() {} };
  handlers.get('pointerdown')(input); handlers.get('click')(input);
  assert.deepEqual(delivered.map(e => e.type), ['pointerdown', 'click']);
  assert.equal(delivered[0].pointerId, 7); assert.equal(delivered[1].clientX, 30); assert.equal(focused, 1);
  root.active = true; handlers.get('click')({ ...input, target: button });
  assert.equal(delivered.length, 2, 'normal React-targeted clicks must not be replayed');
  root.active = true; handlers.get('pointerdown')({ ...input, clientX: 500 });
  assert.equal(cancelled, 2, 'unrelated content must not be hijacked');
  dispose(); assert.equal(handlers.size, 0);
});

test('modal backdrops block theme input but still allow only the fixed window control actions', async () => {
  const { bindRevealInput } = await import('../src/theme-reveal.mjs');
  for (const windowControl of [false, true]) {
    const handlers = new Map(), delivered = [];
    const root = { hasAttribute: () => !windowControl }, backdrop = {};
    class Event { constructor(type, props) { this.type = type; Object.assign(this, props); } }
    const doc = { documentElement: root, defaultView: { PointerEvent: Event, MouseEvent: Event }, querySelector: () => backdrop,
      addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: type => handlers.delete(type) };
    const button = { ownerDocument: doc, contains: target => target === button, closest: () => null,
      getBoundingClientRect: () => ({ left: 1300, right: 1346, top: 0, bottom: 44 }), focus() {},
      dispatchEvent: e => { e.target = button; handlers.get(e.type)?.(e); delivered.push(e.type); } };
    let stopped = 0, cancelled = 0;
    const dispose = bindRevealInput(button, () => cancelled++, { windowControl });
    const input = { target: backdrop, clientX: 1320, clientY: 20, button: 0, detail: 1, isPrimary: true,
      preventDefault() {}, stopImmediatePropagation() { stopped++; } };
    handlers.get('pointerdown')(input); handlers.get('click')(input);
    assert.deepEqual(delivered, windowControl ? ['click'] : []);
    assert.equal(stopped, windowControl ? 2 : 0, 'caption input must not dismiss a modal through its backdrop');
    assert.equal(cancelled, windowControl ? 2 : 0);
    dispose();
  }
});
