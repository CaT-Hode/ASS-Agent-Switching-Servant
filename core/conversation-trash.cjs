// Recoverable, identity-scoped native transcript deletion. Never delete project
// directories, credentials, or an entire SQLite database.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { safePath, atomic } = require('./native-fields.cjs');
const files = require('./conversation-files.cjs'), codecs = require('./project-codecs.cjs');
const { hash, pathKey, stamp } = codecs;
const identity = (r) => r.harness + '\0' + r.sessionId;
function indexFile(dir) {
  const names = fs.readdirSync(dir).filter((n) => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  return names[0] ? path.join(dir, names[0]) : '';
}
function codexRow(row) {
  const file = indexFile(row.dir); if (!file) return null; safePath(file);
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    const fields = db.prepare('PRAGMA table_info(threads)').all();
    if (!fields.some((r) => r.name === 'id')) return null;
    const value = db.prepare('SELECT * FROM threads WHERE id=?').get(row.sessionId); if (!value) return null;
    if (value.rollout_path && pathKey(value.rollout_path) !== pathKey(row.file) && !row.relatedFiles?.some((f) => pathKey(value.rollout_path) === pathKey(f))) throw Error('Codex 索引指向其他记录，请先刷新');
    // Keep FK-dependent rows in place; restore only this thread's parent row.
    // The transcript and desktop thread metadata disappear from the native list,
    // while unrelated runtime tables are not rewritten or cascade-deleted.
    if (Object.values(value).some((v) => typeof v === 'bigint' || v instanceof Uint8Array)) throw Error('Codex 索引包含未支持的字段，未删除');
    return { file, value, fields: fields.map((r) => r.name) };
  } finally { db.close(); }
}
function removeCodex(item, checkOnly = false) {
  if (!item) return;
  safePath(item.file); const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(item.file, { timeout: 1000 });
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    const current = db.prepare('SELECT * FROM threads WHERE id=?').get(item.value.id);
    if (current && JSON.stringify(current) !== JSON.stringify(item.value)) throw Error('Codex 会话索引已变化，未删除');
    if (current && !checkOnly) db.prepare('DELETE FROM threads WHERE id=?').run(item.value.id);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { db.close(); }
}
function restoreCodex(item, checkOnly = false) {
  if (!item) return; safePath(item.file);
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(item.file, { timeout: 1000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = db.prepare('SELECT * FROM threads WHERE id=?').get(item.value.id);
    if (current && JSON.stringify(current) !== JSON.stringify(item.value)) throw Error('Codex 已有同 ID 的会话，未覆盖');
    if (!current && !checkOnly) {
      const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name));
      const keys = item.fields.filter((k) => fields.has(k));
      if (keys.some((k) => !/^[a-zA-Z0-9_]+$/.test(k))) throw Error('索引字段无效');
      db.prepare(`INSERT INTO threads(${keys.map((k) => '"' + k + '"').join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => item.value[k]));
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { db.close(); }
}
function metadataFiles(row) {
  const names = row.harness === 'codex' ? [path.join(row.dir, 'session_index.jsonl')] : row.harness === 'claude' ? [path.join(path.dirname(row.file), 'sessions-index.json')] : [];
  return names.flatMap((file) => {
    safePath(file); if (!fs.existsSync(file)) return [];
    if (fs.statSync(file).size > 32 * 1024 ** 2) throw Error('客户端会话索引过大，未删除');
    const raw = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.jsonl')) {
      const entries = raw.split('\n').filter((l) => { try { return JSON.parse(l).id === row.sessionId; } catch { return false; } });
      return entries.length ? [{ file, format: 'jsonl', entries, sessionId: row.sessionId }] : [];
    }
    const value = JSON.parse(raw); if (!Array.isArray(value.entries)) return [];
    const entries = value.entries.filter((r) => r.sessionId === row.sessionId);
    return entries.length ? [{ file, format: 'json', entries, sessionId: row.sessionId }] : [];
  });
}
function updateMetadata(item, restore, checkOnly = false) {
  safePath(item.file); if (!fs.existsSync(item.file)) { if (!restore) return; throw Error('客户端索引文件已移走，请先恢复目录'); }
  const raw = fs.readFileSync(item.file, 'utf8');
  if (item.format === 'jsonl') {
    const current = raw.split('\n').filter((l) => { try { return JSON.parse(l).id === item.sessionId; } catch { return false; } });
    if (restore) {
      if (current.length && JSON.stringify(current) !== JSON.stringify(item.entries)) throw Error('同 ID 的会话名称已变化，未覆盖');
      if (!current.length && !checkOnly) atomic(item.file, raw + (raw.endsWith('\n') ? '' : '\n') + item.entries.join('\n') + '\n');
    } else {
      if (current.length && JSON.stringify(current) !== JSON.stringify(item.entries)) throw Error('客户端名称索引已变化，未删除');
      if (!checkOnly) atomic(item.file, raw.split('\n').filter((l) => !item.entries.includes(l)).join('\n'));
    }
  } else {
    const value = JSON.parse(raw), current = value.entries.filter((r) => r.sessionId === item.sessionId);
    if (restore && current.length && JSON.stringify(current) !== JSON.stringify(item.entries)) throw Error('同 ID 的会话已变化，未覆盖');
    if (!restore && current.length && JSON.stringify(current) !== JSON.stringify(item.entries)) throw Error('客户端名称索引已变化，未删除');
    value.entries = restore ? current.length ? value.entries : [...value.entries, ...item.entries] : value.entries.filter((r) => r.sessionId !== item.sessionId);
    if (!checkOnly) atomic(item.file, JSON.stringify(value));
  }
}
async function plan({ vault, secret, rows, sources, label, backup = true }) {
  const id = crypto.randomUUID(), directory = path.join(vault, 'trash', id); safePath(directory);
  if (backup) fs.mkdirSync(directory, { recursive: true });
  const result = { id, label, recoverable: backup, createdAt: new Date().toISOString(), phase: 'prepared', rows: [], files: [], indexes: [], metadata: [], imports: [], archiveLockRows: [] };
  const selected = new Map(rows.map((r) => [identity(r), r]));
  const found = codecs.discover(sources);
  // Never remove only one duplicate/older DSH generation, which would make the
  // deleted conversation reappear when the native reader falls back.
  for (const row of selected.values()) {
    const copies = found.rows.filter((r) => identity(r) === identity(row));
    if (!copies.length) throw Error('原生记录已变化或不存在，请刷新');
    if (row.harness === 'codex') result.archiveLockRows.push(...copies.map(r => ({ harness: r.harness, sessionId: r.sessionId, dir: r.dir, file: r.file, archived: r.archived, nativePresent: r.nativePresent })));
    result.rows.push({ harness: row.harness, sessionId: row.sessionId, title: row.title, cwd: row.cwd });
    if (row.harness === 'opencode') {
      const native = copies[0], bundle = codecs.openCodeBundle(native.file, native.sessionId);
      if (!backup) { result.imports.push({ ...native, signature: hash(JSON.stringify(bundle)) }); continue; }
      const raw = Buffer.from(JSON.stringify(bundle)), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), iv);
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      const backupName = hash(identity(native)) + '.opencode.enc';
      fs.writeFileSync(path.join(directory, backupName), Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { flag: 'wx', mode: 0o600 });
      result.imports.push({ ...native, signature: hash(JSON.stringify(bundle)), backup: backupName }); continue;
    }
    const candidates = new Set(copies.map((r) => r.file));
    if (row.harness === 'dsh') for (const copy of copies) for (const name of fs.readdirSync(path.dirname(copy.file)))
      if (/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name)) candidates.add(path.join(path.dirname(copy.file), name));
    for (const file of candidates) {
      const source = sources.find((s) => s.harness === row.harness && (files.inside(s.dir, file) || s.sessionDirs?.some((d) => files.inside(d, file))));
      if (!source) throw Error('原生会话位置不在已识别范围');
      safePath(file); const stat = fs.statSync(file); if (!stat.isFile()) throw Error('会话不是普通文件');
      const native = { ...row, file };
      let snapshot, digest;
      if (backup) snapshot = await files.preserve(native, directory, secret);
      else {
        const hasher = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hasher.update(chunk);
        digest = hasher.digest('hex');
      }
      if (stamp(fs.statSync(file)) !== stamp(stat)) throw Error('会话仍在写入，未删除');
      result.files.push({ file, harness: row.harness, sessionId: row.sessionId, signature: stamp(stat), ...(backup ? { snapshot } : { digest }) });
    }
    for (const copy of copies) {
      result.metadata.push(...metadataFiles(copy));
      if (row.harness === 'codex') { const index = codexRow({ ...copy, relatedFiles: [...candidates] });
        if (index && !result.indexes.some((r) => r.file === index.file && r.value.id === index.value.id)) result.indexes.push(index); }
    }
  }
  result.metadata = result.metadata.filter((m, i, all) => all.findIndex((x) => x.file === m.file && x.sessionId === m.sessionId) === i);
  return result;
}
function progressFile(vault, entry) {
  if (!vault) return null;
  if (!/^[a-f0-9-]{36}$/.test(entry.id)) throw Error('备份标识无效');
  const file = entry.recoverable === false ? path.join(vault, 'deletions', entry.id + '.json') : path.join(vault, 'trash', entry.id, 'progress.json'); safePath(file); return file;
}
function removedIdentities(entry) {
  return entry.rows.filter(row => {
    const related = entry.files.filter(f => f.harness === row.harness && f.sessionId === row.sessionId);
    if (related.length) return related.every(f => !fs.existsSync(f.file));
    const item = entry.imports.find(f => f.harness === row.harness && f.sessionId === row.sessionId);
    if (item) { try { codecs.openCodeBundle(item.file, item.sessionId); } catch (error) { return /会话不存在/.test(error.message); } }
    return false;
  }).map(identity);
}
function progress(vault, entry, phase, step) {
  const file = progressFile(vault, entry);
  if (file) atomic(file, JSON.stringify({ id: entry.id, phase, step, updatedAt: new Date().toISOString(),
    ...(entry.recoverable === false ? { removed: removedIdentities(entry) } : {}) }));
}
function status(vault, entry) {
  const file = progressFile(vault, entry);
  if (!file || !fs.existsSync(file)) return entry;
  if (fs.statSync(file).size > 32768) throw Error('删除恢复进度记录过大');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!['deleting', 'delete-partial', 'deleted', 'restoring', 'restore-partial', 'restored'].includes(saved.phase)) throw Error('删除恢复进度记录无效');
  return saved.id === entry.id ? { ...entry, phase: saved.phase, progress: saved.step,
    ...(entry.recoverable === false ? { removed: (saved.removed || []).filter(id => entry.rows.some(row => identity(row) === id)) } : {}) } : entry;
}
function failed(entry, vault) {
  progress(vault, entry, 'delete-partial', '删除未完成，请刷新后重试'); return status(vault, entry);
}
async function commit(entry, vault, options = {}) {
  if (options.liveCodex) {
    const rows = entry.archiveLockRows || [];
    return require('./codex-archive-delete.cjs').withLocks(rows, assertHeld => commit(entry, vault, { assertHeld, archived: true }));
  }
  const assertHeld = options.assertHeld || (() => {});
  const preserved = entry.recoverable === false ? '' : '；备份保留';
  assertHeld();
  for (const item of entry.files) {
    assertHeld();
    if (options.archived && entry.archiveLockRows.some(r => pathKey(r.file) === pathKey(item.file)) && !fs.existsSync(item.file)) throw Error('归档记录已移走或恢复，未删除；请刷新');
    safePath(item.file); if (!fs.existsSync(item.file)) continue;
    if (stamp(fs.statSync(item.file)) !== item.signature) throw Error('会话已变化，未删除' + preserved);
    const digest = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(item.file)) digest.update(chunk);
    if (digest.digest('hex') !== (item.snapshot?.digest || item.digest) || stamp(fs.statSync(item.file)) !== item.signature) throw Error('会话内容已变化，未删除' + preserved);
  }
  // Revalidate all native metadata before removing any transcript.
  assertHeld();
  if (options.archived) {
    for (const item of entry.indexes) if (![true, 1, '1'].includes(item.value.archived)) throw Error('目标不再是归档对话，未删除');
    // A paginated fork may reference this rollout. Do not leave that fork with
    // missing history; refuse deletion instead of expanding its deletion scope.
    require('./codex-archive-delete.cjs').assertUnreferenced(entry.archiveLockRows);
  }
  for (const item of entry.indexes) removeCodex(item, true);
  for (const item of entry.metadata) updateMetadata(item, false, true);
  progress(vault, entry, 'deleting', '开始删除索引');
  try {
    for (const item of entry.indexes) { assertHeld(); removeCodex(item); progress(vault, entry, 'deleting', '已处理会话索引'); }
    for (const item of entry.metadata) {
      assertHeld();
      // The shared Codex name index has independent writers (e.g. another
      // chat being renamed). Do not replace that whole file while Codex runs.
      // A stale name entry cannot resurrect a deleted thread/rollout; keep it
      // for restoration rather than risking unrelated names in this operation.
      if (!(options.archived && item.format === 'jsonl')) updateMetadata(item, false);
      progress(vault, entry, 'deleting', '已处理名称索引');
    }
    for (const item of entry.files) {
      assertHeld();
      safePath(item.file); if (!fs.existsSync(item.file)) continue;
      if (stamp(fs.statSync(item.file)) !== item.signature) throw Error('会话仍在变化，停止删除' + preserved);
      fs.unlinkSync(item.file);
      if (entry.recoverable === false) progress(vault, entry, 'deleting', '已删除本地记录');
    }
    progress(vault, entry, 'deleted', '删除完成');
    return { ...entry, phase: 'deleted', ...(entry.recoverable === false ? { removed: removedIdentities(entry) } : {}) };
  } catch (error) {
    progress(vault, entry, 'delete-partial', entry.recoverable === false ? '部分步骤完成，请刷新后重试' : '部分步骤完成，可重试删除或恢复');
    throw Error(entry.recoverable === false ? '删除未全部完成，已删除的部分无法恢复；请刷新后重试。' + error.message : '删除未全部完成，部分索引或记录可能已移除；备份保留，可重试或恢复。' + error.message);
  }
}
async function restore({ vault, secret, entry }) {
  if (entry.recoverable === false) throw Error('这次删除未保存备份，无法恢复');
  const directory = path.join(vault, 'trash', entry.id), staged = [];
  if (!/^[a-f0-9-]{36}$/.test(entry.id)) throw Error('备份标识无效');
  try {
    for (const item of entry.indexes) restoreCodex(item, true);
    for (const item of entry.metadata) updateMetadata(item, true, true);
    for (const item of entry.files) {
      safePath(item.file);
      if (fs.existsSync(item.file)) {
        const digest = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(item.file)) digest.update(chunk);
        if (digest.digest('hex') !== item.snapshot.digest) throw Error('已有同名记录，未覆盖');
        continue;
      }
      const encrypted = files.snapshotFile(directory, item.snapshot), header = Buffer.alloc(28), fd = fs.openSync(encrypted, 'r');
      try { if (fs.readSync(fd, header, 0, 28, 0) !== 28) throw Error('备份不完整'); } finally { fs.closeSync(fd); }
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), header.subarray(0, 12)); d.setAuthTag(header.subarray(12));
      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      const tmp = item.file + '.' + crypto.randomUUID() + '.restore.tmp'; staged.push({ tmp, target: item.file });
      await pipeline(fs.createReadStream(encrypted, { start: 28 }), d, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    }
    // Recheck after asynchronous decryption before publishing any transcript.
    for (const item of entry.indexes) restoreCodex(item, true);
    for (const item of entry.metadata) updateMetadata(item, true, true);
    progress(vault, entry, 'restoring', '开始恢复记录');
    for (const item of staged) { safePath(item.target); fs.linkSync(item.tmp, item.target); progress(vault, entry, 'restoring', '已恢复会话文件'); }
    for (const item of entry.indexes) restoreCodex(item);
    for (const item of entry.metadata) updateMetadata(item, true);
    progress(vault, entry, 'restored', '恢复完成');
    return { ...entry, phase: 'restored', restoredAt: new Date().toISOString() };
  } catch (error) {
    // Preflight errors produce no visible changes; publication failures retain
    // a durable status instead of claiming the native transcript is absent.
    const saved = status(vault, entry);
    if (saved.phase === 'restoring') { progress(vault, entry, 'restore-partial', '部分步骤完成，请重试恢复'); throw Error('恢复未全部完成，部分记录可能已恢复；备份保留，请重试。' + error.message); }
    throw error;
  } finally { for (const item of staged) if (fs.existsSync(item.tmp)) fs.unlinkSync(item.tmp); }
}
function importBundle(vault, secret, entry, item) {
  if (!/^[a-f0-9-]{36}$/.test(entry.id) || !/^[a-f0-9]{64}\.opencode\.enc$/.test(item.backup)) throw Error('OpenCode 备份标识无效');
  const file = path.join(vault, 'trash', entry.id, item.backup); safePath(file);
  const raw = fs.readFileSync(file); if (raw.length < 28) throw Error('OpenCode 备份不完整');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  if (hash(body) !== item.signature) throw Error('OpenCode 备份校验失败');
  return JSON.parse(body.toString('utf8'));
}
module.exports = { plan, commit, restore, importBundle, status, failed };
