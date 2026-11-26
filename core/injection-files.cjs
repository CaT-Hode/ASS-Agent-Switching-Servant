const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomic } = require("./config.cjs");
const { ids: clientIds } = require("./client-registry.cjs");
const IDS = clientIds("legacyProxy");
const NAMES = new Set(["config.toml", "catalog.json", "models.json", "settings.yaml", "settings.json"]);
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
class InjectionFiles {
  constructor(dataDir) {
    this.root = path.resolve(dataDir);
    this.file = path.join(this.root, "route-injections.json");
    this.entries = [];
    this.error = "";
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 16 * 1024 * 1024) throw Error();
        const entries = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (!Array.isArray(entries) || entries.length > 2000) throw Error();
        for (const e of entries) {
          if (!IDS.includes(e.harness) || !/^[a-f0-9]{64}$/.test(e.after) ||
              !(e.before === null || typeof e.before === "string")) throw Error();
          this.target(e.relative, e.harness);
        }
        this.entries = entries;
      }
    } catch { this.error = "注入恢复记录损坏，已禁止覆盖和自动清理，请保留数据目录并检查"; }
  }
  target(relative, harness) {
    if (typeof relative !== "string") throw Error("无效注入路径");
    const parts = relative.replaceAll("\\", "/").split("/");
    if (parts.length !== 4 || parts[0] !== "clients" || parts[1] !== harness ||
        !IDS.includes(harness) || !/^[a-f0-9]{24}$/.test(parts[2]) || !NAMES.has(parts[3]))
      throw Error("注入路径不在 ASS 独立账户目录内");
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw Error("注入目录包含链接，拒绝写入或清理");
    }
    return current;
  }
  save() { atomic(this.file, JSON.stringify(this.entries)); }
  list(ids) {
    if (this.error) throw Error(this.error);
    return this.entries.filter((e) => ids.includes(e.harness));
  }
  preflight(ids) {
    for (const e of this.list(ids)) {
      const file = this.target(e.relative, e.harness);
      if (fs.existsSync(file) && hash(fs.readFileSync(file)) !== e.after)
        throw Error("注入文件已被外部修改，未覆盖：" + e.relative);
    }
  }
  write(harness, plan) {
    if (this.error) throw Error(this.error);
    this.preflight([harness]);
    for (const [name, content] of plan.files) {
      const relative = path.relative(this.root, path.join(plan.dir, name)).replaceAll("\\", "/");
      const file = this.target(relative, harness);
      let entry = this.entries.find((e) => e.relative === relative);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (!entry) {
        entry = { harness, relative, before, after: hash(content) };
        this.entries.push(entry);
      } else entry.after = hash(content);
      // Record before writing; a crash or disk error leaves a visible conflict, never guessed cleanup.
      this.save();
      atomic(file, content);
    }
  }
  restore(ids) {
    this.preflight(ids);
    const selected = this.list(ids);
    for (const e of selected) {
      const file = this.target(e.relative, e.harness);
      if (fs.existsSync(file) && hash(fs.readFileSync(file)) !== e.after)
        throw Error("恢复期间注入文件被修改，已停止后续清理：" + e.relative);
      if (e.before === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file); // Exact allowlisted generated file, never a directory.
      } else atomic(file, e.before);
      this.entries = this.entries.filter((x) => x !== e);
      this.save();
    }
    return selected.length;
  }
  fingerprint(ids) {
    return hash(JSON.stringify(this.list(ids).map((e) => {
      const f = this.target(e.relative, e.harness);
      return [e.relative, fs.existsSync(f) ? hash(fs.readFileSync(f)) : null];
    })));
  }
}
module.exports = { InjectionFiles, IDS, hash };
