const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const TOML = require('@iarna/toml');
const { atomic } = require('./config.cjs');
const { safePath } = require('./native-fields.cjs');
const ownModel = value => /^ASS_[a-f0-9]{24}::/.test(value || '');
const ownProvider = value => ['ASS', 'ass_official'].includes(value);
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
async function header(file) {
  const chunks = []; let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) {
    const end = chunk.indexOf(10); const part = end < 0 ? chunk : chunk.subarray(0, end + 1);
    chunks.push(part); size += part.length;
    if (size > 2 * 1024 * 1024) throw Error('Codex 会话元数据过大，未修改');
    if (end >= 0) return Buffer.concat(chunks).toString('utf8');
  }
  throw Error('Codex 会话记录尚未完整写入，未修改');
}
async function rewrite(item, reverse = false) {
  const expected = reverse ? item.hashAfter : item.hashBefore;
  if (await digest(item.file) !== expected) throw Error('Codex 会话同时被修改，未覆盖');
  const before = reverse ? item.headAfter : item.headBefore, after = reverse ? item.headBefore : item.headAfter;
  const stat = await fsp.stat(item.file), tmp = item.file + '.ass-' + randomUUID() + '.tmp';
  const tailLength = stat.size - Buffer.byteLength(before) - (reverse ? item.appendBytes ?? Buffer.byteLength(item.append || '') : 0);
  try {
    await fsp.writeFile(tmp, after, { mode: 0o600, flag: 'wx' });
    if (tailLength > 0) await pipeline(fs.createReadStream(item.file, { start: Buffer.byteLength(before),
      end: Buffer.byteLength(before) + tailLength - 1 }), fs.createWriteStream(tmp, { flags: 'a' }));
    if (!reverse && item.append) await fsp.appendFile(tmp, item.append);
    const fd = await fsp.open(tmp, 'r+'); try { await fd.sync(); } finally { await fd.close(); }
    if (await digest(item.file) !== expected) throw Error('Codex 会话在写入期间变化，未覆盖');
    await fsp.rename(tmp, item.file);
  } finally { await fsp.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
class CodexSessionHandoff {
  constructor({ codexDir, dataDir, crypto, config, officialModels, assertIdle }) {
    Object.assign(this, { codexDir, dataDir, crypto, config, officialModels, assertIdle });
    this.journal = path.join(dataDir, 'codex-session-handoff.enc.json'); this.error = ''; this.busy = false;
  }
  database() {
    if (!fs.existsSync(this.codexDir)) return null;
    const files = fs.readdirSync(this.codexDir).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    return files[0] ? path.join(this.codexDir, files[0]) : null;
  }
  rows(db) {
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(r => r.name));
    if (!['id', 'model_provider', 'rollout_path'].every(k => columns.has(k))) throw Error('Codex 会话索引格式无法识别，未修改');
    const model = columns.has('model');
    return { model, rows: db.prepare(`SELECT id, model_provider, rollout_path${model ? ', model' : ''} FROM threads
      WHERE model_provider IN ('ASS','ass_official')${model ? " OR model GLOB 'ASS_*::*'" : ''}`).all() };
  }
  status() {
    const file = this.database(); if (!file) return { count: 0 };
    let db;
    try { db = new DatabaseSync(file, { readOnly: true }); const rows = this.rows(db).rows;
      return { count: rows.length, predictionCount: rows.filter(row => ownProvider(row.model_provider)).length,
        pending: fs.existsSync(this.journal), error: this.error }; }
    catch { return { count: 0, error: 'Codex 会话绑定暂不可读' }; }
    finally { db?.close(); }
  }
  ownedFile(file) {
    const normalized = path.resolve(file.replace(/^\\\\\?\\/, ''));
    if (!['sessions', 'archived_sessions'].some(dir => { const relative = path.relative(path.join(this.codexDir, dir), normalized);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })) throw Error('Codex 会话路径不属于当前客户端，未修改');
    safePath(normalized); return normalized;
  }
  target() {
    const native = this.officialModels().filter(m => /^gpt-[\w.-]+$/.test(m.slug));
    let baseline = {};
    const detached = this.config.preflightDetach();
    try { baseline = TOML.parse(detached?.next || fs.readFileSync(this.config.file, 'utf8')); } catch {}
    const model = native.find(m => m.slug === baseline.model) || native[0];
    if (!model) throw Error('没有可确认的官方 GPT 模型，请先读取 Codex 模型目录');
    return { model: model.slug, effort: baseline.model_reasoning_effort || model.default_reasoning_level || 'medium', native };
  }
  persist(value) {
    if (!this.crypto.isEncryptionAvailable()) throw Error('凭据加密不可用，未修改会话绑定');
    const encrypted = this.crypto.encryptString(JSON.stringify(value)).toString('base64');
    if (encrypted.length > 8 * 1024 * 1024) throw Error('会话恢复元数据过大，未修改');
    atomic(this.journal, JSON.stringify({ version: 1, encrypted }));
  }
  async recover() {
    if (!fs.existsSync(this.journal)) return;
    await this.assertIdle();
    const raw = JSON.parse(fs.readFileSync(this.journal, 'utf8'));
    if (raw.version !== 1) throw Error('会话恢复事务格式无法识别');
    const plan = JSON.parse(this.crypto.decryptString(Buffer.from(raw.encrypted, 'base64')));
    if (plan.database !== this.database() || !Array.isArray(plan.items)) throw Error('会话恢复目标已变化');
    const db = new DatabaseSync(plan.database); let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      for (const item of [...plan.items].reverse()) {
        if (item.file) {
          item.file = this.ownedFile(item.file);
          const hash = await digest(item.file);
          if (hash === item.hashAfter) await rewrite(item, true);
          else if (hash !== item.hashBefore) throw Error('Codex 会话在事务恢复前变化，已保留恢复记录');
        }
        const current = db.prepare(`SELECT model_provider${plan.model ? ',model' : ''} FROM threads WHERE id=?`).get(item.before.id);
        if (!current) throw Error('Codex 会话索引已变化，未恢复');
        if (current.model_provider === item.after.provider && (!plan.model || current.model === item.after.model)) {
          db.prepare(`UPDATE threads SET model_provider=?${plan.model ? ',model=?' : ''} WHERE id=?`).run(...[item.before.model_provider,
            ...(plan.model ? [item.before.model] : []), item.before.id]);
        } else if (current.model_provider !== item.before.model_provider || plan.model && current.model !== item.before.model) throw Error('Codex 会话绑定被外部更新，未覆盖');
      }
      db.exec('COMMIT'); transaction = false; await fsp.unlink(this.journal); this.error = '';
    } catch (e) { if (transaction) db.exec('ROLLBACK'); throw e; } finally { db.close(); }
  }
  assertPredictionRoute() {
    const status = this.config.status();
    if (!status.attached || status.provider !== 'openai' || status.authMode !== 'oauth')
      throw Error('请先更新并同步普通 OAuth 接入；无账号模式不能修复预测');
    this.config.preflightDetach(); // Validate the saved ownership record, without detaching.
  }
  async restorePrediction() {
    this.assertPredictionRoute();
    return this.restore(true);
  }
  async restore(prediction = false) {
    if (this.busy) throw Error('正在恢复 Codex 会话绑定，请稍后重试');
    this.busy = true;
    try { return await this.restoreNow(prediction); } finally { this.busy = false; }
  }
  async restoreNow(prediction = false) {
    await this.recover();
    const database = this.database(); if (!database) return { count: 0 };
    const reader = new DatabaseSync(database, { readOnly: true }); let candidates;
    try { candidates = this.rows(reader); } finally { reader.close(); }
    if (prediction) candidates.rows = candidates.rows.filter(row => ownProvider(row.model_provider));
    if (!candidates.rows.length) return { count: 0 };
    await this.assertIdle();
    if (prediction) this.assertPredictionRoute();
    const target = prediction ? null : this.target(), items = [];
    for (const row of candidates.rows) {
      const item = { before: row, after: { provider: ownProvider(row.model_provider) ? 'openai' : row.model_provider,
        model: prediction ? row.model : row.model || target.model }, append: '' };
      if (fs.existsSync(row.rollout_path)) {
        item.file = this.ownedFile(row.rollout_path); item.hashBefore = await digest(item.file);
        item.headBefore = await header(item.file); const meta = JSON.parse(item.headBefore);
        if (meta.type !== 'session_meta' || meta.payload?.id !== row.id) throw Error('Codex 会话元数据与索引不一致，未修改');
        if (prediction && meta.payload.model_provider !== 'openai' && !ownProvider(meta.payload.model_provider))
          throw Error('Codex 会话供应商与索引不一致，未修改预测绑定');
        if (ownProvider(meta.payload.model_provider)) meta.payload.model_provider = 'openai';
        item.headAfter = JSON.stringify(meta) + (item.headBefore.endsWith('\r\n') ? '\r\n' : '\n');
        if (!prediction) {
        let context, history = [], unsafeReplay = false;
        const lines = createInterface({ input: fs.createReadStream(item.file), crlfDelay: Infinity });
        for await (const line of lines) if (/"type"\s*:\s*"(?:turn_context|response_item|compacted|event_msg)"/.test(line)) {
          const event = JSON.parse(line);
          if (event.type === 'turn_context') context = event;
          else if (event.type === 'response_item') history.push({ value: event.payload, foreign: ownModel(context?.payload?.model) });
          else if (event.type === 'compacted') {
            if (Array.isArray(event.payload?.replacement_history)) {
              history = event.payload.replacement_history.map(value => ({ value, foreign: ownModel(context?.payload?.model) })); unsafeReplay = false;
            } else unsafeReplay = true;
          } else if (event.type === 'event_msg' && event.payload?.type === 'thread_rolled_back') unsafeReplay = true;
        }
        const compatible = history.filter(({ value, foreign }) => !(value?.type === 'reasoning' &&
          (foreign || Array.isArray(value.content) && value.content.length)));
        if (compatible.length !== history.length) {
          if (unsafeReplay) throw Error('此会话包含旧版压缩或回退记录，请先在 Codex 中重建当前上下文；未覆盖会话');
          item.append = JSON.stringify({ timestamp: new Date().toISOString(), type: 'compacted', payload: {
            message: '恢复官方模型续聊上下文', replacement_history: compatible.map(r => r.value) } }) + '\n';
        }
        const recent = context?.payload?.model || row.model;
        const selected = target.native.some(m => m.slug === recent) ? recent : target.model;
        if (context && (ownModel(recent) || !target.native.some(m => m.slug === recent))) {
          const next = structuredClone(context); next.timestamp = new Date().toISOString(); next.payload.model = selected; next.payload.effort = target.effort;
          if (next.payload.model_provider !== undefined) next.payload.model_provider = 'openai';
          if (next.payload.collaboration_mode?.settings?.model) next.payload.collaboration_mode.settings.model = selected;
          item.append += JSON.stringify(next) + '\n';
        }
        item.after.model = selected;
        }
        if (item.append) {
          const fd = await fsp.open(item.file, 'r');
          try {
            const stat = await fd.stat(), last = Buffer.alloc(1);
            await fd.read(last, 0, 1, stat.size - 1);
            if (last[0] !== 10) throw Error('Codex 会话记录尚未完整写入，未修改');
          } finally { await fd.close(); }
        }
        const original = fs.createReadStream(item.file, { start: Buffer.byteLength(item.headBefore) }), hash = createHash('sha256');
        hash.update(item.headAfter); for await (const bytes of original) hash.update(bytes); hash.update(item.append); item.hashAfter = hash.digest('hex');
      } else if (!prediction && (ownModel(item.after.model) || !target.native.some(m => m.slug === item.after.model))) item.after.model = target.model;
      items.push(item);
    }
    const plan = { database, model: candidates.model, items };
    this.persist({ ...plan, items: items.map(({ append, ...item }) => ({ ...item, appendBytes: Buffer.byteLength(append) })) });
    if (prediction) {
      const backup = path.join(this.dataDir, 'backups', `codex-prediction-${Date.now()}-${randomUUID()}.enc.json`);
      safePath(backup); atomic(backup, await fsp.readFile(this.journal, 'utf8'));
    }
    const db = new DatabaseSync(database); let committed = false, transaction = false;
    try {
      await this.assertIdle();
      if (prediction) this.assertPredictionRoute();
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      for (const item of items) {
        const changed = db.prepare(`UPDATE threads SET model_provider=?${plan.model ? ',model=?' : ''}
          WHERE id=? AND model_provider=?${plan.model ? ' AND model IS ?' : ''}`).run(item.after.provider,
          ...(plan.model ? [item.after.model] : []), item.before.id, item.before.model_provider, ...(plan.model ? [item.before.model] : []));
        if (changed.changes !== 1) throw Error('Codex 会话绑定在确认后变化，未覆盖');
        if (item.file) await rewrite(item);
      }
      db.exec('COMMIT'); transaction = false; committed = true; await fsp.unlink(this.journal); this.error = '';
      return { count: items.length };
    } catch (e) {
      if (!committed && transaction) db.exec('ROLLBACK'); db.close();
      try { await this.recover(); } catch { this.error = '会话绑定恢复未完成，请关闭 Codex 后重新恢复'; }
      throw e;
    } finally { if (db.isOpen) db.close(); }
  }
}
module.exports = { CodexSessionHandoff, ownModel, ownProvider };
