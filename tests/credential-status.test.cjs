const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  discoverNative,
  inspectCredentials,
  parseRecords,
  nativeLocations,
} = require("../core/credential-status.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { Preferences } = require("../core/preferences.cjs");
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-auth-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof data === "string" ? data : JSON.stringify(data),
  );
}
const grant = {
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 2100000000000,
};
function seed(home) {
  write(path.join(home, ".codex/auth.json"), {
    auth_mode: "chatgpt",
    tokens: {
      access_token: grant.access,
      refresh_token: grant.refresh,
      account_id: "private-account",
    },
  });
  write(path.join(home, ".claude/.credentials.json"), {
    claudeAiOauth: {
      accessToken: grant.access,
      refreshToken: grant.refresh,
      expiresAt: grant.expires,
    },
  });
  write(path.join(home, ".local/share/opencode/auth.json"), {
    openai: grant,
    anthropic: grant,
    "opencode-go": { type: "api", key: "synthetic-key" },
  });
  write(path.join(home, ".pi/agent/auth.json"), {
    "openai-codex": grant,
    "github-copilot": grant,
    custom: grant,
  });
  write(
    path.join(home, ".dsh/.credentials.yaml"),
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-key\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload: " +
      JSON.stringify(grant) +
      "\n",
  );
}
test("all five native harnesses discover their own OAuth/API records separately", (t) => {
  const home = temp(t);
  seed(home);
  const counts = { codex: 1, claude: 1, opencode: 3, pi: 3, dsh: 2 };
  for (const [harness, count] of Object.entries(counts)) {
    const found = discoverNative(harness, { home }).flatMap((s) => s.accounts);
    assert.equal(found.length, count, harness);
    assert.ok(
      found.some((a) => a.authType === "oauth" && a.ready),
      harness,
    );
    assert.equal(new Set(found.map((a) => a.id)).size, count);
    const result = JSON.stringify(found);
    if (harness === "codex")
      assert.equal(
        found[0].profile.fields.find((f) => f.id === "accountId").value,
        "private-account",
      );
    for (const secret of [grant.access, grant.refresh, "synthetic-key"])
      assert.ok(!result.includes(secret));
    assert.deepEqual(
      found,
      discoverNative(harness, { home }).flatMap((s) => s.accounts),
    );
  }
});
test("expiry, refresh capability and empty credentials never become verified login", () => {
  const old = { ...grant, expires: 1000000000000 };
  assert.equal(parseRecords("pi", { a: old })[0].status, "refresh-required");
  assert.equal(
    parseRecords("pi", { a: { ...old, refresh: "" } })[0].ready,
    false,
  );
  assert.equal(
    parseRecords("opencode", { a: { ...grant, access: "" } })[0].status,
    "incomplete",
  );
  assert.equal(
    parseRecords("codex", { OPENAI_API_KEY: "synthetic-key" })[0].authType,
    "api",
  );
  assert.equal(
    parseRecords("pi", { a: { type: "api_key", key: "!do-not-run" } })[0].ready,
    false,
  );
  assert.equal(
    parseRecords("pi", { a: grant })[0].message,
    "OAuth",
  );
  assert.equal(
    parseRecords("opencode", {
      custom: { type: "wellknown", key: "secret" },
    })[0].status,
    "external",
  );
});
test("malformed, missing and keyring-only credentials are distinct and errors contain no source text", (t) => {
  const dir = temp(t);
  assert.equal(inspectCredentials("codex", dir).status, "missing");
  write(path.join(dir, "auth.json"), '{"secret":"never-print-credential');
  const broken = inspectCredentials("codex", dir);
  assert.equal(broken.status, "unreadable");
  assert.ok(!JSON.stringify(broken).includes("never-print"));
  write(
    path.join(dir, "config.toml"),
    'cli_auth_credentials_store = "keyring"',
  );
  assert.equal(inspectCredentials("codex", dir).status, "external");
  write(
    path.join(dir, ".credentials.yaml"),
    "records: [invalid\nsecret: never-print",
  );
  assert.equal(inspectCredentials("dsh", dir).status, "unreadable");
});
test("environment and persisted custom homes are checked alongside defaults without duplicates", (t) => {
  const home = temp(t),
    custom = path.join(home, "custom"),
    explicit = path.join(home, "explicit");
  const env = {
    CLAUDE_CONFIG_DIR: custom,
    PI_CODING_AGENT_DIR: custom,
    DSH_HOME: custom,
    XDG_DATA_HOME: path.join(home, "xdg"),
  };
  for (const h of ["claude", "pi", "dsh"])
    assert.equal(nativeLocations(h, home, env, explicit)[1], custom);
  assert.equal(
    nativeLocations("opencode", home, env)[0],
    path.join(home, "xdg/opencode"),
  );
  assert.equal(
    nativeLocations(
      "codex",
      home,
      {},
      path.join(home, ".codex"),
      path.join(home, ".codex"),
    ).length,
    1,
  );
  const fromEnv = discoverNative("claude", {
    home,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-env-oauth" },
  });
  assert.equal(fromEnv[0].accounts[0].authType, "oauth");
  assert.ok(!JSON.stringify(fromEnv).includes("synthetic-env-oauth"));
});
test("native account selection and launch plans never overwrite auth/config; all selections survive restart", (t) => {
  const dir = temp(t),
    home = path.join(dir, "home");
  seed(home);
  const providers = [
    {
      id: "fixture",
      name: "Fixture",
      baseUrl: "https://example.test/v1",
      apiKey: "synthetic-key",
      enabled: true,
      models: ["a", "b"].map((model) => ({
        model,
        displayName: model,
        enabled: true,
        wireApi: "openai-chat",
        efforts: ["low"],
        defaultEffort: "low",
      })),
    },
  ];
  const create = () =>
    new HarnessManager(
      dir,
      () => ({ providers }),
      [],
      path.join(home, ".codex"),
      { home, env: {}, isConnected: () => true },
    );
  const manager = create();
  for (const h of ["codex", "claude", "pi"]) {
    const account = manager
      .snapshot()
      .clients.find((c) => c.id === h)
      .accounts.find((a) => a.authType === "oauth");
    const before = fs.readFileSync(account.sourcePath);
    manager.select(h, account.id);
    const plan = manager.plan(h, account.id);
    assert.equal(plan.routed, false);
    assert.equal(plan.files.length, 0);
    manager.materialize(plan);
    assert.deepEqual(fs.readFileSync(account.sourcePath), before);
    assert.equal(
      create()
        .snapshot()
        .clients.find((c) => c.id === h).selected,
      account.id,
    );
  }
  manager.setInjection("pi", { excludedProviders: ["not-selected-provider"] });
  assert.throws(
    () => manager.setCredentialHome("pi", path.join(home, ".pi/agent")),
    /先断开/,
  );
  manager.options.isConnected = () => false;
  manager.setCredentialHome("pi", path.join(home, ".pi/agent"));
  assert.deepEqual(create().state.injections.pi.excludedProviders, ["not-selected-provider"]);
  assert.equal(create().state.credentialHomes.pi, path.join(home, ".pi/agent"));
  assert.deepEqual(create().modelPlan("pi", JSON.stringify(["fixture", "b"])).args, [
    "--provider",
    require("../core/native-config.cjs").providerId(
      providers[0],
      "openai-chat",
    ),
    "--model",
    "b",
    "--thinking",
    "low",
  ]);
  assert.throws(() => manager.selectModel("claude", "api:fixture", "b"));
  assert.ok(!fs.readFileSync(manager.file, "utf8").includes("synthetic"));
});
test("managed OpenCode/Pi/DSH profiles enumerate individual provider cards and stale login is not persisted", (t) => {
  const dir = temp(t),
    home = path.join(dir, "home"),
    manager = new HarnessManager(
      dir,
      () => ({ providers: [] }),
      [],
      path.join(home, ".codex"),
      { home, env: {} },
    );
  manager.piProviders = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const id = manager.add("pi", "Work", "a");
  const file = path.join(manager.root("pi", id), "auth.json");
  write(file, { a: grant, b: grant });
  const cards = manager.snapshot().clients.find((c) => c.id === "pi").accounts;
  assert.equal(cards.length, 2);
  assert.equal(manager.plan("pi", cards[1].id).dir, manager.root("pi", id));
  manager.select("pi", cards[0].id);
  write(file, { b: grant });
  const remaining = manager.snapshot().clients.find((c) => c.id === "pi");
  assert.equal(remaining.accounts[0].id, cards[1].id);
  assert.equal(remaining.selected, "");
  write(file, {});
  assert.equal(
    manager.snapshot().clients.find((c) => c.id === "pi").accounts[0].ready,
    false,
  );
});
test("UI preferences persist with an allowlist and do not accept secrets or invalid page IDs", (t) => {
  const dir = temp(t),
    preferences = new Preferences(dir);
  // New UI features may add defaults. This test protects persisted changes and
  // the allowlist, while requiring every unrelated initial preference to survive.
  const initial = structuredClone(preferences.state);
  preferences.update({
    view: "clients",
    client: "dsh",
    provider: "fixture",
    officialService: "deepseek",
    token: "secret",
  });
  assert.deepEqual(new Preferences(dir).state, {
    ...initial,
    view: "clients",
    client: "dsh",
    provider: "fixture",
    officialService: "deepseek",
  });
  preferences.update({ view: "<script>", client: "unknown" });
  assert.equal(new Preferences(dir).state.view, "clients");
  assert.ok(!fs.readFileSync(preferences.file, "utf8").includes("secret"));
});
test("native OAuth launches clear inherited API overrides and use the selected credential source", (t) => {
  const dir = temp(t),
    home = path.join(dir, "home");
  seed(home);
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "env-token",
    ANTHROPIC_API_KEY: "api-override",
    OPENAI_API_KEY: "other-key",
    XDG_CONFIG_HOME: path.join(home, "config"),
  };
  const manager = new HarnessManager(
    dir,
    () => ({ providers: [] }),
    [],
    path.join(home, ".codex"),
    { home, env },
  );
  const account = manager
    .snapshot()
    .clients.find((c) => c.id === "claude")
    .accounts.find((a) => a.source === "本机账户");
  const plan = manager.plan("claude", account.id);
  assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(
    manager.plan("claude", "native:claude-env").env.CLAUDE_CODE_OAUTH_TOKEN,
    "env-token",
  );
});
