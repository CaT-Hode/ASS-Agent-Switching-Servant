"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const APP_NAME = "ASS";
const VERSION_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const ZIP_RE = /^ASS-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win32-x64\.zip$/i;
const SHA_RE = /^ASS-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-SHA256\.txt$/i;

function normalize(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();
}
function samePath(a, b) {
  return normalize(a) === normalize(b);
}
function inside(parent, child) {
  const p = normalize(parent) + path.sep;
  const c = normalize(child);
  return c === normalize(parent) || c.startsWith(p);
}
function isLink(stat) {
  return Boolean(stat && stat.isSymbolicLink && stat.isSymbolicLink());
}
function lstatMaybe(file, fsApi = fs) {
  try { return fsApi.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function exists(file, fsApi = fs) { return Boolean(lstatMaybe(file, fsApi)); }
function packagePathFor(releaseRoot, version) {
  return path.join(releaseRoot, `v${version}`, `${APP_NAME}-win32-x64`);
}

function makeContext(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const pkg = options.package || require(path.join(root, "package.json"));
  const env = options.env || process.env;
  const releaseRoot = path.resolve(options.releaseRoot || path.join(root, "release"));
  const programs = options.programs || path.join(
    env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs",
  );
  return {
    root,
    package: pkg,
    version: pkg.version,
    packageName: pkg.name,
    releaseRoot,
    current: path.join(releaseRoot, "current"),
    targetPackage: packagePathFor(releaseRoot, pkg.version),
    programs,
    shortcut: path.join(programs, "ASS.lnk"),
    fsApi: options.fsApi || fs,
    osApi: options.osApi || {},
    env,
    asarReader: options.asarReader,
  };
}

function assertReleaseRoot(ctx) {
  const stat = lstatMaybe(ctx.releaseRoot, ctx.fsApi);
  if (!stat) throw new Error(`release directory is missing: ${ctx.releaseRoot}`);
  if (!stat.isDirectory() || isLink(stat)) throw new Error(`release directory is not an owned directory: ${ctx.releaseRoot}`);
}
function assertPlainPath(ctx, file) {
  const relative = path.relative(ctx.releaseRoot, file);
  if (!inside(ctx.releaseRoot, file)) throw new Error(`path escapes release root: ${file}`);
  let cursor = ctx.releaseRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = lstatMaybe(cursor, ctx.fsApi);
    if (isLink(stat)) throw new Error(`refusing foreign junction/symlink: ${cursor}`);
  }
}
function assertPackageDirectory(ctx, packageDir, label = "package") {
  assertPlainPath(ctx, packageDir);
  const stat = lstatMaybe(packageDir, ctx.fsApi);
  if (!stat) throw new Error(`${label} is missing: ${packageDir}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not an owned directory: ${packageDir}`);
}

function readAsarPackageDefault(asarFile) {
  let asar;
  try { asar = require("@electron/asar"); } catch (e) {
    throw new Error(`cannot load @electron/asar to validate ${asarFile}: ${e.message}`);
  }
  try {
    asar.uncacheAll();
    const metadata = JSON.parse(asar.extractFile(asarFile, "package.json").toString("utf8"));
    for (const file of ["electron/main.cjs", "dist/index.html"]) {
      if (!asar.extractFile(asarFile, file).length) throw new Error(`empty required packaged resource: ${file}`);
    }
    return metadata;
  } catch (e) { throw new Error(`invalid packaged resources: ${e.message}`); }
}

const RUNTIME_FILES = [
  "ASS.exe", "resources/app.asar", "resources/ass.ico", "locales/en-US.pak", "icudtl.dat", "resources.pak",
  "chrome_100_percent.pak", "chrome_200_percent.pak", "snapshot_blob.bin",
  "v8_context_snapshot.bin", "version", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll",
  "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll",
  "vk_swiftshader_icd.json", "vulkan-1.dll", "LICENSE", "LICENSES.chromium.html",
];
function packageTree(ctx, packageDir, pruning = false) {
  function visit(dir, prefix = "") {
    for (const entry of ctx.fsApi.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = prefix + entry.name;
      if (isLink(ctx.fsApi.lstatSync(file))) throw new Error(`refusing foreign junction/symlink: ${file}`);
      const allowed = RUNTIME_FILES.includes(relative) || /^locales\/[A-Za-z0-9-]+\.pak$/.test(relative);
      if (entry.isDirectory()) {
        if (pruning && !["resources", "locales"].includes(relative)) throw new Error(`unknown package directory retained: ${file}`);
        visit(file, relative + "/");
      } else if (!entry.isFile() || (pruning && !allowed)) throw new Error(`unknown package file retained: ${file}`);
    }
  }
  visit(packageDir);
}
function validatePackage(ctx, packageDir, expectedVersion = ctx.version) {
  assertPackageDirectory(ctx, packageDir);
  const required = RUNTIME_FILES.filter(file => !["libEGL.dll", "libGLESv2.dll", "resources/ass.ico"].includes(file));
  const missing = [];
  for (const relative of required) {
    const target = path.join(packageDir, relative);
    assertPlainPath(ctx, target);
    const stat = lstatMaybe(target, ctx.fsApi);
    if (!stat || !stat.isFile() || stat.size === 0) missing.push(relative);
  }
  if (missing.length) throw new Error(`incomplete ASS build at ${packageDir}; missing ${missing.join(", ")}`);
  packageTree(ctx, packageDir);
  const asarFile = path.join(packageDir, "resources", "app.asar");
  const metadata = ctx.asarReader ? ctx.asarReader(asarFile, ctx) : readAsarPackageDefault(asarFile);
  if (!metadata || metadata.name !== ctx.packageName || metadata.version !== expectedVersion)
    throw new Error(`untrusted ASS build metadata at ${packageDir}; expected ${ctx.packageName}@${expectedVersion}`);
  return { packageDir, version: metadata.version, packageName: metadata.name };
}

function canonicalPath(file, fsApi = fs) {
  try { return fsApi.realpathSync.native ? fsApi.realpathSync.native(file) : fsApi.realpathSync(file); }
  catch (_) { return path.resolve(file); }
}
function inspectCurrent(ctx) {
  const stat = lstatMaybe(ctx.current, ctx.fsApi);
  if (!stat) return { exists: false, target: null };
  if (!isLink(stat)) throw new Error(`release/current is not an owned junction: ${ctx.current}`);
  let resolved;
  try { resolved = ctx.fsApi.realpathSync(ctx.current); } catch (e) { throw new Error(`cannot resolve release/current: ${e.message}`); }
  const relative = path.relative(ctx.releaseRoot, resolved).split(path.sep);
  const version = relative.length === 2 && relative[1] === "ASS-win32-x64" && versionFromEntry(relative[0]);
  if (!version) throw new Error(`release/current points outside an owned package: ${resolved}`);
  validatePackage(ctx, resolved, version);
  return { exists: true, target: resolved };
}
function assertCurrentTarget(ctx) {
  assertPackageDirectory(ctx, ctx.targetPackage, "current package");
  return validatePackage(ctx, ctx.targetPackage, ctx.version);
}

function shortcutSpec(ctx, options = {}) {
  const directory = options.keepRunning ? ctx.targetPackage : ctx.current;
  const target = path.join(directory, "ASS.exe");
  return {
    path: ctx.shortcut,
    targetPath: target,
    workingDirectory: directory,
    // A concrete version changes the icon cache key on every update while the
    // launch target remains stable. Never read the cached current/EXE icon.
    iconLocation: `${path.join(ctx.targetPackage, 'resources', 'ass.ico')},0`,
    description: "ASS",
    appUserModelId: "local.ass.desktop",
  };
}
function shortcutProbeDefault(file, ctx) {
  const stat = lstatMaybe(file, ctx.fsApi);
  if (!stat) return null;
  if (isLink(stat)) throw new Error(`refusing linked shortcut path: ${file}`);
  if (process.platform !== "win32") throw new Error(`cannot inspect Windows shortcut on ${process.platform}: ${file}`);
  // Read the persisted property store directly. Shell.Application's cached
  // ExtendedProperty can be empty on Windows Server immediately after a write.
  const script = fs.readFileSync(path.join(__dirname, 'windows-app-identity.ps1'), 'utf8') + "\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=ConvertFrom-Json $env:ASS_SHORTCUT_PROBE; $s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($p.Path); [Console]::Out.WriteLine((ConvertTo-Json @{TargetPath=$l.TargetPath;WorkingDirectory=$l.WorkingDirectory;IconLocation=$l.IconLocation;Description=$l.Description;Arguments=$l.Arguments;AppUserModelId=[AssAppIdentity]::GetShortcut($p.Path)} -Compress))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...ctx.env, ASS_SHORTCUT_SPEC: '', ASS_SHORTCUT_PROBE: JSON.stringify({ Path: file }) },
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`cannot inspect ASS shortcut: ${(result.stderr || "").trim()}`);
  let value;
  try { value = JSON.parse(result.stdout); } catch (e) { throw new Error(`invalid ASS shortcut inspection result: ${e.message}`); }
  // WScript expands DOS 8.3 user directories on Windows Server. Rebase only
  // the checked root's spelling, preserving the release/current junction path.
  const longRoot = ctx.fsApi.realpathSync.native ? ctx.fsApi.realpathSync.native(ctx.root) : ctx.fsApi.realpathSync(ctx.root);
  const rootSpelling = file => typeof file === 'string' && file.toLowerCase().startsWith(longRoot.toLowerCase() + path.sep)
    ? ctx.root + file.slice(longRoot.length) : file;
  for (const key of ['TargetPath', 'WorkingDirectory', 'IconLocation']) value[key] = rootSpelling(value[key]);
  return value;
}
function ownedShortcut(ctx, existing) {
  if (!existing) return true;
  const target = existing.targetPath || existing.TargetPath || "";
  const work = existing.workingDirectory || existing.WorkingDirectory || "";
  const icon = existing.iconLocation || existing.IconLocation || "";
  const currentTarget = samePath(target, path.join(ctx.current, "ASS.exe"));
  if (!currentTarget) {
    const parts = path.relative(ctx.releaseRoot, target).split(path.sep);
    const version = parts.length === 3 && versionFromEntry(parts[0]);
    if (!version || parts[1] !== "ASS-win32-x64" || parts[2] !== "ASS.exe") throw new Error(`refusing foreign ASS.lnk: ${ctx.shortcut}`);
    validatePackage(ctx, path.dirname(target), version);
  }
  if (existing.arguments || existing.Arguments) throw new Error(`refusing ASS.lnk with custom arguments: ${ctx.shortcut}`);
  const ownedWork = !work || samePath(work, path.dirname(target));
  const iconFile = icon.replace(/,\s*-?\d+$/, "");
  let ownedIcon = !icon || samePath(iconFile, target) || samePath(iconFile, path.join(ctx.current, 'resources', 'ass.ico'));
  if (!ownedIcon) {
    const parts = path.relative(ctx.releaseRoot, iconFile).split(path.sep);
    const version = parts.length === 4 && versionFromEntry(parts[0]);
    if (version && parts[1] === 'ASS-win32-x64' && parts[2] === 'resources' && parts[3] === 'ass.ico') {
      assertPlainPath(ctx, iconFile); validatePackage(ctx, path.dirname(path.dirname(iconFile)), version); ownedIcon = true;
    }
  }
  if (!ownedWork || !ownedIcon)
    throw new Error(`refusing foreign ASS.lnk: ${ctx.shortcut}`);
  return true;
}
function processProbeDefault(paths, ctx) {
  if (process.platform !== "win32") return [];
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $wanted=ConvertFrom-Json $env:ASS_RELEASE_PROCESS_PATHS; $set=@{}; foreach($p in $wanted){$set[$p.ToLowerInvariant()]=1}; Get-CimInstance Win32_Process -Filter \"Name='ASS.exe'\" | ForEach-Object { if(-not $_.ExecutablePath) { throw ('Cannot inspect executable path for ASS PID '+$_.ProcessId) }; if($set.ContainsKey($_.ExecutablePath.ToLowerInvariant())) { [Console]::Out.WriteLine((ConvertTo-Json @{Id=$_.ProcessId;ExecutablePath=$_.ExecutablePath} -Compress)) } }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...ctx.env, ASS_RELEASE_PROCESS_PATHS: JSON.stringify(paths) },
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`cannot inspect running ASS processes: ${(result.stderr || "").trim()}`);
  return String(result.stdout || "").split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (_) { return { ExecutablePath: line }; }
  });
}
function processProbe(ctx, paths) {
  const probe = ctx.osApi.processProbe || ((wanted) => processProbeDefault(wanted, ctx));
  const found = probe(paths, ctx) || [];
  return found.filter(item => item && (item.executablePath || item.ExecutablePath));
}
function assertNoRunning(ctx, packageDirs) {
  const paths = packageDirs.map(dir => path.join(dir, "ASS.exe"));
  const current = inspectCurrent(ctx);
  if (current.exists && packageDirs.some(dir => samePath(dir, current.target))) paths.push(path.join(ctx.current, "ASS.exe"));
  const seen = new Set();
  const unique = paths.filter(p => { const k = normalize(p); if (seen.has(k)) return false; seen.add(k); return true; });
  const running = processProbe(ctx, unique);
  if (running.length) {
    const detail = running.map(p => `${p.Id || p.id || "?"}:${p.ExecutablePath || p.executablePath}`).join(", ");
    throw new Error(`ASS release is running; close process before updating/removing package (${detail})`);
  }
  return { paths: unique, running: [] };
}

