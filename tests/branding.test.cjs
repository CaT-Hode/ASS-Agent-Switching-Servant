const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
test("project full name is Agent-Switching-Servant with ASS product and matching package lock", () => {
  const pkg = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.name, "agent-switching-servant");
  assert.equal(pkg.productName, "ASS");
  assert.ok(pkg.description.includes("Agent-Switching-Servant"));
  assert.equal(lock.name, pkg.name); assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[""].version, pkg.version);
  assert.ok(read('src/updates.jsx').includes('<AboutBrand'));
  for (const file of ["README.md", "LICENSE", "src/about-brand.jsx", "core/openrouter-auth.cjs", "scripts/package.mjs"])
    assert.ok(read(file).includes("Agent-Switching-Servant"), file);
});
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

test("Pi uses the official compact monochrome mark, black in light and white in dark", async () => {
  const { providerBrand } = await import("../src/provider-brand.mjs");
  assert.equal(providerBrand({ id: "native-pi" }), "pi");
  const svg = read("public/providers/pi.svg");
  assert.ok(svg.includes('fill="#000"'));
  assert.doesNotMatch(svg, /#F09082|#4D9ABF|#F1BE58/);
  assert.equal((svg.match(/<path /g) || []).length, 3);
  assert.ok(read("src/clients.jsx").includes('pi: "pi"'));
  assert.ok(read("src/theme.css").includes('img[src="./providers/pi.svg"] { filter: var(--pi-logo-filter); }'));
  const resolved = read("src/theme.css").match(/:root\[data-color-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(resolved?.includes('--pi-logo-filter: invert(1);'));
  assert.ok(read('src/theme.jsx').includes('document.documentElement.dataset.colorTheme = resolved || resolvedTheme(value)'));
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
