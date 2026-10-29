// Real Ubuntu CLIs and interop TCP relay; synthetic upstreams, isolated homes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { execFile } = require('node:child_process');
const { Router } = require('../core/router.cjs');
const { WslSync } = require('../core/wsl-sync.cjs');
const { makeCatalog } = require('../core/models.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-wsl-qa-'));
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const token = '8'.repeat(64), calls = [];
let isolatedBridge, isolatedHome, passed = false;
const provider = { id: 'fixture', name: 'WSL fixture', enabled: true, apiKey: 'synthetic-provider', baseUrl: 'https://fixture.invalid/v1',
  models: [{ model: 'claude-sonnet-4-6', enabled: true, wireApi: 'anthropic', contextWindow: 1000000 }] };
const catalogue = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'AI Switch Servant/catalog.json'), 'utf8'));
const sources = {
  codex: { model: 'gpt-6-astra', plan: { gatewayAuth: true, localToken: token, catalog: makeCatalog(catalogue.models, [], {}) } },
  claude: { token, plan: { accountless: true, localToken: token, providers: [provider], defaultModel: { model: 'fixture::claude-sonnet-4-6' } } },
};
function mock(url, init) {
  const body = JSON.parse(init.body); calls.push({ path: new URL(url).pathname, model: body.model });
  if (url.includes('count_tokens')) return new Response('{"input_tokens":10}', { headers: { 'content-type': 'application/json' } });
  if (url.includes('messages')) {
    const message = { id: 'msg_synthetic', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'WSL_NATIVE_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } };
    if (!body.stream) return new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
    return sse([{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WSL_NATIVE_OK' } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' }]);
  }
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'WSL_NATIVE_OK', annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
  return sse([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'WSL_NATIVE_OK' },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]);
}
const sse = rows => new Response(rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const router = new Router({ getState: id => id === 'claude' ? { ...sources.claude.plan, providers: [provider] } : { ...sources.codex.plan, providers: [] },
  getOfficialAuth: async () => ({ authorization: 'Bearer synthetic-official' }), fetchUpstream: mock });
function run(args) {
  return new Promise((resolve, reject) => {
    const child = execFile('wsl.exe', ['-d', 'Ubuntu', '--', ...args],
      { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 ** 2 }, (error, stdout, stderr) => error ? reject(Error((stderr + stdout).slice(-1600))) : resolve(stdout));
    child.stdin.end();
  });
}
(async () => {
  await router.start(0);
  const sync = new WslSync({ dataDir: root, crypto: crypt, sources: () => sources, port: router.port,
    executable: process.env.ASS_WSL_QA_EXECUTABLE || process.execPath });
  const bridgeName = '.cache/ass-wsl-bridge-' + Date.now();
  sync.helper = sync.helper.replace("ROOT = Path.home() / '.local/share/ass'", "ROOT = Path.home() / '" + bridgeName + "'");
  const agent = sync.run;
  const native = await agent('Ubuntu', { action: 'inspect' });
  const home = native.home + '/.cache/ass-wsl-qa-' + Date.now();
  isolatedBridge = native.home + '/' + bridgeName;isolatedHome = home;
  const info = { ...native, dirs: { codex: home + '/codex', claude: home + '/claude', pi: home + '/pi' } };
  sync.run = (distro, data) => data.action === 'inspect' ? Promise.resolve(info) : agent(distro, data);
  const originalAuth = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: 'synthetic-original-oauth', id_token: 'synthetic-original-id', refresh_token: 'synthetic-original-refresh' } });
  const authFile = info.dirs.codex + '/auth.json';
  await agent('Ubuntu', { action: 'write', files: [{ file: authFile,
    beforeHash: require('../core/native-fields.cjs').hash(null), after: originalAuth }] });
  await sync.configure('codex', { enabled: true });
  await sync.configure('claude', { enabled: true });
  assert.equal(sync.public().clients.codex.error, '');assert.equal(sync.public().clients.claude.error, '');
  const env = ['env', 'PATH=' + path.posix.dirname(info.binaries.codex) + ':/usr/bin:/bin'];
  const codex = await run([...env, 'CODEX_HOME=' + info.dirs.codex, info.binaries.codex,
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', 'Reply WSL_NATIVE_OK.']);
  assert.match(codex, /WSL_NATIVE_OK/);
  const profile = info.dirs.claude + '/.claude.json';
  await agent('Ubuntu', { action: 'write', files: [{ file: profile, beforeHash: require('../core/native-fields.cjs').hash(null), after: '{"hasCompletedOnboarding":true}' }] });
  const claude = await run([...env, 'CLAUDE_CONFIG_DIR=' + info.dirs.claude, info.binaries.claude,
    '--print', 'Reply WSL_NATIVE_OK.', '--output-format', 'json']);
  assert.match(claude, /WSL_NATIVE_OK/);
  assert.ok(calls.some(c => c.model === 'gpt-6-astra')); assert.ok(calls.some(c => c.model === 'claude-sonnet-4-6'));
  await sync.configure('codex', { enabled: false });await sync.configure('claude', { enabled: false });
  assert.equal((await agent('Ubuntu', { action: 'read', files: [authFile] }))[authFile], originalAuth);
  passed = true;
  console.log(JSON.stringify({ passed: true, nativeCodex: true, nativeClaude: true, NATBridge: true, suffixRemoved: true,
    originalOAuthRestored: true, packagedRelay: !!process.env.ASS_WSL_QA_EXECUTABLE, realCloudCalls: 0, isolatedHome: home }));
})().catch(error => { console.error(error.message); console.error('Evidence: ' + root); process.exitCode = 1; }).finally(async () => {
  await router.stop();
  if (isolatedBridge) await run(['python3', '-c', `
from pathlib import Path
import json,os,signal,shutil,sys
root=Path(sys.argv[1]); home=Path(sys.argv[2]); cache=Path.home()/'.cache'
assert root.parent==cache and root.name.startswith('ass-wsl-bridge-')
assert home.parent==cache and home.name.startswith('ass-wsl-qa-')
for state in root.glob('*/bridge-state.json'):
 pid=json.loads(state.read_text())['pid']; cmd=Path('/proc')/str(pid)/'cmdline'
 if cmd.exists() and str(root).encode() in cmd.read_bytes() and b'wsl-agent.py' in cmd.read_bytes(): os.kill(pid,signal.SIGTERM)
if sys.argv[3]=='passed':
 shutil.rmtree(root);shutil.rmtree(home)
`, isolatedBridge, isolatedHome, passed ? 'passed' : 'failed']);
  if (passed) fs.rmSync(root, { recursive: true, force: true });
});
