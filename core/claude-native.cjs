// Native CLI overlay. Routing and its field-level restore record are committed
// together by ProxyConfig's encrypted write-ahead journal.
const path = require("node:path");
const { isDeepStrictEqual: equal } = require("node:util");
const { document, edit, read } = require("./native-fields.cjs");
const { claudeModelSettings, claudeModelEnv, CLAUDE_MODEL_ENV: MODEL_ENV } = require("./accountless.cjs");
const CLEAR_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];
const CLOUD_ENV = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const SETTING_KEYS = ["model", "availableModels", "enforceAvailableModels", "modelPicker", "apiKeyHelper"];
const ENV_KEYS = [...MODEL_ENV, ...CLEAR_ENV, ...CLOUD_ENV, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "CLAUDE_CODE_AUTO_MODE_SERVER"];
const present = value => ({ exists: true, value });
function valueAt(data, keys) {
  let value = data;
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("CC 配置字段的父级不是对象，未覆盖");
    if (!Object.hasOwn(value, key)) return { exists: false };
    value = value[key];
  }
  return present(value);
}
function targets(manager) {
  const home = manager.nativeHome, env = manager.nativeEnv || {};
  const custom = env.CLAUDE_CONFIG_DIR?.replace(/^~(?=[/\\]|$)/, home);
  if (custom && !path.isAbsolute(custom)) throw Error("CLAUDE_CONFIG_DIR 必须为绝对路径，才能接入系统终端");
  const dir = custom ? path.resolve(custom) : path.join(home, ".claude");
  // Account-import search directories do not change what the native CLI reads.
  return { settings: path.join(dir, "settings.json"), profile: path.join(custom ? dir : home, ".claude.json") };
}
function validate(record) {
  if (!record) return;
  const t = record.targets;
  if (record.version !== 1 || !t || !path.isAbsolute(t.settings || "") || !path.isAbsolute(t.profile || "") ||
      path.basename(t.settings) !== "settings.json" || path.basename(t.profile) !== ".claude.json" ||
      ![path.dirname(t.settings), path.dirname(path.dirname(t.settings))].includes(path.dirname(t.profile)) ||
      typeof record.createdEnv !== "boolean" || !Array.isArray(record.fields) || !record.fields.length) throw Error("CC 原生接入记录无效");
  const seen = new Set();
  for (const f of record.fields) {
    const allowed = f.file === t.profile ? equal(f.path, ["hasCompletedOnboarding"])
      : f.file === t.settings && Array.isArray(f.path) &&
        ((f.path.length === 1 && SETTING_KEYS.includes(f.path[0])) ||
         (f.path.length === 2 && f.path[0] === "env" && ENV_KEYS.includes(f.path[1])));
    const key = JSON.stringify([f.file, f.path]);
    if (!allowed || seen.has(key) || [f.before, f.after].some(v => !v || typeof v.exists !== "boolean" || (v.exists && !Object.hasOwn(v, "value"))))
      throw Error("CC 原生接入字段无效");
    seen.add(key);
  }
}
function specs(manager, plan) {
  if (!plan?.accountless) return [];
  const t = targets(manager), selected = plan.defaultModel.model;
  const settings = claudeModelSettings(plan.providers, selected);
  const base = `http://127.0.0.1:${manager.options?.port || 25819}/clients/claude/models`;
  const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: plan.localToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...claudeModelEnv(plan.providers, selected, plan.autoModeModel),
    ...Object.fromEntries(CLEAR_ENV.map(k => [k, ""])), ...Object.fromEntries(CLOUD_ENV.map(k => [k, "0"])) };
  return [
    ...Object.entries(settings).map(([key, value]) => ({ file: t.settings, path: [key], after: present(value) })),
    { file: t.settings, path: ["apiKeyHelper"], after: { exists: false } },
    ...Object.entries(env).map(([key, value]) => ({ file: t.settings, path: ["env", key], after: present(value) })),
    { file: t.profile, path: ["hasCompletedOnboarding"], after: present(true) },
  ];
}
function checkPolicy(manager, t) {
  const env = manager.nativeEnv || {};
  // Never silently pretend shell overrides or enforced logins are accounted for.
  const conflicts = [...CLEAR_ENV, ...CLOUD_ENV, ...MODEL_ENV, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].filter(k =>
    env[k] && !(CLOUD_ENV.includes(k) && ["0", "false"].includes(env[k])));
  if (conflicts.length) throw Error("CC 终端环境存在接入覆盖，请先移除后重启 ASS：" + conflicts.join("、"));
  const files = [t.settings, path.join(path.dirname(t.settings), "managed-settings.json")];
  if (process.platform === "win32" && env.ProgramFiles) files.push(path.join(env.ProgramFiles, "ClaudeCode", "managed-settings.json"));
  for (const file of files) {
    const source = read(file);
    if (!source) continue;
    const data = document(source, "json").data;
    if (data.forceLoginMethod || data.forceLoginOrgUUID) throw Error("CC 配置要求官方登录，请先确认其登录策略；ASS 不覆盖此限制");
  }
}
const routedModel = value => typeof value === 'string' && (/^claude-ass-/.test(value) || value.includes('::'));
function clearRoutedSelections(data) {
  const before = JSON.stringify(data), result = structuredClone(data);
  const base = result.env?.ANTHROPIC_BASE_URL;
  // A previous, independently configured gateway still owns its model names.
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base)) return data;
  for (const key of ['model', 'lastModel', 'lastSessionModel']) if (routedModel(result[key])) delete result[key];
  for (const project of Object.values(result.projects || {})) {
    const projectBase = project.env?.ANTHROPIC_BASE_URL;
    if (projectBase && !/^https:\/\/api\.anthropic\.com\/?$/.test(projectBase)) continue;
    for (const key of ['model', 'lastModel', 'lastSessionModel']) if (routedModel(project[key])) delete project[key];
  }
  for (const key of MODEL_ENV) if (routedModel(result.env?.[key])) delete result.env[key];
  if (Array.isArray(result.availableModels)) {
    result.availableModels = result.availableModels.filter(model => !routedModel(typeof model === 'string' ? model : model?.value));
    if (!result.availableModels.length) { delete result.availableModels; delete result.enforceAvailableModels; }
  }
  if (Array.isArray(result.modelPicker)) {
    result.modelPicker = result.modelPicker.filter(model => !routedModel(model?.value || model?.model));
    if (!result.modelPicker.length) delete result.modelPicker;
  }
  return JSON.stringify(result) === before ? data : result;
}
function plan(manager, route, previous, { repair = false } = {}) {
  validate(previous);
  const desired = specs(manager, route), t = targets(manager);
  if (desired.length) {
    checkPolicy(manager, t);
    if (previous && !equal(previous.targets, t)) throw Error("CC 原生目录已变化，请先关闭无账号启动，恢复旧目录后再开启");
  }
  const files = new Map(), entries = new Map();
  const get = file => {
    if (!files.has(file)) { const before = read(file); document(before, "json"); files.set(file, { file, before, after: before }); }
    return files.get(file);
  };
  const key = f => JSON.stringify([f.file, f.path]);
  for (const f of previous?.fields || []) {
    const current = valueAt(document(get(f.file).after, "json").data, f.path);
    if (!repair && !equal(current, f.after)) throw Error("CC 无账号启动字段被外部修改，请先一键修复：" + f.path.join("."));
    entries.set(key(f), f);
  }
  const fields = desired.map(f => {
    const before = entries.get(key(f))?.before || valueAt(document(get(f.file).after, "json").data, f.path);
    return { ...f, before };
  });
  for (const f of [...(previous?.fields || []).filter(f => !desired.some(d => key(d) === key(f))).map(f => ({ ...f, after: f.before })), ...fields]) {
    const file = get(f.file);
    file.after = edit(file.after, "json", f.path, f.after);
  }
  const createdEnv = previous?.createdEnv ?? (desired.length ? !Object.hasOwn(document(get(t.settings).before, "json").data, "env") : false);
  if (!desired.length && previous?.createdEnv) {
    const file = get(previous.targets.settings), data = document(file.after, "json").data;
    if (data.env && !Object.keys(data.env).length) file.after = edit(file.after, "json", ["env"], { exists: false });
  }
  if (!desired.length) for (const file of [t.settings, t.profile]) {
    const record = get(file), data = document(record.after, 'json').data, cleared = clearRoutedSelections(data);
    if (!equal(data, cleared)) record.after = JSON.stringify(cleared, null, 2) + '\n';
  }
  return { record: desired.length ? { version: 1, targets: t, createdEnv, fields } : undefined,
    files: [...files.values()].filter(f => f.after !== f.before) };
}
function check(record) {
  validate(record);
  const docs = new Map();
  for (const f of record?.fields || []) {
    if (!docs.has(f.file)) docs.set(f.file, document(read(f.file), "json").data);
    if (!equal(valueAt(docs.get(f.file), f.path), f.after))
      throw Error("CC 无账号启动字段被外部修改，请先一键修复：" + f.path.join("."));
  }
}
function fingerprint(manager, record) {
  const files = new Set([...Object.values(targets(manager)), ...Object.values(record?.targets || {})]);
  return [...files].map(file => [file, read(file)]);
}
module.exports = { targets, validate, plan, check, fingerprint, clearRoutedSelections };
