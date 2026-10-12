const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const codecs = require('../core/project-codecs.cjs');
const { ProjectConversations } = require('../core/project-conversations.cjs');
const { HarnessManager } = require('../core/harnesses.cjs');
const { currentModel } = require('../core/opencode-resume-model.cjs');
const id = '123e4567-e89b-42d3-a456-426614174000', timestamp = '2026-10-09T02:00:00Z';
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
function fixture(t, harness = 'pi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-sync-fidelity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const sources = codecs.HARNESSES.map(harness => ({ harness, dir: path.join(root, harness) }));
  sources.forEach(s => fs.mkdirSync(s.dir));
  const dirs = Object.fromEntries(sources.map(s => [s.harness, s.dir]));
  const file = path.join(dirs[harness], harness === 'claude' ? 'projects' : 'sessions', 'fixture', id + '.jsonl');
  const options = { dataDir: path.join(root, 'ass'), crypto: encryption, sources: () => sources };
  return { root, cwd, sources, dirs, file, options, library: new ProjectConversations(options) };
}
function piRows(cwd) {
  const rows = [{ type: 'session', version: 3, id, cwd, timestamp }]; let parentId = null;
  const add = (type, fields) => { const row = { type, id: 'e' + rows.length, parentId, timestamp, ...fields }; rows.push(row); parentId = row.id; return row.id; };
  const msg = (role, text) => add('message', { message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { model: 'fixture', stopReason: 'stop' } : {}) } });
  return { rows, add, msg };
}
async function enable(f) { const p = (await f.library.list()).items.find(p => p.cwd === f.cwd); assert.ok(p); await f.library.configure(p.id, { enabled: true }); return p.id; }
const texts = rows => codecs.decode('pi', rows).messages.map(m => m.text);

test('Claude keeps separate API blocks, replaces snapshots of the same block, and retains later reused IDs', () => {
  const row = (uuid, parentUuid, type, text, index, turn = 'shared-provider-id') => ({ uuid, parentUuid, type, sessionId: id, cwd: process.cwd(), timestamp,
    ...(index === undefined ? {} : { apiBlockIndex: index }), message: { id: turn, role: type, content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  const rows = [row('u1', null, 'user', 'first'), row('a0', 'u1', 'assistant', 'partial', 0), row('a1', 'a0', 'assistant', 'BLOCK_ZERO 中文', 0),
    row('a2', 'a1', 'assistant', 'BLOCK_ONE', 1), row('u2', 'a2', 'user', 'second'), row('a3', 'u2', 'assistant', 'LATER_TURN', 0)];
  const decoded = codecs.decode('claude', rows);
  assert.deepEqual(decoded.messages.map(m => m.text), ['first', 'BLOCK_ZERO 中文', 'BLOCK_ONE', 'second', 'LATER_TURN']);
  for (const harness of codecs.HARNESSES) {
    const projection = codecs.encode(harness, { id: harness === 'opencode' ? 'ses_fixture' : id, cwd: process.cwd(), messages: decoded.messages });
    const read = harness === 'opencode' ? codecs.decodeOpenCode(JSON.parse(projection.bytes)) : codecs.decode(harness,
      harness === 'dsh' ? Buffer.concat([...require('../core/conversation-reader.cjs').frames(projection.bytes)].map(frame => require('node:zlib').zstdDecompressSync(frame))).toString().trim().split('\n').map(JSON.parse) : projection.bytes.toString().trim().split('\n').map(JSON.parse));
    assert.ok(read.messages.some(m => m.text === 'BLOCK_ZERO 中文'), harness); assert.ok(read.messages.some(m => m.text === 'BLOCK_ONE'), harness);
  }
});

test('pi latest compaction checkpoint precedes kept range; older summaries and old context do not return', () => {
  const p = piRows(process.cwd()); p.msg('user', 'OLD_USER'); p.msg('assistant', 'OLD_ANSWER');
  const keep = p.msg('user', 'KEEP'); p.msg('assistant', 'KEEP_ANSWER'); p.add('compaction', { summary: 'SUMMARY_ONE', firstKeptEntryId: keep });
  const secondKeep = p.msg('user', 'RECENT'); p.msg('assistant', 'RECENT_ANSWER');
  p.add('compaction', { summary: 'SUMMARY_TWO', firstKeptEntryId: secondKeep }); p.msg('user', 'AFTER'); p.msg('assistant', 'AFTER_ANSWER');
  assert.deepEqual(texts(p.rows), ['[历史压缩摘要]\nSUMMARY_TWO', 'RECENT', 'RECENT_ANSWER', 'AFTER', 'AFTER_ANSWER']);
});

test('pi active context applies latest deletion/replacement, preserving original roles and raw rows', () => {
  const p = piRows(process.cwd()), drop = p.msg('user', 'REMOVE'), replace = p.msg('assistant', 'OLD_VALUE');
  p.add('context_edit', { targetId: drop, replacement: null }); p.add('context_edit', { targetId: replace, replacement: { content: 'FIRST_VALUE' } });
  p.add('context_edit', { targetId: replace, replacement: { content: [{ type: 'text', text: 'NEW_VALUE 中文' }], role: 'system' } });
  p.msg('user', 'NEXT'); p.msg('assistant', 'NEXT_ANSWER'); const before = JSON.stringify(p.rows);
  assert.deepEqual(texts(p.rows), ['NEW_VALUE 中文', 'NEXT', 'NEXT_ANSWER']);
  assert.equal(codecs.decode('pi', p.rows).messages[0].role, 'assistant'); assert.equal(JSON.stringify(p.rows), before);
});

test('pi edits outside active branch or outside retained compaction range do not apply', () => {
  const p = piRows(process.cwd()), target = p.msg('user', 'BASE'); const leaf = p.msg('assistant', 'BASE_ANSWER');
  const edit = p.add('context_edit', { targetId: target, replacement: null });
  p.rows.push({ type: 'message', id: 'other-leaf', parentId: leaf, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'OTHER_BRANCH' }], stopReason: 'stop' } });
  assert.deepEqual(texts(p.rows), ['BASE', 'BASE_ANSWER', 'OTHER_BRANCH']);
  p.rows.push({ type: 'compaction', id: 'compact', parentId: edit, timestamp, firstKeptEntryId: target, summary: 'CURRENT_SUMMARY' });
  assert.deepEqual(texts(p.rows), ['[历史压缩摘要]\nCURRENT_SUMMARY', 'BASE_ANSWER']);
});

