import React, { useLayoutEffect, useRef } from 'react';
import { widgetColumnTracks } from '../core/request-widget-view.mjs';

function columnBounds(fields, tracks, index) {
  return [fields[index].min, Math.max(fields[index].min, tracks[index] + tracks[index + 1] - fields[index + 1].min)];
}

export function WidgetColumnHeader({ fields, widths, width, scale, panel, disabled, onCommit }) {
  const header = useRef(null), drag = useRef(null);
  const headerGrid = widgetColumnTracks(fields, widths, scale);
  const bodyGrid = widgetColumnTracks(fields, widths);
  const savedGrid = useRef(null);
  savedGrid.current = { headerGrid, bodyGrid };

  const readTracks = () => getComputedStyle(header.current).gridTemplateColumns.split(' ')
    .map(size => parseFloat(size) / scale);

  function updateValues(tracks) {
    header.current?.querySelectorAll('[role="separator"]').forEach((node, index) => {
      const [min, max] = columnBounds(fields, tracks, index);
      const value = Math.round(tracks[index]);
      node.setAttribute('aria-valuemin', String(min));
      node.setAttribute('aria-valuemax', String(Math.round(max)));
      node.setAttribute('aria-valuenow', String(value));
      node.setAttribute('aria-valuetext', value + ' DIP');
    });
  }

  function restore() {
    const node = header.current;
    if (!node) return;
    node.style.gridTemplateColumns = savedGrid.current.headerGrid;
    panel.current?.style.setProperty('--request-columns', savedGrid.current.bodyGrid);
    updateValues(readTracks());
  }

  useLayoutEffect(() => {
    const node = header.current;
    if (!node) return;
    drag.current = null;
    delete node.dataset.resizing;
    restore();
  }, [headerGrid, width, scale]);

  function move(tracks, index, delta) {
    const [min, max] = columnBounds(fields, tracks, index);
    const pair = tracks[index] + tracks[index + 1];
    const left = Math.min(max, Math.max(min, tracks[index] + delta));
    const next = [...tracks];
    next[index] = left;
    next[index + 1] = pair - left;
    header.current.style.gridTemplateColumns = next.map(size => size * scale + 'px').join(' ');
    panel.current?.style.setProperty('--request-columns', next.map(size => size + 'px').join(' '));
    updateValues(next);
    return next;
  }

  async function save(tracks) {
    // Model takes the remainder. Keep the visible columns' effective widths;
    // the preference store merges them with any currently hidden columns.
    const next = Object.fromEntries(fields.slice(1).map(({ id, min }, index) =>
      [id, Math.max(min, tracks[index + 1])]));
    if (!(await onCommit(next))) restore();
  }

  function finish(event, apply) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    delete header.current.dataset.resizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!apply || !current.next || Math.abs(current.next[current.index] - current.start[current.index]) < .05) restore();
    else void save(current.next);
  }

  if (fields.length < 2) return null;
  return <div ref={header} className="settings-widget-column-header" role="group" aria-label="调整请求列宽"
    style={{ width, gridTemplateColumns: headerGrid }}>
    {fields.map(({ id, label }, index) => <div className="settings-widget-column-cell" key={id}>
      <span title={label}>{label}</span>
      {index + 1 < fields.length && <span className="settings-widget-column-divider" role="separator"
        tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} aria-orientation="vertical"
        aria-label={`调整${label}与${fields[index + 1].label}列宽`}
        onPointerDown={event => {
          if (disabled || drag.current || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { index, x: event.clientX, pointerId: event.pointerId, start: readTracks() };
          header.current.dataset.resizing = id;
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (current?.pointerId !== event.pointerId) return;
          current.next = move(current.start, index, (event.clientX - current.x) / scale);
        }}
        onPointerUp={event => finish(event, true)}
        onPointerCancel={event => finish(event, false)}
        onLostPointerCapture={event => finish(event, false)}
        onKeyDown={event => {
          if (event.key === 'Escape' && drag.current) {
            event.preventDefault();
            finish({ pointerId: drag.current.pointerId, currentTarget: event.currentTarget }, false);
            return;
          }
          if (disabled || drag.current || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const tracks = readTracks(), step = event.shiftKey ? 12 : 4;
          const next = move(tracks, index, event.key === 'ArrowLeft' ? -step : step);
          if (Math.abs(next[index] - tracks[index]) < .05) restore();
          else void save(next);
        }} />}
    </div>)}
  </div>;
}
