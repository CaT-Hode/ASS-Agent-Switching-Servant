const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { requestTps, visibleOutputTokens } = require('./request-metrics.cjs');
const { emptyStats, addRequestStats, isNativeObservation, requestOK, visibleTps } = require('./request-stats.mjs');
const { failureDetails } = require('./diagnostic-failure.cjs');
const { upstreamRequestId } = require('./http-passthrough.cjs');
const MAX_RECORDS = 200;
const WRITE_ERROR = '请求历史写入失败，当前运行的监控仍可用，重启后可能缺少记录。';
const compactStats = stats => Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== 0 && value !== false));
// Persist only metrics, routing labels and bounded diagnostic fields.
function publicRecord(record) {
  if (!record || typeof record.model !== 'string' || !record.model) return null;
  const result = {};
  for (const key of ['time', 'source', 'model', 'status', 'ms', 'ok', 'httpStatus', 'httpOk', 'taskOk',
    'error', 'requestId', 'client', 'protocol', 'providerId', 'operation', 'ttftMs', 'generationMs', 'startedAt']) {
    if (['string', 'number', 'boolean'].includes(typeof record[key]) || record[key] === null) result[key] = record[key];
  }
  const upstreamId = upstreamRequestId({ 'x-request-id': record.upstreamRequestId }) ?? upstreamRequestId(record.upstream?.headers);
  if (upstreamId) result.upstreamRequestId = upstreamId;
  const failure = failureDetails(record.failure ?? record.diagnostic?.failure);
  if (failure) {
    const { kind, layer, label, code } = failure;
    result.failure = { kind, layer, label, ...(code ? { code } : {}) };
  }
  if (record.observation === 'antigravity-transcript' || record.observation === 'antigravity-hook')
    result.observation = record.observation;
  if (record.timingSource === 'hook' && result.observation === 'antigravity-hook') result.timingSource = 'hook';
  const native = isNativeObservation(result);
  if (native) {
    // Old transcript rows copied HTTP success and supplied a task duration
    // without a matched start event. Their token counts remain usable.
    result.observation ??= 'antigravity-transcript';
    result.httpStatus = result.httpOk = result.status = result.ttftMs = result.generationMs = null;
    if (result.timingSource !== 'hook') {
      result.ms = null;
      delete result.startedAt;
    }
  }
  if (record.usage && typeof record.usage === 'object') result.usage = Object.fromEntries(
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
      .filter(key => Number.isSafeInteger(record.usage[key]) && record.usage[key] >= 0).map(key => [key, record.usage[key]]));
  const hasVisibleCount = Number.isSafeInteger(record.visibleTokens) && record.visibleTokens >= 0;
  result.visibleTokens = native ? null : hasVisibleCount ? record.visibleTokens : visibleOutputTokens(result.usage);
  result.visibleMs = !native && Number.isFinite(record.visibleMs) && record.visibleMs >= 0 ? record.visibleMs : null;
  result.tpsEstimated = !native && hasVisibleCount && record.tpsEstimated === true;
  // Older logs did not separate visible timing from reasoning. Keep that speed
  // unknown, rather than reuse a whole-request or mixed reasoning interval.
  result.tps = visibleTps(result.visibleTokens, result.visibleMs);
  result.endToEndTps = native ? null : requestTps(result.usage?.outputTokens, result.ms);
  return result;
}
class RequestHistory {
  constructor(dataDir) {
    this.rows = []; this.revision = 0; this.error = ''; this.lastId = 0;
    this.pending = new Map(); this.dirtyBuckets = new Set();
    this.archive = new Map(); this.archived = 0; this.archiveView = null;
    const filename = path.join(dataDir, 'request-history.sqlite');
    try {
      this.db = new DatabaseSync(filename);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version === 1) {
        for (const { id, record } of this.db.prepare('SELECT id, record FROM tail ORDER BY id').iterate()) {
          const stored = JSON.parse(record);
          const row = isNativeObservation(stored) ? publicRecord(stored) : stored;
          if (row) this.rows.push(row);
          this.lastId = id;
        }
        for (const { key, bucket } of this.db.prepare('SELECT key, bucket FROM archive ORDER BY rowid').iterate()) {
          const value = JSON.parse(bucket);
          this.archive.set(key, value); this.archived += value.stats.calls;
        }
      } else if (version === 0) {
        this.readLegacy(dataDir);
        if (this.archiveReadError) { this.close(); return; }
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.transaction(() => {
          this.db.exec(`CREATE TABLE tail (id INTEGER PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE archive (key TEXT PRIMARY KEY, bucket TEXT NOT NULL);`);
          this.prepareWrites();
          for (const row of this.rows) this.saveRow.run(++this.lastId, JSON.stringify(row));
          for (const [key, bucket] of this.archive) this.saveBucket.run(key, JSON.stringify(bucket));
          this.db.exec('PRAGMA user_version = 1');
        });
        return;
      } else {
        throw Error('Unsupported request history');
      }
      this.db.exec('PRAGMA synchronous = FULL');
      this.prepareWrites();
    } catch {
      this.close();
      this.error = this.archiveReadError || WRITE_ERROR;
    }
  }
  readLegacy(dataDir) {
    const file = path.join(dataDir, 'requests.jsonl');
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'request-history.json'), 'utf8'));
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
        this.archive.set(this.archiveKey(bucket), { ...bucket, stats: compactStats(stats) }); this.archived += stats.calls;
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
    for (const source of [file + '.previous', file]) {
      try {
        const text = fs.readFileSync(source, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          try { const row = publicRecord(JSON.parse(line)); if (row) this.accept(row); }
          catch { this.error = '部分旧请求记录无法读取，已保留其余记录。'; }
        }
      } catch (error) { if (error.code !== 'ENOENT') this.error = '请求历史暂不可读，仍会显示本次运行的新请求。'; }
    }
  }
  prepareWrites() {
    this.saveRow = this.db.prepare('INSERT INTO tail (id, record) VALUES (?, ?)');
    this.retireRows = this.db.prepare('DELETE FROM tail WHERE id <= ?');
    this.saveBucket = this.db.prepare('INSERT INTO archive (key, bucket) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET bucket = excluded.bucket');
  }
  transaction(write) {
    this.db.exec('BEGIN');
    try { write(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() {
    this.db?.close(); this.db = null;
  }
  archiveKey(row) {
    return JSON.stringify([row.time, row.model, row.source, row.client, row.ok,
      ...(isNativeObservation(row) ? ['antigravity-native'] : [])]);
  }
  accept(row) {
    this.rows.push(row);
    if (this.rows.length <= MAX_RECORDS) return;
    const retired = this.rows.shift(), timestamp = Date.parse(retired.time);
    if (!Number.isFinite(timestamp) || retired.operation === 'count_tokens') return;
    const label = { time: new Date(Math.floor(timestamp / 60000) * 60000).toISOString(), model: retired.model,
      source: retired.source || '未标注', client: retired.client || 'unknown', ok: requestOK(retired),
      ...(isNativeObservation(retired) ? { protocol: 'antigravity-native' } : {}) };
    const key = this.archiveKey(label);
    const bucket = this.archive.get(key) || { ...label, stats: {} };
    const stats = emptyStats();
    addRequestStats(stats, bucket); addRequestStats(stats, retired);
    bucket.stats = compactStats(stats);
    this.archive.set(key, bucket); this.archived++; this.archiveView = null;
    return key;
  }
  append(record) {
    const row = publicRecord(record);
    if (!row) return;
    const bucket = this.accept(row); this.revision++;
    if (!this.db) return;
    const id = ++this.lastId, oldest = id - MAX_RECORDS;
    this.pending.set(id, row);
    this.pending.delete(oldest);
    if (bucket) this.dirtyBuckets.add(bucket);
    try {
      // Deleting the tail and updating the corresponding minute bucket share a commit.
      this.transaction(() => {
        this.retireRows.run(oldest);
        for (const [rowId, value] of this.pending) this.saveRow.run(rowId, JSON.stringify(value));
        for (const key of this.dirtyBuckets) this.saveBucket.run(key, JSON.stringify(this.archive.get(key)));
      });
      this.pending.clear(); this.dirtyBuckets.clear();
      if (this.error === WRITE_ERROR) this.error = '';
    } catch { this.error = WRITE_ERROR; }
  }
  snapshot(revision) {
    const changed = revision !== this.revision;
    if (changed) this.archiveView ||= [...this.archive.values()];
    return { rows: changed ? this.rows : undefined, archive: changed ? this.archiveView : undefined,
      archived: this.archived, revision: this.revision, error: this.error, limit: MAX_RECORDS };
  }
}
module.exports = { RequestHistory, publicRecord };
