import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronRight, Search, X, Zap, Play, Square } from './icons.jsx';
import { usageModelName } from './usage-view.mjs';
import { transitionUI, Presence } from './surface-motion.jsx';
import { PROTOCOL_NAMES, clientName, providerName, requestOK, requestKey, phaseName, known, fmt, seconds, monitorRows, summarizeRequests,
  aggregateTps, currentTps, cacheRate, meanTtft, requestTimeline } from './request-monitor-view.mjs';
import './request-monitor.css';
const EMPTY = { rows: [], active: [], error: '', limit: 5000 };
const PAGESIZE = 25;
const percent = value => known(value) ? fmt(value, 1) + '%' : '—';
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
function Trend({ buckets }) {
  const maxCalls = Math.max(1, ...buckets.map(bucket => bucket.calls));
  const maxTps = Math.max(1, ...buckets.map(bucket => aggregateTps(bucket) || 0));
  const estimated = buckets.some(bucket => bucket.tpsEstimated);
  const scaleY = value => 114 - value / maxTps * 96;
  const lines = []; let line = [];
  for (let i = 0; i < buckets.length; i++) {
    const value = aggregateTps(buckets[i]);
    if (value === null) { if (line.length) lines.push(line); line = []; }
    else line.push([i * 24 + 12, scaleY(value)]);
  }
  if (line.length) lines.push(line);
  return <section className="monitor-panel monitor-trend" aria-label="请求与吞吐趋势">
    <header><div><h2>请求与吞吐趋势</h2><p>按请求完成时间统计</p></div>
      <div className="monitor-legend"><span><i />成功</span><span><i className="failed" />失败</span><span><i className="tps" />{estimated ? '≈ ' : ''}可见 TPS</span></div></header>
    <div className="monitor-chart">
      <span className="monitor-axis-left">{fmt(maxCalls)} 次</span><span className="monitor-axis-right">{fmt(maxTps, 1)} tok/s</span>
      <svg viewBox="0 0 720 130" preserveAspectRatio="none" role="img" aria-label={`当前范围 ${buckets.reduce((n, b) => n + b.calls, 0)} 个请求的数量及 TPS 趋势`}>
        {[18, 66, 114].map(y => <line key={y} x1="0" x2="720" y1={y} y2={y} className="monitor-grid" />)}
        <g className="monitor-bars" key={buckets.some(bucket => bucket.calls) ? 'data' : 'empty'}>{buckets.map((bucket, index) => { const height = bucket.calls / maxCalls * 96, failed = (bucket.calls - bucket.passed) / maxCalls * 96;
          return <g key={index}><title>{`${new Date(bucket.time).toLocaleString('zh-CN')}–${time(bucket.end)} · ${bucket.calls} 次 · 可见 TPS ${bucket.tpsEstimated ? '≈ ' : ''}${fmt(aggregateTps(bucket), 1)}`}</title>
            <rect x={index * 24 + 4} y={114 - height} width="16" height={height} rx="3" className="monitor-bar" />
            {failed > 0 && <rect x={index * 24 + 4} y={114 - height} width="16" height={failed} rx="2" className="monitor-bar failed" />}</g>; })}</g>
        {lines.map((points, index) => <g key={index}><polyline className="monitor-tps-line" points={points.map(p => p.join(',')).join(' ')} />
          {points.map(([x, y]) => <circle key={x} cx={x} cy={y} r="2.5" className="monitor-tps-dot" />)}</g>)}
      </svg>
      <div className="monitor-chart-times">{[0, 14, 29].map(i => <span key={i}>{new Date(buckets[i].time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>)}</div>
    </div>
  </section>;
}
function RequestDetail({ row, onClose }) {
  return <section className="monitor-panel monitor-detail" aria-label="请求详情">
    <header><div><h2>{usageModelName(row.model)}</h2><p>{providerName(row)} · {new Date(row.time).toLocaleString('zh-CN', { hour12: false })}</p></div>
      <button className="icon-button" aria-label="关闭请求详情" onClick={onClose}><X size={18} /></button></header>
    <dl>{[
      ['请求 ID', row.requestId || '旧记录未提供'], ['客户端', clientName(row.client)], ['接口协议', PROTOCOL_NAMES[row.protocol] || '未记录'],
      ['原始模型 ID', row.model], ['上游 HTTP', row.httpStatus ?? '未收到'], ['ASS 状态', row.inProgress ? phaseName(row) : row.status],
      ['输入 token', fmt(row.usage?.inputTokens)], ['输出 token', (row.outputEstimated ? '≈ ' : '') + fmt(row.usage?.outputTokens)],
      ['缓存读取', fmt(row.usage?.cacheReadTokens)], ['缓存写入', fmt(row.usage?.cacheWriteTokens)],
      ['推理 token', fmt(row.usage?.reasoningTokens)], ['可见输出 token', (row.tpsEstimated && known(row.visibleTokens) ? '≈ ' : '') + fmt(row.visibleTokens)],
      ['可见输出 TPS', (row.tpsEstimated && known(row.tps) ? '≈ ' : '') + fmt(row.tps, 1)], ['可见输出接收时长', seconds(row.visibleMs)],
      ['全程吞吐', (row.outputEstimated && known(row.endToEndTps) ? '≈ ' : '') + fmt(row.endToEndTps, 1) + ' tok/s'],
      ['首输出延迟', seconds(row.ttftMs)], ['首输出后耗时', seconds(row.generationMs)], ['总耗时', seconds(row.ms)],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
    {row.error && <p className="monitor-request-error" role="status">{row.error}</p>}
  </section>;
}
export function RequestMonitor({ state }) {
  const [history, setHistory] = useState(EMPTY), [loadError, setLoadError] = useState(''), [paused, setPaused] = useState(false);
  const [options, setOptions] = useState({ range: 'day', search: '', provider: 'all', client: 'all', status: 'all', diagnostics: false });
  const [group, setGroup] = useState('requests'), [page, setPage] = useState(0), [selected, setSelected] = useState(null);
  const [now, setNow] = useState(Date.now);
  const revision = useRef(undefined), refresh = useRef(null);
  useEffect(() => {
    if (paused) return;
    let cancelled = false, reading = false;
    const read = async () => {
      if (cancelled || reading || document.hidden) return;
      reading = true;
      try {
        const next = await window.ass.call('request-monitor', revision.current);
        if (!cancelled) {
          revision.current = next.revision;
          setHistory(current => ({ ...next, rows: next.rows || current.rows, active: next.active || [] }));
          setLoadError(''); setNow(next.now || Date.now());
        }
      } catch (error) { if (!cancelled) setLoadError(error.message); }
      finally { reading = false; }
    };
    refresh.current = read; read();
    const timer = setInterval(read, 1000);
    document.addEventListener('visibilitychange', read);
    return () => { cancelled = true; refresh.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [paused]);
  useEffect(() => { refresh.current?.(); }, [state.requestRevision]);
  const allRows = useMemo(() => [...history.active, ...history.rows], [history.active, history.rows]);
  const rows = useMemo(() => monitorRows(allRows, options, now), [allRows, options, now]);
  const summary = useMemo(() => summarizeRequests(rows, group === 'provider' ? 'provider' : 'model'), [rows, group]);
  const buckets = useMemo(() => requestTimeline(rows, options.range, now), [rows, options.range, now]);
  const providers = useMemo(() => [...new Set(allRows.map(providerName))].sort(), [allRows]);
  const clients = useMemo(() => [...new Set(allRows.map(row => row.client || 'unknown'))].sort(), [allRows]);
  const selectedRow = selected && (allRows.find(row => requestKey(row) === requestKey(selected)) || selected);
  const total = summary.total, maxPage = Math.max(0, Math.ceil(rows.length / PAGESIZE) - 1), currentPage = Math.min(page, maxPage);
  const patch = update => { setOptions(current => ({ ...current, ...update })); setPage(0); setSelected(null); };
  const metrics = [
    ['请求数', fmt(total.calls), <Activity size={17} />, `${total.running} 个正在处理`],
    ['成功率', total.completed ? percent(total.passed / total.completed * 100) : '—', <CheckCircle2 size={17} />, `${fmt(total.passed)} 成功 / ${fmt(total.completed - total.passed)} 失败`],
    [total.running ? '并发可见 TPS' : '可见输出 TPS', ((total.running ? total.liveEstimated : total.tpsEstimated) ? '≈ ' : '') + fmt(currentTps(total), 1), <Zap size={17} />,
      total.running ? total.liveTpsSamples ? `${total.liveTpsSamples} 个请求的可见接收速率之和 · tok/s` : '等待可见输出及首秒采样' : `${total.tpsSamples} 个请求 · 文本与工具参数 · tok/s`],
    ['缓存命中率', percent(cacheRate(total)), <ArrowDownLeft size={17} />, `${total.cacheSamples} 个有缓存数据的请求`],
    ['平均首输出', seconds(meanTtft(total)), <ArrowUpRight size={17} />, `${total.ttftSamples} 个流式请求`],
  ];
  return <div className="request-monitor">
    <header className="monitor-heading"><div><span className="monitor-eyebrow">REQUEST OBSERVABILITY</span><h2>请求监控</h2><p>吞吐、缓存与供应商表现，随请求实时更新。</p></div>
      <div className="monitor-live"><span className={paused ? 'paused' : ''}><i />{paused ? '已暂停刷新' : '实时更新'}</span>
        <button className="button" onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Square size={14} />}{paused ? '继续刷新' : '暂停刷新'}</button></div></header>
    <div className="monitor-toolbar"><div className="monitor-range" role="group" aria-label="监控时间范围">
      {[['hour', '近 1 小时'], ['day', '近 24 小时'], ['week', '近 7 天'], ['all', '全部保留记录']].map(([value, label]) =>
        <button key={value} aria-pressed={options.range === value} onClick={() => transitionUI(() => patch({ range: value }))}>{label}</button>)}</div>
      <span className="monitor-retained">已保留 {fmt(history.rows.length)} 条 · 最多 {fmt(history.limit)} 条</span></div>
    {(loadError || history.error) && <p className="error-box" role="alert">{loadError || history.error}</p>}
    <div className="monitor-kpis">{metrics.map(([label, value, icon, hint]) => <section key={label} className="monitor-kpi" aria-label={label}>
      <div><span>{label}</span>{icon}</div><strong>{value}</strong><small>{hint}</small></section>)}</div>
    <div className="monitor-middle"><Trend buckets={buckets} /><section className="monitor-panel monitor-tokens">
      <header><div><h2>Token 分布</h2><p>{total.usageSamples} / {total.calls} 个请求报告了用量</p></div></header>
      <div><span><ArrowDownLeft size={15} />输入</span><strong>{total.inputSamples ? fmt(total.input) : '—'}</strong></div>
      <div><span><ArrowUpRight size={15} />输出</span><strong>{total.outputSamples ? fmt(total.output) : '—'}</strong></div>
      <div className="monitor-token-track" aria-hidden="true" data-empty={!(total.input + total.output)} key={total.input + total.output ? 'data' : 'empty'}><i style={{ width: `${total.input + total.output ? total.input / (total.input + total.output) * 100 : 0}%` }} /></div>
      <div className="monitor-cache-total"><span>缓存读取 <b>{total.cacheReadSamples ? fmt(total.cacheRead) : '—'}</b></span><span>缓存写入 <b>{total.cacheWriteSamples ? fmt(total.cacheWrite) : '—'}</b></span></div>
    </section></div>
    <section className="monitor-panel monitor-log" aria-label="模型请求记录">
      <div className="monitor-log-heading"><div className="monitor-tabs" role="group" aria-label="监控视图">{[['requests', '请求明细'], ['model', '模型汇总'], ['provider', '供应商汇总']].map(([value, label]) =>
        <button key={value} aria-pressed={group === value} onClick={() => transitionUI(() => { setGroup(value); setPage(0); setSelected(null); })}>{label}</button>)}</div>
        <span className="muted">{fmt(rows.length)} 个请求</span></div>
      <div className="monitor-filters"><label className="monitor-search"><Search size={16} /><input aria-label="搜索模型或供应商" placeholder="搜索模型、供应商或请求 ID" value={options.search} onChange={event => patch({ search: event.target.value })} /></label>
        <select aria-label="筛选供应商" value={options.provider} onChange={event => patch({ provider: event.target.value })}><option value="all">所有供应商</option>{providers.map(name => <option key={name} value={name}>{name}</option>)}</select>
        <select aria-label="筛选客户端" value={options.client} onChange={event => patch({ client: event.target.value })}><option value="all">所有客户端</option>{clients.map(id => <option key={id} value={id}>{clientName(id)}</option>)}</select>
        <select aria-label="筛选请求状态" value={options.status} onChange={event => patch({ status: event.target.value })}><option value="all">所有状态</option><option value="running">进行中</option><option value="success">成功</option><option value="failed">失败</option></select>
        <label className="monitor-diagnostics"><input type="checkbox" checked={options.diagnostics} onChange={event => patch({ diagnostics: event.target.checked })} />含连接测试</label></div>
      {!rows.length ? <div className="monitor-empty"><Activity size={28} /><h3>{allRows.length ? '没有符合条件的请求' : '等待第一个模型请求'}</h3><p>{allRows.length ? '调整时间范围或筛选条件查看记录。' : '请求开始后，会在这里实时显示状态、耗时和吞吐。'}</p></div> :
        <div className="monitor-table-scroll">{group === 'requests' ? <table className="monitor-table"><thead><tr>
          {['时间', '模型 / 协议', '供应商 / 客户端', '输入 / 输出', '缓存读取', '可见 TPS', '首输出', '总耗时', '状态'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
          {rows.slice(currentPage * PAGESIZE, (currentPage + 1) * PAGESIZE).map(row => <tr key={requestKey(row)} data-in-progress={row.inProgress || undefined} className={selectedRow && requestKey(selectedRow) === requestKey(row) ? 'selected' : ''}>
            <td><time title={new Date(row.startedAt || row.time).toLocaleString('zh-CN')}>{time(row.startedAt || row.time)}</time></td>
            <td><button className="monitor-model-button" aria-label={`查看 ${usageModelName(row.model)} 请求详情`} aria-expanded={selectedRow && requestKey(selectedRow) === requestKey(row)} onClick={() => setSelected(selectedRow && requestKey(selectedRow) === requestKey(row) ? null : row)}>{usageModelName(row.model)}<ChevronRight size={12} /></button>
              <small>{row.operation === 'compaction' ? '上下文压缩 · ' : ''}{PROTOCOL_NAMES[row.protocol] || '未记录协议'}</small></td>
            <td><span className="monitor-provider-name" title={providerName(row)}>{providerName(row)}</span><small>{clientName(row.client)}</small></td>
            <td><span>{fmt(row.usage?.inputTokens)}</span><small>{row.outputEstimated ? '≈ ' : ''}{fmt(row.usage?.outputTokens)}</small></td>
            <td><span className={row.usage?.cacheReadTokens > 0 ? 'monitor-cache-hit' : ''}>{fmt(row.usage?.cacheReadTokens)}</span><small>{row.usage?.inputTokens > 0 && known(row.usage?.cacheReadTokens) ? percent(row.usage.cacheReadTokens / row.usage.inputTokens * 100) : '—'}</small></td>
            <td className="monitor-tps-value" title={row.tpsEstimated ? '估算可见文本与工具参数 token ÷ 可见输出接收时长；实时值先采样一秒' : '非推理输出 token ÷ 首个至末个可见输出的接收时长；无独立计时则未知'}>{row.tpsEstimated && known(row.tps) ? '≈ ' : ''}{fmt(row.tps, 1)}{row.tpsEstimated && known(row.tps) && <small>估算 tok/s</small>}</td><td>{seconds(row.ttftMs)}</td><td>{seconds(row.ms)}</td>
            <td><span className={`monitor-status ${row.inProgress ? 'running' : requestOK(row) ? 'ok' : 'failed'}`} title={row.error || `上游 HTTP ${row.httpStatus ?? '未收到'}`}>{row.inProgress ? phaseName(row) : requestOK(row) ? '成功' : '失败'}<b>{row.httpStatus ?? row.status}</b></span></td>
          </tr>)}</tbody></table> : <table className="monitor-table monitor-summary-table"><thead><tr>{[group === 'model' ? '模型' : '供应商', group === 'model' ? '供应商' : '模型数', '请求', '成功率', '输入 token', '输出 token', '缓存命中率', '可见 TPS', '平均首输出'].map((label, i) => <th key={i}>{label}</th>)}</tr></thead><tbody>
          {summary.groups.map(entry => <tr key={entry.name}><td><strong>{entry.name}</strong></td><td title={[...entry.providers].join('、')}>{group === 'model' ? [...entry.providers].join('、') : entry.models.size}</td>
            <td>{fmt(entry.calls)}{entry.running > 0 && <small>{entry.running} 进行中</small>}</td><td>{entry.completed ? percent(entry.passed / entry.completed * 100) : '—'}</td><td>{entry.inputSamples ? fmt(entry.input) : '—'}</td><td>{entry.outputSamples ? fmt(entry.output) : '—'}</td>
            <td>{percent(cacheRate(entry))}</td><td className="monitor-tps-value">{(entry.running ? entry.liveEstimated : entry.tpsEstimated) ? '≈ ' : ''}{fmt(currentTps(entry), 1)}{entry.running > 0 && <small>实时 tok/s</small>}</td><td>{seconds(meanTtft(entry))}</td></tr>)}</tbody></table>}</div>}
      {group === 'requests' && rows.length > PAGESIZE && <footer className="monitor-pagination"><span>第 {currentPage + 1} / {maxPage + 1} 页</span><div>
        <button className="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="button" disabled={currentPage >= maxPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div></footer>}
    </section>
    <Presence show={!!selectedRow}>{selectedRow && <RequestDetail row={selectedRow} onClose={() => setSelected(null)} />}</Presence>
    <details className="monitor-method"><summary>指标口径与模型归并</summary><p>展示经过 ASS 的进行中和已完成请求，每秒刷新。进行中请求置顶，耗时从接收请求开始累计；成功率、用量和缓存汇总只计已结束的请求。直连供应商的客户端请查看路由总览中的原生用量。</p>
      <p>主要 TPS 为可见文本与工具参数的接收速率。上游明确报告推理 token 数时，从总输出中减去推理量；否则仅按可见内容估算（ASCII 约 4 字符/token，其他字符约 1 字符/token），标记“≈”。估算不写入计费用量。思考、推理摘要及隐藏推理均不计入可见输出。</p>
      <p>已完成请求使用首个至末个可见输出的接收时长，不计首次可见输出前的等待或最后输出后的用量尾包延迟。进行中每秒更新，包含可见输出之间的停顿；需观察到不同时间的输出并采样一秒。单包、非流式或缺少独立计时的数据不测速。汇总以成功请求的可见 token 总数除以其接收时长之和；估算样本参与时汇总也标“≈”。并发卡片为活跃请求接收速率之和。</p>
      <p>全程吞吐保留在详情中，为全部输出 token ÷ 请求总耗时，包含等待与推理。两项都是客户端侧指标，不能还原服务端真实解码速度。旧日志缺少独立可见计时时，主要 TPS 显示“—”，原日志及可查的全程吞吐保留。</p>
      <p>缓存命中率 = 缓存读取 token ÷ 输入 token，只使用报告了缓存数据的请求。Anthropic 输入统一包含缓存读取和写入，缺失字段显示“—”。模型名称沿用 ASS 的最后一级归并，例如 vendor/model 与 model 合为一项，供应商仍单独展示。</p>
      <p>请求历史沿用本机滚动日志，并最多展示最近 {fmt(history.limit)} 条；时间范围只筛选保留记录。这里仅保存用量数字与路由标签，不记录提示词或回答正文。</p></details>
  </div>;
}
