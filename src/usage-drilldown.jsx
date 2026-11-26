import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, X } from './icons.jsx';
import { CLIENT_NAMES } from './usage-view.mjs';
import './usage-drilldown.css';

const count = (value) => value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const total = (row) => row.input + row.output;
const errorText = (error) => error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');

export function UsageDrilldown({ selection, onClose, onOpenConversation, act }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(undefined);
  const heading = useRef(null);
  useEffect(() => {
    let current = true;
    window.ass.call('usage-drilldown', selection.query).then((value) => {
      if (current) setResult(value);
    }).catch((failure) => { if (current) setError(errorText(failure)); });
    heading.current?.focus();
    return () => { current = false; };
  }, [selection]);
  const open = expanded === undefined ? result?.projects[0]?.id : expanded;
  return <section className="usage-breakdown usage-drilldown" aria-labelledby="usage-drilldown-heading" id="usage-drilldown" onKeyDown={(event) => {
    if (event.key === 'Escape') onClose();
  }}>
    <header>
      <div>
        <h2 id="usage-drilldown-heading" ref={heading} tabIndex={-1}>会话用量</h2>
        <small>{selection.label}</small>
      </div>
      <button type="button" className="icon-button" aria-label="关闭会话用量" onClick={onClose}><X size={16} /></button>
    </header>
    {error ? <p className="error-box" role="alert">{error}</p> : !result ? (
      <p className="usage-drill-status" role="status"><Loader2 size={15} className="spin" />读取本机会话用量…</p>
    ) : <>
      <p className="usage-drill-status">选中范围 · {count(result.selected.calls)} 次调用 · {count(total(result.selected))} Tokens</p>
      {!result.projects.length && !result.unallocated.calls && !total(result.unallocated) ? <p className="muted tiny">此范围暂无会话用量</p> : null}
      {result.projects.map((project) => <div className="usage-drill-project" key={project.id}>
        <button type="button" className="usage-drill-project-heading" aria-expanded={open === project.id} onClick={() => setExpanded(open === project.id ? null : project.id)}>
          <ChevronRight size={15} /><strong>{project.name}</strong><span>{count(project.sessions.length)} 个会话 · {count(total(project.selected))} Tokens</span>
        </button>
        {open === project.id ? <ul className="usage-drill-sessions">
          {project.sessions.map((session) => <li key={`${session.client}:${session.id}`}>
            <div className="usage-drill-description">
              <strong title={session.title}>{session.title}</strong>
              <small>{session.surface || CLIENT_NAMES[session.client] || session.client}{session.title === '会话未匹配' ? ` · ${session.id.slice(0, 8)}` : ''}</small>
            </div>
            <div className="usage-drill-metrics">
              <strong>{count(total(session.selected))} Tokens</strong>
              <small>所选 {count(session.selected.calls)} 次 · 已收录总量 {count(total(session.total))} Tokens</small>
            </div>
            {session.target ? <button type="button" className="button" onClick={() => onOpenConversation(session.target)}>查看原会话</button>
              : session.resume ? <button type="button" className="button" onClick={() => act('usage-open-antigravity', () =>
                window.ass.call('antigravity-resume', session.resume.id, session.resume.workspace))}>打开 CLI 会话</button>
              : <small className="usage-drill-unavailable">暂无可用的会话入口</small>}
          </li>)}
        </ul> : null}
      </div>)}
      {result.unallocated.calls || total(result.unallocated) ? <p className="usage-drill-status muted">
        未分配到会话 · {count(result.unallocated.calls)} 次调用 · {count(total(result.unallocated))} Tokens{selection.query.dayOnly ? '（仅有日汇总）' : ''}
      </p> : null}
    </>}
  </section>;
}
