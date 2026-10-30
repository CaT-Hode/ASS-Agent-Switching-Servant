const fs = require('node:fs'), path = require('node:path');
const { requestTps, visibleOutputTokens } = require('./request-metrics.cjs');
const { atomic } = require('./config.cjs');
const { emptyStats, addRequestStats, requestOK, visibleTps } = require('./request-stats.mjs');
const MAX_RECORDS = 200;
// The monitor reads only numeric
// measurements and routing labels; it never exposes raw upstream payloads.
function publicRecord(record) {
  if (!record || typeof record.model !== 'string' || !record.model) return null;
  const result = {};
  for (const key of ['time', 'source', 'model', 'status', 'ms', 'ok', 'httpStatus', 'httpOk', 'taskOk',
    'error', 'requestId', 'client', 'protocol', 'providerId', 'operation', 'ttftMs', 'generationMs', 'startedAt']) {
    if (['string', 'number', 'boolean'].includes(typeof record[key]) || record[key] === null) result[key] = record[key];
  }
  if (record.usage && typeof record.usage === 'object') result.usage = Object.fromEntries(
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
      .filter(key => Number.isSafeInteger(record.usage[key]) && record.usage[key] >= 0).map(key => [key, record.usage[key]]));
  const hasVisibleCount = Number.isSafeInteger(record.visibleTokens) && record.visibleTokens >= 0;
  result.visibleTokens = hasVisibleCount ? record.visibleTokens : visibleOutputTokens(result.usage);
  result.visibleMs = Number.isFinite(record.visibleMs) && record.visibleMs >= 0 ? record.visibleMs : null;
  result.tpsEstimated = hasVisibleCount && record.tpsEstimated === true;
  // Older logs did not separate visible timing from reasoning. Keep that speed
  // unknown, rather than reuse a whole-request or mixed reasoning interval.
  result.tps = visibleTps(result.visibleTokens, result.visibleMs);
  result.endToEndTps = requestTps(result.usage?.outputTokens, result.ms);
  return result;
}
class RequestHistory {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'requests.jsonl'); this.rows = []; this.revision = 0; this.error = '';
    this.stateFile = path.join(dataDir, 'request-history.json');
    this.archive = new Map(); this.archived = 0; this.archiveView = null;
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.rows) || !Array.isArray(state.archive)) throw Error('Invalid history');
      for (const bucket of state.archive) {
        if (!bucket.model || !Number.isFinite(Date.parse(bucket.time)) || !Number.isSafeInteger(bucket.stats?.calls) || bucket.stats.calls < 1)
          throw Error('Invalid archive');
        const stats = emptyStats(); addRequestStats(stats, bucket);
        if (state.tpsVersion !== 2) {
          // Old aggregates mixed measured streams with sub-second buffered
          // bursts. Their individual timings no longer exist; retain all token
          // and request totals, but do not present the mixed speed as measured.
          stats.tpsSamples = stats.visibleTokens = stats.visibleMs = 0; stats.tpsEstimated = false;
        }
        this.archive.set(this.archiveKey(bucket), { ...bucket, stats }); this.archived += stats.calls;
      }
      for (const record of state.rows) { const row = publicRecord(record); if (row) this.accept(row); }
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.archive.clear();this.archived = 0;this.rows = [];
        this.archiveReadError = '请求归档无法读取，已保留原文件；当前仅显示可读取的明细。';
        this.error = this.archiveReadError;
      }
    }
    let compact = false;
    for (const file of [this.file + '.previous', this.file]) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (file !== this.file) compact = true;
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          try { const row = publicRecord(JSON.parse(line)); if (row) {
            if (this.rows.length >= MAX_RECORDS) compact = true;
            this.accept(row);
          } }
          catch { this.error = '部分旧请求记录无法读取，已保留其余记录。'; }
        }
      } catch (error) { if (error.code !== 'ENOENT') this.error = '请求历史暂不可读，仍会显示本次运行的新请求。'; }
    }
    if (compact) {
      try { this.persist(); }
      catch { this.error = this.archiveReadError || '请求归档保存失败，当前运行的统计仍可用。'; }
    }
  }
  archiveKey(row) { return JSON.stringify([row.time, row.model, row.source, row.client, row.ok]); }
  accept(row) {
    this.rows.push(row);
    if (this.rows.length <= MAX_RECORDS) return;
    const retired = this.rows.shift(), timestamp = Date.parse(retired.time);
    if (!Number.isFinite(timestamp) || retired.operation === 'count_tokens') return;
    const label = { time: new Date(Math.floor(timestamp / 60000) * 60000).toISOString(), model: retired.model,
      source: retired.source || '未标注', client: retired.client || 'unknown', ok: requestOK(retired) };
    const key = this.archiveKey(label);
    if (!this.archive.has(key)) this.archive.set(key, { ...label, stats: emptyStats() });
    addRequestStats(this.archive.get(key).stats, retired); this.archived++; this.archiveView = null;
  }
  persist() {
    if (this.archiveReadError) throw Error(this.archiveReadError);
    // One atomic ledger owns both the archive and the retained tail. The JSONL
    // below is a compatibility mirror, never re-imported once the ledger exists.
    // This prevents counting an evicted row twice after an interrupted mirror write.
    atomic(this.stateFile, JSON.stringify({ version: 1, tpsVersion: 2, archive: this.snapshot().archive, rows: this.rows },
      (key, value) => key === 'stats' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== 0 && v !== false)) : value));
    atomic(this.file, this.rows.map(row => JSON.stringify(row) + '\n').join(''));
    fs.rmSync(this.file + '.previous', { force: true });
  }
  append(record) {
    const row = publicRecord(record);
    if (!row) return;
    this.accept(row); this.revision++;
    try {
      this.persist();
    } catch { this.error = this.archiveReadError || '请求历史写入失败，当前运行的监控仍可用，重启后可能缺少记录。'; }
  }
  snapshot() {
    this.archiveView ||= [...this.archive.values()];
    return { rows: this.rows, archive: this.archiveView, archived: this.archived, revision: this.revision, error: this.error, limit: MAX_RECORDS };
  }
}
module.exports = { RequestHistory, publicRecord };