function versionFromEntry(name) {
  const match = VERSION_RE.exec(name);
  return match ? match[1] : null;
}
function artifactVersion(name) {
  let m = ZIP_RE.exec(name); if (m) return m[1];
  m = SHA_RE.exec(name); return m ? m[1] : null;
}
function listReleaseEntries(ctx) {
  assertReleaseRoot(ctx);
  return ctx.fsApi.readdirSync(ctx.releaseRoot, { withFileTypes: true }).map(entry => entry.name);
}
function verifiedArtifacts(ctx, directory, version) {
  const zip = path.join(directory, `ASS-v${version}-win32-x64.zip`);
  const sha = path.join(directory, `ASS-v${version}-SHA256.txt`);
  try {
    for (const file of [zip, sha]) {
      assertPlainPath(ctx, file);
      const stat = ctx.fsApi.lstatSync(file);
      if (!stat.isFile()) return [];
    }
    const checksum = ctx.fsApi.readFileSync(sha, "utf8").replace(/^\uFEFF/, "").trim();
    const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(checksum);
    if (!match || match[2] !== path.basename(zip)) return [];
    const hash = require("node:crypto").createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    const fd = ctx.fsApi.openSync(zip, "r");
    try {
      let position = 0, size;
      while ((size = ctx.fsApi.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
        if (!position && (size < 4 || buffer.readUInt32LE(0) !== 0x04034b50)) return [];
        hash.update(buffer.subarray(0, size));
        position += size;
      }
      if (!position || hash.digest("hex").toLowerCase() !== match[1].toLowerCase()) return [];
    } finally { ctx.fsApi.closeSync(fd); }
    return [sha, zip];
  } catch (_) { return []; }
}
function collectPruneCandidates(ctx) {
  const candidates = [];
  const unknown = [];
  for (const name of listReleaseEntries(ctx)) {
    const full = path.join(ctx.releaseRoot, name);
    const stat = lstatMaybe(full, ctx.fsApi);
    const v = versionFromEntry(name);
    if (v) {
      if (isLink(stat)) throw new Error(`refusing foreign junction/symlink: ${full}`);
      if (!stat.isDirectory()) { unknown.push(full); continue; }
      if (v === ctx.version) continue;
      const pkgDir = path.join(full, `${APP_NAME}-win32-x64`);
      try {
        validatePackage(ctx, pkgDir, v);
        packageTree(ctx, pkgDir, true);
        candidates.push({ type: "package", version: v, path: pkgDir, versionDir: full });
        for (const file of verifiedArtifacts(ctx, full, v)) candidates.push({ type: "artifact", version: v, path: file, versionDir: full });
      } catch (e) {
        unknown.push(full);
      }
      continue;
    }
    const av = artifactVersion(name);
    if (av && av !== ctx.version) {
      const versionDir = path.join(ctx.releaseRoot, `v${av}`);
      const pkgDir = path.join(versionDir, `${APP_NAME}-win32-x64`);
      try {
        validatePackage(ctx, pkgDir, av);
        if (!verifiedArtifacts(ctx, ctx.releaseRoot, av).includes(full)) throw new Error("unverified archive");
        candidates.push({ type: "artifact", version: av, path: full, versionDir });
      }
      catch (_) { unknown.push(full); }
    } else unknown.push(full);
  }
  for (const item of candidates) {
    if (item.type === "artifact") {
      const stat = ctx.fsApi.lstatSync(item.path);
      item.observed = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    }
  }
  return { candidates, unknown };
}
function buildPlan(ctx, options = {}) {
  const prune = Boolean(options.prune);
  if (options.keepRunning && prune) throw Error("--keep-running cannot prune runtime files");
  assertReleaseRoot(ctx);
  const current = inspectCurrent(ctx);
  const target = assertCurrentTarget(ctx);
  const shortcut = shortcutSpec(ctx, options);
  const shortcutReader = ctx.osApi.shortcutProbe || ((file) => shortcutProbeDefault(file, ctx));
  const existingShortcut = shortcutReader(ctx.shortcut, ctx);
  ownedShortcut(ctx, existingShortcut);
  let pruneData = { candidates: [], unknown: [] };
  if (prune) pruneData = collectPruneCandidates(ctx);
  const packageDirs = current.exists && !samePath(current.target, ctx.targetPackage) ? [current.target] : [];
  for (const item of pruneData.candidates) packageDirs.push(path.join(item.versionDir, "ASS-win32-x64"));
  let running = [], preservedProcesses = [];
  if (options.keepRunning) {
    // Never rebind a path from which a live Electron can lazily load modules.
    // Only future launch entries change, pinned to the validated new package.
    preservedProcesses = processProbe(ctx, [...packageDirs.map(dir => path.join(dir, "ASS.exe")), path.join(ctx.current, "ASS.exe")]);
  } else {
    try { assertNoRunning(ctx, packageDirs); }
    catch (e) { running = [e.message]; }
  }
  return {
    mode: "plan", prune, version: ctx.version,
    activation: options.keepRunning ? "next-launch" : "current", preservedProcesses,
    releaseRoot: ctx.releaseRoot, targetPackage: ctx.targetPackage, current: ctx.current,
    currentLink: current.exists ? "owned" : "missing", targetMetadata: target,
    shortcut: { ...shortcut, existing: existingShortcut },
    prune: pruneData,
    running,
    actions: [
      options.keepRunning || current.exists && samePath(canonicalPath(ctx.current, ctx.fsApi), ctx.targetPackage) ? "keep release/current junction" : "create/update release/current junction",
      shortcutMatches(existingShortcut, shortcut) ? "keep ASS.lnk" : options.keepRunning ? "write version-pinned ASS.lnk for next launch" : "write current-based ASS.lnk with app identity",
      ...pruneData.candidates.map(item => `remove ${path.relative(ctx.root, item.path)}`),
    ],
  };
}

function removeOwnedLink(ctx, file) {
  const stat = lstatMaybe(file, ctx.fsApi);
  if (!stat) return;
  if (!isLink(stat)) throw new Error(`refusing to remove non-junction: ${file}`);
  ctx.fsApi.unlinkSync(file);
}
function createJunctionDefault(link, target, ctx) {
  ctx.fsApi.symlinkSync(target, link, "junction");
}
function replaceCurrent(ctx) {
  const old = inspectCurrent(ctx);
  if (old.exists && samePath(old.target, ctx.targetPackage)) return { changed: false, old };
  const temp = path.join(ctx.releaseRoot, `.current-${process.pid}-${Date.now()}`);
  const create = ctx.osApi.createJunction || ((link, target) => createJunctionDefault(link, target, ctx));
  const rename = ctx.osApi.rename || ((a, b) => ctx.fsApi.renameSync(a, b));
  const remove = ctx.osApi.removeLink || ((file) => removeOwnedLink(ctx, file));
  create(temp, ctx.targetPackage, ctx);
  try {
    if (exists(ctx.current, ctx.fsApi)) remove(ctx.current, ctx);
    rename(temp, ctx.current, ctx);
    return { changed: true, old };
  } catch (e) {
    try { if (exists(temp, ctx.fsApi)) remove(temp, ctx); } catch (_) {}
    if (old.exists && !exists(ctx.current, ctx.fsApi)) {
      try { create(ctx.current, old.target, ctx); } catch (_) {}
    }
    throw new Error(`cannot update release/current junction; rollback attempted: ${e.message}`);
  }
}
function writeShortcutDefault(spec, ctx) {
  if (process.platform !== "win32") throw new Error(`cannot write Windows shortcut on ${process.platform}`);
  ctx.fsApi.mkdirSync(path.dirname(spec.path), { recursive: true });
  const temp = path.join(path.dirname(spec.path), `.ASS-${process.pid}-${Date.now()}.lnk`);
  const backup = `${spec.path}.bak-${process.pid}-${Date.now()}`;
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=ConvertFrom-Json $env:ASS_SHORTCUT_SPEC; $s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($p.Path); $l.TargetPath=$p.TargetPath; $l.WorkingDirectory=$p.WorkingDirectory; $l.IconLocation=$p.IconLocation; $l.Description=$p.Description; $l.Save()\n" + fs.readFileSync(path.join(__dirname, "windows-app-identity.ps1"), "utf8");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...ctx.env, ASS_SHORTCUT_SPEC: JSON.stringify({ Path: temp, TargetPath: spec.targetPath, WorkingDirectory: spec.workingDirectory, IconLocation: spec.iconLocation, Description: spec.description, AppUserModelId: spec.appUserModelId }) },
    encoding: "utf8", windowsHide: true, stdio: "ignore",
  });
  if (result.status !== 0 || !exists(temp, ctx.fsApi)) {
    if (exists(temp, ctx.fsApi)) ctx.fsApi.unlinkSync(temp);
    throw new Error(`cannot create ASS shortcut: ${result.error ? result.error.message : `exit ${result.status}`}`);
  }
  let published = false;
  try {
    const temporary = shortcutProbeDefault(temp, ctx);
    if (!shortcutMatches(temporary, spec)) throw new Error("shortcut readback mismatch: " + JSON.stringify({ expected: spec, actual: temporary }));
    if (exists(spec.path, ctx.fsApi)) ctx.fsApi.renameSync(spec.path, backup);
    ctx.fsApi.renameSync(temp, spec.path);
    published = true;
    const saved = shortcutProbeDefault(spec.path, ctx);
    if (!shortcutMatches(saved, spec)) throw new Error("shortcut readback mismatch: " + JSON.stringify({ expected: spec, actual: saved }));
  } catch (e) {
    try { if (exists(temp, ctx.fsApi)) ctx.fsApi.unlinkSync(temp); } catch (_) {}
    try { if (published) ctx.fsApi.unlinkSync(spec.path); } catch (_) {}
    try { if (exists(backup, ctx.fsApi)) ctx.fsApi.renameSync(backup, spec.path); } catch (_) {}
    throw new Error(`cannot replace ASS shortcut; rollback attempted: ${e.message}`);
  }
  if (exists(backup, ctx.fsApi)) {
    try { ctx.fsApi.unlinkSync(backup); } catch (e) { console.warn(`Installed ASS shortcut; retained backup ${backup}: ${e.message}`); }
  }
}
function writeShortcut(ctx, spec) {
  const writer = ctx.osApi.writeShortcut || ((value) => writeShortcutDefault(value, ctx));
  writer(spec, ctx);
}
function removeCandidate(ctx, item) {
  if (!inside(ctx.releaseRoot, item.path)) throw new Error(`refusing path outside release root: ${item.path}`);
  const stat = lstatMaybe(item.path, ctx.fsApi);
  if (!stat) return;
  assertPlainPath(ctx, item.path);
  if (isLink(stat)) throw new Error(`refusing linked prune target: ${item.path}`);
  const current = inspectCurrent(ctx);
  if (item.version === ctx.version || (current.exists && inside(item.path, current.target))) throw new Error(`refusing to prune current package: ${item.path}`);
  if (item.type === "package") {
    validatePackage(ctx, item.path, item.version);
    packageTree(ctx, item.path, true);
    assertNoRunning(ctx, [item.path]);
    const remove = ctx.osApi.removeTree || ((target) => ctx.fsApi.rmSync(target, { recursive: true, force: false }));
    remove(item.path, ctx);
  } else {
    if (!stat.isFile()) throw new Error(`refusing non-file prune target: ${item.path}`);
    if (!item.observed || ["size", "mtimeMs", "ino"].some(key => stat[key] !== item.observed[key])) throw new Error(`artifact changed after planning: ${item.path}`);
    assertNoRunning(ctx, [path.join(item.versionDir, "ASS-win32-x64")]);
    const av = artifactVersion(path.basename(item.path));
    if (av !== item.version) throw new Error(`artifact ownership mismatch: ${item.path}`);
    ctx.fsApi.unlinkSync(item.path);
  }
}
function shortcutMatches(existing, spec) {
  return Boolean(existing && samePath(existing.targetPath || existing.TargetPath || "", spec.targetPath)
    && samePath(existing.workingDirectory || existing.WorkingDirectory || "", spec.workingDirectory)
    && samePath(String(existing.iconLocation || existing.IconLocation || "").replace(/,\s*-?\d+$/, ""), spec.iconLocation.replace(/,\s*-?\d+$/, ""))
    && (existing.appUserModelId || existing.AppUserModelId) === spec.appUserModelId
    && !(existing.arguments || existing.Arguments));
}
function executeInstall(ctx, options = {}) {
  const plan = buildPlan(ctx, options);
  if (plan.running.length) throw new Error(plan.running[0]);
  const oldCurrent = inspectCurrent(ctx);
  if (options.keepRunning) {
    if (!shortcutMatches(plan.shortcut.existing, plan.shortcut)) writeShortcut(ctx, plan.shortcut);
    const reader = ctx.osApi.shortcutProbe || ((file) => shortcutProbeDefault(file, ctx));
    if (!shortcutMatches(reader(ctx.shortcut, ctx), plan.shortcut)) throw Error("ASS shortcut readback mismatch");
    const after = inspectCurrent(ctx);
    if (oldCurrent.exists !== after.exists || oldCurrent.exists && !samePath(oldCurrent.target, after.target))
      throw Error("release/current changed concurrently; running runtime was not modified by this installer");
    return { ...plan, mode: "install", installed: true, currentPreserved: true,
      activeRuntimeReplaced: false, nextLaunchExecutable: plan.shortcut.targetPath };
  }
  const replacement = replaceCurrent(ctx);
  let shortcutCommitted = false;
  try {
    if (!shortcutMatches(plan.shortcut.existing, plan.shortcut)) writeShortcut(ctx, plan.shortcut);
    shortcutCommitted = true;
    const reader = ctx.osApi.shortcutProbe || ((file) => shortcutProbeDefault(file, ctx));
    if (!shortcutMatches(reader(ctx.shortcut, ctx), plan.shortcut)) throw new Error("ASS shortcut readback mismatch; pruning aborted");
  } catch (e) {
    if (replacement.changed && !shortcutCommitted) {
      try {
        removeOwnedLink(ctx, ctx.current);
        if (oldCurrent.exists) ctx.fsApi.symlinkSync(oldCurrent.target, ctx.current, "junction");
      } catch (rollback) { throw new Error(`${e.message}; junction rollback failed: ${rollback.message}`); }
    }
    throw e;
  }
  // Installation is committed. Never roll back to a package after pruning starts.
  if (options.prune) {
    assertNoRunning(ctx, plan.prune.candidates.filter(item => item.type === "package").map(item => item.path));
    for (const item of plan.prune.candidates) removeCandidate(ctx, item);
    for (const dir of new Set(plan.prune.candidates.map(item => item.versionDir))) {
      const stat = lstatMaybe(dir, ctx.fsApi);
      if (stat && stat.isDirectory() && !isLink(stat) && ctx.fsApi.readdirSync(dir).length === 0) ctx.fsApi.rmdirSync(dir);
    }
  }
  return { ...plan, mode: "install", installed: true };
}

