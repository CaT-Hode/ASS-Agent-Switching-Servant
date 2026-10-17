// One UI update per burst. Explicit snapshot replies reuse their exact result.
class SnapshotPublisher {
  constructor({ read, send, onError = () => {}, canSend = () => true, schedule = setTimeout, cancel = clearTimeout, delay = 40 }) {
    Object.assign(this, { read, send, onError, canSend, schedule, cancel, delay });
    this.timer = null;
  }
  clear() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
  publish(value) {
    this.clear();
    try {
      if (this.canSend()) this.send(value === undefined ? this.read() : value);
    } catch (error) {
      // A background state read or a closing window must not crash the process
      // or reject an otherwise completed IPC action. The next push can retry.
      try { this.onError(error); } catch {}
    }
  }
  push() {
    if (this.timer !== null || !this.canSend()) return;
    this.timer = this.schedule(() => { this.timer = null; this.publish(); }, this.delay);
    this.timer?.unref?.();
  }
}
class ClientSnapshot {
  constructor(read) { this.read = read; this.last = { clients: [] }; }
  current() {
    try {
      const state = this.read();
      this.last = structuredClone(state);
      return { state, error: '' };
    } catch {
      // Native application updates must not hide a successfully saved API
      // provider by preventing the entire settings snapshot from publishing.
      return { state: structuredClone(this.last), error: '原生客户端状态暂不可读，已保留上次账户信息；供应商配置已独立刷新。' };
    }
  }
}
module.exports = { SnapshotPublisher, ClientSnapshot };
