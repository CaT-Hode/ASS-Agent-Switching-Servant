import React, { memo, useLayoutEffect, useRef, useState } from 'react';
import { WIDGET_QUOTA_HEIGHT, WIDGET_ROW_INLINE_PADDING, WIDGET_USAGE_HEIGHT, widgetColumnTracks, widgetContentInsets,
  widgetDuration as duration, widgetHeatRadius, widgetVisibleColumns } from '../core/request-widget-view.mjs';
import { clientName } from './request-monitor-view.mjs';
import { UsageMeter } from './usage-meter.jsx';
import './widget-surface.css';
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const formatRate = value => (value >= 1000 ? compact.format(value) : value.toFixed(value < 100 ? 1 : 0)) + '/s';
const speed = row => row.tps !== null ? formatRate(row.tps) : row.endToEndTps !== null ? '~' + formatRate(row.endToEndTps) : '—';
const rowTitle = row => `${row.rawModel}\n${row.provider} · ${clientName(row.client)}\n${row.tps === null && row.endToEndTps !== null ? '全程吞吐' : row.estimated ? '估算可见输出' : '可见输出'} ${speed(row)}${row.shortSample ? '（短样本，不计入汇总）' : ''} · ${duration(row.ms)}\n输入 ${row.input ?? '—'} · 输出 ${row.output ?? '—'} · 缓存 ${row.cache === null ? '—' : row.cache.toFixed(1)+'%'}${row.error ? '\n'+row.error : ''}`;
const MovingRow = memo(function MovingRow({ row, index, exiting, onExit, harness, provider, throughput, cache, showDuration, preview }) {
  const node = useRef(null), entered = useRef(false);
  useLayoutEffect(() => {
    if (preview) return;
    const element = node.current, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = getComputedStyle(element);
    const from = entered.current ? { transform: style.transform, opacity: style.opacity }
      : { transform: reduced ? 'none' : 'translateX(-24px) scale(.955)', opacity: 0 };
    entered.current = true;
    const keyframes = exiting
      ? [from, { transform: reduced ? 'none' : 'translateX(36px) scale(.96)', opacity: 0 }]
      : reduced
        ? [from, { transform: 'none', opacity: 1 }]
        : [from, { transform: 'translateX(2.5px) scale(1.006)', opacity: 1, offset: .68 }, { transform: 'none', opacity: 1 }];
    const animation = element.animate(keyframes,
      { duration: reduced ? 0 : exiting ? 260 : 380, easing: exiting ? 'cubic-bezier(.4,0,.2,1)' : 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
    let timer = null;
    if (exiting) {
      let settled = false;
      const done = () => { if (!settled) { settled = true; onExit(row.id); } };
      animation.finished.then(done, () => {});
      // Guard against throttled/stalled Web Animations when the overlay is occluded.
      timer = setTimeout(done, reduced ? 40 : 420);
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
      try { animation.commitStyles(); } catch {}
      animation.cancel();
    };
  }, [exiting, preview]);
  const phase = !row.inProgress ? row.ok === false ? 'failed' : 'complete' : row.phase === 'streaming' ? 'output' : 'waiting';
  return <div className="widget-row-slot" style={{ transform: `translateY(${-index*27}px)` }} inert={exiting || undefined} data-exiting={exiting || undefined}>
    <div ref={node} className="widget-request" data-request-id={row.id} data-phase={phase}
      aria-label={`${row.model}${harness ? ' · ' + clientName(row.client) : ''} · ${row.inProgress ? row.phase === 'streaming' ? '输出中' : '等待中' : row.ok === false ? '失败' : '完成'}`}
      onPointerEnter={event => { event.currentTarget.title = rowTitle(row); }}>
      <i className="widget-row-material" aria-hidden="true" />
      <span className="widget-model">{row.model}</span>
      {provider && <span className="widget-provider">{row.provider}</span>}
      {harness && <span className="widget-harness">{clientName(row.client)}</span>}
      {throughput && <span className="widget-tps" aria-label={row.tps === null && row.endToEndTps !== null ? '全程吞吐 ' + speed(row) : row.shortSample ? '可见 TPS ' + speed(row) + '，短样本' : undefined}>{speed(row)}{row.shortSample && <sup aria-hidden="true">*</sup>}</span>}
      {cache && <span className="widget-cache" aria-label={'缓存命中率 '+(row.cache ?? '未知')}>{row.cache === null ? '—' : Math.round(row.cache)+'%'}</span>}
      {showDuration && <span className="widget-duration">{duration(row.ms)}</span>}
    </div>
  </div>;
});
const WidgetHeatmap = memo(function WidgetHeatmap({ heat, preview }) {
  const [hover, setHover] = useState(null);
  return <div className="widget-footer">
    <div className="widget-heatmap" role="group" aria-label="今日 Token，二十四个小时时段" onPointerLeave={() => setHover(null)}>
      {heat.cells.map(cell => <span className="widget-heatcell" key={cell.hour} data-level={cell.level} data-future={cell.future}
        data-current={cell.current || undefined} aria-current={cell.current ? 'time' : undefined}
        onPointerEnter={() => setHover(cell.hour)} onFocus={() => setHover(cell.hour)} onBlur={() => setHover(null)} tabIndex={preview ? undefined : 0}
        aria-describedby={hover === cell.hour ? 'heat-tooltip' : undefined}
        aria-label={`${cell.hour}点至${cell.hour+1}点，${cell.tokens} token`}>
        {cell.current && cell.tokens > 0 && <i key={cell.tokens} className="widget-heat-ripple" aria-hidden="true" />}
      </span>)}
    </div>
    {hover !== null && heat.cells[hover] && <div className="widget-heat-tooltip" role="tooltip" id="heat-tooltip">
      <span>{String(hover).padStart(2,'0')}:00–{String(hover+1).padStart(2,'0')}:00</span>
      <strong>{compact.format(heat.cells[hover].tokens)} <small>token</small></strong>
      <span>↓ {compact.format(heat.cells[hover].input)}　↑ {compact.format(heat.cells[hover].output)}</span>
    </div>}
  </div>;
});

function WidgetUsage({ summary }) {
  const label = summary && `今日 ${summary.total.toLocaleString('zh-CN')} Tokens，输入 ${summary.input.toLocaleString('zh-CN')}，输出 ${summary.output.toLocaleString('zh-CN')}`;
  return <div className="widget-usage" style={{ height: WIDGET_USAGE_HEIGHT }} title={label} aria-label={label}>
    <span>今日 Token <strong>{summary ? compact.format(summary.total) : '—'}</strong></span>
    {summary && <small aria-hidden="true">↓ {compact.format(summary.input)} <span>↑ {compact.format(summary.output)}</span></small>}
  </div>;
}

function WidgetQuotaBar({ bar }) {
  const known = Number.isFinite(bar.remainingPercent);
  const percent = known ? Number(bar.remainingPercent.toFixed(1)) : null;
  const reset = Date.parse(bar.resetsAt);
  const resetTime = Number.isFinite(reset) ? new Date(reset).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }) : null;
  const label = [bar.label, known ? `${percent}% remaining` : 'No quota data',
    ...(resetTime ? [`Resets ${resetTime}`] : [])].join(' · ');
  return <div className="widget-quota-bar" lang="en" style={{ height: WIDGET_QUOTA_HEIGHT }} title={label}>
    {known ? <UsageMeter value={percent} label={label} quota={{ id: bar.period, label: bar.label }} />
      : <div className="usage-meter" role="img" aria-label={label} />}
    <div className="widget-quota-caption" aria-hidden="true"><span>{bar.label}</span><strong>{known ? `${percent}%` : '—'}</strong></div>
  </div>;
}

