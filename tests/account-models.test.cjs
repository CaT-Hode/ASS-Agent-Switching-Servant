const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { Store } = require("../core/store.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { modelRef } = require("../core/client-policy.cjs");
const { Preferences } = require("../core/preferences.cjs");
const { modelSources } = require("../core/model-inventory.cjs");
const tx = require("../core/account-transactions.cjs");
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-accounts-models-")),
    codex = path.join(dir, "codex"),
    home = path.join(dir, "home");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(codex);
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(codex, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-test", display_name: "GPT Test", context_window: 128000 },
        { slug: "gpt-other", display_name: "Other", context_window: 128000 },
      ],
    }),
  );
  const store = new Store(dir, codex, crypto);
  store.import({
    providers: [
      {
        id: "deep",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "synthetic-key",
        wireApi: "openai-chat",
        models: ["deepseek-chat"],
      },
      {
        id: "go",
        name: "Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "synthetic-key",
        models: ["go-model"],
      },
      {
        id: "work",
        name: "Work",
        baseUrl: "https://example.test/v1",
        apiKey: "synthetic-key",
        models: [{ model: "alpha", wireApi: "anthropic" }, "beta"],
      },
    ],
  });
  const reload = () =>
    new HarnessManager(dir, () => store.state, store.officialModels, codex, {
      home,
      env: {},
    });
  return { dir, codex, home, store, reload, harnesses: reload() };
}
const accounts = (h, id) =>
  h
    .snapshot()
    .clients.find((c) => c.id === id)
    .accounts.filter((a) => a.kind === "api")
    .map((a) => a.id);
