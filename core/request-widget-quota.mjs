import { createHash } from "node:crypto";
import { CLIENT_NAMES } from "./client-registry.cjs";
import { quotaWindowKey } from "./quota-history.mjs";

export const widgetQuotaClients = new Set(["codex", "claude", "antigravity"]);

const periodNames = {
  "5h": "5 小时额度",
  "周": "每周额度",
  weekly: "每周额度",
};
const antigravityGroups = {
  "Gemini Models": "Gemini",
  "Claude and GPT models": "Claude / GPT",
};

function windowName(clientId, field, index) {
  const { group, label } = field;
  let period = Object.hasOwn(periodNames, label) ? periodNames[label] : null;
  if (/^\d+(?:\.\d+)?h$/.test(label)) period = label.slice(0, -1) + " 小时额度";
  else if (/^\d+(?:\.\d+)? 分钟$/.test(label)) period = label + "额度";
  if (clientId === "antigravity" && Object.hasOwn(antigravityGroups, group) && period)
    return antigravityGroups[group] + " · " + period;
  if (clientId === "claude" && /^((?:Claude )?(?:Opus|Sonnet|Haiku|Fable)(?: [0-9.]+)?) 周额度$/i.test(label))
    return label;
  if (clientId === "codex" && /^gpt-[0-9][a-z0-9.-]*-codex(?:-spark)?$/i.test(group) && period)
    return group + " · " + period;
  return period ? (group ? `额度组 ${index + 1} · ${period}` : period) : `额度窗口 ${index + 1}`;
}

export function widgetQuotaChoices(clients) {
  const choices = new Map();
  for (const client of clients) {
    if (!widgetQuotaClients.has(client.id)) continue;
    const accounts = client.accounts.filter(account => account.authType === "oauth" && account.quota?.remote);
    for (const [accountIndex, account] of accounts.entries()) {
      const accountId = account.oauthRecordId || account.id;
      if (!accountId) continue;
      const fields = (account.quota.fields || []).filter(field => field.kind === "quota" &&
        typeof field.id === "string" && typeof field.label === "string" &&
        Number.isFinite(field.remainingPercent) && field.remainingPercent >= 0 && field.remainingPercent <= 100);
      for (const [index, field] of fields.entries()) {
        const id = createHash("sha256").update(JSON.stringify([client.id, accountId, quotaWindowKey(field)])).digest("hex");
        if (choices.has(id)) continue;
        const label = [CLIENT_NAMES[client.id], windowName(client.id, field, index),
          ...(accounts.length > 1 ? [`账户 ${accountIndex + 1}`] : [])].join(" · ");
        const reset = typeof field.resetsAt === "string" ? Date.parse(field.resetsAt) : NaN;
        choices.set(id, {
          id,
          label,
          period: field.label === "5h" ? "5h" : ["周", "weekly"].includes(field.label) ||
            field.label.endsWith(" 周额度") ? "weekly" : null,
          remainingPercent: field.remainingPercent,
          resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
        });
      }
    }
  }
  return [...choices.values()];
}

export function currentWidgetQuotaBar(choice, now) {
  if (!choice) return { label: "额度暂不可用", period: null, remainingPercent: null, resetsAt: null };
  const { label, period, remainingPercent, resetsAt } = choice;
  if (resetsAt && Date.parse(resetsAt) <= now) return { label, period, remainingPercent: null, resetsAt: null };
  return { label, period, remainingPercent, resetsAt };
}

export function selectedWidgetQuotaBars(ids, choices, now = Date.now()) {
  return ids.map(id => currentWidgetQuotaBar(choices.find(item => item.id === id), now));
}
