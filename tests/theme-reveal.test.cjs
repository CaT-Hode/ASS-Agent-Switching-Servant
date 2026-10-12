const { test } = require('node:test'), assert = require('node:assert/strict');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(options = {}) {
  const { createThemeReveal } = await import('../src/theme-reveal.mjs');
  const attributes = new Map(), transitions = [], animations = [];
  const root = { setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    animate: (frames, timing) => { if (options.animationThrows) throw Error('unsupported');
      const animation = { frames, timing, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(animation); return animation; } };
  const doc = { documentElement: root, hidden: !!options.hidden };
  if (!options.unsupported) doc.startViewTransition = update => {
    if (options.startThrows) throw Error('capture');
    const ready = deferred(), finished = deferred();
    const transition = { update, ready: ready.promise, finished: finished.promise,
      readyNow: () => ready.resolve(), done: () => finished.resolve(), fail: () => ready.reject(Error('capture')),
      skipTransition: () => { ready.reject(Error('skipped')); finished.resolve(); } };
    transitions.push(transition); return transition;
  };
  const controller = createThemeReveal({ document: doc, viewport: () => ({ width: 1440, height: 960 }), reducedMotion: () => !!options.reduce });
  return { controller, attributes, animations, transitions };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('reveal geometry covers every corner from bottom-left, top-right and keyboard button centers', async () => {
  const { themeRevealGeometry } = await import('../src/theme-reveal.mjs');
  for (const [width, height] of [[1440, 960], [3840, 2160], [1100, 740]]) {
    for (const origin of [{ x: 60, y: height - 30 }, { x: width - 22, y: 22 },
      { getBoundingClientRect: () => ({ left: 20, top: height - 70, width: 180, height: 40 }) }]) {
      const p = themeRevealGeometry(origin, width, height);
      for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) assert.ok(p.radius > Math.hypot(p.x - x, p.y - y));
    }
    const keyboard = themeRevealGeometry({ getBoundingClientRect: () => ({ left: 20, top: height - 70, width: 180, height: 40 }) }, width, height);
    assert.equal(keyboard.x, 110); assert.equal(keyboard.y, height - 50);
  }
  const invalid = themeRevealGeometry({ x: Infinity, y: NaN }, NaN, -5);
  assert.ok(Object.values(invalid).every(Number.isFinite));
});

test('both directions reveal only the new full-window snapshot, anchored to the exact input point', async () => {
  const { THEME_REVEAL_DURATION, THEME_REVEAL_EASING } = await import('../src/theme-reveal.mjs');
  for (const theme of ['light', 'dark']) {
    const f = await fixture(), commits = [];
    f.controller.run(() => commits.push(theme), { x: 1380, y: 24 });
    assert.deepEqual(commits, []); f.transitions[0].update(); f.transitions[0].readyNow(); await flush();
    assert.deepEqual(commits, [theme]);
    const a = f.animations[0];
    assert.equal(a.frames.clipPath[0], 'circle(0px at 1380px 24px)');
    assert.ok(a.frames.clipPath[1].endsWith('at 1380px 24px)'));
    assert.equal(a.timing.pseudoElement, '::view-transition-new(root)');
    assert.equal(a.timing.duration, THEME_REVEAL_DURATION); assert.equal(a.timing.easing, THEME_REVEAL_EASING);
    assert.notEqual(a.timing.easing, 'linear');
    f.transitions[0].done(); await flush(); assert.equal(f.attributes.size, 0);
    assert.ok(a.cancelled, 'finished fill:both effects must not survive into the next reveal');
  }
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
