import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { usageModelName } from '../core/model-name.mjs';
import { motionRows, widgetHeight, widgetWidth, widgetHeatHeight, widgetHeatRadius } from '../core/request-widget-view.mjs';

const require = createRequire(import.meta.url);
const { routeFor } = require('../core/router.cjs');
const { codexModelId, makeCatalog } = require('../core/models.cjs');
const { compose, providerId } = require('../core/native-config.cjs');
const { compactTokenLimit } = require('../core/context-budget.cjs');
const { claudeModelSettings } = require('../core/accountless.cjs');
const { adapter: accountInfoAdapter, apiProfile } = require('../core/account-info.cjs');
const { canQueryBalance, queryBalance } = require('../core/balance.cjs');
const { messagesTransport } = require('../core/provider-transport.cjs');
const { messagesRequest, messagesEvents, messagesJSON } = require('../core/messages-adapter.cjs');
const { parser: usageParser, scan: scanUsage } = require('../core/usage-readers.cjs');
const { SseParser } = require('../core/sse-parser.cjs');
const { CodexCompaction } = require('../core/codex-compaction.cjs');
const { Router } = require('../core/router.cjs');
const { classifyFailure } = require('../core/diagnostic-failure.cjs');
const { RequestMetrics } = require('../core/request-metrics.cjs');
const { RequestHistory } = require('../core/request-history.cjs');
const { WslSync, projection, planFiles } = require('../core/wsl-sync.cjs');
const { parseAnswer } = require('../core/scoped-dns.cjs');
const localRelease = require('../scripts/local-release.cjs');
const { Preferences } = require('../core/preferences.cjs');
const packageLayout = require('../scripts/package-layout.cjs');
const { prepareConfig, ConfigManager } = require('../core/config.cjs');
const { ProxyConfig } = require('../core/proxy-config.cjs');
const { CodexSessionHandoff } = require('../core/codex-session-handoff.cjs');
const { CodexOfficialAuth } = require('../core/codex-official-auth.cjs');
const { DatabaseSync } = require('node:sqlite');
const TOML = require('@iarna/toml');
const { inspectCredentials } = require('../core/credential-status.cjs');

const provider = (overrides = {}) => ({ id: 'fixture-provider', name: 'Fixture', enabled: true,
  baseUrl: 'https://provider.example/proxy/v1', apiKey: 'fixture-secret', extraHeaders: {}, network: 'system',
  models: [{ model: 'fixture-model', enabled: true, wireApi: 'openai-responses', defaultEffort: 'high', maxOutputTokens: 12000 }],
  ...overrides });
const testCrypto = () => ({ isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString('utf8') });
const responseBody = (model, input) => ({ model, stream: true, input: [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic request' }] },
  ...input,
] });

test('compact request widget keeps square heat cells and migrates its old default width once', t => {
  assert.equal(widgetWidth(340), 288);
  assert.deepEqual([widgetHeight(0, 5), widgetHeight(3, 5), widgetHeight(100, 5)], [102, 156, 210]);
  assert.deepEqual([widgetHeatRadius(12), widgetHeatRadius(36), widgetHeatRadius(48)], [4, 6, 8]);
  const cell = (widgetWidth(340) - 32 - 33) / 12;
  assert.ok(Math.abs(widgetHeatHeight(340) - (cell * 2 + 3)) < 1e-9);
  const row = { id: 'fixture', model: 'model', provider: 'provider', inProgress: true, phase: 'waiting', ms: 0, tps: null };
  const first = motionRows([], [row]), retained = motionRows(first, [{ ...row }]);
  assert.equal(retained, first, 'unchanged rows do not replace the renderer collection');
  assert.equal(retained[0], first[0], 'unchanged rows retain their React identity');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-widget-layout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'preferences.json'), JSON.stringify({ requestWidget: { width: 380 } }));
  const migrated = new Preferences(directory);
  assert.equal(migrated.state.requestWidget.width, 340);
  assert.equal(migrated.state.requestWidget.layoutVersion, 2);
  migrated.update({ requestWidget: { width: 380 } });
  assert.equal(new Preferences(directory).state.requestWidget.width, 380);
});

