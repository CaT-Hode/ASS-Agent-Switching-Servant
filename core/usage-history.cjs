const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { atomic } = require("./config.cjs");
class UsageHistory {
  constructor({ dataDir, crypto, getOptions, onChange = () => {} }) {
    this.file = path.join(dataDir, "usage-history.enc.json");
    this.crypto = crypto;
    this.getOptions = getOptions;
    this.onChange = onChange;
    this.cache = {};
    this.locations = {};
    this.state = { rows: [], sources: [], updatedAt: null };
    this.job = null;
    try {
      if (fs.statSync(this.file).size > 128 * 1024 * 1024) return;
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const value = JSON.parse(
        crypto.decryptString(Buffer.from(envelope.encrypted, "base64")),
      );
      if (
        value.version === 2 &&
        value.snapshot?.timeZone ===
          Intl.DateTimeFormat().resolvedOptions().timeZone
      ) {
        this.cache = value.cache || {};
        this.locations = value.locations || {};
        this.state = value.snapshot;
      }
    } catch {
      /* Rebuild from native files; never modify those files. */
    }
  }
  public() {
    return { ...this.state, loading: !!this.job };
  }
  refresh({ automatic = false } = {}) {
    if (this.job) return this.job;
    if (automatic && Date.now() - Date.parse(this.state.updatedAt) < 60000)
      return Promise.resolve();
    this.job = new Promise((resolve) => {
      const worker = new Worker(path.join(__dirname, "usage-worker.cjs"), {
        workerData: { options: { ...this.getOptions(), automatic }, cache: this.cache, locations: this.locations },
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value) {
          this.cache = value.cache;
          this.locations = value.locations || {};
          this.state = value.snapshot;
          try {
            if (!this.crypto.isEncryptionAvailable()) throw Error("encryption");
            atomic(
              this.file,
              JSON.stringify({
                encrypted: this.crypto
                  .encryptString(JSON.stringify({ version: 2, ...value }))
                  .toString("base64"),
              }),
            );
          } catch {
            this.state.error = "用量缓存保存失败";
          }
        } else this.state.error = "本地用量读取失败，保留上次结果";
        this.job = null;
        this.onChange();
        resolve(this.public());
      };
      const timer = setTimeout(() => {
        worker.terminate();
        finish(null);
      }, 120000);
      worker.once("message", finish);
      worker.once("error", () => finish(null));
      worker.once("exit", () => finish(null));
    });
    this.onChange();
    return this.job;
  }
}
module.exports = { UsageHistory };
