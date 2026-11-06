import React from "react";
import { RefreshCw, ExternalLink } from "./icons.jsx";
import { accountPlan } from './account-plan.mjs';
import { UsageMeter } from './usage-meter.jsx';
const api = window.ass;
const plans = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
  pro5x: "Pro 5×",
  pro20x: "Pro 20×",
};
function valueOf(field) {
  if (field.kind === "date")
    return new Date(field.value).toLocaleString("zh-CN", { hour12: false });
  return field.value + (field.unit ? " " + field.unit : "");
}
export function AccountPlan({ account }) {
  const plan = accountPlan(account);
  return plan ? <span className="account-plan" title="订阅档位">{plan}</span> : null;
}
function Facts({ fields }) {
  return (
    <dl className="account-profile-facts">
      {fields.map((f) => (
        <div key={f.id}>
          <dt>{f.label}</dt>
          <dd
            title={valueOf(f)}
            className={f.kind === "amount" ? "profile-amount" : undefined}
          >
            {valueOf(f)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function AccountProfile({ account, client, state, act, busy, hideIdentity = false }) {
  const p = account.profile || { fields: [] };
  if (!account.profile && !account.quota) return null;
  // Subscription usage is cached separately from local identity. Do not drop
  // the quota cache merely because the identity snapshot is local-only.
  const quota = account.quota || p;
  const quotas = (quota.fields || []).filter((f) => f.kind === "quota");
  const get = (id) => p.fields.find((f) => f.id === id)?.value;
  const email = get("email"),
    name = get("name") || get("keyLabel"),
    plan = accountPlan(account);
  const priority = (f) =>
    f.id === "remaining" || f.id.startsWith("balance-")
      ? 0
      : ["limit", "usageDaily", "usageMonthly", "available"].includes(f.id)
        ? 1
        : f.kind === "amount"
          ? 2
          : 3;
  const facts = p.fields
    .filter(
      (f) =>
        f.kind === "amount" &&
        !["email", "name", "keyLabel", "plan", "scopes"].includes(f.id),
    )
    .sort((a, b) => priority(a) - priority(b));
  return (
    <section className="account-profile" aria-label="账户资料">
      {!hideIdentity && (email || name || plan) && (
        <div className="account-identity">
          <div>
            {!hideIdentity && email && <strong title={email}>{email}</strong>}
            {!hideIdentity && name && !email && <strong title={name}>{name}</strong>}
          </div>
          {plan && (
            <span
              className="account-plan"
              title="账户套餐"
            >
              {plans[plan.toLowerCase()] || plan}
            </span>
          )}
        </div>
      )}
      {facts.length > 0 && <Facts fields={facts.slice(0, 6)} />}
      {quotas.length > 0 && (
        <div className="account-quotas">
          {quotas.map((f) => (
              <div
                className={
                  "account-quota" +
                  (f.status === "rate-limited" ? " limited" : "")
                }
                key={f.id}
              >
                <div>
                  <strong>{f.label}</strong>
                  <span>剩余 {Number(f.remainingPercent.toFixed(1))}%</span>
                </div>
                <UsageMeter label={f.label + ' 剩余额度'} value={f.remainingPercent} quota={f} />
                <small>
                  已用 {Number(f.usedPercent.toFixed(1))}%
                  {f.status === "rate-limited" ? " · 已达上限" : ""}
                  {f.resetsAt && (
                    <>
                      {" "}
                      ·{" "}
                      {new Date(f.resetsAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}{" "}
                      重置
                    </>
                  )}
                </small>
              </div>
            ))}
        </div>
      )}
      <div className="account-profile-source">
        {(p.stale || quota.stale) && <small>上次查询结果</small>}
        {p.quotaMode === 'console' && <small>{p.note}</small>}
        {p.infoLinks?.map((link) => (
          <button key={link.id} className="text-button" onClick={() => act('account-info-doc', () => api.call('account-info-doc', link.id))}>
            {link.label}<ExternalLink size={12} />
          </button>
        ))}
        {p.consoleService && (
          <button
            className="text-button"
            onClick={() =>
              act("official-open", () =>
                api.call("official-open", p.consoleService, "console"),
              )
            }
          >
            控制台
            <ExternalLink size={12} />
          </button>
        )}
        {(p.canRefresh || quota.canRefresh) && (
          <button
            className="icon-button"
            title="刷新账户资料（不发送模型请求）"
            aria-label={account.label + " 刷新账户资料"}
            disabled={!!busy || p.refreshing || quota.refreshing}
            onClick={() =>
              act("account-info-" + account.id, () =>
                api.call("account-info", client.id, account.id),
              )
            }
          >
            <RefreshCw
              size={13}
              className={
                busy === "account-info-" + account.id ? "spin" : undefined
              }
            />
          </button>
        )}
      </div>
      {p.error && (
        <p className="account-profile-error" role="alert">
          {p.error}
          {p.updatedAt ? "；保留上次成功资料" : ""}
        </p>
      )}
      {quota !== p && quota.error && quota.error !== p.error && (
        <p className="account-profile-error" role="alert">{quota.error}{quota.updatedAt ? "；保留上次成功用量" : ""}</p>
      )}
      {(p.warning || quota.warning) && <p className="muted tiny" role="status">{p.warning || quota.warning}</p>}
    </section>
  );
}
