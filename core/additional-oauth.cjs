// File-backed OAuth adapters only. Native clients own login and refresh.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { read, document, edit, hash, safePath } = require("./native-fields.cjs");
const { text, claims } = require("./account-info.cjs");
const zcodeInfo = require("./zcode-account-info.cjs");
const antigravity = require("./antigravity-status.cjs");
const SUPPORTED = new Set(["kimi", "zcode", "antigravity"]);
const has = (v) => typeof v === "string" && !!v.trim();
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const stamp = (v) => hash(JSON.stringify(v));
const KIMI_FIELDS = ["access_token", "refresh_token", "expires_at", "scope", "token_type", "expires_in"];
function part(file, format = "json") {
  const value = read(file);
  if (value?.length > 2 * 1024 * 1024) throw Error("OAuth 文件过大，未读取");
  return { file, text: value, data: document(value, format).data };
}
function status(access, refresh, seconds, now = Date.now()) {
  const n = Number(seconds), expiresAt = Number.isFinite(n) && n > 0 && n < 8.64e12 ? n * 1000 : null;
  const expired = expiresAt !== null && expiresAt <= now;
  return { authType: "oauth", ready: has(access) && (!expired || has(refresh)), expiresAt,
    status: !has(access) ? "incomplete" : expired ? has(refresh) ? "refresh-required" : "expired" : "detected",
    message: !has(access) ? "OAuth 凭据不完整" : expired ? has(refresh) ? "访问令牌已到期 · 由客户端刷新" : "授权已到期 · 需要重新登录" : "OAuth" };
}
function endpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && !u.search && !u.hash
      ? u.origin + u.pathname.replace(/\/+$/, "") : "";
  } catch { return ""; }
}
function kimiReference(dir, provider) {
  if (!object(provider?.oauth) || has(provider.api_key) || has(provider.api_key_env)) return null;
  const ref = provider.oauth;
  if ((ref.storage || "file") !== "file") return null;
  const slot = typeof ref.key === "string" && ref.key.startsWith("oauth/") ? ref.key.slice(6) : ref.key;
  if (!has(slot) || slot.startsWith(".") || /[/\\:\x00-\x1f]/.test(slot) || slot.length > 160) return null;
  const base = endpoint(provider.base_url);
  if (!["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"].includes(base)) return null;
  // Native references persist the region's OAuth host. The unqualified legacy
  // slot means CN; never move a CN grant into a Global/custom authorization host.
  const host = endpoint(ref.oauthHost || "https://auth.kimi.com");
  if (host !== (base.includes("api.kimi.ai/") ? "https://auth.kimi.ai" : "https://auth.kimi.com")) return null;
  return { provider: "kimi:" + stamp([base, host, slot]).slice(0, 20), base, host, slot,
    authFile: path.join(dir, "credentials", slot + ".json") };
}
function kimiSources(location, env = {}) {
  const config = part(path.join(location.dir, "config.toml"), "toml");
  const refs = new Map();
  for (const p of Object.values(require('./kimi-model-config.cjs').normalize(config.data).providers)) {
    const ref = kimiReference(location.dir, p);
    if (ref) refs.set(ref.provider, { ...location, ...ref, harness: "kimi", env, native: true });
  }
  // Two service/region declarations sharing one file cannot establish which
  // login actually produced its token, even if the individual refs are legal.
  return [...refs.values()].filter((s, _, all) => all.filter((v) => v.authFile === s.authFile).length === 1);
}
function cipherKey(env = {}) {
  let username = "unknown";
  try { username = os.userInfo().username; } catch {}
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  return crypto.createHash("sha256").update(secret).digest();
}
function decryptZCode(value, env) {
  if (typeof value !== "string") return "";
  if (!value.startsWith("enc:v1:")) return value;
  const parts = value.slice(7).split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p))) throw Error("ZCode 凭据无法解密");
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw Error("ZCode 凭据无法解密");
  const cipher = crypto.createDecipheriv("aes-256-gcm", cipherKey(env), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8");
}
function encryptZCode(value, env) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", cipherKey(env), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "enc:v1:" + [iv, cipher.getAuthTag(), body].map((p) => p.toString("base64url")).join(".");
}
function sourceFile(source) {
  if (source.harness === "kimi") return source.authFile;
  if (source.harness === "antigravity") return antigravity.historyFile(source);
  return path.join(source.dir, "credentials.json");
}
function zcodeUser(grant) {
  try { const user = JSON.parse(grant.user_info); return object(user) ? user : {}; } catch { return {}; }
}
function zcodeIdentity(provider, user) {
  if (provider === "zai" && has(user.user_id)) return user.user_id;
  return has(user.id) && has(user.username) && has(user.displayName) ? user.id : null;
}
function publicGrant(harness, provider, grant, now) {
  if (harness === "kimi") return { ...status(grant.access_token, grant.refresh_token, grant.expires_at, now),
    provider, label: "Kimi Code", profile: { source: "local", docs: ["kimi"], fields: [] } };
  if (harness === "antigravity") {
    const parsed = antigravity.parseStoredToken(grant, now);
    if (parsed.invalid || !parsed.account) return { ...status("", "", null, now), provider,
      label: "Gemini", profile: { source: "local", docs: ["antigravity"], fields: [] } };
    const { identityKey, refreshable, ...account } = parsed.account;
    return { ...account, provider, label: "Gemini" };
  }
  const user = zcodeUser(grant), secrets = [grant.access_token, grant.refresh_token, grant.session_token,
    ...(Array.isArray(grant.coding) ? grant.coding.map((c) => c?.apiKey) : [])];
  const fields = provider === "zai" && has(user.user_id)
    ? [["email", "邮箱", user.email], ["name", "名称", user.name], ["accountId", "用户 ID", user.user_id]]
    : [["name", "名称", user.displayName || user.username], ["accountId", "用户 ID", user.id]];
  let auth = status(grant.access_token, grant.refresh_token, claims(grant.access_token).exp, now);
  // The session JWT is not the provider's refreshable access token. Native
  // ZCode invalidates an expired JWT instead of treating refresh as sufficient.
  const session = status(grant.session_token, "", claims(grant.session_token).exp, now);
  const complete = !!zcodeIdentity(provider, user) && (provider === "zai" || provider === "bigmodel");
  if (!complete || !session.ready) auth = { ...session, ready: false,
    status: session.status === "expired" ? "expired" : "incomplete",
    message: session.status === "expired" ? "ZCode 会话已到期 · 需要重新登录" : "ZCode 登录资料不完整" };
  return { ...auth, provider, label: provider === "zai" ? "Z.ai" : "智谱 BigModel",
    profile: { source: "local", docs: ["zcode"], fields: fields.flatMap(([id, label, value]) => {
      const safe = text(value, secrets); return safe ? [{ id, label, value: safe }] : [];
    }) } };
}
function readSource(source, { fresh = false } = {}) {
  if (source.issue) throw Error(source.issue);
  let config, auth, grants = [];
  if (source.harness === "kimi") {
    config = part(path.join(source.dir, "config.toml"), "toml");
    const refs = kimiSources(source, source.env);
    if (!refs.some((s) => s.provider === source.provider && s.authFile === source.authFile))
      throw Error("Kimi OAuth 引用已变化，请重新选择账户");
    auth = part(sourceFile(source));
    const grant = Object.fromEntries(KIMI_FIELDS.filter((k) => Object.hasOwn(auth.data, k)).map((k) => [k, auth.data[k]]));
    if (has(grant.access_token)) {
      const row = publicGrant("kimi", source.provider, grant);
      // The documented Kimi token file has no stable user identity. Do not
      // merge distinct opaque rotating refresh grants on a guessed identity.
      row.profile.fields = [{ id: "region", label: "服务区域", value: source.base.includes("api.kimi.ai/") ? "Global" : "中国区" },
        { id: "slot", label: "授权位置", value: source.slot }];
      const env = source.env || {};
      const official = !require('./kimi-model-config.cjs').environmentIssue(env) && [env.KIMI_CODE_BASE_URL, env.KIMI_BASE_URL].every((v) => !v || endpoint(v) === source.base) &&
        [env.KIMI_CODE_OAUTH_HOST, env.KIMI_OAUTH_HOST].every((v) => !v || endpoint(v) === source.host);
      grants.push({ row, grant, identity: null, grantKey: stamp(["kimi", source.provider, grant.refresh_token || grant.access_token]),
        query: official ? { kind: "kimi-code", baseUrl: source.base } : null });
    }
  } else if (source.harness === "antigravity") {
    let raw;
    if (source.storage === "keyring") {
      if (!source.keyringAdapter || typeof source.keyringAdapter.read !== "function") throw Error("Antigravity 系统凭据读取器不可用");
      raw = fresh ? source.keyringAdapter.read() : source.keyring?.raw;
      if (raw !== null && (typeof raw !== "string" || raw.length > 65536)) throw Error("Antigravity 系统凭据格式无法识别");
      auth = { file: sourceFile(source), text: raw ?? null, data: raw ? document(raw, "json").data : {} };
    } else {
      auth = part(sourceFile(source));
    }
    if (auth.text !== null) {
      const parsed = antigravity.parseStoredToken(auth.data);
      if (parsed.invalid) throw Error("Antigravity OAuth 格式无法识别");
      if (parsed.account) {
        const token = Object.hasOwn(parsed.grant, "token") ? parsed.grant.token : parsed.grant;
        if (has(token.access_token)) {
          const row = publicGrant("antigravity", "google-antigravity", parsed.grant);
          grants.push({ row, grant: parsed.grant,
            identity: parsed.account.identityKey ? stamp(["antigravity", parsed.account.identityKey]) : null,
            grantKey: stamp(["antigravity", token.refresh_token || token.access_token]), query: null });
        }
      }
    }
  } else {
    auth = part(sourceFile(source));
    if (Object.values(auth.data).some((v) => typeof v !== "string")) throw Error("ZCode 凭据格式无法识别");
    // Selection is query context only. Account switching still writes OAuth
    // fields exclusively; it never restores a different user's project config.
    try { config = part(path.join(source.dir, "setting.json")); } catch { config = { data: {}, text: null }; }
    const value = (key) => decryptZCode(auth.data[key], source.env);
    const provider = value("oauth:active_provider");
    if (["zai", "bigmodel"].includes(provider)) {
      const grant = { access_token: value(`oauth:${provider}:access_token`),
        refresh_token: value(`oauth:${provider}:refresh_token`), user_info: value(`oauth:${provider}:user_info`),
        session_token: value("zcodejwttoken"), attribution: value("oauth:login_attribution") };
      const user = zcodeUser(grant);
      if (has(grant.access_token) && has(grant.session_token) && zcodeIdentity(provider, user)) {
        const env = source.env || {};
        const official = (!env.ZCODE_ENV || env.ZCODE_ENV === "production") &&
          [env.ZCODE_BASE_URL, env.ZCODE_ENDPOINT_ORIGIN].every((v) => !v || endpoint(v) === "https://zcode.z.ai");
        const coding = official && zcodeInfo.official(env, provider);
        if (coding) grant.coding = zcodeInfo.capture(provider, zcodeIdentity(provider, user), config.data, value);
        const row = publicGrant("zcode", provider, grant);
        grants.push({ row, grant, identity: stamp(["zcode", provider, zcodeIdentity(provider, user)]),
          grantKey: stamp(["zcode", provider, grant.refresh_token || grant.access_token]),
          query: official ? { kind: coding ? "zcode-account" : "zcode-start", baseUrl: "https://zcode.z.ai" } : null });
      }
    }
  }
  const parts = [auth], modified = auth.text === null ? 0 : source.harness === "antigravity" && source.storage === "keyring"
    ? Number(source.keyring?.checkedAt) || Date.now() : fs.statSync(auth.file).mtimeMs;
  return { source, auth, parts, config: config?.data || {}, grants, modified,
    fingerprint: stamp([parts.map((p) => [p.file, p.text]), config?.text ?? null,
      // Changing the native cipher key must invalidate a confirmation too.
      source.harness === "zcode" ? cipherKey(source.env).toString("hex") : null]) };
}
function writes(state, entry) {
  let value = state.auth.text;
  const set = (key, v) => { value = edit(value, "json", [key], v === undefined ? { exists: false } : { exists: true, value: v }); };
  if (entry.harness === "antigravity") {
    if (entry.provider !== "google-antigravity") throw Error("不支持此 Antigravity 授权");
    const parsed = antigravity.parseStoredToken(entry.grant);
    if (parsed.invalid || !parsed.account) throw Error("Antigravity 授权格式无法识别");
    const after = JSON.stringify(entry.grant);
    if (state.source.storage === "keyring" && Buffer.byteLength(after) > 2560)
      throw Error("Antigravity 授权超过系统凭据容量，未切换");
    return [{ ...state.auth, after,
      ...(state.source.storage === "keyring" ? { external: "antigravity-keyring",
        afterWrite: (raw) => {
          const parsed = raw ? antigravity.parseStoredToken(JSON.parse(raw)) : {};
          Object.assign(state.source.keyring, { raw, grant: parsed.grant, account: parsed.account, checkedAt: Date.now(),
            status: raw === null ? "missing" : "detected" });
        } } : {}) }];
  }
  if (entry.harness === "kimi") {
    if (state.source.provider !== entry.provider) throw Error("Kimi OAuth 区域或存储位置不匹配");
    for (const k of KIMI_FIELDS) set(k, entry.grant[k]);
  } else {
    if (!["zai", "bigmodel"].includes(entry.provider)) throw Error("不支持此 ZCode 授权");
    const inactive = entry.provider === "zai" ? "bigmodel" : "zai";
    // Follow native mutually-exclusive identity domains; old provider tokens
    // must not remain paired with the new shared session JWT. API/MCP keys stay.
    for (const field of ["access_token", "refresh_token", "user_info"]) {
      set(`oauth:${inactive}:${field}`, undefined);
      set(`oauth:${entry.provider}:${field}`, has(entry.grant[field]) ? encryptZCode(entry.grant[field], state.source.env) : undefined);
    }
    set("oauth:active_provider", encryptZCode(entry.provider, state.source.env));
    set("zcodejwttoken", encryptZCode(entry.grant.session_token, state.source.env));
    set("oauth:login_attribution", has(entry.grant.attribution) ? encryptZCode(entry.grant.attribution, state.source.env) : undefined);
  }
  return [{ ...state.auth, after: value, lock: entry.harness === "zcode" ? "zcode" : undefined }];
}
function lock(file) {
  // Cooperate with ZCode's native credentials.json.lock + unique owner protocol.
  // A busy/stale lock is never deleted by ASS. No UI-blocking retry loop.
  safePath(file);
  const dir = file + ".lock", owner = path.join(dir, `owner-${process.pid}-${crypto.randomUUID()}.json`);
  safePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.mkdirSync(dir); } catch { throw Error("ZCode 正在更新凭据，请结束登录或刷新后重试"); }
  const release = () => { try { fs.unlinkSync(owner); } catch {} try { fs.rmdirSync(dir); } catch {} };
  try {
    const initial = fs.statSync(dir);
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: path.basename(owner) }), { flag: "wx", mode: 0o600 });
    const current = fs.statSync(dir), owners = fs.readdirSync(dir);
    if (initial.ino !== current.ino || initial.dev !== current.dev || owners.length !== 1 || owners[0] !== path.basename(owner)) throw Error();
  } catch { release(); throw Error("ZCode 凭据锁已变化，请重试"); }
  return release;
}
module.exports = { SUPPORTED, kimiReference, kimiSources, sourceFile, readSource, publicGrant, writes,
  decryptZCode, encryptZCode, lock, status };
