const { randomUUID } = require("node:crypto");
const { convertRequest, translateStream, sseMessages } = require("./adapters.cjs");
const { withOutputLimit } = require('./output-tokens.cjs');
const unsupported = (type) => Object.assign(Error("此跨协议模型不支持 " + type + "，请选择 Messages 模型"), { status: 400 });
function normalizeMessages(body) {
  if (!body.messages?.some(m => ["system", "developer"].includes(m.role))) return body;
  const blocks = value => typeof value === "string" ? (value ? [{ type: "text", text: value }] : []) : value || [];
  return { ...body, system: [...blocks(body.system), ...body.messages
    .filter(m => ["system", "developer"].includes(m.role)).flatMap(m => blocks(m.content))],
    messages: body.messages.filter(m => !["system", "developer"].includes(m.role)) };
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw unsupported("内容格式");
  return content.map((c) => { if (c.type !== "text") throw unsupported(c.type); return c.text || ""; }).join("\n");
}
function messagesRequest(body, model, protocol) {
  if (body.stop_sequences != null && (!Array.isArray(body.stop_sequences) || body.stop_sequences.some(s => typeof s !== 'string' || !s)))
    throw Object.assign(Error('stop_sequences 必须是非空字符串数组'), { status: 400 });
  const input = [];
  const system = [contentText(body.system || "")];
  for (const message of body.messages || []) {
    // Current CC gateways may send a system turn in addition to top-level
    // system. Preserve it as instructions instead of rejecting the whole turn.
    if (["system", "developer"].includes(message.role)) { system.push(contentText(message.content)); continue; }
    if (!["user", "assistant"].includes(message.role)) throw unsupported("消息角色");
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks || []) {
      if (block.type === "text") input.push({ role: message.role, content: block.text });
      else if (block.type === "image" && block.source) {
        const source = block.source;
        const image = source.type === "url" ? source.url : source.type === "base64" && source.media_type && source.data
          ? `data:${source.media_type};base64,${source.data}` : null;
        if (!image) throw unsupported("image");
        input.push({ role: message.role, content: [{ type: "input_image", image_url: image }] });
      }
      else if (block.type === "tool_use") input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
      else if (block.type === "tool_result") input.push({ type: "function_call_output", call_id: block.tool_use_id,
        output: (block.is_error ? "Tool error: " : "") + contentText(block.content || "") });
      else if (!["thinking", "redacted_thinking"].includes(block.type)) throw unsupported(block.type);
    }
  }
  const tools = (body.tools || []).map((tool) => {
    if ((tool.type && !/^custom(?:_\d+)?$/.test(tool.type)) || !tool.name) throw unsupported("服务端工具");
    return { type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema };
  });
  const choice = body.tool_choice;
  const request = { model: model.model, input, instructions: system.filter(Boolean).join("\n\n"), stream: true, store: false,
    max_output_tokens: Math.max(16, withOutputLimit(body, model, 'anthropic').max_tokens),
    ...(tools.length ? { tools } : {}),
    ...(choice ? { tool_choice: choice.type === "tool" ? { type: "function", name: choice.name }
      : choice.type === "any" ? "required" : choice.type } : {}),
    ...(body.output_config?.effort ? { reasoning: { effort: body.output_config.effort } } : {}),
  };
  if (choice?.disable_parallel_tool_use) request.parallel_tool_calls = false;
  const converted = protocol === "openai-responses" ? request : convertRequest(request, model, protocol);
  for (const field of ["temperature", "top_p"]) if (body[field] !== undefined) converted[field] = body[field];
  if (body.stop_sequences?.length && protocol !== 'openai-responses') {
    converted.stop = body.stop_sequences;
  }
  return converted;
}
async function* translatedMessages(stream, protocol, model) {
  const id = "msg_" + randomUUID().replace(/-/g, "");
  const usage = { input_tokens: 0, output_tokens: 0 };
  yield { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } } };
  const blocks = new Map(); let index = 0, ended = false, tool = false;
  function* finishItem(item) {
    if (!["function_call", "message"].includes(item?.type)) return;
    let block = blocks.get(item.id);
    if (block?.closed) return;
    if (!block) {
      const isTool = item.type === "function_call";
      if (isTool) tool = true;
      block = { index: index++, type: isTool ? "tool" : "text", closed: false, hasDelta: false };
      blocks.set(item.id, block);
      yield { type: "content_block_start", index: block.index, content_block: isTool
        ? { type: "tool_use", id: item.call_id || item.id, name: item.name, input: {} } : { type: "text", text: "" } };
    }
    if (!block.hasDelta) {
      yield { type: "content_block_delta", index: block.index, delta: block.type === "tool"
        ? { type: "input_json_delta", partial_json: item.arguments || "{}" }
        : { type: "text_delta", text: (item.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("") } };
      block.hasDelta = true;
    }
    block.closed = true;
    yield { type: "content_block_stop", index: block.index };
  }
  const events = protocol === "openai-responses" ? sseMessages(stream) : translateStream(stream, protocol, model);
  for await (const event of events) {
    if (event.error || ["error", "response.failed"].includes(event.type)) throw Error("上游返回错误事件");
    if (/^response\.refusal\./.test(event.type || '') || event.item?.content?.some(c => c.type === 'refusal') ||
        event.response?.output?.some(item => item.content?.some(c => c.type === 'refusal')) ||
        event.response?.incomplete_details?.reason === 'content_filter') throw Error('上游拒绝或过滤了请求，未作为正常完成转发');
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      tool = true; blocks.set(event.item.id, { index: index++, type: "tool", closed: false, hasDelta: false });
      yield { type: "content_block_start", index: blocks.get(event.item.id).index,
        content_block: { type: "tool_use", id: event.item.call_id || event.item.id, name: event.item.name, input: {} } };
    }
    const text = event.type === "response.output_text.delta", args = event.type === "response.function_call_arguments.delta";
    if (text || args) {
      const key = event.item_id || String(event.output_index);
      if (!blocks.has(key) && text) {
        blocks.set(key, { index: index++, type: "text", closed: false, hasDelta: false });
        yield { type: "content_block_start", index: blocks.get(key).index, content_block: { type: "text", text: "" } };
      }
      const block = blocks.get(key);
      if (!block || block.closed) throw Error("上游流中的内容块顺序无效");
      block.hasDelta = true;
      yield { type: "content_block_delta", index: block.index, delta: text ? { type: "text_delta", text: event.delta } : { type: "input_json_delta", partial_json: event.delta } };
    }
    if (event.type === "response.function_call_arguments.done") {
      const block = blocks.get(event.item_id);
      if (block && !block.closed && !block.hasDelta && typeof event.arguments === "string") {
        block.hasDelta = true;
        yield { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: event.arguments } };
      }
    }
    // A closed argument block is not proof that a tool completed. Wait for the
    // response terminal before publishing a callable tool block's stop event.
    if (event.type === "response.output_item.done" && event.item?.type !== 'function_call') yield* finishItem(event.item);
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      if (event.type === 'response.incomplete' && (tool || event.response?.output?.some(item => item.type === 'function_call'))) throw Error('上游工具调用未完整生成，未转发执行');
      for (const item of event.response?.output || []) {
        // Some providers only put text / tool arguments in the completed item.
        yield* finishItem(item);
      }
      for (const block of blocks.values()) if (!block.closed) { block.closed = true; yield { type: "content_block_stop", index: block.index }; }
      Object.assign(usage, { input_tokens: event.response?.usage?.input_tokens || 0, output_tokens: event.response?.usage?.output_tokens || 0 });
      yield { type: "message_delta", delta: { stop_reason: event.type === "response.incomplete" ? "max_tokens" : tool ? "tool_use" : "end_turn", stop_sequence: null }, usage };
      yield { type: "message_stop" }; ended = true; break;
    }
  }
  if (!ended) throw Error("上游流提前结束");
}
async function* messagesEvents(stream, protocol, model, stopSequences = []) {
  const events = translatedMessages(stream, protocol, model);
  if (protocol !== 'openai-responses' || !stopSequences?.length) { yield* events;return; }
  const tail = Math.max(...stopSequences.map(s => s.length)) - 1;
  const open = new Map(), pending = new Map();
  let usage = { input_tokens: 0, output_tokens: 0 };
  for await (const event of events) {
    if (event.type === 'message_start') usage = { ...event.message.usage };
    if (event.type === 'message_delta') Object.assign(usage, event.usage);
    if (event.type === 'content_block_start') open.set(event.index, event.content_block.type);
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const text = (pending.get(event.index) || '') + event.delta.text;
      let position = -1, stop;
      for (const sequence of stopSequences) {
        const found = text.indexOf(sequence);
        if (found >= 0 && (position < 0 || found < position)) { position = found;stop = sequence; }
      }
      const end = position >= 0 ? position : Math.max(0, text.length - tail);
      if (end) yield { ...event, delta: { type: 'text_delta', text: text.slice(0, end) } };
      if (position >= 0) {
        // A stop marker cannot make a partial function call executable.
        if ([...open.values()].includes('tool_use')) throw Error('停止序列命中前工具调用未完整生成，未转发执行');
        for (const index of open.keys()) yield { type: 'content_block_stop', index };
        yield { type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: stop }, usage };
        yield { type: 'message_stop' };
        return; // Closing the source iterator also cancels the upstream reader.
      }
      pending.set(event.index, text.slice(end));
      continue;
    }
    if (event.type === 'content_block_stop') {
      const text = pending.get(event.index);
      if (text) yield { type: 'content_block_delta', index: event.index, delta: { type: 'text_delta', text } };
      pending.delete(event.index);open.delete(event.index);
    }
    yield event;
  }
}
async function messagesJSON(events) {
  let message;
  const blocks = new Map();
  for await (const event of events) {
    if (event.type === "message_start") message = event.message;
    if (event.type === "content_block_start") blocks.set(event.index, { ...event.content_block, json: "" });
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      else block.json += event.delta.partial_json;
    }
    if (event.type === "message_delta") { Object.assign(message, event.delta); Object.assign(message.usage, event.usage); }
  }
  message.content = [...blocks.values()].map(({ json, ...block }) => block.type === "tool_use" ? { ...block, input: JSON.parse(json || "{}") } : block);
  return message;
}
module.exports = { messagesRequest, messagesEvents, messagesJSON, normalizeMessages };
