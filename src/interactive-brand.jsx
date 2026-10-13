import React, { useEffect, useRef } from 'react';
import { springStep } from './theme-motion.mjs';
import './interactive-brand.css';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function InteractiveBrand({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current, reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const axes = Object.fromEntries(['power', 'x', 'y', 'turn'].map(key => [key, { position: 0, velocity: 0, target: 0 }]));
    let frame = null, previous = 0, pointer = null, pending = false, pressed = false;
    const paint = () => {
      const power = clamp(axes.power.position, 0, 1), x = axes.x.position, y = axes.y.position;
      node.style.setProperty('--brand-power', power.toFixed(4));
      node.style.setProperty('--brand-turn', axes.turn.position.toFixed(3) + 'deg');
      node.style.setProperty('--brand-x', (x * 2.2).toFixed(3) + 'px');
      node.style.setProperty('--brand-y', (y * 1.8).toFixed(3) + 'px');
      node.style.setProperty('--brand-tilt', (x * 3.5).toFixed(3) + 'deg');
      node.style.setProperty('--brand-wave', (y * 2).toFixed(3) + 'px');
      node.style.setProperty('--brand-hue', (x * 100 + y * 35).toFixed(3) + 'deg');
      node.style.setProperty('--brand-light-x', (50 + x * 40).toFixed(2) + '%');
      node.style.setProperty('--brand-light-y', (50 + y * 35).toFixed(2) + '%');
      if (power > .002) node.dataset.brandActive = 'true';
      else node.removeAttribute('data-brand-active');
    };
    const clearTargets = () => { for (const axis of Object.values(axes)) axis.target = 0; };
    const tick = time => {
      frame = null;
      if (pending) {
        pending = false;
        if (!pointer || document.hidden || document.querySelector('dialog[open], [aria-modal="true"]')) clearTargets();
        else {
          const logo = node.querySelector('.ass-logo').getBoundingClientRect();
          const word = node.querySelector('.brand-wordmark').getBoundingClientRect();
          const version = node.querySelector('.version-button').getBoundingClientRect();
          const bounds = { left: Math.min(logo.left, word.left), right: Math.max(logo.right, word.right, version.right),
            top: Math.min(logo.top, word.top), bottom: Math.max(logo.bottom, word.bottom) };
          const distance = Math.hypot(Math.max(bounds.left - pointer.x, 0, pointer.x - bounds.right),
            Math.max(bounds.top - pointer.y, 0, pointer.y - bounds.bottom));
          const near = clamp(1 - distance / 64, 0, 1), power = near * near * (3 - 2 * near);
          const x = clamp((pointer.x - (bounds.left + bounds.right) / 2) / Math.max(1, (bounds.right - bounds.left) / 2), -1, 1);
          const y = clamp((pointer.y - (bounds.top + bounds.bottom) / 2) / Math.max(1, (bounds.bottom - bounds.top) / 2), -1, 1);
          axes.power.target = power;
          axes.x.target = reduced.matches ? 0 : x * power;
          axes.y.target = reduced.matches ? 0 : y * power;
          axes.turn.target = reduced.matches ? 0 : (x * 26 + y * 8) * power;
          if (pressed && power > 0 && !reduced.matches) axes.turn.velocity += 220;
        }
        pressed = false;
      }
      const dt = clamp((time - previous) / 1000, 0, .05);
      previous = time;
      let settling = false;
      for (const [key, axis] of Object.entries(axes)) {
        const next = reduced.matches ? { position: axis.target, velocity: 0 }
          : springStep(axis.position, axis.velocity, axis.target, dt, key === 'turn' ? 17 : 23);
        axis.position = next.position; axis.velocity = next.velocity;
        if (Math.abs(axis.position - axis.target) > .001 || Math.abs(axis.velocity) > .01) settling = true;
        else { axis.position = axis.target; axis.velocity = 0; }
      }
      paint();
      if (settling || pending) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      pending = true;
      if (frame === null) { previous = performance.now(); frame = requestAnimationFrame(tick); }
    };
    const move = e => {
      if (e.pointerType === 'touch') return;
      pointer = { x: e.clientX, y: e.clientY }; schedule();
    };
    const leave = e => { if (e.relatedTarget == null) { pointer = null; schedule(); } };
    const press = e => {
      if (e.button !== 0 || !e.target.closest('.ass-logo, .brand-wordmark, .version-button')) return;
      pointer = { x: e.clientX, y: e.clientY }; pressed = true; schedule();
    };
    const reset = () => {
      pointer = null; pressed = false;
      if (!document.hidden) { schedule(); return; }
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; pending = false;
      for (const axis of Object.values(axes)) Object.assign(axis, { position: 0, velocity: 0, target: 0 });
      paint();
    };
    const media = () => { schedule(); };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('blur', reset);
    node.addEventListener('pointerdown', press, { passive: true });
    document.addEventListener('visibilitychange', reset);
    reduced.addEventListener('change', media);
    paint();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerout', leave);
      window.removeEventListener('blur', reset); node.removeEventListener('pointerdown', press);
      document.removeEventListener('visibilitychange', reset); reduced.removeEventListener('change', media);
    };
  }, []);
  return <div className="brand brand-interactive" ref={ref}>{children}</div>;
}
