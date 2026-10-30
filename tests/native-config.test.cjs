const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseImport } = require("../core/models.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { modelRef } = require("../core/client-policy.cjs");
const { NativeFields, document, edit } = require("../core/native-fields.cjs");
const {
  NativeConfig,
  locations,
  compose,
  providerId,
  piLiteral,
  baseUrl,
} = require("../core/native-config.cjs");
const { Connections } = require("../core/connections.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const crypt = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    data = path.join(root, "data");
  const providers = parseImport({
    providers: [
      {
        id: "fixture",
        name: "Mixed API",
        baseUrl: "https://example.test",
        apiKey: "synthetic-key",
        models: [
          { model: "chat", wireApi: "openai-chat" },
          { model: "responses", wireApi: "openai-responses" },
          { model: "messages", wireApi: "anthropic" },
        ],
      },
    ],
  });
  const manager = new HarnessManager(
    data,
    () => ({ providers }),
    [],
    path.join(home, ".codex"),
    { home, env: {}, isConnected: () => true },
  );
  const originalLauncher = manager.launcher.bind(manager);
  manager.launcher = id => id === 'opencode' ? { ...originalLauncher(id), version: '1.18.33' } : originalLauncher(id);
  const native = new NativeConfig(data, crypt, manager);
  manager.options.nativeConfig = native;
  return { root, home, data, providers, manager, native };
}
const grant = {
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 2100000000000,
};

test('all native harnesses rename legacy ASS namespaces and keep the same selected model without owning later choices', t => {
  const f = fixture(t);
  for (const id of ['opencode', 'pi', 'dsh', 'kimi', 'zcode']) {
    const oldFields = JSON.parse(JSON.stringify(f.native.desired(id).fields).replace(/ASS-([a-f0-9]{16})/g, 'ass-$1'));
    f.native.fields.apply(id, oldFields);
    const target = locations(id, f.manager), format = id === 'kimi' ? 'toml' : target.format || (id === 'opencode' ? 'jsonc' : 'json');
    const config = document(fs.readFileSync(target.config, 'utf8'), format).data;
    const legacy = providerId(f.providers[0], 'openai-chat').replace(/^ASS-/, 'ass-');
    const alias = id === 'kimi' ? Object.keys(config.models).find(key => key.startsWith(legacy)) : legacy;
    const file = id === 'pi' ? target.settings : target.config;
    const keys = id === 'pi' ? ['defaultProvider'] : id === 'dsh' ? ['agent-default-model', 'provider']
      : id === 'kimi' ? ['default_model'] : id === 'zcode' ? ['config', 'defaultModelSelection'] : ['model'];
    const value = id === 'opencode' ? legacy + '/chat' : id === 'zcode' ? { providerId: legacy, modelId: 'chat' } : alias;
    const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    write(file, id === 'kimi' ? '\uFEFFdefault_model = ' + JSON.stringify(value) + ' # keep selection\n' + source
      : edit(source, format, keys, { exists: true, value }));
    f.native.sync(id);
    const updated = document(fs.readFileSync(file, 'utf8'), format).data;
    const actual = keys.reduce((data, key) => data[key], updated);
    assert.deepEqual(actual, id === 'zcode' ? { providerId: 'ASS-' + legacy.slice(4), modelId: 'chat' }
      : 'ASS-' + value.slice(4), id);
    assert.equal(f.native.status(id, true).applied, true, id);
    assert.ok(!f.native.fields.entries.some(e => e.harness === id && e.renameOnly), id);
    write(file, edit(fs.readFileSync(file, 'utf8'), format, keys, { exists: false }));
    f.native.restore([id]);
  }
});

test("three native formats separate wire protocols, use real origins and preserve default OAuth unless selected", (t) => {
  const f = fixture(t),
    p = f.providers[0];
  for (const id of ["opencode", "pi", "dsh"]) {
    const target = locations(id, f.manager);
    write(
      target.config,
      id === "dsh"
        ? "# keep plugins\nplugins: [custom]\n"
        : { plugin: ["custom"], providers: { user: { models: [] } } },
    );
    if (id === "dsh")
      write(
        target.auth,
        "version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload: " +
          JSON.stringify(grant) +
          "\n",
      );
    else write(target.auth, { "openai-codex": grant });
    f.native.sync(id);
    if (id === "dsh")
      assert.equal(
        f.native.status(id, true).runtimeStatus,
        "client-refresh-required",
      );
    const config = document(
      fs.readFileSync(target.config, "utf8"),
      id === "dsh" ? "yaml" : "jsonc",
    ).data;
    const auth = document(
      fs.readFileSync(target.auth, "utf8"),
      id === "dsh" ? "yaml" : "json",
    ).data;
    assert.deepEqual(
      id === "dsh"
        ? auth.records["llm-pi-ai/openai-codex"].payload
        : auth["openai-codex"],
      grant,
    );
    const collection =
      id === "dsh"
        ? config["llm-pi-ai"].providers
        : id === "pi"
          ? config.providers
          : config.provider;
    for (const wire of ["openai-chat", "openai-responses", "anthropic"]) {
      assert.ok(collection[providerId(p, wire)]);
      assert.match(providerId(p, wire), /^ASS-[a-f0-9]{16}-(chat|responses|messages)$/);
    }
    assert.doesNotMatch(
      JSON.stringify(config),
      /127\.0\.0\.1|ASS_LOCAL_TOKEN|synthetic-key/,
    );
    assert.equal(config.model, undefined);
    assert.equal(config["agent-default-model"], undefined);
    assert.ok(
      f.manager
        .snapshot()
        .clients.find((c) => c.id === id)
        .modelAccounts.some((a) => a.authType === "oauth"),
    );
    assert.equal(
      f.manager
        .snapshot()
        .clients.find((c) => c.id === id)
        .modelAccounts.filter((a) => a.kind === "native").length,
      1,
    );
    f.native.restore([id]);
    const restored = document(
      fs.readFileSync(target.auth, "utf8"),
      id === "dsh" ? "yaml" : "json",
    ).data;
    assert.deepEqual(
      id === "dsh"
        ? restored.records["llm-pi-ai/openai-codex"].payload
        : restored["openai-codex"],
      grant,
    );
    assert.doesNotMatch(JSON.stringify(restored), /synthetic-key/);
  }
});

test("sync/disable preserves OAuth refresh, unrelated fields and JSONC/YAML comments", (t) => {
  const f = fixture(t);
  for (const id of ["opencode", "pi", "dsh"]) {
    const target = locations(id, f.manager),
      format = id === "dsh" ? "yaml" : "json";
    write(
      target.auth,
      id === "dsh"
        ? "version: 1\n# native grant\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload: " +
            JSON.stringify(grant) +
            "\n"
        : { "openai-codex": grant },
    );
    if (id === "opencode")
      write(
        target.config,
        '{\n// user MCP\n"mcp":{"keep":{"enabled":true}},\n"model":"openai/original",\n}\n',
      );
    if (id === "dsh")
      write(
        target.config,
        "# user MCP\nmcp: { keep: true }\nagent-default-model:\n  provider: native\n  model: original\n  reasoningEffort: low\n",
      );
    if (id === "pi")
      write(target.settings, {
        defaultProvider: "openai-codex",
        defaultModel: "original",
        theme: "light",
      });
    f.manager.setInjection(id, { excludedProviders: [] });
    f.native.sync(id);
    let auth = document(fs.readFileSync(target.auth, "utf8"), format).data;
    const entry =
      id === "dsh"
        ? auth.records["llm-pi-ai/openai-codex"].payload
        : auth["openai-codex"];
    entry.access = "rotated-access";
    write(target.auth, id === "dsh" ? require("yaml").stringify(auth) : auth);
    f.providers[0].models[0].displayName = "renamed";
    f.native.sync(id);
    f.native.restore([id]);
    auth = document(fs.readFileSync(target.auth, "utf8"), format).data;
    assert.equal(
      (id === "dsh"
        ? auth.records["llm-pi-ai/openai-codex"].payload
        : auth["openai-codex"]
      ).access,
      "rotated-access",
    );
    const config = document(
      fs.readFileSync(id === "pi" ? target.settings : target.config, "utf8"),
      id === "dsh" ? "yaml" : "jsonc",
    ).data;
    assert.equal(
      id === "pi"
        ? config.defaultModel
        : id === "dsh"
          ? config["agent-default-model"].model
          : config.model,
      id === "opencode" ? "openai/original" : "original",
    );
    if (id !== "pi")
      assert.match(fs.readFileSync(target.config, "utf8"), /user MCP/);
  }
});

test("owned-field edits conflict without overwriting, and exact ownership does not hide a newly changed OAuth", (t) => {
  const f = fixture(t),
    target = locations("pi", f.manager),
    id = providerId(f.providers[0], "openai-chat");
  f.native.sync("pi");
  const auth = JSON.parse(fs.readFileSync(target.auth));
  auth[id] = grant;
  write(target.auth, auth);
  const before = fs.readFileSync(target.auth, "utf8");
  assert.throws(() => f.native.sync("pi"), /外部修改/);
  assert.throws(() => f.native.restore(["pi"]), /外部修改/);
  assert.equal(fs.readFileSync(target.auth, "utf8"), before);
  assert.ok(
    f.manager
      .snapshot()
      .clients.find((c) => c.id === "pi")
      .accounts.some((a) => a.provider === id && a.authType === "oauth"),
  );
});

test("provider switches update only managed keys; all-off sync and disconnect keep original defaults", (t) => {
  const f = fixture(t),
    target = locations("pi", f.manager);
  write(target.settings, {
    defaultProvider: "oauth",
    defaultModel: "original",
    plugins: ["keep"],
  });
  f.manager.setInjection("pi", { excludedProviders: [] });
  f.native.sync("pi");
  f.providers[0].models[0].displayName = "Changed";
  f.native.sync("pi");
  assert.equal(
    JSON.parse(fs.readFileSync(target.settings)).defaultModel,
    "original",
  );
  const restarted = new NativeConfig(f.data, crypt, f.manager);
  f.manager.options.nativeConfig = restarted;
  restarted.sync("pi");
  restarted.restore(["pi"]);
  assert.equal(
    JSON.parse(fs.readFileSync(target.settings)).defaultModel,
    "original",
  );
  restarted.sync("pi");
  f.manager.setInjection("pi", { excludedProviders: ["fixture"] });
  assert.equal(restarted.sync("pi").modelCount, 0);
  assert.equal(restarted.status("pi", true).applied, true);
  restarted.restore(["pi"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target.auth)), {});
  assert.equal(
    JSON.parse(fs.readFileSync(target.settings)).defaultProvider,
    "oauth",
  );
});