test('usage display merges nested provider names by the final model component', () => {
  assert.equal(usageModelName('ASS_route::vendor/family/model[1m]'), 'model');
  assert.equal(usageModelName('vendor/model'), 'model');
  assert.equal(usageModelName('model'), 'model');
});

test('model injection assigns a 90% compaction budget across Codex and native harnesses', t => {
  for (const protocol of ['openai-responses', 'openai-chat', 'anthropic'])
    assert.match(providerId({ id: 'provider' }, protocol), /^ass-[a-f0-9]{16}-(responses|chat|messages)$/);
  assert.equal(compactTokenLimit(1000000), 900000);
  const codex = makeCatalog([], [provider({ models: [{ model: 'fixture-model', displayName: 'Fixture Model',
    enabled: true, wireApi: 'openai-responses', defaultEffort: 'high', efforts: ['low', 'high'],
    contextWindow: 1000000, maxOutputTokens: 12000 }] })]).models.find(m => m.slug.includes('::'));
  assert.equal(codex.context_window, 1000000);
  assert.equal(codex.auto_compact_token_limit, 900000);
  assert.equal(codex.effective_context_window_percent, 100);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-context-budget-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const p = provider({ models: [{ model: 'fixture-model', displayName: 'Fixture Model', enabled: true,
    wireApi: 'openai-responses', defaultEffort: 'high', efforts: ['low', 'high'],
    contextWindow: 1000000, maxOutputTokens: 12000 }] });
  const claude = claudeModelSettings([p], codexModelId(p.id, 'fixture-model'));
  assert.equal(claude.autoCompactWindow, 900000);
  assert.equal(Object.values(claude.modelSettings)[0].autoCompactWindow, 900000);
  assert.match(claude.model, /\[1m\]$/);
  const manager = { nativeHome: home, nativeEnv: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    state: { credentialHomes: {}, injections: {} }, effectiveProviders: () => [p],
    getState: () => ({ providers: [p] }), launcher: () => ({ ready: false }) };
  const plans = Object.fromEntries(['opencode', 'pi', 'dsh', 'kimi', 'zcode'].map(id => [id, compose(id, manager)]));
  const fields = id => plans[id].fields;
  const context = {
    opencode: fields('opencode').find(f => f.path[0] === 'provider').value.models['fixture-model'].limit.context,
    pi: fields('pi').find(f => f.path[0] === 'providers').value.models[0].contextWindow,
    dsh: fields('dsh').find(f => f.path[0] === 'llm-pi-ai').value.models[0].contextWindow,
    kimi: fields('kimi').find(f => f.path[0] === 'models').value.max_context_size,
    zcode: fields('zcode').find(f => f.selector?.modelId === 'fixture-model').value.config.properties.contextWindow,
  };
  assert.deepEqual(context, Object.fromEntries(Object.keys(context).map(id => [id, 900000])));
});

test('exact ASS model IDs route to the configured upstream model without rewriting its protocol', () => {
  const p = provider(), id = codexModelId(p.id, p.models[0].model);
  const route = routeFor({ model: id, input: [] }, { providers: [p] });
  assert.equal(route.url, 'https://provider.example/proxy/v1/responses');
  assert.equal(route.protocol, 'openai-responses');
  assert.equal(route.body.model, 'fixture-model');
  const deepseek = provider({ baseUrl: 'https://api.deepseek.com', models: [{ model: 'deepseek-v4-pro', enabled: true,
    wireApi: 'anthropic' }] });
  assert.deepEqual(messagesTransport(deepseek, deepseek.models[0]), {
    protocol: 'anthropic', url: 'https://api.deepseek.com/anthropic/v1/messages', adapted: false,
  });
});

