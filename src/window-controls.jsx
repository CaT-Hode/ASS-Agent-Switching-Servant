import React, { useEffect, useRef, useState } from 'react';
import { bindRevealInput } from './theme-reveal.mjs';
import { cancelThemeReveal } from './theme.jsx';
const api = window.ass;
export function WindowControls({ onError }) {
  const controls = useRef(null);
  const [status, setStatus] = useState({ maximized: false, focused: true, sequence: -1 });
  useEffect(() => {
    let mounted = true;
    const read = next => { if (mounted) setStatus(current => current.sequence > next.sequence ? current : next); };
    const unsubscribe = api.onWindowState(read);
    api.call('window-action', 'state').then(read).catch(e => { if (mounted) onError(e.message); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const cleanups = [...controls.current.querySelectorAll('button')].map(button => bindRevealInput(button, cancelThemeReveal, { windowControl: true }));
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const act = action => api.call('window-action', action).catch(e => onError(e.message));
  return <div ref={controls} className="window-controls" data-focused={status.focused} aria-label="窗口操作">
    <button type="button" aria-label="最小化" title="最小化" onClick={() => act('minimize')}>
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1 6h10" /></svg>
    </button>
    <button type="button" aria-label={status.maximized ? '还原窗口' : '最大化'} title={status.maximized ? '还原窗口' : '最大化'} onClick={() => act('toggle-maximize')}>
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">{status.maximized
        ? <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7Z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}</svg>
    </button>
    <button type="button" aria-label="关闭" title="关闭到托盘" onClick={() => act('close')}>
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
    </button>
  </div>;
}
