import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Play, RotateCcw, ShieldCheck, Trash2, X } from './icons.jsx';
import { ConversationMarkdown } from './conversation-markdown.mjs';
const api = window.ass, labels = { codex: 'Codex', claude: 'Claude Code' };
const statusText = { archived: '已归档', residual: '索引缺失', duplicate: '非当前副本', retained: '仅保留副本', missing: '原记录不存在' };
const reasons = {
  archived: '原生索引标为归档，或日志位于 archived_sessions。',
  residual: '日志仍在磁盘，但可读取的 Codex 原生索引中没有此会话；可能是删除后的残留或索引尚未同步。',
  duplicate: 'Codex 原生索引指向同一会话的另一份日志，此文件是非当前副本。',
  retained: '原路径已不存在，当前内容来自 ASS 保存的加密副本。',
  missing: '原生文件和可用保留副本均不存在。',
};
export const storageSize = bytes => {
  const units = ['B', 'KiB', 'MiB', 'GiB']; let n = Math.max(0, Number(bytes) || 0), u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toLocaleString('zh-CN', { maximumFractionDigits: u ? 2 : 0 })} ${units[u]}`;
};
export function HistoryBadge({ row, current = false }) {
  const status = current ? row.currentStatus : row.historyStatus;
  if (statusText[status]) return <span className="conversation-history-badge" title={reasons[status]}>{statusText[status]}</span>;
  if (['unavailable', 'partial'].includes(row.nativeIndexState)) return <span className="conversation-history-badge" title="原生索引暂不可读或超出读取范围；没有据此判定会话已删除。">索引状态未知</span>;
  return null;
}
export function HistorySource({ row }) {
  const explanation = reasons[row.historyStatus];
  if (!explanation) return null;
  return <div className="conversation-source-note"><p>{explanation}</p><small title={row.file}>日志来源：{row.file}</small></div>;
}
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '未知';
const errorText = e => e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
export function ConversationHistory({ initialHarness, onClose, onChange }) {
  const panel = useRef(null), events = useRef(null), [harness, setHarness] = useState(labels[initialHarness] ? initialHarness : 'codex');
  const [tab, setTab] = useState('backups'), [backups, setBackups] = useState(null), [trash, setTrash] = useState(null);
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [before, setBefore] = useState(0);
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [cleaning, setCleaning] = useState(null);
  const previewSelection = useRef(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  events.current = { onClose, busy, cleaning };
  useEffect(() => {
    const opener = document.activeElement; panel.current?.querySelector('button')?.focus();
    const handle = e => {
      if (e.key === 'Escape') { e.stopPropagation(); if (events.current.cleaning) setCleaning(null); else if (!events.current.busy) events.current.onClose(); }
      if (e.key !== 'Tab') return;
      const root = panel.current.querySelector('[role="alertdialog"]') || panel.current;
      const focusable = [...root.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    let current = true; setBackups(null); setError(''); setPreview(null); setCleaning(null);
    Promise.all([api.call('conversations-backups', { harness, offset }), api.call('project-conversations-trash', { includeRestored: true })])
      .then(([a, b]) => { if (!current) return; setBackups(a); setTrash(b); setError(a.error || '');
        setSelected(old => a.items.find(r => r.id === old?.id) || a.items[0] || null); })
      .catch(e => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [harness, offset, revision]);
  useEffect(() => {
    let current = true; setPreview(null);
    if (selected?.id !== previewSelection.current && before) { setBefore(0); return; }
    previewSelection.current = selected?.id;
    if (backups && selected?.available) api.call('conversations-backup-preview', selected.id, before).then(r => { if (current) setPreview(r); })
      .catch(e => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [backups, selected?.id, selected?.capturedAt, selected?.available, before, previewRevision]);
  async function act(name, ...args) {
    setBusy(name); setError(''); setNotice(''); setCleaning(null);
    try {
      const r = await api.call(name, ...args);
      const fallback = name === 'conversations-preserve' ? `已保留 ${r.retained} 个当前对话` : name === 'conversations-resume' ? '已使用当前账户打开续聊' : '操作完成';
      setNotice((r.message || fallback) + (r.bytes ? `，释放 ${storageSize(r.bytes)}` : ''));
      setBefore(0); setRevision(n => n + 1); onChange();
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  function cleanup(row) {
    if (!backups) return;
    setCleaning({ type: 'backups', title: row ? row.title : `全部 ${labels[harness]} 保留副本`, count: row ? 1 : backups.total,
      bytes: row ? row.backupBytes : backups.bytes, input: { harness, ids: row ? [row.id] : undefined, revision: backups.revision, confirmed: true } });
  }
  return <div className="conversation-trash-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section ref={panel} className="conversation-history-panel" role="dialog" aria-modal="true" aria-label="历史与存储" onClick={e => e.stopPropagation()}>
      <header><div><h2>历史与存储</h2><p>保留换号前的内容，原记录丢失后可恢复或继续。</p></div><button className="icon-button" aria-label="关闭历史与存储" disabled={!!busy} onClick={onClose}><X size={18} /></button></header>
      <div className="conversation-history-tabs"><button aria-pressed={tab === 'backups'} onClick={() => { setTab('backups'); setCleaning(null); }}>保留副本</button><button aria-pressed={tab === 'trash'} onClick={() => { setTab('trash'); setCleaning(null); }}>已删除备份</button></div>
      {tab === 'backups' ? <>
        <div className="conversation-history-toolbar"><div className="conversation-tabs">{Object.entries(labels).map(([id, label]) => <button key={id} aria-pressed={harness === id} disabled={!!busy} onClick={() => { setHarness(id); setOffset(0); setBefore(0); }}>{label}</button>)}</div>
          <span>{backups ? `${backups.total} 个副本 · ${storageSize(backups.bytes)}` : '读取存储…'}</span>
          <div className="actions"><button className="button" disabled={!!busy} onClick={() => act('conversations-preserve', harness)}><ShieldCheck size={14} />保留当前对话</button><button className="button danger" disabled={!!busy || !backups?.total} onClick={() => cleanup()}>清空本客户端副本</button></div>
        </div>
        <p className="conversation-history-help">归档和索引缺失的日志不自动备份。预览展示保存时的内容；清理仅移除 ASS 副本。</p>
        <div className="conversation-history-body"><nav aria-label="保留副本列表">
          {backups?.items.map(row => <article key={row.id} className={selected?.id === row.id ? 'selected' : ''}>
            <button className="conversation-history-main" aria-pressed={selected?.id === row.id} onClick={() => { setSelected(row); setBefore(0); setPreviewRevision(n => n + 1); }}><strong>{row.title}</strong><small>{date(row.capturedAt)} · {storageSize(row.backupBytes)}</small><HistoryBadge row={row} current />{!row.available && <small>副本缺失或不完整</small>}</button>
            <button className="icon-button" aria-label={'清理副本 ' + row.title} disabled={!!busy} onClick={() => cleanup(row)}><Trash2 size={14} /></button>
          </article>)}
          {backups && !backups.total && <div className="empty"><ShieldCheck size={30} /><p>暂无保留副本</p></div>}
          {!backups && <div className="empty"><Loader2 className="spin" /></div>}
          <footer className="conversation-pagination"><button className="icon-button" aria-label="上一页副本" disabled={!!busy || !offset} onClick={() => setOffset(n => Math.max(0, n - 40))}><ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /></button><span>{backups?.total || 0} 个副本</span><button className="icon-button" aria-label="下一页副本" disabled={!!busy || !backups || offset + 40 >= backups.total} onClick={() => setOffset(n => n + 40)}><ChevronRight size={14} /></button></footer>
        </nav><div className="conversation-history-preview">{selected ? <>
          <div className="conversation-history-source"><strong>{selected.title}</strong><p>{reasons[selected.currentStatus] || '原生会话仍在，可以使用当前记录继续。'}</p><small title={selected.file}>{selected.file}</small></div>
          <div className="conversation-message-pages"><button className="text-button" disabled={!preview?.hasEarlier} onClick={() => setBefore(n => n + 40)}>更早内容</button><span>{preview?.total || 0} 条消息</span><button className="text-button" disabled={!before} onClick={() => setBefore(n => Math.max(0, n - 40))}>较新内容</button></div>
          <div className="conversation-messages" aria-label="副本内容">{preview?.messages.map((m, i) => <article className={'conversation-message ' + m.role} key={before + ':' + i}><header>{m.role === 'user' ? '你' : '助手'}</header><ConversationMarkdown text={m.text} /></article>)}{selected.available && !preview && <Loader2 className="spin" />}</div>
          <footer><button className="button" disabled={!!busy || !selected.available || selected.nativeAvailable} onClick={() => act('conversations-backup-restore', selected.id)}><RotateCcw size={14} />恢复到当前客户端</button><button className="button primary" disabled={!!busy || !selected.available} onClick={() => act('conversations-resume', selected.id)}><Play size={14} />使用当前账户继续</button></footer>
        </> : <div className="empty">选择副本查看保存的内容</div>}</div></div>
      </> : <div className="conversation-history-trash"><p className="conversation-history-help">旧版留下的恢复备份，共 {storageSize(trash?.bytes)}。新的对话删除不再保存备份。仅清除 ASS 副本；Codex 的 thread_history_*.sqlite 正文数据库及远端副本不在清理范围内。</p>
        {trash?.items.map(row => <article key={row.id}><div><strong>{row.label}</strong><small>{row.count} 个对话 · {storageSize(row.bytes)} · {date(row.createdAt)}{row.phase === 'restored' ? ' · 已恢复' : row.phase === 'deleted' ? '' : ['restoring', 'restore-partial'].includes(row.phase) ? ' · 恢复未完成' : ' · 删除未完成'}</small></div><div className="actions"><button className="button" disabled={!!busy || ['restored', 'purging'].includes(row.phase)} onClick={() => act('project-conversations-restore', row.id)}><RotateCcw size={14} />恢复</button><button className="button danger" disabled={!!busy || !['deleted', 'restored', 'purging'].includes(row.phase)} onClick={() => setCleaning({ type: 'trash', title: row.label, count: row.count, bytes: row.bytes, input: { id: row.id, confirmed: true } })}>永久清理</button></div></article>)}
        {trash && !trash.items.length && <div className="empty">暂无已删除备份</div>}
      </div>}
      {cleaning && <div className="conversation-history-confirm" role="alertdialog" aria-label="永久清理历史确认"><strong>{cleaning.title}</strong><p>永久清理 {cleaning.count} 个{cleaning.type === 'backups' ? '保留副本' : '对话的恢复备份'}（{storageSize(cleaning.bytes)}），此操作不可恢复。</p><p>仅清除 ASS 保存的副本与恢复备份。Codex 的 thread_history_*.sqlite 正文存储可能仍保留内容；不会清除该存储或远端副本。</p><div className="actions"><button className="button" autoFocus onClick={() => setCleaning(null)}>取消</button><button className="button danger" disabled={!!busy} onClick={() => act(cleaning.type === 'backups' ? 'conversations-backup-cleanup' : 'project-conversations-trash-purge', cleaning.input)}>永久清理</button></div></div>}
      {error && <p className="error-box" role="alert">{error}</p>}{notice && <p className="conversation-history-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
