// Local OAuth history only. Credentials never cross the renderer boundary.
// Native clients still perform login/refresh; ASS never refreshes or revokes grants.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const TOML = require("@iarna/toml");
const { read, document, edit, atomic, hash } = require("./native-fields.cjs");
const { credentialFile, parseRecords } = require("./credential-status.cjs");
const additional = require("./additional-oauth.cjs");
const SUPPORTED = new Set(["codex", "claude", "pi", ...additional.SUPPORTED]);
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const has = (v) => typeof v === "string" && v.length > 0;
const key = (file) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const stamp = (v) => hash(JSON.stringify(v));
const sourceFile = (source) => additional.SUPPORTED.has(source.harness)
  ? additional.sourceFile(source) : credentialFile(source.harness, source.dir, true);
function json(file) {
  const text = read(file);
  if (text?.length > 2 * 1024 * 1024) throw Error("OAuth 文件过大，未读取");
  return { file, text, data: document(text, "json").data };
}
function jwt(token) {
  try {
    if (typeof token !== "string" || token.length > 65536 || token.split(".").length !== 3) return {};
    const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    return object(value) ? value : {};
  } catch { return {}; }
}
function identity(harness, provider, grant) {
  // Claims identify local records, not proof of validity. Include person AND
  // workspace: two people in one ChatGPT workspace must never overwrite each other.
  if (provider === "openai" || provider === "openai-codex") {
    const id = jwt(grant.id_token), access = jwt(grant.access_token || grant.access);
    const a = id["https://api.openai.com/auth"] || {}, b = access["https://api.openai.com/auth"] || {};
    const account = grant.account_id || grant.accountId || a.chatgpt_account_id || b.chatgpt_account_id;
    if ([a.chatgpt_account_id, b.chatgpt_account_id].some((v) => v && account && v !== account))
      throw Error("OAuth 工作区与令牌不一致，未记录");
    const idUser = a.chatgpt_user_id || a.user_id, accessUser = b.chatgpt_user_id || b.user_id;
    if (idUser && accessUser && idUser !== accessUser) throw Error("OAuth 用户与令牌不一致，未记录");
    const user = a.chatgpt_user_id || a.user_id || b.chatgpt_user_id || b.user_id || id.sub || access.sub || id.email || access["https://api.openai.com/profile"]?.email;
    if (has(account) && has(user)) return stamp([harness, provider, account, user]);
  } else {
    const user = grant.accountId || grant.account?.uuid || grant.email;
    if (has(user)) return stamp([harness, provider, user, grant.organization?.uuid || grant.projectId || ""]);
  }
  return null; // Do not pretend an opaque rotating token identifies a person.
}
function readSource(source, options) {
  const { harness, dir } = source;
  if (!SUPPORTED.has(harness)) throw Error("此客户端不支持 OAuth 账户切换");
  if (additional.SUPPORTED.has(harness)) return additional.readSource(source, options);
  let config = {}, configText = null;
  if (harness === "codex") {
    configText = read(path.join(dir, "config.toml"));
    try { config = configText ? TOML.parse(configText.replace(/^\uFEFF/, "")) : {}; }
    catch { throw Error("Codex 配置无法解析，未读取 OAuth"); }
    if (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== "file")
      throw Error("Codex 使用密钥库、自动存储或内存凭据，不能通过文件切换");
  }
  const auth = json(credentialFile(harness, dir, true));
  const parts = [auth];
  let metadata;
  if (harness === "claude") {
    const local = path.join(dir, ".claude.json"), adjacent = path.join(path.dirname(dir), ".claude.json");
    const file = source.native !== false && path.basename(dir).toLowerCase() === ".claude" && !fs.existsSync(local) ? adjacent : local;
    metadata = json(file);
    parts.push(metadata);
  }
  const modified = auth.text === null ? 0 : fs.statSync(auth.file).mtimeMs;
  const rows = parseRecords(harness, auth.data, Date.now(), {
    savedAt: modified,
    claudeIdentity: metadata?.data.oauthAccount,
  });
  const grants = rows.filter((r) => r.authType === "oauth").flatMap((row) => {
    if (harness === "codex" && auth.data.auth_mode && auth.data.auth_mode !== "chatgpt") return [];
    const grant = harness === "codex" ? auth.data.tokens : harness === "claude" ? auth.data.claudeAiOauth : auth.data[row.provider];
    if (!object(grant) || !has(grant.access_token || grant.accessToken || grant.access)) return [];
    const stableIdentity = identity(harness, row.provider, grant);
    return [{ row, grant, identity: stableIdentity,
      // A stable refresh grant can tie access-token refreshes together even when
      // the provider supplies no identity. Rotated opaque grants stay separate.
      grantKey: stamp([harness, row.provider, grant.refresh_token || grant.refreshToken || grant.refresh || grant.access_token || grant.accessToken || grant.access]),
      metadata: object(metadata?.data.oauthAccount) &&
        (!(grant.accountId || grant.account?.uuid) || (grant.accountId || grant.account?.uuid) === metadata.data.oauthAccount.accountUuid)
        ? metadata.data.oauthAccount : undefined,
      lastRefresh: harness === "codex" ? auth.data.last_refresh : undefined,
    }];
  });
  return { source, auth, parts, config, grants, modified,
    fingerprint: stamp([parts.map((p) => [p.file, p.text]), configText]) };
}

