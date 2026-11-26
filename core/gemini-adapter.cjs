const crypto = require("node:crypto");
const { convertRequest, sseMessages } = require("./adapters.cjs");
const { withOutputLimit } = require("./output-tokens.cjs");

const GRPC_STATUS = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "UNIMPLEMENTED",
  409: "ABORTED",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

function geminiError(status, message) {
  const code = Number.isInteger(status) ? status : 500;
  return {
    error: {
      code,
      message: String(message || "请求失败"),
      status: GRPC_STATUS[code] || (code >= 500 ? "INTERNAL" : "INVALID_ARGUMENT"),
    },
  };
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "nullable" || value === undefined) continue;
    if (key === "type" && typeof value === "string") {
      out.type = value.toLowerCase();
    } else if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeSchema(v)]),
      );
    } else if (["items", "additionalProperties"].includes(key) && value && typeof value === "object") {
      out[key] = normalizeSchema(value);
    } else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)) {
      out[key] = value.map(normalizeSchema);
    } else {
      out[key] = value;
    }
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function thinkingEffort(thinkingConfig, model) {
  if (!thinkingConfig || typeof thinkingConfig !== "object") return null;
  const level = String(thinkingConfig.thinkingLevel || thinkingConfig.thinking_level || "").toLowerCase();
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) return level;
  const budget = thinkingConfig.thinkingBudget ?? thinkingConfig.thinking_budget;
  if (budget === 0) return null;
  if (typeof budget === "number" && Number.isFinite(budget)) {
    if (budget < 0) return model?.defaultEffort || "high";
    if (budget <= 2048) return "low";
    if (budget <= 8192) return "medium";
    return "high";
  }
  return thinkingConfig.includeThoughts || thinkingConfig.include_thoughts
    ? model?.defaultEffort || "medium"
    : null;
}

