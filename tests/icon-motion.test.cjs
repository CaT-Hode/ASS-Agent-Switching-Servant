const { test } = require("node:test");
const assert = require("node:assert/strict");
test("motion has separate hover/press/exit, retargets live frames and cleans up detached or disabled controls", async () => {
  const { attachIconMotion } = await import("../src/icon-player.mjs");
  const events = new Map(), mediaEvents = new Map();
  const reduced = { matches: false, addEventListener: (_, fn) => mediaEvents.set("change", fn), removeEventListener: () => mediaEvents.clear() };
  let observe;
  const win = { matchMedia: (q) => q.includes("reduce") ? reduced : { matches: true }, addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ transform: "matrix(1,0,0,1,2.5,0)", opacity: "1" }), MutationObserver: class { constructor(fn) { observe = fn; } observe() {} disconnect() {} } };
  const root = { contains: () => true, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name) };
  let blocked = false, count = 0; const animations = [];
  const host = { matches: (q) => q === '[data-icon-scope]' ? false : blocked, contains: () => false, querySelectorAll: () => [svg] };
  const svg = { isConnected: true, dataset: { motionIcon: "Settings2" }, closest: (q) => q === ".spin" ? null : host,
    querySelector: () => ({ animate(frames) { count++; const a = { frames, finished: new Promise(() => {}), cancel() { this.cancelled = true; } }; animations.push(a); return a; } }) };
  const event = { target: { closest: () => host }, button: 0, pointerType: "mouse" };
  const dispose = attachIconMotion(root, win);
  events.get("pointerover")(event); assert.equal(count, 2);
  assert.equal(svg.dataset.iconPhase, 'hover');
  events.get("pointerdown")(event); assert.equal(count, 4); assert.equal(svg.dataset.iconPhase, 'press');
  assert.equal(animations.at(-1).frames[0].transform, 'matrix(1,0,0,1,2.5,0)', 'press starts at the live hover frame');
  events.get("pointerdown")(event); assert.equal(count, 4, 'rapid press does not restart an in-flight press');
  events.get('pointerout')(event); assert.equal(svg.dataset.iconPhase, 'exit'); assert.equal(count, 6);
  events.get('pointerover')(event); assert.equal(svg.dataset.iconPhase, 'hover'); assert.equal(count, 8);
  events.get("keydown")(); assert.ok(animations.every((a) => a.cancelled)); assert.equal(svg.dataset.iconAnimating, undefined);
  blocked = true; events.get("pointerover")(event); assert.equal(count, 8);
  blocked = false; reduced.matches = true; events.get("pointerdown")(event); assert.equal(count, 8);
  reduced.matches = false; events.get("pointerover")({ ...event, pointerType: "touch" }); assert.equal(count, 8);
  events.get("pointerover")(event); assert.equal(count, 10);
  svg.isConnected = false; observe(); assert.equal(svg.dataset.iconAnimating, undefined);
  svg.isConnected = true; events.get('pointerover')(event); blocked = true; observe(); assert.equal(svg.dataset.iconAnimating, undefined);
  mediaEvents.get("change")(); assert.equal(svg.dataset.iconAnimating, undefined);
  dispose(); assert.equal(events.size, 0); assert.equal(mediaEvents.size, 0);
});
