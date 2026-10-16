const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { normalizeModel, codexModelId } = require('../core/models.cjs');
const { withOutputLimit, upgradeNativeOutput } = require('../core/output-tokens.cjs');
const { Store } = require('../core/store.cjs');
const { NativeFields, document } = require('../core/native-fields.cjs');
const { NativeConfig } = require('../core/native-config.cjs');
const { ProxyConfig } = require('../core/proxy-config.cjs');
const { routeFor } = require('../core/router.cjs');
const { harnessRoute } = require('../core/harness-route.cjs');
const { convertRequest } = require('../core/adapters.cjs');
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-output-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('128K output is shared across protocols, bounded by context and overridden per model', () => {
  for (const wireApi of ['openai-responses', 'openai-chat', 'anthropic']) {
    assert.equal(normalizeModel({ model: 'custom', wireApi }, {}).maxOutputTokens, 131072);
    assert.equal(normalizeModel({ model: 'custom', wireApi, contextWindow: 64000 }, {}).maxOutputTokens, 64000);
    assert.equal(normalizeModel({ model: 'custom', wireApi, maxOutputTokens: 8192 }, {}).maxOutputTokens, 8192);
  }
});
test('one-time saved-default migration preserves credentials, contexts, custom values and later manual 16K', t => {
  const dir = directory(t), provider = { id: 'p', name: 'p', baseUrl: 'https://example.test/v1',
    enabled: true, secrets: Buffer.from(JSON.stringify({ apiKey: 'synthetic-keep', extraHeaders: {} })).toString('base64'),
    models: [normalizeModel({ model: 'old', maxOutputTokens: 16384, contextWindow: 1048576 }, {}),
      normalizeModel({ model: 'custom', maxOutputTokens: 8192 }, {})] };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ providers: [provider], officialOverrides: {} }));
  const store = new Store(dir, dir, crypt);
  assert.equal(store.state.providers[0].models[0].maxOutputTokens, 131072);
  assert.equal(store.state.providers[0].models[0].contextWindow, 1048576);
  assert.equal(store.state.providers[0].models[1].maxOutputTokens, 8192);
  assert.equal(store.state.providers[0].apiKey, 'synthetic-keep');
  store.model('p', { ...store.state.providers[0].models[0], maxOutputTokens: 16384 }, 'old');
  assert.equal(new Store(dir, dir, crypt).state.providers[0].models[0].maxOutputTokens, 16384);
});
test('native 128K migration modifies only owned model budgets and persists the restore journal', t => {
  const dir = directory(t), file = path.join(dir, 'models.json'), fields = new NativeFields(dir, crypt);
  fs.writeFileSync(file, JSON.stringify({ keep: true }));
  fields.apply('pi', [{ harness: 'pi', file, format: 'json', path: ['providers', 'ass-fixture'],
    value: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', contextWindow: 1048576, maxTokens: 16384 }] } }]);
  const old = { ...fields.state }; delete old.outputTokenDefaultsVersion;
  fs.writeFileSync(fields.file, JSON.stringify({ version: 1, encrypted: Buffer.from(JSON.stringify(old)).toString('base64') }));
  const native = new NativeConfig(dir, crypt, {});
  assert.deepEqual(native.errors, {});
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.keep, true); assert.equal(config.providers['ass-fixture'].models[0].maxTokens, 131072);
  assert.equal(native.fields.entries[0].after.value.models[0].maxTokens, 131072);
  assert.deepEqual(native.fields.entries[0].before, { exists: false });
  const entry = native.fields.entries[0], value = structuredClone(entry.after.value); value.models[0].maxTokens = 16384;
  native.fields.apply('pi', [{ ...entry, value }]);
  assert.equal(new NativeConfig(dir, crypt, {}).fields.entries[0].after.value.models[0].maxTokens, 16384);
});
test('native budget migration refuses externally modified owned fields', t => {
  const dir = directory(t), file = path.join(dir, 'models.json'), fields = new NativeFields(dir, crypt);
  fields.apply('pi', [{ harness: 'pi', file, format: 'json', path: ['providers', 'ass-fixture'],
    value: { models: [{ id: 'm', contextWindow: 1048576, maxTokens: 16384 }] } }]);
  const old = { ...fields.state }; delete old.outputTokenDefaultsVersion;
  fs.writeFileSync(fields.file, JSON.stringify({ version: 1, encrypted: Buffer.from(JSON.stringify(old)).toString('base64') }));
  const config = JSON.parse(fs.readFileSync(file)); config.providers['ass-fixture'].models[0].maxTokens = 20000;
  fs.writeFileSync(file, JSON.stringify(config));
  const native = new NativeConfig(dir, crypt, {});
  assert.match(native.errors.pi, /外部修改/); assert.equal(JSON.parse(fs.readFileSync(file)).providers['ass-fixture'].models[0].maxTokens, 20000);
});
test('all native model schemas receive the same migration without changing custom limits', () => {
  const fixtures = [
    { harness: 'dsh', path: ['llm-pi-ai', 'providers', 'ass-p'], value: { models: [{ id: 'm', contextWindow: 1000000, maxTokens: 16384 }] }, output: v => v.models[0].maxTokens },
    { harness: 'opencode', path: ['provider', 'ass-p'], value: { models: { m: { limit: { context: 1000000, output: 16384 } } } }, output: v => v.models.m.limit.output },
    { harness: 'kimi', path: ['models', 'ass-p'], value: { max_context_size: 1000000, max_output_size: 16384 }, output: v => v.max_output_size },
    { harness: 'zcode', path: ['modelConfigRules'], value: { config: { properties: { contextWindow: 1000000 }, optionSpecs: { maxOutputTokens: { max: 16384 } } } }, output: v => v.config.optionSpecs.maxOutputTokens.max },
  ];
  for (const f of fixtures) assert.equal(f.output(upgradeNativeOutput({ ...f, after: { value: f.value } })), 131072);
});
test('already-applied Claude routing upgrades without changing accountless credentials or native files', t => {
  const dir = directory(t), provider = { id: 'p', enabled: true, apiKey: 'synthetic-keep', models: [normalizeModel({ model: 'm', maxOutputTokens: 16384 }, {})] };
  fs.writeFileSync(path.join(dir, 'proxy-applied.json'), JSON.stringify({ version: 1,
    encrypted: Buffer.from(JSON.stringify({ clients: { claude: { providers: [provider], accountless: true, localToken: 'a'.repeat(64) } }, pending: null })).toString('base64') }));
  const proxy = new ProxyConfig(dir, crypt, {}, {}, {});
  assert.equal(proxy.error, ''); assert.equal(proxy.clients.claude.providers[0].models[0].maxOutputTokens, 131072);
  assert.equal(proxy.clients.claude.localToken, 'a'.repeat(64)); assert.equal(proxy.clients.claude.providers[0].apiKey, 'synthetic-keep');
  assert.equal(new ProxyConfig(dir, crypt, {}, {}, {}).clients.claude.providers[0].models[0].maxOutputTokens, 131072);
});
test('Codex and Claude requests use model limits while retaining smaller explicit budgets and official behavior', () => {
  const model = normalizeModel({ model: 'm', wireApi: 'openai-responses' }, {}), provider = { id: 'p', enabled: true, apiKey: 'synthetic', baseUrl: 'https://example.test/v1', models: [model] }, state = { providers: [provider] };
  assert.equal(routeFor({ model: codexModelId('p', 'm') }, state).body.max_output_tokens, 131072);
  assert.equal(routeFor({ model: codexModelId('p', 'm'), max_output_tokens: 1024 }, state).body.max_output_tokens, 1024);
  assert.equal(routeFor({ model: 'gpt-official' }, state).body.max_output_tokens, undefined);
  assert.equal(routeFor({ model: codexModelId('p', 'm') }, state, '/compact').body.max_output_tokens, undefined);
  const body = { model: 'm' }; harnessRoute('/harness/p/v1/messages', body, state);
  assert.equal(body.max_tokens, 131072);
  const count = { model: 'm' }; model.wireApi = 'anthropic'; harnessRoute('/harness/p/v1/messages/count_tokens', count, state);
  assert.equal(count.max_tokens, undefined);
  assert.equal(withOutputLimit({ max_completion_tokens: 512 }, model, 'openai-chat').max_completion_tokens, 512);
  assert.equal(convertRequest({ input: 'hello', model: 'm' }, {}, 'anthropic').max_tokens, 131072);
  model.maxOutputTokens = 8192;
  assert.equal(routeFor({ model: codexModelId('p', 'm'), max_output_tokens: 20000 }, state).body.max_output_tokens, 8192);
});
