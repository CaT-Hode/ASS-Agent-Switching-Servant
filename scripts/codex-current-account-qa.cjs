// Read-only current-account probe. Copies only auth.json to a temporary
// CODEX_HOME and asks app-server for account/read with the full generated ASS
// injection config. Only account metadata may go online; no inference is sent.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const TOML = require('@iarna/toml');
const { prepareConfig, atomic } = require('../core/config.cjs');
const { makeCatalog } = require('../core/models.cjs');

const source = path.join(process.env.USERPROFILE, '.codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-current-account-'));
const binaryRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
const binary = process.argv[2] || fs.readdirSync(binaryRoot).map(entry => path.join(binaryRoot, entry, 'codex.exe'))
  .filter(fs.existsSync).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw Error('Pass a verified absolute Codex binary path');
const sourceAuth = path.join(source, 'auth.json'), sourceConfig = path.join(source, 'config.toml');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = [sourceAuth, sourceConfig].map(hash);
const auth = fs.readFileSync(sourceAuth);
const workspaceSelected = Boolean(JSON.parse(auth).tokens?.account_id);
atomic(path.join(root, 'auth.json'), auth);
const catalog = path.join(root, 'catalog.json');
atomic(catalog, JSON.stringify(makeCatalog([], [])));
const config = prepareConfig('', catalog, 'http://127.0.0.1:25819/clients/ASS/v1', null, 'a'.repeat(64), true);
atomic(path.join(root, 'config.toml'), config.text);
assert.equal(TOML.parse(config.text).chatgpt_base_url, undefined);
assert.equal(Object.hasOwn(config.replaced, 'chatgpt_base_url'), false);

const childEnv = { ...process.env, CODEX_HOME: root };
for (const key of Object.keys(childEnv)) if (/^(OPENAI_|CHATGPT_|CODEX_(?:API_KEY|ACCESS_TOKEN|INTERNAL|THREAD))/i.test(key)) delete childEnv[key];
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
  env: childEnv,
  cwd: root,
  windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
});
let settled = false;
const timer = setTimeout(() => finish({ error: 'account/read timeout' }, 1), 30000);
async function finish(result, code = 0) {
  if (settled) return; settled = true;
  clearTimeout(timer);
  const exited = new Promise(resolve => child.once('exit', resolve));
  const reap = setTimeout(() => child.kill(), 1000);
  try { child.stdin.end(); } catch {}
  if (child.exitCode === null && child.pid) await exited;
  clearTimeout(reap);
  try { assert.deepEqual([sourceAuth, sourceConfig].map(hash), before); }
  catch { result = { error: 'Native auth/config changed during read-only probe' }; code = 1; }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(JSON.stringify(result));
  process.exitCode = code;
}
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) {
    if (message.error) return finish({ error: 'initialize failed' }, 1);
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } }) + '\n');
  } else if (message.id === 2) {
    if (message.error) return finish({ error: message.error.message }, 1);
    const account = message.result?.account;
    if (!account || account.type !== 'chatgpt' || message.result.requiresOpenaiAuth !== true ||
        workspaceSelected && !message.result.workspaceRouting)
      return finish({ error: 'Full injected config failed native account/workspace check' }, 1);
    finish({
      passed: true,
      fullGeneratedConfig: true,
      accountVisible: Boolean(account),
      accountType: account?.type || null,
      planType: account?.planType || null,
      requiresOpenaiAuth: message.result?.requiresOpenaiAuth ?? null,
      workspaceRouting: Boolean(message.result?.workspaceRouting),
      nativeAuthAndConfigUnchanged: true,
      inferenceRequests: 0,
    });
  }
});
child.on('error', error => finish({ error: error.message }, 1));
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ass_current_account_qa', version: '1' } } }) + '\n');
