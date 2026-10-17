const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const TOML = require('@iarna/toml');
const { Store } = require('../core/store.cjs');
const { ConfigManager, atomic } = require('../core/config.cjs');
const { HarnessManager } = require('../core/harnesses.cjs');
const { ProxyConfig } = require('../core/proxy-config.cjs');
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-codex-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), codex = path.join(root, 'codex');
  const original = 'model = "gpt-original"\nmodel_reasoning_effort = "high"\n[features]\nkeep = true\n';
  atomic(path.join(codex, 'config.toml'), original);
  atomic(path.join(codex, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-only"}}');
  const store = new Store(data, codex, crypt);
  store.updateProvider({ id: 'relay', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', models: [{ model: 'one', wireApi: 'openai-chat' }] });
  const manager = new HarnessManager(data, () => store.state, store.officialModels, codex, { home: root, env: {}, launchEnv: { PATH: '' }, isConnected: () => true });
  const reload = () => {
    const config = new ConfigManager(codex, data), proxy = new ProxyConfig(data, crypt, manager, store, config);
    return { config, proxy };
  };
  const f = { root, data, codex, original, store, manager, reload, ...reload() };
  f.proxy.sync('codex');
  f.legacy = () => { const legacy = structuredClone(f.proxy.clients.codex); delete legacy.attachment; f.proxy.persist({ codex: legacy }); };
  f.dropCheckpoints = () => { for (const file of [f.proxy.codexRecovery.file, f.proxy.codexRecovery.previous]) if (fs.existsSync(file)) fs.unlinkSync(file); };
  f.snapshot = () => [f.config.file, f.config.catalog, path.join(codex, 'auth.json'), path.join(data, 'settings.json')].map(file => fs.readFileSync(file));
  return f;
}

test('legacy missing record is rebuilt from a unique native baseline, without applying drafts or changing native config', t => {
  const f = fixture(t), owned = JSON.parse(fs.readFileSync(f.config.record, 'utf8'));
  f.legacy(); f.dropCheckpoints(); fs.unlinkSync(f.config.record);
  f.store.updateProvider({ ...f.store.state.providers[0], baseUrl: 'https://unapplied.invalid/v1' });
  const before = f.snapshot(), { config, proxy } = f.reload();
  assert.equal(proxy.recoveryError, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.record, 'utf8')), owned);
  assert.deepEqual(proxy.clients.codex.attachment, owned);
  assert.equal(proxy.clients.codex.providers[0].baseUrl, 'https://fixture.invalid/v1');
  assert.deepEqual(f.snapshot(), before);
  const journal = fs.readFileSync(proxy.file), checkpoint = fs.readFileSync(proxy.codexRecovery.file);
  f.reload(); assert.deepEqual(fs.readFileSync(proxy.file), journal); assert.deepEqual(fs.readFileSync(proxy.codexRecovery.file), checkpoint);
});

test('independent encrypted checkpoint survives loss of the record, original backup and applied attachment', t => {
  const f = fixture(t), owned = f.proxy.clients.codex.attachment;
  f.legacy(); fs.unlinkSync(f.config.record); fs.unlinkSync(owned.backup);
  const before = f.snapshot(), recovered = f.reload();
  assert.deepEqual(recovered.proxy.clients.codex.attachment, owned); assert.deepEqual(f.snapshot(), before);
  assert.ok(fs.existsSync(recovered.config.record));
  const file = recovered.proxy.codexRecovery.file;
  const encoded = JSON.parse(fs.readFileSync(file)); assert.equal(encoded.version, 1); assert.equal(typeof encoded.encrypted, 'string');
  assert.ok(fs.statSync(file).size < 1024 * 1024);
  assert.doesNotThrow(() => recovered.proxy.requireCodexOfficialService());
});

for (const broken of ['{"backup":', '{}', 'null', '{"blocks":[],"replaced":{}}']) test(`a corrupt canonical record ${broken} recovers with its original bytes in an encrypted backup`, t => {
  const f = fixture(t), before = f.snapshot(), original = f.proxy.clients.codex.attachment;
  atomic(f.config.record, broken);
  const { config, proxy } = f.reload();
  assert.deepEqual(JSON.parse(fs.readFileSync(config.record, 'utf8')), original);
  assert.deepEqual(f.snapshot(), before);
  const names = fs.readdirSync(path.join(f.data, 'backups')).filter(n => n.startsWith('codex-record-recovery-'));
  assert.equal(names.length, 1);
  const envelope = JSON.parse(fs.readFileSync(path.join(f.data, 'backups', names[0])));
  assert.equal(JSON.parse(crypt.decryptString(Buffer.from(envelope.encrypted, 'base64'))).before, broken);
  f.reload(); assert.equal(fs.readdirSync(path.join(f.data, 'backups')).filter(n => n.startsWith('codex-record-recovery-')).length, 1);
  assert.equal(proxy.pending, null);
});

test('a damaged independent checkpoint uses the previous validated generation', t => {
  const f = fixture(t), original = structuredClone(f.proxy.clients.codex.attachment);
  f.proxy.codexRecovery.save({ ...original, backup: path.join(f.data, 'backups', 'another-baseline.toml') });
  f.legacy(); fs.unlinkSync(f.config.record); fs.unlinkSync(original.backup);
  atomic(f.proxy.codexRecovery.file, '{truncated');
  const { proxy, config } = f.reload();
  assert.equal(proxy.recoveryError, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.record, 'utf8')), original);
  f.reload();
});

