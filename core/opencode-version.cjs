// Versioned OpenCode contract. Discovery is read-only; credential activation
// is delegated to the public CLI. ASS never writes OpenCode's SQLite tables.
const fs = require('node:fs'), path = require('node:path');
const { safePath } = require('./native-fields.cjs');
function database(file, fn) {
  safePath(file);
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  try { db.exec('BEGIN'); return fn(db); } finally { db.close(); }
}
function hasTable(db, name) { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function version(launcher, dir) {
  if (/^[12]\./.test(launcher?.version || '')) return Number(launcher.version[0]);
  if (launcher?.version) throw Error('OpenCode CLI 版本未支持');
  const entry = launcher?.entryPoint || launcher?.executable;
  if (entry) for (const relative of ['.', '..', '../..']) {
    try { const p = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), relative, 'package.json'), 'utf8'));
      if (p.name === '@opencode/cli' && /^2\./.test(p.version)) return 2;
      if (p.name === 'opencode-ai' && /^1\./.test(p.version)) return 1;
    } catch {}
  }
  const file = dir && path.join(dir, 'opencode.db');
  if (file && fs.existsSync(file)) return database(file, db => {
    const v1 = ['session', 'message', 'part'].every(t => hasTable(db, t)), v2 = ['session_v2', 'session_message'].every(t => hasTable(db, t));
    if (v1 !== v2) return v2 ? 2 : 1;
    throw Error('OpenCode 数据库版本无法唯一识别，请配置已知版本 CLI');
  });
  if (!launcher?.ready) return 1; // Empty uninstalled home has no active native CLI.
  throw Error('OpenCode CLI 版本无法确认，请配置带版本信息的安装目录');
}
function credentials(dir) {
  const file = path.join(dir, 'opencode.db');
  if (!fs.existsSync(file)) return null;
  return database(file, db => {
    if (!hasTable(db, 'credential')) return null;
    const columns = new Set(db.prepare('PRAGMA table_info(credential)').all().map(r => r.name));
    if (!['id', 'integration_id', 'label', 'value', 'active'].every(k => columns.has(k)))
      throw Error('OpenCode credential 数据库版本未支持，未读取旧 auth.json 作为替代');
    const rows = db.prepare('SELECT id,integration_id,label,value,active FROM credential LIMIT 10001').all();
    if (rows.length > 10000) throw Error('OpenCode 账户数量超过读取范围');
    return rows.map(r => ({ id: r.id, integrationID: r.integration_id, label: r.label,
      active: !!r.active, value: JSON.parse(r.value) }));
  });
}
function selected(account) {
  const rows = credentials(account.nativeDir || path.dirname(account.sourcePath));
  const row = rows?.find(r => r.id === account.credentialId && r.integrationID === account.provider);
  if (!row) throw Error('OpenCode 原生账户已变化，请刷新后选择');
  return row;
}
function command(major, action, argument) {
  if (!['import', 'export', 'delete'].includes(action)) throw Error('无效的 OpenCode 会话操作');
  return major === 2 ? ['session', action, argument, '--standalone']
    : ['import', 'export'].includes(action) ? [action, argument] : ['session', action, argument];
}
function encode({ id, cwd, title, messages, createdAt, model = '' }) {
  const time = Date.parse(createdAt), zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const target = model ? require('./opencode-resume-model.cjs').modelRef(model) : { providerID: 'ASS-history', modelID: 'unassigned' };
  const ref = { id: target.modelID, providerID: target.providerID };
  const rows = messages.map((m, i) => {
    const when = Date.parse(m.timestamp || createdAt), base = { id: 'msg_' + id.slice(4) + '_' + i.toString(16).padStart(8, '0'), time: { created: when } };
    return m.role === 'user' ? { ...base, type: 'user', text: m.text, files: [], agents: [], skills: [] }
      : { ...base, type: 'assistant', agent: 'build', model: ref, content: [{ type: 'text', text: m.text }],
        finish: 'stop', cost: 0, tokens: zero, time: { created: when, streamed: when, completed: when } };
  });
  if (rows.length) rows.push({ type: 'idle', id: 'msg_' + id.slice(4) + '_idle', time: { created: rows.at(-1).time.created }, outcome: 'succeeded' });
  return { info: { id, projectID: 'global', title, location: { directory: cwd }, cost: 0, tokens: zero,
    time: { created: time, updated: time }, agent: 'build', model: ref }, messages: rows };
}
function bundle(db, id) {
  const r = db.prepare('SELECT * FROM session_v2 WHERE id=?').get(id); if (!r) throw Error('OpenCode 会话不存在');
  const messages = db.prepare('SELECT * FROM session_message WHERE session_id=? ORDER BY seq').all(id)
    .map(m => ({ ...JSON.parse(m.data), id: m.id, type: m.type }));
  return { info: { id, projectID: r.project_id, title: r.title, location: { directory: r.directory },
    cost: r.cost, tokens: { input: r.tokens_input, output: r.tokens_output, reasoning: r.tokens_reasoning,
      cache: { read: r.tokens_cache_read, write: r.tokens_cache_write } },
    ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
    ...(r.permission ? { permissions: JSON.parse(r.permission) } : {}),
    ...(r.revert ? { revert: JSON.parse(r.revert) } : {}),
    ...(r.fork_session_id && r.fork_boundary ? { fork: { sessionID: r.fork_session_id, boundary: JSON.parse(r.fork_boundary) } } : {}),
    ...(r.parent_id ? { parentID: r.parent_id } : {}), ...(r.agent ? { agent: r.agent } : {}),
    ...(r.model ? { model: JSON.parse(r.model) } : {}), time: { created: r.time_created, updated: r.time_updated } }, messages };
}
function cwd(bundle) { return bundle?.info?.location?.directory ?? bundle?.info?.directory; }
function semantic(bundle) {
  const copy = structuredClone(bundle);
  if (!copy?.info?.id || typeof cwd(copy) !== 'string' || !Array.isArray(copy.messages)) throw Error('OpenCode 会话身份无效');
  const { pathKey } = require('./conversation-paths.cjs');
  if (copy.info.location) copy.info.location.directory = pathKey(copy.info.location.directory);
  else copy.info.directory = pathKey(copy.info.directory);
  for (const message of copy.messages) if (message.info?.path) {
    for (const field of ['cwd', 'root']) if (message.info.path[field]) message.info.path[field] = pathKey(message.info.path[field]);
  }
  if (copy.info.time) delete copy.info.time.updated;
  // The importer resolves projectID from location.directory. Directory remains
  // part of the comparison; generated project IDs are import metadata.
  delete copy.info.projectID;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  return JSON.stringify(canonical(copy));
}
function equal(a, b) { return semantic(a) === semantic(b); }
module.exports = { cwd, semantic, equal, version, credentials, selected, command, encode, bundle, database, hasTable };