function prePackageGuard(options = {}) {
  const ctx = makeContext(options);
  const release = lstatMaybe(ctx.releaseRoot, ctx.fsApi);
  if (!release) return { guarded: true, targetPackage: ctx.targetPackage, current: ctx.current };
  assertReleaseRoot(ctx);
  assertPlainPath(ctx, ctx.targetPackage);
  assertNoRunning(ctx, [ctx.targetPackage]);
  return { guarded: true, targetPackage: ctx.targetPackage, current: ctx.current };
}

function parseArgs(argv = process.argv.slice(2)) {
  let command = "plan", prune = false, json = false;
  let keepRunning = false;
  for (const arg of argv) {
    if (arg === "plan" || arg === "install") command = arg;
    else if (arg === "--prune") prune = true;
    else if (arg === "--json") json = true;
    else if (arg === "--keep-running") keepRunning = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { command, prune, json, ...(keepRunning ? { keepRunning: true } : {}) };
}
function usage() {
  return "Usage: node scripts/local-release.cjs [plan|install] [--prune | --keep-running] [--json]";
}
function windowsBrandSpec(ctx, options = {}) {
  return { ReleaseRoot: ctx.releaseRoot, Executable: shortcutSpec(ctx, options).targetPath,
    Icon: path.join(ctx.targetPackage, 'resources', 'ass.ico'), AppId: 'local.ass.desktop' };
}
function refreshShortcutIcon(ctx) {
  // Safe even while ASS routes requests: only replace its already-owned link.
  assertReleaseRoot(ctx); assertCurrentTarget(ctx);
  const current = inspectCurrent(ctx);
  if (!current.exists || !samePath(current.target, ctx.targetPackage)) throw Error('ASS icon refresh must match the installed version');
  const read = ctx.osApi.shortcutProbe || ((file) => shortcutProbeDefault(file, ctx));
  ownedShortcut(ctx, read(ctx.shortcut, ctx));
  const spec = shortcutSpec(ctx); writeShortcut(ctx, spec);
  if (!shortcutMatches(read(ctx.shortcut, ctx), spec)) throw Error('ASS shortcut icon readback mismatch');
  registerWindowsBrand(ctx);
  return { updated: true, shortcut: spec.path, icon: spec.iconLocation };
}
function registerWindowsBrand(ctx, options = {}) {
  const spec = windowsBrandSpec(ctx, options);
  if (!ctx.fsApi.existsSync(spec.Icon)) throw Error('Packaged ASS icon is missing');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-brand-registration.ps1')],
    { encoding: 'utf8', windowsHide: true, env: { ...ctx.env, ASS_BRAND_SPEC: JSON.stringify(spec) } });
  if (result.status !== 0) throw Error('ASS Windows icon registration failed: ' + (result.stderr || result.error?.message || '').trim());
  return { registered: true, appId: spec.AppId, icon: spec.Icon };
}
function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return { help: true }; }
  const ctx = makeContext(options);
  const result = args.command === "install" ? executeInstall(ctx, args) : buildPlan(ctx, args);
  if (args.command === 'install' && process.platform === 'win32') result.brand = registerWindowsBrand(ctx, args);
  console.log(JSON.stringify(result, null, args.json ? 2 : 0));
  return result;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`local-release: ${e.message}`); process.exitCode = 1; }
}

module.exports = {
  RUNTIME_FILES, makeContext, parseArgs, usage, buildPlan, executeInstall,
  validatePackage, inspectCurrent, collectPruneCandidates, shortcutSpec, prePackageGuard,
  windowsBrandSpec,
  refreshShortcutIcon,
};
