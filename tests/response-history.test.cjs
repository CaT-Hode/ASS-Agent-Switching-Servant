const { test } = require("node:test");
const assert = require("node:assert/strict");
const { officialCodexHistory } = require("../core/response-history.cjs");
const { Router, routeFor } = require("../core/router.cjs");
const { codexModelId } = require("../core/models.cjs");

const foreignReasoning = () => ({
  type: "reasoning", id: "123e4567-e89b-42d3-a456-426614174001",
  content: [{ type: "reasoning_text", text: "synthetic provider reasoning" }],
  summary: [], encrypted_content: "synthetic-foreign-state",
});
const nativeReasoning = () => ({
  type: "reasoning", id: "rs_synthetic", content: [],
  summary: [{ type: "summary_text", text: "synthetic summary" }],
  encrypted_content: "synthetic-official-state",
});
const state = { providers: [{
  id: "deepseek-fixture", name: "DeepSeek fixture", enabled: true,
  apiKey: "synthetic-provider-key", baseUrl: "https://provider.invalid/v1", network: "system",
  models: [{ model: "deepseek-v4-pro", enabled: true, wireApi: "openai-responses", defaultEffort: "high" }],
}] };
const freeze = value => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

test("DeepSeek to official GPT removes the incompatible whole reasoning item without editing history", () => {
  const before = freeze({ model: "gpt-6.1-sol", store: false, input: [
    { role: "user", content: "hello" }, foreignReasoning(),
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "hello back" }] },
    { role: "user", content: "continue" },
  ] });
  const serialized = JSON.stringify(before);
  const route = routeFor(before, state);
  assert.equal(route.official, true);
  assert.equal(route.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.deepEqual(route.body.input, [before.input[0], before.input[2], before.input[3]]);
  assert.equal(route.body.store, false);
  assert.equal(route.body.model, before.model);
  assert.equal(JSON.stringify(before), serialized);
  assert.equal(JSON.stringify(route.body).includes("synthetic-foreign-state"), false);
  assert.equal(JSON.stringify(route.body).includes("synthetic provider reasoning"), false);
});

test("official native reasoning, assistant phases, media and tool pairs retain identity and order", () => {
  const native = nativeReasoning();
  const kept = [
    { role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "synthetic:image" }] },
    native,
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "checking" }] },
    { type: "function_call", call_id: "call_fixture", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fixture", output: "result" },
    { type: "reasoning", id: "rs_other", encrypted_content: "synthetic-other-state", summary: [] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] },
  ];
  const body = freeze({ model: "gpt-6.1-sol", input: [foreignReasoning(), ...kept, foreignReasoning()],
    reasoning: { effort: "high" }, tools: [{ type: "function", name: "inspect", parameters: {} }],
    include: ["reasoning.encrypted_content"], previous_response_id: "resp_fixture" });
  const result = officialCodexHistory(body);
  assert.deepEqual(result, { ...body, input: kept });
  kept.forEach((item, i) => assert.equal(result.input[i], item));
  assert.equal(result.reasoning, body.reasoning);
  assert.equal(result.tools, body.tools);
  assert.equal(result.include, body.include);
});

test("valid official history and non-array input pass through unchanged", () => {
  for (const input of [undefined, null, "hello", [], [nativeReasoning()], [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
  ]]) {
    const body = freeze({ model: "gpt-6.1-sol", input });
    assert.equal(officialCodexHistory(body), body);
  }
});

test("unknown or malformed history is left to upstream validation, not silently repaired", () => {
  const body = freeze({ input: [null, "unexpected", { type: "reasoning", content: "malformed" },
    { type: "reasoning", content: null }, { type: "compaction", encrypted_content: "opaque" },
    { type: "function_call_output", content: ["unknown"], call_id: "call_fixture" }] });
  assert.equal(officialCodexHistory(body), body);
});

test("native third-party Responses and compact preserve their own reasoning and encrypted state", () => {
  const body = freeze({ model: codexModelId("deepseek-fixture", "deepseek-v4-pro"), input: [foreignReasoning()] });
  for (const suffix of ["", "/compact"]) {
    const route = routeFor(body, state, suffix);
    assert.equal(route.official, false);
    assert.equal(route.body.input, body.input);
    assert.equal(route.body.input[0].encrypted_content, "synthetic-foreign-state");
    assert.equal(route.body.model, "deepseek-v4-pro");
  }
});

test("normalization never changes routing ownership or falls back for unknown models", () => {
  assert.throws(() => routeFor({ model: "unknown::gpt", input: [foreignReasoning()] }, state), /未启用/);
  const body = freeze({ model: "gpt-6.1-sol", input: [foreignReasoning(), nativeReasoning()] });
  const route = routeFor(body, state, "/compact");
  assert.equal(route.url, "https://chatgpt.com/backend-api/codex/responses/compact");
  assert.deepEqual(route.body.input, [body.input[1]]);
});

test("HTTP Responses and compact send normalized history once with original subscription auth", async t => {
  const calls = [];
  const router = new Router({ getState: () => state, fetchUpstream: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    assert.equal(body.input.some(item => item?.type === "reasoning" && item.content?.length), false);
    return new Response(JSON.stringify({ id: "resp_fixture", status: "completed", output: [] }),
      { headers: { "content-type": "application/json" } });
  } });
  await router.start(0); t.after(() => router.stop());
  for (const suffix of ["", "/compact"]) {
    const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses${suffix}`, {
      method: "POST", headers: { authorization: "Bearer synthetic-subscription-token",
        "chatgpt-account-id": "synthetic-account", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", stream: false, input: [foreignReasoning(), nativeReasoning(),
        { role: "user", content: "continue" }] }),
    });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "completed");
  }
  assert.equal(calls.length, 2, "no automatic retry or duplicate request");
  calls.forEach(call => {
    assert.equal(call.headers.authorization, "Bearer synthetic-subscription-token");
    assert.equal(call.headers["chatgpt-account-id"], "synthetic-account");
    assert.deepEqual(call.body.input, [nativeReasoning(), { role: "user", content: "continue" }]);
    assert.equal(call.headers["x-api-key"], undefined);
  });
  assert.equal(calls[1].url, "https://chatgpt.com/backend-api/codex/responses/compact");
});

test("HTTP native third-party route still forwards its original reasoning with provider auth", async t => {
  const calls = [];
  const router = new Router({ getState: () => state, fetchUpstream: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ status: "completed", output: [] }), { headers: { "content-type": "application/json" } });
  } });
  await router.start(0); t.after(() => router.stop());
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer synthetic-subscription-token", "content-type": "application/json" },
    body: JSON.stringify({ model: codexModelId("deepseek-fixture", "deepseek-v4-pro"), stream: false, input: [foreignReasoning()] }),
  });
  assert.equal(response.status, 200); await response.json();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer synthetic-provider-key");
  assert.deepEqual(calls[0].body.input, [foreignReasoning()]);
  assert.equal(calls[0].body.model, "deepseek-v4-pro");
});

test("official streaming output remains byte-for-byte unchanged after outbound normalization", async t => {
  const responseText = 'event: response.output_item.done\ndata: ' + JSON.stringify({ type: "response.output_item.done", item: nativeReasoning() }) +
    '\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const router = new Router({ getState: () => state, fetchUpstream: async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).input, [{ role: "user", content: "continue" }]);
    return new Response(responseText, { headers: { "content-type": "text/event-stream" } });
  } });
  await router.start(0); t.after(() => router.stop());
  const response = await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer synthetic-subscription-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", stream: true, input: [foreignReasoning(), { role: "user", content: "continue" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), responseText);
});
