const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Router } = require("../core/router.cjs");
const { claudeModels, resolveClaudeModel } = require("../core/claude-models.cjs");
const { codexModelId } = require("../core/models.cjs");
const { claudeModelSettings, claudeModelEnv } = require("../core/accountless.cjs");
const providers = [{ id: "relay", name: "Relay", enabled: true, apiKey: "synthetic-key", baseUrl: "https://relay.test/v1", models: [
  { model: "kimi/messages", enabled: true, wireApi: "anthropic" },
  { model: "gpt-test", enabled: true, wireApi: "openai-responses" },
  { model: "deepseek-chat", enabled: true, wireApi: "openai-chat" },
  { model: "claude-opus", enabled: true, wireApi: "anthropic" },
  { model: "disabled", enabled: false, wireApi: "anthropic" },
] }];
test("native Messages and both converted protocols share the full picker and discovery catalog", () => {
  const rows = claudeModels(providers), settings = claudeModelSettings(providers, codexModelId('relay', 'kimi/messages'));
  assert.equal(rows.length, 4); assert.equal(settings.modelPicker.options.length, 4);
  assert.ok(rows.every(m => /^claude-ass-[a-f0-9]{32}$/.test(m.discoveryId)));
  assert.equal(new Set(rows.map(m => m.discoveryId)).size, rows.length);
  for (const m of rows) {
    assert.match(m.cliModel, /^ASS_[a-f0-9]{24}::/);
    assert.equal(m.cliModel, codexModelId('relay', m.description));
    assert.equal(resolveClaudeModel(providers, m.discoveryId), m.model);
    assert.equal(resolveClaudeModel(providers, m.model), m.model);
    assert.equal(resolveClaudeModel(providers, m.discoveryId + "[1m]"), m.model);
  }
  assert.equal(resolveClaudeModel(providers, "claude-ass/foreign::model"), "claude-ass/foreign::model");
  assert.equal(resolveClaudeModel(providers, "claude-ass/relay::gpt-test"), "claude-ass/relay::gpt-test");
  assert.equal(resolveClaudeModel(providers, "claude-ass/relay::gpt-test[1m]"), "claude-ass/relay::gpt-test[1m]");
  assert.equal(resolveClaudeModel(providers, "relay::gpt-test[1m]"), "relay::gpt-test[1m]");
  assert.throws(() => claudeModelSettings(providers, 'relay::gpt-test'), /不在已注入/);
  assert.equal(resolveClaudeModel(providers, "relay::claude-opus"), "relay::claude-opus");
  assert.equal(claudeModels([{ ...providers[0], enabled: false }]).length, 0);
});
test('CLI marks million-token deployments while keeping routing identities and ordinary contexts unchanged', () => {
  const configured = structuredClone(providers);
  for (const context of [200000, 999999, 1000000, 1048576]) {
    for (const model of configured[0].models) model.contextWindow = context;
    const rows = claudeModels(configured), suffix = context >= 1000000 ? '[1m]' : '';
    const settings = claudeModelSettings(configured, rows[0].model);
    assert.deepEqual(settings.availableModels, rows.map(row => codexModelId('relay', row.description) + suffix));
    assert.equal(settings.model, codexModelId('relay', rows[0].description) + suffix);
    assert.deepEqual(settings.modelPicker.options.map(row => row.model), settings.availableModels);
    assert.equal(settings.modelPicker.options[0].label, rows[0].label + (suffix ? ' [1m]' : ''));
    const env = claudeModelEnv(configured, rows[0].model, rows[1].model);
    assert.equal(env.ANTHROPIC_MODEL, codexModelId('relay', rows[0].description) + suffix);
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_MODEL, codexModelId('relay', rows[1].description) + suffix);
    for (const row of rows) assert.equal(resolveClaudeModel(configured, row.cliModel), row.model);
  }
});

test('CLI auto-compact window follows 95 percent of the selected deployment within native limits', () => {
  const configured = structuredClone(providers);
  for (const [context, expected] of [[64000, 100000], [128000, 121600], [200000, 190000],
    [1000000, 950000], [1048576, 996147], [2000000, 1000000]]) {
    configured[0].models[0].contextWindow = context;
    const row = claudeModels(configured)[0];
    const settings = claudeModelSettings(configured, row.cliModel);
    assert.equal(settings.autoCompactWindow, expected);
    assert.equal(settings.modelSettings[codexModelId('relay', row.description).toLowerCase()].autoCompactWindow, expected);
  }
  delete configured[0].models[0].contextWindow;
  assert.equal(claudeModelSettings(configured, codexModelId('relay', 'kimi/messages')).autoCompactWindow, undefined);
});

test('routed Claude versions use the canonical per-model compact key', () => {
  const configured = structuredClone(providers);
  configured[0].models = [{ model: 'claude-opus-4-6-20260101', enabled: true, wireApi: 'anthropic', contextWindow: 1000000 }];
  assert.deepEqual(claudeModelSettings(configured, codexModelId('relay', 'claude-opus-4-6-20260101')).modelSettings,
    { 'claude-opus-4-6': { autoCompactWindow: 950000 } });
});

test("ASS CLI IDs and desktop discovery reach the original upstream models; old provider prefixes are rejected", async t => {
  const calls = [];
  const router = new Router({ getState: () => ({ providers }), fetchUpstream: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, model: body.model });
    const events = url.endsWith("messages") ? [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } }, { type: "message_stop" }]
      : url.endsWith("responses") ? [{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]
      : [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }];
    return new Response(events.map(e => "data: " + JSON.stringify(e) + "\n\n").join(""));
  } });
  await router.start(0); t.after(() => router.stop());
  const base = `http://127.0.0.1:${router.port}/clients/claude/models/v1`, headers = { authorization: "Bearer " + router.clientToken };
  const directory = await (await fetch(base + "/models", { headers })).json();
  assert.equal(directory.data.length, 4);
  const old = await fetch(base + '/messages', { method: 'POST', headers,
    body: JSON.stringify({ model: 'relay::kimi/messages', messages: [], max_tokens: 16 }) });
  assert.equal(old.status, 404);
  for (const m of directory.data) {
    const row = claudeModels(providers).find(row => row.discoveryId === m.id);
    for (const model of [m.id, row.cliModel + '[1m]', row.model]) {
    const response = await fetch(base + "/messages?beta=true", { method: "POST", headers, body: JSON.stringify({
      model, messages: [{ role: "user", content: "OK" }], stream: true, max_tokens: 16,
    }) });
    assert.equal(response.status, 200); const text = await response.text(); assert.match(text, /OK/); assert.match(text, /message_stop/);
    }
  }
  assert.deepEqual(calls.map(c => c.model), providers[0].models.filter(m => m.enabled).flatMap(m => Array(3).fill(m.model)));
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ["/v1/messages", "/v1/responses", "/v1/chat/completions", "/v1/messages"].flatMap(p => Array(3).fill(p)));
});