test("native plans use native homes with no proxy token, while Codex and Claude stay isolated", (t) => {
  const f = fixture(t);
  f.manager.nativeEnv = {
    XDG_CONFIG_HOME: path.join(f.home, "custom-config"),
    NODE_EXTRA_CA_CERTS: "C:\\ca.pem",
    HTTP_PROXY: "http://proxy.test",
    OPENAI_API_KEY: "wrong-account",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  };
  for (const id of ["opencode", "pi", "dsh"]) {
    f.native.sync(id);
    const plan = f.manager.modelPlan(id, modelRef("fixture", "chat"), "local-secret");
    assert.equal(plan.dir, locations(id, f.manager).dir);
    assert.equal(plan.routed, false);
    assert.deepEqual(plan.files, []);
    assert.equal(plan.env.ASS_LOCAL_TOKEN, undefined);
    assert.equal(plan.env.OPENAI_API_KEY, undefined);
    assert.equal(plan.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(plan.env.NODE_USE_SYSTEM_CA, "1");
    assert.equal(plan.env.NODE_EXTRA_CA_CERTS, "C:\\ca.pem");
    assert.equal(plan.env.HTTP_PROXY, "http://proxy.test");
    f.manager.materialize(plan);
  }
  for (const id of ["codex", "claude"]) {
    const plan = f.manager.modelPlan(id, modelRef("fixture", id === "claude" ? "messages" : "chat"), "local-secret");
    assert.equal(plan.routed, true);
    assert.equal(plan.env.ASS_LOCAL_TOKEN, "local-secret");
    assert.ok(plan.dir.startsWith(path.join(f.data, "clients")));
    assert.equal(plan.nativeSelection, undefined);
  }
});

test("native path resolution honors overrides and OpenCode JSONC priority; credential-home changes need disconnect", (t) => {
  const f = fixture(t);
  f.manager.nativeEnv.XDG_CONFIG_HOME = path.join(f.home, "xdg");
  const dir = path.join(f.home, "xdg/opencode");
  write(path.join(dir, "opencode.json"), {});
  write(path.join(dir, "opencode.jsonc"), {});
  assert.equal(
    locations("opencode", f.manager).config,
    path.join(dir, "opencode.jsonc"),
  );
  f.manager.nativeEnv.OPENCODE_CONFIG = path.join(f.home, "custom.jsonc");
  assert.equal(
    locations("opencode", f.manager).config,
    f.manager.nativeEnv.OPENCODE_CONFIG,
  );
  f.manager.nativeEnv.DSH_HOME = path.join(f.home, "custom-dsh");
  assert.equal(locations("dsh", f.manager).dir, f.manager.nativeEnv.DSH_HOME);
  assert.throws(() => f.manager.setCredentialHome("pi", f.home), /先断开/);
});

test("native limitations are explicit and imported config values cannot become commands", (t) => {
  const f = fixture(t),
    p = f.providers[0];
  assert.equal(piLiteral("!echo $TOKEN"), "$!echo $$TOKEN");
  p.apiKey = "!echo $TOKEN";
  p.extraHeaders = { "X-Test": "!echo $TOKEN" };
  const pi = compose("pi", f.manager);
  assert.ok(
    pi.fields.some(
      (e) => e.credentialProvider && e.value.key === "$!echo $$TOKEN",
    ),
  );
  p.models[0].defaultEffort = "ultra";
  assert.throws(() => f.manager.modelPlan("pi", modelRef("fixture", "chat")), /原生思维强度/);
  p.models[0].defaultEffort = "medium";
  p.extraHeaders = { "X-Test": "{file:secret}" };
  assert.throws(() => compose("opencode", f.manager), /插值/);
  assert.equal(baseUrl("pi", p, "anthropic"), "https://example.test");
  assert.equal(baseUrl("opencode", p, "anthropic"), "https://example.test/v1");
});

test("native ledger is encoded at rest, corrupt and unavailable encryption fail closed", (t) => {
  const f = fixture(t);
  f.native.sync("pi");
  const ledger = fs.readFileSync(f.native.fields.file, "utf8");
  assert.doesNotMatch(ledger, /synthetic-key|synthetic-access/);
  write(f.native.fields.file, "bad");
  const broken = new NativeFields(f.data, crypt);
  assert.ok(broken.error);
  assert.throws(() => broken.apply("pi", []), /损坏/);
  write(f.native.fields.file, { version: 1, encrypted: Buffer.from('{"entries":null}').toString("base64") });
  const invalidStructure = new NativeConfig(f.data, crypt, f.manager);
  assert.ok(invalidStructure.status("pi").error);
  assert.deepEqual(invalidStructure.fields.entries, []);
  const disabled = new NativeFields(path.join(f.root, "unavailable"), {
    isEncryptionAvailable: () => false,
  });
  const file = path.join(f.home, "new.json");
  assert.throws(
    () =>
      disabled.apply("pi", [
        { harness: "pi", file, format: "json", path: ["ass"], value: 1 },
      ]),
    /加密不可用/,
  );
  assert.equal(fs.existsSync(file), false);
});

test("malformed documents, duplicate keys, aliases, scalar parents and symlinks are refused", (t) => {
  const f = fixture(t),
    file = path.join(f.home, "guard.json"),
    ledger = f.native.fields;
  for (const text of [
    "{broken",
    '{"providers":{},"providers":{}}',
    '{"providers":7}',
  ]) {
    write(file, text);
    assert.throws(() =>
      ledger.apply("pi", [
        {
          harness: "pi",
          file,
          format: "json",
          path: ["providers", "ass"],
          value: 1,
        },
      ]),
    );
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  assert.throws(
    () => document("original: &a { key: 1 }\ncopy: *a\n", "yaml"),
    /别名/,
  );
  const link = path.join(f.home, "link");
  fs.symlinkSync(f.data, link, "junction");
  assert.throws(
    () =>
      ledger.apply("pi", [
        {
          harness: "pi",
          file: path.join(link, "no.json"),
          format: "json",
          path: ["ass"],
          value: 1,
        },
      ]),
    /链接/,
  );
});

test("failed multi-file writes roll back exact snapshots; interrupted transactions recover only on explicit sync", (t) => {
  const f = fixture(t),
    target = locations("pi", f.manager);
  write(target.config, { providers: { keep: {} } });
  write(target.auth, { "openai-codex": grant });
  const originals = [target.config, target.auth].map((file) => [
    file,
    fs.readFileSync(file, "utf8"),
  ]);
  const rename = fs.renameSync;
  let fail = true;
  fs.renameSync = (a, b) => {
    if (b === target.auth && fail) {
      fail = false;
      throw Error("fixture disk failure");
    }
    return rename(a, b);
  };
  try {
    assert.throws(() => f.native.sync("pi"), /fixture disk failure/);
  } finally {
    fs.renameSync = rename;
  }
  for (const [file, text] of originals)
    assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(f.native.fields.entries.length, 0);
  const plan = f.native.fields.plan("pi", compose("pi", f.manager).fields);
  f.native.fields.save({
    entries: [],
    pending: { beforeEntries: [], files: plan.files },
  });
  write(plan.files[0].file, plan.files[0].after);
  const afterPartial = fs.readFileSync(plan.files[0].file, "utf8");
  const restart = new NativeConfig(f.data, crypt, f.manager);
  assert.equal(fs.readFileSync(plan.files[0].file, "utf8"), afterPartial);
  assert.equal(restart.status("pi").pending, true);
  restart.sync("pi");
  assert.equal(restart.fields.state.pending, null);
  restart.restore(["pi"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target.auth)), {
    "openai-codex": grant,
  });
});

test("DSH version marker remains valid after disconnect and native-only enable never starts a router", async (t) => {
  const f = fixture(t),
    target = locations("dsh", f.manager);
  let starts = 0;
  const config = {
    file: path.join(f.home, "codex/config.toml"),
    status: () => ({}),
    preflightDetach() {},
    detach() {},
  };
  const connections = new Connections({
    dataDir: f.data,
    nativeConfig: f.native,
    config,
    injections: new InjectionFiles(f.data),
    router: {
      start: async () => starts++,
      stop: async () => {},
      clientActive: () => 0,
    },
    processes: {
      refresh: async () => {},
      snapshot: () => ({ sessions: [], error: "" }),
    },
  });
  const plan = await connections.preview("dsh", true);
  assert.equal(fs.existsSync(target.auth), false);
  await connections.apply({
    ticket: plan.ticket,
    mode: "safe",
    acknowledged: true,
  });
  assert.equal(starts, 0);
  assert.equal(connections.routerEnabled(), false);
  assert.equal(connections.snapshot().clients.dsh.mode, "native");
  const off = await connections.preview("dsh", false);
  await connections.apply({
    ticket: off.ticket,
    mode: "safe",
    acknowledged: true,
  });
  const final = document(fs.readFileSync(target.auth, "utf8"), "yaml").data;
  assert.equal(final.version, 1);
  assert.deepEqual(final.records, {});
});

test("configuration changes after confirmation invalidate native enable ticket", async (t) => {
  const f = fixture(t),
    target = locations("pi", f.manager);
  const connections = new Connections({
    dataDir: f.data,
    nativeConfig: f.native,
    config: {
      file: path.join(f.home, "codex/config.toml"),
      status: () => ({}),
    },
    injections: new InjectionFiles(f.data),
    router: { clientActive: () => 0 },
    processes: { refresh: async () => {}, snapshot: () => ({ sessions: [] }) },
  });
  const plan = await connections.preview("pi", true);
  write(target.auth, { newLogin: grant });
  await assert.rejects(
    connections.apply({
      ticket: plan.ticket,
      mode: "safe",
      acknowledged: true,
    }),
    /已变化/,
  );
  assert.equal(connections.enabled.pi, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(target.auth)), {
    newLogin: grant,
  });
});