test('pi unfinished tool turns remain local and malformed context edits never replay old content', () => {
  const p = piRows(process.cwd()); p.msg('user', 'BASE'); p.msg('assistant', 'ANSWER'); p.msg('user', 'PENDING');
  p.add('message', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], stopReason: 'toolUse' } });
  assert.equal(codecs.decode('pi', p.rows).pending, true); assert.deepEqual(texts(p.rows), ['BASE', 'ANSWER']);
  p.rows.splice(-2); p.add('context_edit', { targetId: 'e1', replacement: { unsupported: true } });
  assert.throws(() => texts(p.rows), /上下文修改/);
});

test('sync omission markers carry source presence, never prompt bodies or upgraded instructions', () => {
  const rows = [{ type: 'user', uuid: 'u', sessionId: id, cwd: process.cwd(), timestamp, message: { content: 'AGENTS user text' } },
    { type: 'attachment', uuid: 'snapshot', parentUuid: 'u', attachment: { type: 'prompt_snapshot', systemPrompt: ['PRIVATE_SOURCE_SYSTEM'] } },
    { type: 'assistant', uuid: 'a', parentUuid: 'snapshot', timestamp, message: { content: [{ type: 'text', text: 'ANSWER' }], stop_reason: 'end_turn' } }];
  const decoded = codecs.decode('claude', rows);
  assert.deepEqual(decoded.syncOmissions, ['system']); assert.ok(!JSON.stringify(decoded).includes('PRIVATE_SOURCE_SYSTEM'));
  assert.equal(decoded.messages[0].role, 'user'); assert.equal(decoded.messages[0].text, 'AGENTS user text');
});

