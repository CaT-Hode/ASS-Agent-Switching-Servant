// Native Codex -> ASS -> simulated Gemini Anthropic transport. No cloud calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const { Router } = require('../core/router.cjs');
const { atomic, prepareConfig } = require('../core/config.cjs');
const { normalizeProvider, makeCatalog, codexModelId } = require('../core/models.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-gemini-search-'));
const home = path.join(root, 'home'), codex = path.join(home, '.codex'); fs.mkdirSync(codex, { recursive: true });
const binary = process.env.ASS_QA_CODEX_BIN;
assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), 'Set ASS_QA_CODEX_BIN to the installed native binary');
const provider = normalizeProvider({ id: 'fixture', name: 'Gemini fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-provider-key',
  models: [{ model: 'gemini-fixture', wireApi: 'anthropic' }] });
const calls = [], logs = [];
const router = new Router({ getState: () => ({ providers: [provider] }), log: row => logs.push(row), fetchUpstream: async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ url, body });
  const events = [{ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'GEMINI_DOCUMENT_OK' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
(async () => {
  await router.start(0);
  const catalog = path.join(root, 'catalog.json'); atomic(catalog, JSON.stringify(makeCatalog([], [provider])));
  atomic(path.join(codex, 'config.toml'), prepareConfig('', catalog, `http://127.0.0.1:${router.port}/clients/ASS/v1`).text + '\nweb_search="live"\n');
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'fixture', exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'pro' } })).toString('base64url') + '.fixture';
  atomic(path.join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'synthetic', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() }));
  const env = { ...process.env, CODEX_HOME: codex, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'),
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-c', 'web_search="live"',
      '-m', codexModelId(provider.id, 'gemini-fixture'), 'Rewrite the provided local document. No web research is needed.'], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = ''; child.stdout.on('data', b => { output = (output + b).slice(-32000); }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-12000); });
    const timer = setTimeout(() => child.kill(), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr); assert.match(result.output, /GEMINI_DOCUMENT_OK/);
  assert.ok(calls.length > 0); assert.ok(calls.every(c => c.url === 'https://fixture.invalid/v1/messages'));
  assert.ok(calls.every(c => c.body.system.includes('Native web search is unavailable') && c.body.tools?.length));
  assert.ok(logs.some(row => row.ok && row.omittedTools?.includes('web_search')), 'Must exercise an actual native search declaration');
  console.log(JSON.stringify({ passed: true, nativeSearchDeclared: true, anthropicRequestCompleted: true, nativeToolsRetained: true, realCloudCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await router.stop();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('ass-gemini-search-')) throw Error('Unexpected QA cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
});
