// One acceleration peak across the entire radius track, followed by a long
// deceleration to zero. Never append a second, faster overscan expansion.
export const THEME_REVEAL_DURATION = 2000;
export const THEME_REVEAL_EASING = 'cubic-bezier(.2,0,.55,1)';
export const THEME_REVEAL_HOLD_OFFSET = .98;

export function themeRevealGeometry(origin, width, height) {
  width = Math.max(1, Number.isFinite(width) ? width : 1);
  height = Math.max(1, Number.isFinite(height) ? height : 1);
  const bounds = origin?.getBoundingClientRect?.();
  const point = bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : origin;
  const x = Math.max(0, Math.min(width, Number.isFinite(point?.x) ? point.x : width / 2));
  const y = Math.max(0, Math.min(height, Number.isFinite(point?.y) ? point.y : height / 2));
  const diagonal = Math.hypot(width, height);
  // A single endpoint exceeds the full diagonal, including a centered trigger.
  // Overscan belongs in that endpoint, not a short, separately accelerated leg.
  return { x, y, xPercent: x / width * 100, yPercent: y / height * 100,
    radius: diagonal * 2 + 96 };
}

// Chromium can retarget pointer hit-testing to <html> while the root is being
// painted in a transition snapshot. Hand input back only to the actual owned
// control under that point, not to arbitrary selectors or duplicated UI.
// Only caption controls remain usable through a modal's inert backdrop.
export function bindRevealInput(element, cancel, { forwardPointer = false, windowControl = false } = {}) {
  const doc = element.ownerDocument, view = doc.defaultView;
  let pending = false;
  const inside = e => {
    const r = element.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const modal = () => doc.querySelector('dialog[open], [aria-modal="true"]');
  const active = () => doc.documentElement.hasAttribute('data-theme-reveal') || (windowControl && !!modal());
  const available = () => windowControl || !modal() || !!element.closest('dialog[open], [aria-modal="true"]');
  const props = e => ({ bubbles: true, cancelable: true, composed: true, detail: e.detail,
    clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons,
    pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
    altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
  const down = e => {
    if (!active() || !available() || element.contains(e.target) || e.button !== 0 || e.isPrimary === false || !inside(e)) return;
    // Suppress the original <html> compatibility-mousedown focus action;
    // otherwise it blurs the forwarded drag and marks the next click cancelled.
    e.preventDefault(); e.stopImmediatePropagation(); pending = true; cancel(); element.focus({ preventScroll: true });
    if (forwardPointer) {
      element.dispatchEvent(new view.PointerEvent('pointerdown', props(e)));
    }
  };
  const click = e => {
    if (!pending && !active()) return;
    pending = false;
    if (!available() || element.contains(e.target) || e.detail === 0 || e.button !== 0 || !inside(e)) return;
    e.stopImmediatePropagation(); cancel();
    element.dispatchEvent(new view.MouseEvent('click', props(e)));
  };
  const reset = () => { pending = false; };
  doc.addEventListener('pointerdown', down, true); doc.addEventListener('click', click, true);
  doc.addEventListener('pointercancel', reset, true);
  return () => {
    doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('click', click, true);
    doc.removeEventListener('pointercancel', reset, true);
  };
}

// One whole-window snapshot pair, not a second React tree or a DOM copy.
// The callback is generation-guarded: skipTransition still invokes its update
// callback, so a superseded request must never apply an old theme later.
export function createThemeReveal({ document: doc, viewport, reducedMotion }) {
  const root = doc.documentElement;
  let generation = 0, active = null;
  const clear = (entry) => {
    // fill:both effects outlive the transition pseudo-element. Remove them so
    // a later transition cannot resurrect an old mask with an old origin.
    try { entry.animation?.cancel(); } catch {}
    if (active !== entry) return;
    active = null; root.removeAttribute('data-theme-reveal');
  };
  const skip = (entry) => {
    try { entry.animation?.cancel(); entry.transition?.skipTransition(); } catch {}
    clear(entry);
  };
  return {
    run(commit, origin, { animate = true } = {}) {
      // Native theme/media echoes can arrive after the new color has already
      // been committed. They must not tear down that color's in-flight mask.
      if (!animate && active?.applied && !doc.hidden && !reducedMotion()) {
        commit(); return active.transition;
      }
      const interrupted = active;
      const ticket = ++generation;
      if (interrupted) skip(interrupted);
      let applied = false, entry;
      const applyOnce = () => {
        if (applied || ticket !== generation) return;
        applied = true; if (entry) entry.applied = true; commit();
      };
      // Rapid input stays usable. Finish directly at the latest requested
      // theme rather than queueing old full-screen snapshots behind the user.
      if (interrupted || !animate || doc.hidden || reducedMotion() || typeof doc.startViewTransition !== 'function') {
        applyOnce(); return null;
      }
      const size = viewport();
      const geometry = themeRevealGeometry(origin, size.width, size.height);
      entry = { transition: null, animation: null, applyOnce, applied: false, ...size };
      active = entry; root.setAttribute('data-theme-reveal', 'circle');
      try { entry.transition = doc.startViewTransition(applyOnce); }
      catch { applyOnce(); clear(entry); return null; }
      entry.transition.ready.then(() => {
        if (active !== entry || ticket !== generation) return;
        try {
          const style = doc.defaultView?.getComputedStyle?.(root, '::view-transition-new(root)');
          const cssWidth = parseFloat(style?.width), cssHeight = parseFloat(style?.height);
          const width = Math.max(size.width, Number.isFinite(cssWidth) ? cssWidth : 0);
          const height = Math.max(size.height, Number.isFinite(cssHeight) ? cssHeight : 0);
          const { xPercent, yPercent, radius } = themeRevealGeometry({ x: geometry.x, y: geometry.y }, width, height);
          // The snapshot is a replaced pseudo-element, not the button's DOM
          // coordinate space. Its viewport-pinned box owns the clip center.
          const center = `${xPercent}% ${yPercent}%`;
          const full = `circle(${radius}px at ${center})`;
          entry.animation = root.animate([
            { clipPath: `circle(0px at ${center})`, offset: 0, easing: THEME_REVEAL_EASING },
            { clipPath: full, offset: THEME_REVEAL_HOLD_OFFSET },
            { clipPath: full, offset: 1 },
          ], { duration: THEME_REVEAL_DURATION, easing: 'linear',
            pseudoElement: '::view-transition-new(root)', fill: 'both' });
        } catch { applyOnce(); skip(entry); }
      }, () => { applyOnce(); skip(entry); });
      entry.transition.finished.then(() => clear(entry), () => { applyOnce(); clear(entry); });
      return entry.transition;
    },
    cancel() {
      if (!active) return;
      active.applyOnce(); ++generation; skip(active);
    },
    resize() {
      if (!active) return;
      const size = viewport();
      if (Math.abs(size.width - active.width) > 2 || Math.abs(size.height - active.height) > 2) this.cancel();
    },
  };
}
