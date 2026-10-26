const { createHash } = require("node:crypto");
function customInput(args) {
  let parsed;
  try { parsed = JSON.parse(args); } catch { throw Error("上游自定义工具输入不是完整 JSON"); }
  if (typeof parsed.input !== "string") throw Error("上游自定义工具缺少 input 字符串");
  return parsed.input;
}
function hasArraySchema(schema) {
  return !!schema && typeof schema === 'object' &&
    (schema.type === 'array' || Array.isArray(schema.type) && schema.type.includes('array') || Object.values(schema).some(hasArraySchema));
}
function functionInput(args) {
  const input = customInput(args);
  let value;
  try { value = JSON.parse(input); } catch { throw Error('上游函数工具参数不是有效 JSON 对象'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('上游函数工具参数不是有效 JSON 对象');
  return input;
}
// Convert client-executed custom/namespace tools to JSON functions. The proxy
// never executes them; restore the exact client tool identity on the way back.
function toolBridge(body, { encodeArrayArguments = false } = {}) {
  const mapping = new Map(), names = new Map(), unqualified = new Map(), tools = [];
  const key = (namespace, name) => JSON.stringify([namespace || "", name]);
  const aliasKey = (name, custom) => JSON.stringify([name, custom]);
  const wireNameFor = (namespace, name, custom) => namespace || custom
    ? "ass_" + createHash("sha256").update(key(namespace, name)).digest("hex").slice(0, 32) : name;
  function add(tool, namespace) {
    if (tool.type === "namespace") {
      for (const nested of tool.tools || []) add(nested, namespace ? namespace + "." + tool.name : tool.name);
      return;
    }
    if (!["custom", "function"].includes(tool.type)) { tools.push(tool); return; }
    const original = { name: tool.name, ...(namespace ? { namespace } : {}), custom: tool.type === "custom" };
    if (!original.custom && encodeArrayArguments && hasArraySchema(tool.parameters)) original.jsonArguments = true;
    const wireName = wireNameFor(namespace, tool.name, original.custom);
    if (mapping.has(wireName)) throw Object.assign(Error("重复工具定义"), { status: 400 });
    mapping.set(wireName, original); names.set(key(namespace, tool.name), wireName);
    const alias = aliasKey(tool.name, original.custom);
    unqualified.set(alias, unqualified.has(alias) ? null : wireName);
    tools.push(original.custom || original.jsonArguments ? { type: "function", name: wireName,
      description: [tool.description, original.custom ? "Pass the complete raw tool input as the input string."
        : "Pass the complete JSON object of tool arguments as the input string. Arguments JSON schema: " + JSON.stringify(tool.parameters),
        tool.format?.syntax ? "Input syntax: " + tool.format.syntax : "", tool.format?.definition || ""].filter(Boolean).join("\n"),
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
      ...(original.jsonArguments && tool.strict !== undefined ? { strict: tool.strict } : {}) }
      : { ...tool, name: wireName });
  }
  for (const tool of body.tools || []) add(tool, tool.namespace);
  function convertItem(item) {
    if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
    if (!["function_call", "custom_tool_call"].includes(item.type)) return item;
    const custom = item.type === "custom_tool_call";
    if (custom && (typeof item.name !== 'string' || !item.name || typeof item.input !== 'string'))
      throw Object.assign(Error("自定义工具历史的名称或输入无效"), { status: 400 });
    let name = names.get(key(item.namespace, item.name));
    // Codex rollouts can omit namespace on stored calls. Rebind only when
    // exactly one currently declared tool has the same name and input kind.
    if (!name && !item.namespace) {
      name = unqualified.get(aliasKey(item.name, custom));
    }
    // Historical tools may no longer be declared (including deferred tools).
    // Translate their call/result pair without re-enabling an obsolete tool.
    name ||= wireNameFor(item.namespace, item.name, custom);
    const { namespace, input, ...rest } = item;
    return { ...rest, type: "function_call", name,
      arguments: custom ? JSON.stringify({ input }) : mapping.get(name)?.jsonArguments
        ? JSON.stringify({ input: item.arguments || '{}' }) : item.arguments };
  }
  const choice = body.tool_choice;
  const request = { ...body, ...(body.tools ? { tools } : {}),
    ...(Array.isArray(body.input) ? { input: body.input.map(convertItem) } : {}),
    ...(choice && typeof choice === "object" && names.has(key(choice.namespace, choice.name))
      ? { tool_choice: { type: "function", name: names.get(key(choice.namespace, choice.name)) } } : {}) };
  function item(value) {
    const original = value?.type === "function_call" && mapping.get(value.name);
    if (!original) return value;
    const { custom, jsonArguments, ...identity } = original;
    if (!custom && !jsonArguments) return { ...value, ...identity };
    const input = value.arguments ? (jsonArguments ? functionInput(value.arguments) : customInput(value.arguments)) : "";
    if (jsonArguments) return { ...value, ...identity, arguments: input };
    const { arguments: args, ...rest } = value;
    return { ...rest, ...identity, type: "custom_tool_call", input };
  }
  function response(value) {
    return { ...value, ...(Array.isArray(value.output) ? { output: value.output.map(item) } : {}) };
  }
  async function* restore(events) {
    const encoded = new Map(), argumentsById = new Map(); let sequence = 0;
    const output = event => ({ ...event, sequence_number: sequence++ });
    for await (const e of events) {
      const original = e.type === 'response.output_item.added' && mapping.get(e.item?.name);
      if (original && (original.custom || original.jsonArguments)) encoded.set(e.item.id, original);
      if (encoded.has(e.item_id) && e.type === "response.function_call_arguments.delta") {
        argumentsById.set(e.item_id, (argumentsById.get(e.item_id) || "") + e.delta); continue;
      }
      if (encoded.has(e.item_id) && e.type === "response.function_call_arguments.done") {
        const raw = e.arguments || argumentsById.get(e.item_id) || "{}";
        const jsonArguments = encoded.get(e.item_id).jsonArguments;
        const input = jsonArguments ? functionInput(raw) : customInput(raw);
        const { arguments: args, ...rest } = e;
        yield output({ ...rest, type: jsonArguments ? 'response.function_call_arguments.delta' : "response.custom_tool_call_input.delta", delta: input });
        yield output({ ...rest, ...(jsonArguments ? { arguments: input } : { type: 'response.custom_tool_call_input.done', input }) }); continue;
      }
      yield output({ ...e, ...(e.item ? { item: item(e.item) } : {}),
        ...(e.response ? { response: response(e.response) } : {}) });
    }
  }
  return { request, restore, response };
}
module.exports = { toolBridge };
