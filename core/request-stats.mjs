export const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Sub-second bursts do not provide the one-second receive sample used by live
// TPS. Apply the same rule to completed rows and their archive aggregates.
export const visibleTps = (tokens, ms) => known(tokens) && known(ms) && ms >= 1000 ? tokens * 1000 / ms : null;
export const requestOK = row => row.taskOk ?? row.ok ?? false;
export function emptyStats() {
  return { calls: 0, completed: 0, running: 0, liveTps: 0, liveTpsSamples: 0, liveEstimated: false, passed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageSamples: 0,
    inputSamples: 0, outputSamples: 0, cacheReadSamples: 0, cacheWriteSamples: 0,
    cacheSamples: 0, cachedInput: 0, cacheReadForRate: 0, tpsSamples: 0, visibleTokens: 0, visibleMs: 0, tpsEstimated: false, ttftSamples: 0, ttftTotal: 0 };
}
export function addRequestStats(stats, row) {
  if (row.stats) {
    for (const key of Object.keys(stats)) {
      if (typeof stats[key] === 'boolean') stats[key] ||= row.stats[key] === true;
      else if (known(row.stats[key])) stats[key] += row.stats[key];
    }
    return;
  }
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
  if (requestOK(row) && visibleTps(row.visibleTokens, row.visibleMs) !== null) {
    stats.tpsSamples++; stats.visibleTokens += row.visibleTokens; stats.visibleMs += row.visibleMs;
    stats.tpsEstimated ||= row.tpsEstimated === true;
  }
  if (known(row.ttftMs)) { stats.ttftSamples++; stats.ttftTotal += row.ttftMs; }
}
