const { modelKey } = require("./model-inspection.cjs");
const { savedFailure, classifyFailure } = require("./diagnostic-failure.cjs");

function diagnosticTargets(state, authReady) {
  return [
    {
      id: "official",
      name: "OpenAI 官方",
      models: state.officialModels,
      hasKey: authReady,
    },
    ...state.providers,
  ].flatMap((p) =>
    p.models.map((m) => ({
      key: modelKey(p.id, m.model),
      providerId: p.id,
      providerName: p.name,
      model: m.model,
      displayName: m.displayName,
      skip:
        p.enabled === false
          ? "供应商已停用"
          : m.enabled === false
            ? "模型已停用"
            : !p.hasKey
              ? p.id === "official"
                ? "未检测到官方登录"
                : "未配置 API Key"
              : "",
    })),
  );
}

class DiagnosticBatch {
  constructor({ targets, run, onChange = () => {}, concurrency = 2 }) {
    Object.assign(this, { targets, run, onChange, concurrency });
    this.state = { running: false, entries: [] };
  }
  snapshot() {
    const entries = this.state.entries;
    const count = (status) => entries.filter((e) => e.status === status).length;
    return {
      ...this.state,
      total: entries.length,
      completed: entries.filter(
        (e) => !["queued", "running"].includes(e.status),
      ).length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      cancelled: count("cancelled"),
      entries: entries.map((e) => ({ ...e })),
    };
  }
  restore(state) {
    if (state && !this.state.running) this.state = structuredClone(state);
  }
  start() {
    if (this.state.running) throw Error("一键测试正在进行");
    const targets = this.targets();
    if (!targets.some((t) => !t.skip))
      throw Error("没有已启用且具有凭据的模型可供测试");
    this.controller = new AbortController();
    this.state = {
      running: true,
      stopping: false,
      startedAt: new Date().toISOString(),
      entries: targets.map(({ skip, ...t }) => ({
        ...t,
        status: skip ? "skipped" : "queued",
        message: skip || "等待测试",
      })),
    };
    const signal = this.controller.signal;
    const worker = async () => {
      while (!signal.aborted) {
        const entry = this.state.entries.find((e) => e.status === "queued");
        if (!entry) return;
        entry.status = "running";
        entry.message = "正在检查完整响应…";
        this.onChange();
        try {
          const result = await this.run(entry.providerId, entry.model, signal);
          Object.assign(entry, {
            status:
              signal.aborted || result.cancelled
                ? "cancelled"
                : result.ok
                  ? "passed"
                  : "failed",
            message:
              signal.aborted || result.cancelled ? "已取消" : result.message,
            ms: result.ms,
            ...(!result.ok && !result.cancelled && !signal.aborted ? savedFailure(result) || {} : {}),
          });
        } catch (error) {
          entry.status = signal.aborted ? "cancelled" : "failed";
          entry.message = signal.aborted
            ? "已取消"
            : "检测未完成，请检查模型配置或网络";
          if (!signal.aborted) Object.assign(entry, classifyFailure(error));
        }
        this.onChange();
      }
    };
    this.onChange();
    this.finished = Promise.all(
      Array.from({ length: this.concurrency }, worker),
    ).finally(() => {
      for (const e of this.state.entries)
        if (e.status === "queued")
          Object.assign(e, {
            status: "cancelled",
            message: "已取消，未发送请求",
          });
      this.state.running = false;
      this.state.stopping = false;
      this.state.finishedAt = new Date().toISOString();
      this.onChange();
    });
    return this.snapshot();
  }
  cancel() {
    if (!this.state.running) return;
    this.state.stopping = true;
    this.controller.abort();
    this.onChange();
  }
}
module.exports = { DiagnosticBatch, diagnosticTargets };
