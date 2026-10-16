// Read-only diagnosis of official project-list connectivity. Prints status and
// response classification only, never OAuth, project names or conversations.
const { app, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-project-network-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.codex/auth.json'), 'utf8'));
  if (!auth.tokens?.access_token || /\s/.test(auth.tokens.access_token)) throw Error('Native OAuth unavailable');
  const latest = path.join(process.env.LOCALAPPDATA, 'Codex/Logs/2026/10/16');
  const log = fs.readdirSync(latest).filter(n => n.includes('-t0-')).map(n => path.join(latest, n))
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const project = /url=(\/gizmos\/g-p-[a-f0-9]+\/conversations)(?:\?|\s)/.exec(fs.readFileSync(log, 'utf8'))?.[1];
  if (!project) throw Error('No observed project-list endpoint');
  const transport = session.fromPartition('ass-project-network');
  await transport.setProxy({ mode: 'system' });
  const results = [];
  for (const [kind, endpoint] of [['workspace', '/wham/accounts/check'], ['project', project]]) {
    const url = 'https://chatgpt.com/backend-api' + endpoint;
    const response = await transport.fetch(url, { headers: {
      authorization: 'Bearer ' + auth.tokens.access_token,
      ...(auth.tokens.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}),
      accept: 'application/json', originator: 'codex_desktop_rs',
    }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const body = await response.text();
    let data; try { data = JSON.parse(body); } catch {}
    results.push({ kind, status: response.status, contentType: response.headers.get('content-type'),
      cloudflareChallenge: /_cf_chl_opt|cloudflare_challenge|Enable JavaScript and cookies/.test(body),
      json: data !== undefined,
      responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0,12) : [],
      cfRay: response.headers.get('cf-ray') });
  }
  console.log(JSON.stringify({ transport: 'Electron system session.fetch', results, inferenceRequests: 0 }));
}).catch(error => { console.error(JSON.stringify({ error: error.name === 'TimeoutError' ? 'Timeout' : error.message }));
  process.exitCode = 1;
}).finally(() => {
  // Electron can hold its own temporary network cache until process exit.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  app.exit(process.exitCode || 0);
});
