const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DiagnosticHistory } = require("../core/diagnostic-history.cjs");
const { DiagnosticBatch } = require("../core/diagnostic-batch.cjs");
const { diagnosticMetrics } = require("../core/diagnostic-metrics.cjs");
const { modelKey } = require("../core/model-inspection.cjs");
const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
test("native metadata temporarily missing on restart cannot erase observations; batch resumes as history", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-history-v2-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let context = { provider: { id: "native-test:p", apiKey: "synthetic-private" }, model: { model: "alpha", wireApi: "openai-chat" } };
  const options = { dataDir, crypto, getContext: () => context };
  const history = new DiagnosticHistory(options);
  const result = { providerId: "native-test:p", model: "alpha", time: new Date().toISOString(), ms: 200, ok: true,
    headersMs: 50, firstEventMs: 60, firstTextMs: 120, protocolMs: 30, httpStatus: 200, phase: "complete", route: "native", inputTokens: 4, outputTokens: 2 };
  history.record(result, history.fingerprint(result.providerId, result.model));
  history.recordBatch({ running: true, startedAt: result.time, entries: [{ ...result, status: "passed" },
    { providerId: "p", model: "waiting", status: "running" }] });
  const previous = context; context = null;
  const restarted = new DiagnosticHistory(options), key = modelKey(result.providerId, result.model);
  assert.equal(restarted.public()[key].stale, true);
  context = previous;
  assert.equal(restarted.public()[key].stale, undefined);
  assert.equal(restarted.public()[key].firstTextMs, 120);
  assert.equal(restarted.public()[key].protocolMs, 30);
  assert.equal(restarted.public()[key].httpStatus, 200);
  const batch = new DiagnosticBatch({}); batch.restore(restarted.batch);
  assert.equal(batch.snapshot().passed, 1); assert.equal(batch.snapshot().cancelled, 1);
  assert.equal(batch.snapshot().running, false); assert.equal(batch.snapshot().interrupted, true);
  assert.doesNotMatch(JSON.stringify(restarted.public()), /synthetic-private/);
});
test("request timings distinguish headers, non-text events, first text and complete duration without inventing usage", () => {
  let clock = 100;
  const m = diagnosticMetrics("openai-chat", "native", () => clock);
  clock = 140; m.headers({ status: 200 });
  clock = 150; m.observe({ choices: [{ delta: { role: "assistant" } }] });
  clock = 180; m.observe({ choices: [{ delta: { content: "你好" } }] });
  clock = 250; let result = m.finish(true);
  assert.deepEqual([result.headersMs, result.firstEventMs, result.firstTextMs, result.ms], [40, 50, 80, 150]);
  assert.equal(result.eventCount, 2); assert.equal(result.outputTokens, undefined);
  m.observe({ usage: { prompt_tokens: 9, completion_tokens: 4 } });
  result = m.finish(true);
  assert.equal(result.inputTokens, 9); assert.equal(result.outputTokens, 4);
});
