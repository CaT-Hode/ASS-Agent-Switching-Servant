const fs = require("node:fs");
const path = require("node:path");
const { MessageChannel, Worker } = require("node:worker_threads");
const { atomic } = require("./config.cjs");
const { excludedAntigravityUsageSessions } = require("./usage-extra.cjs");
const { purgeAntigravityUsageCache } = require("./usage-readers.cjs");
class UsageHistory {
  constructor({ dataDir, crypto, getOptions, onChange = () => {} }) {
    this.file = path.join(dataDir, "usage-history.enc.json");
    this.crypto = crypto;
    this.getOptions = getOptions;
    this.onChange = onChange;
    const cached = this.readCache() || null;
    this.initial = purgeAntigravityUsageCache(cached, excludedAntigravityUsageSessions(dataDir));
    this.state = this.initial?.snapshot || { rows: [], sources: [], updatedAt: null };
    this.worker = null;
    this.job = null;
    this.saveFailed = false;
    this.stopped = false;
    if (cached !== this.initial) this.save(JSON.stringify(this.initial));
  }
  readCache() {
    try {
      if (fs.statSync(this.file).size > 128 * 1024 * 1024) return;
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const value = JSON.parse(
        this.crypto.decryptString(Buffer.from(envelope.encrypted, "base64")),
      );
      if (
        value.version === 2 &&
        value.snapshot?.timeZone ===
          Intl.DateTimeFormat().resolvedOptions().timeZone
      ) {
        return value;
      }
    } catch {
      /* Rebuild from native files; never modify those files. */
    }
  }
  public() {
    return { ...this.state, loading: !!this.job };
  }
  save(payload) {
    try {
      if (!this.crypto.isEncryptionAvailable()) throw Error("encryption");
      atomic(this.file, JSON.stringify({ encrypted: this.crypto.encryptString(payload).toString("base64") }));
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
      this.state.error = "用量缓存保存失败";
    }
  }
  startWorker() {
    const worker = new Worker(path.join(__dirname, "usage-worker.cjs"), {
      workerData: this.initial === undefined ? this.readCache() : this.initial,
    });
    this.initial = undefined;
    this.worker = worker;
    worker.on("message", value => {
      if (this.worker === worker) this.finish(value);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.finish();
    };
    worker.once("error", failed);
    worker.once("exit", failed);
    return worker;
  }
  finish(value) {
    if (!this.job) return;
    const { resolve, timer } = this.job;
    clearTimeout(timer);
    this.job = null;
    this.worker?.unref();
    if (value?.snapshot) {
      this.state = value.snapshot;
      if (value.payload) this.save(value.payload);
    } else this.state.error = "本地用量读取失败，保留上次结果";
    this.onChange();
    resolve(this.public());
  }
  refresh({ automatic = false } = {}) {
    if (this.job) return this.job.promise;
    if (this.stopped || automatic && Date.now() - Date.parse(this.state.updatedAt) < 60000)
      return Promise.resolve();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const timer = setTimeout(() => {
      this.stopWorker();
      this.finish();
    }, 120000);
    this.job = { promise, resolve, timer };
    try {
      const worker = this.worker || this.startWorker();
      worker.ref();
      worker.postMessage({ options: { ...this.getOptions(), automatic }, saveFailed: this.saveFailed });
    } catch {
      this.finish();
      return promise;
    }
    this.onChange();
    return promise;
  }
  async drilldown(selection) {
    if (this.job) await this.job.promise;
    if (!this.worker) await this.refresh();
    const worker = this.worker;
    if (!worker) throw Error("无法读取本地用量明细");
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const finish = (error, result) => {
        clearTimeout(timer);
        port1.close();
        if (error) reject(Error(error));
        else resolve(result);
      };
      const timer = setTimeout(() => finish("读取本地用量明细超时"), 15000);
      port1.once("message", ({ error, result }) => finish(error, result));
      port1.once("close", () => finish("本地用量明细读取已结束"));
      try {
        worker.postMessage({ selection, port: port2 }, [port2]);
      } catch {
        port2.close();
        finish("无法读取本地用量明细");
      }
    });
  }
  stopWorker() {
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
  }
  stop() {
    this.stopped = true;
    this.stopWorker();
    if (!this.job) return;
    const { resolve, timer } = this.job;
    clearTimeout(timer);
    this.job = null;
    resolve(this.public());
  }
}
module.exports = { UsageHistory };
