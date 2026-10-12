const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { atomic, read, document, edit } = require("./native-fields.cjs");
const { claudeModels } = require("./claude-models.cjs");

const POLICY = "HKCU\\SOFTWARE\\Policies\\Claude";
const MACHINE_POLICY = "HKLM\\SOFTWARE\\Policies\\Claude";
const names = ["inferenceProvider", "inferenceCredentialKind", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey"];
const modelNames = [...names, "inferenceModels", "modelDiscoveryEnabled"];
const egressKey = "coworkEgressAllowedHosts";
// Personal desktop deployments need normal tool networking. This is separate
// from ASS's loopback-only, authenticated inference listener.
const defaultEgress = ["*"];
const uuid = /^[a-f0-9-]{36}$/;
const hash = values => crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
const present = value => ({ exists: true, value });
const field = (data, name) => Object.hasOwn(data, name) ? present(data[name]) : { exists: false };
const json = text => document(text, "json").data;
const localHash = data => {
  const keys = Object.keys(data);
  const managed = [names, modelNames, [...names, egressKey], [...modelNames, egressKey],
    [...modelNames, "defaultModelEffort", egressKey]]
    .find(candidate => keys.length === candidate.length && candidate.every(name => Object.hasOwn(data, name)));
  return managed ? hash(Object.fromEntries(managed.map(name => [name, data[name]]))) : "";
};

function validateEgress(hosts) {
  if (!Array.isArray(hosts) || hosts.length > 500 || hosts.some(host => {
    if (typeof host !== "string" || host.length > 260) return true;
    if (host === "*") return false;
    const match = /^(\*\.)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?$/.exec(host);
    return !match || match[2].split(".").some(label => !label || label.length > 63 || /^-|-$/.test(label)) ||
      (match[3] && (+match[3] < 1 || +match[3] > 65535));
  })) throw Error("Claude 工具联网域名无效，请使用主机名、*.域名或 *，不要填写 URL");
  return [...new Set(hosts)];
}

function reg(args) {
  return execFileSync("reg.exe", args, { encoding: "utf8", windowsHide: true, maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
}
function readPolicy(key) {
  let output;
  try { output = reg(["query", key]); }
  catch (error) {
    if (error.status === 1) return {};
    throw Error("无法读取 Claude 桌面版系统配置", { cause: error });
  }
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
    if (match) values[match[1]] = { type: match[2], value: match[3].trim() };
  }
  return values;
}
function desired(token, port, providers, egressHosts = defaultEgress) {
  if (!/^[a-f0-9]{64}$/.test(token || "") || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Claude 桌面版接入凭据尚未就绪");
  const profile = {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}/clients/claude/models`,
    inferenceGatewayApiKey: token,
  };
  if (providers) {
    const models = claudeModels(providers);
    if (!models.length) throw Error("Claude 桌面版没有可接入的模型");
    profile.inferenceModels = models.map(({ discoveryId, label, maxEffort, supports1m, prefer1m }) => ({ name: discoveryId, labelOverride: label,
      ...(supports1m ? { supports1m, prefer1m } : {}),
      ...(maxEffort ? { maxEffort } : {}) }));
    profile.modelDiscoveryEnabled = false;
    if (models[0].claudeIdentity && models[0].defaultEffort)
      profile.defaultModelEffort = models[0].defaultEffort;
  }
  profile[egressKey] = validateEgress(egressHosts);
  return profile;
}
function restorePolicy(policy, previous) {
  for (const name of names) {
    const value = previous[name];
    if (value) reg(["add", policy, "/v", name, "/t", value.type, "/d", value.value, "/f"]);
    else if (readPolicy(policy)[name]) reg(["delete", policy, "/v", name, "/f"]);
  }
}
function defaultDirectory() {
  const directory = process.env.CLAUDE_USER_DATA_DIR || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Claude-3p"));
  if (!directory || !path.isAbsolute(directory)) throw Error("无法确定 Claude 桌面版用户配置目录");
  return directory;
}

class ClaudeDesktopGateway {
  constructor(dataDir, { directory = defaultDirectory(), policy = POLICY, machinePolicy = MACHINE_POLICY,
    policyReader = readPolicy, writer = atomic } = {}) {
    this.file = path.join(dataDir, "claude-desktop-gateway.json");
    this.directory = path.resolve(directory);
    this.metaFile = path.join(this.directory, "configLibrary", "_meta.json");
    this.settingsFile = path.join(this.directory, "claude_desktop_config.json");
    Object.assign(this, { policy, machinePolicy, policyReader, writer, cache: null });
  }
  owner() {
    const text = read(this.file);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (!/^[a-f0-9]{64}$/.test(value.hash)) throw Error();
      if (value.version === 1) return value;
      if (value.version !== 2 || !uuid.test(value.id) || value.directory !== this.directory ||
          !value.before || ["metaExisted", "settingsExisted"].some(k => typeof value.before[k] !== "boolean") ||
          ["appliedId", "mode"].some(k => typeof value.before[k]?.exists !== "boolean" ||
            (value.before[k].exists && !Object.hasOwn(value.before[k], "value")))) throw Error();
      return value;
    } catch { throw Error("Claude 桌面版恢复记录无法识别或配置目录已变化，请检查 ASS 数据目录"); }
  }
  policies() {
    if (this.cache && Date.now() - this.cache.at < 3000) return this.cache;
    this.cache = { at: Date.now(), user: this.policyReader(this.policy), machine: this.policyReader(this.machinePolicy) };
    return this.cache;
  }
  invalidate() { this.cache = null; }
  profileFile(id) {
    if (!uuid.test(id)) throw Error("Claude 桌面版配置 ID 无效");
    return path.join(this.directory, "configLibrary", id + ".json");
  }
  local() {
    const metaText = read(this.metaFile), settingsText = read(this.settingsFile);
    const meta = json(metaText), settings = json(settingsText);
    if (meta.entries !== undefined && (!Array.isArray(meta.entries) || meta.entries.some(e => !e || typeof e.id !== "string")))
      throw Error("Claude 桌面版配置索引无法识别，未覆盖");
    return { metaText, settingsText, meta, settings };
  }
  status(token, port, providers) {
    const { user, machine } = this.policies(), owner = this.owner();
    const managed = Object.keys(user).length > 0 || Object.keys(machine).length > 0;
    if (owner?.version === 1) {
      const configured = names.every(name => user[name]?.type === "REG_SZ");
      const owned = configured && owner.hash === hash(Object.fromEntries(names.map(name => [name, user[name].value])));
      const expected = token ? Object.fromEntries(names.map(name => [name, desired(token, port)[name]])) : null;
      return { configured, owned, current: !!(owned && !Object.keys(machine).length && expected && owner.hash === hash(expected)), conflict: !!Object.keys(machine).length || !owned };
    }
    const { meta, settings } = this.local();
    const profile = owner ? json(read(this.profileFile(owner.id))) : {};
    const owned = !!owner && localHash(profile) === owner.hash;
    const selected = !!owner && meta.appliedId === owner.id && !meta.hybridPointer;
    return {
      configured: owned, owned,
      current: !!(owned && selected && settings.deploymentMode === "3p" && !managed && token && owner.hash === hash(desired(token, port, providers, profile[egressKey] ?? defaultEgress))),
      conflict: managed || !!meta.hybridPointer || (!!meta.appliedId && !selected) || (!!owner && !owned),
    };
  }
  // Each file replacement is atomic; a failed batch restores the exact prior
  // bytes, checking for intervening edits before any rollback.
  commit(changes, nextOwner, message) {
    const records = [...changes, { file: this.file, before: read(this.file), after: nextOwner ? JSON.stringify(nextOwner, null, 2) + "\n" : null }];
    const completed = [];
    try {
      for (const change of records) {
        if (change.before === change.after) continue;
        if (read(change.file) !== change.before) throw Object.assign(Error(), { code: "CONFIG_CHANGED" });
        if (change.after === null) fs.unlinkSync(change.file);
        else this.writer(change.file, change.after);
        completed.push(change);
      }
    } catch (error) {
      let restored = true;
      for (const change of completed.reverse()) {
        try {
          if (read(change.file) !== change.after) throw Error();
          if (change.before === null) fs.unlinkSync(change.file);
          else atomic(change.file, change.before);
        } catch { restored = false; }
      }
      const code = /^[A-Z_0-9]+$/.test(error.code || "") ? `（${error.code}）` : "";
      throw Error(message + code + (restored ? "；原设置已恢复" : "；部分设置未恢复，请保留 ASS 数据目录"), { cause: error });
    } finally { this.invalidate(); }
  }
  enable(token, port, providers, egressHosts) {
    const plan = this.prepareEnable(token, port, providers, egressHosts);
    this.commit(plan.changes, plan.owner, "Claude 桌面版本地配置写入失败");
    return { ok: true, message: "Claude 桌面版已配置。重新打开 Claude 后可通过 ASS 使用注入模型。" };
  }
  prepareEnable(token, port, providers, egressHosts) {
    const owner = this.owner();
    if (owner?.version === 1) throw Error("请先移除旧版 Claude 桌面策略，再启用一体化无账号接入");
    this.invalidate();
    const { user, machine } = this.policies();
    if (Object.keys(user).length || Object.keys(machine).length)
      throw Error("Claude 桌面版已有系统管理策略，请先调整该策略后使用本地接入");
    const local = this.local(), id = owner?.id || crypto.randomUUID(), file = this.profileFile(id);
    const profileText = read(file);
    if (local.meta.hybridPointer || (local.meta.appliedId && local.meta.appliedId !== owner?.id))
      throw Error("Claude 桌面版已有生效的本地第三方配置，请先在桌面版中切换或移除该配置");
    if (owner ? localHash(json(profileText)) !== owner.hash : profileText !== null)
      throw Error("Claude 桌面版配置已被其他程序修改，ASS 未覆盖");
    // Preserve an explicitly saved policy on later model/port/token syncs.
    // Only a hash-verified ASS profile may supply this value.
    const expected = desired(token, port, providers, egressHosts ?? json(profileText)[egressKey] ?? defaultEgress);
    const next = { version: 2, id, directory: this.directory, hash: hash(expected), before: owner?.before || {
      appliedId: field(local.meta, "appliedId"), mode: field(local.settings, "deploymentMode"),
      metaExisted: local.metaText !== null, settingsExisted: local.settingsText !== null,
    } };
    const entries = local.meta.entries || [];
    let metaText = edit(local.metaText, "json", ["entries"], present(entries.some(e => e.id === id) ? entries : [...entries, { id, name: "ASS" }]));
    metaText = edit(metaText, "json", ["appliedId"], present(id));
    return { changes: [
      { file, before: profileText, after: JSON.stringify(expected, null, 2) + "\n" },
      { file: this.settingsFile, before: local.settingsText, after: edit(local.settingsText, "json", ["deploymentMode"], present("3p")) },
      { file: this.metaFile, before: local.metaText, after: metaText },
    ], owner: next };
  }
  preflightDisable() {
    const owner = this.owner();
    if (!owner) return null;
    if (owner.version === 1) {
      const current = readPolicy(this.policy);
      if (owner.hash !== hash(Object.fromEntries(names.map(name => [name, current[name]?.value]))))
        throw Error("Claude 桌面版旧策略已变化，ASS 未删除其他程序的设置");
    } else {
      this.local();
      const profileText = read(this.profileFile(owner.id));
      if (profileText !== null && localHash(json(profileText)) !== owner.hash)
        throw Error("Claude 桌面版配置已变化，ASS 未删除其他程序的设置");
    }
    return owner;
  }
  disable() {
    const owner = this.preflightDisable();
    if (!owner) return { ok: true, message: "Claude 桌面版没有 ASS 管理的接入" };
    if (owner.version === 1) return this.disableLegacy(owner);
    const plan = this.prepareDisable();
    this.commit(plan.changes, null, "Claude 桌面版本地接入关闭失败");
    return { ok: true, message: "已关闭 ASS 对 Claude 桌面版的接入，重新打开 Claude 后生效。" };
  }
  prepareDisable() {
    const owner = this.preflightDisable();
    if (!owner) return { changes: [], owner: null };
    if (owner.version === 1) throw Error("请先移除旧版 Claude 桌面策略，再切换一体化无账号接入");
    const local = this.local(), file = this.profileFile(owner.id), profileText = read(file);
    if (profileText !== null && localHash(json(profileText)) !== owner.hash)
      throw Error("Claude 桌面版配置已变化，ASS 未删除其他程序的设置");
    const selected = local.meta.appliedId === owner.id;
    let metaText = local.metaText, settingsText = local.settingsText;
    if (selected) {
      metaText = edit(metaText, "json", ["appliedId"], owner.before.appliedId);
      if (local.settings.deploymentMode === "3p") settingsText = edit(settingsText, "json", ["deploymentMode"], owner.before.mode);
    }
    if (local.meta.entries?.some(e => e.id === owner.id)) {
      const entries = local.meta.entries.filter(e => e.id !== owner.id);
      metaText = edit(metaText, "json", ["entries"], !entries.length && !owner.before.metaExisted ? { exists: false } : present(entries));
    }
    if (!owner.before.metaExisted && !Object.keys(json(metaText)).length) metaText = null;
    if (!owner.before.settingsExisted && !Object.keys(json(settingsText)).length) settingsText = null;
    return { changes: [
      { file: this.metaFile, before: local.metaText, after: metaText },
      { file: this.settingsFile, before: local.settingsText, after: settingsText },
      { file, before: profileText, after: null },
    ], owner: null };
  }
  // Included in ProxyConfig's encrypted write-ahead transaction so CLI and
  // Desktop either commit together or are both restored after failure/crash.
  plan(token, port, providers, egressHosts) {
    const result = token ? this.prepareEnable(token, port, providers, egressHosts) : this.prepareDisable();
    return [...result.changes, { file: this.file, before: read(this.file),
      after: result.owner ? JSON.stringify(result.owner, null, 2) + "\n" : null }]
      .filter(change => change.before !== change.after);
  }
  allowsFile(file) {
    return [this.file, this.metaFile, this.settingsFile].includes(file) ||
      path.dirname(file) === path.dirname(this.metaFile) && uuid.test(path.basename(file, ".json")) && path.extname(file) === ".json";
  }
  fingerprint() {
    const owner = this.owner();
    return [this.file, this.metaFile, this.settingsFile, ...(owner?.version === 2 ? [this.profileFile(owner.id)] : [])]
      .map(file => [file, read(file)]);
  }
  // Retired registry configurations are withdrawal-only; new setups use local files.
  disableLegacy(owner) {
    const current = readPolicy(this.policy);
    if (owner.hash !== hash(Object.fromEntries(names.map(name => [name, current[name]?.value]))))
      throw Error("Claude 桌面版旧策略已变化，ASS 未删除其他程序的设置");
    try {
      for (const name of names) reg(["delete", this.policy, "/v", name, "/f"]);
      fs.unlinkSync(this.file);
    } catch (error) {
      try { restorePolicy(this.policy, current); } catch {}
      throw Error("Claude 桌面版旧策略关闭失败，请检查该策略的写入权限", { cause: error });
    } finally { this.invalidate(); }
    return { ok: true, message: "已撤销旧版 ASS 策略；下次开启将使用本地配置。" };
  }
}
module.exports = { ClaudeDesktopGateway, desired, readPolicy };