test("quitting ASS retains native configurations and native sessions; explicit disconnect still restores them", async (t) => {
  const f = fixture(t),
    target = locations("pi", f.manager);
  f.native.sync("pi");
  const initial = fs.readFileSync(target.auth, "utf8");
  const sessions = [
    {
      id: "native-window",
      harness: "pi",
      status: "running",
      transport: "native",
    },
  ];
  const stopped = [];
  const connections = new Connections({
    dataDir: f.data,
    nativeConfig: f.native,
    config: {
      file: path.join(f.home, "codex/config.toml"),
      status: () => ({}),
      preflightDetach() {},
      detach() {},
    },
    injections: new InjectionFiles(f.data),
    router: { clientActive: () => 0, stop: async () => {} },
    processes: {
      refresh: async () => {},
      snapshot: () => ({ sessions }),
      stop: async (ids) => {
        stopped.push(...ids);
        sessions.length = 0;
        return { sessions };
      },
    },
  });
  connections.enabled.pi = true;
  const quit = await connections.preview("all", false, true);
  assert.deepEqual(quit.retainedNative, ["pi"]);
  assert.equal(quit.sessions.length, 0);
  await connections.apply({
    ticket: quit.ticket,
    mode: "safe",
    acknowledged: true,
  });
  assert.equal(connections.enabled.pi, true);
  assert.deepEqual(stopped, []);
  assert.equal(fs.readFileSync(target.auth, "utf8"), initial);
  const off = await connections.preview("pi", false);
  await connections.apply({
    ticket: off.ticket,
    mode: "terminate",
    acknowledged: true,
  });
  assert.deepEqual(stopped, ["native-window"]);
  assert.equal(connections.enabled.pi, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(target.auth)), {});
});

