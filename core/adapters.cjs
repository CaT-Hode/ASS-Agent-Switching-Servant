const crypto = require("node:crypto");
const { DEFAULT_OUTPUT_TOKENS } = require('./output-tokens.cjs');
function textOf(content) {
  return typeof content === "string"
    ? content
    : (content || [])
        .filter((c) => ["input_text", "output_text", "text"].includes(c.type))
        .map((c) => c.text || "")
        .join("\n");
}
function contentParts(content, kind) {
  if (typeof content === "string") return kind === "anthropic" ? [{ type: "text", text: content || " " }] : content;
  const parts = (content || []).map(c => {
    if (["input_text", "output_text", "text"].includes(c.type)) return { type: "text", text: c.text || " " };
    if (c.type === "input_image" && typeof c.image_url === "string") {
      if (kind !== "anthropic") return { type: "image_url", image_url: { url: c.image_url, ...(c.detail ? { detail: c.detail } : {}) } };
      const data = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(c.image_url);
      if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
      if (/^https?:\/\//.test(c.image_url)) return { type: "image", source: { type: "url", url: c.image_url } };
    }
    throw Object.assign(Error("该协议无法转换输入类型 " + c.type + "；请使用支持此能力的原生接口"), { status: 400 });
  });
  return kind !== "anthropic" && parts.every(c => c.type === "text") ? parts.map(c => c.text).join("\n") : parts;
}
function inputMessages(body, kind) {
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : body.input || [];
  const messages = [];
  const system = [body.instructions || ""];
  for (const i of input) {
    if (i.type === "reasoning") continue;
    if (i.type === "function_call") {
      if (kind === "anthropic")
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: i.call_id,
              name: i.name,
              input: JSON.parse(i.arguments || "{}"),
            },
          ],
        });
      else
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: i.call_id,
              type: "function",
              function: { name: i.name, arguments: i.arguments || "{}" },
            },
          ],
        });
    } else if (i.type === "function_call_output") {
      if (kind === "anthropic")
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: i.call_id,
              content:
                typeof i.output === "string"
                  ? i.output
                  : JSON.stringify(i.output),
            },
          ],
        });
      else
        messages.push({
          role: "tool",
          tool_call_id: i.call_id,
          content:
            typeof i.output === "string" ? i.output : JSON.stringify(i.output),
        });
    } else if (i.role) {
      if (["system", "developer"].includes(i.role)) {
        system.push(textOf(i.content));
        continue;
      }
      messages.push({
        role: i.role === "assistant" ? "assistant" : "user",
        content: contentParts(i.content, kind),
      });
    } else throw new Error(`该协议暂不支持输入类型 ${i.type || "unknown"}`);
  }
  if (kind === "anthropic") {
    const merged = [];
    for (const m of messages) {
      if (merged.at(-1)?.role === m.role)
        merged.at(-1).content.push(...m.content);
      else merged.push(m);
    }
    return { messages: merged, system: system.filter(Boolean).join("\n\n") };
  }
  // Parallel calls belong to one assistant turn, before all corresponding tool
  // results. Splitting them into assistant turns makes valid history invalid.
  const merged = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      if (Array.isArray(previous.content) || Array.isArray(message.content))
        previous.content = [previous.content, message.content].flatMap(v => Array.isArray(v) ? v : v ? [{ type: "text", text: v }] : []);
      else previous.content = [previous.content, message.content].filter(Boolean).join("\n") || null;
      if (message.tool_calls) previous.tool_calls = [...(previous.tool_calls || []), ...message.tool_calls];
    } else merged.push(message);
  }
  return {
    messages: [
      ...(system.some(Boolean)
        ? [{ role: "system", content: system.filter(Boolean).join("\n\n") }]
        : []),
      ...merged,
    ],
  };
}
function convertRequest(body, model, protocol) {
  if (body.previous_response_id)
    throw new Error("跨协议请求需要完整历史，不支持 previous_response_id");
  const tools = (body.tools || []).map((t) => {
    if (t.type !== "function")
      throw new Error(
        `该协议不支持 ${t.type} 工具，请关闭原生工具或改用 Responses 模型`,
      );
    return protocol === "anthropic"
      ? {
          name: t.name,
          description: t.description || "",
          input_schema: t.parameters || { type: "object", properties: {} },
        }
      : {
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.parameters || { type: "object", properties: {} },
          },
        };
  });
  const request = {
    model: body.model,
    ...inputMessages(body, protocol),
    stream: true,
  };
  if (tools.length) request.tools = tools;
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) request[key] = body[key];
  if (protocol === "anthropic") {
    request.max_tokens =
      body.max_output_tokens || model.maxOutputTokens || DEFAULT_OUTPUT_TOKENS;
    // Effort is forwarded, never silently downshifted. Compatibility is determined by the upstream.
    if (body.reasoning?.effort)
      request.output_config = { effort: body.reasoning.effort };
    if (body.tool_choice === "none") delete request.tools;
    else if (body.tool_choice === "required")
      request.tool_choice = { type: "any" };
    else if (body.tool_choice?.name)
      request.tool_choice = { type: "tool", name: body.tool_choice.name };
    if (body.parallel_tool_calls === false && request.tools?.length)
      request.tool_choice = { ...(request.tool_choice || { type: "auto" }), disable_parallel_tool_use: true };
  } else {
    request.stream_options = { include_usage: true };
    if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
    if (body.reasoning?.effort)
      request.reasoning_effort = body.reasoning.effort;
    if (body.max_output_tokens) request.max_tokens = body.max_output_tokens;
    if (body.tool_choice)
      request.tool_choice =
        typeof body.tool_choice === "string"
          ? body.tool_choice
          : { type: "function", function: { name: body.tool_choice.name } };
  }
  return request;
}
async function* sseMessages(stream, signal) {
  const reader = stream.getReader(), parser = new (require('./sse-parser.cjs').SseParser)();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      for (const frame of parser.feed(value, done, event => event.done || ['response.completed', 'response.incomplete', 'message_stop'].includes(event.type))) yield frame.event;
      if (done) break;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
class ResponseEvents {
  constructor(model) {
    this.seq = 0;
    this.response = {
      id: "resp_" + crypto.randomBytes(12).toString("hex"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
      output: [],
      usage: null,
    };
    this.items = new Map();
  }
  event(type, data = {}) {
    return { type, sequence_number: this.seq++, ...data };
  }
  usage(input, output, details) {
    for (const [key, value] of Object.entries({ input_tokens: input, output_tokens: output }))
      if (Number.isFinite(value) && value >= 0) (this.response.usage ||= {})[key] = value;
    if (Number.isFinite(details?.reasoning_tokens) && details.reasoning_tokens >= 0)
      (this.response.usage ||= {}).output_tokens_details = { reasoning_tokens: details.reasoning_tokens };
  }
  start() {
    return [
      this.event("response.created", {
        response: { ...this.response, output: [] },
      }),
      this.event("response.in_progress", {
        response: { ...this.response, output: [] },
      }),
    ];
  }
  add(key, kind, info = {}) {
    if (this.items.has(key)) return [];
    const index = this.response.output.length;
    const item =
      kind === "tool"
        ? {
            type: "function_call",
            id: "fc_" + crypto.randomBytes(8).toString("hex"),
            call_id: info.id || "call_" + crypto.randomBytes(8).toString("hex"),
            name: info.name || "",
            arguments: "",
            status: "in_progress",
          }
        : {
            type: "message",
            id: "msg_" + crypto.randomBytes(8).toString("hex"),
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: "", annotations: [] }],
          };
    this.items.set(key, { item, index });
    this.response.output.push(item);
    const ev = [
      this.event("response.output_item.added", {
        output_index: index,
        item: structuredClone(item),
      }),
    ];
    if (kind !== "tool")
      ev.push(
        this.event("response.content_part.added", {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part: structuredClone(item.content[0]),
        }),
      );
    return ev;
  }
  delta(key, text) {
    const { item, index } = this.items.get(key);
    if (item.type === "function_call") {
      item.arguments += text;
      return this.event("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: text,
      });
    }
    item.content[0].text += text;
    return this.event("response.output_text.delta", {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: text,
    });
  }
  finish(incomplete = false) {
    if (incomplete && [...this.items.values()].some(v => v.item.type === 'function_call')) throw Error('上游工具调用未完整生成，未转发执行');
    const ev = [];
    for (const { item, index } of this.items.values()) {
      item.status = incomplete ? "incomplete" : "completed";
      if (item.type === "function_call")
        ev.push(
          this.event("response.function_call_arguments.done", {
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          }),
        );
      else {
        ev.push(
          this.event("response.output_text.done", {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text: item.content[0].text,
          }),
        );
        ev.push(
          this.event("response.content_part.done", {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: item.content[0],
          }),
        );
      }
      ev.push(
        this.event("response.output_item.done", { output_index: index, item }),
      );
    }
    this.response.status = incomplete ? "incomplete" : "completed";
    if (incomplete)
      this.response.incomplete_details = { reason: "max_output_tokens" };
    const usage = this.response.usage;
    if (Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens))
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
    ev.push(
      this.event(incomplete ? "response.incomplete" : "response.completed", {
        response: this.response,
      }),
    );
    return ev;
  }
}
async function* translateStream(stream, protocol, model) {
  const out = new ResponseEvents(model);
  yield* out.start();
  let ended = false,
    limited = false;
  for await (const data of sseMessages(stream)) {
    if (data.error || data.type === "error") throw new Error("上游流返回错误");
    if (data.choices?.some(c => c.delta?.refusal || c.finish_reason === 'content_filter')) throw Error('上游拒绝或过滤了请求，未作为正常完成转发');
    if (protocol === "anthropic") {
      if (data.type === "message_start")
        out.usage(data.message?.usage?.input_tokens, data.message?.usage?.output_tokens);
      if (data.type === "content_block_start") {
        const c = data.content_block;
        if (c.type === "tool_use") {
          yield* out.add(data.index, "tool", { id: c.id, name: c.name });
          if (c.input && Object.keys(c.input).length) yield out.delta(data.index, JSON.stringify(c.input));
        }
        else if (c.type === "text") {
          yield* out.add(data.index, "text");
          if (c.text) yield out.delta(data.index, c.text);
        }
      }
      if (data.type === "content_block_delta" && out.items.has(data.index)) {
        if (data.delta.type === "text_delta")
          yield out.delta(data.index, data.delta.text);
        if (data.delta.type === "input_json_delta")
          yield out.delta(data.index, data.delta.partial_json);
      }
      if (data.type === 'content_block_stop') {
        const item = out.items.get(data.index)?.item;
        if (item?.type === 'function_call' && !item.arguments) yield out.delta(data.index, '{}');
      }
      if (data.type === "message_delta") {
        out.usage(data.usage?.input_tokens, data.usage?.output_tokens);
        limited ||= anthropicLimited(data.delta?.stop_reason);
      }
      if (data.type === "message_stop") {
        ended = true;
        break;
      }
    } else {
      if (data.done) {
        ended = true;
        break;
      }
      if (data.usage) {
        out.usage(data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.completion_tokens_details);
      }
      const c = data.choices?.[0],
        d = c?.delta;
      if (c?.finish_reason) {
        ended = true;
        limited = c.finish_reason === "length";
      }
      if (d?.content) {
        yield* out.add("text", "text");
        yield out.delta("text", d.content);
      }
      for (const t of d?.tool_calls || []) {
        const key = "tool" + t.index;
        const existing = out.items.get(key)?.item;
        if (existing && t.function?.name && t.function.name !== existing.name) throw Error('上游分段工具名称无法安全识别，未转发执行');
        yield* out.add(key, "tool", { id: t.id, name: t.function?.name });
        if (t.function?.arguments) yield out.delta(key, t.function.arguments);
      }
    }
  }
  if (!ended) throw new Error("上游流提前断开，未收到结束事件");
  yield* out.finish(limited);
}
const anthropicLimited = reason => ['max_tokens', 'model_context_window_exceeded'].includes(reason);
module.exports = { convertRequest, translateStream, sseMessages, anthropicLimited };
