import { usageModelName } from './model-name.mjs';
import { shortVisibleSample } from './request-stats.mjs';
const known = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const number = v => known(v) ? v : 0;
const key = row => row.requestId || [row.time, row.source, row.model].join(':');
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const eligible = row => row.model && row.client !== 'diagnostics' && row.operation !== 'count_tokens';
export const widgetProviderName = name => (typeof name === 'string' ? name.replace(/官方/g, '').replace(/\s+/g, ' ').trim() : '') || '未标注';
export const WIDGET_FRAME_INSET = 6;
export const WIDGET_ROW_HEIGHT = 27;
export const WIDGET_SECTION_GAP = 4;
export const WIDGET_USAGE_HEIGHT = 22;
export const WIDGET_QUOTA_HEIGHT = 24;
export const WIDGET_MAX_RADIUS = 48;
export const WIDGET_GLASS_DEFAULTS = { bezelWidth: 18, distortion: 40 };
export const WIDGET_GLASS_LIMITS = { bezelWidth: [6, 64], distortion: [0, 100] };
const WIDGET_WIDTH_INSET = 52;
export const widgetWidth = width => width - WIDGET_WIDTH_INSET;
export const widgetWidthSetting = visible => visible + WIDGET_WIDTH_INSET;
export const widgetHeatRadius = radius => Math.max(4, Math.min(8, Math.round(radius / 6)));
export const widgetQuotaHeight = count => count * (WIDGET_SECTION_GAP + WIDGET_QUOTA_HEIGHT);
export function widgetContentInsets(radius = 36) {
  const inset = Math.round((radius - 36) * 2 / 3);
  return { horizontal: Math.max(6, 10 + inset), top: Math.max(4, 8 + inset), bottom: Math.max(6, 10 + inset) };
}
export const widgetHeight = (count, capacity, width = 340, showHeatmap = true, showUsage = false, quotaCount = 0, radius) => {
  const { top, bottom } = widgetContentInsets(radius);
  const rows = Math.max(1, Math.min(capacity, count));
  const heat = showHeatmap ? WIDGET_SECTION_GAP + widgetHeatHeight(width, radius) : 0;
  const usage = showUsage ? WIDGET_SECTION_GAP + WIDGET_USAGE_HEIGHT : 0;
  return Math.ceil(2 * WIDGET_FRAME_INSET + top + rows * WIDGET_ROW_HEIGHT + heat + usage + widgetQuotaHeight(quotaCount) + bottom);
};
// The 2x12 heatmap uses square cells; derive its DIP height from the same
// inner width used by the renderer so the window fits the heatmap.
export const widgetHeatHeight = (width = 340, radius) => {
  const inner = widgetWidth(width) - 2 * (WIDGET_FRAME_INSET + widgetContentInsets(radius).horizontal);
  return Math.max(32, (inner - 33) / 6 + 3);
};
export const widgetDuration = ms => Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) + 's' : '—';
const rowFields = ['id', 'model', 'rawModel', 'provider', 'client', 'inProgress', 'phase', 'ok', 'ms', 'tps', 'endToEndTps', 'estimated', 'shortSample', 'cache', 'input', 'output', 'error'];
const sameRow = (a, b) => rowFields.every(key => Object.is(a[key], b[key]));
export function motionRows(previous, rows) {
  const incoming = new Map(rows.map((row, index) => [row.id, { row, index, exiting: false }]));
  const next = previous.map(item => {
    const current = incoming.get(item.row.id);
    if (!current) return item.exiting ? item : { ...item, exiting: true };
    const row = sameRow(item.row, current.row) ? item.row : current.row;
    return row === item.row && item.index === current.index && !item.exiting
      ? item : { ...item, row, index: current.index, exiting: false };
  });
  const retained = new Set(next.map(item => item.row.id));
  for (const item of incoming.values()) if (!retained.has(item.row.id)) next.push(item);
  return next.length === previous.length && next.every((item, index) => item === previous[index]) ? previous : next;
}
const ORPHAN_GRACE_MS = 2500;
export class WidgetRequests {
  constructor() { this.slots = [];this.seen = new Map(); }
  update(active, history, now) {
    const rows = [...history, ...active].filter(eligible), latest = new Map(rows.map(row => [key(row), row]));
    for (const slot of this.slots) {
      const row = latest.get(slot.id);
      if (row) {
        slot.missingSince = null;
        slot.row = row;
        if (!row.inProgress && slot.finished === null) {
          slot.finished = now;
          const rowTs = Date.parse(row.time);
          this.seen.set(slot.id, Math.max(now, Number.isFinite(rowTs) ? rowTs : now) + 17000);
        }
      } else if (slot.finished === null) {
        // A native Hook has no matching history ID. Clear it as soon as it leaves `active`.
        // Other requests can still receive a matching history record after a short delay.
        slot.missingSince ??= now;
        if (slot.row.observation === 'antigravity-hook' || now - slot.missingSince >= ORPHAN_GRACE_MS) {
          slot.orphan = true;
          this.seen.set(slot.id, now + 17000);
        }
      }
    }
    this.slots = this.slots.filter(slot => !slot.orphan);
    const existing = new Set(this.slots.map(slot => slot.id));
    for (const [id, expiry] of this.seen) if (expiry < now && !existing.has(id)) this.seen.delete(id);
    const added = [...latest.values()].filter(row => !existing.has(key(row)) && !this.seen.has(key(row)) && (row.inProgress || now - Date.parse(row.time) < 15000));
    for (const row of added) {
      const id = key(row);if (existing.has(id)) continue;existing.add(id);
      const parsedTime = Date.parse(row.time);
      const finishedAt = Number.isFinite(parsedTime) ? Math.min(now, parsedTime) : now;
      const slot = { id, row, finished: row.inProgress ? null : finishedAt, missingSince: null };
      this.seen.set(id, row.inProgress ? Infinity : finishedAt + 17000);
      const reusable = this.slots.reduce((best, item, i) => item.finished !== null &&
        (best < 0 || item.finished < this.slots[best].finished) ? i : best, -1);
      if (reusable < 0) this.slots.push(slot);else this.slots[reusable] = slot;
    }
    // Each completed row rests in place for 15 s (reusable by incoming requests)
    // and then leaves independently so newer requests never trap older completed rows.
    this.slots = this.slots.filter(slot => slot.finished === null || now - slot.finished < 15000);
    return this.slots.map(({ id, row }) => ({ id, model: usageModelName(row.model, row.client), rawModel: row.model,
      provider: widgetProviderName(row.source), client: row.client, inProgress: !!row.inProgress,
      phase: row.phase, ok: row.taskOk ?? row.ok, ms: row.ms,
      tps: known(row.tps) ? row.tps : null, endToEndTps: known(row.endToEndTps) ? row.endToEndTps : null,
      estimated: row.tpsEstimated === true, shortSample: shortVisibleSample(row),
      cache: known(row.usage?.inputTokens) && row.usage.inputTokens > 0 && known(row.usage?.cacheReadTokens)
        ? Math.min(100, row.usage.cacheReadTokens / row.usage.inputTokens * 100) : null,
      input: row.usage?.inputTokens, output: row.usage?.outputTokens, error: row.error,
    }));
  }
}
export function todayHeatmap(usage, requests, now) {
  const date = new Date(now), day = dayKey(date), bins = Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0, input: 0, output: 0 }));
  let unallocatedInput = 0, unallocatedOutput = 0;
  for (const row of usage.rows || []) if (row.day === day) {
    const input = number(row.input), output = number(row.output);
    if (Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= date.getHours()) {
      const bin = bins[row.hour];bin.tokens += input + output;bin.input += input;bin.output += output;
    } else if (!Number.isInteger(row.hour)) {
      unallocatedInput += input;unallocatedOutput += output;
    }
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
  const input = bins.reduce((sum, bin) => sum + bin.input, unallocatedInput);
  const output = bins.reduce((sum, bin) => sum + bin.output, unallocatedOutput);
  return { day, unallocated: unallocatedInput + unallocatedOutput, total: input + output, input, output, cells: bins.map(bin => ({ ...bin,
    level: bin.tokens ? Math.max(1, Math.ceil(Math.sqrt(bin.tokens / maximum) * 4)) : 0,
    future: bin.hour > date.getHours(),
    current: bin.hour === date.getHours(),
  })) };
}
