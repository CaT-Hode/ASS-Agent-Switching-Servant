// Installed CLI, temporary configuration and synthetic Messages responses only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const { Store } = require('../core/store.cjs');
const { HarnessManager } = require('../core/harnesses.cjs');
const { ConfigManager } = require('../core/config.cjs');
const { ProxyConfig } = require('../core/proxy-config.cjs');
const { Router } = require('../core/router.cjs');
const { modelRef } = require('../core/client-policy.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-claude-defaults-'));
const home = path.join(root, 'home'), data = path.join(root, 'data'), codex = path.join(home, '.codex');
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const store = new Store(data, codex, crypt), calls = [];
for (const [id, model] of [['main', 'claude-opus-4-6'], ['review', 'claude-sonnet-4-6']])
  store.updateProvider({ id, baseUrl: `https://${id}.invalid`, apiKey: 'synthetic-native-key', models: [{ model, wireApi: 'anthropic', contextWindow: 1000000 }] });
const manager = new HarnessManager(data, () => store.state, [], codex, { home, env: {}, launchEnv: { PATH: '' } });
const proxy = manager.options.proxyConfig = new ProxyConfig(data, crypt, manager, store, new ConfigManager(codex, data));
function response(body, content, stop) {
  const message = { id: 'msg_synthetic_' + calls.length, type: 'message', role: 'assistant', model: body.model,
    content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (!body.stream) return new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } },
      { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      { type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const router = new Router({ getState: id => proxy.routingState(id), allowClient: () => true, fetchUpstream: async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ host: new URL(url).hostname, model: body.model });
  if (url.includes('count_tokens')) return new Response('{"input_tokens":10}', { headers: { 'content-type': 'application/json' } });
  if (body.model === 'claude-sonnet-4-6') return response(body, [{ type: 'text', text: '<block>no</block><severity>0</severity>' }], 'end_turn');
  const used = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  return used ? response(body, [{ type: 'text', text: 'ASS_NATIVE_OK' }], 'end_turn')
    : response(body, [{ type: 'tool_use', id: 'tool_synthetic', name: 'Bash', input: { command: `node -e "require('node:fs').writeFileSync('qa-marker.txt','ASS_QA')"`, description: 'Write the isolated QA marker' } }], 'tool_use');
} });
(async () => {
  await router.start(0); manager.options.port = router.port;
  const dir = manager.nativeEnv.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  manager.setInjection('claude', { defaultModel: modelRef('main', 'claude-opus-4-6'), autoModeModel: modelRef('review', 'claude-sonnet-4-6') });
  proxy.sync('claude', true);
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [root]: { hasTrustDialogAccepted: true } } }));
  const binary = process.env.ASS_QA_CLAUDE_BIN || path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  assert.ok(fs.existsSync(binary), 'Set ASS_QA_CLAUDE_BIN to the installed CLI');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|AUTO_MODE_|SUBAGENT_MODEL))/.test(key)) delete env[key];
  const child = spawn(binary, ['--print', 'Use Bash once to write qa-marker.txt with node, then answer ASS_NATIVE_OK.',
    '--permission-mode', 'auto', '--output-format', 'json', '--max-turns', '3', '--debug-file', path.join(root, 'debug.log')],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ binary, root, dir }));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Isolated CLI timed out')); }, 45000);
    child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  fs.writeFileSync(path.join(root, 'stdout.json'), stdout); fs.writeFileSync(path.join(root, 'stderr.log'), stderr);
  assert.equal(code, 0, stderr.slice(-500) || stdout.slice(-500));
  assert.deepEqual(JSON.parse(stdout).permission_denials, [], 'The classifier must approve the isolated tool call');
  assert.ok(Object.hasOwn(JSON.parse(stdout).modelUsage, 'main::claude-opus-4-6[1m]'), 'The native CLI must load the 1M selection');
  assert.ok(calls.some(c => c.host === 'main.invalid' && c.model === 'claude-opus-4-6'), JSON.stringify(calls));
  assert.ok(calls.some(c => c.host === 'review.invalid' && c.model === 'claude-sonnet-4-6'), 'Classifier must reach its independently selected provider: ' + JSON.stringify(calls));
  assert.match(fs.readFileSync(path.join(root, 'debug.log'), 'utf8'), /classifier_request_started[^\n]*model=review::claude-sonnet-4-6\[1m\]/);
  assert.equal(fs.readFileSync(path.join(root, 'qa-marker.txt'), 'utf8'), 'ASS_QA');
  console.log(JSON.stringify({ passed: true, defaultModel: true, independentClassifierRoute: true, nativeAutoMode: true, context1m: true, upstreamSuffixRemoved: true, realCloudCalls: 0, root }));
})().catch(e => { console.error(e); console.error('Evidence: ' + root); process.exitCode = 1; }).finally(() => router.stop());
