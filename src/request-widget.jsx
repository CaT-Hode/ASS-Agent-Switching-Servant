import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WIDGET_MAX_RADIUS, motionRows } from '../core/request-widget-view.mjs';
import { WidgetSurface } from './widget-surface.jsx';
import { X } from './icons.jsx';
import './menus.css';
import './request-widget.css';
export function RequestWidget() {
  const [state, setState] = useState({ rows: [], heat: { cells: [] }, radius: WIDGET_MAX_RADIUS });
  const [entries, setEntries] = useState([]);
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);
  const dragging = useRef(false), panelRef = useRef(null), prevCountRef = useRef(null), jellyAnim = useRef(null);
  const count = entries.reduce((max, item) => Math.max(max, item.index+1), 0);
  useLayoutEffect(() => {
    if (state.ready && (count || !state.rows.length)) window.requestWidget.layout(count);
  }, [count, state.ready, state.rows.length]);
  useLayoutEffect(() => {
    const previous = prevCountRef.current;
    prevCountRef.current = count;
    const panel = panelRef.current;
    if (previous === null || previous === count || !panel || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const growing = count > previous;
    jellyAnim.current?.cancel();
    jellyAnim.current = panel.animate(
      growing
        ? [
            { transform: 'scaleX(1) scaleY(1)' },
            { transform: 'scaleX(.987) scaleY(1.016)', offset: .28 },
            { transform: 'scaleX(1.006) scaleY(.994)', offset: .66 },
            { transform: 'scaleX(1) scaleY(1)' },
          ]
        : [
            { transform: 'scaleX(1) scaleY(1)' },
            { transform: 'scaleX(1.013) scaleY(.986)', offset: .30 },
            { transform: 'scaleX(.996) scaleY(1.005)', offset: .68 },
            { transform: 'scaleX(1) scaleY(1)' },
          ],
      { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)' },
    );
  }, [count]);
  const retired = useCallback(id => setEntries(previous => previous.filter(item => item.row.id !== id || !item.exiting)), []);
  useEffect(() => {
    let alive = true;
    const receive = value => {
      if (alive && !dragging.current) {
        setState(previous => ({ ...value, ready: true, heat: value.heat || previous.heat }));
        setEntries(previous => motionRows(previous, value.rows));
      }
    };
    const receiveTheme = value => {
      if (alive && value) {
        setState(previous => previous.theme === value.theme && previous.glass === value.glass
          ? previous : { ...previous, theme: value.theme, glass: value.glass });
      }
    };
    const unsubscribe = window.requestWidget.subscribe(receive);
    const unsubscribeTheme = window.requestWidget.subscribeTheme?.(receiveTheme);
    window.requestWidget.ready().then(receive);
    return () => { alive = false; unsubscribe(); unsubscribeTheme?.(); jellyAnim.current?.cancel(); };
  }, []);
  useLayoutEffect(() => {
    if (!menu) return;
    const panel = menuRef.current;
    if (!panel.matches(':popover-open')) panel.showPopover();
    const left = Math.max(5, Math.min(menu.x, innerWidth - panel.offsetWidth - 5));
    const top = Math.max(5, Math.min(menu.y, innerHeight - panel.offsetHeight - 5));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.setProperty('--ass-menu-origin', `${menu.x > left + panel.offsetWidth / 2 ? 'right' : 'left'} ${menu.y > top + panel.offsetHeight / 2 ? 'bottom' : 'top'}`);
    panel.firstElementChild.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const pressOutside = event => { if (!menuRef.current?.contains(event.target)) setMenu(null); };
    const dismiss = () => setMenu(null);
    document.addEventListener('pointerdown', pressOutside);
    window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', pressOutside); window.removeEventListener('blur', dismiss); };
  }, [menu]);
  const stopDrag = () => { if (dragging.current) { dragging.current = false;window.requestWidget.endDrag(); } };
  return <>
    <WidgetSurface frame={state} entries={entries} onExit={retired} panelRef={panelRef} tabIndex={-1}
      onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, origin: document.activeElement }); }}
      onKeyDown={event => {
        if (event.key === 'Escape') window.requestWidget.hide();
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault();
          const { left, bottom } = event.target.getBoundingClientRect();
          setMenu({ x: left, y: bottom, origin: event.target });
        }
      }}
      onPointerDown={event => { if (event.button === 0 && !menu) {
        dragging.current = true;event.currentTarget.setPointerCapture(event.pointerId);window.requestWidget.drag();
      } }} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag} />
    {menu && <div ref={menuRef} popover="manual" role="menu" aria-label="悬浮窗操作" className="ass-menu-panel widget-context-menu"
      data-theme={state.theme || 'dark'} onKeyDown={event => {
        if (!['Escape', 'Tab'].includes(event.key)) return;
        event.preventDefault();
        setMenu(null);
        (menu.origin?.tabIndex >= 0 ? menu.origin : panelRef.current)?.focus({ preventScroll: true });
      }}>
      <button type="button" role="menuitem" onClick={() => window.requestWidget.hide()}><X size={15} />关闭悬浮窗</button>
    </div>}
  </>;
}
createRoot(document.getElementById('root')).render(<RequestWidget />);
