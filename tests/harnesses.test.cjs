const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const TOML = require("@iarna/toml");
const {
  HarnessManager,
  apiAccounts,
  isolatedEnv,
  routeConfig,
  authSummary,
} = require("../core/harnesses.cjs");
const {
  normalizeOAuth,
  enumerateSources,
} = require("../core/oauth-import.cjs");
const { parseImport } = require("../core/models.cjs");
const { Router } = require("../core/router.cjs");
function desktopFixture(root) {
  const local = path.join(root, "local");
  const desktop = path.join(local, "Programs", "@opencode-aidesktop", "OpenCode.exe");
  fs.mkdirSync(path.join(path.dirname(desktop), "resources"), { recursive: true });
  fs.writeFileSync(desktop, "synthetic executable");
  fs.writeFileSync(path.join(path.dirname(desktop), "resources/app.asar"), "synthetic archive");
  return { desktop, launchEnv: { PATH: "", USERPROFILE: root, LOCALAPPDATA: local } };
}
const providers = parseImport({
  providers: [
    {
      id: "deep",
      name: "DeepSeek",
      brand: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "synthetic-deep-key",
      wireApi: "openai-chat",
      models: [{ model: "deepseek-chat", wireApi: "openai-chat" }],
    },
    {
      id: "go",
      name: "Go",
      brand: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "synthetic-go-key",
      wireApi: "openai-chat",
      models: [{ model: "qwen", wireApi: "openai-chat" }],
    },
    {
      id: "ant",
      name: "Claude API",
      baseUrl: "https://api.anthropic.com",
      apiKey: "synthetic-ant-key",
      models: [{ model: "claude-test", wireApi: "anthropic" }],
    },
  ],
});
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-clients-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("desktop-only OpenCode is displayed as installed and never launched with CLI credentials", async (t) => {
  const root = temp(t), { desktop, launchEnv } = desktopFixture(root);
  const manager = new HarnessManager(root, () => ({providers: []}), [], path.join(root,"codex"), { home:root, env:{}, launchEnv });
  await manager.refreshOAuth();
  const client = manager.snapshot().clients.find(c => c.id === "opencode");
  assert.equal(client.launcher.installed, true);
  assert.equal(client.executable, "");
  assert.equal(client.desktop, desktop);
  await assert.rejects(manager.launch("opencode", "not-an-account", "login"), /OpenCode CLI/);
  assert.equal(fs.existsSync(path.join(root,"clients")), false);
  manager.setExecutable("opencode", desktop);
  const restored = new HarnessManager(root, () => ({providers: []}), [], path.join(root,"codex"), { home:root, env:{}, launchEnv });
  assert.equal(restored.launcher("opencode").kind, "desktop");
  assert.equal(restored.desktop("opencode"), desktop);
  fs.unlinkSync(desktop);
  assert.equal(restored.desktop("opencode"), null);
});

test("auto-discovery prefers CLI when Desktop is also present and respects explicit Desktop selection", async (t) => {
  const root = temp(t), { desktop, launchEnv } = desktopFixture(root);
  const bin = path.join(root, "bin"), cli = path.join(bin, "opencode.exe");
  fs.mkdirSync(bin);
  fs.writeFileSync(cli, "synthetic CLI");
  launchEnv.PATH = bin;
  const manager = new HarnessManager(root, () => ({providers: []}), [], path.join(root,"codex"), { home:root, env:{}, launchEnv });
  await manager.refreshOAuth();
  assert.equal(manager.launcher("opencode").executable, cli);
  assert.equal(manager.desktop("opencode"), desktop);
  manager.setExecutable("opencode", desktop);
  await manager.refreshOAuth();
  assert.equal(manager.launcher("opencode").kind, "desktop");
});
test("Claude virtual desktop archive is not a second CLI; saved selection survives full rediscovery", async (t) => {
  const root = temp(t), bin = path.join(root, "bin"), local = path.join(root, "local");
  const cli = path.join(bin, "claude.cmd"), desktop = path.join(local, "Programs/Claude/claude.exe");
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(cli, "synthetic CLI");
  fs.mkdirSync(path.join(path.dirname(desktop), "resources/app.asar"), { recursive: true });
  fs.writeFileSync(desktop, "synthetic desktop");
  fs.writeFileSync(path.join(path.dirname(desktop), "resources/app.asar/package.json"), '{"name":"desktop-shell"}');
  const options = { home: root, env: {}, launchEnv: { PATH: bin, USERPROFILE: root, LOCALAPPDATA: local } };
  const manager = new HarnessManager(root, () => ({ providers: [] }), [], path.join(root, "codex"), options);
  await manager.refreshOAuth({ rediscover: true });
  assert.equal(manager.launcher("claude").executable, cli);
  assert.equal(manager.desktop("claude"), desktop);
  manager.setExecutable("claude", cli);
  const loaded = new HarnessManager(root, () => ({ providers: [] }), [], path.join(root, "codex"), options);
  await loaded.refreshOAuth({ rediscover: true });
  assert.equal(loaded.launcher("claude").executable, cli);
  assert.equal(loaded.desktop("claude"), desktop);
  fs.unlinkSync(desktop);
  await loaded.refreshOAuth({ rediscover: true });
  assert.equal(loaded.desktop("claude"), null);
  assert.equal(loaded.launcher("claude").executable, cli);
});

