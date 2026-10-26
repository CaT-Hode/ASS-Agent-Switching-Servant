const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
test("brand rename retains persisted data location, app identity and update compatibility", () => {
  const main = read("electron/main.cjs"), updates = read("core/updates.cjs");
  assert.ok(main.includes('path.join(app.getPath("appData"), "AI Switch Servant")'));
  assert.ok(main.includes('app.setName("ASS")'));
  assert.ok(main.includes('app.setAppUserModelId("local.ass.desktop")'));
  assert.match(main, /window\.setAppDetails\(\{\s*appId: "local\.ass\.desktop",/);
  assert.ok(main.includes('appIconPath: app.isPackaged ? process.execPath : path.join(__dirname, "../assets/ass.ico")'));
  assert.ok(main.includes('relaunchDisplayName: "ASS"'));
  assert.ok(main.includes('relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`'));
  assert.ok(updates.includes('CaT-Hode/ASS-Agent-Switching-Servant'));
  assert.ok(updates.includes('AI-Switch-Servant-v${v.text}-win32-x64.zip'));
  assert.ok(read("core/config.cjs").includes('name = "ASS"'));
  assert.ok(!read("core/config.cjs").includes('name = "AI Switch Servant"'));
});

test('Windows app registration and icon export share the stable packaged ASS brand', () => {
  const { windowsBrandSpec } = require('../scripts/local-release.cjs');
  const spec = windowsBrandSpec({ releaseRoot: path.join(root, 'release'), current: path.join(root, 'release/current'), targetPackage: path.join(root, 'release/v0.2.15/ASS-win32-x64') });
  assert.equal(spec.AppId, 'local.ass.desktop');
  assert.equal(spec.Executable, path.join(root, 'release/current/ASS.exe'));
  assert.equal(spec.Icon, path.join(root, 'release/v0.2.15/ASS-win32-x64/resources/ass.ico'));
  assert.ok(read('scripts/package.mjs').includes('extraResource: [fileURLToPath(new URL("../assets/ass.ico"'));
  const registration = read('scripts/windows-brand-registration.ps1');
  assert.ok(registration.includes("Name='IconUri'; Value=$icon") && registration.includes('Value="$icon,0"'));
  assert.ok(registration.includes('Refusing foreign ASS registry entry') && registration.includes('Export-Clixml'));
  assert.ok(registration.includes('SHChangeNotify') && !registration.includes('Stop-Process'));
});
