import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motionRows } from '../core/request-widget-view.mjs';
import './request-widget.css';
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const duration = ms => Number.isFinite(ms) ? ms < 60000 ? (ms/1000).toFixed(1)+'s' : Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0') : '—';
const speed = row => row.tps === null ? '—' : (row.estimated ? '≈' : '') + row.tps.toFixed(row.tps < 100 ? 1 : 0) + '/s';
function MovingRow({ row, index, exiting, onExit }) {
  const node = useRef(null), entered = useRef(false);
  useLayoutEffect(() => {
    const element = node.current, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = getComputedStyle(element);
    const from = entered.current ? { transform: style.transform, opacity: style.opacity }
      : { transform: reduced ? 'none' : 'translateX(-32px)', opacity: 0 };
    entered.current = true;
    const animation = element.animate([from, exiting ? { transform: reduced ? 'none' : 'translateX(40px)', opacity: 0 } : { transform: 'none', opacity: 1 }],
    { duration: reduced ? 0 : exiting ? 160 : 220, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'both' });
    if (exiting) animation.finished.then(() => onExit(row.id), () => {});
    return () => { animation.commitStyles();animation.cancel(); };
  }, [exiting]);
  return <div className="widget-row-slot" style={{ transform: `translateY(${index*29}px)` }} inert={exiting || undefined} data-exiting={exiting || undefined}>
    <div ref={node} className="widget-request" data-request-id={row.id}
      data-phase={!row.inProgress ? row.ok === false ? 'failed' : 'complete' : row.phase === 'streaming' ? 'output' : 'waiting'}
      aria-label={`${row.model} · ${row.inProgress ? row.phase === 'streaming' ? '输出中' : '等待中' : row.ok === false ? '失败' : '完成'}`}
      title={`${row.rawModel}\n${row.provider} · ${row.client || '—'}\n${row.estimated?'估算可见输出':'可见输出'} ${speed(row)} · ${duration(row.ms)}\n输入 ${row.input ?? '—'} · 输出 ${row.output ?? '—'} · 缓存 ${row.cache === null ? '—' : row.cache.toFixed(1)+'%'}${row.error ? '\n'+row.error : ''}`}>
      <i className="widget-row-material" aria-hidden="true" /><span className="widget-model">{row.model}</span><span className="widget-provider">{row.provider}</span>
      <span className="widget-tps">{speed(row)}</span><span className="widget-cache" aria-label={'缓存命中率 '+(row.cache ?? '未知')}>{row.cache === null ? '—' : Math.round(row.cache)+'%'}</span>
      <span className="widget-duration">{duration(row.ms)}</span>
    </div>
  </div>;
}
export function RequestWidget() {
  const [state, setState] = useState({ rows: [], heat: { cells: [] }, radius: 36, capacity: 5 });
  const [entries, setEntries] = useState([]);
  const [hover, setHover] = useState(null);
  const count = entries.reduce((max, item) => Math.max(max, item.index+1), 0);
  useLayoutEffect(() => {
    if (state.heat.cells.length && (count || !state.rows.length)) window.requestWidget.layout(count);
  }, [count, state.heat.cells.length, state.rows.length]);
  const retired = id => setEntries(previous => previous.filter(item => item.row.id !== id || !item.exiting));
  useEffect(() => { let alive = true;const receive = value => { if (alive) { setState(value);setEntries(previous => motionRows(previous, value.rows)); } };
    const unsubscribe = window.requestWidget.subscribe(receive);
    window.requestWidget.ready().then(receive);return () => { alive = false;unsubscribe(); }; }, []);
  const glass = !!state.glass?.presented && !state.glass?.error;
  return <main className="widget-panel" data-glass={glass} data-theme={state.theme || 'dark'} style={{ '--radius': state.radius+'px' }} aria-label="实时请求悬浮窗"
    onContextMenu={event => { event.preventDefault();window.requestWidget.menu(); }}
    onKeyDown={event => { if (event.key === 'Escape') window.requestWidget.hide(); }}
    onPointerDown={event => { if (event.button === 0) window.requestWidget.drag(); }}>
    {!glass && state.error && <span className="widget-error" title={state.error} aria-label={state.error}>!</span>}
    <div className="widget-requests" style={{ maxHeight: state.capacity*29, height: Math.max(1, count)*29 }} aria-live="off">
      {entries.map(item => <MovingRow key={item.row.id} {...item} onExit={retired} />)}
      {!entries.length && <div className="widget-idle" aria-label="等待请求"><i /><i /><i /></div>}
    </div>
    <div className="widget-heatmap" role="group" aria-label="今日 Token，二十四个小时时段" onPointerLeave={() => setHover(null)}>
      {state.heat.cells.map(cell => <span className="widget-heatcell" key={cell.hour} data-level={cell.level} data-future={cell.future}
        onPointerEnter={() => setHover(cell.hour)} onFocus={() => setHover(cell.hour)} onBlur={() => setHover(null)} tabIndex={0}
        aria-describedby={hover === cell.hour ? 'heat-tooltip' : undefined}
        aria-label={`${cell.hour}点至${cell.hour+1}点，${cell.tokens} token`} />)}
    </div>
    {hover !== null && state.heat.cells[hover] && <div className="widget-heat-tooltip" role="tooltip" id="heat-tooltip">
      <span>{String(hover).padStart(2,'0')}:00–{String(hover+1).padStart(2,'0')}:00</span>
      <strong>{compact.format(state.heat.cells[hover].tokens)} <small>token</small></strong>
      <span>↓ {compact.format(state.heat.cells[hover].input)}　↑ {compact.format(state.heat.cells[hover].output)}</span>
    </div>}
  </main>;
}
createRoot(document.getElementById('root')).render(<RequestWidget />);
