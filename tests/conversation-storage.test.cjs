const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ConversationLibrary } = require('../core/conversations.cjs');
const { ProjectConversations } = require('../core/project-conversations.cjs');
const { historyStatus } = require('../core/conversation-status.cjs');
const { legacyDelete } = require('./helpers/legacy-conversation-trash.cjs');
const ID = '123e4567-e89b-42d3-a456-426614174000', ARCHIVE = '223e4567-e89b-42d3-a456-426614174000', RESIDUAL = '323e4567-e89b-42d3-a456-426614174000';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-storage-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^ass-storage-test-/); fs.rmSync(root, { recursive: true, force: true }); });
  const dirs = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  function transcript(harness, id = ID, folder = 'sessions', text = 'saved private text') {
    const rows = harness === 'codex' ? [{ type: 'session_meta', payload: { id, cwd, timestamp: '2026-09-30T00:00:00Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }]
      : [{ type: 'user', sessionId: id, cwd, message: { role: 'user', content: text } }];
    return write(path.join(dirs[harness], harness === 'claude' ? 'projects/project' : folder, id + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const file = transcript('codex'), cc = transcript('claude'), key = crypto.randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true,
    encryptString: s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([c.update(s), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
    decryptString: b => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(); } };
  const options = { dataDir: path.join(root, 'data'), crypto: encryption, sources: () => Object.entries(dirs).map(([harness, dir]) => ({ harness, dir })) };
  const library = new ConversationLibrary(options);
  return { root, dirs, cwd, file, cc, write, transcript, options, library };
}
test('backup management previews captured content, reports disk bytes, and scopes permanent cleanup to one client', async t => {
  const f = fixture(t); await f.library.preserve('codex'); await f.library.preserve('claude');
  const list = await f.library.backups({ harness: 'codex' }); assert.equal(list.total, 1); assert.equal(list.bytes, fs.statSync(f.file).size + 28);
  const id = list.items[0].id, ccBlob = f.library.entries.find(r => r.harness === 'claude').snapshot.blob;
  f.transcript('codex', ID, 'sessions', 'new native content');
  assert.equal((await f.library.backupPreview(id)).messages[0].text, 'saved private text');
  assert.equal((await f.library.preview(id)).messages[0].text, 'new native content');
  await assert.rejects(f.library.cleanupBackups({ harness: 'codex', revision: list.revision, confirmed: false }), /确认/);
  const removed = await f.library.cleanupBackups({ harness: 'codex', revision: list.revision, confirmed: true });
  assert.equal(removed.bytes, list.bytes); assert.equal(removed.count, 1); assert.equal((await f.library.backups({ harness: 'codex' })).total, 0);
  assert.ok(fs.existsSync(path.join(f.library.vault, 'records', ccBlob))); assert.match(fs.readFileSync(f.file, 'utf8'), /new native content/); assert.ok(fs.existsSync(f.cc));
  const again = new ConversationLibrary(f.options); assert.equal((await again.backups({ harness: 'claude' })).total, 1);
});
test('changed snapshot revisions, foreign IDs, and failed intent writes never remove ciphertext', async t => {
  const f = fixture(t); await f.library.preserve('codex'); const before = await f.library.backups({ harness: 'codex' });
  f.transcript('codex', ID, 'sessions', 'changed contents and length'); await f.library.preserve('codex');
  await assert.rejects(f.library.cleanupBackups({ harness: 'codex', revision: before.revision, confirmed: true }), /变化/);
  const now = await f.library.backups({ harness: 'codex' }), blob = f.library.entries.find(r => r.snapshot).snapshot.blob;
  await assert.rejects(f.library.cleanupBackups({ harness: 'claude', revision: f.library.backupRevision('claude'), ids: [now.items[0].id], confirmed: true }), /不属于/);
  const persist = f.library.persist; f.library.persist = () => { throw Error('disk full'); };
  await assert.rejects(f.library.cleanupBackups({ harness: 'codex', revision: now.revision, confirmed: true }), /disk full/); f.library.persist = persist;
  assert.ok(fs.existsSync(path.join(f.library.vault, 'records', blob)));
});
test('missing originals restore from the saved snapshot without overwriting an existing native conversation', async t => {
  const f = fixture(t); await f.library.preserve('codex'); const row = (await f.library.backups({ harness: 'codex' })).items[0];
  await assert.rejects(f.library.restoreBackup(row.id, f.dirs.codex), /仍在/);
  fs.unlinkSync(f.file); await f.library.refresh(true);
  const restored = await f.library.restoreBackup(row.id, f.dirs.codex); assert.equal(restored.copied, true);
  assert.match(fs.readFileSync(restored.file, 'utf8'), /saved private text/);
});
test('Codex archives and disk-only logs are classified separately, including stale session_index title entries', async t => {
  const f = fixture(t), archived = f.transcript('codex', ARCHIVE, 'archived_sessions'), orphan = f.transcript('codex', RESIDUAL);
  const db = new DatabaseSync(path.join(f.dirs.codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, name TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)'); insert.run(ID, 'active', f.cwd, f.file, 0); insert.run(ARCHIVE, 'archived', f.cwd, archived, 1); db.close();
  f.write(path.join(f.dirs.codex, 'session_index.jsonl'), JSON.stringify({ id: RESIDUAL, thread_name: 'deleted title remains' }) + '\n');
  await f.library.refresh(true); const rows = f.library.entries.filter(r => r.harness === 'codex');
  assert.equal(historyStatus(rows.find(r => r.sessionId === ID)), 'active'); assert.equal(historyStatus(rows.find(r => r.sessionId === ARCHIVE)), 'archived');
  assert.equal(historyStatus(rows.find(r => r.sessionId === RESIDUAL)), 'residual'); assert.ok(fs.existsSync(orphan));
  await f.library.preserve('codex'); assert.equal((await f.library.backups({ harness: 'codex' })).total, 1);
  const projects = new ProjectConversations(f.options), active = await projects.list();
  assert.equal(active.items[0].counts.codex, 1); assert.equal(active.inactive.codex, 2);
  const inactive = await projects.list({ scope: 'inactive' }); assert.equal(inactive.items[0].counts.codex, 2);
  assert.deepEqual(new Set((await projects.records(inactive.items[0].id, { harness: 'codex' })).items.map(r => r.historyStatus)), new Set(['archived', 'residual']));
});
test('an unreadable SQLite index does not classify normal logs as deleted', async t => {
  const f = fixture(t); f.write(path.join(f.dirs.codex, 'state_5.sqlite'), 'not a sqlite database'); await f.library.refresh(true);
  const row = f.library.entries.find(r => r.harness === 'codex'); assert.equal(row.nativeIndexState, 'unavailable'); assert.equal(historyStatus(row), 'active');
});
test('a moved archived original is recognized beside its older retained path', async t => {
  const f = fixture(t); await f.library.preserve('codex'); const before = (await f.library.backups({ harness: 'codex' })).items[0];
  const target = path.join(f.dirs.codex, 'archived_sessions', ID + '.jsonl'); fs.mkdirSync(path.dirname(target)); fs.renameSync(f.file, target);
  const after = (await f.library.backups({ harness: 'codex' })).items[0]; assert.equal(after.nativeAvailable, true); assert.equal(after.currentStatus, 'archived');
  assert.equal(f.library.resumeRow(before.id).file, target);
});
test('permanent trash cleanup frees only its backup and keeps deleted retained copies out after restart', async t => {
  const f = fixture(t); await f.library.preserve('codex'); await f.library.refresh(true);
  const projects = new ProjectConversations({ ...f.options, history: async () => { await f.library.refresh(true); return f.library.entries.filter(r => r.snapshot).map(r => f.library.publicRow(r)); } });
  const list = await projects.list(), project = list.items[0], row = (await projects.records(project.id, { harness: 'codex' })).items[0];
  const deleted = await legacyDelete(projects, { projectId: project.id, recordId: row.id, confirmed: true });
  const bytes = projects.trashList().items[0].bytes; assert.ok(bytes > 28);
  await assert.rejects(projects.purgeTrash({ id: deleted.id, confirmed: false }), /确认/);
  const purged = await projects.purgeTrash({ id: deleted.id, confirmed: true }); assert.equal(purged.bytes, bytes);
  const again = new ProjectConversations({ ...f.options, history: projects.history });
  assert.equal((await again.list({ scope: 'all' })).items[0].counts.codex || 0, 0); assert.equal(again.trashList().items.length, 0); assert.ok(fs.existsSync(f.cc));
});