test('accountless Codex keeps the OpenAI provider with reversible local auth and preserves later native login', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-accountless-prediction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(codexDir); fs.mkdirSync(dataDir);
  const p = provider({ models: [{ model: 'fixture-model', enabled: true, wireApi: 'openai-responses',
    defaultEffort: 'high', efforts: ['low', 'high'], contextWindow: 200000, maxOutputTokens: 12000 }] });
  const model = codexModelId(p.id, p.models[0].model), token = 'a'.repeat(64);
  const config = new ConfigManager(codexDir, dataDir, 25819);
  fs.writeFileSync(config.catalog, JSON.stringify(makeCatalog([], [p])));
  const prepared = prepareConfig('', config.catalog, config.baseUrl, { model, effort: 'high' }, token, false);
  fs.writeFileSync(config.file, prepared.text);
  fs.writeFileSync(config.record, JSON.stringify({ replaced: prepared.replaced,
    blocks: prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
  assert.deepEqual(config.status(), { attached: true, legacyWorkspaceRelay: false, authMode: 'accountless',
    managed: true, provider: 'openai' });
  config.preflightDetach();
  assert.equal(routeFor({ model, input: [] }, { providers: [p] }).body.model, 'fixture-model');

  const manager = { injection: () => ({ models: [{ ref: JSON.stringify([p.id, p.models[0].model]), included: true }] }),
    effectiveProviders: () => [p], options: {}, state: { providers: [p] } };
  const store = { state: { providers: [p], officialOverrides: {} }, officialModels: [], readCatalog() {} };
  const withLogin = new ProxyConfig(path.join(root, 'with-login'), testCrypto(), manager, store,
    new ConfigManager(path.join(root, 'codex-login'), path.join(root, 'config-login'), 25820), null,
    { hasCodexLogin: () => true });
  const loggedInPlan = withLogin.desired('codex', true);
  assert.match(prepareConfig('', config.catalog, config.baseUrl, loggedInPlan.defaultModel,
    loggedInPlan.localToken, false).text, /^model_provider = "openai"$/m);
  const withoutLogin = new ProxyConfig(path.join(root, 'without-login'), testCrypto(), manager, store,
    new ConfigManager(path.join(root, 'codex-no-login'), path.join(root, 'config-no-login'), 25821), null,
    { hasCodexLogin: () => false });
  const plainAccountless = withoutLogin.desired('codex', true);
  assert.match(prepareConfig('', config.catalog, config.baseUrl, plainAccountless.defaultModel,
    plainAccountless.localToken, false).text, /^model_provider = "openai"$/m);

  const native = withoutLogin.config;
  fs.mkdirSync(path.dirname(native.file), { recursive: true });
  const baseline = 'cli_auth_credentials_store = "keyring"\n';
  fs.writeFileSync(native.file, baseline);
  withoutLogin.sync('codex', true);
  assert.equal(TOML.parse(fs.readFileSync(native.file, 'utf8')).cli_auth_credentials_store, 'file');
  const credential = new CodexOfficialAuth(path.dirname(native.file));
  assert.equal(credential.currentCredential(), withoutLogin.clients.codex.localToken);
  assert.equal(credential.hasChatGptLogin(), false);
  assert.equal(withoutLogin.status('codex', true).applied, true);
  assert.deepEqual(inspectCredentials('codex', path.dirname(native.file)).rows, []);
  const reloaded = new ProxyConfig(path.dirname(withoutLogin.file), testCrypto(), manager, store, native, null);
  assert.equal(reloaded.error, '');
  assert.equal(reloaded.status('codex', true).applied, true);
  reloaded.sync('codex', true);
  native.detach(); reloaded.restore(['codex']);
  assert.equal(fs.existsSync(native.auth), false);
  assert.equal(TOML.parse(fs.readFileSync(native.file, 'utf8')).cli_auth_credentials_store, 'keyring');

  // A real API credential authenticates the local route without being replaced.
  const apiAuth = '{ "auth_mode": "apikey", "OPENAI_API_KEY": "native-fixture-key" }\n';
  fs.writeFileSync(native.auth, apiAuth);
  reloaded.sync('codex', true);
  assert.equal(fs.readFileSync(native.auth, 'utf8'), apiAuth);
  assert.equal(reloaded.clients.codex.localAuth, undefined);
  assert.equal(credential.currentCredential(), 'native-fixture-key');
  native.detach(); reloaded.restore(['codex']);
  assert.equal(fs.readFileSync(native.auth, 'utf8'), apiAuth);

  // Native login after fallback creation must win over the saved rollback file.
  fs.unlinkSync(native.auth);
  reloaded.sync('codex', true);
  const oauth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-native-oauth', account_id: 'fixture' } });
  fs.writeFileSync(native.auth, oauth);
  reloaded.hasCodexLogin = () => credential.hasChatGptLogin();
  assert.equal(reloaded.status('codex', true).pending, true);
  reloaded.sync('codex', true);
  assert.equal(fs.readFileSync(native.auth, 'utf8'), oauth);
  assert.equal(reloaded.clients.codex.localAuth, undefined);
  assert.equal(native.status().provider, 'openai');
  native.detach(); reloaded.restore(['codex']);
  assert.equal(fs.readFileSync(native.auth, 'utf8'), oauth);

  // A failed multi-file commit restores absence as well as existing config.
  fs.unlinkSync(native.auth);
  const before = fs.readFileSync(native.file, 'utf8');
  const persist = reloaded.persist.bind(reloaded);
  let fail = true;
  reloaded.persist = (clients, pending, options) => {
    if (!pending && fail) { fail = false; throw Error('fixture save failure'); }
    return persist(clients, pending, options);
  };
  assert.throws(() => reloaded.sync('codex', true), /fixture save failure/);
  assert.equal(fs.existsSync(native.auth), false);
  assert.equal(fs.readFileSync(native.file, 'utf8'), before);
  assert.equal(reloaded.clients.codex, undefined);
  assert.equal(reloaded.pending, null);
});

test('Codex binding repair needs no login and preserves models, history and unrelated providers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-codex-bindings-'));
  const codexDir = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true }); fs.mkdirSync(dataDir);
  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, model TEXT)');
  const model = codexModelId('fixture-provider', 'fixture-model');
  const tail = '  {"type":"turn_context","payload":{"model":' + JSON.stringify(model) + ',"model_provider":"ASS"}}\n' +
    '{"type":"response_item","payload":{"type":"reasoning","encrypted_content":"fixture-history"}}\n';
  for (const [id, provider] of [['a', 'ASS'], ['b', 'ass_official'], ['c', 'openai'], ['d', 'unrelated']]) {
    const file = path.join(codexDir, 'sessions', id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } }) + '\n' + tail);
    db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(id, provider, file, model);
  }
  let idle = 0;
  const handoff = new CodexSessionHandoff({ codexDir, dataDir, crypto: testCrypto(), officialModels: () => [],
    config: { status: () => ({ attached: true, provider: 'openai', authMode: 'accountless' }), preflightDetach() {} },
    assertIdle: async () => { idle++; } });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(handoff.status().bindingCount, 2);
  assert.deepEqual(await handoff.restoreBindings(), { count: 2 });
  assert.ok(idle > 0);
  for (const row of db.prepare('SELECT * FROM threads ORDER BY id').all()) {
    assert.equal(row.model, model);
    assert.equal(row.model_provider, row.id === 'd' ? 'unrelated' : 'openai');
    const bytes = fs.readFileSync(row.rollout_path, 'utf8'), end = bytes.indexOf('\n');
    assert.equal(bytes.slice(end + 1), tail);
    assert.equal(JSON.parse(bytes.slice(0, end)).payload.model_provider, row.model_provider);
  }
  assert.equal(handoff.status().bindingCount, 0);
  assert.deepEqual(await handoff.restoreBindings(), { count: 0 });
});

