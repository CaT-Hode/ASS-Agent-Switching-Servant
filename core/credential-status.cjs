// Read-only credential inventory. Never refresh tokens, execute key helpers, or
// return credential values to the renderer. Native clients own authentication.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const TOML = require("@iarna/toml");
const YAML = require("yaml");
const JSONC = require("jsonc-parser");
const { localProfile } = require("./account-info.cjs");
const dsh = require("./dsh-config.cjs");
const { loadOpenCodeConfig } = require("./opencode-config.cjs");
const { builtinApi, BUILTINS } = require("./native-api-defaults.cjs");
const { memoRead } = require("./read-scope.cjs");
const has = (v) => typeof v === "string" && !!v.trim();
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const digest = (v) =>
  crypto.createHash("sha256").update(v).digest("hex").slice(0, 20);
function read(file, format = "json") {
  return memoRead(read, [file, format], () => readUncached(file, format));
}
function readUncached(file, format) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) return { error: "凭据文件过大，未读取" };
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const data =
      format === "yaml"
        ? YAML.parse(text, { maxAliasCount: 50 })
        : format === "toml"
          ? TOML.parse(text)
          : JSON.parse(text);
    return object(data)
      ? { data, updatedAt: stat.mtime.getTime() }
      : { error: "凭据格式无法识别" };
  } catch (e) {
    return e.code === "ENOENT"
      ? { missing: true }
      : { error: "凭据文件无法读取或格式损坏" };
  }
}
function expiry(token, explicit) {
  let value = Number(explicit);
  if (!(value > 0)) {
    try {
      value = Number(
        JSON.parse(Buffer.from(token.split(".")[1], "base64url")).exp,
      );
    } catch {}
  }
  if (!(value > 0) || !Number.isFinite(value)) return null;
  value = value < 1e12 ? value * 1000 : value;
  return value < 8.64e15 ? value : null;
}
function oauth(provider, access, refresh, expires, now) {
  const expiresAt = expiry(access || "", expires),
    expired = expiresAt !== null && expiresAt <= now;
  const refreshable = has(refresh),
    present = has(access);
  const status = !present
    ? "incomplete"
    : expired
      ? refreshable
        ? "refresh-required"
        : "expired"
      : "detected";
  return {
    provider,
    authType: "oauth",
    ready: present && (!expired || refreshable),
    status,
    expiresAt,
    message: !present
      ? "OAuth 凭据不完整"
      : expired
        ? refreshable
          ? "访问令牌已到期 · 由客户端刷新"
          : "授权已到期 · 需要重新登录"
        : "OAuth",
  };
}
function api(provider, value) {
  const dynamic = has(value) && /^[!$]/.test(value);
  return {
    provider,
    authType: "api",
    ready: has(value) && !dynamic,
    status: dynamic ? "external" : has(value) ? "detected" : "incomplete",
    message: dynamic
      ? "外部密钥引用 · 未执行解析"
      : has(value)
        ? "API Key"
        : "原生凭据链 · 由客户端确认",
  };
}
function parseRecords(harness, data, now = Date.now(), meta = {}) {
  const info = (row, raw = {}) => ({
    ...row,
    profile: localProfile(harness, row.provider, raw, {
      authType: row.authType,
      savedAt: meta.savedAt,
      metadataAt: meta.claudeUpdatedAt,
    }),
  });
  if (harness === "codex") {
    if (
      data.auth_mode === "apikey" ||
      (!data.tokens?.access_token && has(data.OPENAI_API_KEY))
    )
      return [info(api("openai", data.OPENAI_API_KEY))];
    if (object(data.tokens))
      return [
        info(
          oauth(
            "openai",
            data.tokens.access_token,
            data.tokens.refresh_token,
            null,
            now,
          ),
          data.tokens,
        ),
      ];
    return [];
  }
  if (harness === "claude") {
    const t = data.claudeAiOauth;
    const rows = object(t)
      ? [
          info(
            oauth("anthropic", t.accessToken, t.refreshToken, t.expiresAt, now),
            { ...t, cachedIdentity: meta.claudeIdentity },
          ),
        ]
      : [];
    if (has(data.primaryApiKey))
      rows.push(info(api("anthropic-api", data.primaryApiKey)));
    return rows;
  }
  if (harness === "dsh") {
    const rows = [];
    for (const [id, value] of Object.entries(
      data.refs || (data.version ? {} : data),
    ))
      if (/^[A-Z][A-Z0-9_]*_API_KEY$/.test(id) && has(value))
        rows.push(info(api(id, value)));
    for (const [key, record] of Object.entries(data.records || {})) {
      if (!key.startsWith("llm-pi-ai/") || !object(record)) continue;
      const id = key.slice(10),
        t = record.payload;
      if (record.kind === "grant" && t?.type === "oauth")
        rows.push(info(oauth(id, t.access, t.refresh, t.expires, now), t));
      else if (record.kind === "api-key") rows.push(info(api(id, record.key)));
    }
    return rows;
  }
  return Object.entries(data).flatMap(([id, t]) => {
    if (!object(t)) return [];
    if (t.type === "oauth")
      return [info(oauth(id, t.access, t.refresh, t.expires, now), t)];
    if (["api", "api_key"].includes(t.type)) return [info(api(id, t.key))];
    if (has(t.type))
      return [
        {
          provider: id,
          authType: "unknown",
          ready: false,
          status: "external",
          message: "其他原生凭据类型 · 由客户端确认",
        },
      ];
    return [];
  });
}
function credentialFile(harness, dir, native = false) {
  return path.join(
    dir,
    harness === "claude"
      ? ".credentials.json"
      : harness === "dsh"
        ? ".credentials.yaml"
        : harness === "opencode" && !native
          ? "data/opencode/auth.json"
          : "auth.json",
  );
}
function inspectCredentials(
  harness,
  dir,
  { native = false, now = Date.now(), launcher } = {},
) {
  const file = credentialFile(harness, dir, native);
  if (harness === 'opencode') {
    const dataDir = native ? dir : path.join(dir, 'data/opencode');
    try {
      const adapter = require('./opencode-version.cjs'), major = adapter.version(launcher, dataDir), entries = major === 2 ? adapter.credentials(dataDir) : null;
      if (major === 2) {
        const rows = (entries || []).filter(r => typeof r.integrationID === 'string' && !/^ass-/i.test(r.integrationID)).map(r => {
          const row = r.value.type === 'key' ? api(r.integrationID, r.value.key)
            : r.value.type === 'oauth' ? oauth(r.integrationID, r.value.access, r.value.refresh, r.value.expires, now)
            : { provider: r.integrationID, authType: 'unknown', ready: false, status: 'external', message: '原生凭据类型尚未支持' };
          return { ...row, credentialId: r.id, active: r.active,
            label: require('./account-info.cjs').text(r.label, [r.value.key, r.value.access, r.value.refresh]) || r.integrationID,
            message: row.message + (r.active ? ' · 当前账户' : ' · 非当前账户') };
        });
        return { file: path.join(dataDir, 'opencode.db'), rows, status: rows.length ? 'detected' : 'missing',
          message: 'OpenCode v2 credential service（旧 auth.json 不代表当前登录）' };
      }
    } catch { return { file: path.join(dataDir, 'opencode.db'), rows: [], status: 'unreadable', message: 'OpenCode credential 数据库无法读取，未回退到旧 auth.json' }; }
  }
  if (harness === "codex") {
    const config = read(path.join(dir, "config.toml"), "toml");
    if (
      ["keyring", "ephemeral"].includes(config.data?.cli_auth_credentials_store)
    )
      return {
        file,
        rows: [],
        status: "external",
        message: "使用系统密钥库或临时凭据 · 请在原生客户端确认",
      };
  }
  const result = read(file, harness === "dsh" ? "yaml" : "json");
  if (result.error)
    return { file, rows: [], status: "unreadable", message: result.error };
  // Claude's session metadata belongs to this credential directory only. Never
  // borrow the default user's identity for an isolated/custom account.
  let claudeIdentity, claudeUpdatedAt;
  if (harness === "claude" && result.data?.claudeAiOauth) {
    const candidate = path.join(dir, ".claude.json");
    const session = read(candidate);
    const adjacent =
      native && path.basename(dir).toLowerCase() === ".claude"
        ? read(path.join(path.dirname(dir), ".claude.json"))
        : {};
    const data = session.data || adjacent.data;
    if (object(data?.oauthAccount)) {
      claudeIdentity = data.oauthAccount;
      claudeUpdatedAt = (session.data ? session : adjacent).updatedAt;
    }
  }
  const rows = parseRecords(harness, result.data || {}, now, {
    savedAt: result.updatedAt,
    claudeIdentity,
    claudeUpdatedAt,
  });
  return {
    file,
    rows,
    status: rows.length ? "detected" : "missing",
    message: rows.length ? "已读取本地凭据" : "未检测到本地凭据",
  };
}
function nativeLocations(harness, home, env, override, codexDir, launcher) {
  if (harness === 'dsh') return require('./dsh-locations.cjs').locations({ home, env, override, launcher }).dirs;
  const defaults = {
    codex: path.join(home, ".codex"),
    claude: path.join(home, ".claude"),
    opencode: path.join(home, ".local/share/opencode"),
    pi: path.join(home, ".pi/agent"),
    dsh: path.join(home, ".dsh"),
  };
  const custom = {
    codex: codexDir || env.CODEX_HOME,
    claude: env.CLAUDE_CONFIG_DIR,
    opencode: env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, "opencode"),
    pi: env.PI_CODING_AGENT_DIR,
    dsh: env.DSH_HOME,
  };
  const seen = new Set();
  return [override, custom[harness], defaults[harness]]
    .filter(Boolean)
    .map((dir) => path.resolve(dir.replace(/^~(?=[/\\]|$)/, home)))
    .filter((dir) => {
      const key = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function configuredNativeApiProviders(harness, dir, { home, env = {}, authData = {}, workspace } = {}) {
  const output = [];
  const add = (provider, label, key, configPath) => {
    if (typeof provider !== "string" || !provider || provider.length > 250 || /[\x00-\x1f\x7f]/.test(provider) ||
        /^(?:ass-(?:api|[a-f0-9]{16}-(?:chat|responses|messages))|ass_(?:api|official))$/i.test(provider) ||
        !has(key) || key.length > 65536 || /[\r\n\0]/.test(key) || /^[!$]/.test(key)) return;
    const safeLabel = typeof label === "string" && !/[\x00-\x1f\x7f]/.test(label) &&
      (!key || !label.includes(key)) ? label.trim().slice(0, 80) : "";
    output.push({ provider, label: safeLabel || provider, configPath });
  };
  const expand = (raw, mode = "literal") => {
    if (object(raw) && typeof raw.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.env)) raw = env[raw.env];
    if (!has(raw)) return "";
    const text = raw.trim();
    const ref = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
    if (ref) return has(env[ref[1]]) ? env[ref[1]].trim() : "";
    if (mode === "pi" && text.includes("$")) {
      let missing = false;
      const result = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_, a, b) => { if (!has(env[a || b])) missing = true; return env[a || b] || ""; });
      return missing || result.includes("$") ? "" : result;
    }
    if (mode === "pi" && Object.hasOwn(env, text)) return has(env[text]) ? env[text].trim() : "";
    return text.startsWith("!") || text.includes("{file:") ? "" : text;
  };
  if (harness === "dsh") {
    try {
      const settings = dsh.readSettings(dir, (file, format) => read(file, format).data || {});
      const authFile = path.join(dir, ".credentials.yaml"), auth = read(authFile, "yaml").data || {};
      const providers = settings["llm-pi-ai"]?.providers || {};
      for (const [id, p] of Object.entries(providers)) {
        const record = auth.records?.["llm-pi-ai/" + id];
        if (record?.kind === "grant") continue;
        const key = record?.kind === "api-key" ? record.key : expand(p.apiKey, "pi") ||
          (typeof p.apiKeyEnv === "string" ? expand(env[p.apiKeyEnv]) : "");
        add(id, p.displayName || p.name, key, dsh.target(dir).config);
      }
      const deep = settings["llm-deepseek"] || {}, keyName = deep.apiKeyEnv || "DEEPSEEK_API_KEY";
      const deepKey = expand(auth.refs?.[keyName] || (!auth.version && auth[keyName]) || env[keyName]);
      add("DEEPSEEK_API_KEY", "DeepSeek", deepKey, dsh.target(dir).config);
    } catch {}
  } else if (harness === "pi") {
    const file = path.join(dir, "models.json"), providers = read(file).data?.providers || {};
    for (const [id, p] of Object.entries(providers))
      if (object(p)) add(id, p.name || p.displayName, expand(p.apiKey, "pi"), file);
    for (const id of Object.keys(BUILTINS)) {
      if (authData[id]?.type === "oauth") continue;
      add(id, id, expand(env[builtinApi(id).envKey]), file);
    }
  } else if (harness === "opencode") {
    try {
      const { data } = loadOpenCodeConfig({ home, env, workspace });
      const cache = read(path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "opencode/models.json")).data || {};
      for (const id of new Set([...Object.keys(BUILTINS), ...Object.keys(cache), ...Object.keys(data.provider || {})])) {
        const p = data.provider?.[id] || {};
        const key = p.options?.apiKey !== undefined ? expand(p.options.apiKey) :
          expand(authData[id]?.key) || (cache[id]?.env || [builtinApi(id).envKey]).map((name) => expand(env[name])).find(Boolean);
        add(id, p.name, key, "");
      }
    } catch {}
  } else if (harness === "codex") {
    const file = path.join(dir, "config.toml");
    let config = {};
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.length <= 2 * 1024 * 1024) config = TOML.parse(text);
    } catch {}
    for (const [id, p] of Object.entries(config.model_providers || {})) {
      if (!object(p)) continue;
      if (p.auth) continue;
      const key = (typeof p.env_key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.env_key) && expand(env[p.env_key])) ||
        expand(p.experimental_bearer_token) || expand(p.api_key) || (p.requires_openai_auth ? expand(authData.OPENAI_API_KEY) || expand(env.OPENAI_API_KEY) : "");
      add(id, p.name, key, file);
    }
    if ((config.model_provider || "openai") === "openai")
      add("openai", "OpenAI", expand(authData.OPENAI_API_KEY) || expand(env.OPENAI_API_KEY), file);
  } else if (harness === "claude") {
    const file = path.join(dir, "settings.json"), settings = read(file).data || {}, runtime = settings.env || {};
    const key = expand(runtime.ANTHROPIC_API_KEY) || expand(env.ANTHROPIC_API_KEY) ||
      expand(authData.primaryApiKey);
    add("anthropic-api", "Anthropic", key, file);
  }
  return output;
}
function discoverNative(
  harness,
  { home, env = {}, override, codexDir, now = Date.now(), owns, workspace, launcher },
) {
  const dirs = nativeLocations(harness, home, env, override, codexDir, launcher);
  const sources = dirs.map((dir) => {
    const result = inspectCredentials(harness, dir, { native: true, now, launcher });
    const rows = result.rows.length
      ? result.rows
      : ["unreadable", "external"].includes(result.status)
        ? [
            {
              provider: "native",
              authType: "unknown",
              ready: false,
              status: result.status,
              message: result.message,
            },
          ]
        : [];
    const accounts = rows.map((row) => ({
      ...row,
      id: "native:" + digest(harness + "\0" + dir + "\0" + row.provider + (row.credentialId ? '\0' + row.credentialId : '')),
      kind: "native",
      label:
        row.provider === "openai" && row.authType === "oauth"
          ? "ChatGPT"
          : row.label || row.provider,
      badge:
        row.authType === "oauth"
          ? "OAuth"
          : row.authType === "api"
            ? "API Key"
            : "待确认",
      source: "本机账户",
      sourcePath: result.file,
      nativeDir: dir,
      ...(harness === "opencode" ? { workspace } : {}),
      providers: [row.provider],
    }));
    const authData = harness === 'opencode' && result.status === 'unreadable' ? {} : harness === 'opencode' && result.file.endsWith('.db')
      ? Object.fromEntries((require('./opencode-version.cjs').credentials(dir) || []).filter(r => r.active && r.value.type === 'key').map(r => [r.integrationID, { type: 'api', key: r.value.key }]))
      : read(result.file, harness === "dsh" ? "yaml" : "json").data || {};
    const configuredRows = harness === "opencode" && path.resolve(dir).toLowerCase() !== path.resolve(dirs[0]).toLowerCase()
      ? [] : configuredNativeApiProviders(harness, dir, { home, env, authData, workspace });
    const addedConfigured = new Set();
    for (const configured of configuredRows) {
      const matching = accounts.filter((account) => account.provider === configured.provider);
      if (matching.some((account) => account.authType === "api" || harness === "pi" && account.authType === "oauth") || addedConfigured.has(configured.provider) ||
          (configured.configPath && owns?.(configured.configPath, configured.provider))) continue;
      addedConfigured.add(configured.provider);
      const suffix = matching.length ? "\0config-api" : "";
      accounts.push({ provider: configured.provider, authType: "api", ready: true, status: "detected",
        message: "本机 API 配置", id: "native:" + digest(harness + "\0" + dir + "\0" + configured.provider + suffix),
        kind: "native", label: configured.label, badge: "API Key", source: "本机配置",
        sourcePath: result.file, nativeDir: dir, providers: [configured.provider] });
      if (harness === "opencode") accounts.at(-1).workspace = workspace;
    }
    return {
      ...result,
      dir,
      accounts,
    };
  });
  if (harness === 'dsh') {
    const { issue } = require('./dsh-locations.cjs').locations({ home, env, override, launcher });
    if (issue) sources.push({ file: launcher?.entryPoint || launcher?.location, dir: dirs[0], rows: [], accounts: [], status: 'external', message: issue });
  }
  if (harness === "claude" && has(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    const row = oauth("anthropic", env.CLAUDE_CODE_OAUTH_TOKEN, "", null, now);
    const file = "环境变量 CLAUDE_CODE_OAUTH_TOKEN";
    sources.unshift({
      file,
      dir: dirs[0],
      status: "detected",
      message: "检测到环境变量授权",
      rows: [row],
      accounts: [
        {
          ...row,
          id: "native:claude-env",
          kind: "native",
          label: "anthropic",
          badge: "OAuth",
          source: "环境变量",
          sourcePath: file,
          nativeDir: dirs[0],
          providers: ["anthropic"],
        },
      ],
    });
  }
  return sources;
}
module.exports = {
  parseRecords,
  inspectCredentials,
  credentialFile,
  nativeLocations,
  discoverNative,
  configuredNativeApiProviders,
  digest,
};