export function WidgetSurface({ frame, entries, onExit, panelRef, preview = false, ...events }) {
  const glass = frame.glass === true;
  const insets = widgetContentInsets(frame.radius);
  const { harness = false, provider = true, throughput = true, cache = true, duration: showDuration = true } = frame.columns || {};
  const requestColumns = widgetColumnTracks(widgetVisibleColumns(frame.columns), frame.columnWidths);
  return <div ref={panelRef} className="widget-panel" data-glass={glass} data-theme={frame.theme || 'dark'}
    data-preview={preview || undefined} style={{ '--radius': frame.radius+'px', '--heat-radius': widgetHeatRadius(frame.radius)+'px',
      '--widget-padding': [insets.top, insets.horizontal, insets.bottom].map(value => value + 'px').join(' '),
      '--request-inline-padding': WIDGET_ROW_INLINE_PADDING + 'px',
      '--request-columns': requestColumns }}
    role={preview ? 'img' : 'main'} aria-label={preview ? '请求悬浮窗布局示例' : '实时请求悬浮窗'} {...events}>
    {!glass && frame.error && <span className="widget-error" title={frame.error} aria-label={frame.error}>!</span>}
    <div className="widget-requests" aria-live="off">
      {entries.map(item => <MovingRow key={item.row.id} {...item} onExit={onExit}
        {...{ harness, provider, throughput, cache, showDuration, preview }} />)}
      {!entries.length && <div className="widget-idle" aria-label="等待请求"><i /><i /><i /></div>}
    </div>
    {frame.showUsage && <WidgetUsage summary={frame.usageSummary} />}
    {frame.showHeatmap !== false && <WidgetHeatmap heat={frame.heat} preview={preview} />}
    {frame.quotaBars?.map((bar, index) => <WidgetQuotaBar key={index} bar={bar} />)}
  </div>;
}
