// Opt-in native consumers + loopback model API. Never downloads, uses a real
// credential, rewrites a user's session, or contacts a cloud model endpoint.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const codecs = require('../../core/project-codecs.cjs');
const { ProjectConversations } = require('../../core/project-conversations.cjs');
const { HarnessManager } = require('../../core/harnesses.cjs');
const { mock } = require('./mock.cjs');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file,
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); };
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function environment(home) {
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot || '/usr', 'System32'), '/usr/bin', '/bin'].join(path.delimiter),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    CI: '1', NO_COLOR: '1', TERM: 'dumb', DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PI_OFFLINE: '1', PI_TELEMETRY: '0',
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
    NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'guard.cjs')) };
  for (const key of ['HOME', 'TEMP', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) fs.mkdirSync(env[key], { recursive: true });
  return env;
}
function execute(executable, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, 55000);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-(1024 ** 2)); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-(1024 ** 2)); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); resolve({ args, code, stdout, stderr, expired }); });
  });
}
function pin(prefix, folder, pkg, version) {
  const dir = path.join(prefix, folder, 'node_modules', pkg), meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(meta.name, pkg); assert.equal(meta.version, version); return dir;
}
async function enable(library, cwd) {
  const p = (await library.list()).items.find(p => p.cwd === cwd); assert.ok(p, 'native project missing');
  await library.configure(p.id, { enabled: true }); return { project: p.id, thread: library.project(p.id).threads[0].id };
}
async function main() {
  if (!process.argv.includes('--enable')) { console.log('SKIPPED: use --enable --prefix <absolute installed package roots>'); return; }
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  if (!prefix || !path.isAbsolute(prefix)) throw Error('absolute --prefix required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-sync-native-fidelity-')), results = [], server = await mock({ multiBlock: true });
  const check = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, status: 'pass', detail }); }
    catch (e) { results.push({ name, status: 'fail', error: e.stack }); }
    put(path.join(root, 'results.json'), results); console.log(JSON.stringify(results.at(-1)));
  };
  try {
    const pi = pin(prefix, 'native-pi', '@earendil-works/pi-coding-agent', '1.0.0');
    await check('pi 1.0.0 native active context and native-restored ASS projection', async () => {
      const { SessionManager } = await import(pathToFileURL(path.join(pi, 'dist/core/session-manager.js')).href);
      const cwd = path.join(root, 'pi/project'), dir = path.join(root, 'pi/sessions'); fs.mkdirSync(cwd, { recursive: true });
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const user = text => ({ role: 'user', content: text, timestamp: Date.now() });
      const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'qa', model: 'qa', usage, stopReason: 'stop', timestamp: Date.now() });
      for (const kind of ['compaction', 'context_edit']) {
        const sm = SessionManager.create(cwd, dir);
        sm.appendMessage({ role: 'system', content: 'PRIVATE_NATIVE_SYSTEM', tools: [], timestamp: Date.now() });
        const drop = sm.appendMessage(user('OLD_USER')), replace = sm.appendMessage(assistant('OLD_ASSISTANT'));
        const kept = sm.appendMessage(user('KEEP_USER')); sm.appendMessage(assistant('KEEP_ASSISTANT'));
        if (kind === 'compaction') sm.appendCompaction('NATIVE_SUMMARY', kept, 50000);
        else { sm.appendContextEdit(drop, null); sm.appendContextEdit(replace, { content: [{ type: 'text', text: 'NEW_ASSISTANT' }] }); }
        sm.appendMessage(user('AFTER_USER')); sm.appendMessage(assistant('AFTER_ASSISTANT'));
        const file = sm.getSessionFile(), before = fs.readFileSync(file), decoded = codecs.readConversation({ harness: 'pi', file });
        const native = SessionManager.open(file, dir).buildSessionContext();
        const messageTexts = JSON.stringify(native.messages);
        assert.ok(!messageTexts.includes('OLD_USER')); assert.ok(!messageTexts.includes('OLD_ASSISTANT'));
        assert.ok(!JSON.stringify(decoded).includes('PRIVATE_NATIVE_SYSTEM'));
        const expected = kind === 'compaction' ? ['[历史压缩摘要]\nNATIVE_SUMMARY', 'KEEP_USER', 'KEEP_ASSISTANT', 'AFTER_USER', 'AFTER_ASSISTANT']
          : ['NEW_ASSISTANT', 'KEEP_USER', 'KEEP_ASSISTANT', 'AFTER_USER', 'AFTER_ASSISTANT'];
        assert.deepEqual(decoded.messages.map(m => m.text), expected);
        const projection = path.join(root, 'pi', kind + '.jsonl');
        put(projection, codecs.encode('pi', { id: '123e4567-e89b-42d3-a456-426614174123', cwd, messages: decoded.messages }).bytes);
        const restored = SessionManager.open(projection, dir), context = restored.buildSessionContext();
        assert.deepEqual(context.messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(b => b.text).join('\n')), expected);
        restored.appendMessage(user('NATIVE_CONTINUED')); restored.appendMessage(assistant('NATIVE_CONTINUED_ANSWER'));
        assert.equal(codecs.readConversation({ harness: 'pi', file: projection }).messages.at(-1).text, 'NATIVE_CONTINUED_ANSWER');
        assert.ok(before.equals(fs.readFileSync(file)), 'source file mutated');
        put(path.join(root, 'pi', kind + '-evidence.json'), { native, decoded, restored: context });
      }
      return { cases: ['compaction', 'context_edit'], sourceReadOnly: true, projectionNativeRestore: true };
    });
    for (const major of [1, 2]) await check('OpenCode ' + (major === 1 ? '1.18.34' : '2.0.22') + ' default ASS resume selects current B on wire', async () => {
      const pkg = major === 1 ? 'opencode-ai' : '@opencode/cli'; pin(prefix, 'native-oc' + major, pkg, major === 1 ? '1.18.34' : '2.0.22');
      const binary = path.join(prefix, 'native-oc' + major, 'node_modules', major === 1 ? 'opencode-windows-x64' : '@opencode/cli-windows-x64', 'bin/opencode.exe');
      const cwd = path.join(root, 'oc' + major, 'project'), home = path.join(root, 'oc' + major, 'home'); fs.mkdirSync(cwd, { recursive: true });
      const env = environment(home), ocDir = path.join(env.XDG_DATA_HOME, 'opencode');
      put(path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json'), { model: 'local-b/model-b', permission: { '*': 'deny' },
        provider: { 'local-b': { npm: '@ai-sdk/anthropic', options: { baseURL: server.base.replace('/v1', '/b/v1'), apiKey: 'synthetic-b' },
          models: { 'model-b': { name: 'B', limit: { context: 64000, output: 1024 } } } },
          openai: { npm: '@ai-sdk/openai', options: { baseURL: server.base.replace('/v1', '/wrong/v1'), apiKey: 'synthetic-wrong' },
            models: { 'gpt-5': { name: 'Old model', limit: { context: 64000, output: 1024 } } } } } });
      const run = async (label, args) => { const r = await execute(binary, args, cwd, env); put(path.join(root, 'oc' + major, label + '.json'), r);
        assert.equal(r.code, 0, r.stderr.slice(-5000) || r.stdout.slice(-5000)); return r; };
      if (major === 2) { const credentials = path.join(root, 'oc2/bootstrap.json');
        put(credentials, [{ id: 'cred_qa', integrationID: 'opencode', label: 'QA only', active: true, value: { type: 'key', key: 'synthetic-bootstrap' } }]);
        await run('bootstrap', ['auth', 'import', credentials, '--standalone']); }
      const original = path.join(env.PI_CODING_AGENT_DIR, 'sessions/qa/source.jsonl');
      put(original, codecs.encode('pi', { id: '123e4567-e89b-42d3-a456-426614174123', cwd,
        messages: [{ role: 'user', text: 'SOURCE_USER' }, { role: 'assistant', text: 'SOURCE_ANSWER' }] }).bytes);
      const library = new ProjectConversations({ dataDir: path.join(root, 'oc' + major, 'ass'), crypto: crypt,
        sources: () => [{ harness: 'pi', dir: env.PI_CODING_AGENT_DIR }, { harness: 'opencode', dir: ocDir }] });
      const { project, thread } = await enable(library, cwd), manager = new HarnessManager(path.join(root, 'oc' + major, 'manager'), () => ({ providers: [] }), [], path.join(home, 'codex'), { home, env, launchEnv: env });
      const initial = manager.projectConversationPlan('opencode', cwd);
      const route = await library.prepare(project, thread, 'opencode', ocDir, major, initial.targetModel);
      const command = action => major === 2 ? ['session', action] : [action];
      await run('import', [...command('import'), route.file, ...(major === 2 ? ['--standalone'] : [])]);
      const plan = manager.projectConversationPlan('opencode', cwd, route.sessionId, route.nativeFile);
      const start = server.requests.length;
      await run('resume', ['run', 'TARGET_B_USER', ...plan.args, ...(major === 2 ? ['--standalone'] : [])]);
      const seen = server.requests.slice(start), request = seen.find(r => r.path.startsWith('/b/v1/messages') && r.body.model === 'model-b');
      assert.ok(request, 'no current model B request'); assert.ok(!seen.some(r => r.path.startsWith('/wrong/')), 'historical model was called');
      for (const marker of ['SOURCE_USER', 'SOURCE_ANSWER', 'TARGET_B_USER']) assert.ok(JSON.stringify(request.body.messages).includes(marker), 'missing ' + marker);
      const decoded = codecs.readConversation({ harness: 'opencode', file: path.join(ocDir, 'opencode.db'), sessionId: route.sessionId });
      assert.ok(decoded.messages.some(m => m.text.includes('NATIVE_BLOCK_ZERO'))); await library.sync(project);
      assert.ok(JSON.stringify(await library.preview(project, thread)).includes('NATIVE_BLOCK_ONE'));
      const next = await library.prepare(project, thread, 'opencode', ocDir, major, initial.targetModel);
      assert.equal((await library.prepare(project, thread, 'opencode', ocDir, major, initial.targetModel)).sessionId, next.sessionId);
      put(path.join(root, 'oc' + major, 'wire.json'), { plan: { args: plan.args }, requests: seen, decoded });
      return { args: plan.args, wireModel: request.body.model, wrongProviderCalls: 0, historyPreserved: true };
    });
    await check('Claude Code 2.1.287 multi-block native reply survives ASS and native resume wire', async () => {
      pin(prefix, 'native-claude', '@anthropic-ai/claude-code', '2.1.287');
      const binary = path.join(prefix, 'native-claude/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe');
      const home = path.join(root, 'claude/home'), cwd = path.join(root, 'claude/project'); fs.mkdirSync(cwd, { recursive: true });
      const env = { ...environment(home), ANTHROPIC_API_KEY: 'synthetic-local-only', ANTHROPIC_BASE_URL: server.base.replace('/v1', ''), ANTHROPIC_MODEL: 'claude-sonnet-4-6' };
      const common = ['--output-format', 'json', '--tools', '', '--disable-slash-commands', '--max-turns', '1'];
      const first = await execute(binary, ['-p', 'CLAUDE_SOURCE_USER', ...common, '--system-prompt', 'PRIVATE_SOURCE_SYSTEM'], cwd, env);
      put(path.join(root, 'claude/source-run.json'), first); assert.equal(first.code, 0, first.stderr || first.stdout);
      const library = new ProjectConversations({ dataDir: path.join(root, 'claude/ass'), crypto: crypt, sources: () => [{ harness: 'claude', dir: env.CLAUDE_CONFIG_DIR }] });
      const { project, thread } = await enable(library, cwd), targetDir = path.join(root, 'claude/target'); fs.mkdirSync(targetDir);
      const route = await library.prepare(project, thread, 'claude', targetDir), start = server.requests.length;
      const resumed = await execute(binary, ['--resume', route.sessionId, '-p', 'CLAUDE_TARGET_USER', ...common, '--system-prompt', 'TARGET_SYSTEM'], cwd, { ...env, CLAUDE_CONFIG_DIR: targetDir });
      put(path.join(root, 'claude/resume-run.json'), resumed); assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
      const seen = server.requests.slice(start), request = seen.find(r => r.path.startsWith('/v1/messages'));
      assert.ok(request); const wire = JSON.stringify(request.body.messages);
      assert.ok(wire.includes('NATIVE_BLOCK_ZERO')); assert.ok(wire.includes('NATIVE_BLOCK_ONE'));
      assert.ok(!JSON.stringify(request.body).includes('PRIVATE_SOURCE_SYSTEM')); assert.ok(JSON.stringify(request.body).includes('TARGET_SYSTEM'));
      put(path.join(root, 'claude/wire.json'), { requests: seen, preview: await library.preview(project, thread) });
      return { firstBlock: true, secondBlock: true, sourceSystemNotElevated: true };
    });
  } finally { server.server.closeAllConnections(); server.server.close(); }
  console.log(JSON.stringify({ evidenceRoot: root, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status !== 'pass').length }));
  if (results.some(r => r.status !== 'pass')) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