function extractTextParts(container) {
  const parts = Array.isArray(container?.parts) ? container.parts : [];
  return parts
    .filter((p) => p && !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function geminiToResponses(body, model, effortOverride = null) {
  if (!body || typeof body !== "object") {
    throw Object.assign(Error("Gemini 请求体无效"), { status: 400 });
  }
  const instructions = extractTextParts(body.systemInstruction || body.system_instruction);
  const input = [];
  const pendingCallsByName = new Map();
  let callCounter = 0;
  const nextCallId = () => "call_agy_" + (++callCounter) + "_" + crypto.randomBytes(4).toString("hex");

  for (const turn of body.contents || []) {
    if (!turn || typeof turn !== "object") continue;
    const role = turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    let buffer = [];
    const flushBuffer = () => {
      if (!buffer.length) return;
      if (buffer.every((item) => item.type === "input_text" || item.type === "output_text")) {
        input.push({ role, content: buffer.map((item) => item.text).join("\n") });
      } else {
        input.push({ role, content: buffer });
      }
      buffer = [];
    };

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.thought === true) continue;

      if (typeof part.text === "string" && part.text.length > 0) {
        buffer.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
        continue;
      }

      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && typeof inlineData.data === "string") {
        const mime = String(inlineData.mimeType || inlineData.mime_type || "image/png");
        if (mime.startsWith("image/")) {
          buffer.push({ type: "input_image", image_url: `data:${mime};base64,${inlineData.data}` });
        } else {
          buffer.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: `[Attached ${mime} payload omitted by cross-protocol adapter]`,
          });
        }
        continue;
      }

      const fnCall = part.functionCall || part.function_call;
      if (fnCall && typeof fnCall.name === "string") {
        flushBuffer();
        const callId = typeof fnCall.id === "string" && fnCall.id ? fnCall.id : nextCallId();
        const queue = pendingCallsByName.get(fnCall.name) || [];
        queue.push(callId);
        pendingCallsByName.set(fnCall.name, queue);
        input.push({
          type: "function_call",
          call_id: callId,
          name: fnCall.name,
          arguments: JSON.stringify(fnCall.args && typeof fnCall.args === "object" ? fnCall.args : {}),
        });
        continue;
      }

      const fnResp = part.functionResponse || part.function_response;
      if (fnResp && typeof fnResp.name === "string") {
        flushBuffer();
        let callId = typeof fnResp.id === "string" && fnResp.id ? fnResp.id : "";
        const queue = pendingCallsByName.get(fnResp.name);
        if (!callId && queue?.length) callId = queue.shift();
        else if (callId && queue?.length) {
          const idx = queue.indexOf(callId);
          if (idx >= 0) queue.splice(idx, 1);
        }
        if (!callId) callId = nextCallId();
        const output =
          typeof fnResp.response === "string"
            ? fnResp.response
            : JSON.stringify(fnResp.response ?? {});
        input.push({
          type: "function_call_output",
          call_id: callId,
          output,
        });
      }
    }
    flushBuffer();
  }

  const tools = [];
  for (const entry of body.tools || []) {
    const decls = entry?.functionDeclarations || entry?.function_declarations || [];
    for (const decl of decls) {
      if (!decl?.name) continue;
      tools.push({
        type: "function",
        name: decl.name,
        description: decl.description || "",
        parameters: normalizeSchema(
          decl.parameters || decl.parametersJsonSchema || decl.parameters_json_schema || { type: "object", properties: {} },
        ),
      });
    }
  }

  const gen = body.generationConfig || body.generation_config || {};
  const toolCfg = body.toolConfig?.functionCallingConfig || body.tool_config?.function_calling_config;
  let toolChoice;
  if (toolCfg?.mode) {
    const mode = String(toolCfg.mode).toUpperCase();
    const allowed = toolCfg.allowedFunctionNames || toolCfg.allowed_function_names;
    if (mode === "NONE") toolChoice = "none";
    else if (mode === "ANY") {
      toolChoice = Array.isArray(allowed) && allowed.length === 1
        ? { type: "function", name: allowed[0] }
        : "required";
    } else if (mode === "AUTO") toolChoice = "auto";
  }

  const effort = effortOverride || thinkingEffort(gen.thinkingConfig || gen.thinking_config, model);
  const responsesBody = {
    model: model.model,
    input,
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(typeof gen.temperature === "number" ? { temperature: gen.temperature } : {}),
    ...(typeof gen.topP === "number" ? { top_p: gen.topP } : typeof gen.top_p === "number" ? { top_p: gen.top_p } : {}),
  };

  const requestedMax = gen.maxOutputTokens ?? gen.max_output_tokens;
  if (Number.isFinite(requestedMax) && requestedMax > 0) {
    responsesBody.max_output_tokens = Math.floor(requestedMax);
  }
  Object.assign(responsesBody, withOutputLimit(responsesBody, model, "openai-responses"));

  const mimeType = gen.responseMimeType || gen.response_mime_type;
  const responseSchema = gen.responseSchema || gen.response_schema || gen.responseJsonSchema || gen.response_json_schema;
  if (mimeType === "application/json") {
    responsesBody.text = {
      format: responseSchema
        ? { type: "json_schema", name: "gemini_output", schema: normalizeSchema(responseSchema) }
        : { type: "json_object" },
    };
  }

  return responsesBody;
}

function geminiRequest(body, model, protocol, effortOverride = null) {
  const responsesBody = geminiToResponses(body, model, effortOverride);
  if (protocol === "openai-responses") return responsesBody;
  const converted = convertRequest(responsesBody, model, protocol);
  const stops = body?.generationConfig?.stopSequences || body?.generation_config?.stop_sequences;
  if (Array.isArray(stops) && stops.length) {
    if (protocol === "anthropic") converted.stop_sequences = stops.filter((s) => typeof s === "string" && s);
    else converted.stop = stops.filter((s) => typeof s === "string" && s);
  }
  return converted;
}

