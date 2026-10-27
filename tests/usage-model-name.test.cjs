const { test } = require('node:test'), assert = require('node:assert/strict');

test('usage groups every client by the final model component across nested namespaces', async () => {
  const { usageModelName } = await import('../src/usage-view.mjs');
  const current = require('../core/models.cjs').codexModelId('fixture', 'deepseek-v4-pro');
  assert.equal(usageModelName(current, 'codex'), 'deepseek-v4-pro');
  assert.equal(usageModelName('ASS_295c4b059d7cb6be362b3f68::deepseek-v4-pro', 'codex'), 'deepseek-v4-pro');
  assert.equal(usageModelName('aimami_relay_960e58ea39::deepseek-v4-flash', 'codex'), 'deepseek-v4-flash');
  assert.equal(usageModelName('aimami_relay_0a211c788d::gpt-5.6-sol', 'codex'), 'gpt-5.6-sol');
  assert.equal(usageModelName(current, 'pi'), 'deepseek-v4-pro');
  for (const client of ['codex','claude','opencode','pi','dsh','kimi','zcode']) {
    for (const name of ['openrouter/vendor/model', 'vendor::model', 'ASS_fixture::model',
      'ASS_fixture::relay::openrouter/vendor/model', 'aimami_relay_not-a-hash::model',
      'relay::model[1m]', 'vendor/model[1M]'])
      assert.equal(usageModelName(name, client), 'model');
    assert.equal(usageModelName('gpt-6-astra', client), 'gpt-6-astra');
  }
  for (const name of ['', 'vendor::', 'vendor/', 'bad\nname']) assert.equal(usageModelName(name), '未标注');
  assert.equal(usageModelName(undefined, 'codex'), '未标注');
});

test('cached native and routed model names group together without rewriting rows or losing counters', async () => {
  const { summarize } = await import('../src/usage-view.mjs');
  const base = { day: '2026-10-10', hour: 10, client: 'codex', provider: 'openai',
    input: 10, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 1, calls: 1, sessions: ['same'] };
  const rows = [
    { ...base, model: 'gpt-5.6-sol' },
    { ...base, provider: 'ASS', model: require('../core/models.cjs').codexModelId('fixture', 'gpt-5.6-sol') },
    { ...base, provider: 'aimai1', model: 'aimami_relay_0a211c788d::router/vendor/gpt-5.6-sol', sessions: ['other'] },
    { ...base, client: 'pi', provider: 'custom', model: 'openrouter/vendor/gpt-5.6-sol[1m]', sessions: ['pi'] },
    { ...base, model: 'deepseek-ai/deepseek-v4-pro' }
  ];
  const cached = JSON.parse(JSON.stringify(rows)), before = JSON.stringify(cached), now = new Date(2026, 9, 10, 12);
  for (const range of ['week', 'month', 'year']) {
    const value = summarize(cached, { range, group: 'model', client: 'all' }, now);
    assert.equal(value.groups.length, 2);
    const group = value.groups.find(g => g.name === 'gpt-5.6-sol');
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls']) assert.equal(group[field], base[field] * 4, field);
    assert.equal(group.sessions.size, 3);
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls'])
      assert.equal(value.groups.reduce((sum, g) => sum + g[field], 0), value.total[field], field);
    assert.equal(value.total.calls, 5); assert.equal(value.total.sessions.size, 3);
  }
  const codex = summarize(cached, { range: 'month', group: 'model', client: 'codex' }, now);
  assert.equal(codex.groups.find(g => g.name === 'gpt-5.6-sol').calls, 3); assert.equal(codex.total.calls, 4);
  const clients = summarize(cached, { range: 'month', group: 'client', client: 'all' }, now);
  assert.deepEqual(clients.groups.map(g => [g.name, g.calls]), [['Codex', 4], ['pi', 1]]);
  assert.equal(JSON.stringify(cached), before, 'native IDs and historical cache are read-only');
});