test('a checkpoint from another Codex directory is rejected, without copying login or config', t => {
  const f = fixture(t), other = path.join(f.root, 'other-codex');
  const config = new ConfigManager(other, f.data), { CodexRecovery } = require('../core/codex-recovery.cjs');
  const before = f.snapshot();
  assert.deepEqual(new CodexRecovery(f.data, crypt, config).candidates(), []);
  assert.equal(fs.existsSync(other), false); assert.deepEqual(f.snapshot(), before);
});

test('ambiguous baseline backups and externally changed endpoints remain untouched', t => {
  const f = fixture(t); f.legacy(); f.dropCheckpoints(); fs.unlinkSync(f.config.record);
  atomic(path.join(f.data, 'backups', 'config-9999999999999-proxy.toml'), f.original.replace('gpt-original', 'gpt-other'));
  const before = f.snapshot(), result = f.reload();
  assert.match(result.proxy.recoveryError, /歧义/); assert.equal(fs.existsSync(f.config.record), false);
  assert.deepEqual(f.snapshot(), before);
  atomic(f.config.file, fs.readFileSync(f.config.file, 'utf8').replaceAll(f.config.baseUrl, 'https://external.invalid/v1'));
  const foreign = f.snapshot(); f.reload(); assert.deepEqual(f.snapshot(), foreign); assert.equal(fs.existsSync(f.config.record), false);
});

test('partial and stale backup files do not prevent a valid original baseline from recovering', t => {
  const f = fixture(t); f.legacy(); f.dropCheckpoints(); fs.unlinkSync(f.config.record);
  atomic(path.join(f.data, 'backups', 'config-9999999999999-proxy.toml'), '[broken');
  atomic(path.join(f.data, 'backups', 'config-9999999999998-proxy.toml'), 'model_provider = "ASS"\n');
  const before = f.snapshot(), result = f.reload();
  assert.equal(result.proxy.recoveryError, undefined); assert.ok(fs.existsSync(result.config.record)); assert.deepEqual(f.snapshot(), before);
});

