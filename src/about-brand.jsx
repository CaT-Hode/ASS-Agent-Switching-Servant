import React, { memo, useEffect, useRef } from 'react';
import { AssLogo, logoSculpture, logoAperture } from './ass-logo.jsx';
import { gatherInnerPath } from './about-morph.mjs';
import { springStep } from './theme-motion.mjs';
import figureArtwork from '../public/ass-about-mascot.svg?raw';
import './about-brand.css';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const actions = ['A 伸懒腰', '第一个 S 弹跳', '第二个 S 翻转招手'];
const logoDuration = 5200;
const gatherEnd = .27, revealStart = .64, revealMiddle = .80, revealEnd = .95;
// Keep React from replacing live SVG animation nodes on unrelated status updates.
const sculptureMarkup = { __html: logoSculpture };
// The SVG viewBox is centered on its actual line junction, (200,196).
// Both layers therefore rotate and grow from that point, including during fades.
const figureMarkup = { __html: figureArtwork };
const poses = [
  ['translateY(0px) scale(1)', 'translateY(-14px) rotate(-12deg) scale(.68,1.48)', 'translateY(9px) rotate(8deg) scale(1.23,.77)', 'translateY(-10px) rotate(-4deg) scale(.94,1.08)', 'none'],
  ['translateY(0px) scale(1)', 'translateY(12px) rotate(-12deg) scale(1.25,.7)', 'translateY(-58px) rotate(-26deg) scale(.78,1.28)', 'translateY(4px) rotate(18deg) scale(1.16,.87)', 'translateY(-20px) rotate(-8deg) scale(.95,1.08)', 'none'],
  ['rotate(0deg) scale(1)', 'rotate(-24deg) scale(.88,1.18)', 'translateY(-28px) rotate(26deg) scale(1.12,.92)', 'translateY(-36px) rotate(220deg) scale(.82,1.12)', 'translateY(0px) rotate(360deg) scale(1)'],
];