test('OpenCode current model resolves target config priority and explicit overrides without guessing historical provider', t => {
  const f = fixture(t), config = path.join(f.root, 'config');
  put(path.join(config, 'opencode', 'opencode.jsonc'), '{//comment\n"model":"provider-b/model-b"}');
  const env = { XDG_CONFIG_HOME: config };
  assert.equal(currentModel({ home: f.root, cwd: f.cwd, env }), 'provider-b/model-b');
  put(path.join(f.cwd, 'opencode.json'), '{"model":"project-c/model-c"}');
  assert.equal(currentModel({ home: f.root, cwd: f.cwd, env }), 'project-c/model-c');
  assert.equal(currentModel({ home: f.root, cwd: f.cwd, env: { ...env, OPENCODE_CONFIG_CONTENT: '{"model":"inline/model"}' } }), 'inline/model');
  assert.equal(currentModel({ home: f.root, cwd: f.cwd, env, override: 'explicit/model/with/slash' }), 'explicit/model/with/slash');
  assert.throws(() => currentModel({ home: f.root, cwd: f.cwd, env, override: 'unqualified' }), /provider\/model/);
  assert.throws(() => currentModel({ home: f.root, cwd: f.cwd, env: { ...env, OPENCODE_CONFIG_CONTENT: '{broken' } }), /JSON/);
});

for (const major of [1, 2]) test(`OpenCode v${major} default ASS plan and projection use model B, never the old model`, async t => {
  const f = fixture(t); const p = piRows(f.cwd); p.msg('user', 'OLD_MODEL_USER'); p.msg('assistant', 'OLD_MODEL_ANSWER'); put(f.file, codecs.jsonl(p.rows));
  const env = { XDG_CONFIG_HOME: path.join(f.root, 'config'), XDG_DATA_HOME: f.root };
  put(path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"provider-b/model-b"}');
  const manager = new HarnessManager(path.join(f.root, 'manager'), () => ({ providers: [] }), [], f.dirs.codex, { home: f.root, env }); manager.state.credentialHomes.opencode = f.dirs.opencode;
  const initial = manager.projectConversationPlan('opencode', f.cwd), projectId = await enable(f), thread = f.library.project(projectId).threads[0];
  const prepared = await f.library.prepare(projectId, thread.id, 'opencode', initial.dir, major, initial.targetModel);
  const bundle = JSON.parse(fs.readFileSync(prepared.file, 'utf8'));
  const ref = major === 2 ? bundle.info.model : bundle.messages[0].info.model;
  assert.equal(ref.providerID, 'provider-b'); assert.equal(ref.id || ref.modelID, 'model-b'); assert.ok(!JSON.stringify(bundle).includes('gpt-5'));
  const plan = manager.projectConversationPlan('opencode', f.cwd, prepared.sessionId, prepared.nativeFile);
  assert.deepEqual(plan.args, ['--session', prepared.sessionId, '--model', 'provider-b/model-b']);
  assert.equal((await f.library.prepare(projectId, thread.id, 'opencode', initial.dir, major, initial.targetModel)).sessionId, prepared.sessionId);
  const override = manager.projectConversationPlan('opencode', f.cwd, prepared.sessionId, prepared.nativeFile, { model: 'explicit/model-c' });
  assert.deepEqual(override.args.slice(-2), ['--model', 'explicit/model-c']);
  const changed = await f.library.prepare(projectId, thread.id, 'opencode', initial.dir, major, 'provider-c/model-c'); assert.notEqual(changed.sessionId, prepared.sessionId);
  fs.unlinkSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'));
  assert.throws(() => manager.projectConversationPlan('opencode', f.cwd, prepared.sessionId, prepared.nativeFile), /尚未选择/);
});

