const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {
  parseImport,
  normalizeModel,
  makeCatalog,
  endpoint,
  codexModelId,
} = require("../core/models.cjs");
const {
  prepareConfig,
  withoutOwn,
  ConfigManager,
  atomic,
} = require("../core/config.cjs");
const { routeFor, Router } = require("../core/router.cjs");
const { convertRequest, translateStream } = require("../core/adapters.cjs");
const source = {
  schemaVersion: 1,
  providers: [
    {
      id: "aimami_relay_test",
      name: "test",
      baseUrl: "https://example.com",
      apiKey: "test-key-not-real",
      wireApi: "openai-responses",
      models: [{ model: "gpt-6-astra", contextWindow: 900000 }],
    },
  ],
};
test("import retains provider IDs and explicit context; effort middle migrates to medium", () => {
  const p = parseImport(source)[0];
  assert.equal(p.id, "aimami_relay_test");
  assert.equal(p.models[0].contextWindow, 900000);
  const m = normalizeModel(
    {
      model: "test",
      efforts: ["low", "middle", "ultra"],
      defaultEffort: "middle",
    },
    p,
  );
  assert.deepEqual(m.efforts, ["low", "medium", "ultra"]);
  assert.equal(m.defaultEffort, "medium");
});
test("catalog writes chosen effort list and context exactly", () => {
  const p = parseImport(source)[0];
  p.models[0].efforts = ["high", "max", "ultra"];
  p.models[0].defaultEffort = "ultra";
  const c = makeCatalog([{ slug: "gpt-6-astra", context_window: 272000 }], [p]);
  const m = c.models[1];
  assert.equal(m.slug, codexModelId("aimami_relay_test", "gpt-6-astra"));
  assert.match(m.slug, /^ASS_[a-f0-9]+::/);
  assert.deepEqual(
    m.supported_reasoning_levels.map((x) => x.effort),
    ["high", "max", "ultra"],
  );
  assert.equal(m.default_reasoning_level, "ultra");
  assert.equal(m.context_window, 900000);
  assert.ok(m.base_instructions);
});

test('injection preserves every native official model field despite stale ASS overrides', () => {
  const official = [{ slug: 'gpt-6.1-sol', display_name: 'Sol', context_window: 500000,
    max_context_window: 872000, default_reasoning_level: 'low', supported_reasoning_levels: [{effort:'low'}],
    base_instructions: 'Native instructions', supports_parallel_tool_calls: true, future_capability: { enabled: true } }];
  const providers = parseImport(source);
  const stale = { 'gpt-6.1-sol': { model:'renamed', contextWindow:272000, efforts:['high'], defaultEffort:'high', enabled:false } };
  for (let i=0;i<2;i++) {
    const catalog = makeCatalog(official, providers, stale);
    assert.deepEqual(catalog.models.filter(m=>!m.slug.includes('::')), official);
    assert.equal(catalog.models.find(m=>m.slug.includes('::')).context_window, 900000);
    assert.equal(official[0].context_window, 500000);
  }
});