for (const mutate of [text => text.replaceAll('# >>> ass managed start\n', '').replaceAll('# <<< ass managed end', ''),
  text => text.replace('# >>> ass managed start', '# missing first marker')]) {
  test('native-writer marker loss repairs only known transport fields and preserves preferences, selection and OAuth', t => {
    const f = fixture(t), auth = fs.readFileSync(path.join(f.codex, 'auth.json'));
    const value = mutate(fs.readFileSync(f.config.file, 'utf8')).replace('model = "gpt-original"', 'model = "gpt-new-selection"');
    atomic(f.config.file, value + '\n[native_new]\nkeep = "after injection"\n');
    const before = TOML.parse(fs.readFileSync(f.config.file, 'utf8')), recovered = f.reload();
    assert.equal(recovered.proxy.recoveryError, undefined);
    assert.deepEqual(TOML.parse(fs.readFileSync(f.config.file, 'utf8')), before);
    assert.equal((fs.readFileSync(f.config.file, 'utf8').match(/# >>> ass managed start/g) || []).length, 2);
    assert.deepEqual(fs.readFileSync(path.join(f.codex, 'auth.json')), auth);
    const normalized = fs.readFileSync(f.config.file); f.reload(); assert.deepEqual(fs.readFileSync(f.config.file), normalized);
  });
}

for (const failing of ['checkpoint', 'record']) test(`metadata recovery tolerates ${failing} disk-write failure and retries cleanly`, t => {
  const f = fixture(t); f.legacy(); f.dropCheckpoints(); fs.unlinkSync(f.config.record);
  const before = f.snapshot(), saved = fs.readFileSync(f.proxy.file), write = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith((failing === 'checkpoint' ? f.proxy.codexRecovery.file : f.config.record) + '.'))
      throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' });
    return write.call(this, file, ...args);
  };
  try { assert.throws(() => f.proxy.autoRecoverCodex(), /full disk/); } finally { fs.writeFileSync = write; }
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(fs.readFileSync(f.proxy.file), saved);
  assert.equal(fs.existsSync(f.config.record), false);
  const { proxy, config } = f.reload(); assert.equal(proxy.recoveryError, undefined); assert.ok(fs.existsSync(config.record));
  const checkpoint = fs.readFileSync(proxy.codexRecovery.file); f.reload(); assert.deepEqual(fs.readFileSync(proxy.codexRecovery.file), checkpoint);
});

test('missing all evidence never invents a rollback baseline, even when ASS markers remain', t => {
  const f = fixture(t), backup = f.proxy.clients.codex.attachment.backup;
  f.legacy(); f.dropCheckpoints(); fs.unlinkSync(f.config.record); fs.unlinkSync(backup);
  const before = f.snapshot(), result = f.reload();
  assert.match(result.proxy.recoveryError, /恢复检查点|原始备份/); assert.equal(fs.existsSync(f.config.record), false); assert.deepEqual(f.snapshot(), before);
});

test('an older automatic recovery cannot overwrite a newer applied routing snapshot', t => {
  const f = fixture(t); f.legacy(); fs.unlinkSync(f.config.record);
  const before = f.snapshot(), write = fs.writeFileSync;
  let external;
  fs.writeFileSync = function(file, ...args) {
    if (!external && String(file).includes('codex-record-recovery-')) {
      const envelope = JSON.parse(fs.readFileSync(f.proxy.file)), payload = JSON.parse(crypt.decryptString(Buffer.from(envelope.encrypted, 'base64')));
      payload.clients.codex.providers[0].baseUrl = 'https://newer-external.invalid/v1';
      external = JSON.stringify({ version: 1, encrypted: crypt.encryptString(JSON.stringify(payload)).toString('base64') });
      write.call(fs, f.proxy.file, external);
    }
    return write.call(this, file, ...args);
  };
  try { assert.throws(() => f.proxy.autoRecoverCodex(), /外部修改|已变化/); } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(f.proxy.file, 'utf8'), external); assert.equal(fs.existsSync(f.config.record), false); assert.deepEqual(f.snapshot(), before);
});

test('a changed rollback baseline in an otherwise valid canonical record is not silently adopted', t => {
  const f = fixture(t), saved = fs.readFileSync(f.proxy.file), before = f.snapshot();
  const record = JSON.parse(fs.readFileSync(f.config.record, 'utf8')); record.replaced.model = 'gpt-externally-modified';
  atomic(f.config.record, JSON.stringify(record));
  f.reload(); assert.deepEqual(fs.readFileSync(f.proxy.file), saved); assert.deepEqual(f.snapshot(), before);
});

test('failure to refresh an optional checkpoint does not block an already valid OAuth transport', t => {
  const f = fixture(t), before = f.snapshot(), write = fs.writeFileSync;
  f.dropCheckpoints();
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(f.proxy.codexRecovery.file + '.')) throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' });
    return write.call(this, file, ...args);
  };
  try { assert.doesNotThrow(() => f.proxy.requireCodexOfficialService()); } finally { fs.writeFileSync = write; }
  assert.deepEqual(f.snapshot(), before);
});
