// Low endpoint velocity and a lower peak avoid a front-loaded sweep and a
// perceptible jump when the last few pixels of the snapshot are removed.
export const THEME_REVEAL_DURATION = 960;
export const THEME_REVEAL_EASING = 'cubic-bezier(.4,0,.6,1)';

export function themeRevealGeometry(origin, width, height) {
  width = Math.max(1, Number.isFinite(width) ? width : 1);
  height = Math.max(1, Number.isFinite(height) ? height : 1);
  const bounds = origin?.getBoundingClientRect?.();
  const point = bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : origin;
  const x = Math.max(0, Math.min(width, Number.isFinite(point?.x) ? point.x : Math.min(100, width / 2)));
  const y = Math.max(0, Math.min(height, Number.isFinite(point?.y) ? point.y : Math.max(0, height - 38)));
  const farthest = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
  // Cover the corners before the snapshot is removed, not exactly at that
  // instant. A 2px mathematical margin leaves no useful paint/rounding buffer.
  const overscan = Math.max(32, Math.min(96, farthest * .06));
  return { x, y, radius: farthest + overscan };
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
      const interrupted = active;
      const ticket = ++generation;
      if (interrupted) skip(interrupted);
      let applied = false;
      const applyOnce = () => {
        if (applied || ticket !== generation) return;
        applied = true; commit();
      };
      // Rapid input stays usable. Finish directly at the latest requested
      // theme rather than queueing old full-screen snapshots behind the user.
      if (interrupted || !animate || doc.hidden || reducedMotion() || typeof doc.startViewTransition !== 'function') {
        applyOnce(); return null;
      }
      const geometry = themeRevealGeometry(origin, viewport().width, viewport().height);
      const entry = { transition: null, animation: null, applyOnce };
      active = entry; root.setAttribute('data-theme-reveal', 'circle');
      try { entry.transition = doc.startViewTransition(applyOnce); }
      catch { applyOnce(); clear(entry); return null; }
      entry.transition.ready.then(() => {
        if (active !== entry || ticket !== generation) return;
        const { x, y, radius } = geometry;
        try {
          const full = `circle(${radius}px at ${x}px ${y}px)`;
          entry.animation = root.animate({ clipPath: [
            `circle(0px at ${x}px ${y}px)`, full, full,
          ], offset: [0, .99, 1] }, { duration: THEME_REVEAL_DURATION, easing: THEME_REVEAL_EASING,
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
  };
}