test("bindings scope accounts to each client; only exact DeepSeek / Go endpoints auto-bind", (t) => {
  const { harnesses: h, store } = setup(t);
  assert.deepEqual(accounts(h, "dsh"), ["api:deep"]);
  assert.deepEqual(accounts(h, "opencode"), ["api:go"]);
  for (const id of ["pi", "codex", "claude"])
    assert.deepEqual(accounts(h, id), []);
  assert.throws(() => h.bindApi("pi", "work"), /官方 API/);
  assert.deepEqual(accounts(h, "pi"), []);
  assert.deepEqual(accounts(h, "codex"), []);
  store.updateProvider({
    id: "pretend",
    name: "DeepSeek",
    brand: "deepseek",
    baseUrl: "https://other.test/v1",
    apiKey: "synthetic-key",
    models: ["x"],
  });
  assert.deepEqual(accounts(h, "dsh"), ["api:deep"]);
});
test("manual binding, selection, auto-binding exclusion and rebind survive restart", (t) => {
  const { harnesses: h, reload } = setup(t);
  h.select("dsh", "api:deep");
  h.setInjection("pi", { excludedProviders: ["work"] });
  h.bindApi("dsh", "deep", false);
  const next = reload();
  assert.deepEqual(accounts(next, "dsh"), []);
  assert.deepEqual(accounts(next, "pi"), []);
  assert.equal(next.state.selected.dsh, undefined);
  assert.deepEqual(next.state.injections.pi.excludedProviders, ["work"]);
  next.bindApi("dsh", "deep");
  assert.deepEqual(accounts(reload(), "dsh"), ["api:deep"]);
});
test("protocol-compatible relays cannot bind Claude; official credentials survive disabled models", (t) => {
  const { harnesses: h, store } = setup(t);
  assert.throws(() => h.bindApi("claude", "deep"), /官方 API/);
  assert.throws(() => h.bindApi("claude", "work"), /官方 API/);
  store.updateProvider({ id: "work", baseUrl: "https://api.anthropic.com", apiKey: "new-official-synthetic" });
  h.bindApi("claude", "work");
  store.removeModel("work", "alpha");
  const c = h.snapshot().clients.find((c) => c.id === "claude");
  assert.equal(c.accounts.length, 1);
  assert.equal(c.accounts[0].ready, true);
  assert.equal(c.accounts[0].models.length, 0);
  assert.equal(h.plan("claude", "api:work").routed, false);
});
test("legacy foreign accounts are removed from cards without removing model providers", (t) => {
  const { dir, reload, store } = setup(t);
  fs.writeFileSync(
    path.join(dir, "clients.json"),
    JSON.stringify({
      selected: { codex: "api:deep" },
      modelSelections: { pi: { "api:work": "alpha" } },
    }),
  );
  const h = reload();
  assert.deepEqual(accounts(h, "codex"), []);
  assert.deepEqual(accounts(h, "pi"), []);
  tx.deleteModel(store, h, "work", "alpha");
  assert.deepEqual(accounts(reload(), "pi"), []);
  assert.ok(store.state.providers.some((p) => p.id === "work"));
});
test("five inline model fields persist; rename preserves provider exclusion and updates namespaced catalog", (t) => {
  const { dir, codex, store, harnesses: h, reload } = setup(t);
  h.setInjection("pi", { excludedProviders: ["work"] });
  const old = store.public().providers.find((p) => p.id === "work").models[0];
  tx.saveModel(
    store,
    h,
    "work",
    {
      ...old,
      model: "renamed",
      displayName: "Changed",
      wireApi: "openai-chat",
      contextWindow: 96000,
      defaultEffort: "max",
    },
    "alpha",
    old,
  );
  const next = new Store(dir, codex, crypto),
    m = next.state.providers.find((p) => p.id === "work").models[0];
  assert.deepEqual(
    [m.model, m.displayName, m.wireApi, m.contextWindow, m.defaultEffort],
    ["renamed", "Changed", "openai-chat", 96000, "max"],
  );
  assert.deepEqual(reload().state.injections.pi.excludedProviders, ["work"]);
  const entry = JSON.parse(
    fs.readFileSync(path.join(dir, "catalog-draft.json")),
  ).models.find((m) => m.slug === require("../core/models.cjs").codexModelId("work", "renamed"));
  assert.equal(entry.display_name, "Work / Changed");
  assert.equal(entry.context_window, 96000);
});
test("deleting a model persists, keeps provider exclusion, other models and credentials", (t) => {
  const { dir, codex, store, harnesses: h, reload } = setup(t);
  h.setInjection("pi", { excludedProviders: ["work"] });
  tx.deleteModel(store, h, "work", "alpha");
  const p = new Store(dir, codex, crypto).state.providers.find(
    (p) => p.id === "work",
  );
  assert.deepEqual(
    p.models.map((m) => m.model),
    ["beta"],
  );
  assert.equal(p.apiKey, "synthetic-key");
  assert.deepEqual(reload().state.injections.pi.excludedProviders, ["work"]);
  assert.deepEqual(accounts(reload(), "pi"), []);
});
test("equivalent model snapshots with reordered keys can be edited and deleted after restart", (t) => {
  const { dir, codex, store, harnesses: h } = setup(t);
  const reorder = (m) => Object.fromEntries(Object.entries(m).reverse());
  const old = store.public().providers.find((p) => p.id === "work").models[0];
  tx.saveModel(
    store,
    h,
    "work",
    { ...old, displayName: "Edited" },
    old.model,
    reorder(old),
  );
  const edited = store.public().providers.find((p) => p.id === "work")
    .models[0];
  tx.deleteModel(store, h, "work", edited.model, reorder(edited));
  const restored = new Store(dir, codex, crypto)
    .public()
    .providers.find((p) => p.id === "work");
  assert.deepEqual(
    restored.models.map((m) => m.model),
    ["beta"],
  );
});
test("stale deletion is rejected without deleting a changed model", (t) => {
  const { store, harnesses: h } = setup(t);
  const old = structuredClone(
    store.public().providers.find((p) => p.id === "work").models[0],
  );
  store.model("work", { ...old, displayName: "Latest" }, old.model, old);
  assert.throws(
    () => tx.deleteModel(store, h, "work", old.model, old),
    /已变化/,
  );
  assert.equal(
    store.public().providers.find((p) => p.id === "work").models[0].displayName,
    "Latest",
  );
});
test("duplicate, invalid, deleted or stale model edits never overwrite current configuration", (t) => {
  const { store } = setup(t),
    old = structuredClone(
      store.state.providers.find((p) => p.id === "work").models[0],
    );
  for (const input of [
    { ...old, model: "beta" },
    { ...old, contextWindow: 0 },
    { ...old, model: "bad\nmodel" },
    { ...old, wireApi: "unknown" },
  ])
    assert.throws(() => store.model("work", input, "alpha", old));
  store.model("work", { ...old, displayName: "Fresh" }, "alpha", old);
  assert.throws(
    () => store.model("work", { ...old, displayName: "Stale" }, "alpha", old),
    /已变化/,
  );
  assert.equal(
    store.state.providers.find((p) => p.id === "work").models[0].displayName,
    "Fresh",
  );
  store.removeModel("work", "alpha");
  assert.throws(() => store.model("work", old, "alpha"), /已移除/);
});
test("official local preferences cannot rename injected IDs or override native model metadata", (t) => {
  const { store, dir, codex } = setup(t),
    cache = fs.readFileSync(path.join(codex, "models_cache.json")),
    old = store.public().officialModels[0];
  store.model(
    "official",
    { ...old, model: "gpt-alias", displayName: "Alias" },
    old.model,
    old,
  );
  assert.equal(store.public().officialModels[0].sourceModel, "gpt-test");
  const cat = JSON.parse(
    fs.readFileSync(path.join(dir, "catalog-draft.json")),
  ).models;
  assert.equal(cat.some((m) => m.slug === 'gpt-alias'), false);
  assert.deepEqual(cat.filter(m=>!m.slug.includes('::')), JSON.parse(cache).models);
  assert.equal(store.public().officialModels[0].model, 'gpt-test');
  assert.throws(
    () =>
      store.model("official", { ...old, wireApi: "anthropic" }, "gpt-test"),
    /只支持/,
  );
  store.removeModel("official", "gpt-test");
  assert.equal(new Store(dir, codex, crypto).public().officialModels.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'catalog-draft.json'))).models.filter(m=>!m.slug.includes('::')), JSON.parse(cache).models);
  store.model("official", { model: "gpt-test" });
  assert.equal(store.public().officialModels.length, 2);
  assert.deepEqual(
    fs.readFileSync(path.join(codex, "models_cache.json")),
    cache,
  );
});
test("model and account settings roll back together on a client journal write failure", (t) => {
  const { store, harnesses: h, dir, codex } = setup(t);
  h.setInjection("pi", { excludedProviders: ["work"] });
  const old = structuredClone(
      store.state.providers.find((p) => p.id === "work").models[0],
    ),
    save = h.save.bind(h);
  let once = true;
  h.save = () => {
    if (once) {
      once = false;
      throw Error("simulated disk failure");
    }
    save();
  };
  assert.throws(
    () =>
      tx.saveModel(
        store,
        h,
        "work",
        { ...old, model: "renamed" },
        "alpha",
        old,
      ),
    /disk failure/,
  );
  assert.equal(
    new Store(dir, codex, crypto).state.providers.find((p) => p.id === "work")
      .models[0].model,
    "alpha",
  );
  assert.deepEqual(h.state.injections.pi.excludedProviders, ["work"]);
});
test("new API account creation and client binding commit together", (t) => {
  const { store, harnesses: h } = setup(t);
  const input = {
    name: "New API",
    baseUrl: "https://example.test/v1",
    apiKey: "synthetic",
    wireApi: "openai-chat",
    models: [],
  };
  assert.throws(() => tx.saveBoundApi(store, h, "claude", input), /官方 API/);
  assert.equal(store.state.providers.length, 3);
  const id = tx.saveBoundApi(store, h, "codex", { ...input, baseUrl: "https://api.openai.com/v1" });
  assert.deepEqual(accounts(h, "codex"), ["api:" + id]);
});
test("legacy accounts navigation migrates to clients and existing native key client is persistent", (t) => {
  const { dir } = setup(t);
  fs.writeFileSync(path.join(dir, "preferences.json"), '{"view":"accounts"}');
  const p = new Preferences(dir);
  assert.equal(p.state.view, "clients");
  p.update({ client: "cursor" });
  assert.equal(new Preferences(dir).state.client, "cursor");
});
test("aggregated native models are read-only declarations and never leak keys or invent context", (t) => {
  const { store, harnesses: h, home } = setup(t),
    agent = path.join(home, ".pi/agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "synthetic-secret",
        refresh: "refresh",
        expires: 2100000000000,
      },
    }),
  );
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "openai-codex": {
          api: "openai-responses",
          apiKey: "secret-model-key",
          models: [
            {
              id: "native-test",
              name: "Native Test",
              input: ["text", "image"],
            },
          ],
        },
        unrelated: { models: [{ id: "should-not-appear" }] },
      },
    }),
  );
  const sources = modelSources(store.public(), h.snapshot(), { home }),
    source = sources.find((s) => s.id === "native-pi");
  assert.equal(source.readOnly, true);
  assert.equal(source.models[0].model, "native-test");
  assert.equal(source.models[0].contextWindow, null);
  for (const forbidden of [
    "synthetic-secret",
    "secret-model-key",
    "should-not-appear",
  ])
    assert.ok(!JSON.stringify(sources).includes(forbidden));
  for (const malformed of ["invalid json", "null", "[]", "true"]) {
    fs.writeFileSync(path.join(agent, "models.json"), malformed);
    assert.equal(
      modelSources(store.public(), h.snapshot(), { home }).find(
        (s) => s.kind === "native",
      ).models.length,
      0,
    );
  }
});
