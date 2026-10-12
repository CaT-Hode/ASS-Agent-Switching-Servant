const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = (id, fields = [], extra = {}) => ({
  id: 'api:' + id, providerId: id, kind: 'api', ready: true, label: id,
  profile: { fields, canRefresh: true }, ...extra,
});
const client = (id, accounts, detected = true) => ({ id, name: id, detected, accounts });
const state = (clients, balances = {}) => ({ harnesses: { clients }, balances });

test('overview prioritizes actual quota/balance/subscription data over free key placeholders', async () => {
  const { overviewAccounts, overviewAccountPriority } = await import('../src/usage-view.mjs');
  const input = state([client('opencode', [api('zen'), api('unsupported', [], { profile: { fields: [], canRefresh: false } })]),
    client('claude', [api('subscription', [{ id: 'plan', value: 'max' }])]),
    client('dsh', [api('deepseek', [{ id: 'balance-0', value: '0', unit: 'CNY' }])]),
    client('codex', [{ id: 'official', kind: 'native', ready: true, label: 'OpenAI',
      quota: { fields: [{ id: 'weekly', kind: 'quota', remainingPercent: 0 }] } }])]);
  const before = JSON.stringify(input);
  const rows = overviewAccounts(input, 'all');
  assert.deepEqual(rows.map(r => r.key), ['codex:official', 'api:deepseek', 'api:subscription', 'api:zen', 'api:unsupported']);
  assert.deepEqual(rows.map(overviewAccountPriority), [3, 2, 1, 0, 0]);
  assert.equal(JSON.stringify(input), before);
});

test('empty and invalid query results are not treated as returned quotas or balances', async () => {
  const { overviewAccounts, overviewAccountPriority } = await import('../src/usage-view.mjs');
  const fields = [{ id: 'plan', value: 'free' },
    ...[undefined, null, '', ' ', 'unknown', Infinity].map((value, i) => ({ id: 'balance-' + i, value })),
    ...[undefined, null, '42', NaN, Infinity].map((remainingPercent, i) => ({ id: 'quota-' + i, kind: 'quota', remainingPercent }))];
  const rows = overviewAccounts(state([client('opencode', [api('zen', fields)])],
    { zen: { ok: true, rows: [{ value: null }, { value: '' }] } }), 'all');
  assert.equal(rows[0].amounts.length, 0);
  assert.equal(rows[0].quotas.length, 0);
  assert.equal(overviewAccountPriority(rows[0]), 0);
});

test('shared API bindings select a richer cached account and retain detected-client filtering', async () => {
  const { overviewAccounts } = await import('../src/usage-view.mjs');
  const input = state([client('codex', [api('shared')]), client('pi', [api('shared', [], {
    quota: { fields: [{ id: 'remaining', value: '8.5', unit: 'USD' }], updatedAt: '2026-10-12T01:00:00Z' },
  })]), client('dsh', [api('hidden', [{ id: 'balance-0', value: 100 }])], false)]);
  const rows = overviewAccounts(input, 'all');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amounts[0].value, '8.5');
  assert.equal(rows[0].client.id, 'pi');
  assert.deepEqual(rows[0].clients, ['codex', 'pi']);
  assert.equal(overviewAccounts(input, 'codex')[0].amounts.length, 0);
  assert.equal(overviewAccounts(input, 'dsh').length, 0);
});

test('cached successful data stays prioritized after refresh failure; balance cache timestamps are reused', async () => {
  const { overviewAccounts, overviewAccountPriority } = await import('../src/usage-view.mjs');
  const rows = overviewAccounts(state([client('dsh', [api('cached', [], {
    quota: { fields: [{ id: 'weekly', kind: 'quota', remainingPercent: 10 }], error: 'network', canRefresh: true },
  }), api('balance')])], { balance: { ok: true, value: '0', unit: 'CNY', time: '2026-10-12T01:00:00Z' } }), 'all');
  assert.equal(overviewAccountPriority(rows[0]), 3);
  assert.equal(rows[0].error, 'network');
  assert.equal(rows[1].amounts[0].value, '0');
  assert.equal(rows[1].updatedAt, '2026-10-12T01:00:00Z');
});