function safeParseArgs(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function buildUsageMetadata({ input = 0, output = 0, reasoning = 0, cached = 0 } = {}) {
  const promptTokenCount = Math.max(0, Math.floor(Number(input) || 0));
  const totalOut = Math.max(0, Math.floor(Number(output) || 0));
  const thoughtsTokenCount = Math.min(totalOut, Math.max(0, Math.floor(Number(reasoning) || 0)));
  const candidatesTokenCount = Math.max(0, totalOut - thoughtsTokenCount);
  const cachedContentTokenCount = Math.min(promptTokenCount, Math.max(0, Math.floor(Number(cached) || 0)));
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + totalOut,
    ...(thoughtsTokenCount > 0 ? { thoughtsTokenCount } : {}),
    ...(cachedContentTokenCount > 0 ? { cachedContentTokenCount } : {}),
  };
}

function chunkOf(parts, extra = {}) {
  return {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        ...extra,
      },
    ],
  };
}

async function* geminiEvents(stream, protocol, model, signal) {
  let ended = false;
  let finishReason = "STOP";
  let usage = null;
  let emittedText = false;
  const emittedCalls = new Set();

  if (protocol === "openai-responses") {
    const calls = new Map();
    for await (const event of sseMessages(stream, signal)) {
      if (event.error || ["error", "response.failed"].includes(event.type)) {
        throw Error(event.error?.message || event.response?.error?.message || "上游返回错误事件");
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
        emittedText = true;
        yield chunkOf([{ text: event.delta }]);
      } else if (
        ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type) &&
        typeof event.delta === "string" &&
        event.delta
      ) {
        yield chunkOf([{ text: event.delta, thought: true }]);
      } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        calls.set(event.item.id, {
          id: event.item.call_id || event.item.id,
          name: event.item.name || "",
          arguments: event.item.arguments || "",
        });
      } else if (event.type === "response.function_call_arguments.delta") {
        const entry = calls.get(event.item_id);
        if (entry && typeof event.delta === "string") entry.arguments += event.delta;
      } else if (event.type === "response.function_call_arguments.done") {
        const entry = calls.get(event.item_id);
        if (entry && typeof event.arguments === "string") entry.arguments = event.arguments;
      } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const entry = calls.get(event.item.id) || {
          id: event.item.call_id || event.item.id,
          name: event.item.name || "",
          arguments: event.item.arguments || "{}",
        };
        if (event.item.arguments) entry.arguments = event.item.arguments;
        if (entry.name && !emittedCalls.has(entry.id)) {
          emittedCalls.add(entry.id);
          yield chunkOf([{ functionCall: { id: entry.id, name: entry.name, args: safeParseArgs(entry.arguments) } }]);
        }
      } else if (["response.completed", "response.incomplete"].includes(event.type)) {
        ended = true;
        if (event.type === "response.incomplete") finishReason = "MAX_TOKENS";
        for (const item of event.response?.output || []) {
          if (item.type === "message" && !emittedText) {
            const text = (item.content || [])
              .filter((c) => c.type === "output_text" && c.text)
              .map((c) => c.text)
              .join("");
            if (text) {
              emittedText = true;
              yield chunkOf([{ text }]);
            }
          } else if (item.type === "function_call") {
            const id = item.call_id || item.id;
            if (item.name && !emittedCalls.has(id)) {
              emittedCalls.add(id);
              yield chunkOf([{ functionCall: { id, name: item.name, args: safeParseArgs(item.arguments) } }]);
            }
          }
        }
        const u = event.response?.usage;
        if (u) {
          usage = buildUsageMetadata({
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
    const blocks = new Map();
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
          blocks.set(event.index, {
            type: "tool",
            id: cb.id || "call_" + event.index,
            name: cb.name || "",
            raw: cb.input && Object.keys(cb.input).length ? JSON.stringify(cb.input) : "",
          });
        } else if (cb?.type === "thinking") {
          blocks.set(event.index, { type: "thinking" });
          if (cb.thinking) yield chunkOf([{ text: cb.thinking, thought: true }]);
        } else if (cb?.type === "text") {
          blocks.set(event.index, { type: "text" });
          if (cb.text) {
            emittedText = true;
            yield chunkOf([{ text: cb.text }]);
          }
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d?.type === "text_delta" && d.text) {
          emittedText = true;
          yield chunkOf([{ text: d.text }]);
        } else if (d?.type === "thinking_delta" && d.thinking) {
          yield chunkOf([{ text: d.thinking, thought: true }]);
        } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
          const block = blocks.get(event.index);
          if (block?.type === "tool") block.raw += d.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const block = blocks.get(event.index);
        if (block?.type === "tool" && block.name && !emittedCalls.has(block.id)) {
          emittedCalls.add(block.id);
          yield chunkOf([{ functionCall: { id: block.id, name: block.name, args: safeParseArgs(block.raw) } }]);
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason === "max_tokens") finishReason = "MAX_TOKENS";
        if (event.usage) {
          if (Number.isFinite(event.usage.output_tokens)) accUsage.output = event.usage.output_tokens;
          if (Number.isFinite(event.usage.input_tokens)) {
            accUsage.input = event.usage.input_tokens + accUsage.cached;
          }
        }
      } else if (event.type === "message_stop") {
        ended = true;
        usage = buildUsageMetadata(accUsage);
        break;
      }
    }
  } else {
    // openai-chat
    const calls = new Map();
    for await (const event of sseMessages(stream, signal)) {
      if (event.error) throw Error(event.error?.message || "上游返回错误事件");
      if (event.done) {
        ended = true;
        break;
      }
      if (event.usage) {
        usage = buildUsageMetadata({
          input: event.usage.prompt_tokens,
          output: event.usage.completion_tokens,
          reasoning: event.usage.completion_tokens_details?.reasoning_tokens,
          cached: event.usage.prompt_tokens_details?.cached_tokens ?? event.usage.prompt_cache_hit_tokens,
        });
      }
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (delta?.refusal || choice?.finish_reason === "content_filter") {
        throw Error("上游拒绝或过滤了请求");
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        yield chunkOf([{ text: reasoning, thought: true }]);
      }
      if (typeof delta?.content === "string" && delta.content) {
        emittedText = true;
        yield chunkOf([{ text: delta.content }]);
      }
      for (const tc of delta?.tool_calls || []) {
        const idx = tc.index ?? 0;
        const entry = calls.get(idx) || { id: tc.id || `call_${idx}`, name: "", arguments: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        calls.set(idx, entry);
      }
      if (choice?.finish_reason) {
        ended = true;
        if (choice.finish_reason === "length") finishReason = "MAX_TOKENS";
      }
    }
    for (const entry of calls.values()) {
      if (entry.name && !emittedCalls.has(entry.id)) {
        emittedCalls.add(entry.id);
        yield chunkOf([{ functionCall: { id: entry.id, name: entry.name, args: safeParseArgs(entry.arguments) } }]);
      }
    }
  }

  if (!ended) throw Error("上游流提前断开，未收到结束事件");

  yield {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [] },
        finishReason,
      },
    ],
    ...(usage ? { usageMetadata: usage } : {}),
    modelVersion: model,
  };
}

