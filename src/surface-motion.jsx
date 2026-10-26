import React, { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

let active = null, generation = 0;
// Capture outgoing pixels instead of retaining obsolete React pages. Inputs
// commit once, rapid navigation cancels old snapshots, background refreshes do
// not call this helper, and theme reveal keeps ownership of its own transition.
export function transitionUI(commit) {
  const root = document.documentElement;
  const ticket = ++generation;
  active?.skipTransition(); active = null; root.removeAttribute('data-ui-transition');
  let applied = false;
  const apply = () => { if (!applied && ticket === generation) { applied = true; flushSync(commit); } };
  if (!document.startViewTransition || document.hidden || root.hasAttribute('data-theme-reveal') ||
    document.querySelector('.app-shell')?.dataset.input === 'keyboard' || document.querySelector('dialog[open]')) {
    apply(); return;
  }
  root.setAttribute('data-ui-transition', 'true');
  let transition;
  try { transition = document.startViewTransition(apply); active = transition; }
  catch { root.removeAttribute('data-ui-transition'); apply(); return; }
  transition.ready.catch(() => {});
  transition.finished.catch(() => {}).finally(() => {
    if (active === transition) { active = null; root.removeAttribute('data-ui-transition'); }
  });
}

// Small transient surfaces keep their real DOM through exit, without delaying
// page navigation or preserving an old interactive page behind the new one.
export function Presence({ show, children, className = '', offset = 'translateY(6px)' }) {
  const [retained, setRetained] = useState(show ? children : null);
  const slot = useRef(null);
  useLayoutEffect(() => { if (show) setRetained(children); }, [show, children]);
  useLayoutEffect(() => {
    const node = slot.current?.firstElementChild;
    if (!node) return;
    if (document.querySelector('.app-shell')?.dataset.input === 'keyboard' && node.getAttribute('role') === 'menu') {
      if (!show) setRetained(null);
      return;
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = node.animate(show
      ? [{ opacity: reduced ? .7 : 0, transform: reduced ? 'none' : offset }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 1, transform: 'none' }, { opacity: reduced ? .7 : 0, transform: reduced ? 'none' : offset }],
    { duration: reduced ? 80 : show ? 180 : 120, easing: 'cubic-bezier(0.23,1,0.32,1)', fill: 'both' });
    if (!show) animation.finished.then(() => setRetained(null), () => {});
    return () => animation.cancel();
  }, [show, offset]);
  return show || retained ? <div ref={slot} className={'motion-presence ' + className} inert={show ? undefined : true}>{show ? children : retained}</div> : null;
}