test('accountless Codex native API credentials stay local and official model requests are rejected', async t => {
  const p = provider(), calls = [], nativeKey = 'native-fixture-key';
  const router = new Router({ getState: () => ({ accountless: true, localToken: 'a'.repeat(64), providers: [p] }),
    getNativeCredential: () => nativeKey, fetchUpstream: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return Response.json({ id: 'fixture', object: 'response', status: 'completed', output: [] });
    } });
  await router.start(0); t.after(() => router.stop());
  const send = (model, key) => fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, input: [] }),
  });
  const success = await send(codexModelId(p.id, p.models[0].model), nativeKey);
  assert.equal(success.status, 200); await success.text();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer ' + p.apiKey);
  assert.ok(!JSON.stringify(calls).includes(nativeKey));
  const official = await send('gpt-fixture', nativeKey);
  assert.equal(official.status, 403); await official.text();
  const invalid = await send(codexModelId(p.id, p.models[0].model), 'other-key');
  assert.equal(invalid.status, 401); await invalid.text();
  assert.equal(calls.length, 1);
});

test('disabled models and unsupported compact routes fail before an upstream request can be built', () => {
  const p = provider({ models: [{ model: 'fixture-model', enabled: false, wireApi: 'openai-responses' }] });
  assert.throws(() => routeFor({ model: codexModelId(p.id, 'fixture-model') }, { providers: [p] }), error => error.status === 404);
  const chat = provider({ models: [{ model: 'fixture-model', enabled: true, wireApi: 'openai-chat' }] });
  assert.throws(() => routeFor({ model: codexModelId(chat.id, 'fixture-model') }, { providers: [chat] }, '/compact'),
    error => error.status === 400);
});

