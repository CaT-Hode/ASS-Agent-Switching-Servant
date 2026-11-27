import { createHash } from "node:crypto";
import { CLIENT_NAMES } from "./client-registry.cjs";
import { quotaWindowKey } from "./quota-history.mjs";

export const widgetQuotaClients = new Set(["codex", "claude", "antigravity"]);

const antigravityGroups = {
  "Gemini Models": "Gemini",
  "Claude and GPT models": "Claude / GPT",
};

function windowName(clientId, field, index) {
  const { group, label } = field;
  const client = CLIENT_NAMES[clientId];
  const duration = /^(\d+(?:\.\d+)?)(h| 分钟)$/.exec(label);
  let period = label === "周" || label === "weekly" ? "Weekly" : null;
  if (duration) {
    const [, value, unit] = duration;
    const name = unit === "h" ? "Hour" : "Minute";
    period = value + " " + name + (Number(value) === 1 ? "" : "s");
  }
  if (clientId === "antigravity" && Object.hasOwn(antigravityGroups, group) && period)
    return antigravityGroups[group] + " · " + period;
  if (clientId === "claude") {
    const model = /^(?:Claude )?((?:Opus|Sonnet|Haiku|Fable)(?: [0-9.]+)?) 周额度$/i.exec(label)?.[1];
    if (model) return `${client} · ${model} Weekly`;
  }
  if (clientId === "codex" && /^gpt-[0-9][a-z0-9.-]*-codex(?:-spark)?$/i.test(group) && period)
    return `${client} · ${group} · ${period}`;
  if (!period) return `${client} · Window ${index + 1}`;
  return group ? `${client} · Group ${index + 1} · ${period}` : `${client} · ${period}`;
}

function knownCodexWindows(keys) {
  return keys.flatMap(key => {
    try {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 3 || parts.some(value => typeof value !== "string")) return [];
      const [id, group, label] = parts;
      return [{ id, group, label, remainingPercent: null }];
    } catch { return []; }
  });
}

export function widgetQuotaChoices(clients, readCodexWindowKeys = () => []) {
  const choices = new Map();
  for (const client of clients) {
    if (!widgetQuotaClients.has(client.id)) continue;
    const accounts = client.accounts.flatMap(account => {
      if (account.authType !== "oauth") return [];
      if (account.quota?.remote) {
        const fields = (account.quota.fields || []).filter(field => field.kind === "quota" &&
          typeof field.id === "string" && typeof field.label === "string" &&
          Number.isFinite(field.remainingPercent) && field.remainingPercent >= 0 && field.remainingPercent <= 100);
        return [{ account, fields }];
      }
      const fields = client.id === "codex" ? knownCodexWindows(readCodexWindowKeys(client, account)) : [];
      return fields.length ? [{ account, fields }] : [];
    });
    for (const [accountIndex, { account, fields }] of accounts.entries()) {
      // AGY quota observations and existing widget selections use the native account ID.
      const accountId = client.id === "antigravity" ? account.id : account.oauthRecordId || account.id;
      if (!accountId) continue;
      for (const [index, field] of fields.entries()) {
        const id = createHash("sha256").update(JSON.stringify([client.id, accountId, quotaWindowKey(field)])).digest("hex");
        if (choices.has(id)) continue;
        const window = windowName(client.id, field, index);
        const label = accounts.length > 1 ? `${window} · Account ${accountIndex + 1}` : window;
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
  if (!choice) return { label: "Quota Unavailable", period: null, remainingPercent: null, resetsAt: null };
  const { label, period, remainingPercent, resetsAt } = choice;
  if (resetsAt && Date.parse(resetsAt) <= now) return { label, period, remainingPercent: null, resetsAt: null };
  return { label, period, remainingPercent, resetsAt };
}

export function selectedWidgetQuotaBars(ids, choices, now = Date.now()) {
  return ids.map(id => currentWidgetQuotaBar(choices.find(item => item.id === id), now));
}
