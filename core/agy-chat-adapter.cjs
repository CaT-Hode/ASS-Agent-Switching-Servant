const crypto = require("node:crypto");
const { convertRequest, sseMessages } = require("./adapters.cjs");
const { withOutputLimit } = require("./output-tokens.cjs");

function openaiError(status, message, code = "api_error") {
  const type = status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error";
  return {
    error: {
      message: String(message || "请求失败"),
      type,
      code,
    },
  };
}

function contentPartsToResponses(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: textType, text: part.text });
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string" && url) {
        out.push({
          type: "input_image",
          image_url: url,
          ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}),
        });
      }
    }
  }
  if (out.every((item) => item.type === textType)) {
    return out.map((item) => item.text).join("\n");
  }
  return out;
}

function chatToResponses(body, model, effortOverride = null) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    throw Object.assign(Error("OpenAI Chat 请求缺少有效的 messages 数组"), { status: 400 });
  }
  const instructions = [];
  const input = [];

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "user");
    if (role === "system" || role === "developer") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p) => p?.type === "text").map((p) => p.text || "").join("\n")
            : "";
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      const output =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p) => (typeof p === "string" ? p : p?.text ?? JSON.stringify(p))).join("\n")
            : JSON.stringify(msg.content ?? "");
      input.push({
        type: "function_call_output",
        call_id: String(msg.tool_call_id || "call_unknown"),
        output,
      });
      continue;
    }
    if (role === "assistant") {
      const parts = contentPartsToResponses(msg.content, "assistant");
      if ((typeof parts === "string" && parts.length > 0) || (Array.isArray(parts) && parts.length > 0)) {
        input.push({ role: "assistant", content: parts });
      }
      for (const tc of msg.tool_calls || []) {
        if (!tc?.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: tc.id || "call_" + crypto.randomBytes(6).toString("hex"),
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        });
      }
      continue;
    }
    const parts = contentPartsToResponses(msg.content, "user");
    input.push({ role: "user", content: parts });
  }

  const tools = [];
  for (const tool of body.tools || []) {
    if (tool?.type === "function" && tool.function?.name) {
      tools.push({
        type: "function",
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters || { type: "object", properties: {} },
      });
    }
  }

  let toolChoice;
  if (typeof body.tool_choice === "string") {
    toolChoice = body.tool_choice;
  } else if (body.tool_choice?.type === "function" && body.tool_choice.function?.name) {
    toolChoice = { type: "function", name: body.tool_choice.function.name };
  }

  const responsesBody = {
    model: model.model,
    input,
    stream: true,
    store: false,
    ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(effortOverride || (typeof body.reasoning_effort === "string" && body.reasoning_effort)
      ? { reasoning: { effort: effortOverride || body.reasoning_effort } }
      : {}),
  };

  const maxOut = body.max_completion_tokens ?? body.max_tokens;
  if (Number.isFinite(maxOut) && maxOut > 0) {
    responsesBody.max_output_tokens = Math.floor(maxOut);
  }
  Object.assign(responsesBody, withOutputLimit(responsesBody, model, "openai-responses"));

  if (body.response_format?.type === "json_object") {
    responsesBody.text = { format: { type: "json_object" } };
  } else if (body.response_format?.type === "json_schema" && body.response_format.json_schema?.schema) {
    responsesBody.text = {
      format: {
        type: "json_schema",
        name: body.response_format.json_schema.name || "output",
        schema: body.response_format.json_schema.schema,
        ...(body.response_format.json_schema.strict !== undefined
          ? { strict: body.response_format.json_schema.strict }
          : {}),
      },
    };
  }

  return responsesBody;
}

function chatUpstreamRequest(body, model, protocol, effortOverride = null) {
  if (protocol === "openai-chat") {
    const out = { ...body, model: model.model };
    if (effortOverride) out.reasoning_effort = effortOverride;
    const streaming = body.stream !== false;
    if (streaming) {
      out.stream = true;
      out.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    return out;
  }
  const responsesBody = chatToResponses(body, model, effortOverride);
  if (protocol === "openai-responses") return responsesBody;
  const converted = convertRequest(responsesBody, model, protocol);
  if (body.stop) {
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop];
    converted.stop_sequences = stops.filter((s) => typeof s === "string" && s);
  }
  return converted;
}