test('Messages conversion keeps tool call/result IDs and arguments', () => {
  const request = messagesRequest({ system: 'rules', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file text' }] },
  ], tools: [{ name: 'read', input_schema: { type: 'object' } }], max_tokens: 500 },
  { model: 'fixture-model', maxOutputTokens: 900 }, 'openai-responses');
  assert.deepEqual(request.input.map(item => item.call_id), ['call-1', 'call-1']);
  assert.equal(request.input[0].arguments, '{"path":"a.txt"}');
  assert.equal(request.input[1].output, 'file text');
  assert.equal(request.instructions, 'rules');
});

test('SSE failed events retain a safe task-failure classification', () => {
  const parser = new SseParser();
  const event = { type: 'response.failed', response: { status: 'failed', error: {
    code: 'insufficient_quota', message: 'synthetic private provider prose',
  } } };
  assert.throws(() => parser.feed(Buffer.from(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`)), error => {
    assert.equal(error.code, 'model_task_failed');
    assert.equal(error.diagnostic.failure.kind, 'quota');
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /synthetic private provider prose/);
    return true;
  });
});

test('compaction serializes historical calls as inert data and applies the output cap', () => {
  const codec = new CodexCompaction(testCrypto());
  const body = { ...responseBody('fixture-model', [
    { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'synthetic result' },
    { type: 'compaction_trigger' },
  ]), tools: [{ type: 'function', name: 'read' }], max_output_tokens: 20000 };
  const prepared = codec.prepare(body, { maxOutputTokens: 8000 });
  assert.equal(prepared.max_output_tokens, 8000);
  assert.equal(prepared.tools, undefined);
  assert.match(JSON.stringify(prepared.input), /synthetic result/);
  assert.doesNotMatch(JSON.stringify(prepared.input), /compaction_trigger|"type":"function_call"/);
});

test('compaction checkpoint encrypts a completed summary and expands it on continuation', async () => {
  const codec = new CodexCompaction(testCrypto());
  const summary = 'Completed: fixture work. Next: inspect output.';
  const completed = Response.json({ id: 'resp-fixture', status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: summary }] },
  ] });
  const checkpoint = await codec.collect(completed, 'openai-responses', new AbortController().signal, 'fixture-model');
  assert.equal(checkpoint.output[0].type, 'compaction');
  assert.match(checkpoint.output[0].encrypted_content, /^ass-compaction-v1:/);
  const expanded = codec.expand({ input: [checkpoint.output[0], { role: 'user', content: 'continue' }] });
  assert.match(expanded.input[0].content[0].text, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Codex compact route returns the classified reason for HTTP 200 task failures without provider prose', async t => {
  const p = provider(), model = codexModelId(p.id, p.models[0].model);
  const privateDetail = 'synthetic private provider prose';
  const router = new Router({ getState: () => ({ providers: [p] }), compactionCrypto: testCrypto(),
    fetchUpstream: async () => new Response(`event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed', response: { status: 'failed', error: { code: 'insufficient_quota', message: privateDetail } },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
  await router.start(0); t.after(() => router.stop());
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-oauth', 'content-type': 'application/json' },
    body: JSON.stringify({ ...responseBody(model, [{ type: 'compaction_trigger' }]), model }),
  });
  const text = await response.text(), result = JSON.parse(text);
  assert.equal(response.status, 502);
  assert.equal(result.error.code, 'model_task_failed');
  assert.equal(result.error.message, '上游明确报告额度或余额不足');
  assert.equal(result.diagnostic.failure.kind, 'quota');
  assert.doesNotMatch(text, new RegExp(privateDetail));
});

test('diagnostics distinguish quota and OpenAI API keys use billing pages instead of guessed balance endpoints', async () => {
  const quota = classifyFailure(null, { httpStatus: 200, body: { error: { code: 'insufficient_quota' } } });
  const rate = classifyFailure(null, { httpStatus: 429, body: { error: { code: 'rate_limit_exceeded' } } });
  const auth = classifyFailure(null, { httpStatus: 401 });
  assert.deepEqual([quota.failure.kind, rate.failure.kind, auth.failure.kind], ['quota', 'rate_limit', 'authentication']);
  const openai = { id: 'openai-api', name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-key',
    network: 'system', models: [] };
  const profile = apiProfile(openai);
  assert.equal(accountInfoAdapter(openai), null);
  assert.equal(profile.canRefresh, false);
  assert.equal(profile.balanceQueryable, false);
  assert.equal(profile.quotaMode, 'console');
  assert.deepEqual(profile.infoLinks.map(link => link.id), ['openai-api-usage', 'openai-api-billing']);
  assert.equal(canQueryBalance(openai), false);
  const requests = [];
  await assert.rejects(queryBalance(openai, async url => { requests.push(url); }), /OpenAI API Key/);
  assert.deepEqual(requests, []);
  for (const baseUrl of ['https://api.openai.com', 'https://api.openai.com/v1/'])
    assert.equal(canQueryBalance({ ...openai, baseUrl }), false);
  assert.equal(canQueryBalance({ ...openai, baseUrl: 'https://relay.example/v1' }), true);
  assert.equal(canQueryBalance({ ...openai, balance: { preset: 'custom', path: '/v1/usage' } }), true);
  const custom = await queryBalance({ ...openai, balance: { preset: 'custom', path: '/custom/balance' } }, async url => {
    requests.push(url);
    return Response.json({ total_available: 12 });
  });
  assert.equal(custom.value, 12);
  assert.deepEqual(requests, ['https://api.openai.com/custom/balance']);
});

test('Codex image generation and edit routes preserve upstream paths and native OAuth', async t => {
  const calls = [];
  const router = new Router({ getState: () => ({}), fetchUpstream: async (url, init) => {
    calls.push({ url, init }); return Response.json({ data: [{ b64_json: 'fixture-image' }] });
  } });
  await router.start(0); t.after(() => router.stop());
  for (const endpoint of ['generations', 'edits']) {
    const body = Buffer.from(`{"prompt":"synthetic ${endpoint}"}`);
    const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/images/${endpoint}`, {
      method: 'POST', headers: { authorization: 'Bearer native-oauth', 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls.at(-1).url, `https://chatgpt.com/backend-api/codex/images/${endpoint}`);
    assert.equal(calls.at(-1).init.headers.authorization, 'Bearer native-oauth');
    assert.deepEqual(calls.at(-1).init.body, body);
  }
});

test('visible TPS excludes reasoning and sub-second output intervals', () => {
  let now = 1000;
  const metrics = new RequestMetrics({ now: () => now, began: 0 });
  metrics.event({ type: 'response.output_text.delta', delta: '12345678' }, now);
  metrics.event({ type: 'response.reasoning.delta', delta: 'hidden'.repeat(80) }, now + 100);
  assert.equal(metrics.snapshot({ live: true }).tps, null);
  now = 2250;
  metrics.event({ type: 'response.output_text.delta', delta: 'abcdefgh' }, now);
  const result = metrics.snapshot({ live: true });
  assert.equal(result.visibleTokens, 4);
  assert.equal(result.visibleMs, 1250, 'TPS retains the measured millisecond interval');
  assert.equal(result.tps, 3.2, 'TPS does not truncate timing to whole seconds');
});

test('request history archives evicted calls once and reloads the accumulated total', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-critical-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = new RequestHistory(directory);
  for (let i = 0; i < 205; i++) history.append({ time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    model: 'fixture-model', source: 'Fixture', client: 'codex', status: 200, httpStatus: 200, taskOk: true, ok: true,
    ms: 1000, usage: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(history.snapshot().rows.length, 200);
  assert.equal(history.snapshot().archived, 5);
  const restored = new RequestHistory(directory);
  assert.equal(restored.snapshot().archived, 5);
  assert.equal(restored.snapshot().archive[0].stats.calls, 5);
});

test('Claude session usage retains reported cache hits through both OpenAI adapters', async () => {
  const frames = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n').body;
  const time = new Date().toISOString();
  for (const [protocol, events] of [
    ['openai-responses', [{ type: 'response.completed', response: { status: 'completed', output: [], usage: {
      input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 7,
    } } }]],
    ['openai-chat', [{ choices: [{ index: 0, finish_reason: 'stop' }] }, { choices: [], usage: {
      prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 7,
    } }]],
  ]) {
    const message = await messagesJSON(messagesEvents(frames(events), protocol, 'fixture'));
    assert.deepEqual(message.usage, { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 80 });
    const transcript = usageParser('claude', 'fixture');
    transcript.accept({ type: 'assistant', timestamp: time, message });
    const [row] = transcript.rows.values();
    assert.deepEqual([row.input, row.output, row.cacheRead], [100, 7, 80]);
  }
});

test('project-archived Claude transcripts are counted once alongside live profiles', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-usage-project-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'workspace'), live = path.join(home, '.claude', 'projects'), archived = path.join(project, 'missions', 'completed');
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(archived, { recursive: true });
  const message = (id, input) => JSON.stringify({ type: 'assistant', sessionId: 'fixture-session', timestamp: new Date().toISOString(),
    message: { id, model: 'fixture-model', usage: { input_tokens: input, output_tokens: 4 } } });
  const shared = message('msg-shared', 10);
  fs.writeFileSync(path.join(live, 'session.jsonl'), shared + '\n');
  fs.writeFileSync(path.join(archived, 'transcript.jsonl'), [shared, message('msg-archive-only', 25)].join('\n') + '\n');
  fs.writeFileSync(path.join(archived, 'other.jsonl'), message('msg-unrecognized-location', 500) + '\n');
  const { snapshot } = await scanUsage({ home, dataDir: home, env: {}, codexDir: path.join(home, '.codex'), projects: [project] });
  const rows = snapshot.rows.filter(row => row.client === 'claude');
  assert.equal(rows.reduce((n, row) => n + row.calls, 0), 2);
  assert.equal(rows.reduce((n, row) => n + row.input, 0), 35);
  assert.equal(rows.reduce((n, row) => n + row.output, 0), 8);
});

