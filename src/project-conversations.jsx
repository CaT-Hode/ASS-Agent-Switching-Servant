import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Search, Loader2, MessagesSquare, Play, RefreshCw, ShieldCheck, ChevronRight, RotateCcw, Pin, Monitor, Trash2, X } from './icons.jsx';
import { useConversationColumns } from './conversation-columns.jsx';
import { detectedClients } from './usage-view.mjs';
import { ConversationMarkdown } from './conversation-markdown.mjs';
import { ConversationHistory, HistoryBadge, HistorySource } from './conversation-history.jsx';
const api = window.ass, labels = { codex: 'Codex', claude: 'Claude Code', dsh: 'DSH', opencode: 'OpenCode', pi: 'pi' };
const brands = { codex: 'openai', claude: 'anthropic', dsh: 'deepseek', opencode: 'opencode', pi: 'pi' };
const originLabels = { ...labels, claude: 'CC' };
const time = (s) => s ? new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const errorText = (e) => e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
const Transcript = memo(function Transcript({ value }) {
  return <div className="conversation-messages" aria-label="对话内容">{value?.messages.map((m, i) => <article className={'conversation-message ' + m.role} key={value.before + ':' + i}>
    <header><span>{m.role === 'user' ? '你' : '助手'}</span><time>{time(m.timestamp)}</time></header>
    {m.text.length > 3000 && /AGENTS|environment_context|INSTRUCTIONS/.test(m.text)
      ? <details><summary>会话上下文</summary><ConversationMarkdown text={m.text} /></details> : <ConversationMarkdown text={m.text} />}
  </article>)}{!value && <Loader2 className="spin" />}</div>;
});
export function ProjectConversations({ state, initialHarness, onClient, onNotify }) {
  const [list, setList] = useState(null), [query, setQuery] = useState(''), [project, setProject] = useState(null);
  const [threads, setThreads] = useState(null), [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [before, setBefore] = useState(0);
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [offset, setOffset] = useState(0), [search, setSearch] = useState(null), [pinned, setPinned] = useState(false);
  const available = detectedClients(state).filter((c) => Object.hasOwn(labels, c.id));
  const [view, setView] = useState(initialHarness || state.preferences.conversations?.harness || 'codex'), [target, setTarget] = useState(initialHarness || 'codex'), [confirm, setConfirm] = useState('');
  const [nativeView, setNativeView] = useState(false);
  const [deleting, setDeleting] = useState(null), [trash, setTrash] = useState(null);
  const [scope, setScope] = useState('active'), [historyOpen, setHistoryOpen] = useState(false);
  const previewSelection = useRef(''), trashGeneration = useRef(0);
  useEffect(() => () => { trashGeneration.current++; }, []);
  function closeTrash() { trashGeneration.current++; setTrash(null); }
  async function openTrash() {
    const generation = ++trashGeneration.current;
    try { const value = await api.call('project-conversations-trash'); if (generation === trashGeneration.current) setTrash(value); }
    catch (e) { if (generation === trashGeneration.current) setError(errorText(e)); }
  }
  const columns = useConversationColumns(state.preferences.conversations?.columns, (value) => api.call('ui-preferences', { conversations: { columns: value } }).catch((e) => setError(errorText(e))));
  useEffect(() => {
    if (!deleting) return;
    const close = (e) => { if (e.key === 'Escape' || (e.type === 'pointerdown' && !e.target.closest('.conversation-delete-confirm, [data-delete-opener]'))) setDeleting(null); };
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, [deleting]);
  useEffect(() => { if (available.length && !available.some((c) => c.id === view)) setView(available[0].id); }, [available.map((c) => c.id).join(','), view]);
  useEffect(() => {
    let current = true;
    api.call('project-conversations-list', { scope }).then((r) => {
      if (!current) return; setList(r); setError(r.error || '');
      setProject((old) => r.items.find((p) => p.id === old?.id) || r.items.find((p) => p.id === state.preferences.conversations?.project) || r.items[0] || null);
    }).catch((e) => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [revision, scope]);
  const shared = scope === 'active' && project?.enabled && project.targets.includes(view) && !nativeView;
  const searchTerm = query.trim();
  const searchReady = search?.query === searchTerm && search?.harness === view && search?.nativeView === (nativeView || scope === 'inactive');
  const matches = useMemo(() => new Map(search?.items.map((p) => [p.id, p]) || []), [search]);
  const threadQuery = searchTerm && searchReady && !matches.get(project?.id)?.projectMatch ? searchTerm : '';
  useEffect(() => {
    let current = true; setSearch(null);
    if (!searchTerm || !list) return;
    const timer = setTimeout(() => api.call('project-conversations-search', { query: searchTerm, harness: view, nativeView: nativeView || scope === 'inactive' })
      .then((r) => { if (current) setSearch(r); }).catch((e) => { if (current) setError(errorText(e)); }), 180);
    return () => { current = false; clearTimeout(timer); };
  }, [searchTerm, view, nativeView, list, scope]);
  useEffect(() => {
    let current = true; setThreads(null); setConfirm('');
    const timer = setTimeout(() => { if (project && list) api.call(shared ? 'project-conversations-threads' : 'project-conversations-records', project.id,
      { offset, query: threadQuery, harness: view, pinned, cached: !!searchTerm }).then((r) => {
      if (current) { setThreads(r); setSelected((old) => r.items.find((t) => t.id === old?.id) || r.items[0] || null); }
    }).catch((e) => { if (current) setError(errorText(e)); }); }, 0);
    return () => { current = false; clearTimeout(timer); };
  }, [project?.id, shared, view, list, offset, threadQuery, pinned, !!searchTerm]);
  useEffect(() => {
    let current = true; setPreview(null); setConfirm('');
    const selection = JSON.stringify([selected?.id, selected?.kind]);
    if (selection !== previewSelection.current && before) { setBefore(0); return; }
    previewSelection.current = selection;
    if (selected) api.call(selected.kind === 'native' ? 'project-conversations-native-preview' : 'project-conversations-preview',
      ...(selected.kind === 'native' ? [selected.id, before] : [project.id, selected.id, before])).then((r) => { if (current) setPreview(r); })
      .catch((e) => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [selected?.id, selected?.kind, before, revision]);
  useEffect(() => {
    if (!confirm) return;
    const opener = document.activeElement, focus = requestAnimationFrame(() => document.querySelector('.conversation-resume-confirm button')?.focus());
    const close = (e) => { if (e.key === 'Escape' || (e.type === 'pointerdown' && !e.target.closest('.conversation-resume-control, .project-toggle-control'))) setConfirm(''); };
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', close);
    return () => { cancelAnimationFrame(focus); document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); if (opener?.isConnected) opener.focus(); };
  }, [confirm]);
  const items = useMemo(() => list?.items.filter((p) => (p.harnesses?.includes(view) || (p.enabled && p.targets.includes(view))) && (!searchTerm || !searchReady || matches.has(p.id))) || [], [list, view, searchTerm, searchReady, matches]);
  useEffect(() => { if (list && !items.some((p) => p.id === project?.id)) {
    setProject(items[0] || null); setOffset(0); setBefore(0);
  } }, [items, list, project?.id]);
  async function action(name, ...args) {
    const generation = trashGeneration.current;
    setBusy(name); setError(''); setNotice(''); setConfirm('');
    const destructive = ['project-conversations-delete', 'project-conversations-restore'].includes(name);
    try { const r = await api.call(name, ...args); const message = r?.message || (name === 'conversations-preserve' ? '已保留 ' + r.retained + ' 个对话' : '');
      if (destructive && onNotify) onNotify(message); else setNotice(message);
      if (name === 'project-conversations-restore' && trash && generation === trashGeneration.current) {
        const value = await api.call('project-conversations-trash');
        if (generation === trashGeneration.current) setTrash(value);
      }
      if (!name.includes('resume') && name !== 'conversations-open-desktop') setRevision((n) => n + 1);
    } catch (e) { if (destructive && onNotify) onNotify(errorText(e), true); else setError(errorText(e)); } finally { setBusy(''); }
  }
  function choose(p) { setProject(p); setSelected(null); setOffset(0); setBefore(0); setNotice(''); setError('');
    api.call('ui-preferences', { conversations: { project: p.id, scope: 'projects' } }).catch((e) => setError(errorText(e))); }
  const targets = project?.targets || available.map((c) => c.id);
  useEffect(() => { setTarget(view); }, [view]);
  function toggleTarget(h) { const next = targets.includes(h) ? targets.filter((v) => v !== h) : [...targets, h];
    if (!next.length) { setError('至少选择一个客户端'); return; }
    action('project-conversations-configure', project.id, { enabled: project.enabled, targets: next }); }
  const native = selected?.kind === 'native', resumeHarness = native ? selected.harness : target;
  const client = state.harnesses.clients.find((c) => c.id === resumeHarness), account = client?.accounts.find((a) => a.oauthCurrent) || client?.accounts.find((a) => a.id === client.selected);
  function deletePrompt(e, p, t) {
    const rect = e.currentTarget.getBoundingClientRect();
    setDeleting({ projectId: p.id, recordId: t?.id, title: t?.title || p.name, left: Math.max(16, Math.min(rect.right - 290, window.innerWidth - 306)), top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 180)) });
  }
  return <section ref={columns.root} className="project-conversation-page" aria-label="对话管理">
    <div className="project-sync-toolbar"><div className="conversation-tabs" aria-label="会话客户端">{available.map((c) => <button key={c.id} aria-pressed={view === c.id} onClick={() => {
      setView(c.id); setOffset(0); setBefore(0); if (!shared) setSelected(null); setNativeView(false);
      api.call('ui-preferences', { conversations: { harness: c.id } }).catch((e) => setError(errorText(e)));
    }}><img src={'./providers/' + brands[c.id] + '.svg'} alt="" />{labels[c.id]}</button>)}</div>
      <div className="conversation-scope" aria-label="对话范围">{[['active', '当前对话'], ['inactive', '归档及残留']].map(([id, label]) => <button key={id} aria-pressed={scope === id} onClick={() => { setScope(id); setOffset(0); setBefore(0); setSelected(null); }}>{label}{id === 'inactive' && !!list?.inactive?.[view] && <small>{list.inactive[view]}</small>}</button>)}</div>
      <span className="conversation-count">{list ? items.reduce((n, p) => n + (p.enabled ? p.count : p.counts?.[view] || 0), 0) + ' 个对话' : '读取记录…'}</span>
      <div className="actions"><button className="button" disabled={!!busy} onClick={() => setHistoryOpen(true)}><ShieldCheck size={15} />历史与存储</button>
        <button className="icon-button" aria-label="已删除记录" onClick={openTrash}><Trash2 size={17} /></button>
        <button className="icon-button" aria-label="刷新项目记录" disabled={!!busy} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={17} /></button></div></div>
    {error && <p className="error-box" role="alert">{error}</p>}{notice && <p className="client-notice" role="status">{notice}</p>}
    <div className="conversation-layout project-sync-layout">
      <section className="conversation-list" aria-label="项目记录列表"><div className="conversation-search"><Search size={15} /><input type="search" aria-label="搜索项目或对话" placeholder="搜索项目或对话" maxLength={500} value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); setBefore(0); }} /></div>
        <div className="conversation-rows">{items.slice(0, 200).map((p) => <article data-project-id={p.id} className={'conversation-row' + (p.id === project?.id ? ' selected' : '')} key={p.id}>
          <button className="conversation-row-main" aria-pressed={p.id === project?.id} onClick={() => choose(p)}><span className="conversation-row-title">{p.nonProject ? <MessagesSquare size={14} /> : <Folder size={14} />}{p.name}</span>
            <span className="conversation-row-meta">{p.cwd && <span className="conversation-row-project" title={p.cwd}>{p.cwd}</span>}<span className="conversation-row-count">{p.enabled ? p.count : p.counts?.[view] || 0} 个对话</span>{p.enabled && <span className="conversation-retained">同步中</span>}</span></button>
          <div className="conversation-row-actions"><button className="icon-button conversation-delete" data-delete-opener aria-label={'删除项目对话 ' + p.name} disabled={!!busy || p.enabled} title={p.enabled ? '关闭同步后删除原生记录' : '删除项目的本地对话，不保存备份'} onClick={(e) => deletePrompt(e, p)}><Trash2 size={14} /></button></div></article>)}
          {list && !items.length && <div className="empty"><Folder size={30} /><p>暂无项目记录</p></div>}{!list && <div className="empty"><Loader2 className="spin" /></div>}</div>
        <footer className="conversation-pagination">{items.length} 个分组</footer></section>
      <div {...columns.separator('projects')} />
      <section className="conversation-detail" aria-label="项目会话">{project ? <>
        <header className="conversation-detail-heading"><div className="conversation-project-path" title={project.cwd || project.name}>{project.cwd || project.name}</div>
          {!project.nonProject && scope === 'active' && <div className="actions"><button className="icon-button" aria-label="同步当前项目" disabled={!project.enabled || !!busy} onClick={() => action('project-conversations-sync', project.id)}><RefreshCw size={17} className={busy ? 'spin' : ''} /></button>
            <div className="project-toggle-control">{confirm === 'disable' && <div className="conversation-resume-confirm" role="dialog" aria-label="关闭项目同步确认"><p>完成内容归回初始客户端，移除同步副本。请先结束续聊。</p><div className="actions"><button className="button" onClick={() => setConfirm('')}>取消</button><button className="button primary" onClick={() => action('project-conversations-configure', project.id, { enabled: false, targets })}>确定</button></div></div>}
              <button className="project-sync-switch" role="switch" aria-label="项目同步" aria-checked={project.enabled} disabled={!!busy}
                onClick={() => project.enabled ? setConfirm('disable') : action('project-conversations-configure', project.id, { enabled: true, targets })}><span className="project-switch-track"><i /></span>项目同步</button></div></div>}
        </header>
        {project.enabled && <div className="project-record-tabs"><button aria-pressed={!nativeView} onClick={() => { setNativeView(false); setOffset(0); }}>共享记录</button><button aria-pressed={nativeView} onClick={() => { setNativeView(true); setOffset(0); }}>原生记录</button><small>{time(project.lastSync)}</small></div>}
        {project.enabled && <details className="project-target-options"><summary>同步客户端</summary><div className="project-sync-targets" aria-label="参与同步的客户端">{available.map(({ id: h }) => <button key={h} aria-label={'参与同步 ' + labels[h]} aria-pressed={targets.includes(h)} disabled={!!busy} onClick={() => toggleTarget(h)}>{labels[h]}</button>)}</div></details>}
        <div className="project-shared-body"><nav className="project-shared-threads" aria-label="项目对话列表"><div className="project-thread-toolbar"><span>{threads?.total || 0} 个对话</span>
          {!shared && <div className="conversation-pin-control"><button className="icon-button conversation-pin-filter" aria-label="只看置顶" aria-describedby="conversation-pin-description" aria-pressed={pinned} title={pinned ? '显示全部对话' : '只显示当前项目的置顶对话'} onClick={() => { setPinned(!pinned); setOffset(0); }}><Pin size={14} /></button><span id="conversation-pin-description" role="tooltip">{pinned ? '显示全部对话' : '只看置顶对话'}</span></div>}</div>
          {threads?.items.map((t) => <article data-record-id={t.id} key={t.id} className={'project-thread-row' + (t.id === selected?.id ? ' selected' : '')}><button className="project-thread-main" aria-pressed={t.id === selected?.id} onClick={() => { setSelected(t); setBefore(0); }}>
            <strong>{t.title}</strong><small>{t.branchOf ? '分支 · ' : ''}{t.kind === 'native' ? labels[t.harness] : t.harnesses.map((h) => labels[h]).join(' / ')} · {time(t.updatedAt)}</small>
            {(t.syncedFrom || (!t.kind && t.originHarness !== view)) && <span className="conversation-sync-origin">来自 {originLabels[t.syncedFrom || t.originHarness]} 的同步</span>}<HistoryBadge row={t} /></button>
            <div className="conversation-row-actions">{t.libraryId && <button className={'icon-button conversation-pin' + (t.pinned ? ' pinned' : '')} aria-label={t.pinned ? '取消置顶对话' : '置顶对话'} title={t.pinned ? '取消置顶' : '置顶此对话'} disabled={!!busy} onClick={() => action('conversations-pin', t.libraryId, !t.pinned)}><Pin size={14} /></button>}
            <button className="icon-button conversation-delete" data-delete-opener aria-label={t.retained && !t.nativePresent ? '管理保留副本 ' + t.title : '删除对话 ' + t.title} title={t.retained && !t.nativePresent ? '在历史与存储中查看或清理副本' : project.enabled ? '关闭同步后删除原生记录' : '删除本地对话，不保存备份'} disabled={!!busy || project.enabled} onClick={(e) => t.retained && !t.nativePresent ? setHistoryOpen(true) : deletePrompt(e, project, t)}><Trash2 size={14} /></button></div></article>)}
          {!threads && <Loader2 className="spin" />}{threads && !threads.items.length && <p>暂无对话</p>}
          <div className="project-thread-pages"><button className="icon-button" aria-label="上一页对话" disabled={!offset || !threads} onClick={() => setOffset((n) => Math.max(0, n - 40))}><ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /></button><small>{threads?.total || 0} 个对话</small><button className="icon-button" aria-label="下一页对话" disabled={!threads || offset + 40 >= threads.total} onClick={() => setOffset((n) => n + 40)}><ChevronRight size={14} /></button></div></nav>
          <div {...columns.separator('threads')} />
          <div className="project-shared-preview">{selected ? <>
            <div className="conversation-transcript">{native && <HistorySource row={selected} />}<div className="conversation-message-pages"><button className="text-button" disabled={!preview?.hasEarlier} onClick={() => setBefore((n) => n + 40)}><RotateCcw size={13} />更早内容</button>
              <span>{preview?.total || 0} 条消息</span>{before > 0 && <button className="text-button" onClick={() => setBefore((n) => Math.max(0, n - 40))}>较新内容<ChevronRight size={13} /></button>}</div><Transcript value={preview} /></div>
            <footer className="project-resume">{native ? <button className="conversation-current-account" onClick={() => onClient?.(resumeHarness)}><span>当前账户<strong>{account?.profile?.fields?.find((f) => f.id === 'email')?.value || account?.label || labels[resumeHarness]}</strong></span></button>
              : <span className="conversation-retained">共享项目记录</span>}
              <div className="conversation-resume-control">{native && selected.libraryId && selected.harness === 'codex' && client?.desktop && <button className="icon-button" aria-label="在 Codex 桌面打开对话" disabled={!!busy} onClick={() => action('conversations-open-desktop', selected.libraryId)}><Monitor size={17} /></button>}
                {confirm === 'resume' && <div className="conversation-resume-confirm" role="dialog" aria-label={native ? '继续对话确认' : '跨客户端续聊确认'}><p>在 {labels[resumeHarness]} 继续？请先结束原窗口中的同一对话。</p><div className="actions"><button className="button" onClick={() => setConfirm('')}>取消</button><button className="button primary" onClick={() => native ? action('project-conversations-native-resume', selected.id) : action('project-conversations-resume', project.id, selected.id, target)}>确定</button></div></div>}
                <button className="button primary" disabled={!!busy || !preview} aria-haspopup="dialog" onClick={() => setConfirm('resume')}><Play size={15} />{busy ? '处理中…' : native ? selected.nativePresent ? '继续对话' : '从副本继续' : '在 ' + labels[target] + ' 继续'}</button></div></footer>
            {resumeHarness === 'dsh' && <p className="conversation-resume-note">打开后在 DSH 会话列表选择此记录。{native ? selected.sessionId : ''}</p>}
          </> : <div className="empty"><MessagesSquare size={30} /><p>选择一段对话</p></div>}</div></div>
      </> : <div className="empty"><Folder size={30} /><p>选择项目</p></div>}</section>
    </div>
    {deleting && createPortal(<div className="conversation-delete-confirm" role="dialog" aria-label="删除本地记录确认" style={{ left: deleting.left, top: deleting.top }}>
      <strong>{deleting.title}</strong><p>{deleting.recordId ? '删除本地对话，不保存备份，无法撤销。' : '删除该项目所有客户端的本地对话，不保存备份，无法撤销。'}项目文件不受影响。</p>
      <div className="actions"><button className="button" autoFocus onClick={() => setDeleting(null)}>取消</button><button className="button danger" disabled={!!busy} onClick={() => { const input = { projectId: deleting.projectId, recordId: deleting.recordId, confirmed: true }; setDeleting(null); action('project-conversations-delete', input); }}>删除</button></div>
    </div>, document.body)}
    {trash && <div className="conversation-trash-backdrop" onClick={closeTrash}><section className="conversation-trash-panel" role="dialog" aria-modal="true" aria-label="已删除记录" onClick={(e) => e.stopPropagation()}>
      <header><h2>已删除记录</h2><button className="icon-button" aria-label="关闭已删除记录" onClick={closeTrash}><X size={18} /></button></header>
      {trash.items.map((r) => <article key={r.id}><div><strong>{r.label}</strong><small>{r.count} 个对话 · {time(r.createdAt)}{r.phase !== 'deleted' && (['restoring', 'restore-partial'].includes(r.phase) ? ' · 恢复未完成' : ' · 删除未完成')}</small></div><button className="button" disabled={!!busy} onClick={() => action('project-conversations-restore', r.id)}><RotateCcw size={14} />恢复</button></article>)}
      {!trash.items.length && <div className="empty">暂无已删除记录</div>}
      {error && <p className="error-box" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section></div>}
    {historyOpen && <ConversationHistory initialHarness={view} onClose={() => setHistoryOpen(false)} onChange={() => setRevision(n => n + 1)} />}
  </section>;
}