test("real multiple installation choices report location ambiguity, not running clients", (t) => {
  const root = temp(t), manager = new HarnessManager(root, () => ({ providers: [] }), [], path.join(root, "codex"), { home: root, env: {}, launchEnv: { PATH: "", USERPROFILE: root } });
  manager.discovery.claude = [{ ready: true, location: "one" }, { ready: true, location: "two" }];
  assert.equal(manager.launcher("claude").ambiguous, true);
  assert.match(manager.launcher("claude").message, /安装位置/);
  assert.doesNotMatch(manager.launcher("claude").message, /点击自动识别后/);
});

test("DeepSeek and Go are API accounts; Claude filters incompatible models", () => {
  assert.equal(apiAccounts("dsh", providers)[0].badge, "DeepSeek API");
  assert.equal(apiAccounts("opencode", providers)[0].badge, "OpenCode Go API");
  assert.equal(apiAccounts("claude", providers).length, 1);
  assert.equal(apiAccounts("claude", providers)[0].ready, true);
  assert.equal(apiAccounts("claude", providers)[0].models.length, 1);
  assert.ok(
    !JSON.stringify(apiAccounts("pi", providers)).includes(
      "synthetic-deep-key",
    ),
  );
});
test("five harness config generators never embed upstream keys", () => {
  for (const id of ["codex", "claude", "opencode", "pi", "dsh"]) {
    const p = providers[id === "claude" ? 2 : 0];
    const plan = routeConfig(id, p, p.models[0], "C:\\temp", "local-token", {
      models: [],
    });
    assert.ok(!JSON.stringify(plan).includes(p.apiKey));
    if (id === "codex")
      {
        const config = TOML.parse(plan.files.find(([f]) => f === "config.toml")[1]);
        assert.equal(config.model_providers.ASS.env_key, "ASS_LOCAL_TOKEN");
        assert.equal(config.model_providers.ASS.requires_openai_auth, false);
      }
    if (id === "dsh")
      assert.equal(
        JSON.parse(plan.files[0][1])["llm-pi-ai"].providers["ass-api"]
          .apiKeyEnv,
        "ASS_LOCAL_TOKEN",
      );
    if (id === "opencode")
      assert.ok(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT).provider.ass);
  }
});
test("native profiles are isolated; official launch clears third-party auth environment", (t) => {
  const dir = temp(t);
  const env = isolatedEnv("pi", dir, {
    ANTHROPIC_AUTH_TOKEN: "bad",
    OPENAI_BASE_URL: "https://other",
    PI_CODING_AGENT_DIR: "old",
    NODE_EXTRA_CA_CERTS: "trusted.pem",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    PATH: "safe",
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, "trusted.pem");
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, dir);
  assert.equal(env.NODE_USE_SYSTEM_CA, "1");
});
test("account switches do not rewrite other profile files; API launch does not use OAuth dir", (t) => {
  const dir = temp(t),
    manager = new HarnessManager(dir, () => ({ providers }), []);
  const one = manager.add("claude", "one"),
    two = manager.add("claude", "two");
  assert.notEqual(manager.root("claude", one), manager.root("claude", two));
  fs.writeFileSync(
    path.join(manager.root("claude", one), ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"synthetic"}}',
  );
  manager.select("claude", two);
  assert.equal(authSummary("claude", manager.root("claude", one)).ready, true);
  const route = manager.plan("claude", "api:ant", "launch", null, "token");
  assert.notEqual(route.dir, manager.root("claude", two));
  assert.equal(route.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(route.env.ANTHROPIC_API_KEY, "synthetic-ant-key");
  assert.throws(() => manager.root("claude", "../escape"));
});
test("OAuth import converts exact formats and rejects API keys / incomplete credentials", () => {
  const jwt =
    "header." +
    Buffer.from(
      JSON.stringify({
        exp: 2000000000,
        "https://api.openai.com/auth": { chatgpt_account_id: "acc" },
      }),
    ).toString("base64url") +
    ".signature";
  const c = normalizeOAuth("codex", {
    tokens: { access_token: jwt, refresh_token: "synthetic-refresh" },
  });
  assert.equal(c.provider, "openai-codex");
  assert.equal(c.record.expires, 2000000000000);
  assert.equal(c.record.accountId, "acc");
  assert.equal(
    normalizeOAuth("claude", {
      claudeAiOauth: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 2000000000000,
      },
    }).provider,
    "anthropic",
  );
  assert.throws(() => normalizeOAuth("codex", { OPENAI_API_KEY: "not-oauth" }));
  assert.throws(() =>
    normalizeOAuth(
      "opencode",
      { openai: { type: "api", key: "key" } },
      "openai",
    ),
  );
});
test("pi import always creates a new account, keeps source immutable and renderer secret-free", (t) => {
  const dir = temp(t),
    codexDir = path.join(dir, "codex");
  fs.mkdirSync(codexDir);
  const manager = new HarnessManager(
    path.join(dir, "app"),
    () => ({ providers }),
    [],
    codexDir,
  );
  const original = JSON.stringify({
    tokens: {
      access_token:
        "h." + Buffer.from('{"exp":2000000000,"https://api.openai.com/auth":{"chatgpt_account_id":"acc"}}').toString("base64url") + ".s",
      refresh_token: "secret-refresh",
      account_id: "acc",
    },
  });
  fs.writeFileSync(path.join(codexDir, "auth.json"), original);
  assert.throws(() => manager.importOAuth("local-codex", "first"));
  manager.piProviders = [{ id: "openai-codex", name: "Codex" }];
  const a = manager.importOAuth("local-codex", "first"),
    b = manager.importOAuth("local-codex", "second");
  assert.notEqual(a, b);
  assert.equal(
    fs.readFileSync(path.join(codexDir, "auth.json"), "utf8"),
    original,
  );
  const snapshot = JSON.stringify(manager.snapshot());
  assert.ok(!snapshot.includes("secret-refresh"));
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(manager.root("pi", a), "auth.json"), "utf8"),
    )["openai-codex"].type,
    "oauth",
  );
});
test("native protocol relay authenticates, never forwards OAuth, rejects mismatched protocols", async (t) => {
  const calls = [];
  const router = new Router({
    getState: () => ({ providers }),
    fetchUpstream: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  router.port = 0;
  await router.start();
  router.port = router.server.address().port;
  t.after(() => router.stop());
  const base = "http://127.0.0.1:" + router.port + "/harness/deep/v1/";
  const send = (suffix, auth) =>
    fetch(base + suffix, {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "chatgpt-account-id": "secret-account",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: true,
        messages: [{ role: "user", content: "OK" }],
      }),
    });
  assert.equal((await send("chat/completions", "wrong")).status, 401);
  assert.equal((await send("responses", router.clientToken)).status, 400);
  const r = await send("chat/completions", router.clientToken);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /DONE/);
  assert.equal(calls[0].headers.authorization, "Bearer synthetic-deep-key");
  assert.equal(calls[0].headers["chatgpt-account-id"], undefined);
});
