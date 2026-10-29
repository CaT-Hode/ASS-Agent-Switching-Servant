const { test } = require('node:test'), assert = require('node:assert/strict');
const { projection, planFiles } = require('../core/wsl-sync.cjs');
const TOML = require('@iarna/toml');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { WslSync } = require('../core/wsl-sync.cjs');
const info = { dirs: { codex: '/home/test/.codex', claude: '/home/test/.claude', pi: '/home/test/.pi/agent' },
  binaries: { codex: '/usr/bin/codex', claude: '/usr/bin/claude', pi: '' } };
const base = 'http://127.0.0.1:41001';
const provider = { id: 'relay', name: 'Relay', enabled: true, apiKey: 'synthetic-only',
  models: [{ model: 'claude-sonnet-4-6', enabled: true, wireApi: 'anthropic', contextWindow: 1000000 }] };
test('WSL projections use Linux paths and gateway auth, keep CC 1M choices and pi native API fields', () => {
  const rows = projection('codex', { model: 'gpt-fixture', effort: 'high', plan: {
    localToken: 'synthetic-local', catalog: { models: [{ slug: 'gpt-fixture' }] } } }, info, base);
  const contents = { [rows[0].file]: 'model_provider="mify"\nmodel_context_window=32000\n[mcp_servers.local]\ncommand="node"\n',
    [rows[1].file]: '{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-old"}}' };
  const plan = planFiles(rows, [], contents), config = TOML.parse(plan.files[0].after);
  assert.equal(config.model_catalog_json, '/home/test/.codex/ass-models.json');
  assert.equal(config.cli_auth_credentials_store, 'file');
  assert.equal(config.model_context_window, undefined);
  assert.equal(JSON.parse(plan.files.find(f => f.file.endsWith('/auth.json')).after).OPENAI_API_KEY, 'synthetic-local');
  assert.equal(JSON.parse(plan.files.find(f => f.file.endsWith('/auth.json')).after).tokens, undefined);
  assert.equal(config.mcp_servers.local.command, 'node');
  assert.ok(plan.files.every(f => !/sessions|state_\d|history/.test(f.file)));
  const cc = projection('claude', { token: 'synthetic-local', plan: { providers: [provider],
    defaultModel: { model: 'relay::claude-sonnet-4-6' } } }, info, base);
  const ccPlan = planFiles(cc, [], { [cc[0].file]: '{"env":{"KEEP":"kept"},"permissions":{"deny":["Bash(rm *)"]}}' });
  const settings = JSON.parse(ccPlan.files[0].after);
  assert.equal(settings.model, 'relay::claude-sonnet-4-6[1m]');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, base + '/clients/claude/models');
  assert.equal(settings.env.KEEP, 'kept');assert.deepEqual(settings.permissions.deny, ['Bash(rm *)']);
  const pi = projection('pi', { files: [{ name: 'models.json', fields: [{ keys: ['providers', 'ass-fixture'], value: { baseUrl: 'https://fixture.invalid' } }] }] }, info, base);
  assert.equal(pi[0].file, '/home/test/.pi/agent/models.json');
  assert.equal(pi[0].fields[0].value.baseUrl, 'https://fixture.invalid');
});
test('WSL field updates and withdrawal preserve unrelated edits and refuse to overwrite changed owned fields', () => {
  const desired = [{ file: '/home/test/.claude/settings.json', format: 'json', fields: [{ keys: ['model'], value: 'ass-model' }] }];
  const original = '{"model":"original","permissions":{"deny":["Bash(rm *)"]}}';
  const applied = planFiles(desired, [], { [desired[0].file]: original });
  const modified = JSON.stringify({ ...JSON.parse(applied.files[0].after), theme: 'dark' });
  const restored = planFiles([], applied.records, { [desired[0].file]: modified });
  assert.equal(JSON.parse(restored.files[0].after).model, 'original');
  assert.equal(JSON.parse(restored.files[0].after).theme, 'dark');
  assert.throws(() => planFiles(desired, applied.records, { [desired[0].file]: '{"model":"external"}' }), /外部修改/);
  assert.equal(planFiles([], applied.records, { [desired[0].file]: applied.files[0].after }).files[0].after, original);
});

