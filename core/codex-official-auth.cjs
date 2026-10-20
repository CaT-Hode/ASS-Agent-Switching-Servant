// Read/refresh the user's existing Codex grant only for an official request.
// The installed app-server owns refresh rotation; ASS does not reimplement it.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function read(file) {
  if (fs.statSync(file).size > 1024 * 1024) throw Error('Codex 登录记录过大');
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (data.auth_mode && data.auth_mode !== 'chatgpt' || typeof data.tokens?.access_token !== 'string' ||
      !data.tokens.access_token || /\s/.test(data.tokens.access_token) ||
      data.tokens.account_id !== undefined && (typeof data.tokens.account_id !== 'string' || /[\r\n]/.test(data.tokens.account_id)))
    throw Error('未找到 ChatGPT OAuth，请在客户端账户中登录');
  return data.tokens;
}
function expiry(token) {
  try { const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp;
    return Number.isFinite(value) ? value * 1000 : null; } catch { return null; }
}
function executable(env = process.env) {
  const root = path.join(env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try { return fs.readdirSync(root).map(dir => path.join(root, dir, 'codex.exe'))
    .filter(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]; } catch { return null; }
}
function refreshNative(codexDir, { signal, binary = executable(), env = process.env, spawnProcess = spawn } = {}) {
  if (!binary) return Promise.reject(Error('未找到 Codex 原生授权程序，请重新登录官方账户'));
  return new Promise((resolve, reject) => {
    // Command-line overrides apply only to this temporary helper. No sessions
    // or global settings are written and no existing process is terminated.
    const childEnv = { ...env, CODEX_HOME: codexDir };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE']) delete childEnv[key];
    const child = spawnProcess(binary, ['-c', 'model_provider="openai"', '-c', 'openai_base_url="https://api.openai.com/v1"',
      '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', 'app-server', '--listen', 'stdio://'],
    { env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      lines.close(); child.stdin.end();
      // A short-lived helper may keep background transport tasks alive.
      const reap = setTimeout(() => child.kill(), 1000); reap.unref(); child.once('exit', () => clearTimeout(reap));
      error ? reject(error) : resolve();
    };
    const aborted = () => finish(Error('官方授权刷新已取消'));
    const timer = setTimeout(() => finish(Error('官方授权刷新超时，请重新登录')), 20000);
    const lines = createInterface({ input: child.stdout });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', () => finish(Error('官方授权程序连接失败')));
    child.on('error', () => finish(Error('官方授权程序启动失败')));
    child.on('exit', () => finish(Error('官方授权程序已退出')));
    lines.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        if (m.error) return finish(Error('官方授权程序初始化失败'));
        send({ method: 'initialized' }); send({ id: 2, method: 'account/read', params: { refreshToken: true } });
      } else if (m.id === 2) {
        // The native refresh can succeed before a separate workspace lookup
        // fails. The caller re-reads and checks the actual saved grant.
        finish();
      }
    });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return aborted();
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ass_official_auth', version: '1' } } });
  });
}
class CodexOfficialAuth {
  constructor(codexDir, { refresh = refreshNative, now = Date.now } = {}) {
    Object.assign(this, { codexDir, refresh, now }); this.pending = null;
  }
  // Read-only snapshot of the current grant for local request authentication.
  // Never refreshes: the native client owns rotation, and a refresh here would
  // duplicate its network work and race its own auth.json write.
  currentAccessToken() {
    try { return read(path.join(this.codexDir, 'auth.json')).access_token || ''; } catch { return ''; }
  }
  async headers({ signal } = {}) {
    const file = path.join(this.codexDir, 'auth.json');
    let grant;
    try { grant = read(file); } catch { throw Object.assign(Error('未找到 ChatGPT OAuth，请在客户端账户中登录'), { status: 401 }); }
    const exp = expiry(grant.access_token);
    if (exp !== null && exp <= this.now() + 60000) {
      this.pending ||= Promise.resolve().then(() => this.refresh(this.codexDir, { signal })).finally(() => { this.pending = null; });
      try { await this.pending; } catch {
        throw Object.assign(Error('官方授权刷新失败，请重新登录；第三方模型仍可使用'), { status: 401 });
      }
      try { grant = read(file); } catch {
        throw Object.assign(Error('官方登录记录已变化，请重新登录；第三方模型仍可使用'), { status: 401 });
      }
      // An account switch while refresh was pending must use the newly saved
      // grant; no cached access or refresh tokens are stored in this object.
      const freshExpiry = expiry(grant.access_token);
      if (freshExpiry !== null && freshExpiry <= this.now())
        throw Object.assign(Error('官方 OAuth 已过期，请重新登录；第三方模型仍可使用'), { status: 401 });
    }
    return { authorization: 'Bearer ' + grant.access_token, ...(grant.account_id ? { 'chatgpt-account-id': grant.account_id } : {}) };
  }
}
module.exports = { CodexOfficialAuth, refreshNative, expiry };