test('WSL sync projects Codex routes and retains unrelated native settings', () => {
  const model = 'ASS_fixture::gpt-6.1-sol';
  const rows = projection('codex', { model, effort: 'high', contextWindow: 1000000,
    plan: { localToken: 'synthetic-local-token', catalog: { models: [] } } },
  { dirs: { codex: '/home/test/.codex' } }, 'http://127.0.0.1:25819');
  const config = rows.find(row => row.file.endsWith('config.toml'));
  const fields = Object.fromEntries(config.fields.map(field => [field.keys[0], field.value]));
  assert.equal(fields.model, model);
  assert.equal(fields.openai_base_url, 'http://127.0.0.1:25819/clients/ASS/v1');
  assert.equal(fields.model_context_window, 1000000);
  assert.equal(fields.model_auto_compact_token_limit, 900000);
  assert.match(rows.find(row => row.file.endsWith('auth.json')).fields[1].value, /^synthetic-local-token$/);
  const file = '/home/test/.claude/settings.json';
  const planned = planFiles([{ file, format: 'json', fields: [{ keys: ['model'], value: 'ASS_fixture::model' }] }], [], {
    [file]: '{"model":"old","permissions":{"deny":["Bash(rm *)"]}}',
  });
  assert.equal(planned.files.length, 1);
  const result = JSON.parse(planned.files[0].after);
  assert.equal(result.model, 'ASS_fixture::model');
  assert.deepEqual(result.permissions.deny, ['Bash(rm *)']);
});

