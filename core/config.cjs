const fs = require("node:fs");
const path = require("node:path");
const TOML = require("@iarna/toml");
const { isDeepStrictEqual: equal } = require("node:util");
const START = "# >>> ass managed start";
const END = "# <<< ass managed end";
// Codex owns these live UI preferences even when they happen to sit between
// ASS markers. Connection/authentication fields remain strictly ASS-owned.
const SELECTION_KEYS = ["model", "model_reasoning_effort"];
function selection(value) {
  for (const key of SELECTION_KEYS) if (Object.hasOwn(value, key) &&
      (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 1024 || /[\r\n]/.test(value[key])))
    throw Error("Codex 模型选择字段无效，未覆盖");
  return Object.fromEntries(SELECTION_KEYS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
function managedBlocks(current) {
  const blocks = current.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) || [];
  if (blocks.length !== 2 || current.split(START).length !== 3 || current.split(END).length !== 3)
    throw Error("Codex 管理标记缺失或不完整，未覆盖");
  return blocks;
}
function withSelection(block, current) {
  let text = block;
  const values = selection(current);
  for (const key of SELECTION_KEYS) {
    text = text.replace(new RegExp("^" + key + "\\s*=.*(?:\\r?\\n|$)", "m"), "");
    if (Object.hasOwn(values, key)) text = text.replace(END, `${key} = ${JSON.stringify(values[key])}\n${END}`);
  }
  return text;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function withoutOwn(text) {
  return text.replace(
    /# >>> ass managed start[\s\S]*?# <<< ass managed end\r?\n?/g,
    "",
  );
}
function prepareConfig(text, catalog, baseUrl = "http://127.0.0.1:25819/clients/ASS/v1", defaultModel = null, localToken = "", gatewayAuth = false) {
  if (text.includes("aimami-relay codex-router top start"))
    throw new Error(
      "检测到其他路由工具仍接管 Codex。请先关闭旧路由，再点击接入。",
    );
  if (text.includes(START) || text.includes(END))
    throw Error("Codex 管理区段必须先验证接入记录，未覆盖");
  const clean = text, parsed = TOML.parse(clean);
  const replaced = {};
  if (["ASS", "ass_router", "aimai1"].includes(parsed.model_provider) ||
    parsed.model_catalog_json === catalog || parsed.openai_base_url === baseUrl ||
    parsed.model_providers?.openai ||
    parsed.model_providers?.ASS ||
    parsed.model_providers?.ass_router ||
    parsed.model_providers?.aimai1
  )
    throw new Error(
      "存在其他工具或非 ASS 管理的模型供应商，请先恢复原配置，避免覆盖",
    );
  let first = clean.search(/^\[/m);
  if (first < 0) first = clean.length;
  let top = clean.slice(0, first),
    rest = clean.slice(first);
  const managedTopKeys = ["model_provider", "model_catalog_json", "openai_base_url",
    ...(defaultModel ? ["model", "model_reasoning_effort"] : [])];
  for (const key of managedTopKeys) {
    replaced[key] = parsed[key] ?? null;
    top = top.replace(new RegExp("^" + key + "\\s*=.*(?:\\r?\\n|$)", "m"), "");
  }
  if (defaultModel && !(/^ASS_[a-f0-9]{24}::.+$/.test(defaultModel.model) ||
    (!localToken || gatewayAuth) && /^gpt-[\w.-]+$/.test(defaultModel.model)))
    throw Error("Codex 默认模型不是当前 ASS 模型标识，未接入");
  const model = defaultModel ? `model = ${JSON.stringify(defaultModel.model)}\nmodel_reasoning_effort = ${JSON.stringify(defaultModel.effort)}\n` : "";
  // Resumed threads may retain their provider, independently of the global
  // default. Redirect built-in OpenAI via its supported setting, NOT an
  // ignored [model_providers.openai] override. Never edit session history.
  // chatgpt_base_url also controls workspace authentication and unrelated
  // official services. Its backend requires HTTPS; keep the user's value (or
  // native default) independent from our loopback inference endpoint.
  const block = `${START}\nmodel_provider = "ASS"\nmodel_catalog_json = ${JSON.stringify(catalog)}\nopenai_base_url = ${JSON.stringify(baseUrl)}\n${model}${END}\n`;
  // Keep the native ChatGPT account visible for ordinary gateway routing.
  // The local bearer is only written for the explicit accountless mode.
  const auth = gatewayAuth
    ? "requires_openai_auth = true\n"
    : localToken
      ? `requires_openai_auth = false\nexperimental_bearer_token = ${JSON.stringify(localToken)}\n`
      : "requires_openai_auth = true\n";
  const definition = `name = "ASS"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\n${auth}supports_websockets = false\n`;
  const providers = `\n${START}\n[model_providers.ASS]\n${definition}${END}\n`;
  const result = block + top + rest + providers;
  TOML.parse(result);
  return { text: result, replaced };
}
class ConfigManager {
  constructor(codexDir, dataDir, port = 25819) {
    this.file = path.join(codexDir, "config.toml");
    this.dataDir = dataDir;
    this.catalog = path.join(dataDir, "catalog.json");
    this.record = path.join(dataDir, "codex-attachment.json");
    this.baseUrl = `http://127.0.0.1:${port}/clients/ASS/v1`;
    // v0.3.28 ownership is accepted only so explicit sync/repair/detach can
    // restore its saved baseline. New attachments never write this endpoint.
    this.legacyChatgptBaseUrl = `http://127.0.0.1:${port}/clients/ASS/backend-api/`;
  }
  status() {
    try {
      const text = fs.readFileSync(this.file, "utf8"), c = TOML.parse(text);
      const provider = c.model_providers?.ASS;
      const authMode = provider?.requires_openai_auth === true && provider?.experimental_bearer_token === undefined
        ? "oauth"
        : provider?.requires_openai_auth === false && typeof provider?.experimental_bearer_token === "string" && provider.experimental_bearer_token.length > 0
          ? "accountless"
          : "unknown";
      return {
        attached:
          c.model_provider === "ASS" &&
          provider?.base_url === this.baseUrl &&
          provider?.supports_websockets === false &&
          c.openai_base_url === this.baseUrl &&
          !c.model_providers?.aimai1 && !c.model_providers?.ass_router &&
          c.model_catalog_json === this.catalog &&
          provider?.wire_api === "responses",
        legacyWorkspaceRelay: c.chatgpt_base_url === this.legacyChatgptBaseUrl,
        authMode,
        managed: text.includes(START),
        provider: c.model_provider || "openai",
      };
    } catch {
      return { attached: false, provider: "unknown" };
    }
  }
  prepareAttach(defaultModel = null, localToken = "", gatewayAuth = false) {
    const old = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    // Validate ownership, restore the baseline in memory, then apply the new
    // desired default. Never strip an externally edited managed block.
    const baseline = old.includes(START) ? this.preflightDetach().next : old;
    const attached = old.includes(START) ? TOML.parse(managedBlocks(old)[0]) : null;
    const selection = !defaultModel && attached?.model && attached.model_reasoning_effort === undefined ? attached.model : null;
    const prepared = prepareConfig(baseline, this.catalog, this.baseUrl, defaultModel, localToken, gatewayAuth);
    if (selection) {
      // Keep an already-owned selection, including its original rollback value.
      // Accountless defaults own effort too and must restore their baseline.
      prepared.replaced.model = TOML.parse(baseline).model ?? null;
      const firstTable = prepared.text.search(/^\[/m);
      const split = firstTable < 0 ? prepared.text.length : firstTable;
      const clean = prepared.text.slice(0, split).replace(/^model\s*=.*(?:\r?\n|$)/m, "") + prepared.text.slice(split);
      prepared.text = clean.replace(END, `model = ${JSON.stringify(selection)}\n${END}`);
      TOML.parse(prepared.text);
    }
    return { old, ...prepared };
  }
  attach(defaultModel = null) {
    const { old, text, replaced } = this.prepareAttach(defaultModel);
    if (old === text) return;
    const backup = path.join(
      this.dataDir,
      "backups",
      "config-" + Date.now() + ".toml",
    );
    atomic(backup, old);
    if ((fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "") !== old)
      throw new Error("配置同时被修改，请重试");
    const previousRecord = fs.existsSync(this.record) ? fs.readFileSync(this.record) : null;
    try {
      atomic(this.record, JSON.stringify({ backup, replaced, blocks: text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
      atomic(this.file, text);
    } catch (error) {
      if (previousRecord) atomic(this.record, previousRecord);
      else if (fs.existsSync(this.record)) fs.unlinkSync(this.record);
      throw error;
    }
    return backup;
  }
  validateRecord(record) {
    const expected = record?.blocks;
    if (!Array.isArray(expected) || expected.length !== 2 || expected.some(s => typeof s !== "string" ||
        !s.startsWith(START + "\n") || !s.endsWith(END) ||
        s.split(START).length !== 2 || s.split(END).length !== 2))
      throw Error("缺少可信的当前 Codex 管理区段记录，未覆盖");
    let owned;
    try { owned = expected.map(s => TOML.parse(s)); }
    catch { throw Error("Codex 管理区段记录无效，未覆盖"); }
    const top = owned[0], provider = owned[1].model_providers?.ASS;
    const topKeys = ["model_provider", "model_catalog_json", "openai_base_url", "chatgpt_base_url", "model", "model_reasoning_effort"];
    const providerKeys = ["name", "base_url", "wire_api", "requires_openai_auth", "supports_websockets", "experimental_bearer_token"];
    if (Object.keys(top).some(k => !topKeys.includes(k)) || top.model_provider !== "ASS" ||
        top.model_catalog_json !== this.catalog || top.openai_base_url !== this.baseUrl ||
        (top.chatgpt_base_url !== undefined && (top.chatgpt_base_url !== this.legacyChatgptBaseUrl ||
          !Object.hasOwn(record.replaced || {}, "chatgpt_base_url"))) ||
        (top.model !== undefined && !(/^ASS_[a-f0-9]{24}::.+$/.test(top.model) ||
          /^gpt-[\w.-]+$/.test(top.model))) ||
        (top.model_reasoning_effort !== undefined && typeof top.model_reasoning_effort !== "string") ||
        !equal(Object.keys(owned[1]), ["model_providers"]) ||
        !equal(Object.keys(owned[1].model_providers || {}), ["ASS"]) ||
        !provider || Object.keys(provider).some(k => !providerKeys.includes(k)) ||
        provider.name !== "ASS" || provider.base_url !== this.baseUrl || provider.wire_api !== "responses" ||
        provider.supports_websockets !== false ||
        !(provider.requires_openai_auth === true && provider.experimental_bearer_token === undefined ||
          provider.requires_openai_auth === false && typeof provider.experimental_bearer_token === "string" && provider.experimental_bearer_token.length > 0))
      throw Error("Codex 管理区段与当前接入不匹配，未覆盖");
    const replacedKeys = Object.keys(record.replaced || {});
    const allowedReplaced = new Set([...topKeys, "agents.default_subagent_model"]);
    if (!record.replaced || typeof record.replaced !== "object" || Array.isArray(record.replaced) ||
        replacedKeys.some(k => !allowedReplaced.has(k)) ||
        Object.values(record.replaced).some(v => v !== null && typeof v !== "string"))
      throw Error("Codex 原配置恢复记录无效，未覆盖");
    return owned;
  }
  preflightDetach() {
    if (!fs.existsSync(this.file)) return null;
    const current = fs.readFileSync(this.file, "utf8");
    if (!current.includes(START)) {
      const parsed = TOML.parse(current);
      if (current.includes(END) || ["ASS", "ass_router", "aimai1"].includes(parsed.model_provider) ||
          ["ASS", "ass_router", "aimai1"].some(k => Object.hasOwn(parsed.model_providers || {}, k)) ||
          parsed.model_catalog_json === this.catalog || parsed.openai_base_url === this.baseUrl)
        throw Error("Codex 配置中存在无法归属的 ASS 字段，请先检查配置，未自动删除");
      return null;
    }
    const record = JSON.parse(fs.readFileSync(this.record, "utf8"));
    const owned = this.validateRecord(record); managedBlocks(current);
    const parsed = TOML.parse(current);
    selection(parsed);
    // Codex's TOML writer may place new root preferences/tables before our EOF
    // comment. Markers are not ownership: validate only the recorded fields and
    // remove only those fields, retaining every unrelated native setting.
    if (Object.entries(owned[0]).some(([key,value]) => !SELECTION_KEYS.includes(key) && !equal(parsed[key],value)) ||
        !equal(parsed.model_providers?.ASS, owned[1].model_providers.ASS))
      throw Error("Codex 的 ASS 管理区段已被外部修改，未覆盖；请检查备份和当前配置");
    for (const key of Object.keys(owned[0])) if (!SELECTION_KEYS.includes(key)) delete parsed[key];
    delete parsed.model_providers.ASS;
    if (!Object.keys(parsed.model_providers).length) delete parsed.model_providers;
    for (const [key, value] of Object.entries(record.replaced)) {
      if (key === "agents.default_subagent_model") {
        const agents = parsed.agents || {};
        if (value === null) delete agents.default_subagent_model;
        else agents.default_subagent_model = value;
        if (Object.keys(agents).length) parsed.agents = agents;
        else delete parsed.agents;
        continue;
      }
      if (value === null) delete parsed[key];
      else parsed[key] = value;
    }
    return { current, next: TOML.stringify(parsed) };
  }
  prepareRepair() {
    let record, recordText, current, parsed;
    try {
      recordText = fs.readFileSync(this.record, "utf8");
      record = JSON.parse(recordText);
      current = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
      parsed = TOML.parse(current);
    } catch { throw Error("Codex 配置或接入记录无法解析，未修复"); }
    if (current.includes("aimami-relay codex-router top start"))
      throw Error("检测到其他路由工具仍接管 Codex。请先关闭旧路由，再修复接入。");
    const owned = this.validateRecord(record);
    const expected = [...record.blocks];
    const savedProviders = owned[1].model_providers;
    const blocks = [...current.matchAll(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)];
    if ((current.split(START).length - 1 !== blocks.length) ||
        (current.split(END).length - 1 !== blocks.length) || ![0, 2].includes(blocks.length))
      throw Error("Codex 管理标记缺失或不完整，未修复");
    const onlyOwned = (value, keys) => Object.keys(value).every((k) => Object.hasOwn(keys, k) &&
      (keys[k] && typeof keys[k] === "object" ? value[k] && typeof value[k] === "object" && onlyOwned(value[k], keys[k]) : true));
    if (!blocks.length) {
      if (Object.keys(owned[0]).some((k) => Object.hasOwn(parsed, k)) || Object.keys(owned[1].model_providers).some(k => parsed.model_providers?.[k]))
        throw Error("Codex 无标记的同名字段无法确认归属，未覆盖");
    } else if (parsed.model_providers?.ASS && !onlyOwned(parsed.model_providers.ASS, savedProviders.ASS)) {
      throw Error("Codex 管理区段混入非 ASS 字段，未覆盖");
    }
    const target = structuredClone(parsed);
    const selected = selection(parsed);
    for (const [key,value] of Object.entries(owned[0]))
      if (!SELECTION_KEYS.includes(key) || !blocks.length) target[key] = value;
    target.model_providers ||= {};
    Object.assign(target.model_providers, savedProviders);
    let recordUpdate;
    if (owned[0].chatgpt_base_url !== undefined) {
      // Repair the already-applied snapshot, never model/provider drafts.
      // Restore the old account backend and retire its ownership atomically
      // with the repaired config through ProxyConfig's write-ahead journal.
      const baseline = record.replaced.chatgpt_base_url;
      expected[0] = expected[0].replace(/^chatgpt_base_url\s*=.*\n/m, "");
      if (baseline === null) delete target.chatgpt_base_url;
      else {
        target.chatgpt_base_url = baseline;
      }
      const replaced = { ...record.replaced };
      delete replaced.chatgpt_base_url;
      recordUpdate = { file: this.record, before: recordText,
        after: JSON.stringify({ ...record, replaced, blocks: expected }) };
    }
    // The common native-write case needs no normalization or config write at
    // all. For a real repair, rebuild owned fields around all existing native
    // preferences, even when Codex has moved them inside a marker region.
    let next = current;
    if (!equal(target, parsed) || recordUpdate || !blocks.length) {
      const top = blocks.length ? withSelection(expected[0], selected) : expected[0];
      const rest = structuredClone(target);
      for (const key of Object.keys(TOML.parse(top))) delete rest[key];
      delete rest.model_providers.ASS;
      if (!Object.keys(rest.model_providers).length) delete rest.model_providers;
      next = top + "\n" + TOML.stringify(rest) + "\n" + expected[1] + "\n";
    }
    try {
      if (!equal(target, TOML.parse(next))) throw Error();
    } catch { throw Error("修复会影响非 ASS 的 Codex 配置，未写入"); }
    return { file: this.file, before: fs.existsSync(this.file) ? current : null, after: next,
      ...(recordUpdate ? { recordUpdate } : {}) };
  }
  detach() {
    const plan = this.preflightDetach();
    if (!plan) return;
    const { current, next } = plan;
    atomic(
      path.join(
        this.dataDir,
        "backups",
        "config-detach-" + Date.now() + ".toml",
      ),
      current,
    );
    if (fs.readFileSync(this.file, "utf8") !== current)
      throw Error("Codex 配置同时被修改，请重新检查后断开");
    atomic(this.file, next);
  }
}
module.exports = { atomic, prepareConfig, withoutOwn, ConfigManager };