test('pi edits rebuild an already shared context, retire older projections and survive restart without revival', async t => {
  const f = fixture(t), p = piRows(f.cwd), drop = p.msg('user', 'REMOVE_FROM_ACTIVE'), replace = p.msg('assistant', 'REPLACE_OLD'); put(f.file, codecs.jsonl(p.rows));
  const projectId = await enable(f), thread = f.library.project(projectId).threads[0]; const old = await f.library.prepare(projectId, thread.id, 'claude', f.dirs.claude);
  const before = fs.readFileSync(old.nativeFile), sourceBefore = fs.readFileSync(f.file);
  p.add('context_edit', { targetId: drop, replacement: null }); p.add('context_edit', { targetId: replace, replacement: { content: [{ type: 'text', text: 'REPLACE_NEW' }] } });
  p.msg('user', 'NEXT'); p.msg('assistant', 'NEXT_ANSWER'); put(f.file, codecs.jsonl(p.rows));
  await f.library.sync(projectId); const current = await f.library.preview(projectId, thread.id);
  assert.deepEqual(current.messages.map(m => m.text), ['REPLACE_NEW', 'NEXT', 'NEXT_ANSWER']);
  assert.equal(f.library.project(projectId).threads.length, 1); assert.equal(f.library.project(projectId).threads[0].priorContexts.length, 1);
  assert.equal(f.library.project(projectId).threads[0].routes[0].contextStale, true); assert.ok(before.equals(fs.readFileSync(old.nativeFile)));
  const archived = await f.library.preview(projectId, thread.id, 0, 0);
  assert.equal(archived.readOnly, true); assert.ok(archived.messages.some(m => m.text === 'REMOVE_FROM_ACTIVE'));
  const restarted = new ProjectConversations(f.options); await restarted.list(); await restarted.sync(projectId); await restarted.sync(projectId);
  const fresh = await restarted.prepare(projectId, thread.id, 'claude', f.dirs.claude); assert.notEqual(fresh.sessionId, old.sessionId);
  assert.ok(!JSON.stringify(await restarted.preview(projectId, thread.id)).includes('REMOVE_FROM_ACTIVE'));
  assert.ok(!sourceBefore.equals(fs.readFileSync(f.file)), 'only the simulated native pi edit changed the source');
});

test('previous decoder revision reparses unchanged pi files, and stale unreadable history cannot resume', async t => {
  const f = fixture(t), p = piRows(f.cwd); p.msg('user', 'OLD'); p.msg('assistant', 'OLD_ANSWER'); const keep = p.msg('user', 'KEPT'); p.msg('assistant', 'KEPT_ANSWER');
  p.add('compaction', { firstKeptEntryId: keep, summary: 'SUMMARY' });
  const old = [{ role: 'user', text: 'OLD' }, { role: 'assistant', text: 'OLD_ANSWER' }];
  const refs = old.map(m => { const ref = codecs.hash(JSON.stringify(m)); return ref; });
  // Seed the old graph with real encrypted blocks, then mark its current file
  // already observed, exactly as a pre-upgrade application would have saved it.
  put(f.file, codecs.encode('pi', { id, cwd: f.cwd, messages: old }).bytes);
  const projectId = await enable(f), project = f.library.project(projectId), oldThread = project.threads[0], key = 'pi\0' + id;
  oldThread.refs = refs; oldThread.times = [timestamp, timestamp]; project.origins[key] = { ...project.origins[key], threadId: oldThread.id, refs, transcriptRevision: 1 };
  put(f.file, codecs.jsonl(p.rows)); project.origins[key].signature = codecs.stamp(fs.statSync(f.file)); f.library.state.observed[projectId + ':' + key] = project.origins[key].signature;
  delete project.origins[key].contextKey; f.library.persist();
  const restarted = new ProjectConversations(f.options); await restarted.list(); await restarted.sync(projectId);
  const text = JSON.stringify(await restarted.preview(projectId, oldThread.id)); assert.ok(!text.includes('OLD_ANSWER')); assert.ok(text.includes('KEPT_ANSWER'));
  const broken = restarted.project(projectId).origins[key]; broken.transcriptRevision = 1; restarted.persist(); fs.unlinkSync(f.file);
  await assert.rejects(restarted.prepare(projectId, oldThread.id, 'claude', f.dirs.claude), /新版上下文读取/);
});

