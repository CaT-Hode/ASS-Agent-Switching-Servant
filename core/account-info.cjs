// Presentation-only metadata. No auth refresh, key helpers or token verification.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomic } = require("./config.cjs");
const { parseSubscription } = require("./subscription-usage.cjs");
const oauthInfo = require("./oauth-info.cjs");
const { withReadScope } = require("./read-scope.cjs");

const ACCOUNT_DOCS = {
  "kimi-info": { label: "Kimi Code 账户与额度接口", url: "https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/oauth/src/managed-usage.ts" },
  "zcode-info": { label: "ZCode 套餐与额度接口", url: "https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts" },
  kimi: { label: "Kimi Code 配置目录", url: "https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html" },
  zcode: { label: "ZCode 原生凭据格式", url: "https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts" },
  antigravity: { label: "Antigravity 登录与 API", url: "https://antigravity.google/docs/cli/install" },
  codex: {
    label: "Codex 账户接口",
    url: "https://learn.chatgpt.com/docs/app-server#auth-endpoints",
  },
  "codex-claims": {
    label: "Codex 登录字段",
    url: "https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs",
  },
  claude: {
    label: "Claude 身份状态",
    url: "https://code.claude.com/docs/en/cli-reference",
  },
  "claude-cache": {
    label: "Claude 登录缓存",
    url: "https://code.claude.com/docs/en/settings",
  },
  opencode: {
    label: "OpenCode 登录记录",
    url: "https://opencode.ai/docs/cli/#auth",
  },
  pi: {
    label: "pi 授权格式",
    url: "https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/types.ts",
  },
  dsh: {
    label: "DSH 授权适配",
    url: "https://github.com/deepseek-ai/deepseek-harness/blob/aa8262ec091698bae9a6b04773a6b5b06ad4aef2/packages/llm/llm-pi-ai/src/auth.ts",
  },
  deepseek: {
    label: "DeepSeek 余额接口",
    url: "https://api-docs.deepseek.com/api/get-user-balance/",
  },
  "opencode-go": {
    label: "OpenCode Go 用量接口",
    url: "https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts",
  },
  "opencode-zen": {
    label: "OpenCode Zen 计费",
    url: "https://opencode.ai/docs/zen/",
  },
  openrouter: {
    label: "OpenRouter Key 接口",
    url: "https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key",
  },
};
const PROVIDERS = {
  openai: "OpenAI / ChatGPT",
  "openai-codex": "OpenAI / ChatGPT",
  anthropic: "Anthropic / Claude",
  "anthropic-api": "Anthropic API",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Google Gemini CLI",
  "google-antigravity": "Google Antigravity",
  deepseek: "DeepSeek",
  DEEPSEEK_API_KEY: "DeepSeek",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  openrouter: "OpenRouter",
};
const object = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
function text(value, secrets = []) {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (
    !s ||
    s.length > 240 ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s) ||
    /(?:^|\s)(?:Bearer\s|sk-[a-z0-9]{12}|eyJ[\w-]+\.eyJ)/i.test(s) ||
    secrets.some(
      (secret) =>
        typeof secret === "string" && secret.length > 3 && s.includes(secret),
    )
  )
    return undefined;
  return s;
}
function claims(token) {
  try {
    if (typeof token !== "string" || token.length > 65536) return {};
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      !parts.every(Boolean) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1])
    )
      return {};
    return object(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
  } catch {
    return {};
  }
}
function iso(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n =
    typeof value === "number"
      ? value < 1e12
        ? value * 1000
        : value
      : Date.parse(value);
  return Number.isFinite(n) && n > 0 && n < 8.64e15
    ? new Date(n).toISOString()
    : undefined;
}
function field(id, label, value, secrets = [], extra = {}) {
  const v = text(value, secrets);
  return v ? { id, label, value: v, ...extra } : null;
}
function localProfile(
  harness,
  provider,
  raw = {},
  { authType = "oauth", savedAt, metadataAt } = {},
) {
  const t = object(raw),
    secrets = [
      t.access_token,
      t.refresh_token,
      t.id_token,
      t.accessToken,
      t.refreshToken,
      t.access,
      t.refresh,
      t.key,
    ];
  const f = (id, label, v) => field(id, label, v, secrets);
  let email,
    name,
    plan,
    accountId,
    userId,
    organizationId,
    organization,
    project,
    tier;
  const docs = [harness];
  const chatgpt =
    authType === "oauth" && ["openai", "openai-codex"].includes(provider);
  if (chatgpt) {
    // Match Codex's explicitly documented namespaced claims, not arbitrary JWT data.
    const id = claims(t.id_token),
      access = claims(t.access_token || t.access);
    const identity = Object.keys(id).length ? id : access;
    const auth = object(identity["https://api.openai.com/auth"]);
    const tokenAccount = text(auth.chatgpt_account_id, secrets);
    accountId = t.account_id || t.accountId || tokenAccount;
    // An explicit workspace that conflicts with the ID token must not inherit its plan/identity.
    if (!accountId || !tokenAccount || accountId === tokenAccount) {
      email =
        identity.email ||
        object(identity["https://api.openai.com/profile"]).email;
      plan = auth.chatgpt_plan_type;
      userId = auth.chatgpt_user_id || auth.user_id;
    }
    docs.push("codex", "codex-claims");
  } else if (authType === "oauth") {
    // Explicit optional metadata only; no recursive scans, inferred plans or opaque token parsing.
    email = t.email;
    name = t.name;
    accountId = t.accountId;
    project = t.projectId;
    if (provider === "anthropic") {
      plan = t.subscriptionType;
      tier = t.rateLimitTier;
      const account = object(t.account),
        org = object(t.organization);
      email = email || account.email_address;
      name = name || account.display_name;
      accountId = accountId || account.uuid;
      organizationId = org.uuid;
      organization = org.name;
      const cached = object(t.cachedIdentity);
      if (!accountId || accountId === cached.accountUuid) {
        email = email || cached.emailAddress;
        name = name || cached.displayName;
        accountId = accountId || cached.accountUuid;
        organizationId = organizationId || cached.organizationUuid;
        organization = organization || cached.organizationName;
        if (Object.keys(cached).length) docs.push("claude-cache");
      }
    }
  }
  const scopes = (
    Array.isArray(t.scopes)
      ? t.scopes
      : typeof t.scope === "string"
        ? t.scope.split(/\s+/)
        : []
  )
    .slice(0, 12)
    .map((s) => text(s, secrets))
    .filter(Boolean);
  return {
    source: chatgpt
      ? "本地登录令牌"
      : docs.includes("claude-cache")
        ? "原生登录缓存"
        : "原生登录记录",
    updatedAt: iso(savedAt),
    metadataUpdatedAt: docs.includes("claude-cache")
      ? iso(metadataAt)
      : undefined,
    docs: [...new Set(docs.filter((id) => ACCOUNT_DOCS[id]))],
    fields: [
      f("provider", "授权供应商", PROVIDERS[provider] || provider),
      f("email", "邮箱", email),
      f("name", "名称", name),
      f("plan", "套餐", plan),
      f("accountId", chatgpt ? "工作区 / 账户 ID" : "账户 ID", accountId),
      f("userId", "用户 ID", userId),
      f("organization", "组织", organization),
      f("organizationId", "组织 ID", organizationId),
      f("projectId", "项目 ID", project),
      f("tier", "限额等级", tier),
      f("scopes", "授权范围", scopes.join(" · ")),
    ].filter(Boolean),
  };
}

