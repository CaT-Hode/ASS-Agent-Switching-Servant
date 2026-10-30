const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual: equal } = require("node:util");
const { createHash, randomUUID } = require("node:crypto");
const JSONC = require("jsonc-parser");
const YAML = require("yaml");
const managedToml = require("./toml-managed.cjs");
const zcode = require("./zcode-config.cjs");
const dsh = require("./dsh-config.cjs");
const hash = (s) =>
  createHash("sha256")
    .update(s || "")
    .digest("hex");
const absent = () => ({ exists: false });
const present = (value) => ({ exists: true, value });
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const identity = (e) =>
  JSON.stringify([path.resolve(e.file).toLowerCase(), e.path,
    e.selector ? Object.entries(e.selector).sort(([a], [b]) => a.localeCompare(b)) : null]);

function atomic(file, value) {
  safePath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, value, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    safePath(file);
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function safePath(file) {
  if (!path.isAbsolute(file)) throw Error("原生配置路径必须是绝对路径");
  let cursor = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw Error("原生配置路径包含链接，未写入");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function read(file) {
  safePath(file);
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024)
      throw Error("原生配置文件超过 8 MiB");
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function document(text, format) {
  if (format === "dsh-patch") return dsh.document(text);
  if (format === "toml") return { data: managedToml.parse(text), source: text || "" };
  const source = text === null ? "{}\n" : text.replace(/^\uFEFF/, "");
  let data, yaml;
  if (format === "yaml") {
    yaml = YAML.parseDocument(source, { uniqueKeys: true });
    if (yaml.errors.length) throw Error("原生 YAML 配置无法解析，未覆盖");
    YAML.visit(yaml, (_, node) => {
      if (YAML.isAlias(node))
        throw Error("含 YAML 别名的原生配置需手动整理后再接入");
    });
    data = yaml.toJSON();
    if (data === null && !source.trim()) {
      data = {};
      yaml = new YAML.Document({});
    }
  } else {
    const errors = [];
    const options = {
      allowTrailingComma: format === "jsonc",
      disallowComments: format !== "jsonc",
    };
    const tree = JSONC.parseTree(source, errors, options);
    if (errors.length || !tree) throw Error("原生 JSON 配置无法解析，未覆盖");
    function duplicates(node) {
      if (node.type === "object") {
        const keys = node.children.map((p) => p.children[0].value);
        if (new Set(keys).size !== keys.length)
          throw Error("原生配置含重复字段，未覆盖");
      }
      for (const child of node.children || []) duplicates(child);
    }
    duplicates(tree);
    data = JSON.parse(JSON.stringify(JSONC.getNodeValue(tree)));
  }
  if (!object(data)) throw Error("原生配置根节点必须是对象，未覆盖");
  return { data, yaml, source };
}
function valueAt(data, keys) {
  let current = data;
  for (const key of keys) {
    if (!object(current)) throw Error("原生配置字段的父节点不是对象，未覆盖");
    if (!Object.hasOwn(current, key)) return absent();
    current = current[key];
  }
  return present(current);
}
function fieldAt(data, keys, selector) {
  const field = valueAt(data, keys);
  if (!selector) return { current: field, keys };
  if (!field.exists) return { current: absent(), keys: [...keys, 0] };
  if (!Array.isArray(field.value)) throw Error("原生规则字段不是列表，未覆盖");
  const matches = field.value.flatMap((v, i) => object(v) &&
    Object.entries(selector).every(([k, expected]) => v[k] === expected) ? [i] : []);
  if (matches.length > 1) throw Error("原生规则存在重复 ID，未覆盖");
  return matches.length ? { current: present(field.value[matches[0]]), keys: [...keys, matches[0]] }
    : { current: absent(), keys: [...keys, field.value.length] };
}
function edit(text, format, keys, value, selector) {
  if (format === "dsh-patch") return dsh.edit(text, keys, value);
  if (format === "toml") return managedToml.edit(text, keys, value);
  const doc = document(text, format);
  const field = fieldAt(doc.data, keys, selector); // refuse replacing a scalar parent
  if (format === "yaml") {
    if (value.exists) doc.yaml.setIn(keys, value.value);
    else doc.yaml.deleteIn(keys);
    return doc.yaml.toString({ lineWidth: 0 });
  }
  return JSONC.applyEdits(
    doc.source,
    JSONC.modify(doc.source, field.keys, value.exists ? value.value : undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: doc.source.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
function validField(e) {
  if (
    !e ||
    !["dsh", "opencode", "pi", "kimi", "zcode"].includes(e.harness) ||
    !path.isAbsolute(e.file || "") ||
    !(e.format === "dsh-patch" ? dsh.validField(e) : e.harness === "zcode" ? zcode.validField(e) : !e.selector && (e.harness === "kimi"
      ? e.format === "toml" && managedToml.validPath(e.path) && (e.path.length === 1 ? e.replace : !e.replace) : ["json", "jsonc", "yaml"].includes(e.format))) ||
    !Array.isArray(e.path) ||
    !e.path.length ||
    e.path.some(
      (k) =>
        typeof k !== "string" ||
        !k ||
        ["__proto__", "constructor", "prototype"].includes(k),
    )
  )
    throw Error("原生配置字段记录无效");
}

// Encrypted write-ahead journal. Only owned fields are restored; whole-document
// snapshots are used solely to roll back an interrupted multi-file transaction.
class NativeFields {
  constructor(dataDir, crypto) {
    this.file = path.join(dataDir, "native-injections.enc.json");
    this.crypto = crypto;
    this.state = { entries: [], pending: null, outputTokenDefaultsVersion: 1 };
    this.error = "";
    try {
      const text = read(this.file);
      this.persistedHash = hash(text);
      if (text !== null) {
        if (!crypto.isEncryptionAvailable()) throw Error();
        const stored = JSON.parse(text);
        if (stored.version !== 1) throw Error();
        this.state = JSON.parse(
          crypto.decryptString(Buffer.from(stored.encrypted, "base64")),
        );
        if (!Array.isArray(this.state.entries)) throw Error();
        for (const e of this.state.entries) validField(e);
        if (this.state.pending) {
          const p = this.state.pending;
          if (!Array.isArray(p.files) || !Array.isArray(p.beforeEntries))
            throw Error();
          for (const e of p.beforeEntries) validField(e);
          for (const f of p.files)
            if (
              !path.isAbsolute(f.file) ||
              !(f.before === null || typeof f.before === "string") ||
              typeof f.after !== "string"
            )
              throw Error();
        }
      }
    } catch {
      this.state = { entries: [], pending: null };
      this.error = "原生接入记录损坏或无法解密，未改动客户端配置";
    }
  }
  get entries() {
    return this.state.entries;
  }
  save(state) {
    if (this.state.outputTokenDefaultsVersion === 1) state = { ...state, outputTokenDefaultsVersion: 1 };
    if (!this.crypto.isEncryptionAvailable())
      throw Error("系统凭据加密不可用，未写入原生配置");
    this.checkJournal();
    safePath(this.file);
    const serialized = JSON.stringify(state);
    const encoded = JSON.stringify({
      version: 1,
      encrypted: this.crypto.encryptString(serialized).toString("base64"),
    });
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
      throw Error("原生配置恢复记录超过 8 MiB，未继续写入");
    atomic(this.file, encoded);
    this.persistedHash = hash(encoded);
    this.state = JSON.parse(serialized);
  }
  checkJournal() {
    if (this.error) throw Error(this.error);
    if (hash(read(this.file)) !== this.persistedHash)
      throw Error("原生接入记录被外部修改，请重启 ASS 后重新检查");
  }
  recoveryCheck() {
    this.checkJournal();
    for (const f of this.state.pending?.files || []) {
      const now = read(f.file);
      if (now !== f.before && now !== f.after)
        throw Error(
          "未完成的原生接入事务遇到外部修改，请保留恢复记录并检查配置",
        );
    }
  }
  recover() {
    this.recoveryCheck();
    const p = this.state.pending;
    if (!p) return;
    for (const f of [...p.files].reverse()) {
      const now = read(f.file);
      if (now === f.before) continue;
      if (now !== f.after) throw Error("恢复期间原生配置被修改，已停止");
      if (f.before === null) fs.unlinkSync(f.file);
      else atomic(f.file, f.before);
    }
    this.save({ entries: p.beforeEntries, pending: null });
  }
  plan(harness, desired = [], { repair = false } = {}) {
    this.recoveryCheck();
    if (this.state.pending) throw Error("原生接入事务待恢复，请点击重新同步");
    const previous = this.entries.filter((e) => e.harness === harness);
    const before = new Map(previous.map((e) => [identity(e), e]));
    const requested = new Map();
    for (const d of desired) {
      validField(d);
      if (d.harness !== harness || requested.has(identity(d)))
        throw Error("原生配置字段重复或客户端不匹配");
      requested.set(identity(d), d);
    }
    // Repair is not a force-sync: it may only reapply the exact, previously
    // confirmed fields. Never claim a new field or apply a pending draft here.
    if (repair && (!previous.length || requested.size !== before.size ||
        [...requested].some(([id, d]) => !before.has(id) || !equal(present(d.value), before.get(id).after))))
      throw Error("没有可信的已接入字段可供修复");
    const files = new Map(),
      entries = this.entries.filter((e) => e.harness !== harness);
    for (const id of new Set([...before.keys(), ...requested.keys()])) {
      const old = before.get(id),
        next = requested.get(id),
        e = next || old;
      let file = files.get(e.file);
      if (!file) {
        const text = read(e.file);
        file = { file: e.file, before: text, after: text, format: e.format };
        if (repair && harness === "dsh" && previous.some((p) => p.file === e.file && p.credentialProvider)) {
          const version = document(text, e.format).data.version;
          if (version !== undefined && version !== 1) throw Error("DSH 凭据格式版本已变化，请先用 DSH 完成升级，未强制修复");
        }
        if (harness === "zcode") {
          if (text === null) file.after = JSON.stringify(zcode.empty(), null, 2) + "\n";
          else zcode.validate(document(text, "json").data);
        }
        files.set(e.file, file);
      }
      const { current } = fieldAt(document(file.after, e.format).data, e.path, e.selector);
      if (old && !equal(current, old.after) && !repair)
        throw Error(
          `原生配置的 ASS 字段已被外部修改：${path.basename(e.file)} · ${e.path.join(" / ")}`,
        );
      if (!old && current.exists && !next.replace)
        throw Error(
          `原生配置已有同名字段：${path.basename(e.file)} · ${e.path.join(" / ")}`,
        );
      const target = next ? present(next.value) : old.before;
      if (!equal(current, target))
        file.after = edit(file.after, e.format, e.path, target, e.selector);
      else if (old && e.format === "toml")
        managedToml.assertOwned(file.after, e.path);
      if (next && (!next.renameOnly || old)) {
        const { value: _, before: __, after: ___, renameOnly: _renameOnly, ...metadata } = next;
        entries.push({
          ...metadata,
          before: old ? old.before : current,
          after: target,
        });
      }
    }
    if (harness === "zcode") for (const file of files.values()) {
      const next = document(file.after, "json").data;
      zcode.validate(next);
      if (file.before !== null) zcode.assertDefaultPreserved(document(file.before, "json").data, next);
    }
    if (harness === "kimi") for (const file of files.values()) {
      const current = document(file.before, "toml").data, next = document(file.after, "toml").data;
      if (previous.some((e) => e.file === file.file && e.path[0] === "models" && e.path[1] === current.default_model) &&
          !Object.hasOwn(next.models || {}, next.default_model))
        throw Error("Kimi 默认模型仍属于待移除的供应商，请先在 Kimi 切换模型");
    }
    return {
      entries,
      files: [...files.values()].filter((f) => f.before !== f.after),
    };
  }
  apply(harness, desired = []) {
    this.recover();
    const plan = this.plan(harness, desired);
    this.commit(plan);
  }
  repairPlan(harness) {
    const desired = this.entries.filter((e) => e.harness === harness)
      .map((e) => ({ ...e, value: e.after.value }));
    return this.plan(harness, desired, { repair: true });
  }
  relocationPlan(harness, relocations) {
    this.recoveryCheck();
    if (this.state.pending) throw Error("原生接入事务待恢复，请先重新同步");
    const files = new Map(), entries = [...this.entries];
    const fileAt = (file, format) => {
      if (!files.has(file)) { const text = read(file); files.set(file, { file, format, before: text, after: text }); }
      return files.get(file);
    };
    for (const { from, to } of relocations) {
      const index = entries.findIndex((e) => identity(e) === identity(from));
      if (index < 0 || entries[index].harness !== harness || !equal(entries[index], from)) throw Error("迁移的原接入记录已变化");
      validField(to);
      if (to.harness !== harness || identity(from) === identity(to) || entries.some((e) => identity(e) === identity(to)))
        throw Error("迁移目标重复或不属于当前客户端");
      const source = fileAt(from.file, from.format), target = fileAt(to.file, to.format);
      const current = fieldAt(document(source.after, from.format).data, from.path, from.selector).current;
      if (current.exists && !equal(current, from.after)) throw Error("旧版 DSH 的受管字段已改变，请先确认旧配置");
      // DSH may already have renamed the legacy file at boot. The encrypted
      // ownership record remains authoritative; never restore or rewrite its archive.
      if (!current.exists && source.before !== null) {
        const archived = read(from.file + ".imported");
        if (archived === null || !equal(fieldAt(document(archived, from.format).data, from.path).current, from.after))
          throw Error("旧版 DSH 字段缺失且没有一致的导入记录，未迁移");
      }
      const next = fieldAt(document(target.after, to.format).data, to.path, to.selector).current;
      if (next.exists && !equal(next, from.after)) throw Error("新版 DSH 中已有不同的同名供应商，未覆盖");
      if (!equal(next, from.after)) target.after = edit(target.after, to.format, to.path, from.after, to.selector);
      if (current.exists) source.after = edit(source.after, from.format, from.path, from.before, from.selector);
      entries[index] = { ...from, file: to.file, format: to.format, path: to.path };
    }
    return { entries, files: [...files.values()].filter((f) => f.before !== f.after) };
  }
  relocate(harness, relocations) {
    const plan = this.relocationPlan(harness, relocations);
    this.backup(harness, plan, "migration");
    this.commit(plan);
    return { files: plan.files.length, migrated: true };
  }
  backup(harness, plan, kind = "repair") {
    if (!this.crypto.isEncryptionAvailable()) throw Error("系统凭据加密不可用，未修复配置");
    const backup = path.join(path.dirname(this.file), "backups", `native-${kind}-${harness}-${Date.now()}-${randomUUID()}.enc.json`);
    const payload = JSON.stringify({ kind: "native-" + kind, harness, createdAt: new Date().toISOString(),
      entries: this.entries.filter((e) => e.harness === harness),
      files: plan.files.map((f) => ({ file: f.file, before: f.before })) });
    const encoded = JSON.stringify({ version: 1, encrypted: this.crypto.encryptString(payload).toString("base64") });
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw Error("修复备份超过 32 MiB，未改动配置");
    atomic(backup, encoded);
    return backup;
  }
  repair(harness) {
    const plan = this.repairPlan(harness);
    if (!plan.files.length) throw Error("受管字段已经一致，无需修复");
    // Save the externally edited version before touching any client file.
    const backup = this.backup(harness, plan);
    this.commit(plan);
    return { backup, files: plan.files.length };
  }
  commit(plan) {
    if (!plan.files.length && equal(this.entries, plan.entries)) return;
    for (const f of plan.files)
      if (read(f.file) !== f.before) throw Error("原生配置在写入前被修改，已停止");
    const pending = { beforeEntries: this.entries, files: plan.files };
    this.save({ entries: this.entries, pending });
    try {
      for (const f of plan.files) {
        if (read(f.file) !== f.before)
          throw Error("原生配置在写入前被修改，已停止");
        atomic(f.file, f.after);
      }
      this.save({ entries: plan.entries, pending: null });
    } catch (e) {
      try {
        this.recover();
      } catch {
        throw Error(
          "原生配置未完成同步；已保留加密恢复记录，存在外部修改时不会覆盖",
        );
      }
      throw e;
    }
  }
  fingerprint(harness) {
    return hash(
      JSON.stringify([
        this.state,
        read(this.file),
        this.entries
          .filter((e) => e.harness === harness)
          .map((e) => [e.file, read(e.file)]),
      ]),
    );
  }
  owns(harness, file, provider) {
    return this.entries.some((e) => {
      if (
        e.harness !== harness ||
        e.credentialProvider !== provider ||
        path.resolve(e.file).toLowerCase() !==
          path.resolve(file || ".").toLowerCase()
      )
        return false;
      try {
        return equal(
          fieldAt(document(read(e.file), e.format).data, e.path, e.selector).current,
          e.after,
        );
      } catch {
        return false;
      }
    });
  }
  ownsModel(harness, dir, provider) {
    const entries = this.entries.filter(e => e.harness === harness &&
      path.resolve(path.dirname(e.file)).toLowerCase() === path.resolve(dir).toLowerCase() &&
      (e.credentialProvider === provider || e.path.includes(provider) || Object.values(e.selector || {}).includes(provider)));
    if (!entries.some(e => e.credentialProvider === provider)) return false;
    return entries.every(e => {
      try { return equal(fieldAt(document(read(e.file), e.format).data, e.path, e.selector).current, e.after); }
      catch { return false; }
    });
  }
}
module.exports = { NativeFields, document, edit, read, hash, safePath, atomic };
