// Actual Electron IPC/DPAPI/UI with local synthetic upstream only.
const { _electron: electron } = require("playwright");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { codexModelId } = require("../core/models.cjs");
const root = path.resolve(__dirname, ".."), out = path.join(process.env.LOCALAPPDATA, "ASS-validation");
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(out, "proxy-separation-")), codex = path.join(data, "codex");
fs.mkdirSync(codex);
const original = 'model = "official-fixture"\nmodel_reasoning_effort = "high"\n';
const auth = '{"tokens":{"access_token":"synthetic-subscription","refresh_token":"synthetic-refresh","account_id":"synthetic-account"}}';
fs.writeFileSync(path.join(codex, "auth.json"), auth);
fs.writeFileSync(path.join(codex, "config.toml"), original);
fs.writeFileSync(path.join(codex, "models_cache.json"), JSON.stringify({ models: [{ slug: "official-fixture", display_name: "Official fixture", context_window: 128000 }] }));
let app, page;
const errors = [];
const call = (name, ...args) => page.evaluate(([name, args]) => window.ass.call(name, ...args), [name, args]);
async function start() {
  app = await electron.launch({ ...(process.env.ASS_QA_EXE ? { executablePath: process.env.ASS_QA_EXE } : {}),
    args: process.env.ASS_QA_EXE ? ["--qa"] : [root, "--qa"],
    env: { ...process.env, ASS_TEST_DATA: data, ASS_TEST_CODEX: codex, ASS_TEST_PORT: "25838" } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text()); });
  await page.waitForSelector("h1");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1380, 940);
    global.assTest.sent = [];
    global.assTest.setFetch(async (url, init) => {
      if (!init?.body) return Response.json({});
      const body = JSON.parse(init.body);
      global.assTest.sent.push({ url, model: body.model, input: body.input, auth: init.headers.authorization, key: init.headers["x-api-key"], account: init.headers["chatgpt-account-id"] });
      return body.stream === false ? Response.json({ type: "message", content: [] }) :
        new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
    });
  });
}
async function stop() { if (app) { await app.evaluate(() => global.assTest.quit()).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function choose(name) {
  await page.getByRole("button", { name: "客户端与账户", exact: true }).click();
  if (!(await page.locator(".client-list").getByRole("button", {name, exact: true}).isVisible()))
    await page.locator(".more-clients > summary").click();
  await page.locator(".client-list").getByRole("button", { name, exact: true }).click();
  assert.equal(await page.locator(".client-injection").count(), 1);
}
async function confirm(button) {
  await button.click();
  const modal = page.getByRole("dialog");
  assert.equal(await modal.getByRole("button").count(), 2);
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
}
async function request(model, localToken = false, client = "codex") {
  const token = localToken ? await app.evaluate(() => global.assTest.router.clientToken) : "synthetic-subscription";
  const response = await fetch("http://127.0.0.1:25838/clients/" + (client === "codex" ? "ASS" : client) + (client === "claude" ? "/models/v1/messages" : "/v1/responses"), {
    method: "POST", headers: { authorization: "Bearer " + token, "chatgpt-account-id": "synthetic-account", "content-type": "application/json" },
    body: JSON.stringify({ model, input: "fixture", messages: [], stream: client !== "claude" }),
  });
  await response.text(); return response.status;
}
(async () => {
  try {
    await start();
    const id = await call("save-provider", { id: "fixture", name: "Route fixture", baseUrl: "https://example.test/v1", apiKey: "synthetic-route-key", models: [
      { model: "alpha", wireApi: "openai-responses" }, { model: "beta", wireApi: "anthropic" },
    ] });
    await assert.rejects(call("account-bind-api", "codex", id), /官方 API/);
    await choose("Codex");
    assert.equal(await page.getByLabel("Codex 默认接入模型").count(), 0);
    await confirm(page.getByRole("switch", { name: "Codex ASS 接入", exact: true }));
    assert.equal((await call("snapshot")).connections.clients.codex.applied, true);
    assert.equal(await request("official-fixture"), 200);
    assert.equal(await request(codexModelId(id, "alpha")), 200);
    assert.equal(await request("official-fixture", true), 403);
    // Saving models also triggers protocol probes; assert only our route requests.
    const sent = await app.evaluate(() => global.assTest.sent.filter((r) => r.input === "fixture"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].auth, "Bearer synthetic-subscription");
    assert.equal(sent[1].auth, "Bearer synthetic-route-key");
    assert.equal(sent[1].account, undefined);
    const catalog = fs.readFileSync(path.join(data, "catalog.json"));
    await page.getByRole("switch", { name: "Route fixture 供应商接入", exact: true }).click();
    assert.equal((await call("snapshot")).connections.clients.codex.pending, true);
    assert.deepEqual(fs.readFileSync(path.join(data, "catalog.json")), catalog);
    await page.screenshot({ path: path.join(out, "account-separation-proxy-pending.png"), animations: "disabled" });
    await stop(); await start(); await choose("Codex");
    assert.equal((await call("snapshot")).connections.clients.codex.pending, true);
    assert.deepEqual(fs.readFileSync(path.join(data, "catalog.json")), catalog);
    await confirm(page.getByRole("button", { name: "同步接入配置", exact: true }));
    assert.equal((await call("snapshot")).connections.clients.codex.modelCount, 0);
    assert.equal(await request(codexModelId(id, "alpha")), 404);
    assert.equal(await request(codexModelId(id, "beta")), 404);
    assert.ok(!fs.readFileSync(path.join(data, "proxy-applied.json"), "utf8").includes("synthetic-route-key"));
    await choose("Claude Code");
    await confirm(page.getByRole("switch", { name: "Claude Code ASS 接入", exact: true }));
    assert.equal((await call("snapshot")).connections.clients.claude.modelCount, 2);
    assert.equal(await request(id + "::beta", true, "claude"), 200);
    await confirm(page.getByRole("switch", { name: "Claude Code ASS 接入", exact: true }));
    await choose("Codex");
    await confirm(page.getByRole("switch", { name: "Codex ASS 接入", exact: true }));
    assert.equal((await call("snapshot")).service.running, false);
    const TOML = require("@iarna/toml");
    assert.deepEqual(TOML.parse(fs.readFileSync(path.join(codex, "config.toml"), "utf8")), TOML.parse(original));
    assert.equal(fs.readFileSync(path.join(codex, "auth.json"), "utf8"), auth);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, proxyClients: 2, draftApplyRestart: true, credentialSeparation: true, DPAPI: true, nativeAuthUnchanged: true, restoration: true, pageErrors: 0 }));
  } catch (error) { await page?.screenshot({ path: path.join(out, "proxy-separation-failure.png") }).catch(() => {}); throw error; }
  finally { await stop(); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