// Only exact official HTTPS origins are eligible. A provider label/brand alone is not authority.
function adapter(provider) {
  const extra = oauthInfo.adapter(provider);
  if (extra) return extra;
  if (
    provider.subscriptionKind === "openai" &&
    provider.baseUrl === "https://chatgpt.com/backend-api"
  )
    return "openai-subscription";
  if (
    provider.subscriptionKind === "anthropic" &&
    provider.baseUrl === "https://api.anthropic.com"
  )
    return "anthropic-subscription";
  try {
    const u = new URL(provider.baseUrl);
    if (u.username || u.password || u.search || u.hash) return null;
    if (
      u.origin === "https://api.deepseek.com" &&
      /^\/(?:v1\/?)?$/.test(u.pathname)
    )
      return "deepseek";
    if (
      u.origin === "https://opencode.ai" &&
      /^\/zen\/(?:go\/)?v1\/?$/.test(u.pathname)
    )
      return u.pathname.includes("/go/") ? "opencode-go" : "opencode";
    if (
      u.origin === "https://openrouter.ai" &&
      /^\/api\/v1\/?$/.test(u.pathname)
    )
      return "openrouter";
  } catch {}
  return null;
}
function apiProfile(provider, nativeConnection = false) {
  const extra = oauthInfo.profile(provider);
  if (extra) return extra;
  let host;
  try {
    host = new URL(provider.baseUrl).host;
  } catch {}
  const id = adapter(provider);
  if (id?.endsWith("-subscription"))
    return {
      source: "订阅额度 · 上次查询",
      fields: [],
      canRefresh: !!provider.apiKey,
      docs: [provider.subscriptionKind === "openai" ? "codex" : "claude"],
      note: "只读额度查询；授权到期请由原生客户端刷新。",
    };
  const oc = id === "opencode" || id === "opencode-go";
  return {
    source: provider.nativeProvider ? "原生 API 登录记录" : "已保存的 API 配置",
    docs: oc ? ["opencode-go", "opencode-zen"] : id ? [id] : [],
    consoleService:
      id === "deepseek" ? "deepseek" : oc ? "opencode" : undefined,
    canRefresh: !!id && !!provider.apiKey,
    note: oc
      ? "查询 Go 订阅用量；Zen 充值余额、邮箱和工作区资料请到官方控制台查看。"
      : id === "deepseek"
        ? "余额接口提供可用、赠金和充值余额，不返回邮箱或账户 ID。"
        : id
          ? "只读查询当前 Key 的资料，不发送模型请求。"
          : "此入口尚无已适配的账户资料接口；余额可在账户菜单查询。",
    fields: [
      field("host", "API 服务", host),
      field(
        "product",
        "服务产品",
        id === "deepseek"
          ? "DeepSeek API"
          : id === "opencode-go"
            ? "OpenCode Go"
            : id === "opencode"
              ? "OpenCode Zen / Go"
              : undefined,
      ),
      field("auth", "认证方式", "API Key"),
      field(
        "network",
        "网络出口",
        nativeConnection
          ? "原生客户端配置"
          : provider.network === "direct-doh"
            ? "直连 · HTTPS DNS · 系统 CA"
          : provider.network === "direct"
            ? "直连 · 系统 CA"
            : "系统代理 · 系统 CA",
      ),
    ].filter(Boolean),
  };
}
function parseRemote(id, data, secrets = []) {
  if (id.endsWith("-subscription")) {
    const fields = parseSubscription(id.split("-")[0], data);
    if (!fields.length) throw Error("未返回订阅额度窗口");
    return fields;
  }
  const fields = [],
    d = object(data);
  const add = (key, label, v) => {
    const f = field(key, label, v, secrets);
    if (f) fields.push(f);
  };
  const amount = (key, label, v, unit = "USD") => {
    if (
      !["string", "number"].includes(typeof v) ||
      String(v).length > 64 ||
      String(v).trim() === "" ||
      !Number.isFinite(Number(v))
    )
      return;
    fields.push({ id: key, label, value: String(v), kind: "amount", unit });
  };
  if (id === "deepseek") {
    if (typeof d.is_available === "boolean")
      add("available", "余额可供调用", d.is_available ? "是" : "否");
    for (const [i, row] of (Array.isArray(d.balance_infos)
      ? d.balance_infos.slice(0, 8)
      : []
    ).entries()) {
      if (!["CNY", "USD"].includes(row?.currency)) continue;
      amount("balance-" + i, "可用余额", row.total_balance, row.currency);
      amount("granted-" + i, "赠金余额", row.granted_balance, row.currency);
      amount("topped-" + i, "充值余额", row.topped_up_balance, row.currency);
    }
  } else if (["opencode", "opencode-go"].includes(id)) {
    for (const [window, label] of [
      ["rolling", "滚动窗口"],
      ["weekly", "每周额度"],
      ["monthly", "每月额度"],
    ]) {
      const usage = object(d.usage?.[window]);
      if (
        typeof usage.percent !== "number" ||
        !Number.isFinite(usage.percent) ||
        usage.percent < 0 ||
        !["ok", "rate-limited"].includes(usage.status)
      )
        continue;
      fields.push({
        id: "quota-" + window,
        label,
        value: String(usage.percent),
        kind: "quota",
        usedPercent: usage.percent,
        remainingPercent: Math.max(0, 100 - usage.percent),
        status: usage.status,
        resetsAt: iso(usage.resetsAt),
      });
    }
    if (fields.length) add("entitlement", "Go 订阅权益", "已通过接口确认");
  } else if (id === "openrouter") {
    const k = object(d.data);
    // A returned Key label may be a masked secret; never present it as a person's name.
    if (!/^sk-/i.test(k.label || "")) add("keyLabel", "Key 标签", k.label);
    add("userId", "创建者 ID", k.creator_user_id);
    add("organizationId", "组织 ID", k.organization_id);
    add("workspaceId", "工作区 ID", k.workspace_id);
    if (typeof k.is_free_tier === "boolean")
      add("tier", "Key 级别", k.is_free_tier ? "免费级别" : "付费级别");
    if (k.limit === null)
      add("limit", "Key 额度上限", "未设置（不代表账户余额无限）");
    else amount("limit", "Key 额度上限", k.limit);
    amount("remaining", "Key 剩余额度", k.limit_remaining);
    amount("usage", "累计使用", k.usage);
    amount("usageDaily", "今日使用", k.usage_daily);
    amount("usageMonthly", "本月使用", k.usage_monthly);
    add("reset", "额度重置周期", k.limit_reset);
    if (iso(k.expires_at))
      fields.push({
        id: "expires",
        label: "Key 到期",
        value: iso(k.expires_at),
        kind: "date",
      });
  }
  if (!fields.length) throw Error("接口未返回可识别的账户资料");
  return fields;
}
const fingerprint = (p) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([p.id, p.baseUrl, p.apiKey, p.network, p.extraHeaders, p.subscriptionKind, p.appVersion,
        ...(p.subscriptionKind === "zcode-account" ? [p.family, p.oauthAccess, p.coding] : [])]),
    )
    .digest("hex");