function buildOpenAiUsage({ input = 0, output = 0, reasoning = 0, cached = 0 } = {}) {
  const prompt_tokens = Math.max(0, Math.floor(Number(input) || 0));
  const completion_tokens = Math.max(0, Math.floor(Number(output) || 0));
  const cached_tokens = Math.min(prompt_tokens, Math.max(0, Math.floor(Number(cached) || 0)));
  const reasoning_tokens = Math.min(completion_tokens, Math.max(0, Math.floor(Number(reasoning) || 0)));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...(cached_tokens > 0 ? { prompt_tokens_details: { cached_tokens } } : {}),
    ...(reasoning_tokens > 0 ? { completion_tokens_details: { reasoning_tokens } } : {}),
  };
}

async function* chatCompletionEvents(stream, protocol, model, signal) {
  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let ended = false;
  let finishReason = "stop";
  let sawToolCall = false;
  let usage = null;

  const makeChunk = (delta, finish_reason = null) => {
    const d = !sentRole && delta && Object.keys(delta).length > 0 ? { role: "assistant", ...delta } : delta;
    if (!sentRole && delta && Object.keys(delta).length > 0) sentRole = true;
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: d, finish_reason }],
    };
  };

  if (protocol === "openai-responses") {
    let emittedText = false;
    let nextToolIndex = 0;
    const itemToIndex = new Map();
    const emittedCalls = new Set();

    for await (const event of sseMessages(stream, signal)) {
      if (event.error || ["error", "response.failed"].includes(event.type)) {
        throw Error(event.error?.message || event.response?.error?.message || "上游返回错误事件");
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
        emittedText = true;
        yield makeChunk({ content: event.delta });
      } else if (
        ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type) &&
        typeof event.delta === "string" &&
        event.delta
      ) {
        yield makeChunk({ reasoning_content: event.delta });
      } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const idx = nextToolIndex++;
        const callId = event.item.call_id || event.item.id || `call_${idx}`;
        itemToIndex.set(event.item.id, { idx, id: callId, name: event.item.name || "", streamedArgs: false });
        emittedCalls.add(callId);
        sawToolCall = true;
        yield makeChunk({
          tool_calls: [
            {
              index: idx,
              id: callId,
              type: "function",
              function: { name: event.item.name || "", arguments: event.item.arguments || "" },
            },
          ],
        });
      } else if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const entry = itemToIndex.get(event.item_id);
        if (entry && event.delta) {
          entry.streamedArgs = true;
          yield makeChunk({
            tool_calls: [{ index: entry.idx, function: { arguments: event.delta } }],
          });
        }
      } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const entry = itemToIndex.get(event.item.id);
        if (!entry) {
          const idx = nextToolIndex++;
          const callId = event.item.call_id || event.item.id || `call_${idx}`;
          emittedCalls.add(callId);
          sawToolCall = true;
          yield makeChunk({
            tool_calls: [
              {
                index: idx,
                id: callId,
                type: "function",
                function: { name: event.item.name || "", arguments: event.item.arguments || "{}" },
              },
            ],
          });
        } else if (!entry.streamedArgs && event.item.arguments) {
          yield makeChunk({
            tool_calls: [{ index: entry.idx, function: { arguments: event.item.arguments } }],
          });
        }
      } else if (["response.completed", "response.incomplete"].includes(event.type)) {
        ended = true;
        if (event.type === "response.incomplete") finishReason = "length";
        for (const item of event.response?.output || []) {
          if (item.type === "message" && !emittedText) {
            const text = (item.content || [])
              .filter((c) => c.type === "output_text" && c.text)
              .map((c) => c.text)
              .join("");
            if (text) {
              emittedText = true;
              yield makeChunk({ content: text });
            }
          } else if (item.type === "function_call") {
            const callId = item.call_id || item.id;
            if (item.name && !emittedCalls.has(callId)) {
              const idx = nextToolIndex++;
              emittedCalls.add(callId);
              sawToolCall = true;
              yield makeChunk({
                tool_calls: [
                  {
                    index: idx,
                    id: callId,
                    type: "function",
                    function: { name: item.name, arguments: item.arguments || "{}" },
                  },
                ],
              });
            }
          }
        }
        const u = event.response?.usage;
        if (u) {
          usage = buildOpenAiUsage({
            input: u.input_tokens,
            output: u.output_tokens,
            reasoning: u.output_tokens_details?.reasoning_tokens,
            cached: u.input_tokens_details?.cached_tokens,
          });
        }
        break;
      }
    }
  } else if (protocol === "anthropic") {
    let nextToolIndex = 0;
    const blockToToolIdx = new Map();
    const accUsage = { input: 0, output: 0, cached: 0 };

    for await (const event of sseMessages(stream, signal)) {
      if (event.error || event.type === "error") {
        throw Error(event.error?.message || "上游返回错误事件");
      }
      if (event.type === "message_start" && event.message?.usage) {
        const u = event.message.usage;
        accUsage.cached = u.cache_read_input_tokens || 0;
        accUsage.input = (u.input_tokens || 0) + accUsage.cached + (u.cache_creation_input_tokens || 0);
        accUsage.output = u.output_tokens || 0;
      } else if (event.type === "content_block_start") {
        const cb = event.content_block;
        if (cb?.type === "tool_use") {
          const idx = nextToolIndex++;
          blockToToolIdx.set(event.index, idx);
          sawToolCall = true;
          const initialArgs = cb.input && Object.keys(cb.input).length ? JSON.stringify(cb.input) : "";
          yield makeChunk({
            tool_calls: [
              {
                index: idx,
                id: cb.id || `call_${idx}`,
                type: "function",
                function: { name: cb.name || "", arguments: initialArgs },
              },
            ],
          });
        } else if (cb?.type === "thinking" && cb.thinking) {
          yield makeChunk({ reasoning_content: cb.thinking });
        } else if (cb?.type === "text" && cb.text) {
          yield makeChunk({ content: cb.text });
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d?.type === "text_delta" && d.text) {
          yield makeChunk({ content: d.text });
        } else if (d?.type === "thinking_delta" && d.thinking) {
          yield makeChunk({ reasoning_content: d.thinking });
        } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
          const idx = blockToToolIdx.get(event.index);
          if (idx !== undefined && d.partial_json) {
            yield makeChunk({
              tool_calls: [{ index: idx, function: { arguments: d.partial_json } }],
            });
          }
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason === "max_tokens") finishReason = "length";
        else if (event.delta?.stop_reason === "tool_use") finishReason = "tool_calls";
        if (event.usage) {
          if (Number.isFinite(event.usage.output_tokens)) accUsage.output = event.usage.output_tokens;
          if (Number.isFinite(event.usage.input_tokens)) accUsage.input = event.usage.input_tokens + accUsage.cached;
        }
      } else if (event.type === "message_stop") {
        ended = true;
        usage = buildOpenAiUsage(accUsage);
        break;
      }
    }
  } else {
    throw Object.assign(Error("内部协议分派错误：" + protocol), { status: 500 });
  }

  if (!ended) throw Error("上游流提前断开，未收到结束事件");

  const finalReason = sawToolCall && finishReason === "stop" ? "tool_calls" : finishReason;
  yield makeChunk({}, finalReason);
  if (usage) {
    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage,
    };
  }
}

async function chatCompletionJSON(events) {
  let id = "";
  let created = Math.floor(Date.now() / 1000);
  let model = "";
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage;
  const toolCalls = new Map();

  for await (const chunk of events) {
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      const entry = toolCalls.get(idx) || {
        id: tc.id || `call_${idx}`,
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.function.name += tc.function.name;
      if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
      toolCalls.set(idx, entry);
    }
  }

  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const message = {
    role: "assistant",
    content: content || (calls.length ? null : ""),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };

  return {
    id: id || "chatcmpl-" + crypto.randomBytes(12).toString("hex"),
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

module.exports = {
  openaiError,
  chatToResponses,
  chatUpstreamRequest,
  chatCompletionEvents,
  chatCompletionJSON,
  buildOpenAiUsage,
};
