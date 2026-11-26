import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "./icons.jsx";
import "./menus.css";

const enabledItems = panel => [...panel.querySelectorAll('[role="menuitem"]:not(:disabled)')];
function focusEdge(panel, last) {
  (enabledItems(panel).at(last ? -1 : 0) || panel).focus({ preventScroll: true });
}

export function ActionMenu({ label, items, disabled = false, text }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null), panel = useRef(null), focusLast = useRef(false);
  const id = 'ass-menu-' + useId().replace(/[^a-z0-9-]/gi, '');
  const anchor = '--' + id;

  useEffect(() => {
    const menu = panel.current;
    const update = event => {
      const shown = event.newState === 'open';
      setOpen(shown);
      if (!shown) return;
      focusEdge(menu, focusLast.current);
      focusLast.current = false;
    };
    menu.addEventListener('toggle', update);
    return () => menu.removeEventListener('toggle', update);
  }, []);

  function close() {
    panel.current.hidePopover();
    trigger.current.focus({ preventScroll: true });
  }

  return <div className="action-menu"
    onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) panel.current.hidePopover();
    }}>
    <button type="button" className={text ? 'button action-menu-trigger' : 'icon-button action-menu-trigger'}
      ref={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      popoverTarget={id} disabled={disabled} style={{ anchorName: anchor }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const last = event.key === 'ArrowUp', menu = panel.current;
        if (menu.matches(':popover-open')) focusEdge(menu, last);
        else { focusLast.current = last; menu.showPopover(); }
      }}>
      {text ? <>{text}<ChevronDown size={14} /></> : <MoreHorizontal size={18} />}
    </button>
    <div ref={panel} className="ass-menu-panel action-menu-panel" id={id} role="menu" aria-label={label}
      popover="auto" tabIndex={-1} style={{ positionAnchor: anchor }} onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = enabledItems(event.currentTarget);
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? -1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons.at(next)?.focus();
      }}>
      {items.filter(Boolean).map(item => <button type="button" role="menuitem" key={item.label} tabIndex={-1}
        disabled={item.disabled} data-danger={item.danger || undefined}
        onClick={() => { close(); item.action(); }}>
        {item.icon && <item.icon size={15} />}{item.label}
      </button>)}
    </div>
  </div>;
}
