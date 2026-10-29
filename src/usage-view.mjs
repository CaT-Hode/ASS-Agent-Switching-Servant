import { accountPlan } from './account-plan.mjs';
import { usageModelName } from '../core/model-name.mjs';
export const CLIENT_NAMES = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "pi",
  dsh: "DSH",
  kimi: "Kimi Code",
  zcode: "ZCode",
};
export const detectedClients = (state) => state.harnesses.clients.filter((c) =>
  c.detected === true || (c.detected === undefined && !!(c.executable || c.launcher?.installed || c.desktop)));
export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function rangeBounds(range, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    start = new Date(end);
  if (range === "week")
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else if (range === "year") start.setDate(start.getDate() - 364);
  else start.setDate(1);
  return { from: dayKey(start), to: dayKey(end), start, end };
}
const empty = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  calls: 0,
  sessions: new Set(),
  observations: 0,
});
function add(to, row) {
  for (const k of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "calls",
  ])
    to[k] += row[k] || 0;
  for (const s of row.sessions || []) to.sessions.add(s);
  to.observations++;
}
// Presentation/grouping only: retain the original IDs in native logs and the
// encrypted usage cache. Historical router IDs are not routing aliases.
export { usageModelName };
export function summarize(rows, options, now = new Date()) {
  const bounds = rangeBounds(options.range, now),
    total = empty(),
    days = new Map(),
    hours = new Map(),
    dailyOnly = new Map(),
    unallocated = empty(),
    groups = new Map();
  const periodHours =
    options.range === "week" ? 1 : options.range === "month" ? 4 : 24;
  const grain = periodHours < 24 ? "hour" : "day";
  const hourKey = (day, hour) => `${day}T${String(hour).padStart(2, "0")}`;
  for (const r of rows) {
    const hasHour = Number.isInteger(r.hour) && r.hour >= 0 && r.hour < 24;
    if (
      r.day < bounds.from ||
      r.day > bounds.to ||
      (options.client !== "all" && r.client !== options.client) ||
      (r.day === bounds.to && hasHour && r.hour > now.getHours())
    )
      continue;
    add(total, r);
    const day = days.get(r.day) || empty();
    add(day, r);
    days.set(r.day, day);
    if (grain === "hour") {
      if (hasHour) {
        const key = hourKey(
            r.day,
            Math.floor(r.hour / periodHours) * periodHours,
          ),
          bucket = hours.get(key) || empty();
        add(bucket, r);
        hours.set(key, bucket);
      } else {
        const bucket = dailyOnly.get(r.day) || empty();
        add(bucket, r);
        add(unallocated, r);
        dailyOnly.set(r.day, bucket);
      }
    }
    const name =
      options.group === "model" ? usageModelName(r.model, r.client) : CLIENT_NAMES[r.client] || r.client;
    const group = groups.get(name) || { name, ...empty() };
    add(group, r);
    groups.set(name, group);
  }
  const timeline = [];
  for (
    let d = new Date(bounds.start);
    d <= bounds.end;
    d.setDate(d.getDate() + 1)
  ) {
    const day = dayKey(d);
    if (grain === "day")
      timeline.push({ key: day, day, ...(days.get(day) || empty()) });
    else {
      const lastHour = day === bounds.to ? now.getHours() : 23;
      for (let hour = 0; hour <= lastHour; hour += periodHours) {
        const key = hourKey(day, hour);
        timeline.push({
          key,
          day,
          hour,
          label: `${day} ${String(hour).padStart(2, "0")}:00–${String(hour + periodHours).padStart(2, "0")}:00`,
          ...(hours.get(key) || empty()),
        });
      }
    }
  }
  return {
    ...bounds,
    range: options.range,
    grain,
    periodHours,
    total,
    timeline,
    unallocated,
    dailyOnly: [...dailyOnly]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, value]) => ({
        key: day + "-daily",
        day,
        label: day + " · 仅按日记录",
        ...value,
      })),
    groups: [...groups.values()].sort(
      (a, b) => b.input + b.output - (a.input + a.output),
    ),
  };
}
// Rank actual displayable data, not query capability or the presence of a key.
export function overviewAccountPriority(row) {
  return row.quotas.length ? 3 : row.amounts.length ? 2 : row.plan && row.plan.toLowerCase() !== "free" ? 1 : 0;
}
const validAmount = (f) =>
  ["number", "string"].includes(typeof f?.value) &&
  String(f.value).trim() !== "" && Number.isFinite(Number(f.value));
export function overviewAccounts(state, clientFilter) {
  const accounts = new Map();
  for (const client of detectedClients(state)) {
    if (clientFilter !== "all" && client.id !== clientFilter) continue;
    for (const a of client.accounts) {
      if (
        !a.ready &&
        a.kind !== "api" &&
        !["expired", "refresh-required"].includes(a.status)
      )
        continue;
      // The same bound API key in several clients has one shared balance.
      const key =
        a.kind === "api" ? "api:" + a.providerId : client.id + ":" + a.id;
      const fields = [...new Map([
          ...(a.profile?.fields || []), ...(a.quota?.fields || []),
        ].map((f) => [f.id, f])).values()],
        quota = a.quota || a.profile;
      const get = (id) => fields.find((f) => f.id === id)?.value;
      const balance = state.balances?.[a.providerId];
      const amounts = fields.filter(
        (f) => (f.id?.startsWith("balance-") || f.id === "remaining") && validAmount(f),
      );
      const row = {
        key,
        account: a,
        client,
        clients: [client.name],
        name: get("email") || get("name") || a.label,
        plan: accountPlan(a),
        quotas: fields.filter((f) => f.kind === "quota" && Number.isFinite(f.remainingPercent)),
        amounts: amounts.length
          ? amounts
          : balance?.ok
            ? (balance.rows || [balance]).filter(validAmount).map((f, i) => ({
                ...f,
                id: "balance-" + i,
              }))
            : [],
        updatedAt: quota?.updatedAt || a.profile?.updatedAt || (balance?.ok ? balance.time : undefined),
        error: quota?.error,
        canRefresh: quota?.canRefresh || a.profile?.canRefresh,
      };
      const previous = accounts.get(key);
      if (previous) {
        const clients = [...new Set([...previous.clients, client.name])];
        // A later binding may have a successful cached query while the first
        // binding is still an empty native API profile. Keep the richer one.
        const best = overviewAccountPriority(row) > overviewAccountPriority(previous) ? row : previous;
        accounts.set(key, { ...best, clients });
      } else accounts.set(key, row);
    }
  }
  return [...accounts.values()].sort((a, b) => overviewAccountPriority(b) - overviewAccountPriority(a));
}
