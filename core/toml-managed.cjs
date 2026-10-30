const TOML = require("@iarna/toml");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual: equal } = require("node:util");

// Kimi owns its document. ASS only appends/removes individually marked tables;
// never round-trip the user's comments, OAuth references or formatting. A
// namespace upgrade may rename the existing default_model scalar in place.
function validPath(keys) {
  return Array.isArray(keys) && (keys.length === 1 && keys[0] === 'default_model' || keys.length === 2 &&
    ["providers", "models"].includes(keys[0]) && /^ass-[a-z0-9-]+$/i.test(keys[1]));
}
function parse(text) {
  try { return TOML.parse((text || "").replace(/^\uFEFF/, "")); }
  catch { throw Error("原生 TOML 配置无法解析，未覆盖"); }
}
function markers(keys) {
  if (!validPath(keys)) throw Error("无效的 ASS TOML 字段");
  const id = createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 24);
  return ["# >>> ASS managed TOML:" + id, "# <<< ASS managed TOML:" + id];
}
function block(keys, value, eol) {
  const [start, end] = markers(keys);
  const body = TOML.stringify({ [keys[0]]: { [keys[1]]: value } }).replace(/\r?\n/g, eol);
  return eol + start + eol + body + end + eol;
}
function normalize(data) {
  for (const key of ["providers", "models"])
    if (data[key] && !Object.keys(data[key]).length) delete data[key];
  return data;
}
function tableRanges(source) {
  const tables = [];
  let quote = "", triple = false, depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (!quote && !depth && (i === 0 || source[i - 1] === "\n")) {
      const newline = source.indexOf("\n", i), end = newline < 0 ? source.length : newline;
      const line = source.slice(i, end);
      if (/^\s*\[/.test(line)) {
        let node = parse(line);
        const keys = [];
        while (node && typeof node === "object") {
          if (Array.isArray(node)) { node = node[0]; continue; }
          const names = Object.keys(node);
          if (names.length !== 1) break;
          keys.push(names[0]); node = node[names[0]];
        }
        tables.push({ start: i, keys }); i = end; continue;
      }
    }
    if (quote) {
      if (quote === '"' && c === "\\") { i++; continue; }
      if (c === quote) {
        if (!triple) quote = "";
        else if (source.startsWith(quote.repeat(3), i)) {
          while (source[i + 1] === quote) i++;
          quote = ""; triple = false;
        }
      }
      continue;
    }
    if (c === "#") { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue; }
    if (c === '"' || c === "'") {
      quote = c; triple = source.startsWith(c.repeat(3), i); if (triple) i += 2;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return tables.map((table, i) => ({ ...table, end: tables[i + 1]?.start ?? source.length }));
}
function removeReformattedTable(source, keys) {
  // Legacy Kimi reserializes the document and drops comments. The encrypted
  // journal still proves semantic ownership; locate just that table and its
  // children, skipping quoted strings/arrays rather than matching header text.
  const spans = tableRanges(source).filter((t) => keys.every((k, i) => t.keys[i] === k));
  if (!spans.length) throw Error("ASS TOML 字段不再是独立表，未覆盖");
  let result = source;
  for (const span of spans.reverse()) {
    const body = source.slice(span.start, span.end);
    const trailing = body.match(/(?:[\t ]*(?:#[^\r\n]*)?\r?\n)+$/)?.[0] || "";
    result = result.slice(0, span.start) + trailing + result.slice(span.end);
  }
  return result;
}
function edit(text, keys, target) {
  const source = text || "", before = parse(source), [root, key] = keys;
  if (keys.length === 1 && root === 'default_model') {
    const result = source.replace(/^(\uFEFF?[\t ]*(?:default_model|"default_model"|'default_model')[\t ]*=[\t ]*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')(?=[\t ]*(?:#[^\r\n]*)?\r?$)/m,
      (_, prefix) => target.exists ? prefix + JSON.stringify(target.value) : '');
    if (target.exists) before.default_model = target.value;
    else delete before.default_model;
    if (!equal(before, parse(result))) throw Error('Kimi 默认模型字段无法单独重命名，未覆盖');
    return result;
  }
  const [start, end] = markers(keys), current = before[root]?.[key];
  let result;
  if (current !== undefined) {
    const startCount = source.split(start).length - 1, endCount = source.split(end).length - 1;
    if (!startCount && !endCount) {
      result = removeReformattedTable(source, keys);
      if (target.exists) result += block(keys, target.value, source.includes("\r\n") ? "\r\n" : "\n");
    } else {
      if (startCount !== 1 || endCount !== 1)
        throw Error("ASS TOML 标记缺失或重复，未覆盖；请先检查客户端配置");
      const owned = ["\r\n", "\n"].map((eol) => block(keys, current, eol))
        .find((value) => source.includes(value));
      if (!owned) throw Error("ASS TOML 区块已被外部修改，未覆盖");
      const index = source.indexOf(owned), eol = owned.startsWith("\r\n") ? "\r\n" : "\n";
      result = source.slice(0, index) + (target.exists ? block(keys, target.value, eol) : "") + source.slice(index + owned.length);
    }
  } else {
    if (source.includes(start) || source.includes(end)) throw Error("ASS TOML 标记与字段不一致，未覆盖");
    result = target.exists ? source + block(keys, target.value, source.includes("\r\n") ? "\r\n" : "\n") : source;
  }
  // A marker inside a multiline string is not an owned table. Parsing both
  // sides also rejects inline/sealed table collisions without rewriting them.
  if (target.exists) {
    before[root] ||= {};
    before[root][key] = target.value;
  } else if (before[root]) delete before[root][key];
  if (!equal(normalize(before), normalize(parse(result))))
    throw Error("TOML 编辑会影响非 ASS 字段，未写入");
  return result;
}
function assertOwned(text, keys) { if (keys.length > 1) edit(text, keys, { exists: false }); }
module.exports = { parse, edit, validPath, assertOwned };
