const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { eligible, withLocks, lockGroups, assertUnreferenced } = require('../core/codex-archive-delete.cjs');
const { assertDeletionIdle } = require('../core/conversation-delete-guard.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-archive-lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { harness: 'codex', dir, file: path.join(dir, 'archived_sessions', 'record.jsonl'),
    sessionId: '123e4567-e89b-42d3-a456-426614174000', archived: true, nativePresent: true };
}
test('archive eligibility is explicit and never relaxes restoration or active/foreign paths', t => {
  const row = fixture(t); assert.equal(eligible(row), true);
  for (const change of [{ harness: 'claude' }, { archived: false }, { nativePresent: false }, { sessionId: '../escape' },
    { file: path.join(row.dir, 'sessions', 'record.jsonl') }, { file: path.join(row.dir, '..', 'archived_sessions', 'record.jsonl') }])
    assert.equal(eligible({ ...row, ...change }), false);
  assert.throws(() => lockGroups([{ ...row, archived: false }]), /原生 Codex 归档/);
});
test('running archive exception requires a checked backend version and is delete-only', { skip: process.platform !== 'win32' }, async t => {
  const row = fixture(t), run = async () => [{ running: ['codex'], codexExecutables: ['backend'] }];
  await assert.rejects(assertDeletionIdle([row], run), /先关闭/);
  let checked = false;
  const options = { allowArchivedCodex: true, assertSupported: async paths => { assert.deepEqual(paths, ['backend']); checked = true; } };
  assert.deepEqual(await assertDeletionIdle([row], run, options), { liveCodex: true }); assert.ok(checked);
  await assert.rejects(assertDeletionIdle([{ ...row, archived: false }], run, options), /先关闭/);
  await assert.rejects(assertDeletionIdle([row], run, { allowArchivedCodex: true }), /后端路径/);
  await assert.rejects(assertDeletionIdle([row, { harness: 'claude' }], async () => ({ running: ['codex', 'claude'], codexExecutables: ['backend'] }), options), /先关闭 Claude/);
});
test('OS locks are released after action failure; stale files do not block later deletion', { skip: process.platform !== 'win32' }, async t => {
  const row = fixture(t); let calls = 0;
  await assert.rejects(withLocks([row], async assertHeld => { assertHeld(); calls++; throw Error('fixture fail'); }), /fixture fail/);
  const lockfile = path.join(row.dir, 'thread-writer-locks', row.sessionId + '.lock');
  assert.ok(fs.existsSync(lockfile));
  await withLocks([row], async assertHeld => { assertHeld(); calls++; }); assert.equal(calls, 2);
});
test('reference check includes hidden subagents and fails closed on compressed histories', t => {
  const row = fixture(t), dir = path.join(row.dir, 'sessions', 'subagents'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-child.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: '123e4567-e89b-42d3-a456-426614174001', history_base: { thread_id: row.sessionId } } }) + '\n');
  assert.throws(() => assertUnreferenced([row]), /仍引用/);
  fs.unlinkSync(file); fs.writeFileSync(file + '.zst', 'compressed fixture');
  assert.throws(() => assertUnreferenced([row]), /压缩历史/);
});