export const AboutBrand = memo(function AboutBrand({ version }) {
  const ref = useRef(null), controller = useRef(null);
  useEffect(() => {
    const root = ref.current, stage = root.querySelector('.about-stage');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const logo = root.querySelector('.about-logo-button');
    const letters = [...root.querySelectorAll('.about-character')];
    const bodies = letters.map(node => node.querySelector('.about-character-body'));
    const animations = new Map();
    const axes = Object.fromEntries(['power', 'x', 'y', 'turn'].map(key => [key, { position: 0, velocity: 0, target: 0 }]));
    let frame = null, previous = 0, pointer = null, pending = false, visible = true, heldUntil = 0, pointerPower = 0, gestureStart = 0;
    const resetAxes = () => { for (const axis of Object.values(axes)) Object.assign(axis, { position: 0, velocity: 0, target: 0 }); };
    const paint = time => {
      const power = clamp(axes.power.position, 0, 1), x = axes.x.position, y = axes.y.position;
      root.style.setProperty('--about-power', power.toFixed(4));
      root.style.setProperty('--about-x', x.toFixed(4));
      root.style.setProperty('--about-y', y.toFixed(4));
      root.style.setProperty('--about-hue', (x * 130 + y * 45).toFixed(2) + 'deg');
      root.style.setProperty('--about-turn', axes.turn.position.toFixed(3) + 'deg');
      root.style.setProperty('--about-look-x', (x * 3).toFixed(3) + 'px');
      root.style.setProperty('--about-look-y', (y * 2.5).toFixed(3) + 'px');
      for (let i = 0; i < letters.length; i++) {
        const personality = [1, -.75, .85][i];
        letters[i].style.setProperty('--character-x', (x * 13 * personality).toFixed(3) + 'px');
        letters[i].style.setProperty('--character-y', (y * 10 * personality - power * [7, 2, 10][i]).toFixed(3) + 'px');
        letters[i].style.setProperty('--character-turn', (x * [15, -19, 17][i] + y * [4, -3, 5][i]).toFixed(2) + 'deg');
        const phase = (time + i * 420) % 3100;
        const blink = power > .05 && !reduced.matches && phase > 2880 ? Math.max(.08, 1 - Math.sin((phase - 2880) / 220 * Math.PI)) : 1;
        letters[i].style.setProperty('--character-blink', blink.toFixed(3));
      }
      if (power > .002) root.dataset.playing = 'true'; else root.removeAttribute('data-playing');
    };
    const tick = time => {
      frame = null;
      if (pending) {
        pending = false;
        if (pointer && visible && !document.hidden) {
          const bounds = stage.getBoundingClientRect();
          const near = clamp(1 - Math.hypot(Math.max(bounds.left - pointer.x, 0, pointer.x - bounds.right),
            Math.max(bounds.top - pointer.y, 0, pointer.y - bounds.bottom)) / 80, 0, 1);
          const power = near * near * (3 - 2 * near);
          const x = clamp((pointer.x - (bounds.left + bounds.right) / 2) / (bounds.width / 2), -1, 1);
          const y = clamp((pointer.y - (bounds.top + bounds.bottom) / 2) / (bounds.height / 2), -1, 1);
          pointerPower = power;
          axes.x.target = reduced.matches ? 0 : x * power;
          axes.y.target = reduced.matches ? 0 : y * power;
          axes.turn.target = reduced.matches ? 0 : x * 32 + y * 14;
        } else { pointerPower = 0; for (const axis of Object.values(axes)) axis.target = 0; }
      }
      // A click hold must not overwrite the remembered proximity target.
      // Otherwise leaving during the hold can keep the playground awake forever.
      axes.power.target = time < heldUntil && visible && !document.hidden ? 1 : pointerPower;
      const dt = clamp((time - previous) / 1000, 0, .05); previous = time;
      let settling = false;
      for (const axis of Object.values(axes)) {
        const next = reduced.matches ? { position: axis.target, velocity: 0 }
          : springStep(axis.position, axis.velocity, axis.target, dt, 19);
        axis.position = next.position; axis.velocity = next.velocity;
        if (Math.abs(axis.position - axis.target) > .001 || Math.abs(axis.velocity) > .01) settling = true;
        else { axis.position = axis.target; axis.velocity = 0; }
      }
      paint(time);
      if (visible && !document.hidden && (pending || settling || time < heldUntil || (pointer && axes.power.position > .01 && !reduced.matches))) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      pending = true;
      if (frame === null && visible && !document.hidden) { previous = performance.now(); frame = requestAnimationFrame(tick); }
    };
    const animateFrames = (node, frames, duration, delay = 0) => {
      const style = getComputedStyle(node);
      const current = { ...frames[0], transform: style.transform, opacity: style.opacity };
      if ('d' in frames[0]) current.d = style.d;
      for (const key of Object.keys(frames[0])) if (key.startsWith('--')) current[key] = style.getPropertyValue(key).trim() || '0';
      animations.get(node)?.cancel();
      const motion = node.animate([current, ...frames.slice(1)].map(frame => ({ ...frame, easing: 'cubic-bezier(.4,0,.2,1)' })), {
        duration, delay, easing: 'linear', fill: 'both',
      });
      motion.startTime = gestureStart;
      animations.set(node, motion);
      motion.finished.then(() => { if (animations.get(node) === motion) { animations.delete(node); motion.cancel(); } }, () => {});
    };
    const animate = (node, frames, duration, delay = 0) => animateFrames(node, frames.map(transform => ({ transform })), duration, delay);
    const trigger = index => {
      if (!visible || document.hidden) return;
      heldUntil = Math.max(heldUntil, performance.now() + (reduced.matches ? 220 : index < 0 ? logoDuration + 150 : 1750)); schedule();
      if (reduced.matches) return;
      gestureStart = document.timeline.currentTime;
      if (index >= 0) animate(bodies[index], poses[index], [1100, 1200, 1450][index]);
      else {
        const morph = logo.querySelector('.about-sculpture');
        if (morph) animateFrames(morph, [{ opacity: 0, offset: 0 }, { opacity: 1, offset: .025 }, { opacity: 1, offset: .95 }, { opacity: 0, offset: 1 }], logoDuration);
        animateFrames(logo.querySelector('.about-flower > .ass-logo'), [{ opacity: 1, offset: 0 }, { opacity: 0, offset: .025 }, { opacity: 0, offset: .95 }, { opacity: 1, offset: 1 }], logoDuration);
        if (morph) {
          for (const [i, petal] of [...morph.querySelectorAll('path[id^="petal-"]')].entries()) {
            petal.style.setProperty('--petal-color', `hsl(${25 + i * 43} 65% 64%)`);
          }
          // Warp each outline and its matching cutout together. Transforming
          // the strokes against a stationary mask would tear the petals apart.
          for (const node of morph.querySelectorAll('path:not(#hub-fitted)')) {
            const path = node.getAttribute('d'), original = `path("${path}")`;
            const gathered = `path("${gatherInnerPath(path, logoAperture)}")`;
            animateFrames(node, [
              { d: original, offset: 0 },
              { d: gathered, offset: gatherEnd }, { d: gathered, offset: .46 },
              { d: original, offset: .58 }, { d: original, offset: 1 },
            ], logoDuration);
          }
          animateFrames(morph.querySelector('#hub-fitted'), [
            { opacity: 1, transform: 'none', offset: 0 },
            { opacity: 0, transform: 'scale(0) rotate(-24deg)', offset: gatherEnd },
            { opacity: 0, transform: 'scale(0)', offset: .46 },
            { opacity: 1, transform: 'none', offset: .58 },
            { opacity: 1, transform: 'none', offset: 1 },
          ], logoDuration);
        }
        animateFrames(logo.querySelector('.about-flower'), [
          { opacity: 1, transform: 'none', offset: 0 },
          { opacity: 1, transform: 'none', offset: .30 },
          { opacity: 1, transform: 'scale(.09,.13) rotate(38deg)', offset: .435 },
          { opacity: 0, transform: 'scale(.025) rotate(48deg)', offset: .46 },
          { opacity: 0, transform: 'scale(.035) rotate(-160deg)', offset: revealStart },
          { opacity: .68, transform: 'scale(.74) rotate(-30deg)', offset: revealMiddle },
          { opacity: 1, transform: 'scale(1.075,.96) rotate(8deg)', offset: revealEnd },
          { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 1 },
        ], logoDuration);
        animateFrames(logo.querySelector('.about-peach'), [
          { opacity: 0, transform: 'scale(.12)', offset: 0 },
          { opacity: 0, transform: 'scale(.12)', offset: .425 },
          { opacity: 1, transform: 'scale(.97,1.02) rotate(-5deg)', offset: .51 },
          { opacity: 1, transform: 'scale(1.13,1.04) rotate(4deg)', offset: .57 },
          { opacity: 1, transform: 'scale(1.44,1.3)', offset: revealStart },
          { opacity: .32, transform: 'scale(1.52,1.38)', offset: revealMiddle },
          { opacity: 0, transform: 'scale(1.57,1.43)', offset: revealEnd },
          { opacity: 0, transform: 'scale(.3)', offset: 1 },
        ], logoDuration);
        bodies.forEach((node, i) => animate(node, poses[i], [1100, 1200, 1450][i], 2200 + i * 90));
        for (const [i, spark] of [...root.querySelectorAll('.about-spark')].entries()) {
          animations.get(spark)?.cancel();
          const angle = i * 30, reach = 72 + (i % 3) * 18;
          const motion = spark.animate([
            { opacity: 0, transform: 'rotate(' + angle + 'deg) translateX(16px) scale(.4)' },
            { opacity: .85, offset: .18 },
            { opacity: 0, transform: 'rotate(' + (angle + 35) + 'deg) translateX(' + reach + 'px) scale(.1)' },
          ], { duration: 850 + (i % 3) * 90, easing: 'cubic-bezier(.15,.7,.3,1)' });
          motion.startTime = gestureStart;
          animations.set(spark, motion);
          motion.finished.then(() => { if (animations.get(spark) === motion) { animations.delete(spark); motion.cancel(); } }, () => {});
        }
      }
    };
    const stop = () => {
      pointer = null; pointerPower = 0; heldUntil = 0;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; pending = false;
      for (const motion of animations.values()) motion.cancel(); animations.clear();
      resetAxes(); paint(performance.now());
    };
    controller.current = { move(e) { if (e.pointerType !== 'touch') { pointer = { x: e.clientX, y: e.clientY }; schedule(); } },
      leave() { pointer = null; schedule(); }, trigger };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible) stop(); });
    observer.observe(root);
    const media = () => { for (const motion of animations.values()) motion.cancel(); animations.clear(); schedule(); };
    document.addEventListener('visibilitychange', stop); window.addEventListener('blur', stop);
    reduced.addEventListener('change', media);
    paint(performance.now());
    return () => {
      stop(); observer.disconnect(); controller.current = null;
      document.removeEventListener('visibilitychange', stop); window.removeEventListener('blur', stop);
      reduced.removeEventListener('change', media);
    };
  }, []);
  return <section className="ass-brand-hero about-playground" ref={ref}
    onPointerMove={e => controller.current?.move(e)} onPointerLeave={() => controller.current?.leave()}>
    <div className="about-stage" role="group" aria-label="ASS 互动品牌">
      <button type="button" className="about-logo-button" aria-label="旋转 ASS 花瓣" title="点一下花瓣" onClick={() => controller.current?.trigger(-1)}>
        <span className="about-logo-shadow" aria-hidden="true" />
        <span className="about-logo-float"><span className="about-logo-body">
          <span className="about-flower"><AssLogo interactive /><span className="about-sculpture" dangerouslySetInnerHTML={sculptureMarkup} /></span>
          <span className="about-peach" aria-hidden="true" dangerouslySetInnerHTML={figureMarkup} />
        </span></span>
        <span className="about-sparks" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} className="about-spark" style={{ '--spark-color': `hsl(${25 + i * 29} 72% 64%)` }} />)}</span>
      </button>
      <div className="ass-wordmark about-letter-row">
        {['A', 'S', 'S'].map((letter, i) => <button type="button" key={i} className="about-character" aria-label={actions[i]} title={actions[i]} onClick={() => controller.current?.trigger(i)}>
          <span className="about-character-shadow" aria-hidden="true" />
          <span className="about-character-float"><span className="about-character-body">
            <span className="about-character-glyph" data-letter={letter}>{letter}</span>
            <span className="about-face" aria-hidden="true"><i /><i /></span>
            <span className="about-hand" aria-hidden="true" />
          </span></span>
        </button>)}
      </div>
      <span className="about-version">v{version}</span>
    </div>
    <div className="about-brand-caption"><p>Agent-Switching-Servant</p><small>点一点花瓣或字母</small></div>
  </section>;
});
