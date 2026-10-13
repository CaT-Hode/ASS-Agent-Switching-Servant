// Synthetic upstream only; independent encrypted profile and no real clients restarted.
const { _electron } = require("playwright");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), out = path.join(process.env.LOCALAPPDATA, "ASS-validation");
const data = fs.mkdtempSync(path.join(out, "protocol-ui-")), codex = path.join(data, "codex");
fs.mkdirSync(codex); fs.writeFileSync(path.join(codex, "config.toml"), 'model = "official-original"\n');
const auth = '{"tokens":{"access_token":"synthetic-official"}}'; fs.writeFileSync(path.join(codex, "auth.json"), auth);
// Exercise the production version gate with a Windows shim, not a test bypass.
const claudeFixture = path.join(data, "launcher with spaces", "claude.cmd");
const claudeLauncher = process.env.ASS_QA_CLAUDE_ENTRY || claudeFixture;
fs.mkdirSync(path.dirname(claudeFixture), { recursive: true });
const writeClaudeVersion = version => fs.writeFileSync(claudeFixture, `@echo off\r\nif not "%~1"=="--version" exit /b 9\r\necho ${version} ^(Claude Code^)\r\n`);
writeClaudeVersion("2.1.283");
let app, page; const errors = [];
const call = (name, ...args) => page.evaluate(([name, args]) => window.ass.call(name, ...args), [name, args]);
async function start() {
  app = await _electron.launch({ ...(process.env.ASS_QA_EXE ? { executablePath: process.env.ASS_QA_EXE } : {}),
    args: process.env.ASS_QA_EXE ? ["--qa"] : [root, "--qa"], env: { ...process.env, ASS_TEST_DATA: data, ASS_TEST_CODEX: codex, ASS_TEST_PORT: "25839" } });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (["error", "warning"].includes(m.type())) errors.push(m.text()); });
  await page.waitForSelector("h1");
  await app.evaluate((_, file) => global.assTest.harnesses.setExecutable("claude", file), claudeLauncher);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1420, 960);
    global.assTest.setFetch(async (url, init) => {
      if (!init?.body) return Response.json({ data: [] });
      const body = JSON.parse(init.body), protocol = url.endsWith("responses") ? "responses" : url.endsWith("messages") ? "messages" : "chat";
      if (body.model !== "dual" && protocol !== "chat") return Response.json({}, { status: 405 });
      const events = protocol === "responses" ? [{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]
        : protocol === "messages" ? [{ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } }, { type: "message_stop" }]
        : [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }];
      return new Response(events.map(e => "data: " + JSON.stringify(e) + "\n\n").join(""));
    });
  });
  await app.evaluate(() => {
    // Only advertise the fixture desktop; this QA never opens the real app.
    const t = global.assTest, desktop = t.harnesses.desktop.bind(t.harnesses);
    t.harnesses.desktop = id => id === "claude" ? "C:\\fixture\\Claude.exe" : desktop(id);
  });
}
async function stop() { await app?.evaluate(() => global.assTest.quit()).catch(() => {}); await app?.close().catch(() => {}); app = null; }
async function choose(name) {
  await page.getByRole("button", { name: "客户端与账户", exact: true }).click();
  const button = page.locator(".client-list").getByRole("button", { name, exact: true });
  if (!(await button.isVisible())) await page.locator(".more-clients > summary").click();
  await button.click();
}
async function confirm(button) {
  await button.click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
async function exitDialog() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("ass:manage", { scope: "all", enabled: false, quit: true }));
  const dialog = page.getByRole("dialog", { name: "退出 ASS？", exact: true });
  await dialog.getByRole("button", { name: "直接退出", exact: true }).waitFor();
  await page.getByText("正在检查是否需要安全退出…", { exact: true }).waitFor({ state: "hidden" });
  return dialog;
}
async function exitBy(dialog, name) {
  const closed = app.waitForEvent("close");
  await dialog.getByRole("button", { name, exact: true }).click();
  await closed;
  app = null;
}
(async () => {
  try {
    await start();
    const emptyClosed = app.waitForEvent("close");
    await app.evaluate(() => global.assTest.requestExit());
    await emptyClosed;
    app = null;
    await start();
    await choose("Codex");
    assert.equal(await page.getByRole("switch", { name: "Codex 无账号启动" }).isDisabled(), true);
    await call("save-provider", { id: "fixture", name: "协议测试", baseUrl: "https://fixture.test/v1", apiKey: "synthetic-api", models: [{ model: "dual", wireApi: "openai-chat" }, { model: "chat-only", wireApi: "anthropic" }] });
    // Creation checks run in the background; injection itself must never wait for them.
    await app.evaluate(() => global.assTest.prepareProtocols("codex"));
    await confirm(page.getByRole("switch", { name: "Codex ASS 接入", exact: true }));
    await confirm(page.getByRole("switch", { name: "Codex 无账号启动" }));
    let snapshot = await call("snapshot"); assert.equal(snapshot.connections.clients.codex.accountless, true);
    assert.equal(snapshot.harnesses.clients.find(c => c.id === "codex").injection.models[0].protocol, "openai-responses");
    await page.screenshot({ path: path.join(out, "accountless-codex-light.png") });
    await choose("Claude Code");
    await confirm(page.getByRole("switch", { name: "Claude Code ASS 接入", exact: true }));
    // Fail if QA ever bypasses this production check again. Only the test shim
    // is rewritten; the optional real installed launcher is read/started only.
    await app.evaluate((_, file) => global.assTest.harnesses.setExecutable("claude", file), claudeFixture);
    writeClaudeVersion("2.1.223");
    await assert.rejects(call("connection-preview", "claude", true, false, true), /2\.1\.242/);
    assert.equal((await call("snapshot")).connections.clients.claude.accountless, false);
    assert.ok(!fs.existsSync(path.join(data, "test-home/.claude/settings.json")));
    writeClaudeVersion("2.1.283");
    await app.evaluate((_, file) => global.assTest.harnesses.setExecutable("claude", file), claudeLauncher);
    await confirm(page.getByRole("switch", { name: "Claude Code 无账号启动" }));
    snapshot = await call("snapshot");
    assert.equal(snapshot.connections.clients.claude.runtimeStatus, "terminal-ready");
    assert.equal(await page.getByRole("button", { name: "启动桌面版", exact: true }).isEnabled(), true);
    await page.getByText("终端与桌面版免登录 · ASS 需保持运行", { exact: true }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "test-home/.claude/settings.json"))).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:25839/clients/claude/models");
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "test-home/.claude.json"))).hasCompletedOnboarding, true);
    assert.deepEqual(snapshot.harnesses.clients.find(c => c.id === "claude").injection.models.map(m => m.protocol), ["anthropic", "openai-chat"]);
    if (claudeLauncher === claudeFixture) {
      // This fixture returns 9 for an interactive launch. A spawned shell must
      // never be reported to the user as a successfully opened Claude session.
      await page.getByRole("button", { name: "启动终端" }).click();
      await page.locator(".toast.error").getByText(/启动后立即退出/).waitFor();
      const launched = path.join(data, "claude-terminal-started.txt");
      fs.writeFileSync(claudeFixture, `@echo off\r\nif "%~1"=="--version" (echo 2.1.283 ^(Claude Code^) & exit /b 0)\r\necho started>"${launched}"\r\nping -n 6 127.0.0.1 >nul\r\n`);
      await page.getByRole("button", { name: "启动终端" }).click();
      await page.locator(".toast:not(.error)").getByText("已打开 Claude Code 终端").waitFor();
      assert.equal(fs.readFileSync(launched, "utf8").trim(), "started");
    }
    await page.locator(".claude-desktop-setup summary").click();
    await page.getByRole("button", { name: "复制网关地址" }).waitFor();
    await page.getByRole("button", { name: "复制本机密钥" }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "Claude 桌面版第三方推理" }).count(), 0);
    assert.equal((await call("snapshot")).claudeDesktop.current, true);
    await page.getByText("已配置", { exact: true }).waitFor();
    const library = path.join(data, "claude-desktop/configLibrary");
    const desktopMeta = JSON.parse(fs.readFileSync(path.join(library, "_meta.json"), "utf8"));
    const desktopProfile = JSON.parse(fs.readFileSync(path.join(library, desktopMeta.appliedId + ".json"), "utf8"));
    const gatewayKey = desktopProfile.inferenceGatewayApiKey;
    const gatewayUrl = desktopProfile.inferenceGatewayBaseUrl;
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "claude-desktop/claude_desktop_config.json"), "utf8")).deploymentMode, "3p");
    const discovered = await fetch(gatewayUrl + "/v1/models", { headers: { authorization: "Bearer " + gatewayKey } });
    assert.equal(discovered.status, 200);
    const discoveredIds = (await discovered.json()).data.map(model => model.id);
    assert.deepEqual(discoveredIds, desktopProfile.inferenceModels.map(model => model.name));
    assert.equal(discoveredIds.length, 2);
    assert.ok(discoveredIds.every(id => /^claude-ass-[a-f0-9]{32}$/.test(id)));
    const response = await fetch(gatewayUrl + "/v1/messages", { method: "POST",
      headers: { authorization: "Bearer " + gatewayKey, "content-type": "application/json" },
      body: JSON.stringify({ model: discoveredIds[0], messages: [{ role: "user", content: "Say OK" }], max_tokens: 16, stream: true }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OK/);
    await page.locator(".client-provider summary").click();
    await page.screenshot({ path: path.join(out, "accountless-claude-protocols.png") });
    // Real direct-exit IPC, not the QA quit hook: all managed settings, keys
    // and enabled state must remain byte-for-byte identical after process exit.
    const preservedFiles = [
      ...await app.evaluate(() => [global.assTest.config.file, global.assTest.config.record, global.assTest.config.catalog]),
      path.join(codex, "auth.json"), path.join(data, "connections.json"), path.join(data, "proxy-applied.json"),
      path.join(data, "test-home/.claude/settings.json"), path.join(data, "test-home/.claude.json"),
      path.join(data, "claude-desktop-gateway.json"), path.join(data, "claude-desktop/claude_desktop_config.json"),
      path.join(library, "_meta.json"), path.join(library, desktopMeta.appliedId + ".json"),
    ];
    const preserved = preservedFiles.map(file => fs.readFileSync(file));
    await assert.rejects(call("app-exit-direct", false), /确认直接退出/);
    // Simulate a live request to verify that only safe exit is blocked.
    await app.evaluate(() => global.assTest.router.requests.set("exit-fixture", { client: "claude" }));
    await call("ui-preferences", { theme: "dark" });
    const directExit = await exitDialog();
    await directExit.getByRole("button", { name: "安全退出", exact: true }).waitFor();
    assert.equal(await directExit.getByRole("button", { name: "安全退出", exact: true }).isDisabled(), true);
    assert.equal(await directExit.getByRole("button", { name: "直接退出", exact: true }).isEnabled(), true);
    assert.match(await directExit.textContent(), /保留所有接入与免登录配置/);
    assert.equal(await page.title(), "ASS");
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    await page.screenshot({ path: path.join(out, "exit-preserve-or-restore.png") });
    await exitBy(directExit, "直接退出");
    for (const [i, file] of preservedFiles.entries()) assert.deepEqual(fs.readFileSync(file), preserved[i]);
    await start();
    snapshot = await call("snapshot");
    assert.equal(snapshot.connections.clients.codex.accountless, true); assert.equal(snapshot.connections.clients.claude.accountless, true);
    assert.equal(snapshot.claudeDesktop.current, true);
    assert.equal(snapshot.service.running, true);
    const resumed = await fetch(gatewayUrl + "/v1/models", { headers: { authorization: "Bearer " + gatewayKey } });
    assert.equal(resumed.status, 200);
    assert.equal(Object.keys(snapshot.capabilities).length, 2);
    await choose("Codex"); await confirm(page.getByRole("switch", { name: "Codex 无账号启动" }));
    assert.equal((await call("snapshot")).connections.clients.codex.accountless, false);
    assert.equal((await call("snapshot")).connections.clients.claude.accountless, true);
    await choose("Claude Code");
    await confirm(page.getByRole("switch", { name: "Claude Code 无账号启动" }));
    assert.equal((await call("snapshot")).claudeDesktop.current, false);
    assert.equal((await call("snapshot")).connections.clients.claude.accountless, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "test-home/.claude/settings.json"))), {});
    assert.equal(fs.readFileSync(path.join(codex, "auth.json"), "utf8"), auth);
    // Safe exit must restore Codex + terminal + desktop instead of preserving
    // their accountless overlays, without touching the original OAuth.
    await choose("Codex"); await confirm(page.getByRole("switch", { name: "Codex 无账号启动" }));
    await choose("Claude Code"); await confirm(page.getByRole("switch", { name: "Claude Code 无账号启动" }));
    assert.equal((await call("snapshot")).claudeDesktop.current, true);
    const safeExit = await exitDialog();
    // Modal uses the native <dialog> role; click waits for enabled state.
    await exitBy(safeExit, "安全退出");
    // Field-level withdrawal preserves harmless whitespace left around the
    // removed managed block; assert the complete parsed configuration.
    assert.deepEqual(require("@iarna/toml").parse(fs.readFileSync(path.join(codex, "config.toml"), "utf8")), { model: "official-original" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "test-home/.claude/settings.json"))), {});
    assert.equal(fs.existsSync(path.join(data, "claude-desktop-gateway.json")), false);
    assert.equal(fs.existsSync(path.join(data, "claude-desktop/claude_desktop_config.json")), false);
    assert.equal(fs.readFileSync(path.join(codex, "auth.json"), "utf8"), auth);
    await start();
    snapshot = await call("snapshot");
    assert.equal(snapshot.connections.clients.codex.enabled, false);
    assert.equal(snapshot.connections.clients.claude.enabled, false);
    const afterSafeClosed = app.waitForEvent("close");
    await app.evaluate(() => global.assTest.requestExit());
    await afterSafeClosed;
    app = null;
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, accountlessEligibility: true, productionVersionGate: true, oldVersionRejected: true,
      claudeLauncher, bothClients: true, automaticProtocols: true, desktopLocalConfig: true, restartPersistence: true,
      directExitPreservesConfig: true, routingResumes: true, safeExitRestoresConfig: true, conditionalSafeExit: true,
      oauthPreserved: true, screenshots: out, errors }));
  } finally {
    await stop();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
