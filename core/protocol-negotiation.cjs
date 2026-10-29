const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomic } = require("./config.cjs");
const { nativeProbe, modelKey, DIAGNOSTIC_TIMEOUT_MS } = require("./model-inspection.cjs");
const { abortable } = require("./abortable.cjs");
const ORDER = ["openai-responses", "anthropic", "openai-chat"];
function identity(p, m) {
  return createHash("sha256").update(JSON.stringify([p.id, p.baseUrl, p.apiKey,
    p.network, Object.entries(p.extraHeaders || {}).sort(), m.model])).digest("hex");
}
// Only a completed native stream establishes support. An HTTP error on its
// own (particularly 400, quota, auth and 5xx) does not disprove a protocol.
class ProtocolNegotiation {
  constructor({ dataDir, crypto, getProviders, fetcher, onChange = () => {}, now = Date.now }) {
    Object.assign(this, { crypto, getProviders, fetcher, onChange, now });
    this.file = path.join(dataDir, "protocols.enc.json");
    this.records = {}; this.jobs = new Map(); this.jobDetails = new Map(); this.error = "";
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw Error();
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (saved.version !== 1) throw Error();
        this.records = JSON.parse(crypto.decryptString(Buffer.from(saved.encrypted, "base64")));
        if (!this.records || typeof this.records !== "object" || Array.isArray(this.records)) throw Error();
        // Older versions treated every 404 as an unsupported protocol, even
        // model/channel errors. Correct that inference in memory without
        // rewriting history or initiating unrequested network probes.
        for (const record of Object.values(this.records)) for (const result of Object.values(record?.protocols || {})) {
          if (result?.status === 'unsupported' && result.httpStatus === 404 && !result.unsupportedEvidence) {
            result.status = result.lastSuccess ? 'passed' : 'unknown';
            result.message = '旧版仅依据 HTTP 404，尚未确认协议是否不支持';
          }
        }
      }
    } catch { this.records = {}; this.error = "协议检测记录无法读取，未覆盖原文件"; }
  }
  get(p, m) {
    const r = this.records[modelKey(p.id, m.model)];
    return r?.fingerprint === identity(p, m) ? r : null;
  }
  save() {
    if (this.error) throw Error(this.error);
    if (!this.crypto.isEncryptionAvailable()) throw Error("系统凭据加密不可用，未保存协议检测");
    const valid = new Set(this.getProviders().flatMap(p => p.models.map(m => modelKey(p.id, m.model))));
    for (const key of Object.keys(this.records)) if (!valid.has(key)) delete this.records[key];
    atomic(this.file, JSON.stringify({ version: 1, encrypted: this.crypto.encryptString(JSON.stringify(this.records)).toString("base64") }));
  }
  record(p, m, report) {
    const live = this.getProviders().find(v => v.id === p.id), model = live?.models.find(v => v.model === m.model);
    if (!model || identity(live, model) !== identity(p, m)) return false;
    const record = this.get(p, m) || { fingerprint: identity(p, m), protocols: {} };
    for (const [protocol, result] of Object.entries(report.protocols || {})) {
      if (!ORDER.includes(protocol)) continue;
      const old = record.protocols[protocol];
      const status = result.status === "passed" ? "passed" : result.unsupported ? "unsupported" : "unknown";
      record.protocols[protocol] = { status: status === "unknown" && old?.status === "passed" ? "passed" : status,
        time: report.time, ms: result.ms, httpStatus: result.httpStatus,
        lastStatus: status, lastSuccess: status === "passed" ? report.time : old?.lastSuccess,
        ...(status === 'unsupported' ? { unsupportedEvidence: 'response' } : {}),
        ...(status === "unknown" ? { message: "暂未确认；网络、权限、限流或请求参数可能影响检测" } : {}) };
    }
    record.time = report.time;
    this.records[modelKey(p.id, m.model)] = record;
    this.save(); this.onChange(); return true;
  }
  select(p, m, harness) {
    const r = this.get(p, m), order = harness === "claude" ? ["anthropic", "openai-responses", "openai-chat"] : ORDER;
    // CC speaks Messages natively. A transient probe failure must not replace
    // verified native support with a lossy protocol bridge.
    if (harness === 'claude' && r?.protocols.anthropic?.status === 'passed') return 'anthropic';
    if (m.protocolOverride) return m.protocolOverride;
    return order.find(protocol => r?.protocols[protocol]?.status === "passed" && r.protocols[protocol].lastStatus !== "unknown") ||
      order.find(protocol => r?.protocols[protocol]?.status === "passed") || m.wireApi;
  }
  providers(harness) {
    return this.getProviders().map(p => ({ ...p, models: p.models.map(m => ({ ...m, wireApi: this.select(p, m, harness),
      ...(harness === 'claude' && this.get(p, m)?.protocols.anthropic?.status === 'passed' ? { nativeMessages: true } : {}) })) }));
  }
  public() {
    return Object.fromEntries(this.getProviders().flatMap(p => p.models.flatMap(m => {
      const r = this.get(p, m);
      return r ? [[modelKey(p.id, m.model), { time: r.time, protocols: r.protocols, efforts: {}, tools: { status: "unknown" } }]] : [];
    })));
  }
  progress() { return Object.fromEntries(this.jobDetails); }
  async ensure(p, m, { force = false, untilAvailable = false, signal, progress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!p.enabled || !p.apiKey || !m.enabled) return;
    const key = modelKey(p.id, m.model), fp = identity(p, m), jobKey = key + fp;
    if (this.jobs.has(jobKey)) return abortable(this.jobs.get(jobKey), signal);
    // A check is user-owned history, not a time-expiring network cache. This
    // also honors v0.1.28 records; unknown/denied results need a manual retry.
    if (!force && this.get(p, m)) return this.get(p, m);
    const controller = new AbortController();
    const probeSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = untilAvailable ? setTimeout(() => controller.abort(new DOMException("Connection check timeout", "TimeoutError")), DIAGNOSTIC_TIMEOUT_MS) : undefined;
    const job = (async () => {
      // Connection checks need one working protocol. Full capability scans
      // still collect independent evidence for every protocol.
      const known = this.get(p, m), preferred = this.select(p, m, "codex");
      const order = untilAvailable && known?.protocols[preferred]?.status === "passed"
        ? [preferred, ...ORDER.filter(protocol => protocol !== preferred)] : ORDER;
      for (const protocol of order) {
        probeSignal.throwIfAborted();
        this.jobDetails.set(key, protocol); this.onChange();
        progress(protocol);
        const result = await nativeProbe(p, m, protocol, this.fetcher, { signal: probeSignal,
          ...(untilAvailable ? { connection: true, effort: m.defaultEffort || "medium" } : {}) });
        if (probeSignal.aborted && probeSignal.reason?.name !== "TimeoutError") probeSignal.throwIfAborted();
        this.record(p, m, { time: new Date(this.now()).toISOString(), protocols: { [protocol]: result } });
        // A credential may be accepted by one protocol but not another. Only
        // rate limiting suppresses further probes; do not hammer the provider.
        if (probeSignal.aborted || result.httpStatus === 429 || untilAvailable && result.status === "passed") break;
      }
      return this.get(p, m);
    })();
    this.jobs.set(jobKey, job);
    try { return await job; } finally { clearTimeout(timer); this.jobs.delete(jobKey); this.jobDetails.delete(key); this.onChange(); }
  }
  async ensureProviders(providers, { onProgress = () => {}, signal, ...options } = {}) {
    const rows = providers.filter(p => p.enabled && p.apiKey).flatMap(p => p.models.filter(m => m.enabled).map(m => [p, m]));
    const controller = new AbortController();
    const batchSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    // Small bounded requests, no context-limit stress tests or burst fan-out.
    let next = 0, completed = 0;
    const active = new Map();
    const report = () => onProgress({ total: rows.length, completed, active: [...active.values()] });
    report();
    const workers = [0, 1].map(async () => { try { while (next < rows.length) {
      batchSignal.throwIfAborted();
      const [p, m] = rows[next++], key = modelKey(p.id, m.model);
      active.set(key, { provider: p.name, model: m.model }); report();
      await this.ensure(p, m, { ...options, signal: batchSignal, progress: protocol => { active.set(key, { provider: p.name, model: m.model, protocol }); report(); } });
      completed++; active.delete(key); report();
    } } catch (error) { controller.abort(error); throw error; } });
    try { await abortable(Promise.all(workers), batchSignal); }
    finally { controller.abort(); }
  }
}
module.exports = { ProtocolNegotiation, identity };