test('a pi WSL provider exclusion withdraws its credential and restores the Linux default', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-wsl-pi-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = '/home/test/.pi/agent';
  const info = { binaries: { pi: '/usr/local/bin/pi' }, dirs: { pi: dir } };
  const makeId = id => providerId({ id }, 'openai-responses');
  const first = makeId('first'), second = makeId('second');
  const sources = { pi: { files: [
    { name: 'models.json', fields: [first, second].map(id => ({ keys: ['providers', id], value: { baseUrl: 'https://fixture.invalid/v1' } })) },
    { name: 'auth.json', fields: [first, second].map(id => ({ keys: [id], value: { type: 'api_key', key: 'fixture' } })) },
    { name: 'settings.json', fields: [{ keys: ['defaultProvider'], value: first }, { keys: ['defaultModel'], value: 'fixture' }] },
  ] } };
  const contents = { [dir + '/settings.json']: '{"defaultProvider":"local","defaultModel":"local-model","theme":"dark"}' };
  const run = async (_, input) => {
    if (input.action === 'inspect') return info;
    if (input.action === 'read') return Object.fromEntries(input.files.map(file => [file, contents[file] ?? null]));
    for (const row of input.files) contents[row.file] = row.after;
  };
  const sync = new WslSync({ dataDir, crypto: testCrypto(), sources: () => sources, run });
  sync.state.distro = 'Test';
  await sync.sync(['pi']);
  assert.equal(sync.public().clients.pi.enabled, true);
  const settings = () => JSON.parse(contents[dir + '/settings.json']);
  assert.equal(settings().defaultProvider, first);
  await sync.configure('pi', { providerId: 'first', enabled: false });
  assert.equal(sync.public().clients.pi.error, '');
  assert.deepEqual(Object.keys(JSON.parse(contents[dir + '/models.json']).providers), [second]);
  assert.deepEqual(Object.keys(JSON.parse(contents[dir + '/auth.json'])), [second]);
  assert.deepEqual(settings(), { defaultProvider: 'local', defaultModel: 'local-model', theme: 'dark' });
  assert.equal(sources.pi.files[2].fields[0].value, first);
  await sync.configure('pi', { enabled: false });
  assert.equal(contents[dir + '/auth.json'], null);
  assert.equal(new WslSync({ dataDir, crypto: testCrypto() }).public().clients.pi.enabled, false);
});

