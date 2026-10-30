const path = require("node:path");
const fs = require("node:fs");
const PROVIDERS = ["config", "providerConfigRules", "providerRules"];
const MODELS = ["config", "modelConfigRules", "providerModelRules"];
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v) => typeof v === "string" && !!v.trim();
function empty() {
  return { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } };
}
function locations({ home, env = {}, override }, readSettings) {
  if (override) return [{ dir: path.resolve(override), configured: true }];
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || home;
  const result = [{ dir: path.resolve(base, ".zcode", "v2"), configured: !!env.ZCODE_DATA_BASE_DIR?.trim() }];
  if (env.ZCODE_DATA_BASE_DIR?.trim() || env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()) return result;
  const bootstrap = path.join(home, ".zcode/v2/setting.json"), settings = readSettings(bootstrap);
  const custom = typeof settings?.dataBaseDir === "string" ? settings.dataBaseDir.trim() : "";
  if (custom) {
    if (!path.isAbsolute(custom)) return [{ ...result[0], bootstrap, issue: "ZCode 桌面数据目录是相对路径，请指定实际凭据目录" }];
    const dir = path.join(custom, ".zcode/v2");
    if (dir.toLowerCase() !== result[0].dir.toLowerCase()) result.push({ dir, configured: true, bootstrap });
  }
  return result;
}
function target(manager, readSettings) {
  const env = manager.nativeEnv, home = manager.nativeHome, override = manager.state.credentialHomes.zcode;
  if (!override && env.ZCODE_DATA_BASE_DIR?.trim() && !path.isAbsolute(env.ZCODE_DATA_BASE_DIR.trim()))
    throw Error("ZCode 自定义配置路径须为绝对路径");
  const candidates = locations({ home, env, override }, readSettings);
  const issue = candidates.find((c) => c.issue)?.issue;
  if (issue) throw Error(issue);
  const active = candidates.filter((c) => c.configured || fs.existsSync(path.join(c.dir, "provider_config.json")));
  if (active.length > 1) throw Error("检测到多个 ZCode 配置位置，请在客户端设置中指定凭据目录");
  const dir = (active[0] || candidates[0]).dir;
  const config = !override && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    ? env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim() : path.join(dir, "provider_config.json");
  if (!path.isAbsolute(dir) || !path.isAbsolute(config)) throw Error("ZCode 自定义配置路径须为绝对路径");
  return { dir: path.resolve(dir), config: path.resolve(config) };
}
function validate(data) {
  const c = data?.config, p = c?.providerConfigRules, m = c?.modelConfigRules;
  const exact = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
  if (!exact(data, ["schemaVersion", "config"]) || data.schemaVersion !== 1 ||
      !exact(c, ["providerConfigRules", "modelConfigRules", "providerOrder", "defaultModelSelection"]) ||
      !exact(p, ["providerRules"]) || !Array.isArray(p.providerRules) ||
      !exact(m, ["providerModelRules", "manualProviderModelRules"]) ||
      !Array.isArray(m.providerModelRules) || !Array.isArray(m.manualProviderModelRules))
    throw Error("ZCode 供应商配置版本或结构无法识别，未覆盖");
  const providerIds = new Set(), modelIds = new Set();
  for (const row of p.providerRules) {
    if (!object(row) || !string(row.providerId) || !object(row.config) || providerIds.has(row.providerId))
      throw Error("ZCode 供应商规则无效或 ID 重复，未覆盖");
    providerIds.add(row.providerId);
  }
  for (const row of [...m.providerModelRules, ...m.manualProviderModelRules]) {
    if (!object(row) || !string(row.providerId) || !string(row.modelId) || !object(row.config))
      throw Error("ZCode 模型规则无效，未覆盖");
    const id = JSON.stringify([row.providerId, row.modelId]);
    if (modelIds.has(id)) throw Error("ZCode 同一模型存在重复或冲突规则，未覆盖");
    modelIds.add(id);
  }
  if (c.providerOrder !== undefined && (!Array.isArray(c.providerOrder) || c.providerOrder.some((id) => !string(id))))
    throw Error("ZCode 供应商排序格式无效，未覆盖");
  if (c.defaultModelSelection !== undefined && (!object(c.defaultModelSelection) ||
      !string(c.defaultModelSelection.providerId) || !string(c.defaultModelSelection.modelId)))
    throw Error("ZCode 默认模型配置无效，未覆盖");
}
function validField(e) {
  if (e.format === 'json' && e.replace && !e.selector &&
      JSON.stringify(e.path) === JSON.stringify(['config', 'defaultModelSelection'])) return true;
  if (e.format !== "json" || e.replace || !object(e.selector) ||
      !/^ass-[a-f0-9]{16}-(chat|responses|messages)$/i.test(e.selector.providerId || "")) return false;
  const keys = Object.keys(e.selector).sort().join(","), field = JSON.stringify(e.path);
  const ok = field === JSON.stringify(PROVIDERS) ? keys === "providerId" :
    field === JSON.stringify(MODELS) && keys === "modelId,providerId" && string(e.selector.modelId);
  return ok && (!Object.hasOwn(e, "value") || object(e.value) &&
    Object.entries(e.selector).every(([k, v]) => e.value[k] === v));
}
function modelConfig(model) {
  // Smart model rules retain ZCode's model/protocol-specific request mappings.
  // Only overwrite ASS-managed context/output limits and available effort levels.
  return { enabled: true, properties: { contextWindow: model.contextWindow }, optionSpecs: {
    maxOutputTokens: { max: model.maxOutputTokens },
    reasoningLevel: model.efforts.length ? { values: model.efforts }
      : { values: ["disabled"], map: "{}" },
  } };
}
function assertDefaultPreserved(before, after) {
  const selected = before.config.defaultModelSelection;
  if (!selected) return;
  const rows = (d) => d.config.providerConfigRules.providerRules;
  const was = rows(before).find((p) => p.providerId === selected.providerId);
  const chosen = after.config.defaultModelSelection || selected;
  const next = rows(after).find((p) => p.providerId === chosen.providerId);
  if (was?.config.personalModelIds?.includes(selected.modelId) &&
      !next?.config.personalModelIds?.includes(chosen.modelId))
    throw Error("ZCode 默认模型仍属于待移除的供应商，请先在 ZCode 切换模型");
}
module.exports = { PROVIDERS, MODELS, empty, locations, target, validate, validField, modelConfig, assertDefaultPreserved };
