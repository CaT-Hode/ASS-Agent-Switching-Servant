import React, { useId, useLayoutEffect, useRef } from 'react';
import { switchLens, switchOptics } from './settings-switch-optics.mjs';
import { createSettingsSwitchMotion, switchTravel } from './settings-switch-motion.mjs';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SettingsSwitch({ label, checked, disabled, onChange, describedBy }) {
  const filterId = 'ass-switch-' + useId().replace(/[^a-z0-9-]/gi, '');
  const optics = switchOptics();
  const button = useRef(null), displacement = useRef(null), motion = useRef(null), pointer = useRef(null);
  const suppressClick = useRef(false);
  const committed = useRef(checked);
  committed.current = checked;

  function cancel() {
    const grip = pointer.current;
    pointer.current = null;
    if (grip) {
      suppressClick.current = true;
      if (button.current?.hasPointerCapture(grip.id)) button.current.releasePointerCapture(grip.id);
    }
    motion.current?.release(committed.current, { cancel: true, reduced: reducedMotion() });
  }

  useLayoutEffect(() => {
    const node = button.current;
    const controller = createSettingsSwitchMotion(committed.current, ({ position, scaleX, scaleY, fill, refraction, moving }) => {
      node.style.setProperty('--switch-x', `${(position * switchTravel).toFixed(3)}px`);
      node.style.setProperty('--switch-sx', scaleX.toFixed(4));
      node.style.setProperty('--switch-sy', scaleY.toFixed(4));
      node.style.setProperty('--switch-fill', fill.toFixed(4));
      node.style.setProperty('--switch-amount', `${(Math.max(0, Math.min(1, position)) * 100).toFixed(2)}%`);
      node.toggleAttribute('data-moving', moving);
      if (optics) displacement.current?.setAttribute('scale', (optics.scale * refraction).toFixed(3));
    });
    motion.current = controller;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const reduceActiveMotion = () => { if (media.matches) cancel(); };
    media.addEventListener('change', reduceActiveMotion);
    window.addEventListener('blur', cancel);
    return () => {
      media.removeEventListener('change', reduceActiveMotion);
      window.removeEventListener('blur', cancel);
      controller.dispose();
    };
  }, [optics]);

  useLayoutEffect(() => {
    if (pointer.current) cancel();
    if (!disabled) motion.current?.sync(checked, { reduced: reducedMotion() });
  }, [checked, disabled]);

  function updateDrag(event) {
    const grip = pointer.current;
    if (!grip || grip.id !== event.pointerId) return;
    const delta = event.clientX - grip.x;
    if (!grip.dragging && Math.abs(delta) < 4) return;
    grip.dragging = true;
    return motion.current.drag(grip.origin + delta / switchTravel, { reduced: reducedMotion() });
  }

  return <button ref={button} type="button" role="switch" className="settings-switch" aria-label={label}
    aria-checked={!!checked} aria-describedby={describedBy} disabled={disabled}
    onPointerDown={event => {
      if (event.button !== 0 || event.isPrimary === false || pointer.current || disabled) return;
      suppressClick.current = false;
      pointer.current = { id: event.pointerId, x: event.clientX, origin: motion.current.press({ reduced: reducedMotion() }), dragging: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={updateDrag}
    onPointerUp={event => {
      const grip = pointer.current;
      if (!grip || grip.id !== event.pointerId) return;
      const position = updateDrag(event);
      pointer.current = null;
      if (event.currentTarget.hasPointerCapture(grip.id)) event.currentTarget.releasePointerCapture(grip.id);
      const next = grip.dragging ? position >= .5 : checked;
      motion.current.release(next, { reduced: reducedMotion() });
      if (grip.dragging) {
        suppressClick.current = true;
        if (next !== checked) onChange(next);
      }
    }}
    onPointerCancel={cancel}
    onLostPointerCapture={event => { if (pointer.current?.id === event.pointerId) cancel(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && pointer.current) { event.preventDefault(); cancel(); }
      if (event.key === ' ' && !event.repeat) motion.current.press({ reduced: reducedMotion() });
    }}
    onKeyUp={event => { if (event.key === ' ') motion.current.release(checked, { reduced: reducedMotion() }); }}
    onBlur={cancel}
    onClick={event => {
      if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
      motion.current.release(!checked, { reduced: reducedMotion() });
      onChange(!checked);
    }}>
    {optics && <svg className="settings-switch-optics" width="0" height="0" aria-hidden="true" focusable="false">
      <defs><filter id={filterId} x="0" y="0" width={optics.width} height={optics.height}
        filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={optics.map} width={optics.width} height={optics.height} preserveAspectRatio="none" result="map" />
        <feDisplacementMap ref={displacement} in="SourceGraphic" in2="map" scale={optics.scale * .4}
          xChannelSelector="R" yChannelSelector="G" result="refracted" />
        <feImage href={optics.highlight} width={optics.width} height={optics.height} preserveAspectRatio="none" result="rim" />
        <feColorMatrix in="refracted" type="saturate" values="6" result="color" />
        <feComposite in="color" in2="rim" operator="in" result="coloredRim" />
        <feBlend in="coloredRim" in2="refracted" result="sample" />
        <feComponentTransfer in="rim" result="glint"><feFuncA type="linear" slope=".5" /></feComponentTransfer>
        <feBlend in="glint" in2="sample" />
      </filter></defs>
    </svg>}
    <span className="settings-switch-rail" aria-hidden="true" />
    <span className="settings-switch-lens" aria-hidden="true" style={{ width: switchLens.width, height: switchLens.height }}>
      <span className="settings-switch-material">
        {optics && <span className="settings-switch-refraction" style={{ inset: -switchLens.overscan, backdropFilter: `url(#${filterId})` }} />}
        <span className="settings-switch-fill" />
      </span>
    </span>
  </button>;
}
