// Native formats are adapters, not a shared executable log. Only completed
// records are imported; tools become historical context, never replayed calls.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { safePath } = require('./native-fields.cjs');
const HARNESSES = ['codex', 'claude', 'dsh', 'opencode', 'pi'];
const DSH_TRANSCRIPT_REVISION = 2;
const TRANSCRIPT_REVISIONS = { dsh: DSH_TRANSCRIPT_REVISION, claude: 2, pi: 2 };
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
const { displayPath, pathKey } = require('./conversation-paths.cjs');
const libraryFiles = require('./conversation-files.cjs');
const NO_PROJECT = 'unassigned';
function projectPath(cwd, sources = []) {
  if (!cwd || !path.isAbsolute(cwd)) return '';
  const k = pathKey(cwd), home = pathKey(require('node:os').homedir());
  if (k === home || k === pathKey(path.parse(cwd).root) || sources.some((s) => k === pathKey(s.dir))) return '';
  // Codex creates working directories for projectless desktop chats too.
  // A cwd is not automatically a user-selected project in those locations.
  if (/[/\\]Documents[/\\]Codex[/\\]\d{4}-\d{2}-\d{2}[/\\][^/\\]+$/i.test(cwd) ||
      k === pathKey(require('node:os').tmpdir())) return '';
  return cwd;
}
const stamp = (s) => `${s.size}:${s.mtimeMs}:${s.ino}`;
const slug = (cwd) => '--' + cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--';
const dshSlug = (cwd) => '--' + (cwd.replace(/[/\\:]+/g, '-').split('').map((c) => /^[A-Za-z0-9._-]$/.test(c) ? c : '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('').replace(/^-+/, '') || 'root').slice(0, 251) + '--';
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const lines = require('./conversation-reader.cjs').lines;
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (typeof b.text === 'string') return b.text;
    if (b.type === 'thinking') return `[历史思考]\n${b.thinking || ''}`;
    if (b.type === 'tool_use' || b.type === 'toolCall' || b.type === 'tool-call') return `[历史工具调用 · ${b.name || b.toolName || ''}]\n${JSON.stringify(b.input ?? b.arguments ?? {})}`;
    if (b.type === 'tool_result' || b.type === 'tool-result') return `[历史工具结果]\n${blockText(b.content) || (typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? {}))}`;
    if (b.type === 'text-chunks' && Array.isArray(b.texts)) return b.texts.join('');
    if (['image', 'input_image', 'file'].includes(b.type)) return `[附件保留在来源记录中 · ${b.name || b.filename || b.type}]`;
    return '';
  }).filter(Boolean).join('\n');
}
function dshText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (['text', 'input_text', 'output_text'].includes(b?.type)) return typeof b.text === 'string' ? b.text : '';
    if (b?.type === 'text-chunks' && Array.isArray(b.texts)) return b.texts.filter((text) => typeof text === 'string').join('');
    return '';
  }).filter(Boolean).join('\n');
}
function message(role, content, timestamp, nativeId) {
  const text = blockText(content);
  if (!text) return null;
  return { role: role === 'user' ? 'user' : 'assistant', text, timestamp: typeof timestamp === 'string' ? timestamp : new Date(Number(timestamp) || 0).toISOString(), nativeId: String(nativeId || '') };
}
function dshMessage(role, data, timestamp) {
  if (!data || (data.role !== undefined && data.role !== role)) return null;
  // A DSH user/message is model-visible input, including agent.inject() context.
  // Its source identifies human input; event type alone does not. Missing
  // source/role fields remain compatible with older minimal text records.
  const kind = data.source?.kind;
  if (kind !== undefined && kind !== (role === 'user' ? 'user' : 'model')) return null;
  return message(role, dshText(data.content), timestamp, data.id);
}
function decode(harness, rows, { completed = true } = {}) {
  const syncOmissions = require('./sync-omissions.cjs').omissions(harness, rows);
  let header = {}, messages = [], model = '', title = '', pending = false, contextKey = '';
  if (harness === 'codex') {
    header = rows.find((r) => r.type === 'session_meta')?.payload || {};
    const life = rows.filter(r => r.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(r.payload?.type));
    pending = ['task_started', 'turn_aborted'].includes(life.at(-1)?.payload.type);
    // Lifecycle-aware logs share only the committed prefix. Legacy logs without
    // lifecycle markers retain their existing compatibility behavior.
    if (completed && life.length) {
      const committed = rows.filter(r => r.type === 'session_meta'); let turn = [];
      for (const row of rows) {
        const event = row.type === 'event_msg' ? row.payload?.type : '';
        if (event === 'task_started') turn = [row];
        else if (event === 'turn_aborted') turn = [];
        else if (event === 'task_complete') { committed.push(...turn, row); turn = []; }
        else if (row.type !== 'session_meta') turn.push(row);
      }
      rows = committed;
    }
    for (const r of rows) {
      if (r.type === 'response_item') {
        const p = r.payload || {};
        if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) messages.push(message(p.role, p.content, r.timestamp, p.id));
        else if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(p.type)) messages.push(message('assistant', `[历史${p.type.includes('output') ? '工具结果' : '工具调用'}]\n${p.name || ''}\n${p.arguments || p.output || p.input || ''}`, r.timestamp, p.call_id));
      }
      if (r.type === 'turn_context') model = r.payload?.model || model;
    }
    if (!messages.length) for (const r of rows) if (r.type === 'event_msg' && ['user_message', 'agent_message'].includes(r.payload?.type))
      messages.push(message(r.payload.type === 'user_message' ? 'user' : 'assistant', r.payload.message, r.timestamp));
  } else if (harness === 'claude') {
    let useful = rows.filter((r) => !r.isSidechain && ['user', 'assistant'].includes(r.type));
    const lastAssistant = useful.filter((r) => r.type === 'assistant').at(-1);
    if (lastAssistant && (lastAssistant.message?.stop_reason === 'tool_use' || (lastAssistant.message?.content || []).some?.((b) => b.type === 'tool_use'))) {
      pending = true; if (completed) useful = useful.slice(0, Math.max(0, useful.findLastIndex((r) => r.type === 'assistant' && ['end_turn', 'stop_sequence', 'max_tokens'].includes(r.message?.stop_reason)) + 1));
    }
    // CC can parent a message to an attachment/progress record. Follow the
    // entire UUID chain, but carry only user/assistant messages into context.
    const byId = new Map(rows.filter((r) => r.uuid && !r.isSidechain).map((r) => [r.uuid, r]));
    let active = useful;
    if (useful.at(-1)?.uuid && useful.some((r) => r.parentUuid)) {
      active = []; let node = useful.at(-1); const seen = new Set();
      while (node && !seen.has(node.uuid)) { if (['user', 'assistant'].includes(node.type)) active.unshift(node); seen.add(node.uuid); node = byId.get(node.parentUuid); }
    }
    header = { id: useful[0]?.sessionId, cwd: useful.find((r) => r.cwd)?.cwd, timestamp: useful[0]?.timestamp };
    const grouped = new Map(); let userAnchor = '';
    for (const r of active) {
      const id = r.message?.id || r.uuid || String(grouped.size);
      if (r.type === 'user') userAnchor = r.uuid || id;
      // Stream fragments may share an assistant message ID, but a provider
      // reusing that ID in a later turn must not replace an earlier answer.
      // Separate block indices are separate native content, while snapshots of
      // the same block replace only that block (at its original ordered slot).
      const block = Number.isInteger(r.apiBlockIndex) && r.apiBlockIndex >= 0 ? ':block:' + r.apiBlockIndex : ':snapshot';
      const key = r.type === 'assistant' ? 'assistant:' + userAnchor + ':' + id + block : 'user:' + (r.uuid || id);
      const m = message(r.type, r.message?.content, r.timestamp, r.type === 'assistant' ? id + block : id);
      if (m) grouped.set(key, m); model = r.message?.model || model;
    }
    messages = [...grouped.values()]; title = rows.filter((r) => r.type === 'custom-title').at(-1)?.customTitle || '';
  } else if (harness === 'pi') {
    header = rows.find((r) => r.type === 'session') || {};
    if (Number(header.version || 1) > 3) throw Error('pi 会话版本尚未支持，未改写');
    // Normalize legacy linear files in memory only. Native pi owns migration.
    if (Number(header.version || 1) === 1) {
      let parentId = null;
      rows = rows.map((r, i) => { if (r.type === 'session') return r; const id = 'legacy-' + i; const v = { ...r, id, parentId }; parentId = id; return v; });
    }
    const byId = new Map(rows.filter((r) => r.id && r.type !== 'session').map((r) => [r.id, r]));
    let active = []; const seen = new Set(); let node = rows.filter((r) => r.type !== 'session').at(-1);
    while (node && !seen.has(node.id)) { active.unshift(node); seen.add(node.id); node = byId.get(node.parentId); }
    const last = active.findLastIndex((r) => r.type === 'message' && r.message?.role === 'assistant' &&
      !['toolUse', 'aborted', 'error'].includes(r.message.stopReason) && !(r.message.content || []).some?.((b) => b.type === 'toolCall'));
    const tail = active.slice(last + 1).filter((r) => r.type === 'message' && ['user', 'assistant', 'toolResult'].includes(r.message?.role));
    pending = tail.length > 0;
    if (completed && pending) active = active.slice(0, last + 1);
    for (const r of active) {
      if (r.type === 'model_change') model = r.modelId;
      else if (r.type === 'message' && r.message?.role === 'assistant') model = r.message.model || model;
    }
    const projected = require('./pi-active-context.cjs').projectContext(active);
    contextKey = hash(JSON.stringify(projected.modifiers));
    for (const r of projected.rows) {
      if (r.type === 'message') {
        const m = r.message || {};
        if (!['user', 'assistant', 'toolResult'].includes(m.role)) continue; // Never transport prompt/tool permissions.
        if (m.role === 'assistant' && ['aborted', 'error'].includes(m.stopReason)) continue;
        messages.push(message(m.role, m.role === 'toolResult' ? `[历史工具结果 · ${m.toolName || ''}]\n${blockText(m.content)}` : m.content, r.timestamp || m.timestamp, r.id));
      } else if (r.type === 'compaction' || r.type === 'branch_summary') messages.push(message('assistant', '[历史压缩摘要]\n' + (r.summary || ''), r.timestamp, r.id));
    }
    title = rows.filter((r) => r.type === 'session_info').at(-1)?.name || '';
  } else if (harness === 'dsh') {
    header = rows[0] || {};
    if (header.type !== 'session' || ![0, 1, 2, 3, 4].includes(header.version)) throw Error('DSH 会话版本尚未支持，未改写');
    title = rows.filter((r) => r.type === 'session/title').at(-1)?.data?.title || '';
    // DSH commits at turn/end. An unfinished suffix must never become a shared turn.
    const lastEnd = rows.findLastIndex((r) => r.type === 'turn/end');
    pending = rows.slice(lastEnd + 1).some((r) => r.type === 'turn/start');
    const surface = [];
    for (const r of rows.slice(1, completed ? lastEnd + 1 : undefined)) {
      if (r.surfaceOp && typeof r.surfaceOp === 'object' && r.surfaceOp.op === 'replace') {
        const start = r.surfaceOp.startSeq ?? r.surfaceOp.start, end = r.surfaceOp.endSeq ?? r.surfaceOp.end;
        for (let i = surface.length - 1; i >= 0; i--) if (surface[i].seq >= start && surface[i].seq <= end) surface.splice(i, 1);
      }
      surface.push(r);
    }
    for (const r of surface) {
      if (r.type === 'user/message') messages.push(dshMessage('user', r.data, r.time));
      else if (r.type === 'assistant/message') messages.push(dshMessage('assistant', r.data?.message, r.time));
      if (r.type === 'request/header') model = r.data?.header?.config?.model || model;
    }
  }
  const filtered = messages.filter(Boolean);
  // Only stable, answered prefixes cross a harness boundary. Tool/context notes
  // following that answer stay with it; a trailing user turn remains local.
  if (filtered.at(-1)?.role === 'user') pending = true;
  if (completed) while (filtered.at(-1)?.role === 'user') filtered.pop();
  // Display the origin in the native client without polluting canonical content.
  const syncPrefix = /^\[来自 (Codex|CC|DSH|OpenCode|pi) 的同步\]\n/;
  if (filtered[0]?.role === 'user') filtered[0].text = filtered[0].text.replace(syncPrefix, '');
  return { sessionId: String(header.id || ''), cwd: header.cwd || '', createdAt: header.timestamp || new Date(Number(header.createdAt) || 0).toISOString(),
    title: title || header.title || filtered.find((m) => m.role === 'user' && !/^\s*(?:# AGENTS\.md|<environment_context>|<INSTRUCTIONS>|<local-command|<command-)/i.test(m.text))?.text.split('\n')[0].slice(0, 160) || '未命名对话', model, messages: filtered, pending,
    sidechain: header.origin === 'subagent' || !!header.source?.subagent || Number(header.delegationDepth) > 0,
    ...(TRANSCRIPT_REVISIONS[harness] ? { transcriptRevision: TRANSCRIPT_REVISIONS[harness] } : {}),
    ...(harness === 'pi' ? { contextKey } : {}), syncOmissions };
}
function database(file, fn) {
  safePath(file); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  try { db.exec('BEGIN'); return fn(db); } finally { db.close(); }
}
function openCodeBundle(file, id) {
  return database(file, (db) => {
    if (require('./opencode-version.cjs').hasTable(db, 'session_v2')) return require('./opencode-version.cjs').bundle(db, id);
    const r = db.prepare('SELECT * FROM session WHERE id = ?').get(id); if (!r) throw Error('OpenCode 会话不存在');
    const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY id').all(id).map((m) => ({
      info: { ...JSON.parse(m.data), id: m.id, sessionID: id },
      parts: db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created, id').all(m.id).map((p) => ({ ...JSON.parse(p.data), id: p.id, sessionID: id, messageID: m.id })),
    }));
    return { info: { id, title: r.title, directory: r.directory, version: r.version, projectID: r.project_id, slug: r.slug,
      time: { created: r.time_created, updated: r.time_updated } }, messages };
  });
}
function decodeOpenCode(bundle) {
  if (bundle.info.location) {
    const rows = bundle.messages, ready = rows.filter(m => m.type === 'user' || m.type === 'assistant' && Number.isFinite(m.time?.completed) && !m.error);
    const messages = ready.map(m => message(m.type, m.type === 'user' ? m.text : m.content, m.time?.created, m.id)).filter(Boolean);
    const pending = rows.at(-1)?.type !== 'idle' && rows.length > 0;
    while (messages.at(-1)?.role === 'user') messages.pop();
    if (messages[0]?.role === 'user') messages[0].text = messages[0].text.replace(/^\[来自 (Codex|CC|DSH|OpenCode|pi) 的同步\]\n/, '');
    return { sessionId: bundle.info.id, cwd: bundle.info.location.directory, title: bundle.info.title,
      createdAt: new Date(bundle.info.time.created).toISOString(), model: ready.at(-1)?.model?.id || '',
      messages, pending, sidechain: !!bundle.info.parentID, nativeVersion: 2 };
  }
  const messages = [], ready = bundle.messages.filter((m) => m.info.role === 'user' || (Number.isFinite(m.info.time?.completed) && !m.info.error));
  for (const m of ready) {
    const content = m.parts.map((p) => p.type === 'tool' ? { type: 'text', text: `[历史工具 · ${p.tool || ''}]\n${JSON.stringify(p.state?.input || {})}\n${p.state?.output || p.state?.error || ''}` } : p);
    messages.push(message(m.info.role, content, m.info.time?.created, m.info.id));
  }
  const filtered = messages.filter(Boolean); while (filtered.at(-1)?.role === 'user') filtered.pop();
  if (filtered[0]?.role === 'user') filtered[0].text = filtered[0].text.replace(/^\[来自 (Codex|CC|DSH|OpenCode|pi) 的同步\]\n/, '');
  return { sessionId: bundle.info.id, cwd: bundle.info.directory, title: bundle.info.title, createdAt: new Date(bundle.info.time.created).toISOString(),
    model: ready.at(-1)?.info.modelID || ready.at(-1)?.info.model?.modelID || '', messages: filtered,
    pending: bundle.messages.length !== ready.length || messages.length !== filtered.length, sidechain: !!bundle.info.parentID };
}
function walk(dir, output, depth = 0) {
  if (depth > 8 || output.length > 20000) throw Error('项目记录超过扫描范围'); safePath(dir);
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const e of entries) {
    if (e.isSymbolicLink() || ['subagents', 'node_modules', 'memory'].includes(e.name)) continue;
    const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, output, depth + 1);
    else if (e.isFile() && /\.jsonl(?:\.zstd)?$/.test(e.name)) output.push(f);
  }
}
function discover(sources, { cwd, includeMessages = false, cache = {}, processed = {} } = {}) {
  const rows = [], errors = [], seen = new Set();
  for (const source of sources) {
    if (!HARNESSES.includes(source.harness) || !path.isAbsolute(source.dir)) continue;
    try {
      if (source.harness === 'opencode') {
        const file = path.join(source.dir, 'opencode.db'); if (!fs.existsSync(file)) continue;
        const sessions = database(file, (db) => db.prepare(`SELECT id,title,directory,time_created,time_updated,parent_id FROM ${require('./opencode-version.cjs').hasTable(db, 'session_v2') ? 'session_v2' : 'session'} ORDER BY time_updated DESC LIMIT 20000`).all());
        for (const s of sessions) {
          if (s.parent_id || !s.directory || (cwd && pathKey(cwd) !== pathKey(s.directory))) continue;
          const id = hash('opencode\0' + pathKey(file) + '\0' + s.id); if (seen.has(id)) continue; seen.add(id);
          const meta = { id, harness: 'opencode', file, dir: source.dir, sessionId: s.id, cwd: s.directory, title: s.title,
            updatedAt: new Date(s.time_updated).toISOString(), createdAt: new Date(s.time_created).toISOString(), signature: String(s.time_updated), nativePresent: true,
          };
          rows.push({ ...meta, ...(includeMessages && processed['opencode\0' + s.id] !== meta.signature ? decodeOpenCode(openCodeBundle(file, s.id)) : {}) }); cache[id] = meta;
        }
        continue;
      }
      if (['codex', 'claude'].includes(source.harness)) {
        const found = libraryFiles.scan([source]); errors.push(...found.errors);
        for (const meta of found.entries.filter((r) => r.nativePresent)) {
          const effective = meta.projectless ? '' : meta.cwd;
          if (cwd && pathKey(cwd) !== pathKey(effective || '.')) continue;
          if (seen.has(meta.id)) continue; seen.add(meta.id);
          let row = meta;
          if (includeMessages && processed[source.harness + '\0' + meta.sessionId] !== meta.signature) {
            try {
              const decoded = decode(source.harness, lines(meta.file, source.harness));
              row = { ...decoded, ...meta, messages: decoded.messages, pending: decoded.pending };
              if (stamp(fs.statSync(meta.file)) !== meta.signature) delete row.messages;
            } catch (e) { errors.push({ harness: source.harness, file: meta.file, message: e.message }); }
          }
          cache[meta.id] = meta; rows.push(row);
        }
        continue;
      }
      const files = [];
      for (const name of source.harness === 'codex' ? ['sessions', 'archived_sessions'] : source.harness === 'claude' ? ['projects'] : ['sessions']) walk(path.join(source.dir, name), files);
      for (const dir of source.sessionDirs || []) if (path.isAbsolute(dir)) walk(dir, files);
      const highest = new Map();
      for (const f of files) {
        if (source.harness === 'dsh') { const v = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(path.basename(f)); if (!v) continue;
          const old = highest.get(path.dirname(f)); if (!old || Number(v[1] || 0) > old.version) highest.set(path.dirname(f), { file: f, version: Number(v[1] || 0) }); }
      }
      for (const file of source.harness === 'dsh' ? [...highest.values()].map((r) => r.file) : files) {
        const id = hash(source.harness + '\0' + pathKey(file)); if (seen.has(id)) continue; seen.add(id);
        try {
          const stat = fs.statSync(file), sig = stamp(stat), old = cache[id];
          const cached = old?.signature === sig && (!TRANSCRIPT_REVISIONS[source.harness] || old.transcriptRevision === TRANSCRIPT_REVISIONS[source.harness]);
          if (cached && cwd && pathKey(cwd) !== pathKey(old.cwd)) continue;
          if (cached && (!includeMessages || processed[source.harness + '\0' + old.sessionId] === sig)) {
            if (!cwd || pathKey(cwd) === pathKey(old.cwd)) rows.push(old); continue;
          }
          // Off-project JSONL files need only their first header, not a full body scan.
          if (cwd && ['codex', 'pi'].includes(source.harness)) {
            const fd = fs.openSync(file, 'r'); let first;
            try { const head = Buffer.alloc(65536); const n = fs.readSync(fd, head, 0, head.length, 0); first = JSON.parse(head.subarray(0, n).toString().split('\n')[0]); }
            finally { fs.closeSync(fd); }
            const dir = source.harness === 'codex' ? first.payload?.cwd : first.cwd;
            if (dir && pathKey(dir) !== pathKey(cwd)) continue;
          }
          const data = decode(source.harness, lines(file)); if (!data.sessionId || data.sidechain || (cwd && pathKey(cwd) !== pathKey(data.cwd || '.'))) continue;
          const { messages, ...meta } = data;
          const row = { ...meta, id, harness: source.harness, file, dir: source.dir, signature: sig, size: stat.size, nativePresent: true,
            ...(source.harness === 'dsh' ? { transcriptRevision: DSH_TRANSCRIPT_REVISION } : {}),
            relative: path.relative(source.dir, file), updatedAt: new Date(stat.mtimeMs).toISOString() };
          const stable = stamp(fs.statSync(file)) === sig;
          if (stable) cache[id] = row;
          rows.push({ ...row, ...(includeMessages && stable ? { messages } : {}) });
        } catch (e) { errors.push({ harness: source.harness, file, message: e.message || '记录未完成、版本未知或无法读取，未改写来源' }); }
      }
    } catch { errors.push({ harness: source.harness, dir: source.dir, message: '会话目录暂时无法读取' }); }
  }
  return { rows, errors };
}
function readConversation(row, options) {
  const value = row.harness === 'opencode' ? decodeOpenCode(openCodeBundle(row.file, row.sessionId)) : decode(row.harness, lines(row.file, row.harness), options);
  if (row.harness === 'codex') {
    const dir = row.dir || row.file.split(/[\\/]sessions[\\/]|[\\/]archived_sessions[\\/]/)[0];
    const index = libraryFiles.codexIndex(dir).get(value.sessionId);
    if (index) Object.assign(value, { cwd: displayPath(index.cwd || value.cwd), title: index.title || value.title, projectless: index.projectless });
  }
  return value;
}
function encode(harness, { id, cwd, title, messages, createdAt = new Date().toISOString(), model = '', nativeVersion = 1 }) {
  if (harness === 'opencode' && nativeVersion === 2) return { bytes: Buffer.from(JSON.stringify(require('./opencode-version.cjs').encode({ id, cwd, title, messages, createdAt, model }))), suffix: '.json' };
  const rows = [], emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  if (harness === 'codex') {
    rows.push({ timestamp: createdAt, type: 'session_meta', payload: { id, cwd, timestamp: createdAt, originator: 'ASS', cli_version: '0.158.0', source: 'cli', model_provider: 'openai' } });
    for (const m of messages) rows.push({ timestamp: m.timestamp || createdAt, type: 'response_item', payload: { type: 'message', role: m.role,
      ...(m.role === 'assistant' ? { phase: 'final_answer' } : {}), content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }] } });
  } else if (harness === 'claude') {
    let parent = null;
    for (const m of messages) {
      const uuid = crypto.randomUUID(); rows.push({ type: m.role, sessionId: id, uuid, parentUuid: parent, cwd, timestamp: m.timestamp || createdAt,
        isSidechain: false, userType: 'external', version: '2.1.283', message: m.role === 'user' ? { role: 'user', content: m.text }
          : { id: 'msg_' + uuid.replaceAll('-', ''), type: 'message', role: 'assistant', model: model || 'claude-sonnet-4-6', content: [{ type: 'text', text: m.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }); parent = uuid;
    }
    rows.push({ type: 'custom-title', sessionId: id, customTitle: title });
  } else if (harness === 'pi') {
    rows.push({ type: 'session', version: 3, id, cwd, timestamp: createdAt }); let parentId = null;
    for (const m of messages) {
      const entryId = crypto.randomBytes(8).toString('hex'); rows.push({ type: 'message', id: entryId, parentId, timestamp: m.timestamp || createdAt,
        message: { role: m.role, content: [{ type: 'text', text: m.text }], timestamp: Date.parse(m.timestamp || createdAt),
          ...(m.role === 'assistant' ? { api: 'openai-responses', provider: 'openai', model: model || 'gpt-5', usage: emptyUsage, stopReason: 'stop' } : {}) } }); parentId = entryId;
    }
    rows.push({ type: 'session_info', id: crypto.randomBytes(8).toString('hex'), parentId, timestamp: createdAt, name: title });
  } else if (harness === 'dsh') {
    rows.push({ type: 'session', version: 3, id, cwd, createdAt: Date.parse(createdAt), isSeeded: false, delegationDepth: 0 });
    let seq = 0, turn = 0, step = 0, openTurn = false, openStep = false;
    const event = (type, data) => rows.push({ type, seq: seq++, time: Date.parse(createdAt), data, ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) });
    for (const m of messages) {
      if (m.role === 'user' && openTurn && !openStep) { event('turn/end', { turn, reason: { kind: 'completed' } }); openTurn = false; }
      if (!openTurn) { step = 0; event('turn/start', { turn: ++turn }); openTurn = true; }
      if (!openStep) { event('step/start', { turn, step: ++step }); openStep = true; }
      const msg = { id: crypto.randomUUID(), role: m.role, content: [{ type: 'text', text: m.text }], source: m.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'ASS-history', model: 'history' } };
      event(m.role === 'user' ? 'user/message' : 'assistant/message', m.role === 'user' ? msg : { turn, step, message: msg, stream: [] });
      if (m.role === 'assistant') { event('step/end', { turn, step }); openStep = false; }
    }
    if (openStep) event('step/end', { turn, step });
    if (openTurn) event('turn/end', { turn, reason: { kind: 'completed' } });
    // Native DSH reads frame zero as exactly one header line. Event framing is
    // independent of the JSONL contents and must not change turn/step ordering.
    const frames = [zlib.zstdCompressSync(Buffer.from(jsonl(rows.slice(0, 1))))];
    if (rows.length > 1) frames.push(zlib.zstdCompressSync(Buffer.from(jsonl(rows.slice(1)))));
    return { bytes: Buffer.concat(frames), suffix: '.jsonl.zstd' };
  } else if (harness === 'opencode') {
    const target = model ? require('./opencode-resume-model.cjs').modelRef(model) : { providerID: 'ASS-history', modelID: 'unassigned' };
    const time = Date.parse(createdAt), info = { id, slug: id, projectID: 'global', directory: cwd, title, version: '1.0.0', time: { created: time, updated: time } };
    let parentID = '';
    const bundle = messages.map((m, i) => {
      // OpenCode traverses IDs lexicographically. Hash-only IDs scramble the
      // imported context even when its timestamps are correct.
      const mid = 'msg_' + i.toString(16).padStart(16, '0') + hash(id + ':message:' + i).slice(0, 10), when = Date.parse(m.timestamp || createdAt);
      const mi = { id: mid, sessionID: id, role: m.role, time: { created: when },
        ...(m.role === 'user' ? { agent: 'build', model: { ...target } }
          : { parentID, ...target, mode: 'build', agent: 'build', path: { cwd, root: cwd }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop', time: { created: when, completed: when } }) };
      if (m.role === 'user') parentID = mid;
      return { info: mi, parts: [{ id: 'prt_' + hash(id + ':part:' + i).slice(0, 26), sessionID: id, messageID: mid, type: 'text', text: m.text }] };
    });
    return { bytes: Buffer.from(JSON.stringify({ info, messages: bundle })), suffix: '.json' };
  } else throw Error('不支持的客户端');
  return { bytes: Buffer.from(jsonl(rows)), suffix: '.jsonl' };
}
module.exports = { HARNESSES, TRANSCRIPT_REVISIONS, NO_PROJECT, projectPath, hash, pathKey, stamp, slug, dshSlug, jsonl, lines, decode, discover, readConversation, encode, openCodeBundle, decodeOpenCode };
