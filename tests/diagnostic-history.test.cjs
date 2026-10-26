const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  DiagnosticHistory,
  diagnosticFingerprint,
} = require("../core/diagnostic-history.cjs");
const { modelKey } = require("../core/model-inspection.cjs");
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text),
  decryptString: (buffer) => buffer.toString(),
};
const model = {
  model: "alpha",
  wireApi: "openai-responses",
  defaultEffort: "medium",
  efforts: ["low", "medium", "high"],
};
const context = () => ({
  provider: {
    id: "p",
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-private-key",
    network: "system",
    extraHeaders: { "x-b": "2", "x-a": "1" },
  },
  model: { ...model },
});
const result = (extra = {}) => ({
  providerId: "p",
  model: "alpha",
  ok: true,
  ms: 123,
  time: "2026-09-22T00:00:00.000Z",
  message: "HTTP 200 · response.completed",
  ...extra,
});
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-diagnostics-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const contexts = new Map([[modelKey("p", "alpha"), context()]]);
  const options = {
    dataDir,
    crypto,
    getContext: (id, name) => contexts.get(modelKey(id, name)),
  };
  const history = new DiagnosticHistory(options);
  const save = (input = result()) =>
    history.record(input, history.fingerprint(input.providerId, input.model));
  return { dataDir, contexts, options, history, save };
}

test("latest per-model success/failure and exact time survive a new instance without secrets", (t) => {
  const f = fixture(t);
  assert.equal(f.save(), true);
  const second = { ...context(), model: { ...model, model: "beta" } };
  f.contexts.set(modelKey("p", "beta"), second);
  assert.equal(
    f.save(
      result({
        model: "beta",
        ok: false,
        message: "HTTP 502; private payload",
      }),
    ),
    true,
  );
  const restored = new DiagnosticHistory(f.options).public();
  assert.deepEqual(restored[modelKey("p", "alpha")], result());
  assert.equal(restored[modelKey("p", "beta")].ok, false);
  assert.match(restored[modelKey("p", "beta")].message, /^HTTP 502/);
  assert.ok(!JSON.stringify(restored).includes("fingerprint"));
  assert.ok(!JSON.stringify(restored).includes("private"));
  assert.ok(
    !fs.readFileSync(f.history.file, "utf8").includes("fixture-private-key"),
  );
});

test("retesting replaces one result and cancellation leaves its previous time intact", (t) => {
  const f = fixture(t);
  f.save();
  assert.equal(
    f.save(
      result({ cancelled: true, ok: false, time: "2026-09-22T01:00:00Z" }),
    ),
    false,
  );
  assert.equal(f.history.public()[modelKey("p", "alpha")].time, result().time);
  assert.equal(
    f.save(
      result({
        ok: false,
        time: "2026-09-22T02:00:00Z",
        message: "未收到完整结束事件",
      }),
    ),
    true,
  );
  assert.equal(
    f.save(),
    false,
    "an older completion cannot replace a new result",
  );
  const restored = new DiagnosticHistory(f.options).public()[
    modelKey("p", "alpha")
  ];
  assert.equal(restored.time, "2026-09-22T02:00:00.000Z");
  assert.equal(restored.ok, false);
});

test("first-time cancellation neither creates a result nor a file", (t) => {
  const f = fixture(t);
  assert.equal(f.save(result({ cancelled: true })), false);
  assert.deepEqual(f.history.public(), {});
  assert.equal(fs.existsSync(f.history.file), false);
});

test("connection edits retain stale observations and reject in-flight old results", (t) => {
  const f = fixture(t),
    old = f.history.fingerprint("p", "alpha");
  f.save();
  f.contexts.set(modelKey("p", "beta"), {
    ...context(),
    model: { ...model, model: "beta" },
  });
  f.save(result({ model: "beta" }));
  f.contexts.get(modelKey("p", "alpha")).model.defaultEffort = "high";
  assert.equal(f.history.record(result(), old), false);
  const active = f.history.public();
  assert.equal(active[modelKey("p", "alpha")].stale, true);
  assert.ok(active[modelKey("p", "beta")]);
  assert.deepEqual(new DiagnosticHistory(f.options).public(), active);
  f.contexts.delete(modelKey("p", "beta"));
  assert.equal(f.history.public()[modelKey("p", "beta")].stale, true);
  assert.deepEqual(new DiagnosticHistory(f.options).public(), f.history.public());
});