test("journal snapshots cannot be mutated through supplied objects", (t) => {
  const f = fixture(t),
    file = path.join(f.home, "owned.json"),
    value = { headers: { tag: "before" } };
  f.native.fields.apply("pi", [
    { harness: "pi", file, format: "json", path: ["owned"], value },
  ]);
  value.headers.tag = "after";
  assert.equal(f.native.fields.entries[0].after.value.headers.tag, "before");
  f.native.fields.apply("pi", []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
});

test("concurrent external edit during a transaction is never overwritten by rollback", (t) => {
  const f = fixture(t),
    first = path.join(f.home, "first.json"),
    second = path.join(f.home, "second.json");
  write(first, {});
  write(second, {});
  const rename = fs.renameSync;
  let intercept = true;
  fs.renameSync = (a, b) => {
    const result = rename(a, b);
    if (intercept && b === first) {
      intercept = false;
      write(second, { external: true });
    }
    return result;
  };
  try {
    assert.throws(
      () =>
        f.native.fields.apply(
          "pi",
          [first, second].map((file) => ({
            harness: "pi",
            file,
            format: "json",
            path: ["owned"],
            value: 1,
          })),
        ),
      /保留加密恢复记录/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(second)), { external: true });
  assert.ok(f.native.fields.state.pending);
  assert.throws(() => f.native.fields.recover(), /外部修改/);
});