async function geminiJSON(events) {
  const parts = [];
  let finishReason = "STOP";
  let usageMetadata;
  let modelVersion;
  let lastTextPart = null;
  let lastThoughtPart = null;

  for await (const chunk of events) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    for (const part of candidate?.content?.parts || []) {
      if (part.thought && typeof part.text === "string") {
        if (lastThoughtPart) lastThoughtPart.text += part.text;
        else {
          lastThoughtPart = { text: part.text, thought: true };
          parts.push(lastThoughtPart);
        }
        lastTextPart = null;
      } else if (typeof part.text === "string") {
        if (lastTextPart) lastTextPart.text += part.text;
        else {
          lastTextPart = { text: part.text };
          parts.push(lastTextPart);
        }
        lastThoughtPart = null;
      } else if (part.functionCall) {
        parts.push(part);
        lastTextPart = null;
        lastThoughtPart = null;
      }
    }
  }

  return {
    candidates: [{ index: 0, content: { role: "model", parts }, finishReason }],
    ...(usageMetadata ? { usageMetadata } : {}),
    ...(modelVersion ? { modelVersion } : {}),
  };
}

module.exports = {
  geminiError,
  normalizeSchema,
  geminiToResponses,
  geminiRequest,
  geminiEvents,
  geminiJSON,
  buildUsageMetadata,
};
