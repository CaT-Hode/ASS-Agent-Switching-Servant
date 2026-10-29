const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), asar = require("@electron/asar");
const root = path.resolve(__dirname, ".."), { version } = require("../package.json");
const layout = require('./package-layout.cjs');
const archive = path.join(root, "release", "v" + version, "ASS-win32-x64/resources/app.asar");
let count = 0;
function verify(relative) {
  for (const e of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, e.name);
    if (e.isDirectory()) verify(name);
    else {
      const source = fs.readFileSync(path.join(root, name));
      const expected = name.replaceAll('\\', '/') === 'electron/main.cjs' ? Buffer.from(layout.productionMain(source.toString('utf8'))) : source;
      if (!asar.extractFile(archive, name).equals(expected)) throw Error("Packaged source mismatch: " + name);
      count++;
    }
  }
}
for (const dir of ["core", "electron", "dist"]) verify(dir);
const forbidden = asar.listPackage(archive).filter((n) => /(?:^|[/\\])(?:configLibrary|conversation-library|project-conversations)(?:[/\\]|$)/i.test(n) || /\.ass-session$/i.test(n) || /(?:^|[/\\])(?:claude-desktop-gateway|claude_desktop_config)\.json$/i.test(n) || /^[/\\](?:qa|tests|design|release|docs|\.git)(?:[/\\]|$)/.test(n) ||
  /^[/\\](?:auth\.json|clients(?:\.before-[^/\\]+)?\.json|settings\.json|preferences\.json|[^/\\]+\.enc\.json|[^/\\]+\.aimami-relay\.json|\.env(?:\..*)?)$/.test(n));
if (forbidden.length) throw Error("Forbidden packaged files: " + forbidden.join(", "));
for (const name of asar.listPackage(archive)) if (!layout.allowed(name)) throw Error('Non-runtime packaged entry: ' + name);
const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
if (manifest.scripts || manifest.devDependencies || Object.keys(manifest.dependencies).sort().join(',') !== [...layout.runtimeDependencies].sort().join(','))
  throw Error('Packaged manifest includes build dependencies or scripts');
if (/ASS_TEST_|global\.assTest|--qa/.test(asar.extractFile(archive, 'electron/main.cjs').toString('utf8'))) throw Error('Packaged QA controls found');
// Resolve the packaged parsers from the packaged files before compressing the
// large Electron runtime, including dependencies loaded through dotted folders.
const temp = require('node:os').tmpdir();
const extracted = fs.mkdtempSync(path.join(temp, 'ass-package-runtime-'));
try {
  asar.extractAll(archive, extracted);
  const load = require('node:module').createRequire(path.join(extracted, 'package.json'));
  const parsed = [load('@iarna/toml').parse('value = 7').value, load('yaml').parse('value: 7').value,
    load('jsonc-parser').parse('{/*comment*/"value":7}').value];
  if (parsed.some(value => value !== 7)) throw Error('Packaged runtime parser check failed');
} finally {
  if (path.dirname(extracted) !== temp || !path.basename(extracted).startsWith('ass-package-runtime-')) throw Error('Unexpected parser-check directory');
  fs.rmSync(extracted, { recursive: true, force: true });
}
const suspect = [];
for (const relative of ["core", "electron", "src"]) for (const name of fs.readdirSync(path.join(root, relative))) {
  const file = path.join(root, relative, name);
  if (!fs.statSync(file).isFile()) continue;
  if (/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(fs.readFileSync(file, "utf8"))) suspect.push(path.join(relative, name));
}
if (suspect.length) throw Error("Unexpected token-shaped source content: " + suspect.join(", "));
if (JSON.parse(asar.extractFile(archive, "package.json")).version !== version) throw Error("Wrong packaged version");
for (const name of ['RequestGlass.node', 'DesktopGlass.dll']) {
  const source = fs.readFileSync(path.join(root, 'native/bin/desktop-glass', name));
  const shipped = fs.readFileSync(path.join(path.dirname(archive), 'desktop-glass', name));
  if (!source.equals(shipped)) throw Error('Packaged native glass mismatch: ' + name);
}
if (fs.existsSync(path.join(path.dirname(archive), 'desktop-glass/RequestGlassReview.node'))) throw Error('Native review bridge must not ship');
console.log(JSON.stringify({ version, identicalRuntimeFiles: count, forbiddenPackagedFiles: forbidden.length, tokenShapedSourceFiles: suspect.length,
  asarSha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") }));
