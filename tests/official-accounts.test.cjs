const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const {
  OFFICIAL_SERVICES,
  serviceForProvider,
} = require("../core/official-services.cjs");
const { NativeKeyStore } = require("../core/native-key-store.cjs");
const { OpenRouterAuth } = require("../core/openrouter-auth.cjs");
const { endpoint } = require("../core/models.cjs");

test("official classification uses known origin, not a provider's brand or name", () => {
  assert.equal(OFFICIAL_SERVICES.length, 19);
  assert.equal(new Set(OFFICIAL_SERVICES.map((s) => s.id)).size, 19);
  assert.equal(
    serviceForProvider({
      name: "OpenAI",
      brand: "openai",
      baseUrl: "https://untrusted.example/v1",
    }),
    undefined,
  );
  assert.equal(
    serviceForProvider({ baseUrl: "https://api.openai.com.evil.example/v1" }),
    undefined,
  );
  assert.equal(
    serviceForProvider({ baseUrl: "https://api.z.ai/api/coding/paas/v4" }).id,
    "zai",
  );
  assert.equal(
    serviceForProvider({ baseUrl: "https://api.kimi.com/coding/v1" }).id,
    "kimi",
  );
  assert.equal(
    OFFICIAL_SERVICES.find((s) => s.id === "cursor").oauth,
    undefined,
  );
});
test("versioned compatibility API prefixes do not get an extra v1", () => {
  assert.equal(
    endpoint(
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "openai-chat",
    ),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(
    endpoint("https://api.z.ai/api/coding/paas/v4", "openai-chat"),
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
  );
  assert.equal(
    endpoint("https://api.anthropic.com", "anthropic"),
    "https://api.anthropic.com/v1/messages",
  );
});
test("native-only keys are encrypted at rest, redacted in public snapshots and can rotate", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-vault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (b) => {
      const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
    },
  };
  const store = new NativeKeyStore(dir, codec);
  const id = store.save({
    vendorId: "cursor",
    label: "Work",
    apiKey: "fixture-key-one",
  });
  assert.ok(!fs.readFileSync(store.file, "utf8").includes("fixture-key-one"));
  assert.ok(!JSON.stringify(store.public()).includes("secret"));
  const loaded = new NativeKeyStore(dir, codec);
  assert.equal(loaded.read(id), "fixture-key-one");
  loaded.save({
    id,
    vendorId: "cursor",
    label: "Personal",
    apiKey: "fixture-key-two",
  });
  assert.equal(loaded.read(id), "fixture-key-two");
  assert.throws(() =>
    loaded.save({ vendorId: "openai", label: "Wrong", apiKey: "fixture" }),
  );
  loaded.remove(id);
  assert.deepEqual(loaded.public(), []);
  assert.throws(() => loaded.read(id));
});
const waitFor = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(10);
  }
  throw Error("Timeout");
};
function fixture(options = {}) {
  const urls = [],
    saved = [],
    calls = [];
  const auth = new OpenRouterAuth({
    openExternal: async (url) => urls.push(url),
    fetchUpstream: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ key: "fixture-pkce-key" });
    },
    saveKey: (key, label) => {
      saved.push({ key, label });
      return "fixture-provider";
    },
    ...options,
  });
  const callback = () =>
    new URL(new URL(urls[0]).searchParams.get("callback_url"));
  return { auth, urls, saved, calls, callback };
}
test("OpenRouter PKCE binds a one-use random callback and keeps the key out of state", async () => {
  const f = fixture();
  try {
    await f.auth.start("Work");
    const redirect = new URL(f.urls[0]),
      callback = f.callback();
    assert.equal(redirect.origin, "https://openrouter.ai");
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(callback.hostname, "localhost");
    const wrong = new URL(callback);
    wrong.pathname = "/wrong";
    assert.equal((await fetch(wrong)).status, 404);
    assert.equal(f.calls.length, 0);
    callback.searchParams.set("code", "fixture-code");
    assert.equal((await fetch(callback)).status, 200);
    await waitFor(() => f.auth.state.status === "complete");
    assert.equal(f.calls.length, 1);
    const request = JSON.parse(f.calls[0].init.body);
    assert.equal(
      crypto
        .createHash("sha256")
        .update(request.code_verifier)
        .digest("base64url"),
      redirect.searchParams.get("code_challenge"),
    );
    assert.equal(f.calls[0].init.redirect, "error");
    assert.equal(f.saved[0].key, "fixture-pkce-key");
    assert.ok(!JSON.stringify(f.auth.state).includes("fixture-pkce-key"));
    assert.equal(f.auth.job, null);
  } finally {
    f.auth.cancel();
  }
});
test("cancelling an in-flight exchange cannot save late credentials", async () => {
  let resolve;
  const f = fixture({
    fetchUpstream: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await f.auth.start();
  const callback = f.callback();
  callback.searchParams.set("code", "fixture-code");
  await fetch(callback);
  assert.equal(f.auth.state.status, "exchanging");
  f.auth.cancel();
  resolve(Response.json({ key: "late-fixture-key" }));
  await delay(20);
  assert.equal(f.auth.state.status, "cancelled");
  assert.equal(f.saved.length, 0);
});
test("OAuth errors and timeout are redacted and release the callback listener", async () => {
  const f = fixture({
    fetchUpstream: async () =>
      Response.json({ error: "do-not-display" }, { status: 401 }),
  });
  await f.auth.start();
  const callback = f.callback();
  callback.searchParams.set("code", "fixture-code");
  await fetch(callback);
  await waitFor(() => f.auth.state.status === "failed");
  assert.ok(!JSON.stringify(f.auth.state).includes("do-not-display"));
  assert.equal(f.saved.length, 0);
  const timed = fixture({ timeout: 10 });
  await timed.auth.start();
  await waitFor(() => timed.auth.state.status === "failed");
  assert.equal(timed.auth.job, null);
});