test('pi retains public provider routes and maps Windows localhost HTTP providers with their paths intact', async () => {
  const ports = [], source = { files: [{ name: 'models.json', fields: [
    { keys: ['providers', 'local'], value: { baseUrl: 'http://localhost:11434/v1', apiKey: '$ASS_PI_AUTH_REQUIRED' } },
    { keys: ['providers', 'public'], value: { baseUrl: 'https://fixture.invalid/v1' } },
  ] }] };
  const mapped = await WslSync.prototype.piSource.call({ bridge: async port => { ports.push(port);return base; } }, source);
  assert.deepEqual(ports, [11434]);
  assert.equal(mapped.files[0].fields[0].value.baseUrl, base + '/v1');
  assert.equal(mapped.files[0].fields[0].value.apiKey, '$ASS_PI_AUTH_REQUIRED');
  assert.equal(mapped.files[0].fields[1].value.baseUrl, source.files[0].fields[1].value.baseUrl);
  assert.equal(source.files[0].fields[0].value.baseUrl, 'http://localhost:11434/v1');
});
test('automatic WSL sync follows applied model changes and can restore original login without moving sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-wsl-sync-'));
  const files = { '/home/test/.codex/config.toml': 'model="old"\n',
    '/home/test/.codex/auth.json': '{"OPENAI_API_KEY":"synthetic-old","auth_mode":"apikey"}',
    '/home/test/.codex/sessions/keep.jsonl': 'original conversation' };
  const original = { ...files }, plan = { localToken: 'synthetic-local', catalog: { models: [] } };
  let model = 'first', available = true;
  const sync = new WslSync({ dataDir: root,
    crypto: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    sources: () => ({ codex: available ? { model, plan } : null }), port: 25819,
    run: async (distro, input) => {
      if (input.action === 'inspect') return info;
      if (input.action === 'read') return Object.fromEntries(input.files.map(name => [name, files[name] ?? null]));
      if (input.action === 'write') for (const row of input.files) {
        assert.ok(!/sessions|history|state_\d/.test(row.file));
        if (row.after === null) delete files[row.file]; else files[row.file] = row.after;
      }
      return {};
    } });
  sync.bridge = async () => base;
  t.after(() => { sync.stop();fs.rmSync(root, { recursive: true, force: true }); });
  await sync.configure('codex', { enabled: true });
  assert.equal(TOML.parse(files['/home/test/.codex/config.toml']).model, 'first');
  sync.start();await new Promise(resolve => setTimeout(resolve, 50));model = 'second';
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.equal(TOML.parse(files['/home/test/.codex/config.toml']).model, 'second');
  assert.ok(!JSON.stringify(sync.public()).includes('synthetic-local'));
  available = false;
  sync.bridge = async () => { throw Error('Disconnected Windows route must not be required for withdrawal'); };
  await sync.sync();assert.deepEqual(files, original);
  assert.equal(sync.public().clients.codex.status, '等待 Windows 接入');
  await sync.configure('codex', { enabled: false });assert.deepEqual(files, original);
});

test('an interrupted multi-file WSL write restores its original fields before accepting a new sync', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-wsl-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { '/home/test/.codex/config.toml': 'model="incomplete"\n', '/home/test/.codex/auth.json': '{"auth_mode":"apikey"}' };
  const original = { ...files, '/home/test/.codex/config.toml': 'model="original"\n' };
  const sync = new WslSync({ dataDir: root, sources: () => ({}), port: 25819,
    crypto: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    run: async (distro, input) => {
      if (input.action === 'read') return { ...files };
      for (const file of input.files) files[file.file] = file.after;
    } });
  sync.state.pending = { id: 'codex', records: [], files: Object.entries(original).map(([file, before]) => ({ file, before,
    after: file.endsWith('config.toml') ? 'model="incomplete"\n' : '{"auth_mode":"apikey","OPENAI_API_KEY":"incomplete"}' })) };
  sync.save();await sync.recover();
  assert.deepEqual(files, original);assert.equal(sync.state.pending, undefined);
});
