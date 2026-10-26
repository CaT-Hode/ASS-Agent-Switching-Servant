const crypto = require("node:crypto");
const { endpoint, EFFORTS } = require("./models.cjs");
const { convertRequest, sseMessages, anthropicLimited } = require("./adapters.cjs");
const { protocolEndpoint, providerSessionHeaders } = require("./provider-transport.cjs");
const { abortable } = require("./abortable.cjs");
// Full capability scans allow slow generations; connection checks have one
// short budget covering protocol selection and the final request together.
const PROBE_TIMEOUT_MS = 90000;
const DIAGNOSTIC_TIMEOUT_MS = 30000;
const modelKey = (provider, model) => JSON.stringify([provider, model]);
const strings = (value) =>
  Array.isArray(value)
    ? value.filter((x) => typeof x === "string" && x.length < 100).slice(0, 30)
    : [];
const positive = (...values) =>
  values.find((v) => Number.isSafeInteger(v) && v > 0) ?? null;
function declaredCapabilities(raw) {
  const parameters = strings(raw.supported_parameters);
  const levels = raw.supported_reasoning_levels || raw.reasoning_efforts;
  const efforts = (Array.isArray(levels) ? levels : [])
    .map((v) => (typeof v === "string" ? v : v?.effort))
    .filter((v) => EFFORTS.includes(v));
  const input = strings(
    raw.input_modalities || raw.architecture?.input_modalities,
  );
  return {
    contextWindow: positive(
      raw.context_length,
      raw.context_window,
      raw.contextWindow,
      raw.limits?.context,
    ),
    maxOutputTokens: positive(
      raw.max_output_tokens,
      raw.max_output_length,
      raw.top_provider?.max_completion_tokens,
      raw.limits?.output,
    ),
    efforts,
    inputModalities: input,
    outputModalities: strings(
      raw.output_modalities || raw.architecture?.output_modalities,
    ),
    tools:
      typeof raw.supports_tools === "boolean"
        ? raw.supports_tools
        : parameters.includes("tools")
          ? true
          : null,
    reasoning:
      typeof raw.supports_reasoning === "boolean"
        ? raw.supports_reasoning
        : efforts.length || parameters.some((v) => /reasoning/.test(v))
          ? true
          : null,
    vision: input.length ? input.includes("image") : null,
    supportedParameters: parameters,
  };
}
function headersFor(provider, protocol) {
  return {
    ...provider.extraHeaders,
    ...(protocol === "anthropic"
      ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: "Bearer " + provider.apiKey }),
  };
}
async function limitedText(response, limit = 2 * 1024 * 1024, signal) {
  const reader = response.body.getReader(),
    chunks = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.length;
      if (size > limit) throw Error("接口响应超过检测大小限制");
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
async function discoverModels(provider, fetchUpstream, signal) {
  if (!provider.apiKey) throw Error("请先填写供应商 API Key");
  const url = endpoint(provider.baseUrl, "openai-responses").replace(
    /\/responses$/,
    "/models",
  );
  const response = await fetchUpstream(
    url,
    {
      method: "GET",
      headers: headersFor(provider, provider.wireApi),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(20000),
      ]),
    },
    provider.network,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      "模型目录接口返回 HTTP " +
        response.status +
        (response.status === 401
          ? "；API Key 无效或未被接受"
          : response.status === 403
            ? "；此 Key 没有目录访问权限"
            : response.status === 429
              ? "；请求限流，请稍后重试"
              : response.status >= 500
                ? "；上游服务暂时异常"
                : "；请检查目录地址，供应商可能未开放 /models"),
    );
  }
  let body;
  try {
    body = JSON.parse(await limitedText(response));
  } catch {
    throw Error("模型目录未返回有效且大小受限的 JSON");
  }
  const list = Array.isArray(body) ? body : body.data || body.models;
  if (!Array.isArray(list)) throw Error("模型目录格式无法识别");
  const seen = new Set();
  const models = list.slice(0, 2000).flatMap((raw) => {
    if (typeof raw === "string") raw = { id: raw };
    const id = raw?.id || raw?.model;
    if (typeof id !== "string" || !id || id.length > 250 || seen.has(id))
      return [];
    seen.add(id);
    return [
      {
        model: id,
        displayName: typeof raw.name === "string" ? raw.name.slice(0, 120) : id,
        declared: declaredCapabilities(raw),
      },
    ];
  });
  return {
    time: new Date().toISOString(),
    source: "供应商 /models 声明（未实测）",
    models,
    truncated: list.length > 2000 || !!body.has_more,
  };
}
async function inspectStream(stream, protocol, nonce, observe = () => {}, signal) {
  let terminal = false,
    incomplete = false,
    text = false,
    reasoningObserved = false,
    tokens = 0,
    bytes = 0;
  const calls = new Map();
  const addResponse = (r) => {
    tokens = Math.max(
      tokens,
      r?.usage?.output_tokens_details?.reasoning_tokens || 0,
    );
    for (const item of r?.output || []) {
      if (
        item.type === "message" &&
        item.content?.some((v) => v.type === "output_text" && v.text)
      )
        text = true;
      if (item.type === "reasoning") reasoningObserved = true;
      if (item.type === "function_call")
        calls.set(item.id || item.call_id, {
          name: item.name,
          args: item.arguments,
        });
    }
  };
  for await (const event of sseMessages(stream, signal)) {
    observe(event);
    bytes += JSON.stringify(event).length;
    if (bytes > 2 * 1024 * 1024) throw Error("检测响应过大");
    if (event.error || ["error", "response.failed"].includes(event.type))
      throw Error("上游错误事件");
    if (protocol === "openai-responses") {
      if (event.type === "response.output_text.delta" && event.delta)
        text = true;
      if (/reasoning.*delta/.test(event.type)) reasoningObserved = true;
      if (["response.completed", "response.incomplete"].includes(event.type)) {
        terminal = true;
        incomplete = event.type === "response.incomplete";
        addResponse(event.response);
      }
      if (event.type === "response.output_item.done")
        addResponse({ output: [event.item] });
    } else if (protocol === "anthropic") {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use")
          calls.set(event.index, {
            name: block.name,
            args: Object.keys(block.input || {}).length
              ? JSON.stringify(block.input)
              : "",
          });
        if (block?.type === "text" && block.text) text = true;
      }
      if (event.delta?.type === "input_json_delta" && calls.has(event.index))
        calls.get(event.index).args += event.delta.partial_json || "";
      if (event.delta?.type === "text_delta" && event.delta.text) text = true;
      if (event.delta?.type === "thinking_delta") reasoningObserved = true;
      if (event.type === "message_delta")
        incomplete ||= anthropicLimited(event.delta?.stop_reason);
      if (event.type === "message_stop") terminal = true;
    } else {
      const c = event.choices?.[0],
        d = c?.delta;
      if (d?.content) text = true;
      if (d?.reasoning_content || d?.reasoning) reasoningObserved = true;
      tokens = Math.max(
        tokens,
        event.usage?.completion_tokens_details?.reasoning_tokens || 0,
      );
      for (const tool of d?.tool_calls || []) {
        const item = calls.get(tool.index) || { name: "", args: "" };
        if (tool.function?.name) item.name = tool.function.name;
        item.args += tool.function?.arguments || "";
        calls.set(tool.index, item);
      }
      if (c?.finish_reason) {
        terminal = true;
        incomplete = c.finish_reason === "length";
      }
    }
    // Protocol completion is sufficient. A keep-alive socket is not an
    // unfinished generation, and must not hold the injection dialog open.
    if (terminal) break;
  }
  const toolObserved = [...calls.values()].some((c) => {
    try {
      return c.name === "ass_probe_echo" && JSON.parse(c.args).marker === nonce;
    } catch {
      return false;
    }
  });
  return {
    completed: terminal && !incomplete,
    text,
    toolObserved,
    reasoningObserved: reasoningObserved || tokens > 0,
    reasoningTokens: tokens,
    incomplete,
  };
}
async function nativeProbe(
  provider,
  model,
  protocol,
  fetchUpstream,
  { effort, tool = false, connection = false, signal, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  const nonce = crypto.randomBytes(8).toString("hex"),
    started = Date.now();
  const body = {
    model: model.model,
    stream: true,
    store: false,
    max_output_tokens: 512,
    instructions: connection ? "Reply concisely."
      : "This is a capability check. Reply briefly. Do not perform any external actions. Request marker: " + nonce,
    input: connection ? [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }] : tool
      ? `Call ass_probe_echo once with marker ${nonce}.`
      : "What is 19 times 23? Reply only with the result.",
    ...(effort ? { reasoning: { effort } } : {}),
    ...(tool
      ? {
          tools: [
            {
              type: "function",
              name: "ass_probe_echo",
              description:
                "Return the supplied marker. This tool is never executed.",
              parameters: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
                additionalProperties: false,
              },
            },
          ],
          tool_choice: { type: "function", name: "ass_probe_echo" },
        }
      : {}),
  };
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => controller.abort(new DOMException("Probe timeout", "TimeoutError")), timeoutMs);
  try {
    return await abortable((async () => {
    requestSignal.throwIfAborted();
    const request =
      protocol === "openai-responses"
        ? body
        : convertRequest(body, model, protocol);
    const response = await fetchUpstream(
      protocolEndpoint(provider, protocol),
      {
        method: "POST",
        headers: {
          ...headersFor(provider, protocol),
          ...providerSessionHeaders(provider, { session_id: "ass-protocol-" + nonce }),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(request),
        redirect: "error",
        credentials: "omit",
        signal: requestSignal,
      },
      provider.network,
    );
    if (requestSignal.aborted) { void response.body?.cancel().catch(() => {}); requestSignal.throwIfAborted(); }
    if (!response.ok) {
      const raw = await limitedText(response, 128 * 1024, requestSignal).catch(() => "");
      requestSignal.throwIfAborted();
      return {
        status: "rejected",
        unsupported: [405, 415].includes(response.status) ||
          ([400, 404, 422].includes(response.status) && /(?:unsupported|not supported|不支持).{0,60}(?:protocol|endpoint|api format|responses api|messages api)|(?:protocol|endpoint|responses api|messages api).{0,60}(?:unsupported|not supported|不支持)/i.test(raw)),
        httpStatus: response.status,
        effortError:
          [400, 422].includes(response.status) &&
          /reasoning|effort|output_config/i.test(raw),
        message: "HTTP " + response.status,
        ms: Date.now() - started,
      };
    }
    const observed = await inspectStream(response.body, protocol, nonce, undefined, requestSignal);
    return {
      ...observed,
      status:
        observed.completed && (observed.text || observed.toolObserved)
          ? "passed"
          : "unknown",
      httpStatus: response.status,
      ms: Date.now() - started,
    };
    })(), requestSignal);
  } catch {
    return {
      status: "unknown",
      message: signal?.aborted
        ? "检测已取消"
        : "超时、网络失败或不完整流；不能据此判定能力",
      ms: Date.now() - started,
    };
  } finally { clearTimeout(timer); controller.abort(); }
}
async function probeCapabilities(
  provider,
  model,
  fetchUpstream,
  { signal, progress = () => {} } = {},
) {
  const report = {
    time: new Date().toISOString(),
    providerId: provider.id,
    model: model.model,
    protocols: {},
    efforts: {},
    tools: { status: "unknown" },
    requestCount: 0,
  };
  const run = async (protocol, options, message) => {
    signal?.throwIfAborted();
    progress(message);
    report.requestCount++;
    return nativeProbe(provider, model, protocol, fetchUpstream, {
      ...options,
      signal,
    });
  };
  try {
    let working;
    for (const protocol of [
      "openai-responses", "anthropic", "openai-chat",
    ]) {
      const result = await run(protocol, {}, "验证 " + protocol);
      report.protocols[protocol] = result;
      if (result.status === "passed") {
        working ||= protocol;
      }
      if (result.httpStatus === 429) return report;
    }
    if (!working) return report;
    const tool = await run(working, { tool: true }, "验证工具调用");
    report.tools = {
      ...tool,
      status: tool.toolObserved && tool.completed ? "observed" : "unknown",
    };
    if (
      !tool.httpStatus ||
      tool.httpStatus >= 500 ||
      [401, 403, 429].includes(tool.httpStatus)
    )
      return report;
    const control = await run(
      working,
      { effort: "ass_invalid_effort" },
      "验证思维参数的非法值对照",
    );
    report.invalidEffortControl = {
      status: control.status,
      httpStatus: control.httpStatus,
      rejectedByValidator: control.effortError === true,
    };
    if (
      !control.httpStatus ||
      control.httpStatus >= 500 ||
      [401, 403, 429].includes(control.httpStatus)
    )
      return report;
    for (const effort of model.efforts) {
      const result = await run(working, { effort }, "验证思维强度 " + effort);
      report.efforts[effort] = {
        ...result,
        status:
          result.status === "passed"
            ? control.effortError
              ? "validated"
              : "accepted-unverified"
            : result.effortError
              ? "rejected"
              : "unknown",
      };
      if (
        !result.httpStatus ||
        result.httpStatus >= 500 ||
        [401, 403, 429].includes(result.httpStatus)
      )
        break;
    }
    return report;
  } catch {
    report.cancelled = true;
    return report;
  }
}
module.exports = {
  PROBE_TIMEOUT_MS,
  DIAGNOSTIC_TIMEOUT_MS,
  modelKey,
  declaredCapabilities,
  discoverModels,
  inspectStream,
  nativeProbe,
  probeCapabilities,
};
