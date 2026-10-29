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
fs.writeFileSync(path.join(data, 'requests.jsonl'), [
  { model: 'ASS_fixture::vendor/model[1m]', source: 'Monitor fixture', client: 'codex', protocol: 'openai-responses', requestId: 'packaged-monitor',
    time: new Date().toISOString(), ok: true, taskOk: true, httpStatus: 200, status: 200, ms: 3000,
    ttftMs: 1000, generationMs: 2000, tps: 25, visibleTokens: 40, visibleMs: 2000,
    usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 750, cacheWriteTokens: 0 } },
  { model: 'vendor/model', source: 'Monitor fixture', time: new Date().toISOString(), ok: true, ms: 2000, httpStatus: 200 },
].map(row => JSON.stringify(row)).join('\n') + '\n');
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
    // The shipped navigation, lazy renderer, preload allowlist and persisted
    // history must agree, including unknown measurements in legacy records.
    await page.getByRole('button', { name: '请求监控', exact: true }).click();
    await page.getByText('2 个请求', { exact: true }).waitFor();
    const monitoring = await page.evaluate(() => window.ass.call('request-monitor'));
    assert.equal(monitoring.rows.length, 2); assert.equal(monitoring.rows[0].usage.cacheReadTokens, 750);
    assert.equal(monitoring.limit, 200);
    await page.getByRole('button', { name: '查看 model 请求详情', exact: true }).first().click();
    await page.getByRole('region', { name: '请求详情', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭请求详情', exact: true }).click();
    await page.getByRole('region', { name: '请求详情', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(monitoring.rows[0].tps, (50 - 10) * 1000 / 2000, 'primary TPS uses visible count and its own receive interval');
    assert.equal(monitoring.rows[0].endToEndTps, 50 * 1000 / 3000);
    assert.equal(monitoring.rows[1].tps, null, 'legacy records cannot reuse total timing as visible timing');
    assert.equal(await page.getByRole('region', { name: '可见输出 TPS', exact: true }).locator('strong').textContent(), '20');
    assert.deepEqual(monitoring.active, []);
    const unchangedMonitoring = await page.evaluate(revision => window.ass.call('request-monitor', revision), monitoring.revision);
    assert.equal(unchangedMonitoring.rows, undefined, 'per-second polls do not resend unchanged historical rows');
    const widgetCreated = app.waitForEvent('window');
    await page.getByRole('button', { name: '悬浮窗', exact: true }).click();
    const widget = await widgetCreated;
    await widget.waitForSelector('.widget-heatcell');
    assert.equal(await widget.locator('.widget-close').count(), 0);
    assert.equal(await widget.locator('.widget-heatcell').count(), 24);
    assert.equal(await widget.locator('.widget-heatcell[data-current="true"][aria-current="time"]').count(), 1);
    assert.ok((await widget.locator('.widget-heatcell[data-current="true"]').evaluate(cell => getComputedStyle(cell).boxShadow)).includes('1px'));
    assert.equal(await widget.locator('.widget-heatcell').evaluateAll(cells => cells.every(cell => cell.textContent === '')), true);
    const heatPositions = await widget.locator('.widget-heatcell').evaluateAll(cells => cells.slice(0, 4).map(cell => {
      const { x, y } = cell.getBoundingClientRect();return { x, y };
    }));
    assert.equal(heatPositions[0].x, heatPositions[1].x, 'hours 0 and 1 occupy the same column');
    assert.ok(heatPositions[1].y > heatPositions[0].y, 'hour 1 follows hour 0 vertically');
    assert.equal(heatPositions[0].y, heatPositions[2].y, 'hour 2 begins the next column at the top');
    assert.ok(heatPositions[2].x > heatPositions[0].x);
    assert.equal(heatPositions[2].x, heatPositions[3].x);
    assert.equal(heatPositions[1].y, heatPositions[3].y);
    const corners = await widget.locator('.widget-panel').evaluate(panel => {
      const cell = panel.querySelector('.widget-heatcell'), last = panel.querySelector('.widget-heatcell:last-child');
      const outer = panel.getBoundingClientRect(), first = cell.getBoundingClientRect(), end = last.getBoundingClientRect();
      return { outer: parseFloat(getComputedStyle(panel).borderTopLeftRadius), inner: parseFloat(getComputedStyle(cell).borderTopLeftRadius),
        left: first.left - outer.left, bottom: outer.bottom - end.bottom,
        continuous: CSS.supports('corner-shape', 'superellipse(2)') && ['superellipse(2)', 'squircle'].includes(getComputedStyle(panel).cornerShape) };
    });
    assert.ok(Math.abs(corners.left - 16) < 1 && Math.abs(corners.bottom - 16) < 1, 'compact content uses matching 16px edge gaps');
    assert.equal(corners.inner, 5, 'heat cells retain rectangular sides rather than capsule ends');
    assert.ok(corners.continuous, 'foreground supports continuous corners matching native glass');
    await widget.waitForFunction(() => document.querySelector('.widget-panel').dataset.glass === 'true', undefined, { timeout: 10000 });
    const widgetBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().includes('request-widget.html')).getContentBounds());
    const anchored = await widgetBounds();
    await widget.evaluate(() => window.requestWidget.layout(5));
    await widget.waitForFunction(() => innerHeight >= 254);
    const expanded = await widgetBounds();
    assert.ok(Math.abs(expanded.y + expanded.height - anchored.y - anchored.height) <= 1, 'actual foreground bottom stays anchored while growing');
    await widget.evaluate(() => window.requestWidget.layout(1));
    await widget.waitForFunction(() => innerHeight <= 141);
    const collapsed = await widgetBounds();
    assert.ok(Math.abs(collapsed.y + collapsed.height - anchored.y - anchored.height) <= 1, 'actual foreground bottom stays anchored while shrinking');
    await widget.evaluate(() => window.requestWidget.layout(document.querySelectorAll('.widget-row-slot').length));
    assert.equal(await widget.evaluate(() => typeof window.ass), 'undefined', 'widget cannot access the full application bridge');
    await widget.locator('.widget-heatcell').first().hover();
    await widget.getByRole('tooltip').waitFor();
    assert.equal(await widget.getByRole('tooltip').evaluate(node => node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth), true);
    await widget.evaluate(() => window.requestWidget.hide());
    await page.waitForFunction(() => document.querySelector('.monitor-live button[aria-pressed]')?.getAttribute('aria-pressed') === 'false');
    await page.getByRole('button', { name: '模型汇总', exact: true }).click();
    await page.locator('.monitor-summary-table').waitFor();
    assert.equal(await page.locator('.monitor-summary-table tbody > tr').count(), 1);
    assert.equal(await page.locator('.monitor-summary-table tbody > tr > td').first().textContent(), 'model');
    await page.getByRole('button', { name: '请求明细', exact: true }).click();
    await page.locator('.monitor-summary-table').waitFor({ state: 'hidden' });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.ass.call('ui-preferences', { theme }), theme);
        await page.waitForFunction(theme => document.documentElement.dataset.colorTheme === theme, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(output, `request-monitor-package-${width}-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.evaluate(() => window.ass.call('ui-preferences', { theme: 'light' }));
    await page.evaluate(() => {
      window.navigationMotions = [];
      const nativeTransition = document.startViewTransition.bind(document);
      document.startViewTransition = update => {
        window.navigationMotions.push(document.documentElement.dataset.uiTransition);
        return nativeTransition(update);
      };
    });
    for (const title of ['供应商与模型', '客户端与账户', '对话管理', '连接诊断', '路由总览', '请求监控']) {
      await page.getByRole('button', { name: title, exact: true }).click();
      await page.waitForFunction(title => document.querySelector('h1.page-heading-accessible')?.textContent === title, title);
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-transition'));
    }
    assert.deepEqual(await page.evaluate(() => window.navigationMotions), ['down', 'down', 'down', 'down', 'up', 'down']);
    await page.evaluate(() => {
      window.navigationMotions = [];
      const nav = document.querySelector('.sidebar nav');
      for (const title of ['路由总览', '连接诊断', '客户端与账户', '请求监控']) [...nav.querySelectorAll('button')].find(button => button.textContent === title).click();
    });
    await page.waitForFunction(() => document.querySelector('h1.page-heading-accessible')?.textContent === '请求监控' && !document.documentElement.hasAttribute('data-ui-transition'));
    assert.deepEqual(await page.evaluate(() => window.navigationMotions), ['up', 'down', 'down', 'fade'], 'rapid clicks compare against the displayed page, not an uncommitted destination');
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
    // Exercise the shipped renderer and production IPC with a disabled fixture;
    // no real provider, native config sync or inference request is involved.
    await page.evaluate(() => window.ass.call('save-provider', {
      id:'package-fixture',name:'Protocol fixture',enabled:false,baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-package-key',
      models:[{model:'gemini-fixture',displayName:'Gemini fixture',wireApi:'openai-responses'}],
    }));
    await page.getByRole('button',{name:'Codex',exact:true}).click();
    await page.locator('.client-provider summary').filter({hasText:'Protocol fixture'}).click();
    const protocol=page.getByRole('combobox',{name:'Protocol fixture / Gemini fixture 接口协议',exact:true});
    assert.equal(await protocol.inputValue(),'auto');
    await protocol.selectOption('anthropic');
    await page.waitForFunction(()=>!document.querySelector('.model-protocol select')?.disabled);
    assert.equal(await protocol.inputValue(),'anthropic');
    const changed=await page.evaluate(()=>window.ass.call('snapshot'));
    assert.equal(changed.providers[0].models[0].wireApi,'openai-responses');
    assert.equal(changed.harnesses.clients.find(c=>c.id==='codex').injection.models[0].protocol,'anthropic');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data,'clients.json'),'utf8')).injections.codex.modelProtocols['["package-fixture","gemini-fixture"]'],'anthropic');
    if (!(await page.getByRole('button',{name:'pi',exact:true}).isVisible()))
      await page.locator('.more-clients > summary').click();
    await page.getByRole('button',{name:'pi',exact:true}).click();
    await page.locator('.client-provider summary').filter({hasText:'Protocol fixture'}).click();
    assert.equal(await protocol.inputValue(),'auto');
    await page.evaluate(() => window.ass.call('save-provider', {
      id:'package-fixture',name:'Protocol fixture',enabled:true,baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-package-key',
      models:[{model:'gemini-fixture',displayName:'Gemini fixture',wireApi:'openai-responses'},
        {model:'claude-review-fixture',displayName:'Review fixture',wireApi:'anthropic'}],
    }));
    await page.getByRole('button',{name:'Claude Code',exact:true}).click();
    const cliDefault=page.getByRole('combobox',{name:'Claude Code CLI 默认模型',exact:true});
    const reviewer=page.getByRole('combobox',{name:'Claude Code Auto Mode 审查模型',exact:true});
    const mainRef='["package-fixture","gemini-fixture"]',reviewRef='["package-fixture","claude-review-fixture"]';
    await cliDefault.selectOption(mainRef);
    await page.waitForFunction(()=>!document.querySelector('.client-default-model select')?.disabled);
    await reviewer.selectOption(reviewRef);
    await page.waitForFunction(()=>!document.querySelector('.client-default-model select')?.disabled);
    assert.equal(await cliDefault.inputValue(),mainRef);assert.equal(await reviewer.inputValue(),reviewRef);
    const claudeInjection=JSON.parse(fs.readFileSync(path.join(data,'clients.json'),'utf8')).injections.claude;
    assert.equal(claudeInjection.defaultModel,mainRef);assert.equal(claudeInjection.autoModeModel,reviewRef);
    assert.equal(await page.getByRole('button',{name:'启动默认模型终端',exact:true}).isDisabled(),true,'unsynced routes cannot launch');
    await page.locator('.client-settings > summary').click();
    assert.equal(await page.getByRole('switch',{name:'Claude Code WSL 自动同步',exact:true}).isChecked(),false);
    assert.equal(await page.locator('.wsl-sync').getByRole('button',{name:'立即同步',exact:true}).isDisabled(),true);
    await page.locator('.client-settings > summary').click();
    const shot=path.join(process.env.LOCALAPPDATA || root,'ASS-validation','claude-model-defaults.png');
    fs.mkdirSync(path.dirname(shot),{recursive:true});await page.screenshot({path:shot});
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
        injectionProtocolUI:true,
        claudeModelDefaultsUI:true,
        requestWidget:true,
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
