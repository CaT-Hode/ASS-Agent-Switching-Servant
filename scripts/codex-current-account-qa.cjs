// Read-only current-account probe. Copies only auth.json to a temporary
// CODEX_HOME and asks app-server for account/read with an account-visible
// custom provider. It never sends an inference request.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const source = path.join(process.env.USERPROFILE, '.codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-current-account-'));
const binaryRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
const binary = fs.readdirSync(binaryRoot).map(entry => path.join(binaryRoot, entry, 'codex.exe')).find(fs.existsSync);
fs.copyFileSync(path.join(source, 'auth.json'), path.join(root, 'auth.json'));
fs.writeFileSync(path.join(root, 'config.toml'), `model_provider = "ASS"\n[model_providers.ASS]\nname = "ASS"\nbase_url = "http://127.0.0.1:25819/clients/ASS/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n`);

const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: root, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
  windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let nextId = 0;
const timer = setTimeout(() => finish({ error: 'account/read timeout' }, 1), 20000);
function finish(result, code = 0) {
  clearTimeout(timer);
  try { child.stdin.end(); } catch {}
  setTimeout(() => child.kill(), 250);
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
    finish({
      accountVisible: Boolean(account),
      accountType: account?.type || null,
      planType: account?.planType || null,
      requiresOpenaiAuth: message.result?.requiresOpenaiAuth ?? null,
      workspaceRouting: Boolean(message.result?.workspaceRouting),
    });
  }
});
child.on('error', error => finish({ error: error.message }, 1));
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ass_current_account_qa', version: '1' } } }) + '\n');
