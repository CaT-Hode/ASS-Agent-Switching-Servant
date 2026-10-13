import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const supplied = process.argv[2];
const moduleUrl = supplied ? pathToFileURL(path.resolve(supplied)) : new URL('../assets/theme-reveal.mjs', import.meta.url);
const { createThemeReveal } = await import(moduleUrl.href);
assert.equal(typeof createThemeReveal, 'function', 'module must export createThemeReveal');
const viewport = { width: 1440, height: 960 };
let emitted;
const root = {
  setAttribute() {}, removeAttribute() {},
  animate(frames, timing) {
    emitted = { frames, timing };
    return { cancel() {} };
  },
};
const doc = {
  documentElement: root, hidden: false,
  defaultView: { getComputedStyle: () => ({ width: '1440px', height: '960px' }) },
  startViewTransition(update) {
    update();
    return { ready: Promise.resolve(), finished: new Promise(() => {}), skipTransition() {} };
  },
};
const controller = createThemeReveal({ document: doc, viewport: () => viewport, reducedMotion: () => false });
controller.run(() => {}, { x: 108, y: 922 });
await Promise.resolve();
await Promise.resolve();
assert.ok(emitted, 'controller did not emit a reveal animation');

function easing(text = 'linear') {
  if (text === 'linear') return t => t;
  assert.ok(text.startsWith('cubic-bezier('), 'checker supports linear and cubic-bezier easing');
  const controls = text.slice(text.indexOf('(') + 1, -1).split(',').map(Number);
  assert.equal(controls.length, 4);
  assert.ok(controls.every(Number.isFinite));
  const [x1, y1, x2, y2] = controls;
  assert.ok(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1);
  const coordinate = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  return time => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const t = (lo + hi) / 2;
      if (coordinate(t, x1, x2) < time) lo = t; else hi = t;
    }
    return coordinate((lo + hi) / 2, y1, y2);
  };
}
const { frames, timing } = emitted;
assert.ok(Number.isFinite(timing.duration) && timing.duration > 0);
assert.ok(frames.length >= 2);
assert.equal(frames[0].offset, 0);
assert.equal(frames.at(-1).offset, 1);
const radius = frame => {
  const match = frame.clipPath?.match(/^circle\(([\d.]+)px(?: at |\))/);
  assert.ok(match, 'expected a circle radius in CSS px');
  return Number(match[1]);
};
const outer = easing(timing.easing);
const segments = frames.slice(1).map((b, i) => {
  const a = frames[i];
  assert.ok(b.offset > a.offset, 'keyframe offsets must increase');
  return { a, b, start: radius(a), end: radius(b), ease: easing(a.easing) };
});
const at = milliseconds => {
  const time = outer(Math.min(1, Math.max(0, milliseconds / timing.duration)));
  const segment = segments.find(s => time <= s.b.offset) || segments.at(-1);
  return segment.start + (segment.end - segment.start) * segment.ease((time - segment.a.offset) / (segment.b.offset - segment.a.offset));
};
const samples = [{ time: 0, radius: at(0), speed: 0 }];
for (let time = 1; time <= Math.ceil(timing.duration); time++) {
  const now = Math.min(time, timing.duration), previous = samples.at(-1);
  if (now <= previous.time) break;
  const r = at(now);
  samples.push({ time: now, radius: r, speed: (r - previous.radius) / (now - previous.time) });
}
const peak = samples.reduce((best, s) => s.speed > best.speed ? s : best);
assert.ok(peak.speed > 0);
const tolerance = Math.max(1e-6, peak.speed * .0001);
for (let i = 1; i < samples.length; i++) {
  assert.ok(samples[i].radius >= samples[i - 1].radius - tolerance, 'radius moved backwards');
  if (samples[i].time > peak.time) assert.ok(samples[i].speed <= samples[i - 1].speed + tolerance,
    'second acceleration after peak at ' + samples[i].time + 'ms; inspect every keyframe segment');
  else assert.ok(samples[i].speed >= samples[i - 1].speed - tolerance,
    'speed slowed and then accelerated again before the global peak');
}
const finalRadius = samples.at(-1).radius, diagonal = Math.hypot(viewport.width, viewport.height);
assert.ok(finalRadius > diagonal, 'final radius must exceed full window diagonal');
assert.ok(samples[1].speed < peak.speed * .01, 'starting velocity is discontinuous');
assert.ok(samples.at(-1).speed < peak.speed * .01, 'ending velocity is not near zero');
const round = n => +n.toFixed(3);
const thresholds = [.8, .9, .99].map(fraction => {
  const sample = samples.find(s => s.radius >= finalRadius * fraction);
  return { radiusFraction: fraction, timeMs: sample.time, radialSpeedPxPerMs: round(sample.speed) };
});
controller.cancel();
console.log(JSON.stringify({
  passed: true, module: fileURLToPath(moduleUrl), viewport, diagonalPx: round(diagonal),
  finalRadiusPx: round(finalRadius), radiusAt100Ms: round(at(Math.min(100, timing.duration))),
  durationMs: timing.duration, peak: { timeMs: peak.time, radialSpeedPxPerMs: round(peak.speed) },
  thresholds, radius80To99Ms: thresholds[2].timeMs - thresholds[0].timeMs,
  evidence: 'Generated keyframe mathematics only; natural playback and painted coverage require separate validation.',
}, null, 2));