test("names, context hints, unrelated models and header order retain results; connection inputs change the fingerprint", () => {
  const base = context(),
    first = diagnosticFingerprint(base);
  const cosmetic = structuredClone(base);
  Object.assign(cosmetic.model, {
    displayName: "new label",
    contextWindow: 200000,
    enabled: false,
  });
  Object.assign(cosmetic.provider, {
    name: "new provider",
    enabled: false,
    models: ["other"],
    extraHeaders: { "x-a": "1", "x-b": "2" },
  });
  assert.equal(diagnosticFingerprint(cosmetic), first);
  for (const [area, key, value] of [
    ["provider", "id", "other"],
    ["provider", "baseUrl", "https://other.test/v1"],
    ["provider", "apiKey", "new-key"],
    ["provider", "network", "direct"],
    ["provider", "extraHeaders", { "x-a": "changed" }],
    ["model", "model", "other"],
    ["model", "wireApi", "anthropic"],
    ["model", "defaultEffort", "high"],
    ["model", "efforts", ["high"]],
  ]) {
    const changed = structuredClone(base);
    changed[area][key] = value;
    assert.notEqual(diagnosticFingerprint(changed), first, key);
  }
});

test("official identity survives token refresh, isolates users/workspaces and handles login/logout", () => {
  const jwt = (claims) =>
    "header." +
    Buffer.from(JSON.stringify(claims)).toString("base64url") +
    ".signature";
  const c = {
    ...context(),
    provider: {
      id: "official",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
    auth: {
      authorization: "Bearer " + jwt({ sub: "user-a", exp: 1 }),
      "chatgpt-account-id": "account-a",
    },
  };
  const first = diagnosticFingerprint(c);
  c.auth.authorization = "Bearer " + jwt({ sub: "user-a", exp: 2 });
  assert.equal(diagnosticFingerprint(c), first);
  c.auth["chatgpt-account-id"] = "account-b";
  assert.notEqual(diagnosticFingerprint(c), first);
  c.auth["chatgpt-account-id"] = "account-a";
  c.auth.authorization = "Bearer " + jwt({ sub: "user-b", exp: 2 });
  assert.notEqual(diagnosticFingerprint(c), first);
  c.auth = undefined;
  assert.notEqual(diagnosticFingerprint(c), first);
  c.auth = { authorization: "Bearer opaque-token" };
  assert.ok(diagnosticFingerprint(c));
});

test("write failure keeps in-memory result with a warning, preserves disk, and retries safely", (t) => {
  const f = fixture(t);
  f.save();
  const disk = fs.readFileSync(f.history.file),
    write = f.history.write;
  f.history.write = () => {
    throw Error("secret-path failure");
  };
  assert.equal(
    f.save(result({ time: "2026-09-22T01:00:00Z", ok: false })),
    true,
  );
  assert.match(f.history.public()[modelKey("p", "alpha")].saveError, /未保存/);
  assert.match(f.history.error, /保存失败/);
  assert.ok(!f.history.error.includes("secret-path"));
  assert.deepEqual(fs.readFileSync(f.history.file), disk);
  f.history.write = write;
  assert.equal(f.history.save(), true);
  assert.equal(f.history.error, "");
  assert.equal(f.history.public()[modelKey("p", "alpha")].saveError, undefined);
  assert.equal(
    new DiagnosticHistory(f.options).public()[modelKey("p", "alpha")].ok,
    false,
  );
});

test("encryption failure is explicit and does not save plaintext", (t) => {
  const f = fixture(t);
  f.history.crypto = { ...crypto, isEncryptionAvailable: () => false };
  f.save();
  assert.match(f.history.error, /凭据加密/);
  assert.equal(fs.existsSync(f.history.file), false);
});

test("malformed/future-version/invalid records cannot break startup or invent a result", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.history.file, "broken");
  let restored = new DiagnosticHistory(f.options);
  assert.deepEqual(restored.public(), {});
  assert.match(restored.error, /无法读取/);
  fs.writeFileSync(
    f.history.file,
    JSON.stringify({ version: 999, encrypted: "e30=" }),
  );
  assert.deepEqual(new DiagnosticHistory(f.options).public(), {});
  const fingerprint = diagnosticFingerprint(context());
  const invalid = [
    null,
    { fingerprint, result: result({ time: "not-a-date" }) },
    { fingerprint, result: result({ ms: -1 }) },
    { fingerprint, result: result({ ok: "true" }) },
    { fingerprint, result: result({ cancelled: true }) },
  ];
  fs.writeFileSync(
    f.history.file,
    JSON.stringify({
      version: 1,
      encrypted: Buffer.from(JSON.stringify(invalid)).toString("base64"),
    }),
  );
  assert.deepEqual(new DiagnosticHistory(f.options).public(), {});
});
