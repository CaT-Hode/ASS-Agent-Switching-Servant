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
  let fd;
  try {
    fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
    fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function withoutOwn(text) {
  return text.replace(
    /# >>> ass managed start[\s\S]*?# <<< ass managed end\r?\n?/g,
    "",
  );
}
function prepareConfig(text, catalog, baseUrl = "http://127.0.0.1:25819/clients/ASS/v1", defaultModel = null, localToken = "", gatewayAuth = false, predictionCompatibility = false) {
  if (predictionCompatibility && !gatewayAuth) throw Error('提示词预测兼容需要原生 OAuth 接入');
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
  const block = `${START}\nmodel_provider = "${predictionCompatibility ? 'openai' : 'ASS'}"\nmodel_catalog_json = ${JSON.stringify(catalog)}\nopenai_base_url = ${JSON.stringify(baseUrl)}\n${model}${END}\n`;
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
          (c.model_provider === "ASS" || c.model_provider === 'openai' && authMode === 'oauth') &&
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
  prepareAttach(defaultModel = null, localToken = "", gatewayAuth = false, predictionCompatibility = false) {
    const old = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    // Validate ownership, restore the baseline in memory, then apply the new
    // desired default. Never strip an externally edited managed block.
    const baseline = old.includes(START) ? this.preflightDetach().next : old;
    const attached = old.includes(START) ? TOML.parse(managedBlocks(old)[0]) : null;
    const selection = !defaultModel && attached?.model && attached.model_reasoning_effort === undefined ? attached.model : null;
    const prepared = prepareConfig(baseline, this.catalog, this.baseUrl, defaultModel, localToken, gatewayAuth, predictionCompatibility);
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
    if (Object.keys(top).some(k => !topKeys.includes(k)) ||
        !(top.model_provider === 'ASS' || top.model_provider === 'openai' && provider?.requires_openai_auth === true && provider.experimental_bearer_token === undefined) ||
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
  ownedCurrent(record, current, requireMarkers = true) {
    const owned = this.validateRecord(record);
    if (requireMarkers) managedBlocks(current);
    const parsed = TOML.parse(current);
    selection(parsed);
    if ((parsed.chatgpt_base_url === this.legacyChatgptBaseUrl && owned[0].chatgpt_base_url !== this.legacyChatgptBaseUrl) ||
        Object.entries(owned[0]).some(([key,value]) => !SELECTION_KEYS.includes(key) && !equal(parsed[key],value)) ||
        !equal(parsed.model_providers?.ASS, owned[1].model_providers.ASS))
      throw Error("Codex 的 ASS 管理区段已被外部修改，未覆盖；请检查备份和当前配置");
    return { owned, parsed };
  }
  attachmentFromBackups() {
    const current = fs.readFileSync(this.file, 'utf8');
    const blocks = managedBlocks(current), live = TOML.parse(current), top = TOML.parse(blocks[0]);
    const dir = path.join(this.dataDir, 'backups');
    const directory = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) return;
    const names = fs.readdirSync(dir).filter(n => /^config-\d+(?:-proxy)?\.toml$/.test(n)).sort().reverse().slice(0, 64);
    let bytes = 0;
    const candidates = [];
    for (const name of names) {
      try {
        const backup = path.join(dir, name), stat = fs.lstatSync(backup);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (bytes += stat.size) > 8 * 1024 * 1024) continue;
        const baseline = fs.readFileSync(backup, 'utf8');
        if (baseline.includes(START) || baseline.includes(END)) continue;
        const before = TOML.parse(baseline);
        const defaultModel = top.model && top.model_reasoning_effort !== undefined
          ? { model: live.model, effort: live.model_reasoning_effort || top.model_reasoning_effort } : null;
        const provider = live.model_providers?.ASS;
        const prepared = prepareConfig(baseline, this.catalog, this.baseUrl, defaultModel,
          provider?.experimental_bearer_token || '', provider?.requires_openai_auth === true, live.model_provider === 'openai');
        let expected = prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g);
        const replaced = prepared.replaced;
        if (top.model && !defaultModel) {
          replaced.model = before.model ?? null;
          expected[0] = expected[0].replace(END, `model = ${JSON.stringify(live.model)}\n${END}`);
        }
        if (live.chatgpt_base_url === this.legacyChatgptBaseUrl) {
          replaced.chatgpt_base_url = before.chatgpt_base_url ?? null;
          expected[0] = expected[0].replace(END, `chatgpt_base_url = ${JSON.stringify(this.legacyChatgptBaseUrl)}\n${END}`);
        }
        const record = { backup, replaced, blocks: expected };
        this.ownedCurrent(record, current);
        candidates.push(record);
      } catch { /* A partial, foreign or unrelated backup is not recovery evidence. */ }
    }
    if (!candidates.length) return;
    if (candidates.some(r => !equal(r.replaced, candidates[0].replaced)))
      throw Error('Codex 旧备份的恢复值存在歧义，已保留当前配置');
    return candidates[0];
  }
  readAttachment({ recoverCorrupt = false } = {}) {
    let text;
    try {
      if (fs.statSync(this.record).size > 1024 * 1024) throw Error('Codex 接入记录超过 1 MiB，已保留原文件');
      text = fs.readFileSync(this.record, 'utf8');
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      text = null;
    }
    if (text !== null) {
      try {
        const record = JSON.parse(text);
        // Incomplete JSON objects can still be parseable after a failed write.
        // Only a separately validated checkpoint may replace that structure.
        // A complete record claiming foreign ownership remains an explicit
        // conflict and must not be converted into a missing-record recovery.
        if (recoverCorrupt && (!record || typeof record !== 'object' || Array.isArray(record) ||
            !Array.isArray(record.blocks) || record.blocks.length !== 2 || !record.replaced)) {
          let trusted;
          try { trusted = this.recoverAttachment?.(); if (trusted) this.validateRecord(trusted); }
          catch { trusted = null; }
          if (trusted) return { record: structuredClone(trusted), text, recovered: true };
        }
        return { record, text };
      } catch (error) {
        if (!recoverCorrupt) throw Error('Codex 接入记录无法解析，未覆盖');
      }
    }
    let record, recoveryError;
    try { record = this.recoverAttachment?.(); } catch (error) { recoveryError = error; }
    if (!record) {
      try { record = this.attachmentFromBackups(); } catch (error) { recoveryError = error; }
    }
    if (!record) throw recoveryError || Error('Codex 接入记录缺失，未找到可校验的恢复检查点或原始备份；当前配置已保留');
    this.validateRecord(record);
    return { record: structuredClone(record), text, recovered: true };
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
    const { record } = this.readAttachment();
    const { owned, parsed } = this.ownedCurrent(record, current);
    // Codex's TOML writer may place new root preferences/tables before our EOF
    // comment. Markers are not ownership: validate only the recorded fields and
    // remove only those fields, retaining every unrelated native setting.
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
    let record, recordText, recovered, current, parsed;
    try {
      ({record, text: recordText, recovered} = this.readAttachment({ recoverCorrupt: true }));
      current = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
      parsed = TOML.parse(current);
    } catch { throw Error("Codex 配置或接入记录无法解析，未修复"); }
    if (current.includes("aimami-relay codex-router top start"))
      throw Error("检测到其他路由工具仍接管 Codex。请先关闭旧路由，再修复接入。");
    const owned = this.validateRecord(record);
    if (parsed.chatgpt_base_url === this.legacyChatgptBaseUrl && owned[0].chatgpt_base_url !== this.legacyChatgptBaseUrl)
      throw Error('Codex 管理区段与当前接入不匹配（旧官方后端基线缺失），未覆盖');
    const expected = [...record.blocks];
    const savedProviders = owned[1].model_providers;
    const blocks = [...current.matchAll(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)];
    const completeMarkers = blocks.length === 2 && current.split(START).length === 3 && current.split(END).length === 3;
    const onlyOwned = (value, keys) => Object.keys(value).every((k) => Object.hasOwn(keys, k) &&
      (keys[k] && typeof keys[k] === "object" ? value[k] && typeof value[k] === "object" && onlyOwned(value[k], keys[k]) : true));
    if (!completeMarkers) {
      if (Object.keys(owned[0]).some((k) => !SELECTION_KEYS.includes(k) && Object.hasOwn(parsed, k)) || parsed.model_providers?.ASS)
        this.ownedCurrent(record, current, false);
    } else if (parsed.model_providers?.ASS && !onlyOwned(parsed.model_providers.ASS, savedProviders.ASS)) {
      throw Error("Codex 管理区段混入非 ASS 字段，未覆盖");
    }
    const target = structuredClone(parsed);
    const selected = selection(parsed);
    for (const [key,value] of Object.entries(owned[0]))
      if (!SELECTION_KEYS.includes(key) || !Object.hasOwn(parsed, key)) target[key] = value;
    target.model_providers ||= {};
    Object.assign(target.model_providers, savedProviders);
    let recordUpdate = recovered ? { file: this.record, before: recordText, after: JSON.stringify(record) } : undefined;
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
    if (!equal(target, parsed) || owned[0].chatgpt_base_url !== undefined || !completeMarkers) {
      const top = withSelection(expected[0], selection(target));
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
