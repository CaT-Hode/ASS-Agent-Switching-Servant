const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { ProjectConversations } = require('../core/project-conversations.cjs');
const codecs = require('../core/project-codecs.cjs');
const { legacyDelete } = require('./helpers/legacy-conversation-trash.cjs');
const ID = '123e4567-e89b-42d3-a456-426614174000', timestamp = '2026-09-30T02:00:00.000Z';
const messages = [{ role: 'user', text: 'Shared project discussion', timestamp }, { role: 'assistant', text: 'Existing answer', timestamp }];
const { DatabaseSync } = require('node:sqlite');
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function fixture(t, all = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-project-sync-')); t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const cwd = path.join(root, 'project'), other = path.join(root, 'other-project'); fs.mkdirSync(cwd); fs.mkdirSync(other);
  const dirs = Object.fromEntries(codecs.HARNESSES.map((h) => [h, path.join(root, h)])); for (const d of Object.values(dirs)) fs.mkdirSync(d);
  const sources = codecs.HARNESSES.map((harness) => ({ harness, dir: dirs[harness] }));
  const secret = crypto.randomBytes(32), encryption = { isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', secret, iv), bytes = Buffer.concat([c.update(s), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
    decryptString: (b) => { const c = crypto.createDecipheriv('aes-256-gcm', secret, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(); } };
  const file = path.join(dirs.codex, 'sessions', `rollout-${ID}.jsonl`); write(file, codecs.encode('codex', { id: ID, cwd, title: 'Test', messages, createdAt: timestamp }).bytes);
  if (all) {
    for (const h of ['claude', 'pi', 'dsh']) {
      const encoded = codecs.encode(h, { id: ID, cwd, title: h + ' project', messages, createdAt: timestamp });
      write(path.join(dirs[h], h === 'claude' ? 'projects' : 'sessions', 'project', h === 'dsh' ? ID + '/session.v3.jsonl.zstd' : ID + '.jsonl'), encoded.bytes);
    }
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(path.join(dirs.opencode, 'opencode.db'));
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,version TEXT,project_id TEXT,slug TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)');
    const bundle = JSON.parse(codecs.encode('opencode', { id: 'ses_test', cwd, title: 'OpenCode project', messages, createdAt: timestamp }).bytes);
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,?,?,?)').run(bundle.info.id, bundle.info.title, cwd, Date.parse(timestamp), Date.parse(timestamp), '1.0', 'global', 'test');
    for (const m of bundle.messages) { db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(m.info.id, bundle.info.id, m.info.time.created, m.info.time.created, JSON.stringify(m.info));
      for (const p of m.parts) db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(p.id, m.info.id, bundle.info.id, m.info.time.created, m.info.time.created, JSON.stringify(p)); }
    db.close();
  }
  const dataDir = path.join(root, 'data'), options = { dataDir, crypto: encryption, sources: () => sources };
  const library = new ProjectConversations(options); return { root, cwd, other, dirs, sources, file, options, library, secret };
}
async function enable(f) { const list = await f.library.list(), p = list.items.find((p) => p.cwd === f.cwd); assert.ok(p); await f.library.configure(p.id, { enabled: true }); return p.id; }
for (const harness of ['claude', 'pi', 'dsh', 'codex']) for (const code of ['EIO', 'ENOSPC'])
test(`${harness} projection survives failed index ${code}, restart/retry and closing without duplicates`, async t => {
  const f = fixture(t), id = await enable(f), th = f.library.project(id).threads[0], original = fs.readFileSync(f.file);
  const unrelated = path.join(f.other, 'keep.txt'); fs.writeFileSync(unrelated, 'unrelated');
  const rename = fs.renameSync; let route, failed = false;
  fs.renameSync = function(src, dst) {
    if(dst === f.library.file && !failed) {
      const state = JSON.parse(f.options.crypto.decryptString(Buffer.from(JSON.parse(fs.readFileSync(src, 'utf8')).encrypted, 'base64')));
      route = state.projects.find(p => p.id === id)?.threads.flatMap(t => t.routes).find(r => r.harness === harness);
      if(route) { failed = true; throw Object.assign(Error('Synthetic index ' + code), {code}); }
    }
    return rename.apply(this, arguments);
  };
  try { await assert.rejects(f.library.prepare(id, th.id, harness, f.dirs[harness]), new RegExp(code)); }
  finally { fs.renameSync = rename; }
  assert.ok(failed); assert.ok(fs.existsSync(route.nativeFile));
  const restarted = new ProjectConversations(f.options); await restarted.sync(id);
  assert.equal(restarted.project(id).threads.length, 1);
  const repeated = await restarted.prepare(id, th.id, harness, f.dirs[harness]); assert.equal(repeated.nativeFile, route.nativeFile);
  assert.equal(restarted.project(id).threads[0].routes.length, 1);
  await restarted.configure(id, {enabled:false}); await restarted.configure(id, {enabled:false});
  assert.equal(fs.existsSync(route.nativeFile), false); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated');
});
for (const harness of ['claude', 'pi', 'dsh', 'codex']) for (const published of [false, true])
test(`${harness} projection recovers real process exit ${published ? 'after' : 'before'} native publication`, async t => {
  const f = fixture(t), id = await enable(f), th = f.library.project(id).threads[0], before = fs.readFileSync(f.file);
  const script = path.join(f.root, 'crash.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),crypto=require('node:crypto');
    const {ProjectConversations}=require(${JSON.stringify(require.resolve('../core/project-conversations.cjs'))});
    const [dataDir,sourcesText,keyText,id,threadId,harness,dir,published]=process.argv.slice(2), key=Buffer.from(keyText,'hex');
    const encryption={isEncryptionAvailable:()=>true,
      encryptString(s){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},
      decryptString(b){const c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();}};
    const lib=new ProjectConversations({dataDir,crypto:encryption,sources:()=>JSON.parse(sourcesText)}),run=lib.run.bind(lib);
    lib.run=async(action,args)=>{if(action==='prepare-publish'&&published==='false')process.exit(73);
      const r=await run(action,args);if(action==='prepare-publish')process.exit(73);return r;};
    lib.prepare(id,threadId,harness,dir).then(()=>process.exit(1),e=>{console.error(e);process.exit(2)});`);
  const child = require('node:child_process').spawnSync(process.execPath, [script, f.options.dataDir, JSON.stringify(f.sources), f.secret.toString('hex'), id, th.id, harness, f.dirs[harness], String(published)], {encoding:'utf8',timeout:15000});
  assert.equal(child.status, 73, child.stderr);
  const restarted = new ProjectConversations(f.options), intent = restarted.state.pendingPrepare; assert.ok(intent);
  assert.equal(fs.existsSync(intent.route.nativeFile), published);
  await restarted.list(); await restarted.sync(id); assert.equal(restarted.project(id).threads.length, 1);
  assert.equal(restarted.state.pendingPrepare, undefined);
  const route = await restarted.prepare(id, th.id, harness, f.dirs[harness]); assert.equal(route.nativeFile, intent.route.nativeFile);
  await restarted.configure(id, {enabled:false}); assert.equal(fs.existsSync(route.nativeFile), false);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
for (const code of ['EIO', 'ENOSPC']) test(`projection intent ${code} never publishes native data; retry is safe`, async t => {
  const f = fixture(t), id = await enable(f), th = f.library.project(id).threads[0], persist = f.library.persist.bind(f.library);
  f.library.persist = () => { if(f.library.state.pendingPrepare) throw Object.assign(Error('Synthetic ' + code), {code}); persist(); };
  await assert.rejects(f.library.prepare(id, th.id, 'claude', f.dirs.claude), new RegExp(code));
  assert.equal(f.library.state.pendingPrepare, undefined);
  assert.equal(codecs.discover(f.sources).rows.length, 1);
  f.library.persist = persist; await f.library.prepare(id, th.id, 'claude', f.dirs.claude);
  await f.library.sync(id); assert.equal(f.library.project(id).threads.length, 1);
});
for (const detached of [false, true]) test(`pending projection preserves external native edits (${detached ? 'copy' : 'hardlink'}) and reports conflict`, async t => {
  const f = fixture(t), id = await enable(f), th = f.library.project(id).threads[0], persist = f.library.persist.bind(f.library);
  f.library.persist = () => { if(f.library.project(id).threads[0].routes.length) throw Error('Synthetic final index EIO'); persist(); };
  await assert.rejects(f.library.prepare(id, th.id, 'claude', f.dirs.claude), /EIO/);
  const route = f.library.state.pendingPrepare.route;
  if(detached) {const replacement=route.nativeFile+'.replacement';fs.writeFileSync(replacement,fs.readFileSync(route.nativeFile));fs.renameSync(replacement,route.nativeFile);}
  fs.appendFileSync(route.nativeFile, '\n{"external":"keep every byte"}\n'); const bytes=fs.readFileSync(route.nativeFile);
  const restarted=new ProjectConversations(f.options);
  for(let repeat=0;repeat<2;repeat++) {
    await assert.rejects(restarted.sync(id), /外部变化/);
    await assert.rejects(restarted.configure(id,{enabled:false}), /外部变化/);
    assert.deepEqual(fs.readFileSync(route.nativeFile),bytes); assert.ok(restarted.state.pendingPrepare);
    assert.equal(restarted.project(id).threads.length,1);
  }
});
test('pending publication rejects a foreign path before modifying any file', async t => {
  const f=fixture(t),id=await enable(f),th=f.library.project(id).threads[0],persist=f.library.persist.bind(f.library);
  f.library.persist=()=>{if(f.library.project(id).threads[0].routes.length)throw Error('Synthetic EIO');persist();};
  await assert.rejects(f.library.prepare(id,th.id,'claude',f.dirs.claude),/EIO/);
  const route=f.library.state.pendingPrepare.route,original=fs.readFileSync(route.nativeFile),foreign=path.join(f.other,'foreign.jsonl');
  fs.writeFileSync(foreign,original);route.nativeFile=foreign;persist();
  const restarted=new ProjectConversations(f.options);
  await assert.rejects(restarted.list(),/路径或身份/);assert.deepEqual(fs.readFileSync(foreign),original);
  assert.equal(restarted.project(id).threads[0].routes.length,0);
});
test('changing sync targets first commits the pending publication instead of invalidating its intent', async t => {
  const f=fixture(t),id=await enable(f),th=f.library.project(id).threads[0],persist=f.library.persist.bind(f.library);
  f.library.persist=()=>{if(f.library.project(id).threads[0].routes.length)throw Error('Synthetic EIO');persist();};
  await assert.rejects(f.library.prepare(id,th.id,'claude',f.dirs.claude),/EIO/);
  const restarted=new ProjectConversations(f.options),route=restarted.state.pendingPrepare.route;
  await restarted.configure(id,{enabled:true,targets:['pi']});assert.equal(restarted.state.pendingPrepare,undefined);
  assert.equal(restarted.project(id).threads.length,1);assert.equal(restarted.project(id).threads[0].routes[0].nativeFile,route.nativeFile);
  await restarted.configure(id,{enabled:false});assert.equal(fs.existsSync(route.nativeFile),false);
});
test('native project rename refreshes enabled name and search, with unreadable metadata preserving the last name', async t => {
  const f=fixture(t),file=path.join(f.dirs.codex,'.codex-global-state.json');
  const rename=name=>write(file,JSON.stringify({'local-projects':{local:{id:'local',name,rootPaths:[f.cwd]}},'thread-project-assignments':{[ID]:{projectKind:'local',projectId:'local'}}}));
  rename('Original native');const id=await enable(f);rename('Renamed native');
  for(let i=0;i<2;i++){assert.equal((await f.library.list()).items.find(p=>p.id===id).name,'Renamed native');assert.equal(f.library.search({query:'Renamed native',harness:'codex'}).items[0].id,id);assert.equal(f.library.search({query:'Original native',harness:'codex'}).items.length,0);}
  write(file,'{broken');assert.equal((await f.library.list()).items.find(p=>p.id===id).name,'Renamed native');
});
test('re-enable skips retired projections while making a recreated identical route visible; retries and failed release preserve state',async t=>{
  const f=fixture(t),id=await enable(f);let thread=f.library.project(id).threads[0];const route=await f.library.prepare(id,thread.id,'claude',f.dirs.claude);
  const oldBytes=fs.readFileSync(route.nativeFile);await f.library.configure(id,{enabled:false});assert.ok(f.library.project(id).retired.includes('claude\0'+route.sessionId));
  // An old projection reappears through a stale/native copy. It must not be a new origin.
  write(route.nativeFile,oldBytes);await f.library.configure(id,{enabled:true});assert.equal(f.library.project(id).threads.length,1);fs.unlinkSync(route.nativeFile);
  thread=f.library.project(id).threads[0];const rebuilt=await f.library.prepare(id,thread.id,'claude',f.dirs.claude);assert.equal(rebuilt.sessionId,route.sessionId);
  const stale=path.join(f.dirs.claude,'projects','stale',route.sessionId+'.jsonl');write(stale,oldBytes);fs.utimesSync(stale,new Date('2030-01-01'),new Date('2030-01-01'));
  for(let i=0;i<2;i++){await f.library.list();assert.ok(f.library.recordsCache.some(r=>r.harness==='claude'&&r.sessionId===rebuilt.sessionId));}
  assert.equal(f.library.recordsCache.find(r=>r.harness==='claude'&&r.sessionId===rebuilt.sessionId).file,rebuilt.nativeFile);await f.library.sync(id);assert.equal(f.library.project(id).threads.length,1);
  const original=f.library.run.bind(f.library);f.library.run=(action,args)=>action==='release-plan'?Promise.reject(Error('Synthetic release failure')):original(action,args);
  await assert.rejects(f.library.configure(id,{enabled:false}),/release failure/);assert.equal(f.library.project(id).enabled,true);f.library.run=original;
  await f.library.configure(id,{enabled:false});await f.library.configure(id,{enabled:false});assert.equal(f.library.project(id).enabled,false);
});
function appendCC(route, user, answer) {
  const rows = codecs.lines(route.nativeFile), parent = rows.filter((r) => r.uuid).at(-1).uuid, uid = crypto.randomUUID(), aid = crypto.randomUUID();
  fs.appendFileSync(route.nativeFile, codecs.jsonl([
    { type: 'user', sessionId: route.sessionId, cwd: route.cwd, uuid: uid, parentUuid: parent, timestamp, message: { role: 'user', content: user } },
    { type: 'assistant', sessionId: route.sessionId, cwd: route.cwd, uuid: aid, parentUuid: uid, timestamp, message: { id: aid, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] } },
  ]));
}
function appendPi(route, user, answer) {
  const rows = codecs.lines(route.nativeFile), parentId = rows.at(-1).id, id = crypto.randomUUID(), aid = crypto.randomUUID();
  fs.appendFileSync(route.nativeFile, codecs.jsonl([{ type: 'message', id, parentId, timestamp, message: { role: 'user', content: [{ type: 'text', text: user }] } },
    { type: 'message', id: aid, parentId: id, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' } }]));
}

test('Codex current project assignment and title override the original session header, even without a log change', async (t) => {
  const f = fixture(t), global = path.join(f.dirs.codex, '.codex-global-state.json');
  const db = new DatabaseSync(path.join(f.dirs.codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,archived INTEGER,name TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?)').run(ID, '# AGENTS.md instructions', f.other, f.file, '客户端已命名');
  write(global, JSON.stringify({ 'local-projects': { project: { id: 'project', name: '实际项目', rootPaths: [f.cwd] } }, 'thread-project-assignments': { [ID]: { projectKind: 'local', projectId: 'project' } } }));
  let list = await f.library.list(); assert.equal(list.items[0].cwd, f.cwd); assert.equal(list.items[0].name, '实际项目');
  const records = await f.library.records(list.items[0].id); assert.equal(records.items[0].title, '客户端已命名');
  const id = list.items[0].id; await f.library.configure(id, { enabled: true });
  db.prepare('UPDATE threads SET name=? WHERE id=?').run('客户端重新命名', ID);
  await f.library.sync(id); assert.equal((await f.library.threads(id)).items[0].title, '客户端重新命名');
  db.close();
  write(global, JSON.stringify({ 'projectless-thread-ids': [ID] }));
  const raw = codecs.discover(f.sources).rows.find((r) => r.sessionId === ID); assert.equal(raw.projectless, true);
});

test('unified metadata search covers project paths and native titles, scoped to the current harness without rescanning', async (t) => {
  const f = fixture(t, true), id = crypto.randomUUID();
  write(path.join(f.dirs.codex, 'sessions', `rollout-${id}.jsonl`), codecs.encode('codex', { id, cwd: f.other, title: 'Unique history needle', messages: [{ ...messages[0], text: 'Unique history needle' }, messages[1]], createdAt: timestamp }).bytes);
  const list = await f.library.list(), original = fs.readFileSync(f.file);
  const home = list.items.find((p) => p.cwd === f.cwd), other = list.items.find((p) => p.cwd === f.other);
  f.library.run = () => { throw Error('search must use cached metadata'); };
  assert.deepEqual(f.library.search({ harness: 'codex', query: '  NEEDLE  ' }).items, [{ id: other.id, projectMatch: false, matches: 1 }]);
  assert.equal(f.library.search({ harness: 'codex', query: 'other-project' }).items[0].projectMatch, true);
  assert.equal(f.library.search({ harness: 'codex', query: 'OpenCode project' }).items.length, 0);
  assert.equal(f.library.search({ harness: 'opencode', query: 'OpenCode project' }).items[0].id, home.id);
  assert.equal(f.library.search({ harness: 'codex', query: 'Existing answer' }).items.length, 0, 'message bodies are not searched or transferred');
  assert.equal(f.library.search({ harness: 'codex', query: '' }).items.length, 2);
  assert.deepEqual(fs.readFileSync(f.file), original);
  for (const input of [{ harness: 'other' }, { harness: 'codex', query: 'x'.repeat(501) }, { harness: 'codex', nativeView: 'yes' }]) assert.throws(() => f.library.search(input), /查询无效/);
});

test('shared search and cached paging do not trigger synchronization, while native view stays native', async (t) => {
  const f = fixture(t), id = await enable(f), p = f.library.project(id);
  p.threads[0].title = 'Shared needle';
  f.library.run = () => { throw Error('search must not synchronize'); };
  assert.equal(f.library.search({ harness: 'pi', query: 'needle' }).items[0].id, id);
  assert.equal(f.library.search({ harness: 'pi', query: 'needle', nativeView: true }).items.length, 0);
  assert.equal((await f.library.threads(id, { cached: true, query: 'needle' })).items[0].title, 'Shared needle');
  await assert.rejects(f.library.threads(id, { cached: 'true' }), /查询无效/);
});

test('large Codex logs are listed and synchronized without a full-file buffer or 128 MiB exclusion', async (t) => {
  const f = fixture(t), fd = fs.openSync(f.file, 'a');
  const noise = JSON.stringify({ type: 'debug_only', payload: 'x'.repeat(128 * 1024) }) + '\n';
  try { for (let i = 0; i < 1030; i++) fs.writeSync(fd, noise); } finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(f.file).size > 128 * 1024 ** 2);
  const listed = codecs.discover(f.sources); assert.equal(listed.errors.length, 0); assert.equal(listed.rows.length, 1);
  const synced = codecs.discover(f.sources, { includeMessages: true, cwd: f.cwd });
  assert.equal(synced.errors.length, 0); assert.equal(synced.rows[0].messages.length, 2);
});

test('DSH v4 concatenated checked frames include all messages, native title, and final row without newline', (t) => {
  const f = fixture(t), z = require('node:zlib');
  const rows = [{ type: 'session', version: 4, id: ID, cwd: f.cwd, createdAt: Date.parse(timestamp) },
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: { content: 'DSH 问题' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'DSH 回答' }] } } },
    { type: 'session/title', seq: 3, data: { title: 'DSH 原生名称' } }, { type: 'turn/end', seq: 4 }];
  const file = path.join(f.dirs.dsh, 'sessions', 'project', ID, 'session.v4.jsonl.zstd');
  const frames = rows.map((r, i) => z.zstdCompressSync(Buffer.from(JSON.stringify(r) + (i < rows.length - 1 ? '\n' : '')), { params: { [z.constants.ZSTD_c_checksumFlag]: 1 } }));
  write(file, Buffer.concat(frames)); const before = fs.readFileSync(file);
  const found = codecs.discover(f.sources, { includeMessages: true }).rows.find((r) => r.harness === 'dsh');
  assert.equal(found.title, 'DSH 原生名称'); assert.equal(found.pending, false); assert.deepEqual(found.messages.map((m) => m.text), ['DSH 问题', 'DSH 回答']);
  fs.appendFileSync(file, frames[1].subarray(0, 9)); assert.throws(() => codecs.readConversation(found), /截断/);
  assert.deepEqual(fs.readFileSync(file).subarray(0, before.length), before);
});

test('CC rename in the middle of a long file overrides sampled summary and first prompt', (t) => {
  const f = fixture(t), encoded = codecs.encode('claude', { id: ID, cwd: f.cwd, title: '准确标题', messages });
  const file = path.join(f.dirs.claude, 'projects', 'project', ID + '.jsonl');
  write(file, Buffer.concat([encoded.bytes, Buffer.from(codecs.jsonl(Array.from({ length: 30 }, () => ({ type: 'progress', padding: 'x'.repeat(100000) }))))]));
  const row = codecs.discover(f.sources).rows.find((r) => r.harness === 'claude'); assert.equal(row.title, '准确标题');
});

test('native deletion requires confirmation, creates no backup and stays deleted after restart', async (t) => {
  const f = fixture(t), list = await f.library.list(), projectId = list.items[0].id;
  const recordId = (await f.library.records(projectId)).items[0].id;
  await assert.rejects(f.library.remove({ projectId, recordId }), /确认/); assert.ok(fs.existsSync(f.file));
  const r = await f.library.remove({ projectId, recordId, confirmed: true }); assert.ok(!fs.existsSync(f.file));
  assert.equal((await f.library.list()).items.length, 0); assert.equal(f.library.trashList().items.length, 0);
  assert.ok(!fs.existsSync(path.join(f.library.vault, 'trash')));
  assert.match(r.message, /未保存备份/);
  const again = new ProjectConversations(f.options); await assert.rejects(again.restoreTrash(r.id), /备份不存在/);
  assert.equal((await again.list()).items.length, 0);
  assert.equal(again.trashList().items.length, 0);
  assert.ok(!fs.readFileSync(again.file, 'utf8').includes(messages[0].text));
});

test('Codex native deletion removes just its index row and name entry; restoration keeps unrelated threads intact', async (t) => {
  const f = fixture(t), dbfile = path.join(f.dirs.codex, 'state_5.sqlite'), db = new DatabaseSync(dbfile);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0)').run(ID, 'Native title', f.cwd, f.file);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0)').run('other', 'Keep', f.other, 'other-file');
  const names = path.join(f.dirs.codex, 'session_index.jsonl'); write(names, codecs.jsonl([{ id: ID, thread_name: 'Old name' }, { id: 'other', thread_name: 'Keep' }]));
  const p = (await f.library.list()).items[0], row = (await f.library.records(p.id)).items[0];
  const deleted = await legacyDelete(f.library, { projectId: p.id, recordId: row.id, confirmed: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get().n, 1); assert.ok(!fs.readFileSync(names, 'utf8').includes(ID));
  await f.library.restoreTrash(deleted.id); assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get().n, 2); assert.ok(fs.readFileSync(names, 'utf8').includes(ID)); db.close();
});

test('archived Codex deletion works with the client running without saving backups', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), archived = path.join(f.dirs.codex, 'archived_sessions', path.basename(f.file));
  fs.mkdirSync(path.dirname(archived)); fs.renameSync(f.file, archived);
  const db = new DatabaseSync(path.join(f.dirs.codex, 'state_5.sqlite'));
  try {
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,1)').run(ID, 'Archived', f.cwd, archived);
  const names = path.join(f.dirs.codex, 'session_index.jsonl');
  const namesBefore = codecs.jsonl([{ id: ID, thread_name: 'Archived' }, { id: 'other', thread_name: 'Keep' }]);
  write(names, namesBefore);
  const guards = [], options = { ...f.options, assertDeletionIdle: async (rows, run, mode) => {
    guards.push(mode); if (!mode?.allowArchivedCodex) throw Error('运行中不能恢复');
    assert.ok(rows.every(require('../core/codex-archive-delete.cjs').eligible)); return { liveCodex: true };
  } };
  const library = new ProjectConversations(options), p = (await library.list({ scope: 'inactive' })).items[0];
  const row = (await library.records(p.id)).items[0];
  const result = await library.remove({ projectId: p.id, recordId: row.id, confirmed: true });
  assert.equal(guards.length, 2); assert.ok(!fs.existsSync(archived));
  assert.equal(db.prepare('SELECT count(*) n FROM threads').get().n, 0);
  assert.equal(fs.readFileSync(names, 'utf8'), namesBefore);
  await assert.rejects(library.restoreTrash(result.id), /备份不存在/);
  const restart = new ProjectConversations(f.options);
  assert.equal((await restart.list({ scope: 'all' })).items.length, 0);
  assert.equal(restart.trashList().items.length, 0); assert.ok(!fs.existsSync(path.join(library.vault, 'trash')));
  } finally { db.close(); }
});

test('live archive deletion refuses occupied targets without creating a backup', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), archived = path.join(f.dirs.codex, 'archived_sessions', path.basename(f.file));
  fs.mkdirSync(path.dirname(archived)); fs.renameSync(f.file, archived);
  const library = new ProjectConversations({ ...f.options, assertDeletionIdle: async () => ({ liveCodex: true }) });
  const p = (await library.list({ scope: 'inactive' })).items[0], row = (await library.records(p.id)).items[0];
  await require('../core/codex-archive-delete.cjs').withLocks([row], async () => {
    await assert.rejects(library.remove({ projectId: p.id, recordId: row.id, confirmed: true }), /占用|会话锁/);
    assert.ok(fs.existsSync(archived)); assert.equal(library.trashList().items.length, 0);
    assert.ok(!fs.existsSync(path.join(library.vault, 'trash')));
  });
});

test('live archive deletion protects forks that still reference the selected history', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), archived = path.join(f.dirs.codex, 'archived_sessions', path.basename(f.file));
  fs.mkdirSync(path.dirname(archived)); fs.renameSync(f.file, archived);
  const otherId = '123e4567-e89b-42d3-a456-426614174001';
  const lines = codecs.lines(archived); lines[0].payload.id = otherId;
  lines[0].payload.history_base = { thread_id: ID, turn_id: 'turn-1' };
  write(path.join(f.dirs.codex, 'sessions', `rollout-${otherId}.jsonl`), codecs.jsonl(lines));
  const library = new ProjectConversations({ ...f.options, assertDeletionIdle: async () => ({ liveCodex: true }) });
  const p = (await library.list({ scope: 'inactive' })).items[0], row = (await library.records(p.id)).items[0];
  await assert.rejects(library.remove({ projectId: p.id, recordId: row.id, confirmed: true }), /仍引用/);
  assert.ok(fs.existsSync(archived));
});

test('project deletion covers CC/pi/DSH, including DSH old generations; code and auth are never removed', async (t) => {
  const f = fixture(t, true); const sources = f.sources.filter((s) => s.harness !== 'opencode');
  const library = new ProjectConversations({ ...f.options, sources: () => sources });
  const old = codecs.discover(sources).rows.find((r) => r.harness === 'dsh').file;
  const v4 = old.replace('v3.', 'v4.'); const z = require('node:zlib'), body = codecs.lines(old); body[0].version = 4; write(v4, z.zstdCompressSync(Buffer.from(codecs.jsonl(body))));
  const code = path.join(f.cwd, 'keep.txt'), auth = path.join(f.dirs.codex, 'auth.json'); write(code, 'PROJECT'); write(auth, 'AUTH');
  const p = (await library.list()).items[0], result = await library.remove({ projectId: p.id, confirmed: true });
  assert.equal((await library.list()).items.length, 0); assert.ok(!fs.existsSync(v4)); assert.ok(!fs.existsSync(old));
  assert.equal(fs.readFileSync(code, 'utf8'), 'PROJECT'); assert.equal(fs.readFileSync(auth, 'utf8'), 'AUTH');
  await assert.rejects(library.restoreTrash(result.id), /备份不存在/);
  assert.equal(library.trashList().items.length, 0); assert.ok(!fs.existsSync(path.join(library.vault, 'trash')));
});

test('deletion refuses a running harness and restoration never overwrites a replacement log', async (t) => {
  const f = fixture(t), library = new ProjectConversations({ ...f.options, assertDeletionIdle: async () => { throw Error('运行中'); } });
  const p = (await library.list()).items[0]; await assert.rejects(library.remove({ projectId: p.id, confirmed: true }), /运行中/); assert.ok(fs.existsSync(f.file));
  const own = (await f.library.list()).items[0], deleted = await legacyDelete(f.library, { projectId: own.id, confirmed: true });
  write(f.file, 'REPLACEMENT'); await assert.rejects(f.library.restoreTrash(deleted.id), /同名/); assert.equal(fs.readFileSync(f.file, 'utf8'), 'REPLACEMENT');
});

test('OpenCode deletion and encrypted recovery go through the native import/delete adapter, not whole DB replacement', async (t) => {
  const f = fixture(t, true), calls = [], database = path.join(f.dirs.opencode, 'opencode.db');
  const adapter = async ({ imports, returns }) => {
    const db = new DatabaseSync(database);
    try {
      for (const item of imports) {
        calls.push('delete:' + item.sessionId);
        db.prepare('DELETE FROM part WHERE session_id=?').run(item.sessionId); db.prepare('DELETE FROM message WHERE session_id=?').run(item.sessionId); db.prepare('DELETE FROM session WHERE id=?').run(item.sessionId);
      }
      for (const item of returns) {
        calls.push('import:' + item.sessionId); const b = JSON.parse(fs.readFileSync(item.file));
        db.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,?,?,?)').run(b.info.id, b.info.title, b.info.directory, b.info.time.created, b.info.time.updated, b.info.version, b.info.projectID, b.info.slug);
        for (const m of b.messages) {
          db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(m.info.id, b.info.id, m.info.time.created, m.info.time.created, JSON.stringify(m.info));
          for (const p of m.parts) db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(p.id, m.info.id, b.info.id, m.info.time.created, m.info.time.created, JSON.stringify(p));
        }
      }
    } finally { db.close(); }
  };
  const library = new ProjectConversations({ ...f.options, sources: () => f.sources.filter((r) => r.harness === 'opencode'), releaseImports: adapter });
  const before = codecs.openCodeBundle(database, 'ses_test'), p = (await library.list()).items[0];
  const result = await legacyDelete(library, { projectId: p.id, confirmed: true });
  assert.throws(() => codecs.openCodeBundle(database, 'ses_test'), /不存在/);
  const entry = library.state.trash[0]; assert.ok(entry.imports[0].backup.endsWith('.enc')); assert.ok(!JSON.stringify(entry).includes('Existing answer'));
  await library.restoreTrash(result.id); assert.deepEqual(codecs.openCodeBundle(database, 'ses_test'), before);
  assert.deepEqual(calls, ['delete:ses_test', 'import:ses_test']);
});

test('OpenCode permanent deletion never stores a recovery bundle or creates a trash entry', async t => {
  const f = fixture(t, true), database = path.join(f.dirs.opencode, 'opencode.db'); let calls = 0;
  const library = new ProjectConversations({ ...f.options, sources: () => f.sources.filter(r => r.harness === 'opencode'),
    releaseImports: async ({ imports, returns }) => {
      calls++; assert.equal(returns.length, 0); assert.ok(imports.every(item => !item.backup));
      const db = new DatabaseSync(database); try { db.prepare('DELETE FROM session WHERE id=?').run('ses_test'); } finally { db.close(); }
    } });
  const p = (await library.list()).items[0]; await library.remove({ projectId: p.id, confirmed: true });
  assert.equal(calls, 1); assert.equal(library.trashList().items.length, 0);
  assert.ok(!fs.existsSync(path.join(library.vault, 'trash')));
  const restarted = new ProjectConversations({ ...f.options, sources: library.sources });
  assert.equal((await restarted.list()).items.length, 0);
  assert.ok(!JSON.stringify(restarted.state.removals).includes('Existing answer'));
});

test('existing backups survive permanent deletion and their explicit restoration stays visible after restart', async t => {
  const f = fixture(t), original = fs.readFileSync(f.file), p = (await f.library.list()).items[0];
  const old = await legacyDelete(f.library, { projectId: p.id, confirmed: true });
  // An unfinished old deletion has a valid backup and a native record that
  // remained/reappeared. Completing its deletion must not discard that backup.
  write(f.file, original); f.library.state.deleted = []; f.library.state.trash[0].phase = 'delete-partial'; f.library.persist();
  await f.library.remove({ projectId: p.id, confirmed: true });
  assert.equal(f.library.trashList().items.length, 1); assert.equal(f.library.trashList().items[0].id, old.id);
  await f.library.restoreTrash(old.id);
  const restarted = new ProjectConversations(f.options);
  assert.equal((await restarted.list()).items[0].count, 1); assert.deepEqual(fs.readFileSync(f.file), original);
});

test('partial permanent deletion records only completed identities, never plaintext recovery content', async t => {
  const f = fixture(t), trash = require('../core/conversation-trash.cjs'), secondId = crypto.randomUUID();
  const second = path.join(f.dirs.codex, 'sessions', 'rollout-' + secondId + '.jsonl');
  write(second, codecs.encode('codex', { id: secondId, cwd: f.cwd, messages, title: 'second', createdAt: timestamp }).bytes);
  await f.library.list();
  const entry = await trash.plan({ vault: f.library.vault, rows: codecs.discover(f.sources).rows, sources: f.sources, label: 'permanent', backup: false });
  entry.files.sort((a, b) => Number(a.file === second) - Number(b.file === second));
  f.library.state.removals = [{ id: entry.id, recoverable: false, rows: entry.rows.map(({ harness, sessionId }) => ({ harness, sessionId })), phase: 'prepared' }]; f.library.persist();
  const unlink = fs.unlinkSync; fs.unlinkSync = file => { if (file === second) throw Error('synthetic busy'); return unlink(file); };
  try { await assert.rejects(trash.commit(entry, f.library.vault), /已删除的部分无法恢复/); } finally { fs.unlinkSync = unlink; }
  const restart = new ProjectConversations(f.options);
  assert.ok(restart.state.deleted.includes('codex\0' + ID)); assert.ok(!restart.state.deleted.includes('codex\0' + secondId));
  assert.ok(!fs.existsSync(f.file)); assert.ok(fs.existsSync(second));
  assert.ok(!fs.existsSync(path.join(f.library.vault, 'trash')));
  const journal = fs.readFileSync(path.join(f.library.vault, 'deletions', entry.id + '.json'), 'utf8');
  assert.ok(!journal.includes(messages[0].text)); assert.ok(!journal.includes(f.cwd));
});

test('Windows extended and UNC paths keep one project identity', () => {
  const { displayPath } = require('../core/conversation-paths.cjs');
  assert.equal(displayPath('\\\\?\\D:\\CodexProj\\ASS'), 'D:\\CodexProj\\ASS');
  assert.equal(displayPath('\\\\?\\UNC\\server\\project'), '\\\\server\\project');
  if (process.platform === 'win32') assert.equal(codecs.pathKey('\\\\?\\D:\\CodexProj\\ASS'), codecs.pathKey('D:\\CodexProj\\ASS'));
});

test('delete process guard is read-only, rejects busy or unverifiable clients', async () => {
  const { assertDeletionIdle } = require('../core/conversation-delete-guard.cjs');
  await assertDeletionIdle([{ harness: 'codex' }], async (script, input) => { assert.ok(!/Stop-Process|taskkill|[.]Kill\(/i.test(script)); assert.deepEqual(input.harnesses, ['codex']); return { running: [] }; });
  await assert.rejects(assertDeletionIdle([{ harness: 'codex' }], async () => ({ running: ['codex'] })), /先关闭 Codex/);
  await assert.rejects(assertDeletionIdle([{ harness: 'codex' }], async () => ({})), /未能确认/);
});
test('delete guard unwraps the shared adapter singleton, but keeps busy and malformed replies blocked', async () => {
  const { assertDeletionIdle } = require('../core/conversation-delete-guard.cjs');
  const rows = [{ harness: 'claude' }, { harness: 'claude' }, { harness: 'pi' }];
  await assertDeletionIdle(rows, async (_, input) => {
    assert.deepEqual(input.harnesses, ['claude', 'pi']); return [{ running: [] }];
  });
  await assert.rejects(assertDeletionIdle(rows, async () => [{ running: ['claude'] }]), /先关闭 Claude/);
  for (const value of [[], [{ running: [] }, { running: [] }], null, [{}], [{ running: null }],
    [{ running: 'claude' }], [{ running: [null] }], [{ running: ['codex'] }]])
    await assert.rejects(assertDeletionIdle(rows, async () => value), /未能确认/);
  await assert.rejects(assertDeletionIdle(rows, async () => { throw Error('inspection failed'); }), /inspection failed/);
});
test('closed-client deletion and encrypted recovery work through the actual PowerShell adapter contract', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t), { assertDeletionIdle } = require('../core/conversation-delete-guard.cjs');
  const { runPowerShell } = require('../core/client-processes.cjs'); let calls = 0;
  const guard = (rows) => assertDeletionIdle(rows, async (script, input) => {
    assert.ok(script.includes('Get-CimInstance Win32_Process'));
    assert.deepEqual(input.harnesses, ['codex']); calls++;
    // Synthetic closed inventory, but the real native subprocess/JSON wrapper.
    // Never inspect, close or delete a user's client or transcript in this test.
    return runPowerShell('[pscustomobject]@{ running=@() } | ConvertTo-Json -Compress', {});
  });
  const library = new ProjectConversations({ ...f.options, assertDeletionIdle: guard });
  const original = fs.readFileSync(f.file), p = (await library.list()).items[0];
  const removed = await legacyDelete(library, { projectId: p.id, confirmed: true });
  assert.equal(fs.existsSync(f.file), false); assert.equal(calls, 2);
  assert.equal(library.trashList().items[0].id, removed.id);
  await library.restoreTrash(removed.id); assert.equal(calls, 3);
  assert.deepEqual(fs.readFileSync(f.file), original);
});
for (const h of codecs.HARNESSES) test(`${h} native projection preserves ordered shared context`, () => {
  const out = codecs.encode(h, { id: h === 'opencode' ? 'ses_test' : ID, cwd: process.cwd(), title: 'Shared', messages, createdAt: timestamp });
  const rows = h === 'dsh' ? Buffer.concat([...require('../core/conversation-reader.cjs').frames(out.bytes)].map(f => require('node:zlib').zstdDecompressSync(f))).toString() : out.bytes.toString();
  const value = h === 'opencode' ? codecs.decodeOpenCode(JSON.parse(rows)) : codecs.decode(h, rows.trim().split('\n').map(JSON.parse));
  assert.deepEqual(value.messages.map((m) => [m.role, m.text]), messages.map((m) => [m.role, m.text])); assert.equal(value.cwd, process.cwd());
  assert.ok(!/auth\.json|\.credentials\.json|apiKey/.test(rows));
});

test('CC repeated upstream message IDs remain separate across completed turns', () => {
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: ID, cwd: process.cwd(), timestamp, message: { role: 'user', content: 'First question' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp, message: { id: 'reused-upstream-id', stop_reason: 'end_turn', content: [{ type: 'text', text: 'First answer' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp, message: { role: 'user', content: 'Second question' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp, message: { id: 'reused-upstream-id', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second answer' }] } },
  ];
  const value = codecs.decode('claude', rows);
  assert.equal(value.pending, false);
  assert.deepEqual(value.messages.map((m) => m.text), ['First question', 'First answer', 'Second question', 'Second answer']);
});
test('project discovery covers all five sources but is read-only and opt-in', async (t) => {
  const f = fixture(t, true), original = fs.readFileSync(f.file), list = await f.library.list();
  assert.equal(list.items.length, 1); assert.equal(list.items[0].count, 5); assert.equal(list.items[0].enabled, false);
  assert.deepEqual(new Set(list.items[0].harnesses), new Set(codecs.HARNESSES)); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(f.library.state.projects.length, 0);
});
test('different projects and different original tasks are not conflated', async (t) => {
  const f = fixture(t, true); write(path.join(f.dirs.pi, 'sessions', 'other', 'other.jsonl'), codecs.encode('pi', { id: crypto.randomUUID(), cwd: f.other, title: 'Other', messages, createdAt: timestamp }).bytes);
  const id = await enable(f), threads = await f.library.threads(id); assert.equal(threads.items.length, 5); assert.equal((await f.library.list()).items.length, 2);
});
test('CC handoff is hardlinked, native originals and credentials stay untouched', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.file), auth = path.join(f.dirs.claude, '.credentials.json'); write(auth, 'KEEP CURRENT ACCOUNT');
  const id = await enable(f), thread = (await f.library.threads(id)).items[0], route = await f.library.prepare(id, thread.id, 'claude', f.dirs.claude);
  assert.equal(route.mode, 'hardlink'); assert.equal(fs.statSync(route.file).ino, fs.statSync(route.nativeFile).ino);
  assert.deepEqual(codecs.readConversation({ harness: 'claude', file: route.nativeFile }).messages.map((m) => m.text), messages.map((m) => m.text));
  assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(fs.readFileSync(auth, 'utf8'), 'KEEP CURRENT ACCOUNT');
});
test('completed CC continuation returns to Codex via the same canonical conversation', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], route = await f.library.prepare(id, th.id, 'claude', f.dirs.claude);
  appendCC(route, 'New CC question', 'New CC answer'); await f.library.sync(id);
  const all = await f.library.threads(id); assert.equal(all.items.length, 1); assert.equal(all.items[0].count, 4);
  const resumed = await f.library.prepare(id, th.id, 'codex', f.dirs.codex);
  assert.deepEqual(codecs.readConversation({ harness: 'codex', file: resumed.nativeFile }).messages.map((m) => m.text), [...messages.map((m) => m.text), 'New CC question', 'New CC answer']);
  const same = await f.library.prepare(id, th.id, 'codex', f.dirs.codex); assert.equal(same.nativeFile, resumed.nativeFile);
});
test('native atomic replacement is retained and reports the detached link as a copy', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], route = await f.library.prepare(id, th.id, 'claude', f.dirs.claude);
  const replacement = route.nativeFile + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(route.nativeFile));
  fs.renameSync(replacement, route.nativeFile);
  const again = await f.library.prepare(id, th.id, 'claude', f.dirs.claude);
  assert.equal(again.nativeFile, route.nativeFile); assert.equal(again.mode, 'copy');
  assert.notEqual(fs.statSync(again.file).ino, fs.statSync(again.nativeFile).ino);
});
test('two simultaneous continuations create two durable branches with shared prefix blocks', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0];
  const cc = await f.library.prepare(id, th.id, 'claude', f.dirs.claude), pi = await f.library.prepare(id, th.id, 'pi', f.dirs.pi);
  appendCC(cc, 'CC branch', 'CC result'); appendPi(pi, 'pi branch', 'pi result'); await f.library.sync(id);
  const all = await f.library.threads(id); assert.equal(all.items.length, 2); assert.equal(all.branches, 1);
  const histories = await Promise.all(all.items.map((r) => f.library.preview(id, r.id))); assert.ok(histories.some((r) => r.messages.some((m) => m.text === 'CC result'))); assert.ok(histories.some((r) => r.messages.some((m) => m.text === 'pi result')));
  assert.equal(fs.readdirSync(path.join(f.library.vault, 'blocks')).length, 6);
  assert.deepEqual(codecs.readConversation({ harness: 'claude', file: cc.nativeFile }).messages.at(-1).text, 'CC result');
});
test('incomplete turns and torn lines never replace completed shared history', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0];
  fs.appendFileSync(f.file, codecs.jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Pending question' }] } }]) + '{"type":');
  await f.library.sync(id); assert.equal((await f.library.preview(id, th.id)).total, 2);
  assert.ok(fs.readFileSync(f.file, 'utf8').endsWith('{"type":'));
});
test('project history survives restart and shared text is encrypted on disk', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], again = new ProjectConversations(f.options);
  assert.equal((await again.threads(id)).items.length, 1); assert.equal((await again.preview(id, th.id)).messages[0].text, messages[0].text);
  assert.ok(!fs.readFileSync(again.file, 'utf8').includes(messages[0].text));
  for (const name of fs.readdirSync(path.join(again.vault, 'blocks'))) assert.ok(!fs.readFileSync(path.join(again.vault, 'blocks', name)).includes(Buffer.from(messages[0].text)));
});
test('closing sync removes indexed projections but retains original and recoverable backups', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], route = await f.library.prepare(id, th.id, 'claude', f.dirs.claude);
  await f.library.configure(id, { enabled: false }); await f.library.sync();
  assert.equal(f.library.project(id).threads.length, 0); assert.ok(!fs.existsSync(route.nativeFile)); assert.ok(fs.existsSync(f.file));
  assert.ok(fs.existsSync(path.join(f.library.vault, 'released', 'claude', route.sessionId + '.jsonl')));
  await assert.rejects(f.library.prepare(id, th.id, 'pi', f.dirs.pi), /启用/);
});
test('native records are grouped and previewable before opting in, without capturing content', async (t) => {
  const f = fixture(t, true), projects = await f.library.list(), p = projects.items.find((p) => p.cwd === f.cwd);
  const r = await f.library.records(p.id); assert.equal(r.total, 5); assert.ok(!p.enabled); assert.equal(f.library.state.projects.length, 0);
  assert.equal((await f.library.nativePreview(r.items.find((r) => r.harness === 'pi').id)).total, 2);
  assert.ok(!fs.existsSync(path.join(f.library.vault, 'blocks')));
});
test('projectless Codex/CC records have no sync switch or writable shared graph', async (t) => {
  const f = fixture(t), file = path.join(f.dirs.claude, 'projects', 'loose.jsonl');
  write(file, codecs.encode('claude', { id: ID, cwd: os.homedir(), title: 'No project', messages }).bytes);
  const p = (await f.library.list()).items.find((p) => p.nonProject); assert.equal(p.id, codecs.NO_PROJECT);
  assert.equal((await f.library.records(p.id)).total, 1); await assert.rejects(f.library.configure(p.id, { enabled: true }), /不支持同步/);
});
test('all completed branches return to the initial harness before closing, other native histories are untouched', async (t) => {
  const f = fixture(t, true), id = await enable(f), th = (await f.library.threads(id)).items.find((r) => r.harnesses.includes('codex'));
  const original = fs.readFileSync(f.file), unrelated = codecs.discover(f.sources).rows.find((r) => r.harness === 'claude'), bytes = fs.readFileSync(unrelated.file);
  const cc = await f.library.prepare(id, th.id, 'claude', f.dirs.claude), pi = await f.library.prepare(id, th.id, 'pi', f.dirs.pi);
  appendCC(cc, 'CC question', 'CC branch'); appendPi(pi, 'pi question', 'pi branch'); await f.library.sync(id);
  await f.library.configure(id, { enabled: false });
  const native = codecs.discover(f.sources, { includeMessages: true }).rows;
  assert.ok(native.some((r) => r.harness === 'codex' && r.messages.some((m) => m.text === 'CC branch')));
  assert.ok(native.some((r) => r.harness === 'codex' && r.messages.some((m) => m.text === 'pi branch')));
  assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(fs.readFileSync(unrelated.file), bytes);
  assert.ok(!fs.existsSync(cc.nativeFile)); assert.ok(!fs.existsSync(pi.nativeFile));
  await f.library.list(); assert.ok(!(await f.library.records(id)).items.some((r) => r.syncedFrom));
});
test('closing refuses an incomplete target turn; no original or projection is removed', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], pi = await f.library.prepare(id, th.id, 'pi', f.dirs.pi);
  fs.appendFileSync(pi.nativeFile, codecs.jsonl([{ type: 'message', id: 'unfinished', parentId: codecs.lines(pi.nativeFile).at(-1).id, message: { role: 'user', content: 'Still working' } }]));
  await assert.rejects(f.library.configure(id, { enabled: false }), /仍在进行|变化/);
  assert.ok(f.library.project(id).enabled); assert.ok(fs.existsSync(pi.nativeFile)); assert.ok(fs.existsSync(f.file));
});
test('projection labels identify the original harness without altering shared message hashes', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], pi = await f.library.prepare(id, th.id, 'pi', f.dirs.pi);
  assert.match(fs.readFileSync(pi.nativeFile, 'utf8'), /来自 Codex 的同步/);
  assert.deepEqual(codecs.readConversation({ harness: 'pi', file: pi.nativeFile }).messages.map((m) => m.text), messages.map((m) => m.text));
  const p = (await f.library.list()).items.find((p) => p.id === id); assert.ok(p.enabled);
  assert.equal((await f.library.records(id, { harness: 'pi' })).items[0].syncedFrom, 'codex');
});
test('pi v1/v2 linear migration, system filtering and incomplete tools are read-only', () => {
  const rows = [{ type: 'session', version: 1, id: ID, cwd: process.cwd() },
    { type: 'message', message: { role: 'system', content: 'Old permission prompt' } },
    { type: 'message', message: { role: 'user', content: 'Old question' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }], stopReason: 'stop', model: 'old-model' } },
    { type: 'message', message: { role: 'hookMessage', content: 'Extension authority' } }];
  const original = JSON.stringify(rows), parsed = codecs.decode('pi', rows); assert.deepEqual(parsed.messages.map((m) => m.text), ['Old question', 'Old answer']);
  assert.equal(parsed.model, 'old-model'); assert.equal(JSON.stringify(rows), original);
  rows.push({ type: 'message', message: { role: 'user', content: 'pending' } }, { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: {} }], stopReason: 'toolUse' } });
  assert.equal(codecs.decode('pi', rows).pending, true); assert.equal(codecs.decode('pi', rows).messages.length, 2);
});
test('DSH current replacement surface preserves the final answer and omits nested tool results', () => {
  const header = { type: 'session', version: 3, id: ID, cwd: process.cwd(), createdAt: Date.parse(timestamp) };
  const rows = [header, { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Question' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'Old output' }] } } },
    { type: 'assistant/message', seq: 3, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, data: { message: { content: [{ type: 'text', text: 'Final output' }] } } },
    { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'Nested output' }] }] } } }, { type: 'turn/end', seq: 5 }];
  const parsed = codecs.decode('dsh', rows); assert.deepEqual(parsed.messages.map(m => m.text), ['Question', 'Final output']);
  assert.throws(() => codecs.decode('dsh', [{ ...header, version: 5 }]), /尚未支持/);
});
test('DSH v0-v4 transcripts keep text and Markdown while skipping typed tools, thinking and summaries', () => {
  const answer = '## Answer\n\n```js\nconst result = 42;\n```\n[历史工具结果] is quoted assistant text.';
  for (const version of [0, 1, 2, 3, 4]) {
    const rows = [{ type: 'session', version, id: ID, cwd: process.cwd(), createdAt: Date.parse(timestamp) },
      { type: 'turn/start', seq: 0 },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'input_text', text: 'Question' }, { type: 'image', name: 'attachment' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [
        { type: 'thinking', thinking: 'private reasoning', text: 'also private' },
        { type: 'reasoning', text: 'DSH reasoning block' },
        { type: 'tool-call', name: 'read', arguments: { file: 'private-path' }, text: 'tool block text' },
        { type: 'tool-result', content: [{ type: 'text', text: 'nested private output' }] },
        { type: 'text-chunks', texts: ['## Answer\n\n', '```js\nconst result = 42;\n```'] },
        { type: 'output_text', text: '[历史工具结果] is quoted assistant text.' },
      ] } } },
      { type: 'tool/result', seq: 3, data: { message: { content: 'tool output' } } },
      { type: 'compaction/summary', seq: 4, data: { summary: 'internal summary' } },
      { type: 'turn/end', seq: 5 }];
    const parsed = codecs.decode('dsh', rows);
    assert.deepEqual(parsed.messages.map(m => [m.role, m.text]), [['user', 'Question'], ['assistant', answer]]);
    assert.equal(parsed.pending, false);
  }
});
test('DSH tool-only messages cannot count as answers and unfinished turns stay outside shared history', () => {
  const header = { type: 'session', version: 4, id: ID, cwd: process.cwd(), createdAt: Date.parse(timestamp) };
  const rows = [header, { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: { content: 'Answered question' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: 'Completed answer' } } }, { type: 'turn/end', seq: 3 },
    { type: 'turn/start', seq: 4 }, { type: 'user/message', seq: 5, data: { content: 'Pending question' } },
    { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'toolCall', name: 'read', arguments: {} }] } } },
    { type: 'tool/result', seq: 7, data: { message: { content: 'not an answer' } } }];
  assert.deepEqual(codecs.decode('dsh', rows).messages.map(m => m.text), ['Answered question', 'Completed answer']);
  assert.equal(codecs.decode('dsh', rows).pending, true);
  assert.deepEqual(codecs.decode('dsh', rows, { completed: false }).messages.map(m => m.text), ['Answered question', 'Completed answer', 'Pending question']);
});
test('DSH v0-v4 distinguish human prompts from system, developer and injected user-role context by source', () => {
  const question = 'Explain system prompts and <think> tags as a programming topic.';
  for (const version of [0, 1, 2, 3, 4]) {
    const rows = [{ type: 'session', version, id: ID, cwd: process.cwd(), createdAt: Date.parse(timestamp) }];
    const event = (type, data) => rows.push({ type, seq: rows.length - 1, time: Date.parse(timestamp), data });
    event('turn/start', {});
    event('system/message', { message: { role: 'system', content: 'hidden system prompt' } });
    event('developer/message', { message: { role: 'developer', content: 'hidden developer prompt' } });
    for (const kind of ['runtime-context', 'skill-catalog', 'skill-invocation', 'time-context', 'tool-jobs', 'agent-message', 'subagent-settled', 'plugin', 'future-injection', null]) {
      event('user/message', { role: 'user', source: { kind }, content: [{ type: 'text', text: 'hidden ' + kind }] });
    }
    event('user/message', { role: 'system', source: { kind: 'user' }, content: 'hidden mismatched role' });
    event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'input_text', text: question }] });
    event('assistant/message', { message: { role: 'system', source: { kind: 'model' }, content: 'hidden mismatched assistant role' } });
    event('assistant/message', { message: { role: 'assistant', source: { kind: 'plugin' }, content: 'hidden generated context' } });
    event('assistant/message', { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'hidden thought' }, { type: 'text', text: 'Visible answer' }] } });
    event('turn/end', {});
    const parsed = codecs.decode('dsh', rows);
    assert.deepEqual(parsed.messages.map(m => [m.role, m.text]), [['user', question], ['assistant', 'Visible answer']]);
    assert.equal(parsed.title, question);
    assert.equal(parsed.pending, false);
  }
});
test('DSH legacy messages without source metadata remain visible but explicit non-dialogue roles do not', () => {
  const rows = [{ type: 'session', version: 0, id: ID, cwd: process.cwd(), createdAt: Date.parse(timestamp) },
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1, data: { role: 'system', content: 'hidden legacy system prompt' } },
    { type: 'user/message', seq: 2, data: { role: 'developer', content: 'hidden legacy developer prompt' } },
    { type: 'user/message', seq: 3, data: { content: 'Legacy human question' } },
    { type: 'assistant/message', seq: 4, data: { message: { role: 'user', content: 'hidden mismatched message' } } },
    { type: 'assistant/message', seq: 5, data: { message: { content: 'Legacy answer' } } }, { type: 'turn/end', seq: 6 }];
  assert.deepEqual(codecs.decode('dsh', rows).messages.map(m => [m.role, m.text]), [['user', 'Legacy human question'], ['assistant', 'Legacy answer']]);
});
test('DSH older metadata is reparsed without a log change so system context cannot persist in titles or newly collected history', async t => {
  const f = fixture(t), file = path.join(f.dirs.dsh, 'sessions', 'project', ID, 'session.v4.jsonl.zstd');
  const rows = [{ type: 'session', version: 4, id: ID, cwd: f.cwd, createdAt: Date.parse(timestamp) },
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'runtime-context' }, content: 'hidden cached system context' } },
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: 'True human question' } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'hidden thought' }, { type: 'text', text: 'Final answer' }] } } },
    { type: 'turn/end', seq: 4 }];
  write(file, require('node:zlib').zstdCompressSync(Buffer.from(codecs.jsonl(rows))));
  const before = fs.readFileSync(file), signature = codecs.stamp(fs.statSync(file));
  f.options.sources = () => f.sources.filter(s => s.harness === 'dsh');
  const previous = codecs.discover(f.options.sources()).rows[0];
  delete previous.transcriptRevision; previous.title = 'hidden cached system context';
  f.library.state.catalog = { [previous.id]: previous }; f.library.persist();
  const library = new ProjectConversations(f.options), project = (await library.list()).items[0];
  const record = (await library.records(project.id)).items[0];
  assert.equal(record.signature, signature);
  assert.equal(record.title, 'True human question');
  assert.deepEqual((await library.nativePreview(record.id)).messages.map(m => m.text), ['True human question', 'Final answer']);
  await library.configure(project.id, { enabled: true, targets: ['dsh'] });
  const shared = (await library.threads(project.id)).items[0];
  assert.equal(shared.title, 'True human question');
  assert.deepEqual((await library.preview(project.id, shared.id)).messages.map(m => m.text), ['True human question', 'Final answer']);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(codecs.stamp(fs.statSync(file)), signature);
});
test('DSH native preview ignores tool history on an unchanged cached file and after restart; new shared history contains only text', async t => {
  const f = fixture(t), dshFile = path.join(f.dirs.dsh, 'sessions', 'project', ID, 'session.v4.jsonl.zstd');
  const rows = [{ type: 'session', version: 4, id: ID, cwd: f.cwd, createdAt: Date.parse(timestamp) },
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: { content: 'DSH text question' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'thinking', thinking: 'omitted reasoning' }, { type: 'text', text: 'DSH final answer' }] } } },
    { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'omitted tool' }] }] } } },
    { type: 'compaction/summary', seq: 4, data: { summary: 'omitted summary' } }, { type: 'turn/end', seq: 5 }];
  write(dshFile, require('node:zlib').zstdCompressSync(Buffer.from(codecs.jsonl(rows))));
  const before = fs.readFileSync(dshFile), signature = codecs.stamp(fs.statSync(dshFile));
  f.options.sources = () => f.sources.filter(s => s.harness === 'dsh');
  let library = new ProjectConversations(f.options);
  const project = (await library.list()).items[0];
  const native = (await library.records(project.id, { harness: 'dsh' })).items[0];
  for (let i = 0; i < 2; i++) {
    await library.list();
    assert.deepEqual((await library.nativePreview(native.id)).messages.map(m => m.text), ['DSH text question', 'DSH final answer']);
    library = new ProjectConversations(f.options);
  }
  await library.list();
  await library.configure(project.id, { enabled: true, targets: ['dsh'] });
  const shared = (await library.threads(project.id)).items[0];
  assert.deepEqual((await library.preview(project.id, shared.id)).messages.map(m => m.text), ['DSH text question', 'DSH final answer']);
  assert.deepEqual(fs.readFileSync(dshFile), before);
  assert.equal(codecs.stamp(fs.statSync(dshFile)), signature);
});
test('pi custom session root is discovered and current model defaults override historical metadata on resume', (t) => {
  const f = fixture(t), custom = path.join(f.root, 'custom-sessions');
  write(path.join(custom, 'pi.jsonl'), codecs.encode('pi', { id: ID, cwd: f.cwd, messages }).bytes);
  assert.equal(codecs.discover([{ harness: 'pi', dir: f.dirs.pi, sessionDirs: [custom] }]).rows.length, 1);
  const { HarnessManager } = require('../core/harnesses.cjs'), manager = new HarnessManager(f.root, () => ({ providers: [] }), [], f.dirs.codex, { home: f.root, env: { PI_CODING_AGENT_DIR: f.dirs.pi, PI_CODING_AGENT_SESSION_DIR: custom } });
  write(path.join(f.dirs.pi, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'current-model' }));
  const plan = manager.projectConversationPlan('pi', f.cwd, ID, path.join(custom, 'pi.jsonl'));
  assert.deepEqual(plan.args.slice(0, 6), ['--session', path.join(custom, 'pi.jsonl'), '--provider', 'anthropic', '--model', 'current-model']);
  assert.ok(manager.conversationSources().find((r) => r.harness === 'pi').sessionDirs.includes(custom));
});
test('tampered shared blocks block resume and do not create a native file', async (t) => {
  const f = fixture(t), id = await enable(f), th = (await f.library.threads(id)).items[0], ref = f.library.project(id).threads[0].refs[0];
  fs.writeFileSync(path.join(f.library.vault, 'blocks', ref + '.enc'), 'corrupted');
  await assert.rejects(f.library.prepare(id, th.id, 'claude', f.dirs.claude)); assert.ok(!fs.existsSync(path.join(f.dirs.claude, 'projects')));
});
test('unknown future formats refuse conversion without changing native history', (t) => {
  const f = fixture(t), file = path.join(f.dirs.pi, 'sessions', 'future.jsonl'); write(file, codecs.jsonl([{ type: 'session', version: 999, id: ID, cwd: f.cwd }]));
  const before = fs.readFileSync(file), r = codecs.discover(f.sources); assert.ok(r.errors.some((e) => e.harness === 'pi')); assert.deepEqual(fs.readFileSync(file), before);
});
test('historical tool operations are inert text, not replayable target tool calls', () => {
  const source = [{ type: 'user', sessionId: ID, cwd: process.cwd(), message: { role: 'user', content: 'Question' } },
    { type: 'assistant', sessionId: ID, cwd: process.cwd(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'delete', input: { path: 'never-executed' } }] } },
    { type: 'user', sessionId: ID, cwd: process.cwd(), message: { role: 'user', content: [{ type: 'tool_result', content: 'Synthetic result' }] } },
    { type: 'assistant', sessionId: ID, cwd: process.cwd(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }];
  const decoded = codecs.decode('claude', source), result = codecs.encode('codex', { id: ID, cwd: process.cwd(), messages: decoded.messages });
  assert.match(result.bytes.toString(), /历史工具调用/); assert.match(result.bytes.toString(), /历史工具结果/); assert.ok(!result.bytes.toString().includes('function_call'));
});
test('CC pending tool execution is withheld even when it includes interim text', () => {
  const rows = [{ type: 'user', sessionId: ID, cwd: process.cwd(), message: { role: 'user', content: 'Pending question' } },
    { type: 'assistant', sessionId: ID, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', name: 'read', input: {} }] } }];
  const decoded = codecs.decode('claude', rows); assert.equal(decoded.pending, true); assert.equal(decoded.messages.length, 0);
});
test('CC attachment/progress parent records do not sever cross-harness history', () => {
  const rows = [{ type: 'user', uuid: 'user', parentUuid: null, sessionId: ID, cwd: process.cwd(), message: { role: 'user', content: 'Original question' } },
    { type: 'attachment', uuid: 'context', parentUuid: 'user' }, { type: 'progress', uuid: 'progress', parentUuid: 'context' },
    { type: 'assistant', uuid: 'answer', parentUuid: 'progress', sessionId: ID, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer after context' }] } }];
  assert.deepEqual(codecs.decode('claude', rows).messages.map((m) => m.text), ['Original question', 'Answer after context']);
});
test('DSH native project directory collapses separators and escapes Unicode', () => {
  assert.equal(codecs.dshSlug('D:\\CodexProj\\ASS'), '--D-CodexProj-ASS--');
  assert.equal(codecs.dshSlug('D:\\中文'), '--D-~4E2D~6587--');
});
test('OpenCode message IDs remain chronological even when timestamps are equal', () => {
  const result = JSON.parse(codecs.encode('opencode', { id: 'ses_test', cwd: process.cwd(), title: 'Order', messages: [...messages, ...messages], createdAt: timestamp }).bytes);
  const ids = result.messages.map((m) => m.info.id); assert.deepEqual([...ids].sort(), ids);
});
test('OpenCode projections are official import bundles, never direct DB writes', async (t) => {
  const f = fixture(t, true), dbFile = path.join(f.dirs.opencode, 'opencode.db'), before = fs.readFileSync(dbFile), id = await enable(f);
  const th = (await f.library.threads(id)).items.find((r) => r.harnesses.includes('codex')), route = await f.library.prepare(id, th.id, 'opencode', f.dirs.opencode);
  assert.equal(route.mode, 'import'); const bundle = JSON.parse(fs.readFileSync(route.file)); assert.ok(bundle.info.id.startsWith('ses_')); assert.equal(bundle.messages.length, 2); assert.deepEqual(fs.readFileSync(dbFile), before);
});
test('same message body retains its individual timestamps while content is deduplicated', async (t) => {
  const f = fixture(t); const repeated = [...messages, { ...messages[0], timestamp: '2026-09-30T03:00:00.000Z' }, { ...messages[1], timestamp: '2026-09-30T03:00:00.000Z' }];
  write(f.file, codecs.encode('codex', { id: ID, cwd: f.cwd, messages: repeated }).bytes);
  const id = await enable(f), th = (await f.library.threads(id)).items[0], preview = await f.library.preview(id, th.id);
  assert.equal(preview.messages[2].timestamp, repeated[2].timestamp); assert.equal(fs.readdirSync(path.join(f.library.vault, 'blocks')).length, 2);
});
test('OpenCode project resume uses its existing native auth/DB root, not an isolated nested home', (t) => {
  const f = fixture(t), { HarnessManager } = require('../core/harnesses.cjs');
  const manager = new HarnessManager(f.root, () => ({ providers: [] }), [], f.dirs.codex, { home: f.root, env: { XDG_DATA_HOME: path.dirname(f.dirs.opencode), XDG_CONFIG_HOME: path.join(f.root, 'config') } });
  manager.state.credentialHomes.opencode = f.dirs.opencode;
  const plan = manager.projectConversationPlan('opencode', f.cwd);
  assert.equal(plan.env.XDG_DATA_HOME, path.dirname(f.dirs.opencode)); assert.equal(plan.env.XDG_CONFIG_HOME, path.join(f.root, 'config')); assert.deepEqual(plan.files, []);
});

test('delete and restore preflight all native metadata before publishing transcript changes', async t => {
  const f = fixture(t), trash = require('../core/conversation-trash.cjs'), names = path.join(f.dirs.codex, 'session_index.jsonl');
  write(names, JSON.stringify({ id: ID, thread_name: 'original' }) + '\n');
  const db = new DatabaseSync(path.join(f.dirs.codex, 'state_5.sqlite')); db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, rollout_path TEXT)'); db.prepare('INSERT INTO threads VALUES(?,?,?)').run(ID, 'original', f.file);
  await f.library.list(); const row = codecs.discover(f.sources).rows.find(r => r.sessionId === ID), entry = await trash.plan({ vault: f.library.vault, secret: f.library.state.secret, rows: [row], sources: f.sources, label: 'preflight' });
  write(names, JSON.stringify({ id: ID, thread_name: 'concurrent rename' }) + '\n');
  await assert.rejects(trash.commit(entry, f.library.vault), /名称索引已变化/);
  assert.ok(fs.existsSync(f.file)); assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get().n, 1);
  write(names, JSON.stringify({ id: ID, thread_name: 'original' }) + '\n');
  const deleted = await trash.commit(entry, f.library.vault); assert.equal(fs.existsSync(f.file), false);
  write(names, JSON.stringify({ id: ID, thread_name: 'new name' }) + '\n');
  await assert.rejects(trash.restore({ vault: f.library.vault, secret: f.library.state.secret, entry: deleted }), /名称已变化/);
  assert.equal(fs.existsSync(f.file), false); assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get().n, 0); assert.match(fs.readFileSync(names, 'utf8'), /new name/); db.close();
});
test('partial native deletion is durable and recoverable after a later file failure', async t => {
  const f = fixture(t), trash = require('../core/conversation-trash.cjs'), secondId = crypto.randomUUID(), second = path.join(f.dirs.codex, 'sessions', 'rollout-' + secondId + '.jsonl');
  write(second, codecs.encode('codex', { id: secondId, cwd: f.cwd, messages, title: 'second', createdAt: timestamp }).bytes);
  await f.library.list(); const entry = await trash.plan({ vault: f.library.vault, secret: f.library.state.secret, rows: codecs.discover(f.sources).rows, sources: f.sources, label: 'partial' });
  // Discovery order varies with random UUID filenames. Make this specifically
  // a later-file failure rather than occasionally failing before any deletion.
  entry.files.sort((a, b) => Number(a.file === second) - Number(b.file === second));
  const original = fs.unlinkSync;
  fs.unlinkSync = file => { if (file === second) throw Error('synthetic later file busy'); return original(file); };
  try { await assert.rejects(trash.commit(entry, f.library.vault), /未全部完成/); } finally { fs.unlinkSync = original; }
  assert.equal(trash.status(f.library.vault, entry).phase, 'delete-partial');
  assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(second), true);
  await trash.restore({ vault: f.library.vault, secret: f.library.state.secret, entry });
  assert.ok(fs.existsSync(f.file)); assert.ok(fs.existsSync(second)); assert.equal(trash.status(f.library.vault, entry).phase, 'restored');
});
