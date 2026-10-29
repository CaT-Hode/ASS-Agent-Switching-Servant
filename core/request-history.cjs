const fs = require('node:fs'), path = require('node:path');
const { requestTps, visibleOutputTokens } = require('./request-metrics.cjs');
const { atomic } = require('./config.cjs');
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
  result.tps = requestTps(result.visibleTokens, result.visibleMs);
  result.endToEndTps = requestTps(result.usage?.outputTokens, result.ms);
  return result;
}
class RequestHistory {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'requests.jsonl'); this.rows = []; this.revision = 0; this.error = '';
    let compact = false;
    for (const file of [this.file + '.previous', this.file]) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (file !== this.file) compact = true;
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          try { const row = publicRecord(JSON.parse(line)); if (row) {
            this.rows.push(row);
            if (this.rows.length > MAX_RECORDS) { this.rows.shift();compact = true; }
          } }
          catch { this.error = '部分旧请求记录无法读取，已保留其余记录。'; }
        }
      } catch (error) { if (error.code !== 'ENOENT') this.error = '请求历史暂不可读，仍会显示本次运行的新请求。'; }
    }
    if (compact) {
      try { this.persist(); }
      catch { this.error = '旧请求明细清理失败，当前仅显示最近 200 条。'; }
    }
  }
  persist() {
    atomic(this.file, this.rows.map(row => JSON.stringify(row) + '\n').join(''));
    fs.rmSync(this.file + '.previous', { force: true });
  }
  append(record) {
    const row = publicRecord(record);
    if (!row) return;
    this.rows.push(row); if (this.rows.length > MAX_RECORDS) this.rows.shift(); this.revision++;
    try {
      this.persist();
    } catch { this.error = '请求历史写入失败，当前运行的监控仍可用，重启后可能缺少记录。'; }
  }
  snapshot() { return { rows: this.rows, revision: this.revision, error: this.error, limit: MAX_RECORDS }; }
}
module.exports = { RequestHistory, publicRecord };
