const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { scan } = require('../core/usage-readers.cjs');
const { discover } = require('../core/usage-locations.cjs');
const when = '2026-10-30T08:00:00Z';
const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
};

test('arbitrary project config names and retired managed homes count each native message once across copies and restarts', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-usage-locations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'workspace'), dir = path.join(project, 'iterations', '17', 'private-state');
  const message = id => ({ type: 'assistant', sessionId: 'cc-session', timestamp: when,
    message: { id, model: 'ASS_provider::vendor/deepseek[1m]', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } } });
  const native = path.join(home, '.claude/projects/p/shared.jsonl');
  write(native, [message('shared')]);
  write(path.join(dir, 'projects/p/current.jsonl'), [message('shared'), message('new'), {
    type: 'assistant', sessionId: 'cc-session', timestamp: when, message: {
      id: 'synthetic-error', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }]);
  write(path.join(home, 'clients/claude', 'a'.repeat(24), 'projects/p/retired.jsonl'), [message('shared')]);
  const codex = [{ type: 'session_meta', payload: { id: 'codex-session', timestamp: when } },
    { type: 'turn_context', payload: { model: 'vendor/model' } },
    { type: 'event_msg', timestamp: when, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 20, output_tokens: 3 }, last_token_usage: { input_tokens: 20, output_tokens: 3 } } } }];
  write(path.join(project, 'arbitrary-config/sessions/date/session.jsonl'), codex);
  write(path.join(home, '.codex/archived_sessions/copy.jsonl'), codex);
  write(path.join(project, 'another-state/sessions/session.jsonl'), [
    { type: 'session', id: 'pi-session', timestamp: when }, { type: 'message', id: 'pi-message', timestamp: when,
      message: { role: 'assistant', model: 'vendor/pi-model', provider: 'provider', usage: { input: 4, output: 2, cacheRead: 6 } } }]);
  write(path.join(project, 'node_modules/ignored/projects/p/fixture.jsonl'), [message('fixture')]);
  const options = { home, dataDir: home, env: {}, projects: [project, path.join(project, 'iterations')], now: Date.parse(when) };
  const before = fs.readFileSync(native), first = await scan(options);
  const sums = client => first.snapshot.rows.filter(r => r.client === client).reduce((s, r) => [s[0] + r.input, s[1] + r.output, s[2] + r.calls], [0, 0, 0]);
  assert.deepEqual(sums('claude'), [30, 4, 2]);
  assert.deepEqual(sums('codex'), [20, 3, 1]);
  assert.deepEqual(sums('pi'), [10, 2, 1]);
  assert.deepEqual((await scan(options, first.cache, first.locations)).snapshot, first.snapshot);
  const { UsageHistory } = require('../core/usage-history.cjs');
  const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const history = new UsageHistory({ dataDir: home, crypto: encryption, getOptions: () => options });
  await history.refresh();
  const restarted = new UsageHistory({ dataDir: home, crypto: encryption, getOptions: () => ({ ...options, projects: [] }) });
  await restarted.refresh();
  assert.deepEqual(restarted.public().rows, first.snapshot.rows,
    'worker discovery survives encrypted-cache reload without the originating process or project selection');
  assert.deepEqual(fs.readFileSync(native), before);
  assert.ok(!JSON.stringify(first.snapshot).includes(home), 'discovery paths never reach the renderer snapshot');
  const { summarize } = await import('../src/usage-view.mjs');
  const grouped = summarize(first.snapshot.rows, { range: 'week', client: 'all', group: 'model' }, new Date(when));
  assert.equal(grouped.groups.find(g => g.name === 'deepseek').input, 30);
});

test('WSL discovery inspects all running distributions, translates supplied roots and leaves sleeping distributions cached', { skip: process.platform !== 'win32' }, async () => {
  const calls = [], home = os.homedir();
  const offline = { client: 'claude', dir: '\\\\wsl.localhost\\Sleeping\\home\\someone\\private-state' };
  const run = async (file, args) => {
    calls.push(args);
    if (args[0] === '--list') return Buffer.from('First\r\nSecond\r\n', 'utf16le');
    const distro = args[1];
    return JSON.stringify({ roots: [{ client: 'claude', dir: `\\\\wsl.localhost\\${distro}\\home\\different-user\\custom-state` }], projects: [], homes: [] });
  };
  const found = await discover({ home, discover: true }, { roots: [offline] }, run);
  assert.equal(found.roots.length, 2);
  assert.equal(found.saved.roots.length, 3);
  assert.ok(found.unavailable.has('Sleeping'));
  assert.deepEqual(calls.filter(args => args[0] === '-d').map(args => args[1]), ['First', 'Second']);
});

test('a client installed only in WSL remains visible when its usage exists', async () => {
  const { detectedClients } = await import('../src/usage-view.mjs');
  const state = { harnesses: { clients: [{ id: 'claude', detected: false }, { id: 'pi', detected: false }] },
    usage: { sources: [{ client: 'claude', records: 3 }, { client: 'pi', records: 0 }] } };
  assert.deepEqual(detectedClients(state).map(c => c.id), ['claude']);
});

test('offline WSL metadata survives refresh and shares deduplication with a readable Windows copy', { skip: process.platform !== 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-usage-offline-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude/projects/p/session.jsonl');
  write(file, [{ type: 'assistant', sessionId: 'session', timestamp: when,
    message: { id: 'same-native-message', model: 'deepseek', usage: { input_tokens: 12, output_tokens: 3 } } }]);
  const options = { home, env: {}, dataDir: home, now: Date.parse(when) }, first = await scan(options);
  const entry = Object.values(first.cache)[0];
  const cache = { ...first.cache, offline: { ...entry, client: 'claude', distro: 'Sleeping' } };
  const locations = require('../core/usage-locations.cjs'), original = locations.discover;
  t.mock.method(locations, 'discover', (options, previous) => original(options, previous, async () => Buffer.from('', 'utf16le')));
  const saved = { roots: [{ client: 'claude', dir: '\\\\wsl.localhost\\Sleeping\\home\\person\\custom' }] };
  const readable = await scan({ ...options, discover: true }, cache, saved);
  assert.equal(readable.snapshot.rows[0].input, 12);
  assert.equal(readable.snapshot.rows[0].calls, 1);
  fs.unlinkSync(file);
  const offline = await scan({ ...options, discover: true }, readable.cache, readable.locations);
  assert.equal(offline.snapshot.rows[0].input, 12);
  assert.equal(offline.snapshot.rows[0].calls, 1);
  assert.equal(offline.snapshot.sources.find(s => s.client === 'claude').status, 'partial');
});
