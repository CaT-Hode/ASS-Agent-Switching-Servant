import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createSettingsRangeMotion } from './settings-switch-motion.mjs';
import { rangeLens, rangeOptics } from './settings-switch-optics.mjs';
import './settings-range.css';

const adjustmentKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SettingsRange({ label, value, min, max, step = 1, unit, disabled, onPreview, onCommit }) {
  const id = 'ass-range-' + useId().replace(/[^a-z0-9-]/gi, '');
  const optics = rangeOptics();
  const slider = useRef(null), rail = useRef(null), displacement = useRef(null), motion = useRef(null);
  const interaction = useRef(null), staged = useRef(null), ignoredChange = useRef(null), generation = useRef(0);
  const [draft, setDraft] = useState(null), [text, setText] = useState(null);
  const displayed = draft ?? value;
  const latest = useRef(null);

  function restore() {
    if (staged.current !== null) onPreview(null);
    staged.current = null;
    setDraft(null);
    setText(null);
    if (slider.current) slider.current.value = value;
  }

  function stage(next) {
    if (!Number.isFinite(next) || next === staged.current || (next === value && staged.current === null)) return;
    staged.current = next;
    setDraft(next);
    onPreview(next);
  }

  function commit(next) {
    if (!Number.isFinite(next) || next === value || disabled) { restore(); return; }
    stage(next);
    const ticket = ++generation.current;
    void (async () => {
      try { await onCommit(next); }
      catch { /* The owner presents save errors. */ }
      finally { if (ticket === generation.current) latest.current.restore(); }
    })();
  }

  function endGesture() {
    const active = interaction.current;
    interaction.current = null;
    if (!active) return;
    motion.current.release(false, { reduced: reducedMotion() });
    ignoredChange.current = slider.current.valueAsNumber;
    if (active.cancelled) restore();
    else commit(ignoredChange.current);
  }

  function cancel(keepPointer = false) {
    if (keepPointer && interaction.current?.pointerId !== undefined) interaction.current.cancelled = true;
    else interaction.current = null;
    ignoredChange.current = value;
    generation.current++;
    motion.current.release(false, { reduced: reducedMotion() });
    restore();
  }

  latest.current = { restore, commit, cancel, endGesture };
  useLayoutEffect(() => {
    const node = rail.current, input = slider.current;
    const controller = createSettingsRangeMotion(({ scaleX, scaleY, fill, refraction }) => {
      node.style.setProperty('--range-scale-x', scaleX);
      node.style.setProperty('--range-scale-y', scaleY);
      node.style.setProperty('--range-fill', fill);
      if (optics) displacement.current?.setAttribute('scale', (optics.scale * refraction).toFixed(3));
    });
    motion.current = controller;
    const nativeChange = () => {
      const next = input.valueAsNumber;
      if (!interaction.current && ignoredChange.current !== next) latest.current.commit(next);
    };
    const pointerUp = event => {
      if (interaction.current?.pointerId === event.pointerId) latest.current.endGesture();
    };
    const pointerCancel = event => {
      if (interaction.current?.pointerId === event.pointerId) latest.current.cancel();
    };
    const blur = () => { if (interaction.current) latest.current.cancel(); };
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changeMotion = () => { if (media.matches) controller.release(false, { reduced: true }); };
    input.addEventListener('change', nativeChange);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', blur);
    media.addEventListener('change', changeMotion);
    return () => {
      generation.current++;
      input.removeEventListener('change', nativeChange);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', blur);
      media.removeEventListener('change', changeMotion);
      controller.dispose();
    };
  }, [optics]);
  useLayoutEffect(() => {
    if (disabled && interaction.current) latest.current.cancel();
  }, [disabled]);

  function finishNumber(input) {
    if (text === null) return;
    const raw = input.valueAsNumber;
    const next = Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step));
    setText(null);
    commit(next);
  }

  return <div className="settings-range-control">
    <div className="settings-range" ref={rail} style={{
      '--range-progress': max > min ? (displayed - min) / (max - min) : 0,
      '--range-lens-width': rangeLens.width + 'px', '--range-lens-height': rangeLens.height + 'px',
    }}>
      <span className="settings-range-track" aria-hidden="true" />
      {optics && <svg className="settings-range-optics" width="0" height="0" aria-hidden="true" focusable="false">
        <defs><filter id={id} width={optics.width} height={optics.height} x="0" y="0"
          filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feImage href={optics.map} width={optics.width} height={optics.height} preserveAspectRatio="none" result="map" />
          <feDisplacementMap ref={displacement} in="SourceGraphic" in2="map" scale={optics.scale * .4}
            xChannelSelector="R" yChannelSelector="G" result="refracted" />
          <feImage href={optics.highlight} width={optics.width} height={optics.height} preserveAspectRatio="none" result="rim" />
          <feComponentTransfer in="rim" result="glint"><feFuncA type="linear" slope=".5" /></feComponentTransfer>
          <feBlend in="glint" in2="refracted" />
        </filter></defs>
      </svg>}
      <span className="settings-range-lens" aria-hidden="true">
        <span className="settings-range-material">
          {optics && <span className="settings-range-refraction" style={{ inset: -rangeLens.overscan, backdropFilter: `url(#${id})` }} />}
          <span className="settings-range-fill" />
        </span>
      </span>
      <input ref={slider} className="settings-range-input" type="range" aria-label={label + '滑条'}
        aria-valuetext={`${displayed}${unit ? ' ' + unit : ''}`} {...{ min, max, step, disabled }} value={displayed}
        onPointerDown={event => {
          if (event.button !== 0 || event.isPrimary === false || disabled) return;
          generation.current++;
          ignoredChange.current = null;
          interaction.current = { pointerId: event.pointerId };
          motion.current.press({ reduced: reducedMotion() });
        }}
        onInput={event => {
          if (interaction.current?.cancelled) { event.currentTarget.value = value; return; }
          stage(event.currentTarget.valueAsNumber);
        }}
        onLostPointerCapture={event => { if (interaction.current?.pointerId === event.pointerId) cancel(); }}
        onKeyDown={event => {
          if (event.key === 'Escape' && interaction.current) {
            event.preventDefault(); event.stopPropagation(); cancel(true);
          } else if (adjustmentKeys.includes(event.key) && !interaction.current) {
            generation.current++;
            ignoredChange.current = null;
            interaction.current = { key: event.key };
            motion.current.press({ reduced: reducedMotion() });
          }
        }}
        onKeyUp={event => { if (interaction.current?.key === event.key) endGesture(); }}
        onBlur={() => { if (interaction.current?.key) endGesture(); }} />
    </div>
    <label className="settings-range-units">
      <input className="settings-range-number" type="number" aria-label={label + '数值'}
        {...{ min, max, step, disabled }} value={text ?? displayed}
        onChange={event => {
          const input = event.currentTarget;
          setText(input.value);
          if (input.validity.valid) stage(input.valueAsNumber);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
        }}
        onBlur={event => finishNumber(event.currentTarget)} />
      {unit && <span aria-hidden="true">{unit}</span>}
    </label>
  </div>;
}