class OAuthHistory {
  constructor({ dataDir, crypto: encryption, sources, target, allows = () => true, onChange = () => {},
    now = Date.now, refresh, external = {} }) {
    Object.assign(this, { encryption, sources, target, allows, onChange, now, refresh, external });
    this.file = path.join(dataDir, "oauth-history.enc.json");
    this.entries = [];
    this.observed = new Map();
    this.pending = new Map();
    this.tickets = new Map();
    this.errors = {};
    this.error = "";
    try {
      const value = read(this.file);
      if (value !== null) {
        if (value.length > 16 * 1024 * 1024) throw Error();
        const outer = JSON.parse(value);
        if (outer.version !== 1 || typeof outer.secret !== "string") throw Error();
        const data = JSON.parse(encryption.decryptString(Buffer.from(outer.secret, "base64")));
        if (!Array.isArray(data.entries) || data.entries.some((e) => !/^[a-f0-9]{24}$/.test(e.id) || !SUPPORTED.has(e.harness) || !object(e.grant))) throw Error();
        this.entries = data.entries;
        if (data.transaction) this.recover(data.transaction);
      }
    } catch { this.error = "OAuth 历史无法解密或已损坏，未覆盖；请检查 ASS 数据目录"; }
  }
  persist(entries, transaction) {
    if (this.error) throw Error(this.error);
    if (!this.encryption.isEncryptionAvailable()) throw Error("系统加密不可用，未保存 OAuth");
    const secret = this.encryption.encryptString(JSON.stringify({ entries, transaction })).toString("base64");
    if (secret.length > 16 * 1024 * 1024 - 256) throw Error("OAuth 历史超过容量限制，未覆盖已有历史");
    atomic(this.file, JSON.stringify({ version: 1, secret }));
    this.entries = entries;
  }
  recover(transaction) {
    if (!Array.isArray(transaction) || transaction.length > 2 || !transaction.length ||
      transaction.some((w) => !path.isAbsolute(w.file) || typeof w.after !== "string" ||
        (w.before !== null && typeof w.before !== "string") ||
        (w.external !== undefined && (!this.external[w.external] || typeof this.external[w.external].read !== "function" ||
          typeof this.external[w.external].write !== "function")))) throw Error();
    const releases = [];
    try {
      for (const w of transaction) {
        if (w.lock === "zcode") releases.push(additional.lock(w.file));
        if (w.lock === "pi") releases.push(require('./pi-auth-lock.cjs').lock(w.file));
      }
      for (const release of releases) release.assert?.();
      this.recoverLocked(transaction);
    } finally { for (const release of releases.reverse()) release(); }
  }
  recoverLocked(transaction) {
    // A crashed multi-file switch is reversible only while every file still
    // equals our before/after image. Never roll back a subsequent native login.
    for (const w of transaction) if (![w.before, w.after].includes(this.targetRead(w))) throw Error();
    for (const w of [...transaction].reverse()) {
      if (this.targetRead(w) !== w.after) continue;
      this.targetWrite(w, w.before);
    }
    this.persist(this.entries);
  }
  targetRead(write) {
    try { return write.external ? this.external[write.external].read() : read(write.file); }
    catch { throw Error("原生 OAuth 凭据无法读取"); }
  }
  targetWrite(write, value) {
    if (write.external) return this.external[write.external].write(value);
    if (value === null) fs.unlinkSync(write.file); else atomic(write.file, value);
  }
  capture(state) {
    let entries = this.entries.slice(), changed = false;
    const ids = {};
    for (const g of state.grants) {
      if (!this.allows(state.source.harness, g.row.provider)) continue;
      const previous = entries.find((e) => e.harness === state.source.harness && e.provider === g.row.provider &&
        (g.identity ? e.identity === g.identity : e.grantKey === g.grantKey));
      const id = previous?.id || crypto.randomBytes(12).toString("hex");
      ids[g.row.provider] = id;
      const fingerprint = stamp([g.grant, g.metadata, g.lastRefresh, g.query]);
      if (previous?.fingerprint === fingerprint) continue;
      // Another native/isolated directory can contain an older copy of this user.
      if (previous && state.source.harness !== "antigravity" &&
          state.modified < previous.sourceModified && previous.sourceFile !== key(state.auth.file)) continue;
      const entry = { id, harness: state.source.harness, provider: g.row.provider,
        identity: g.identity, grantKey: g.grantKey, grant: g.grant,
        metadata: g.metadata, lastRefresh: g.lastRefresh, profile: g.row.profile, query: g.query,
        fingerprint, firstSeenAt: previous?.firstSeenAt || new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(), sourceModified: state.modified, sourceFile: key(state.auth.file) };
      entries = entries.filter((e) => e.id !== id).concat(entry);
      changed = true;
    }
    if (changed) this.persist(entries);
    this.observed.set(key(state.auth.file), { fingerprint: state.fingerprint, ids,
      policy: stamp(state.grants.map((g) => [g.row.provider, this.allows(state.source.harness, g.row.provider)])) });
    return changed;
  }
  scan({ immediate = false } = {}) {
    const before = stamp([this.entries.map((e) => [e.id, e.fingerprint]), this.errors, [...this.observed]]);
    this.errors = {};
    const live = new Set();
    for (const source of this.sources()) {
      if (!SUPPORTED.has(source.harness)) continue;
      const fileKey = key(sourceFile(source));
      live.add(fileKey);
      try {
        if (this.error) throw Error(this.error);
        const state = readSource(source);
        const policy = stamp(state.grants.map((g) => [g.row.provider, this.allows(source.harness, g.row.provider)]));
        if (this.observed.get(fileKey)?.fingerprint === state.fingerprint && this.observed.get(fileKey)?.policy === policy) continue;
        const pending = this.pending.get(fileKey);
        this.pending.set(fileKey, { fingerprint: state.fingerprint, at: pending?.fingerprint === state.fingerprint ? pending.at : this.now() });
        if (!immediate && (pending?.fingerprint !== state.fingerprint || this.now() - pending.at < 750)) continue;
        if (readSource(source).fingerprint !== state.fingerprint) continue;
        this.capture(state);
        this.pending.delete(fileKey);
      } catch (e) {
        // No payloads, paths containing credentials, or parser excerpts in UI/logs.
        this.errors[source.harness] = this.error || "部分 OAuth 未能记录：凭据不可读、存储方式不支持或系统加密不可用";
        this.observed.delete(fileKey);
      }
    }
    for (const k of this.observed.keys()) if (!live.has(k)) this.observed.delete(k);
    for (const k of this.pending.keys()) if (!live.has(k)) this.pending.delete(k);
    const changed = before !== stamp([this.entries.map((e) => [e.id, e.fingerprint]), this.errors, [...this.observed]]);
    if (changed) this.onChange();
    return changed;
  }
  start() {
    if (this.timer) return;
    this.scanSafe({ immediate: true });
    this.timer = setInterval(() => this.scanSafe(), 2000);
    this.timer.unref?.();
    if (this.refresh) {
      this.refreshTimer = setInterval(() => this.refreshExternal(), 10000);
      this.refreshTimer.unref?.();
    }
  }
  scanSafe(options) {
    try { return this.scan(options); }
    catch {
      // A native app can replace its files/install directory during update.
      // Retry at the next tick; never let a discovery failure terminate ASS.
      this.errors.scan = '原生账户扫描暂时失败，已保留现有记录，将自动重试';
      return false;
    }
  }
  async refreshExternal() {
    if (!this.refresh || this.refreshing) return;
    this.refreshing = true;
    try { await this.refresh(); this.scan({ immediate: true }); }
    catch { /* Keep encrypted history and the last readable snapshot. */ }
    finally { this.refreshing = false; }
  }
  stop() { clearInterval(this.timer); clearInterval(this.refreshTimer); this.timer = this.refreshTimer = null; }
  lookup(harness, id) {
    if (!SUPPORTED.has(harness)) throw Error("此客户端不支持 OAuth 账户切换");
    const entry = this.entries.find((e) => e.harness === harness && e.id === id);
    if (!entry || !this.allows(harness, entry.provider)) throw Error("OAuth 账户不存在或客户端不支持此授权");
    return entry;
  }
  inspect(harness, entry) {
    if (this.error) throw Error(this.error);
    const source = this.target(harness, entry.provider);
    if (!source || source.harness !== harness) throw Error("无法确定客户端凭据目录");
    if (source.blocked) throw Error(source.blocked);
    const state = readSource(source, { fresh: harness === "antigravity" }), data = state.auth.data;
    if (harness === "codex") {
      if (state.config.forced_login_method === "api") throw Error("Codex 已限定使用 API Key，未切换");
      if (state.config.forced_chatgpt_workspace_id && entry.profile?.fields.find((f) => f.id === "accountId")?.value !== state.config.forced_chatgpt_workspace_id)
        throw Error("目标账户不符合 Codex 工作区限制，未切换");
      if (data.auth_mode && data.auth_mode !== "chatgpt") throw Error("当前不是 ChatGPT OAuth 登录，未覆盖");
      if (has(data.OPENAI_API_KEY)) throw Error("当前凭据含 API Key，未覆盖");
    }
    if (harness === "pi" && data[entry.provider] && data[entry.provider].type !== "oauth")
      throw Error("此服务当前使用 API Key 或其他凭据，未覆盖");
    return state;
  }
  publicEntry(e) {
    const data = e.harness === "codex" ? { tokens: e.grant } : e.harness === "claude" ? { claudeAiOauth: e.grant } : { [e.provider]: e.grant };
    const row = additional.SUPPORTED.has(e.harness) ? additional.publicGrant(e.harness, e.provider, e.grant) : parseRecords(e.harness, data)[0];
    return { id: "oauth-history:" + e.id, oauthRecordId: e.id, kind: "oauth-history",
      provider: e.provider, authType: "oauth", badge: "OAuth", source: "已保存账户",
      label: row.label || (e.harness === "codex" ? "ChatGPT" : e.provider),
      profile: e.profile, ready: row.ready, status: row.status, message: row.message, expiresAt: row.expiresAt,
      firstSeenAt: e.firstSeenAt, updatedAt: e.updatedAt, identityKnown: !!e.identity };
  }
  decorate(client) {
    if (!SUPPORTED.has(client.id)) return;
    const records = this.entries.filter((e) => e.harness === client.id && this.allows(client.id, e.provider));
    const sources = this.sources();
    const current = new Map();
    for (const a of client.accounts) {
      const accountSource = a.oauthHistorySource || a.sourcePath;
      if (a.authType !== "oauth" || !accountSource || !path.isAbsolute(accountSource)) continue;
      try {
        const source = sources.find((s) => s.harness === client.id && key(sourceFile(s)) === key(accountSource));
        if (!source) continue;
        const observed = this.observed.get(key(accountSource));
        if (!observed || observed.fingerprint !== readSource(source).fingerprint) continue;
        const id = observed.ids[a.oauthHistoryProvider || a.provider || a.oauthProvider];
        if (!id || !records.some((e) => e.id === id)) continue;
        a.oauthRecordId = id;
        const saved = records.find((e) => e.id === id);
        a.updatedAt = saved?.updatedAt;
        let target;
        try { target = this.target(client.id, saved.provider); } catch {}
        a.oauthCurrent = !!target && key(sourceFile(source)) === key(sourceFile(target)) && !target.blocked;
        current.set(id, true);
      } catch {}
    }
    client.accounts.push(...records.filter((e) => !current.has(e.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((e) => this.publicEntry(e)));
    const seen = new Map();
    for (const a of client.accounts) if (a.oauthRecordId) {
      const old = seen.get(a.oauthRecordId);
      if (!old || a.oauthCurrent && !old.oauthCurrent || !old.oauthCurrent && a.id === client.selected) seen.set(a.oauthRecordId, a);
    }
    for (const a of client.accounts) if (a.oauthRecordId && a.id === client.selected) client.selected = seen.get(a.oauthRecordId).id;
    client.accounts = client.accounts.filter((a) => !a.oauthRecordId || seen.get(a.oauthRecordId) === a);
    client.oauthHistoryError = this.error || this.errors[client.id] || "";
  }
  preview(harness, id) {
    this.scan({ immediate: true });
    const entry = this.lookup(harness, id), state = this.inspect(harness, entry);
    if (!this.publicEntry(entry).ready) throw Error("已保存授权已到期，需要重新登录");
    if (harness === 'pi' && require('./pi-auth-lock.cjs').busy(state.auth.file)) throw Error('Pi 正在读写或刷新登录，请稍后重新确认切换');
    for (const [k, t] of this.tickets) if (t.expires < this.now()) this.tickets.delete(k);
    if (this.tickets.size > 20) this.tickets.clear();
    const ticket = crypto.randomBytes(24).toString("hex");
    this.tickets.set(ticket, { harness, id, fingerprint: state.fingerprint, revision: entry.fingerprint,
      target: key(state.auth.file), expires: this.now() + 120000 });
    const f = entry.profile?.fields || [];
    return { ticket, harness, label: f.find((v) => v.id === "email")?.value || f.find((v) => v.id === "name")?.value || this.publicEntry(entry).label,
      target: state.source.storage === "keyring" ? "Windows 凭据管理器 · gemini:antigravity" : state.auth.file };
  }
  apply(ticket, confirmed) {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (confirmed !== true || !t || t.expires < this.now()) throw Error("切换确认已失效，请重新选择账户");
    const entry = this.lookup(t.harness, t.id), state = this.inspect(t.harness, entry);
    const release = t.harness === "zcode" ? additional.lock(state.auth.file) : t.harness === "pi" ? require('./pi-auth-lock.cjs').lock(state.auth.file) : () => {};
    try { return this.applyLocked(t, entry, state, release.assert); } finally { release(); }
  }
  applyLocked(t, entry, state, assertLock = () => {}) {
    if (!this.publicEntry(entry).ready) throw Error("已保存授权已到期，需要重新登录");
    const check = () => {
      assertLock();
      const latest = this.inspect(t.harness, entry);
      if (latest.fingerprint !== t.fingerprint || key(latest.auth.file) !== t.target || entry.fingerprint !== t.revision)
        throw Error("登录信息已变化，请重新确认切换");
    };
    check();
    // Durably preserve the current login before any native write. Encryption
    // failure stops the operation. Only this provider's fields are replaced.
    this.capture(state);
    let text = state.auth.text;
    const set = (field, value) => { text = edit(text, "json", [field], value === undefined ? { exists: false } : { exists: true, value }); };
    if (t.harness === "codex") {
      set("auth_mode", "chatgpt"); set("tokens", entry.grant); set("last_refresh", entry.lastRefresh);
    } else if (t.harness === "claude") set("claudeAiOauth", entry.grant);
    else if (t.harness === "pi") set(entry.provider, entry.grant);
    const writes = additional.SUPPORTED.has(t.harness) ? additional.writes(state, entry) : [{ ...state.auth, after: text, lock: t.harness === "pi" ? "pi" : undefined }];
    if (t.harness === "claude") {
      const meta = state.parts[1];
      writes.push({ ...meta, after: edit(meta.text, "json", ["oauthAccount"], entry.metadata ? { exists: true, value: entry.metadata } : { exists: false }) });
    }
    // Synchronous, compare-before-write. Never restart a client or remove locks.
    check();
    this.persist(this.entries, writes.map((w) => ({ file: w.file, before: w.text, after: w.after,
      lock: w.lock, ...(w.external ? { external: w.external } : {}) })));
    const done = [];
    try {
      for (const w of writes) {
        assertLock();
        if (this.targetRead(w) !== w.text) throw Error("登录信息已变化，请重新确认切换");
        this.targetWrite(w, w.after);
        w.afterWrite?.(w.after);
        done.push(w);
      }
      this.persist(this.entries);
    } catch {
      let conflict = false;
      for (const w of done.reverse()) {
        try {
          if (this.targetRead(w) !== w.after) { conflict = true; continue; }
          assertLock();
          this.targetWrite(w, w.text);
          w.afterWrite?.(w.text);
        } catch { conflict = true; }
      }
      if (!conflict) {
        try { this.persist(this.entries); } catch { conflict = true; }
      }
      if (conflict) this.error = "上次 OAuth 切换未完整恢复，旧登录已加密保存；请检查 ASS 数据目录";
      throw Error(conflict ? this.error : "切换失败，原登录已保留，请重试");
    }
    this.scan({ immediate: true });
    return { ok: true, message: "OAuth 凭据已切换；新会话使用此账户。已运行的客户端可能需要自行重启。" };
  }
}
module.exports = { OAuthHistory, readSource, identity };
