const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Store } = require("../core/store.cjs");
const { promoteNativeSupplier } = require("../core/native-suppliers.cjs");
const { injectionCatalog, acceptsApiAccount } = require("../core/client-policy.cjs");
const { harnessRoute } = require("../core/harness-route.cjs");
const { messagesRequest, messagesEvents, messagesJSON } = require("../core/messages-adapter.cjs");
const { providerSessionHeaders } = require("../core/provider-transport.cjs");
const { Router } = require("../core/router.cjs");
const { translateStream } = require("../core/adapters.cjs");
const { diagnosticMetrics } = require("../core/diagnostic-metrics.cjs");
const { modelSources } = require("../core/model-inventory.cjs");
const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
const stream = (events) => new Response(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
test("verified native APIs become encrypted, persistent suppliers for all clients without becoming foreign official accounts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-native-supplier-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "auth.json"); fs.writeFileSync(file, JSON.stringify({ "opencode-go": { type: "api", key: "synthetic-go" } }));
  const store = new Store(dir, dir, crypto), account = { id: "native", kind: "native", authType: "api", ready: true, provider: "opencode-go", sourcePath: file };
  const args = { store, client: { id: "opencode" }, account, models: [{ model: "glm-demo" }, { model: "minimax-m2.7" }] };
  assert.equal(promoteNativeSupplier({ ...args, verified: false }), null);
  const id = promoteNativeSupplier({ ...args, verified: true });
  assert.equal(promoteNativeSupplier({ ...args, verified: true }), id); assert.equal(store.state.providers.length, 1);
  const provider = new Store(dir, dir, crypto).state.providers[0];
  assert.equal(provider.models[0].wireApi, "openai-chat"); assert.equal(provider.models[1].wireApi, "anthropic");
  for (const client of ["codex", "claude", "dsh", "opencode", "pi"])
    assert.equal(injectionCatalog(client, [provider]).filter((m) => m.included).length, 2);
  for (const client of ["codex", "claude", "dsh"]) assert.equal(acceptsApiAccount(client, provider), false);
  assert.doesNotMatch(JSON.stringify(store.public()), /synthetic-go/);
  const sources = modelSources(store.public(), { clients: [{ id: "opencode", accounts: [{ ...account, supplierId: id }] }] });
  assert.equal(sources.filter((s) => s.kind === "native").length, 0, "promoted accounts do not duplicate supplier cards");
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { "opencode-go": { type: "api", key: "synthetic-go" } });
  store.state.providers = []; store.state.nativeSupplierExclusions = [id];
  assert.equal(promoteNativeSupplier({ ...args, verified: true }), null);
  assert.equal(promoteNativeSupplier({ ...args, account: { ...account, authType: "oauth" }, verified: true }), null);
});
test("Claude uses DeepSeek's native Messages endpoint and adapts Go chat without protocol relabeling", () => {
  const p = { id: "p", enabled: true, apiKey: "synthetic", baseUrl: "https://api.deepseek.com", models: [{ model: "deepseek-chat", wireApi: "openai-chat", enabled: true }] };
  let route = harnessRoute("/models/v1/messages", { model: "ASS_148de9c5a7a44d19e56cd9ae::deepseek-chat" }, { providers: [p] });
  assert.equal(route.url, "https://api.deepseek.com/anthropic/v1/messages"); assert.equal(route.adapted, false);
  p.baseUrl = "https://opencode.ai/zen/go/v1";
  route = harnessRoute("/models/v1/messages", { model: "ASS_148de9c5a7a44d19e56cd9ae::deepseek-chat" }, { providers: [p] });
  assert.equal(route.protocol, "openai-chat"); assert.equal(route.adapted, true);
  const headers = providerSessionHeaders(p, { session_id: "conversation-a", authorization: "Bearer official", "chatgpt-account-id": "other" });
  assert.equal(headers["x-opencode-session"], "conversation-a"); assert.equal(headers.authorization, undefined);
  assert.equal(headers["chatgpt-account-id"], undefined);
});
test("Messages tool round trips preserve IDs, JSON arguments, usage and truncated stream failure", async () => {
  const model = { model: "glm", maxOutputTokens: 1024 };
  const converted = messagesRequest({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "echo", input: { v: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "ok" }] }], tools: [{ name: "echo", input_schema: { type: "object" } }] }, model, "openai-chat");
  assert.equal(converted.messages[0].tool_calls[0].id, "call-a"); assert.equal(converted.messages[1].tool_call_id, "call-a");
  const r = stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "next-call", function: { name: "echo", arguments: '{"v":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 15, completion_tokens: 6 }, choices: [] }]);
  const message = await messagesJSON(messagesEvents(r.body, "openai-chat", "glm"));
  assert.equal(message.stop_reason, "tool_use"); assert.deepEqual(message.content, [{ type: "tool_use", id: "next-call", name: "echo", input: { v: 2 } }]);
  assert.deepEqual(message.usage, { input_tokens: 15, output_tokens: 6 });
  await assert.rejects(messagesJSON(messagesEvents(stream([{ choices: [{ delta: { content: "partial" } }] }]).body, "openai-chat", "glm")), /提前断开/);
  assert.throws(() => messagesRequest({ messages: [{ role: "user", content: [{ type: "image" }] }] }, model, "openai-chat"), /不支持 image/);
});
test("real loopback Claude relay converts text and tools, preserves session, and keeps upstream credentials server-side", async (t) => {
  const provider = { id: "go", enabled: true, apiKey: "synthetic-upstream-key", name: "Go", baseUrl: "https://opencode.ai/zen/go/v1", models: [{ model: "glm", enabled: true, wireApi: "openai-chat" }] };
  const calls = [];
  const router = new Router({ getState: () => ({ providers: [provider] }), fetchUpstream: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return stream([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }, { usage: { prompt_tokens: 7, completion_tokens: 1 } }]);
  } });
  await router.start(0); t.after(() => router.stop());
  for (const streaming of [true, false]) {
    const r = await fetch(`http://127.0.0.1:${router.server.address().port}/clients/claude/models/v1/messages`, { method: "POST", headers: { "x-api-key": router.clientToken, "content-type": "application/json", "x-session-id": "conversation-one" },
      body: JSON.stringify({ model: require('../core/models.cjs').codexModelId('go', 'glm'), messages: [{ role: "user", content: "Say OK" }], stream: streaming, max_tokens: 32 }) });
    assert.equal(r.status, 200); const text = await r.text();
    assert.match(text, /OK/); assert.doesNotMatch(text, /synthetic-upstream-key/);
    if (streaming) assert.match(text, /message_stop/); else assert.equal(JSON.parse(text).content[0].text, "OK");
  }
  assert.equal(calls[0].headers["x-opencode-session"], "conversation-one");
  assert.equal(calls[0].headers.authorization, "Bearer synthetic-upstream-key");
  assert.equal(calls[0].body.model, "glm");
});
test("parallel tool calls stay in one assistant turn and final-only Responses arguments are not discarded", async () => {
  const calls = [1, 2].map((i) => ({ type: "tool_use", id: "call" + i, name: "echo", input: { i } }));
  const body = messagesRequest({ messages: [{ role: "assistant", content: calls },
    { role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "ok" })) }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true } }, { model: "glm" }, "openai-chat");
  assert.equal(body.messages[0].tool_calls.length, 2);
  assert.deepEqual(body.messages.slice(1).map((m) => m.tool_call_id), ["call1", "call2"]);
  assert.equal(body.parallel_tool_calls, false);
  const item = { type: "function_call", id: "fc1", call_id: "call1", name: "echo", arguments: '{"value":42}' };
  const output = await messagesJSON(messagesEvents(stream([
    { type: "response.output_item.added", item: { ...item, arguments: "" } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item] } },
  ]).body, "openai-responses", "gpt"));
  assert.deepEqual(output.content[0].input, { value: 42 });
  assert.equal(output.content.length, 1);
});
test("missing upstream usage stays unknown after protocol adaptation", async () => {
  const metrics = diagnosticMetrics("openai-chat", "router");
  for await (const event of translateStream(stream([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]).body, "openai-chat", "glm")) metrics.observe(event);
  assert.equal(metrics.finish(true).inputTokens, undefined);
  assert.equal(metrics.finish(true).outputTokens, undefined);
});
