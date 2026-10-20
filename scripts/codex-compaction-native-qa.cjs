// Opt-in installed Codex app-server contract. Synthetic credentials, history and
// upstream only; never opens or changes the user's desktop or native profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process'), { createInterface } = require('node:readline');
const { EventEmitter, once } = require('node:events'), assert = require('node:assert/strict');
const { Router } = require('../core/router.cjs'), { makeCatalog, codexModelId } = require('../core/models.cjs');
const TOML = require('@iarna/toml');

async function main() {
  const binary = process.argv[2];
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw Error('Pass an absolute installed Codex binary path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-native-compaction-'));
  const home = path.join(root, 'home'), work = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(work);
  const key = crypto.randomBytes(32), encryption = {
    isEncryptionAvailable: () => true,
    encryptString: text => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]); },
    decryptString: bytes => { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]).toString('utf8'); },
  };
  const provider = { id: 'synthetic', name: 'Synthetic', enabled: true, apiKey: 'synthetic-key', baseUrl: 'https://upstream.invalid',
    models: [{ model: 'compact-fixture', displayName: 'Compaction fixture', wireApi: 'openai-responses', enabled: true,
      contextWindow: 500000, efforts: ['low'], defaultEffort: 'low', maxOutputTokens: 4096 }] };
  const model = codexModelId(provider.id, 'compact-fixture'), calls = [], logs = [];
  const router = new Router({ compactionCrypto: encryption, getState: () => ({ providers: [provider] }), log: row => logs.push(row),
    fetchUpstream: async (url, init) => {
      assert.equal(url, 'https://upstream.invalid/v1/responses');
      assert.equal(init.headers.authorization, 'Bearer synthetic-key');
      const body = JSON.parse(init.body), compact = body.instructions?.includes('Create a compact continuation checkpoint');
      calls.push({ compact, checkpointReplayed: JSON.stringify(body.input).includes('ASS_COMPACT_SYNTHETIC_CHECKPOINT'),
        rawCheckpointSent: JSON.stringify(body.input).includes('ass-compaction-v1:') });
      const message = { type: 'message', id: 'msg_' + calls.length, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: compact ? 'ASS_COMPACT_SYNTHETIC_CHECKPOINT: goal and local evidence retained.' : 'OK', annotations: [] }] };
      const output = compact ? [{ type: 'reasoning', id: 'rs_fixture', summary: [], content: [{ type: 'reasoning_text', text: 'synthetic private thought' }] }, message] : [message];
      const response = { id: 'resp_' + calls.length, object: 'response', status: 'completed', output, model: body.model,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        ...output.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item },
          ...(item.type === 'message' ? [{ type: 'response.output_text.delta', output_index, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
          { type: 'response.output_item.done', output_index, item }]), { type: 'response.completed', response }];
      return new Response(events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  let child;
  try {
    await router.start(0);
    const catalog = path.join(home, 'catalog.json'), generated = makeCatalog([], [provider]);
    fs.writeFileSync(catalog, JSON.stringify(generated));
    fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model_provider: 'ASS', model, model_catalog_json: catalog,
      model_post_turn_compact_threshold_percent: 0, analytics: { enabled: false },
      features: { connectors: false },
      mcp_servers: { rea: { command: process.execPath, args: ['--version'], enabled: false } },
      model_providers: { ASS: { name: 'ASS', wire_api: 'responses', base_url: `http://127.0.0.1:${router.port}/clients/ASS/v1`,
        requires_openai_auth: false, experimental_bearer_token: 'synthetic-local', supports_websockets: false,
        capabilities: { remote_compaction: 'v2' } } } }));
    const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      TEMP: root, TMP: root, TMPDIR: root, TERM: 'dumb', NO_COLOR: '1', DO_NOT_TRACK: '1',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
    env.PATH = [path.dirname(process.execPath), path.join(env.SystemRoot || '/usr', 'System32')].join(path.delimiter);
    const get = spawnSync(binary, ['mcp', 'get', 'rea', '--json'], { cwd: work, env, windowsHide: true, encoding: 'utf8', timeout: 20000 });
    assert.equal(get.status, 0, 'codex mcp get: ' + get.stderr);
    assert.equal(JSON.parse(get.stdout).name, 'rea');
    child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: work, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const bus = new EventEmitter(), pending = new Map(), notifications = []; let next = 1, stderr = '';
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-12000); });
    child.on('error', error => bus.emit('failure', error));
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      let row; try { row = JSON.parse(line); } catch { return; }
      if (row.id != null && pending.has(row.id)) { const done = pending.get(row.id); pending.delete(row.id); done(row); }
      else if (row.method) { notifications.push(row); bus.emit('notification'); }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out: ' + stderr.slice(-2000))); }, 20000);
      pending.set(id, row => { clearTimeout(timer); row.error ? reject(Error(method + ': ' + JSON.stringify(row.error))) : resolve(row.result); });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const wait = async predicate => {
      const deadline = Date.now() + 20000;
      while (true) {
        const index = notifications.findIndex(predicate);
        if (index >= 0) return notifications.splice(index, 1)[0];
        if (Date.now() >= deadline) throw Error('Native notification timed out: ' + stderr.slice(-2000));
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); bus.off('notification', finish); resolve(); };
          const timer = setTimeout(finish, 250); bus.once('notification', finish);
        });
      }
    };
    const init = await rpc('initialize', { clientInfo: { name: 'ass_compaction_qa', version: '1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const started = await rpc('thread/start', { cwd: work, model, modelProvider: 'ASS', approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    const turn = async text => {
      const value = await rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      const done = await wait(row => row.method === 'turn/completed' && row.params.turn.id === value.turn.id);
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error));
    };
    await turn('Synthetic seed. Reply OK without tools.');
    for (let i = 0; i < 2; i++) {
      await rpc('thread/compact/start', { threadId });
      const done = await wait(row => row.method === 'item/completed' && row.params.item.type === 'contextCompaction');
      const compactTurn = await wait(row => row.method === 'turn/completed' && row.params.turn.id === done.params.turnId);
      assert.equal(compactTurn.params.turn.status, 'completed', JSON.stringify(compactTurn.params.turn.error));
      await turn('Continue synthetic seed. Reply OK without tools.');
      assert.equal(calls.at(-1).checkpointReplayed, true);
    }
    assert.equal(calls.filter(call => call.compact).length, 2);
    assert.equal(calls.some(call => call.rawCheckpointSent), false);
    assert.equal(logs.filter(row => row.operation === 'compaction' && row.taskOk).length, 2);
    console.log(JSON.stringify({ passed: true, nativeVersion: init.userAgent, fullCatalogModels: generated.models.length,
      mcpGet: true, compactions: 2, continuations: 2,
      realCredentialsUsed: false, externalInference: false, runningDesktopTouched: false }));
  } catch (error) {
    console.error('Native contract: ' + error.message);
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) {
        const closed = once(child, 'close'); child.kill();
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
      }
    }
    await router.stop();
    const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('ass-native-compaction-')) throw Error('Unexpected fixture cleanup path');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
    catch { console.error('Synthetic fixture remains locked: ' + resolved); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
