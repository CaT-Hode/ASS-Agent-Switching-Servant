const fs = require('node:fs');
const path = require('node:path');
const { atomic } = require('./config.cjs');

// A small encrypted diagnostic trail. Never serialize errors, request bodies,
// parser excerpts or credentials; stack locations are filenames and numbers.
class RuntimeHealth {
  constructor(dataDir, crypto, version) {
    this.file = path.join(dataDir, 'runtime-health.enc.json');
    Object.assign(this, { crypto, version, events: [] });
    try {
      const bytes = fs.readFileSync(this.file);
      if (bytes.length > 64 * 1024) throw Error();
      const saved = JSON.parse(bytes);
      const rows = JSON.parse(crypto.decryptString(Buffer.from(saved.encrypted, 'base64')));
      if (Array.isArray(rows)) this.events = rows.slice(-39);
    } catch { /* Diagnostics cannot prevent startup or restore settings. */ }
    this.record('start');
  }
  record(component, error) {
    const safe = (s) => /^[\w.-]{1,80}$/.test(s || '') ? s : 'unknown';
    const locations = String(error?.stack || '').split('\n').slice(1, 6)
      .flatMap(line => [...line.matchAll(/(?:^|[/\\])([\w.-]+\.c?js):(\d+):(\d+)/g)]
        .map(m => `${m[1]}:${m[2]}:${m[3]}`));
    const row = { time: new Date().toISOString(), version: safe(this.version), component: safe(component),
      ...(error ? { name: safe(error.name), code: safe(error.code), locations } : {}) };
    this.events = [...this.events.slice(-39), row];
    try {
      if (!this.crypto.isEncryptionAvailable()) return;
      atomic(this.file, JSON.stringify({ version: 1,
        encrypted: this.crypto.encryptString(JSON.stringify(this.events)).toString('base64') }));
    } catch { /* Disk full and unavailable OS crypto must not create a second failure. */ }
  }
  background(component, task) {
    return Promise.resolve().then(task).catch(error => { this.record(component, error); });
  }
}
module.exports = { RuntimeHealth };