test('scoped DNS follows the requested CNAME chain and accepts only public IPv4 answers', () => {
  const answer = parseAnswer('a.example', { Status: 0, Answer: [
    { name: 'a.example.', type: 5, data: 'b.example.', TTL: 45 },
    { name: 'b.example.', type: 1, data: '8.8.8.8', TTL: 60 },
    { name: 'b.example.', type: 1, data: '192.168.1.2', TTL: 60 },
  ] });
  assert.deepEqual(answer.addresses, ['8.8.8.8']);
  assert.equal(answer.ttl, 60);
  assert.throws(() => parseAnswer('a.example', { Status: 0, Answer: [
    { name: 'a.example', type: 1, data: '127.0.0.1', TTL: 30 },
  ] }));
});

test('local release and runtime packaging retain only production content', () => {
  assert.deepEqual(localRelease.parseArgs(['install', '--keep-running', '--json']), {
    command: 'install', prune: false, json: true, keepRunning: true,
  });
  assert.equal(packageLayout.allowed('core/router.cjs'), true);
  assert.equal(packageLayout.allowed('core/tests/fixture.cjs'), false);
  assert.equal(packageLayout.allowed('tests/critical.test.mjs'), false);
  assert.equal(packageLayout.allowed('dist/qa/fixture.js'), false);
  const brandScript = fs.readFileSync(path.join(process.cwd(), 'scripts/windows-brand-registration.ps1'), 'utf8');
  assert.match(brandScript, /@\('local\.ass\.desktop', 'ASS'\)/,
    'startup migration updates Electron and legacy Run values');
});
