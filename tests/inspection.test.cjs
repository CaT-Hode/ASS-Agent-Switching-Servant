const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  declaredCapabilities,
  discoverModels,
  probeCapabilities,
  inspectStream,
} = require("../core/model-inspection.cjs");
const p = {
  id: "fixture",
  baseUrl: "https://example.com/v1",
  apiKey: "synthetic-secret",
  wireApi: "openai-responses",
  network: "system",
};
const m = {
  model: "fixture-model",
  wireApi: "openai-responses",
  efforts: ["low", "max"],
};
const stream = (events) =>
  new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
test('Anthropic context exhaustion cannot pass capability inspection', async () => {
  for (const reason of ['end_turn', 'max_tokens', 'model_context_window_exceeded', 'refusal']) {
    const result = await inspectStream(stream([{type:'content_block_delta',delta:{type:'text_delta',text:'OK'}},
      {type:'message_delta',delta:{stop_reason:reason}}, {type:'message_stop'}]).body, 'anthropic', 'nonce');
    const limited = ['max_tokens', 'model_context_window_exceeded'].includes(reason);
    assert.equal(result.incomplete, limited); assert.equal(result.completed, !limited); assert.equal(result.text, true);
  }
});
function success(body) {
  const marker = body.input.match(/marker ([a-f0-9]+)/)?.[1];
  return stream([
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: body.tools
          ? [
              {
                type: "function_call",
                id: "call",
                name: "ass_probe_echo",
                arguments: JSON.stringify({ marker }),
              },
            ]
          : [
              {
                type: "message",
                content: [{ type: "output_text", text: "437" }],
              },
            ],
      },
    },
  ]);
}
test("metadata preserves uncertainty and distinguishes statements from configured defaults", () => {
  assert.equal(declaredCapabilities({ id: "gpt-any" }).contextWindow, null);
  assert.equal(declaredCapabilities({}).tools, null);
  const value = declaredCapabilities({
    context_length: 65536,
    supported_parameters: ["tools", "reasoning"],
    architecture: { input_modalities: ["text", "image"] },
    supported_reasoning_levels: [{ effort: "low" }, "max", "imaginary"],
  });
  assert.equal(value.contextWindow, 65536);
  assert.equal(value.vision, true);
  assert.deepEqual(value.efforts, ["low", "max"]);
  assert.doesNotThrow(() =>
    declaredCapabilities({ supported_reasoning_levels: "malformed" }),
  );
});
test("discovery uses same-origin API credentials, bounded fields and no redirected auth", async () => {
  const report = await discoverModels(p, async (url, options) => {
    assert.equal(url, "https://example.com/v1/models");
    assert.equal(options.headers.authorization, "Bearer synthetic-secret");
    assert.equal(options.redirect, "error");
    return Response.json({
      data: [
        { id: "a", private_secret: "not-for-ui" },
        { id: "a" },
        { id: "b", context_window: 12345 },
      ],
    });
  });
  assert.equal(report.models.length, 2);
  assert.ok(!JSON.stringify(report).includes("not-for-ui"));
});
test("real tool structure is observed, effort acceptance requires an invalid-value control", async () => {
  const report = await probeCapabilities(p, m, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, m.model);
    if (url.endsWith("/messages"))
      return stream([{ type: "content_block_delta", delta: { type: "text_delta", text: "437" } }, { type: "message_stop" }]);
    if (url.endsWith("/chat/completions"))
      return stream([{ choices: [{ delta: { content: "437" }, finish_reason: "stop" }] }]);
    assert.equal(body.max_output_tokens, 512);
    if (body.reasoning?.effort === "ass_invalid_effort")
      return Response.json(
        { error: { message: "invalid reasoning effort" } },
        { status: 400 },
      );
    return success(body);
  });
  assert.equal(report.tools.status, "observed");
  assert.equal(report.efforts.max.status, "validated");
  assert.equal(report.requestCount, 7);
  assert.equal(report.protocols.anthropic.status, "passed", "Messages is checked even after Responses succeeds");
  assert.equal(report.protocols["openai-chat"].status, "passed", "Chat is checked even after Responses and Messages succeed");
  assert.ok(!JSON.stringify(report).includes(p.apiKey));
});
test("capability detection checks Chat after either Responses or Messages succeeds", async () => {
  for (const working of ["responses", "messages"]) {
    const calls = [];
    const report = await probeCapabilities(p, { ...m, efforts: [] }, async (url, options) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/chat/completions")) return stream([{ choices: [{ delta: { content: "437" }, finish_reason: "stop" }] }]);
      if (url.endsWith("/" + working)) return working === "responses" ? success(JSON.parse(options.body)) : stream([{ type: "content_block_delta", delta: { type: "text_delta", text: "437" } }, { type: "message_stop" }]);
      return Response.json({}, { status: 405 });
    });
    assert.deepEqual(calls.slice(0, 3), ["/v1/responses", "/v1/messages", "/v1/chat/completions"]);
    assert.equal(report.protocols["openai-chat"].status, "passed");
  }
});
test("a later protocol rate limit stops tool and effort capability probes", async () => {
  for (const limitAt of ["messages", "completions"]) {
    const report = await probeCapabilities(p, m, async (url, options) => {
      if (url.endsWith("/" + limitAt)) return Response.json({}, { status: 429 });
      if (url.endsWith("/messages")) return stream([{ type: "content_block_delta", delta: { type: "text_delta", text: "437" } }, { type: "message_stop" }]);
      return success(JSON.parse(options.body));
    });
    assert.equal(report.requestCount, limitAt === "messages" ? 2 : 3);
    assert.equal(report.tools.status, "unknown");
    assert.deepEqual(report.efforts, {});
  }
});
test("HTTP 200 for invalid effort does not prove intensity support", async () => {
  const report = await probeCapabilities(p, m, async (_, options) =>
    success(JSON.parse(options.body)),
  );
  assert.equal(report.efforts.low.status, "accepted-unverified");
  assert.equal(report.efforts.max.status, "accepted-unverified");
});
test("truncated responses are unknown; rate limits stop rather than causing more probes", async () => {
  const parsed = await inspectStream(
    stream([{ type: "response.output_text.delta", delta: "partial" }]).body,
    "openai-responses",
    "unused",
  );
  assert.equal(parsed.completed, false);
  const report = await probeCapabilities(p, m, async () =>
    Response.json({ error: "rate limit" }, { status: 429 }),
  );
  assert.equal(report.requestCount, 1);
  assert.deepEqual(report.efforts, {});
});
test("cancellation prevents additional requests", async () => {
  const controller = new AbortController();
  const report = await probeCapabilities(
    p,
    m,
    async (_, options) => {
      controller.abort();
      return success(JSON.parse(options.body));
    },
    { signal: controller.signal },
  );
  assert.equal(report.cancelled, true);
  assert.equal(report.requestCount, 1);
});
