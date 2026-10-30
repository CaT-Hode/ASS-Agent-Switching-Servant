const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { memoRead } = require("./read-scope.cjs");
const ids = new Set(["llm-pi-ai", "llm-deepseek", "agent-default-model"]);
function validProfile(profile) {
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile))
    throw Error('DSH 当前 profile 名称无效，未写入配置');
  return profile;
}
function json(file) {
  return memoRead(json, [file], () => readJson(file));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw Error("DSH 运行版本记录无法读取"); }
}
function usesProfile(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(version || "");
  if (!m) return false;
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  return major > 0 || minor > 1 || (minor === 1 && (patch > 7 || (patch === 7 && (!m[4] || m[4] === "rc" && +m[5] >= 2))));
}
function target(dir, manager) {
  return memoRead(target, [dir, manager], () => resolveTarget(dir, manager));
}
function runtimeFile(dir) {
  return ['dsh-app/web.json', 'desktop-link/web.json', 'web.json'].map(file => path.join(dir, file)).find(file => fs.existsSync(file));
}
function catalogStamp(dir) {
  const location = target(dir), files = [runtimeFile(dir), location.config, path.join(dir, '.credentials.yaml')].filter(Boolean);
  return JSON.stringify(files.map(file => {
    require('./native-fields.cjs').safePath(file);
    try {const s=fs.statSync(file);return [file,s.size,s.mtimeMs,s.ctimeMs,s.ino];}
    catch(e) {if(e.code==='ENOENT')return [file,null];throw e;}
  }));
}
function resolveTarget(dir, manager) {
  const link = json(runtimeFile(dir) || path.join(dir, "desktop-link", "web.json"));
  const installed = json(path.join(dir, "desktop-link", "active-core.json"));
  // A running desktop core can differ from the source checkout selected as CLI.
  let version = link.coreVersion || installed.version;
  if (!version && manager?.state.executables?.dsh) {
    const executable = manager.state.executables.dsh;
    const entry = typeof executable === "string" ? executable : executable.entryPoint;
    if (entry) {
      for (const base of [entry, path.dirname(entry), path.dirname(path.dirname(entry))]) {
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
        const manifest = json(path.join(base, "package.json"));
        if (manifest.name === "@deepseek-ai/dsh") { version = manifest.version; break; }
      }
    }
  }
  const profiles = [...new Set((manager?.options?.nativeConfig?.fields.entries || []).flatMap((e) => {
    if (e.harness !== 'dsh' || e.format !== 'dsh-patch') return [];
    const relative = path.relative(path.resolve(dir, 'profiles'), path.resolve(e.file)).split(path.sep);
    return relative.length === 2 && relative[1] === 'cordis.patch.yml' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(relative[0]) ? [relative[0]] : [];
  }))];
  const owned = profiles.length > 0;
  // Independent account homes inherit the profile format, not desktop runtime
  // metadata. A generated patch remains readable after ASS or DSH restarts.
  if (link.profile === undefined && profiles.length > 1) throw Error('DSH 目录包含多个受管 profile，无法确认启动目标');
  const profile = validProfile(link.profile ?? profiles[0] ?? 'web');
  const profileFile = path.join(dir, "profiles", profile, "cordis.patch.yml");
  const modern = usesProfile(version) || owned || (!version && fs.existsSync(profileFile));
  return { dir, auth: path.join(dir, ".credentials.yaml"),
    config: modern ? path.join(dir, "profiles", profile, "cordis.patch.yml") : path.join(dir, "settings.yaml"),
    format: modern ? "dsh-patch" : "yaml", profile, version };
}
function profileTarget(dir, base) {
  const profile = validProfile(base.profile ?? 'web');
  return { dir, auth: path.join(dir, ".credentials.yaml"), format: base.format, profile, version: base.version,
    config: base.format === "dsh-patch" ? path.join(dir, "profiles", profile, "cordis.patch.yml") : path.join(dir, "settings.yaml") };
}
function launchArgs(location) {
  return ['--profile', validProfile(location.format === 'dsh-patch' ? location.profile : 'web')];
}
function reasoning(model) {
  const supported = ['low', 'medium', 'high', 'xhigh', 'max'];
  const efforts = (model.efforts || []).filter(e => supported.includes(e));
  if (!efforts.length) throw Error('DSH 模型没有可用的原生思考档位（支持 low、medium、high、xhigh、max），未写入配置');
  if (!efforts.includes(model.defaultEffort)) throw Error('DSH 不支持该模型的默认思考档位，未写入配置');
  return Object.fromEntries(efforts.map(e => [e, e]));
}
// Project only the two configurable plugin entries. The rest of the Cordis
// patch (including !!js expressions) stays as YAML syntax and is never executed.
function document(text) {
  const yaml = YAML.parseDocument(text === null || !text.trim() ? "[]\n" : text, { uniqueKeys: true });
  if (yaml.errors.length || !YAML.isSeq(yaml.contents)) throw Error("DSH profile 补丁必须是有效的 YAML 列表，未覆盖");
  YAML.visit(yaml, (_, node) => { if (YAML.isAlias(node)) throw Error("DSH 补丁包含 YAML 别名，请先整理后接入"); });
  const data = {}, indexes = {};
  for (const [index, node] of yaml.contents.items.entries()) {
    if (!YAML.isMap(node)) throw Error("DSH 补丁条目不是对象，未覆盖");
    const id = node.get("id");
    if (!ids.has(id)) continue;
    if (Object.hasOwn(indexes, id)) throw Error("DSH 补丁存在重复的模型配置条目，未覆盖");
    if (node.has("remove") || node.has("replace") || node.has("insert") || node.has("disabled"))
      throw Error("DSH 模型插件被禁用或使用结构化替换，请先在 DSH 确认插件配置");
    const config = node.get("config", true);
    if (config && !YAML.isMap(config)) throw Error("DSH 模型插件 config 不是对象，未覆盖");
    if (config) YAML.visit(config, (_, value) => {
      if (value?.tag && !value.tag.startsWith("tag:yaml.org,2002:")) throw Error("DSH 模型配置包含表达式，未覆盖");
      if (value?.tag === "tag:yaml.org,2002:js") throw Error("DSH 模型配置包含表达式，未覆盖");
    });
    indexes[id] = index;
    data[id] = config?.toJSON() || {};
  }
  return { data, yaml, indexes };
}
function edit(text, keys, value) {
  const doc = document(text), [id, ...field] = keys;
  let index = doc.indexes[id];
  if (index === undefined) {
    if (!value.exists) return text;
    index = doc.yaml.contents.items.length;
    doc.yaml.add(doc.yaml.createNode({ id, config: {} }));
  }
  if (value.exists) doc.yaml.setIn([index, "config", ...field], value.value);
  else doc.yaml.deleteIn([index, "config", ...field]);
  return doc.yaml.toString({ lineWidth: 0 });
}
function validField(e) {
  return e.harness === "dsh" && !e.selector && Array.isArray(e.path) &&
    (e.path.length === 3 && e.path[0] === "llm-pi-ai" && e.path[1] === "providers" && /^ass-[a-f0-9]{16}-(chat|responses|messages)$/i.test(e.path[2]) ||
     e.path.length === 2 && e.path[0] === "agent-default-model" && ["provider", "model", "reasoningEffort"].includes(e.path[1]));
}
function readSettings(dir, readLegacy) {
  const location = target(dir);
  if (location.format === "yaml") return readLegacy(location.config, "yaml");
  return memoRead(readSettings, [location.config], () => readProfileSettings(location));
}
function readProfileSettings(location) {
  let content = null;
  try {
    if (fs.statSync(location.config).size > 8 * 1024 * 1024) throw Error("DSH profile 配置过大");
    content = fs.readFileSync(location.config, "utf8");
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  return document(content).data;
}
function profileFiles(location, base) {
  if (location.format !== 'dsh-patch' || ['web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(location.profile)) return [];
  const manifestFile = path.join(base.dir, 'profiles', validProfile(base.profile), 'package.json');
  require('./native-fields.cjs').safePath(manifestFile);
  const bundles = json(manifestFile).dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.length || bundles.some(b => typeof b !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/.test(b)))
    throw Error('DSH 自定义 profile 缺少可迁移的 bundle 清单；请在目标目录初始化此 profile');
  return [[path.join('profiles', location.profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + location.profile, private: true, dependencies: {}, dsh: { profile: { bundles } },
  }, null, 2) + '\n']];
}
module.exports = { target, profileTarget, launchArgs, validProfile, profileFiles, reasoning, usesProfile, document, edit, validField, readSettings, runtimeFile, catalogStamp };
