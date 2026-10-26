import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "./icons.jsx";
import { Presence } from './surface-motion.jsx';

export function ActionMenu({ label, items, disabled = false, text }) {
  const [open, setOpen] = useState(false),
    root = useRef(null),
    trigger = useRef(null),
    id = useId();
  function close(focus = true) {
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="action-menu"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={text ? "button" : "icon-button"}
        ref={trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {text ? (
          <>
            {text}
            <ChevronDown size={14} />
          </>
        ) : (
          <MoreHorizontal size={18} />
        )}
      </button>
      <Presence show={open} offset="translateY(-4px) scale(.98)">{open && (
        <div
          className="action-menu-panel"
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              const buttons = [
                ...e.currentTarget.querySelectorAll(
                  '[role="menuitem"]:not(:disabled)',
                ),
              ];
              const index = buttons.indexOf(document.activeElement),
                next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {items.filter(Boolean).map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              disabled={item.disabled}
              className={item.danger ? "danger" : ""}
              onClick={() => {
                close();
                item.action();
              }}
            >
              {item.icon && <item.icon size={15} />}
              {item.label}
            </button>
          ))}
        </div>
      )}</Presence>
    </div>
  );
}
