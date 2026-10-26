import { usageModelName, CLIENT_NAMES } from './usage-view.mjs';
export const PROTOCOL_NAMES = { 'openai-responses': 'Responses', 'openai-chat': 'Chat Completions', anthropic: 'Messages' };
export const clientName = id => id === 'diagnostics' ? '连接测试' : CLIENT_NAMES[id] || '未记录';
export const providerName = row => row.source || '未标注';
export const requestOK = row => row.taskOk ?? row.ok ?? false;
export const requestKey = row => row.requestId || [row.time, row.model, row.source].join(':');
export const phaseName = row => row.phase === 'streaming' ? '生成中' : row.phase === 'waiting-output' ? '等待首输出' : '等待上游';
export const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const fmt = (value, digits = 0) => known(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
export const seconds = value => known(value) ? (value / 1000).toFixed(2) + ' s' : '—';
export function emptyStats() {
  return { calls: 0, completed: 0, running: 0, liveTps: 0, liveTpsSamples: 0, liveEstimated: false, passed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageSamples: 0,
    inputSamples: 0, outputSamples: 0, cacheReadSamples: 0, cacheWriteSamples: 0,
    cacheSamples: 0, cachedInput: 0, cacheReadForRate: 0, tpsSamples: 0, generatedTokens: 0, throughputMs: 0, ttftSamples: 0, ttftTotal: 0 };
}
function add(stats, row) {
  stats.calls++;
  if (row.inProgress) {
    stats.running++;
    if (known(row.tps)) { stats.liveTps += row.tps; stats.liveTpsSamples++; stats.liveEstimated ||= row.tpsEstimated; }
    return;
  }
  stats.completed++; if (requestOK(row)) stats.passed++;
  const usage = row.usage;
  if (known(usage?.inputTokens) || known(usage?.outputTokens)) stats.usageSamples++;
  if (known(usage?.inputTokens)) { stats.input += usage.inputTokens; stats.inputSamples++; }
  if (known(usage?.outputTokens)) { stats.output += usage.outputTokens; stats.outputSamples++; }
  if (known(usage?.cacheWriteTokens)) { stats.cacheWrite += usage.cacheWriteTokens; stats.cacheWriteSamples++; }
  if (known(usage?.cacheReadTokens)) { stats.cacheRead += usage.cacheReadTokens; stats.cacheReadSamples++; }
  if (known(usage?.cacheReadTokens) && known(usage?.inputTokens)) {
    stats.cacheSamples++; stats.cacheReadForRate += usage.cacheReadTokens; stats.cachedInput += usage.inputTokens;
  }
  if (requestOK(row) && known(row.ms) && row.ms > 0 && known(usage?.outputTokens)) {
    stats.tpsSamples++; stats.generatedTokens += usage.outputTokens; stats.throughputMs += row.ms;
  }
  if (known(row.ttftMs)) { stats.ttftSamples++; stats.ttftTotal += row.ttftMs; }
}
export const aggregateTps = stats => stats.throughputMs > 0 ? stats.generatedTokens * 1000 / stats.throughputMs : null;
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
    Math.min(now - 3600000, ...rows.map(row => Date.parse(row.time)));
  const step = (now - start) / 30 || 1;
  const buckets = Array.from({ length: 30 }, (_, i) => ({ time: start + i * step, end: start + (i + 1) * step, ...emptyStats() }));
  for (const row of rows) {
    if (row.inProgress) continue;
    const index = Math.max(0, Math.min(29, Math.floor((Date.parse(row.time) - start) / step)));
    add(buckets[index], row);
  }
  return buckets;
}
