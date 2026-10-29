import { usageModelName } from './model-name.mjs';
const known = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const number = v => known(v) ? v : 0;
const key = row => row.requestId || [row.time, row.source, row.model].join(':');
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const eligible = row => row.model && row.client !== 'diagnostics' && row.operation !== 'count_tokens';
export const widgetHeight = (count, capacity) => 130 + Math.max(1, Math.min(capacity, count)) * 29;
export function motionRows(previous, rows) {
  const incoming = new Map(rows.map((row, index) => [row.id, { row, index, exiting: false }]));
  const next = previous.map(item => incoming.get(item.row.id) || { ...item, exiting: true });
  const retained = new Set(next.map(item => item.row.id));
  for (const item of incoming.values()) if (!retained.has(item.row.id)) next.push(item);
  return next;
}
export class WidgetRequests {
  constructor() { this.slots = [];this.seen = new Map(); }
  update(active, history, now) {
    const rows = [...history, ...active].filter(eligible), latest = new Map(rows.map(row => [key(row), row]));
    for (const slot of this.slots) {
      const row = latest.get(slot.id);
      if (row) { slot.row = row;if (!row.inProgress && slot.finished === null) { slot.finished = now;this.seen.set(slot.id, now + 15000); } }
    }
    const existing = new Set(this.slots.map(slot => slot.id));
    for (const [id, expiry] of this.seen) if (expiry < now && !existing.has(id)) this.seen.delete(id);
    const added = [...latest.values()].filter(row => !existing.has(key(row)) && !this.seen.has(key(row)) && (row.inProgress || now - Date.parse(row.time) < 15000));
    for (const row of added) {
      const id = key(row);if (existing.has(id)) continue;existing.add(id);
      const slot = { id, row, finished: row.inProgress ? null : Date.parse(row.time) };
      this.seen.set(id, row.inProgress ? Infinity : slot.finished + 15000);
      const reusable = this.slots.reduce((best, item, i) => item.finished !== null &&
        (best < 0 || item.finished < this.slots[best].finished) ? i : best, -1);
      if (reusable < 0) this.slots.push(slot);else this.slots[reusable] = slot;
    }
    // Clear a completed batch after its last completion has rested for 15 s.
    // New requests can reuse completed slots immediately without moving others.
    const finished = this.slots.filter(slot => slot.finished !== null);
    if (finished.length && now - Math.max(...finished.map(slot => slot.finished)) >= 15000)
      this.slots = this.slots.filter(slot => slot.finished === null);
    return this.slots.map(({ id, row }) => ({ id, model: usageModelName(row.model), rawModel: row.model,
      provider: row.source || '未标注', client: row.client, inProgress: !!row.inProgress,
      phase: row.phase, ok: row.taskOk ?? row.ok, ms: row.ms,
      tps: known(row.tps) ? row.tps : null, estimated: row.tpsEstimated === true,
      cache: known(row.usage?.inputTokens) && row.usage.inputTokens > 0 && known(row.usage?.cacheReadTokens)
        ? Math.min(100, row.usage.cacheReadTokens / row.usage.inputTokens * 100) : null,
      input: row.usage?.inputTokens, output: row.usage?.outputTokens, error: row.error,
    }));
  }
}
export function todayHeatmap(usage, requests, now) {
  const date = new Date(now), day = dayKey(date), bins = Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0, input: 0, output: 0 }));
  let unallocated = 0;
  for (const row of usage.rows || []) if (row.day === day) {
    const tokens = number(row.input) + number(row.output);
    if (Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= date.getHours()) {
      const bin = bins[row.hour];bin.tokens += tokens;bin.input += number(row.input);bin.output += number(row.output);
    }
    else if (Number.isInteger(row.hour)) continue;
    else unallocated += tokens;
  }
  const cutoff = Date.parse(usage.updatedAt) || 0;
  // Fill the interval since the canonical usage scan; a new scan replaces it.
  for (const row of requests.filter(eligible)) {
    const time = new Date(row.time);
    if (+time > cutoff && +time <= now && dayKey(time) === day) {
      const bin = bins[time.getHours()];bin.input += number(row.usage?.inputTokens);bin.output += number(row.usage?.outputTokens);
      bin.tokens += number(row.usage?.inputTokens) + number(row.usage?.outputTokens);
    }
  }
  const maximum = Math.max(1, ...bins.map(bin => bin.tokens));
  return { day, unallocated, total: bins.reduce((sum, bin) => sum + bin.tokens, unallocated), cells: bins.map(bin => ({ ...bin,
    level: bin.tokens ? Math.max(1, Math.ceil(Math.sqrt(bin.tokens / maximum) * 4)) : 0,
    future: bin.hour > date.getHours(),
  })) };
}
