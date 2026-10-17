const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const { atomic } = require('./config.cjs');
const { safePath } = require('./native-fields.cjs');
const LIMIT = 1024 * 1024;

// A small independent checkpoint survives loss of both the canonical record
// and a legacy applied plan without attachment metadata. It never stores drafts.
class CodexRecovery {
  constructor(dataDir, crypto, config) {
    Object.assign(this, { crypto, config });
    this.file = path.join(dataDir, 'codex-recovery.enc.json');
    this.previous = path.join(dataDir, 'codex-recovery.previous.enc.json');
  }
  decode(file) {
    safePath(file);
    if (fs.statSync(file).size > LIMIT) throw Error('Codex 恢复检查点过大');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw Error('Codex 恢复检查点格式无效');
    const value = JSON.parse(this.crypto.decryptString(Buffer.from(envelope.encrypted, 'base64')));
    if (value.kind !== 'codex-attachment' || value.config !== this.config.file || value.catalog !== this.config.catalog ||
        value.baseUrl !== this.config.baseUrl) throw Error('Codex 恢复检查点不属于当前目录');
    this.config.validateRecord(value.record);
    return value.record;
  }
  candidates() {
    const result = [];
    for (const file of [this.file, this.previous]) {
      try { result.push(this.decode(file)); } catch { /* Try the other bounded checkpoint. */ }
    }
    return result;
  }
  save(record) {
    this.config.validateRecord(record);
    if (!this.crypto.isEncryptionAvailable()) throw Error('系统凭据加密不可用，未保存恢复检查点');
    let prior;
    try { prior = this.decode(this.file); } catch { /* Preserve unreadable files in the repair backup. */ }
    if (equal(prior, record)) return;
    const value = JSON.stringify({ version: 1, encrypted: this.crypto.encryptString(JSON.stringify({
      kind: 'codex-attachment', config: this.config.file, catalog: this.config.catalog,
      baseUrl: this.config.baseUrl, record,
    })).toString('base64') });
    if (Buffer.byteLength(value) > LIMIT) throw Error('Codex 恢复检查点超过 1 MiB');
    safePath(this.file); safePath(this.previous);
    if (prior) atomic(this.previous, fs.readFileSync(this.file));
    atomic(this.file, value);
  }
}
module.exports = { CodexRecovery };
