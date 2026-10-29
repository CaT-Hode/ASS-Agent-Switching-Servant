import { usageModelName, CLIENT_NAMES } from './usage-view.mjs';
import { known, requestOK, emptyStats, addRequestStats as add } from '../core/request-stats.mjs';
export { known, requestOK, emptyStats };
export const PROTOCOL_NAMES = { 'openai-responses': 'Responses', 'openai-chat': 'Chat Completions', anthropic: 'Messages' };
export const clientName = id => id === 'diagnostics' ? '连接测试' : CLIENT_NAMES[id] || '未记录';
export const providerName = row => row.source || '未标注';
export const requestKey = row => row.requestId || [row.time, row.model, row.source].join(':');
export const phaseName = row => row.phase === 'streaming' ? '生成中' : row.phase === 'waiting-output' ? '等待首输出' : '等待上游';
export const fmt = (value, digits = 0) => known(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
export const seconds = value => known(value) ? (value / 1000).toFixed(2) + ' s' : '—';
export const aggregateTps = stats => stats.visibleMs > 0 ? stats.visibleTokens * 1000 / stats.visibleMs : null;
export const currentTps = stats => stats.running ? stats.liveTpsSamples ? stats.liveTps : null : aggregateTps(stats);
export const cacheRate = stats => stats.cacheSamples && stats.cachedInput > 0 ? stats.cacheReadForRate / stats.cachedInput * 100 : null;
export const meanTtft = stats => stats.ttftSamples ? stats.ttftTotal / stats.ttftSamples : null;
export function monitorRows(rows, options, now = Date.now()) {
  const since = options.range === 'hour' ? now - 3600000 : options.range === 'day' ? now - 86400000 : options.range === 'week' ? now - 7 * 86400000 : 0;
  const query = (options.search || '').trim().toLowerCase();
  return rows.filter(row => row.model && Date.parse(row.time) >= since && Date.parse(row.time) <= now &&
    (options.diagnostics || row.client !== 'diagnostics') && row.operation !== 'count_tokens' &&
    (options.provider === 'all' || providerName(row) === options.provider) &&
    (options.client === 'all' || (row.client || 'unknown') === options.client) &&
    (options.status === 'all' || (options.status === 'running' ? row.inProgress : !row.inProgress && requestOK(row) === (options.status === 'success'))) &&
    (!query || [usageModelName(row.model), providerName(row), clientName(row.client), row.model, row.requestId].some(value => value?.toLowerCase().includes(query))))
    .sort((a, b) => Number(!!b.inProgress) - Number(!!a.inProgress) || Date.parse(b.time) - Date.parse(a.time));
}
export function summarizeRequests(rows, group = 'model') {
  const total = emptyStats(), groups = new Map();
  for (const row of rows) {
    add(total, row);
    const name = group === 'provider' ? providerName(row) : usageModelName(row.model);
    if (!groups.has(name)) groups.set(name, { name, providers: new Set(), models: new Set(), ...emptyStats() });
    const entry = groups.get(name); add(entry, row);
    entry.providers.add(providerName(row)); entry.models.add(usageModelName(row.model));
  }
  return { total, groups: [...groups.values()].sort((a, b) => b.calls - a.calls) };
}
export function requestTimeline(rows, range, now = Date.now()) {
  const start = range === 'hour' ? now - 3600000 : range === 'day' ? now - 86400000 : range === 'week' ? now - 7 * 86400000 :
    rows.reduce((start, row) => Math.min(start, Date.parse(row.time)), now - 3600000);
  const step = (now - start) / 30 || 1;
  const buckets = Array.from({ length: 30 }, (_, i) => ({ time: start + i * step, end: start + (i + 1) * step, ...emptyStats() }));
  for (const row of rows) {
    if (row.inProgress) continue;
    const index = Math.max(0, Math.min(29, Math.floor((Date.parse(row.time) - start) / step)));
    add(buckets[index], row);
  }
  return buckets;
}
