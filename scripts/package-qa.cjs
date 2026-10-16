// Tests the packaged Windows executable with a fresh, disposable profile.
const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const { version } = require("../package.json");
const output = path.join(process.env.LOCALAPPDATA, "ASS-validation");
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, "packaged-"));
const codex = path.join(data, "codex");
fs.mkdirSync(codex);
const home = path.join(data, 'home');
const appData = path.join(home, 'AppData', 'Roaming'), localData = path.join(home, 'AppData', 'Local');
for (const directory of [home, appData, localData]) fs.mkdirSync(directory, { recursive: true });
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:ASS_|DSH_|DEEPSEEK_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|OPENCODE_|PI_|KIMI_|ZCODE_|XDG_|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(isolatedEnv, { ASS_DATA_DIR: data, CODEX_HOME: codex, USERPROFILE: home, HOME: home,
  APPDATA: appData, LOCALAPPDATA: localData, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
  PATH: [process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter) });
(async () => {
  const app = await electron.launch({
    executablePath: process.env.ASS_TEST_EXECUTABLE || path.join(
      root,
      "release",
      "v" + version,
      "ASS-win32-x64",
      "ASS.exe",
    ),
    // With a custom executable Playwright does not add its readiness loader.
    // Load it from the development checkout; it never enters the installer.
    args: ['-r', path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js')],
    env: isolatedEnv,
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text()); });
    await page.waitForSelector("h1");
    assert.equal(await page.title(), "ASS");
    assert.equal(await app.evaluate(() => typeof global.assTest), 'undefined');
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    const parsed = await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const load = createRequire(app.getAppPath() + '/package.json');
      return [load('@iarna/toml').parse('value = 7').value,
        load('yaml').parse('value: 7').value, load('jsonc-parser').parse('{/*comment*/"value":7}').value];
    });
    assert.deepEqual(parsed, [7, 7, 7]);
    const state = await page.evaluate(() => window.ass.call('snapshot'));
    assert.equal(state.providers.length, 0);
    assert.equal(state.service.running, false);
    assert.equal(state.startupError, '');
    assert.equal(state.codex.attached, false);
    const refresh = await page.evaluate(() => window.ass.call('connections-refresh'));
    assert.equal(refresh.ok, true);
    assert.deepEqual(refresh.refreshed, []);
    assert.deepEqual(refresh.skipped, []);
    await page.getByRole("button", { name: "关于 ASS", exact: true }).click();
    await page.locator(".ass-wordmark").waitFor();
    assert.equal(await page.locator(".ass-brand-hero p").textContent(), "Agent-Switching-Servant");
    assert.equal(await app.evaluate(({ app }) => app.getName()), "ASS");
    assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), data);
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(output, "agent-switching-servant-about.png"), animations: "disabled" });
    assert.equal(await page.getByRole("switch", { name: "自动检查更新", exact: true }).isChecked(), true);
    await page
      .getByRole("button", { name: "客户端与账户", exact: true })
      .click();
    if (!(await page.getByRole("button", { name: "Codex", exact: true }).isVisible()))
      await page.locator(".more-clients > summary").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    const codexLaunch = page.getByRole("button", { name: "通过 ASS 启动 Codex", exact: true });
    await codexLaunch.waitFor(); assert.ok(await codexLaunch.isEnabled());
    const codexDesktopDetected = !!state.harnesses.clients.find(c => c.id === 'codex')?.desktop;
    await page.locator('.codex-desktop-launch').screenshot({ path: path.join(output, "codex-desktop-launch.png"), animations: "disabled" });
    if (!(await page.getByRole("button", { name: "pi", exact: true }).isVisible()))
      await page.locator(".more-clients > summary").click();
    await page
      .getByRole("button", { name: "pi", exact: true })
      .click();
    await page
      .locator(".pi-import > summary")
      .waitFor();
    assert.equal(fs.existsSync(path.join(codex, "config.toml")), false);
    assert.equal(await page.getByRole("button", { name: "接入 Codex", exact: true }).count(), 0);
    assert.equal(await page.locator('.client-list').getByRole('switch').count(), 0);
    assert.equal(await page.locator('.client-panel .client-heading').getByRole('switch').count(), 1);
    const toggle = page.getByRole("switch", { name: "pi ASS 接入", exact: true });
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    assert.equal(await page.getByRole("dialog").getByRole("button").count(), 2);
    assert.equal(await page.getByRole("dialog").getByRole("checkbox").count(), 0);
    assert.equal(await page.getByRole("dialog").getByRole("radio").count(), 0);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await toggle.click();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        packaged: "passed",
        emptyProfile: true,
        nativeWindow: true,
        oauthUI: true,
        fullName: "Agent-Switching-Servant",
        pageErrors: 0,
        codexLaunchVisible: true,
        codexDesktopDetected,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