test('unchanged Claude multi-block upgrade repairs the shared prefix and retains completed continuation', async t => {
  const f = fixture(t, 'claude');
  const source = [
    { type: 'user', uuid: 'u', parentUuid: null, sessionId: id, cwd: f.cwd, timestamp, message: { content: 'FIRST' } },
    { type: 'assistant', uuid: 'a0', parentUuid: 'u', sessionId: id, apiBlockIndex: 0, timestamp, message: { id: 'msg_shared', content: [{ type: 'text', text: 'BLOCK_ZERO' }], stop_reason: 'end_turn' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'a0', sessionId: id, apiBlockIndex: 1, timestamp, message: { id: 'msg_shared', content: [{ type: 'text', text: 'BLOCK_ONE' }], stop_reason: 'end_turn' } }
  ];
  put(f.file, codecs.jsonl([source[0], { ...source[2], parentUuid: 'u' }]));
  const projectId = await enable(f), threadId = f.library.project(projectId).threads[0].id;
  const route = await f.library.prepare(projectId, threadId, 'pi', f.dirs.pi);
  const projected = codecs.lines(route.nativeFile), leaf = projected.at(-1).id;
  put(route.nativeFile, codecs.jsonl([...projected,
    { type: 'message', id: 'continued-u', parentId: leaf, timestamp, message: { role: 'user', content: 'CONTINUED_USER' } },
    { type: 'message', id: 'continued-a', parentId: 'continued-u', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'CONTINUED_ANSWER' }], stopReason: 'stop' } }
  ]));
  await f.library.sync(projectId);
  put(f.file, codecs.jsonl(source));
  const key = 'claude\0' + id, origin = f.library.project(projectId).origins[key];
  origin.transcriptRevision = 1; origin.signature = codecs.stamp(fs.statSync(f.file));
  f.library.state.observed[projectId + ':' + key] = origin.signature; f.library.persist();
  const restarted = new ProjectConversations(f.options); await restarted.list(); await restarted.sync(projectId); await restarted.sync(projectId);
  assert.deepEqual((await restarted.preview(projectId, threadId)).messages.map(m => m.text),
    ['FIRST', 'BLOCK_ZERO', 'BLOCK_ONE', 'CONTINUED_USER', 'CONTINUED_ANSWER']);
  const history = await restarted.preview(projectId, threadId, 0, 0);
  assert.deepEqual(history.messages.map(m => m.text), ['FIRST', 'BLOCK_ONE', 'CONTINUED_USER', 'CONTINUED_ANSWER']); assert.equal(history.readOnly, true);
  await assert.rejects(restarted.preview(projectId, threadId, 0, 99), /不存在/);
  const fresh = await restarted.prepare(projectId, threadId, 'pi', f.dirs.pi); assert.notEqual(fresh.sessionId, route.sessionId);
});

test('pi empty effective context clears shared context without deleting native records or reviving history', async t => {
  const f = fixture(t), p = piRows(f.cwd), u = p.msg('user', 'REMOVED_USER'), a = p.msg('assistant', 'REMOVED_ANSWER');
  put(f.file, codecs.jsonl(p.rows)); const projectId = await enable(f), threadId = f.library.project(projectId).threads[0].id;
  const route = await f.library.prepare(projectId, threadId, 'claude', f.dirs.claude);
  p.add('context_edit', { targetId: u, replacement: null }); p.add('context_edit', { targetId: a, replacement: null }); put(f.file, codecs.jsonl(p.rows));
  await f.library.sync(projectId); await f.library.sync(projectId);
  assert.equal((await f.library.preview(projectId, threadId)).total, 0);
  assert.equal((await f.library.preview(projectId, threadId, 0, 0)).total, 2);
  await assert.rejects(f.library.prepare(projectId, threadId, 'claude', f.dirs.claude), /有效上下文为空/);
  assert.ok(fs.existsSync(route.nativeFile)); assert.ok(fs.existsSync(f.file));
});

test('closing sync removes an unobserved retired projection using its verified published baseline', async t => {
  const f = fixture(t), p = piRows(f.cwd), u = p.msg('user', 'ORIGINAL'), a = p.msg('assistant', 'ANSWER');
  // Source-first discovery can retire a published route before its first scan.
  f.sources.sort((a, b) => Number(b.harness === 'pi') - Number(a.harness === 'pi'));
  put(f.file, codecs.jsonl(p.rows)); const projectId = await enable(f), threadId = f.library.project(projectId).threads[0].id;
  const route = await f.library.prepare(projectId, threadId, 'claude', f.dirs.claude);
  p.add('context_edit', { targetId: u, replacement: { content: 'REVISED' } });
  p.add('context_edit', { targetId: a, replacement: { content: 'REVISED_ANSWER' } }); put(f.file, codecs.jsonl(p.rows));
  await f.library.sync(projectId);
  assert.equal(f.library.project(projectId).origins['claude\0' + route.sessionId], undefined);
  assert.equal(f.library.project(projectId).threads[0].routes[0].contextStale, true);
  await f.library.configure(projectId, { enabled: false });
  assert.equal(fs.existsSync(route.nativeFile), false); assert.equal(fs.existsSync(f.file), true);
  const row = codecs.readConversation({ harness: 'pi', file: f.file }); assert.deepEqual(row.messages.map(m => m.text), ['REVISED', 'REVISED_ANSWER']);
});
