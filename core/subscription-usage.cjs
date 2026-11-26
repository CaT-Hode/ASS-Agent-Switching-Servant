const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const antigravityQuota = require("./antigravity-quota.cjs");

function tokenAccountId(access) {
  try {
    const parts = access.split(".");
    if (parts.length !== 3) return undefined;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))[
      "https://api.openai.com/auth"
    ]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function nativeSubscriptionProvider(client, account) {
  if (
    !account ||
    account.kind === "api" ||
    account.authType !== "oauth" ||
    !account.ready
  )
    return null;
  if (client.id === "antigravity") return antigravityQuota.provider(client, account);
  const provider = account.provider || account.oauthProvider;
  const kind = ["openai", "openai-codex"].includes(provider)
    ? "openai"
    : provider === "anthropic"
      ? "anthropic"
      : null;
  if (!kind || !account.sourcePath || !path.isAbsolute(account.sourcePath))
    return null;
  try {
    const credentialDB = client.id === 'opencode' && account.credentialId && account.sourcePath.endsWith('.db');
    if (!credentialDB && fs.statSync(account.sourcePath).size > 2 * 1024 * 1024) return null;
    const text = credentialDB ? '' : fs
      .readFileSync(account.sourcePath, "utf8")
      .replace(/^\uFEFF/, "");
    const data = credentialDB ? { [provider]: require('./opencode-version.cjs').selected(account).value } :
      client.id === "dsh"
        ? YAML.parse(text, { maxAliasCount: 20 })
        : JSON.parse(text);
    const token =
      client.id === "codex"
        ? data.tokens
        : client.id === "claude"
          ? data.claudeAiOauth
          : client.id === "dsh"
            ? data.records?.["llm-pi-ai/" + provider]?.payload
            : data[provider];
    return subscriptionProvider(client.id, provider, token, "native-info:" + client.id + ":" + account.id);
  } catch {
    return null;
  }
}
// Saved OAuth records must use their own grant, never the active native file.
function subscriptionProvider(harness, provider, token, id) {
    const kind = ["openai", "openai-codex"].includes(provider) ? "openai" : provider === "anthropic" ? "anthropic" : null;
    if (!kind) return null;
    const access = token?.access_token || token?.accessToken || token?.access;
    if (typeof access !== "string" || !access || access.length > 65536)
      return null;
    const accountId =
      token.account_id ||
      token.accountId ||
      (kind === "openai" ? tokenAccountId(access) : undefined);
    return {
      id,
      nativeProvider: kind,
      subscriptionKind: kind,
      baseUrl:
        kind === "openai"
          ? "https://chatgpt.com/backend-api"
          : "https://api.anthropic.com",
      apiKey: access,
      network: "system",
      models: [],
      extraHeaders:
        kind === "openai"
          ? {
              "user-agent": "codex-cli",
              ...(typeof accountId === "string" &&
              accountId.length <= 250 &&
              accountId &&
              !/[\x00-\x1f]/.test(accountId)
                ? { "chatgpt-account-id": accountId }
                : {}),
            }
          : { "anthropic-beta": "oauth-2025-04-20" },
    };
}
function resetTime(value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15
    ? new Date(ms).toISOString()
    : undefined;
}
function quota(id, label, used, resets) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0)
    return null;
  return {
    id: "quota-" + id,
    label,
    kind: "quota",
    value: String(used),
    usedPercent: used,
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    resetsAt: resetTime(resets),
  };
}
function quotaAmount(id, label, value, unit, extra = {}) {
  return { id, label, value: String(value), unit, kind: "amount", quotaDetail: true, ...extra };
}
function nonnegative(value) {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function minorUnits(amount, exponent) {
  const value = nonnegative(amount);
  return value !== null && Number.isInteger(exponent) && exponent >= 0 && exponent <= 6
    ? value / 10 ** exponent : null;
}
function claudeSpend(data) {
  const spend = data?.spend;
  const legacy = data?.extra_usage;
  const modern = typeof spend?.enabled === "boolean";
  if (modern ? !spend.enabled : legacy?.is_enabled !== true) return null;
  const currency = modern ? spend.used?.currency : legacy.currency ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const decimals = legacy?.decimal_places ?? 2;
  const used = modern ? minorUnits(spend.used?.amount_minor, spend.used?.exponent)
    : minorUnits(legacy.used_credits, decimals);
  if (used === null) return null;
  const limit = modern
    ? spend.limit?.currency === currency ? minorUnits(spend.limit.amount_minor, spend.limit.exponent) : null
    : minorUnits(legacy.monthly_limit, decimals);
  return quotaAmount("claude-extra-usage", "额外付费已用", used, currency,
    limit === null ? {} : { limit: String(limit) });
}
function claudeQuotaFields(data) {
  const legacy = data?.rate_limits || data;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows = [
    ["five_hour", "5h", "session"],
    ["seven_day", "周", "weekly_all"],
  ].map(([key, label, kind]) => {
    const w = legacy?.[key];
    const scoped = limits.find(item => item?.kind === kind);
    return quota(key, label, w?.utilization ?? w?.used_percentage, w?.resets_at)
      || quota(key, label, scoped?.percent, scoped?.resets_at);
  }).filter(Boolean);
  const models = new Map();
  for (const [key, label] of [["opus", "Opus"], ["sonnet", "Sonnet"], ["fable", "Fable"]]) {
    const w = legacy?.["seven_day_" + key];
    const field = quota("weekly-" + key, label + " 周额度", w?.utilization ?? w?.used_percentage, w?.resets_at);
    if (field) models.set(key, { ...field, group: "模型周额度" });
  }
  for (const item of limits) {
    const name = item?.kind === "weekly_scoped" && item.scope?.model?.display_name;
    if (typeof name !== "string" || !/^[a-z\d][a-z\d .+_-]{0,47}$/i.test(name)) continue;
    const key = name.split(/\s+/)[0].toLowerCase();
    if (models.has(key)) continue;
    const field = quota("weekly-" + key, name + " 周额度", item.percent, item.resets_at);
    if (field) models.set(key, { ...field, group: "模型周额度" });
  }
  const spend = claudeSpend(data);
  return [...windows, ...models.values(), ...(spend ? [spend] : [])];
}
function parseCodexResetCredits(data, now = Date.now()) {
  if (!Array.isArray(data?.credits)) return null;
  const expiries = [];
  let missingExpiryCount = 0;
  for (const credit of data.credits) {
    if (typeof credit?.status !== "string") return null;
    if (credit.status !== "available") continue;
    if (credit.expires_at == null) {
      missingExpiryCount++;
    } else {
      const expires = Date.parse(credit.expires_at);
      if (!Number.isFinite(expires)) return null;
      if (expires > now) expiries.push(new Date(expires).toISOString());
    }
  }
  expiries.sort();
  return quotaAmount("codex-reset-credits", "可用重置", expiries.length + missingExpiryCount, "次", {
    expiries, missingExpiryCount, ...(expiries.length ? { expiresAt: expiries[0] } : {}),
  });
}
function codexWindows(limits, prefix = "") {
  return [
    limits?.primary_window || limits?.primary,
    limits?.secondary_window || limits?.secondary,
  ]
    .map((w, i) => {
      if (!w) return null;
      const mins =
        w.windowDurationMins ??
        (typeof w.limit_window_seconds === "number"
          ? w.limit_window_seconds / 60
          : null);
      const label =
        mins === 300
          ? "5h"
          : mins === 10080
            ? "周"
            : Number.isFinite(mins) && mins > 0
              ? mins % 60 === 0
                ? `${mins / 60}h`
                : `${mins} 分钟`
              : `窗口 ${i + 1}`;
      return quota(
        prefix + i,
        label,
        w.used_percent ?? w.usedPercent,
        w.reset_at ?? w.resetsAt,
      );
    })
    .filter(Boolean);
}
function parseSubscription(kind, data) {
  if (kind === "anthropic") return claudeQuotaFields(data);
  const limits =
    data?.rateLimitsByLimitId?.codex || data?.rateLimits || data?.rate_limit;
  const fields = codexWindows(limits);
  const seen = new Set();
  for (const pool of Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits : []) {
    const name = pool?.limit_name;
    if (typeof name !== "string" || !/^[a-z\d][a-z\d .+_()/-]{0,59}$/i.test(name)) continue;
    const id = name.toLowerCase().replace(/[^a-z\d]+/g, "-");
    if (seen.has(id)) continue;
    const windows = codexWindows(pool.rate_limit, "codex-extra-" + id + "-");
    if (windows.length) {
      fields.push(...windows.map(field => ({ ...field, group: name })));
      seen.add(id);
    }
  }
  const credits = data?.credits || limits?.credits;
  if (credits?.unlimited === true && credits.has_credits !== false) {
    fields.push(quotaAmount("codex-credits", "Codex Credits", "不限", ""));
  } else {
    const balance = nonnegative(credits?.balance);
    if (balance !== null && (credits.has_credits !== false || balance === 0))
      fields.push(quotaAmount("codex-credits", "Codex Credits", balance, ""));
  }
  return fields;
}
module.exports = { nativeSubscriptionProvider, subscriptionProvider, parseSubscription, parseCodexResetCredits };
