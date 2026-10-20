// Installed app-server contract with synthetic DeepSeek events and credentials.
// Does not open the desktop, execute tools, or contact a model service.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
const { EventEmitter, once } = require('node:events'), assert = require('node:assert/strict');
const { Router } = require('../core/router.cjs'), { makeCatalog, codexModelId } = require('../core/models.cjs');
const TOML = require('@iarna/toml');

async function main() {
  const binary = process.argv[2], expectResidual = process.argv.includes('--expect-residual');
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw Error('Pass an absolute installed Codex binary path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-native-reasoning-'));
  const home = path.join(root, 'home'), work = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(work);
  const key = crypto.randomBytes(32), encryption = {
    isEncryptionAvailable: () => true,
    encryptString: text => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]); },
    decryptString: bytes => { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]).toString('utf8'); },
  };
  const thought = 'ASS_SYNTHETIC_THOUGHT', answer = 'ASS_SYNTHETIC_ANSWER';
  const provider = { id: 'synthetic', name: 'Synthetic', enabled: true, apiKey: 'synthetic-key', baseUrl: 'https://api.deepseek.com',
    models: [{ model: 'reason-fixture', displayName: 'Reasoning fixture', wireApi: 'openai-responses', enabled: true,
      contextWindow: 500000, efforts: ['high'], defaultEffort: 'high' }] };
  const model = codexModelId(provider.id, 'reason-fixture'), calls = [];
  const router = new Router({ compactionCrypto: encryption, getState: () => ({ providers: [provider] }),
    fetchUpstream: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/v1/responses');
      const body = JSON.parse(init.body); calls.push(body);
      const index = calls.length, reason = { type: 'reasoning', id: 'rs_' + index, summary: [],
        content: [{ type: 'reasoning_text', text: thought }] };
      const message = { type: 'message', id: 'msg_' + index, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }] };
      const response = { id: 'resp_' + index, object: 'response', status: 'completed', model: body.model,
        output: [reason, message], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } };
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...reason, content: [] } },
        { type: 'response.reasoning_text.delta', item_id: reason.id, output_index: 0, content_index: 0, delta: thought },
        { type: 'response.reasoning_text.done', item_id: reason.id, output_index: 0, content_index: 0, text: thought },
        { type: 'response.output_item.done', output_index: 0, item: reason },
        { type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 1, content_index: 0, delta: answer },
        { type: 'response.output_item.done', output_index: 1, item: message },
        { type: 'response.completed', response }];
      return new Response(events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  let child;
  try {
    await router.start(0);
    const catalog = path.join(home, 'catalog.json');
    fs.writeFileSync(catalog, JSON.stringify(makeCatalog([], [provider])));
    fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model_provider: 'ASS', model, model_catalog_json: catalog,
      model_post_turn_compact_threshold_percent: 0, analytics: { enabled: false }, features: { connectors: false },
      model_providers: { ASS: { name: 'ASS', wire_api: 'responses', base_url: `http://127.0.0.1:${router.port}/clients/ASS/v1`,
        requires_openai_auth: false, experimental_bearer_token: 'synthetic-local', supports_websockets: false } } }));
    const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      TEMP: root, TMP: root, TERM: 'dumb', NO_COLOR: '1', DO_NOT_TRACK: '1',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
    env.PATH = [path.dirname(process.execPath), path.join(env.SystemRoot || '/usr', 'System32')].join(path.delimiter);
    child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: work, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const bus = new EventEmitter(), pending = new Map(), notifications = []; let next = 1, stderr = '';
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      let row; try { row = JSON.parse(line); } catch { return; }
      if (row.id != null && pending.has(row.id)) { const done = pending.get(row.id); pending.delete(row.id); done(row); }
      else if (row.method) { notifications.push(row); bus.emit('notification'); }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out: ' + stderr.slice(-1500))); }, 20000);
      pending.set(id, row => { clearTimeout(timer); row.error ? reject(Error(method + ': ' + JSON.stringify(row.error))) : resolve(row.result); });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const wait = async predicate => {
      const deadline = Date.now() + 20000;
      while (true) {
        const row = notifications.find(predicate); if (row) return row;
        if (Date.now() >= deadline) throw Error('Native notification timed out: ' + stderr.slice(-1500));
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); bus.off('notification', finish); resolve(); };
          const timer = setTimeout(finish, 250); bus.once('notification', finish);
        });
      }
    };
    const init = await rpc('initialize', { clientInfo: { name: 'ass_reasoning_qa', version: '1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const started = await rpc('thread/start', { cwd: work, model, modelProvider: 'ASS', approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    for (let i = 0; i < 2; i++) {
      const value = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the synthetic answer without tools.', text_elements: [] }] });
      const turnId = value.turn.id;
      const done = await wait(row => row.method === 'turn/completed' && row.params.turn.id === turnId);
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error));
      const complete = await wait(row => row.method === 'item/completed' && row.params.turnId === turnId && row.params.item.type === 'reasoning');
      assert.deepEqual(complete.params.item.content, expectResidual ? [thought] : [], 'Completed reasoning should no longer contain display text');
      assert.deepEqual(complete.params.item.summary, []);
      assert(notifications.some(row => row.method === 'item/reasoning/textDelta' && row.params.turnId === turnId && row.params.delta === thought), 'Live thinking should remain visible');
      assert(notifications.some(row => row.method === 'item/completed' && row.params.turnId === turnId && row.params.item.type === 'agentMessage' && row.params.item.text === answer), 'Final answer must remain intact');
    }
    assert(calls[1].input.some(item => item.type === 'reasoning' && item.content?.[0]?.text === thought), 'Next turn must replay the original reasoning');
    assert(!JSON.stringify(calls).includes('ass-reasoning-v1:'), 'No ASS capsule may reach the upstream');
    const read = await rpc('thread/read', { threadId, includeTurns: true });
    const retained = read.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'reasoning');
    assert.equal(retained.length, 2);
    assert(retained.every(item => JSON.stringify(item.content) === JSON.stringify(expectResidual ? [thought] : [])), 'Thread reload should keep completed reasoning hidden');
    console.log(JSON.stringify({ passed: true, nativeVersion: init.userAgent, residualReproduced: expectResidual,
      liveThinking: true, continuations: 2, threadReload: true, realCredentialsUsed: false, externalInference: false, runningDesktopTouched: false }));
  } finally {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]); }
    }
    await router.stop();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ass-native-reasoning-')) throw Error('Unexpected fixture cleanup path');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
    catch { console.error('Synthetic fixture remains locked: ' + resolved); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