function cachedModelEntitlement(entry) {
  const section = entry?.sections?.usage, value = section?.modelEntitlement;
  if (!value || !["available", "pending", "unavailable"].includes(value.status)) return null;
  const result = { status: value.status, updatedAt: section.updatedAt };
  if (Array.isArray(value.models)) {
    const models = [...new Set(value.models.filter((id) => typeof id === "string" && id.trim() &&
      id.length <= 250 && !/[\x00-\x1f\x7f]/.test(id)).map((id) => id.trim()))].slice(0, 100);
    result.models = models;
  }
  if (value.status === "pending" && iso(value.effectiveAt)) result.effectiveAt = iso(value.effectiveAt);
  return result;
}
function queryError(error, label = "资料") {
  // Classify only known error codes; raw network messages may contain secrets.
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || "");
  if (["TimeoutError", "AbortError"].includes(error?.name) || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code) || /net::ERR_TIMED_OUT\b/.test(message))
    return `${label}查询超时，请稍后重试`;
  if (/^(?:ERR_CERT_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code) || /net::ERR_CERT_/.test(message))
    return `${label}查询的证书验证失败，请检查系统证书和代理`;
  if (/^(?:ENOTFOUND|EAI_AGAIN)$/.test(code) || /net::ERR_NAME_NOT_RESOLVED\b/.test(message))
    return `${label}接口域名解析失败，请检查网络`;
  if (/net::ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)\b/.test(message))
    return `${label}查询无法连接系统代理，请检查代理设置`;
  if (/^HTTP \d{3}$/.test(message)) return `${label}查询失败 · ${message}`;
  if (error instanceof SyntaxError) return `${label}接口返回无效 JSON`;
  if (["资料响应为空", "资料响应过大", "接口未返回可识别的账户资料", "未返回订阅额度窗口"].includes(message)) return message;
  return `${label}查询失败，请检查网络或接口权限`;
}
class AccountInfo {
  constructor({
    dataDir,
    crypto: vault,
    getProvider,
    fetcher,
    now = Date.now,
  }) {
    this.file = path.join(dataDir, "account-info.enc.json");
    this.vault = vault;
    this.getProvider = getProvider;
    this.fetcher = fetcher;
    this.now = now;
    this.cache = {};
    this.jobs = new Map();
    this.errors = new Map();
    this.warnings = new Map();
    this.attempts = new Map();
    try {
      if (fs.statSync(this.file).size <= 2 * 1024 * 1024) {
        const stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.cache = object(
          JSON.parse(
            vault.decryptString(Buffer.from(stored.encrypted, "base64")),
          ),
        );
      }
    } catch {} // Runtime metadata is recoverable; never make startup depend on it.
  }
  save() {
    if (!this.vault.isEncryptionAvailable()) throw Error("资料缓存加密不可用");
    const active = withReadScope(() => Object.fromEntries(
      Object.entries(this.cache).filter(([id, r]) => {
        try {
          const p = this.getProvider(id);
          return p && r?.fingerprint === fingerprint(p);
        } catch {
          // An unavailable old account must not poison another account's save.
          return false;
        }
      }),
    ));
    atomic(
      this.file,
      JSON.stringify({
        encrypted: this.vault
          .encryptString(JSON.stringify(active))
          .toString("base64"),
      }),
    );
    this.cache = active;
  }
  saveResult(key) {
    try { this.save(); this.warnings.clear(); }
    catch { this.warnings.set(key, "资料已更新，但未保存到本机；重启后将重新查询"); }
  }
  public(provider) {
    const base = apiProfile(provider),
      entry = this.cache[provider.id],
      key = fingerprint(provider);
    const valid = entry?.fingerprint === key && Array.isArray(entry.fields);
    const modelEntitlement = valid ? cachedModelEntitlement(entry) : null;
    return {
      ...base,
      ...(valid
        ? {
            fields: [...base.fields, ...entry.fields],
            source: "官方 API · 上次查询",
            remote: true,
            updatedAt: entry.updatedAt,
            stale: this.now() - Date.parse(entry.updatedAt) > 15 * 60000,
            ...(modelEntitlement ? { modelEntitlement } : {}),
          }
        : {}),
      error: this.errors.get(key),
      warning: this.warnings.get(key),
      refreshing: this.jobs.has(key),
    };
  }
  async refresh(id, { automatic = false } = {}) {
    const p = this.getProvider(id),
      kind = p && adapter(p);
    if (!kind || !p.apiKey) throw Error("此账户没有可查询的官方资料接口");
    if (p.queryBlocked) throw Error(p.queryBlocked);
    const key = fingerprint(p);
    if (this.jobs.has(key)) return this.jobs.get(key);
    const cached =
      this.cache[id]?.fingerprint === key
        ? Date.parse(this.cache[id].updatedAt)
        : 0;
    const checked = Math.max(cached || 0, this.attempts.get(key) || 0);
    if (automatic && this.now() - checked < 5 * 60000)
      return { ok: !this.errors.has(key), cached: true, message: this.errors.get(key), warning: this.warnings.get(key) };
    this.attempts.set(key, this.now());
    const job = this.query(p, kind, key);
    this.jobs.set(key, job);
    try {
      return await job;
    } finally {
      this.jobs.delete(key);
    }
  }
  async query(p, kind, key) {
    if (oauthInfo.adapter(p)) return this.queryOAuth(p, kind, key);
    const route =
      kind === "openai-subscription"
        ? "https://chatgpt.com/backend-api/wham/usage"
        : kind === "anthropic-subscription"
          ? "https://api.anthropic.com/api/oauth/usage"
          : kind === "deepseek"
            ? "https://api.deepseek.com/user/balance"
            : ["opencode", "opencode-go"].includes(kind)
              ? "https://opencode.ai/zen/go/v1/usage"
              : "https://openrouter.ai/api/v1/key";
    try {
      const { data } = await this.fetchJSON(p, route, kind.endsWith("-subscription") ? p.extraHeaders : {});
      const expectedAccount = p.extraHeaders?.["chatgpt-account-id"];
      if (
        kind === "openai-subscription" &&
        expectedAccount &&
        data.account_id &&
        data.account_id !== expectedAccount
      )
        throw Error("额度账户不匹配");
      const fields = parseRemote(kind, data, [p.apiKey]);
      const current = this.getProvider(p.id);
      if (!current || fingerprint(current) !== key)
        return { ok: false, message: "账户配置已变化，请重新查询" };
      this.cache[p.id] = {
        fingerprint: key,
        fields,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.errors.delete(key);
      this.saveResult(key);
      return { ok: true, warning: this.warnings.get(key) };
    } catch (e) {
      // Never expose body, auth headers, network error URLs or raw exception strings.
      const message =
        e.message === "额度账户不匹配"
          ? "返回额度不属于所选账户，未采用此结果"
          : kind.endsWith("-subscription") &&
              ["HTTP 401", "HTTP 403"].includes(e.message)
            ? "订阅额度未获授权（" +
              e.message +
              "），请在原生客户端确认登录与权限"
            : ["opencode", "opencode-go"].includes(kind) &&
                e.message === "HTTP 403"
              ? "此 Key 未获 Go 订阅查询权限（HTTP 403）；Zen 余额请在控制台查看"
              : queryError(e);
      this.errors.set(key, message);
      return { ok: false, message };
    }
  }
  async fetchJSON(p, url, extraHeaders = {}, authorization = "Bearer " + p.apiKey) {
    const r = await this.fetcher(url, { method: "GET", headers: { ...extraHeaders,
      accept: "application/json", authorization },
      signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" }, p.network);
    if (!r.ok) { await r.body?.cancel(); throw Error("HTTP " + r.status); }
    if (Number(r.headers.get("content-length")) > 256 * 1024) { await r.body?.cancel(); throw Error("资料响应过大"); }
    const chunks = [], reader = r.body?.getReader(); let size = 0;
    if (!reader) throw Error("资料响应为空");
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 256 * 1024) { await reader.cancel(); throw Error("资料响应过大"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), responseTime: Date.parse(r.headers.get("date")) };
  }
  async queryOAuth(p, kind, key) {
    p = structuredClone(p); // One immutable credential/scope generation per query.
    const requests = oauthInfo.requests(p);
    const secrets = new Set([p.apiKey, p.oauthAccess, ...(p.coding || []).map((c) => c.apiKey)].filter(Boolean));
    const protect = (value) => { if (typeof value === "string" && value) secrets.add(value); };
    const get = (url, headers = {}) => this.fetchJSON(p, url, headers, headers.authorization || "Bearer " + p.apiKey);
    const results = await Promise.all(requests.map(async (request) => {
      const { section, url } = request;
      try {
        const response = request.run ? await request.run(get, protect) : await get(url);
        const options = { safeText: (v) => text(v, [...secrets]), now: this.now() };
        const fields = oauthInfo.parseResponse(kind, request, response, options);
        const modelEntitlement = oauthInfo.modelEntitlement(kind, request, response, options);
        return { section, fields, ...(modelEntitlement ? { modelEntitlement } : {}),
          updatedAt: new Date(this.now()).toISOString() };
      } catch (e) {
        const label = request.label || (section === "identity" ? "账户资料" : "额度");
        const message = ["HTTP 401", "HTTP 403"].includes(e.message)
          ? `${label}未获授权（${e.message}），请在原生客户端确认登录`
          : queryError(e, label);
        return { section, error: message };
      }
    }));
    const current = this.getProvider(p.id);
    if (!current || fingerprint(current) !== key) return { ok: false, message: "账户配置已变化，请重新查询" };
    const previous = this.cache[p.id]?.fingerprint === key ? this.cache[p.id] : null;
    const sections = { ...previous?.sections };
    for (const r of results) if (!r.error) sections[r.section] = { fields: r.fields, updatedAt: r.updatedAt,
      ...(r.modelEntitlement ? { modelEntitlement: r.modelEntitlement } : {}) };
    const errors = results.filter((r) => r.error).map((r) => r.error);
    if (errors.length) this.errors.set(key, errors.join("；")); else this.errors.delete(key);
    if (results.some((r) => !r.error)) {
      // Keep independently fetched identity and usage when one endpoint fails.
      // The public timestamp is the oldest displayed section, not a false fresh
      // timestamp on retained quota data. No cache can cross token fingerprints.
      const items = Object.values(sections);
      this.cache[p.id] = { fingerprint: key, sections, fields: items.flatMap((s) => s.fields),
        updatedAt: items.map((s) => s.updatedAt).sort()[0] };
      this.saveResult(key);
    }
    return { ok: errors.length === 0, partial: errors.length > 0 && results.some((r) => !r.error), message: errors.join("；") || undefined, warning: this.warnings.get(key) };
  }
}
module.exports = {
  ACCOUNT_DOCS,
  localProfile,
  apiProfile,
  adapter,
  parseRemote,
  AccountInfo,
  claims,
  iso,
  text,
};