test('prediction structured output survives chat and Anthropic conversion without altering normal requests',()=>{
  const schema={type:'object',properties:{suggestion:{anyOf:[{type:'string'},{type:'null'}]}},required:['suggestion'],additionalProperties:false};
  const body={model:'custom',input:'Predict',text:{format:{type:'json_schema',name:'prediction',strict:true,schema}},reasoning:{effort:'low'}};
  const original=structuredClone(body);
  for(let i=0;i<2;i++) {
    const chat=convertRequest(body,{},'openai-chat');
    assert.deepEqual(chat.response_format,{type:'json_schema',json_schema:{name:'prediction',strict:true,schema}});
    const messages=convertRequest(body,{},'anthropic');
    assert.deepEqual(messages.output_config,{effort:'low',format:{type:'json_schema',schema}});
  }
  assert.deepEqual(body,original);
  assert.equal(convertRequest({model:'x',input:'Hi'}, {}, 'openai-chat').response_format,undefined);
  assert.equal(convertRequest({model:'x',input:'Hi'}, {}, 'anthropic').output_config,undefined);
  assert.throws(()=>convertRequest({...body,text:{format:{type:'json_schema'}}},{},'openai-chat'),/schema/);
  assert.throws(()=>convertRequest({...body,text:{format:{type:'unsupported'}}},{},'anthropic'),/输出格式/);
});
test("import validation rejects insecure destinations, duplicate IDs and sensitive custom headers", () => {
  for (const change of [
    { baseUrl: "http://example.com" },
    { baseUrl: "https://user:secret@example.com" },
    { extraHeaders: { Authorization: "secret" } },
    { balance: { path: "//evil.com" } },
  ])
    assert.throws(() =>
      parseImport({ providers: [{ ...source.providers[0], ...change }] }),
    );
  assert.throws(() =>
    parseImport({ providers: [source.providers[0], source.providers[0]] }),
  );
});
test("URLs do not accidentally drop /v1 or append it twice", () => {
  assert.equal(
    endpoint("https://example.com", "openai-responses"),
    "https://example.com/v1/responses",
  );
  assert.equal(
    endpoint("https://example.com/v1", "anthropic"),
    "https://example.com/v1/messages",
  );
  assert.equal(
    endpoint("https://example.com/prefix/v1", "openai-chat"),
    "https://example.com/prefix/v1/chat/completions",
  );
});
test("unknown namespaces never fall back to official; per-model protocol is honored", () => {
  const state = { providers: parseImport(source) };
  assert.throws(() => routeFor({ model: "removed::gpt" }, state));
  state.providers[0].models[0].wireApi = "anthropic";
  const r = routeFor({ model: codexModelId("aimami_relay_test", "gpt-6-astra") }, state);
  assert.equal(r.protocol, "anthropic");
  assert.equal(r.body.model, "gpt-6-astra");
  assert.equal(r.official, false);
});
test("attach and detach preserve user settings and later edits", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ass-config-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const codex = path.join(d, "codex"),
    data = path.join(d, "app");
  fs.mkdirSync(codex);
  const original =
    'model = "gpt-6-astra"\nmodel_provider = "custom"\n[features]\nfoo = true\n';
  atomic(path.join(codex, "config.toml"), original);
  const c = new ConfigManager(codex, data);
  c.attach();
  assert.equal(c.status().attached, true);
  let text = fs.readFileSync(c.file, "utf8");
  atomic(c.file, text.replace("foo = true", "foo = false"));
  c.detach();
  text = fs.readFileSync(c.file, "utf8");
  assert.ok(text.includes('model_provider = "custom"'));
  assert.ok(text.includes("foo = false"));
  assert.ok(!text.includes("25819"));
});
test("attach refuses another active router and competing provider definitions", () => {
  assert.throws(() =>
    prepareConfig("# >>> aimami-relay codex-router top start", "x"),
  );
  assert.throws(() =>
    prepareConfig('[model_providers.openai]\nname="mine"', "x"),
  );
  for (const provider of ["ASS", "ass_router", "aimai1"]) {
    assert.throws(() => prepareConfig(`model_provider = "${provider}"\n`, "x"), /其他工具/);
    assert.throws(() => prepareConfig(`[model_providers.${provider}]\nname="mine"`, "x"), /其他工具/);
  }
  assert.throws(() => prepareConfig('# >>> ass managed start\nmodel_provider="ASS"\n# <<< ass managed end', "x"), /验证接入记录/);
  assert.throws(() => prepareConfig("", "x", undefined, { model: "unknown::gpt", effort: "high" }), /当前 ASS 模型标识/);
  const generated = prepareConfig("", "catalog.json").text;
  assert.match(generated, /model_providers\.ASS/);
  assert.doesNotMatch(generated, /aimai1|ass_router/);
  assert.match(generated, /model_provider = "ASS"/);
  assert.match(generated, /openai_base_url = "http:\/\/127.0.0.1:25819\/clients\/ASS\/v1"/);
});
test("Anthropic conversion handles tool calls and tool results, excludes reasoning", () => {
  const request = convertRequest(
    {
      model: "claude",
      input: [
        { role: "user", content: "hello" },
        { type: "reasoning", encrypted_content: "private" },
        {
          type: "function_call",
          call_id: "call1",
          name: "shell",
          arguments: '{"cmd":"pwd"}',
        },
        { type: "function_call_output", call_id: "call1", output: "C:/test" },
      ],
      tools: [
        { type: "function", name: "shell", parameters: { type: "object" } },
      ],
      reasoning: { effort: "high" },
    },
    { maxOutputTokens: 4000 },
    "anthropic",
  );
  assert.equal(request.messages.length, 3);
  assert.equal(request.messages[1].content[0].type, "tool_use");
  assert.equal(request.messages[2].content[0].type, "tool_result");
  assert.equal(request.output_config.effort, "high");
  assert.ok(!JSON.stringify(request).includes("private"));
});
test("unsupported features fail explicitly rather than silently stripping input", () => {
  assert.throws(() =>
    convertRequest(
      { input: [{ role: "user", content: [{ type: "input_image" }] }] },
      {},
      "anthropic",
    ),
  );
  assert.throws(() =>
    convertRequest({ tools: [{ type: "web_search" }] }, {}, "anthropic"),
  );
});
function sse(data) {
  const text = data.map((x) => "data: " + JSON.stringify(x) + "\n\n").join("");
  const bytes = Buffer.from(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7)
        c.enqueue(bytes.subarray(i, i + 7));
      c.close();
    },
  });
}
test("Anthropic SSE conversion preserves UTF8, function arguments and usage", async () => {
  const input = [
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "你好" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call1", name: "shell" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"cmd":"pwd"}' },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ];
  const events = [];
  for await (const e of translateStream(sse(input), "anthropic", "claude"))
    events.push(e);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "你好");
  assert.equal(events.at(-1).response.output[1].arguments, '{"cmd":"pwd"}');
  assert.equal(events.at(-1).response.usage.total_tokens, 17);
});
test("truncated translated streams never claim success", async () => {
  await assert.rejects(async () => {
    for await (const e of translateStream(
      sse([{ choices: [{ delta: { content: "partial" } }] }]),
      "openai-chat",
      "test",
    )) {
    }
  });
});
test("router preserves streaming, separates credentials and cancels unsafe browser requests", async (t) => {
  const calls = [];
  const router = new Router({
    getState: () => ({ providers: parseImport(source) }),
    fetchUpstream: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(sse([{ type: "response.completed" }]), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  router.port = 0;
  await router.start();
  router.port = router.server.address().port;
  t.after(() => router.stop());
  const base = "http://127.0.0.1:" + router.port;
  for (const model of ["gpt-6-astra", codexModelId("aimami_relay_test", "gpt-6-astra")]) {
    const r = await fetch(base + "/clients/ASS/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-official-token",
        "chatgpt-account-id": "private-account",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, stream: true, input: "hi" }),
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /response.completed/);
  }
  assert.equal(
    calls[0].headers.authorization,
    "Bearer synthetic-official-token",
  );
  assert.equal(calls[1].headers.authorization, "Bearer test-key-not-real");
  assert.equal(calls[1].headers["chatgpt-account-id"], undefined);
  assert.equal(calls[1].body.model, "gpt-6-astra");
  const apiWindow = await fetch(base + "/clients/ASS/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + router.clientToken, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: "hi" }),
  });
  assert.equal(apiWindow.status, 403);
  assert.match(await apiWindow.text(), /不能请求 ChatGPT/);
  assert.equal(calls.length, 2, "local route credentials never leave ASS for subscription APIs");
  const blocked = await fetch(base + "/health", {
    headers: { origin: "https://external.example" },
  });
  assert.equal(blocked.status, 403);
});
