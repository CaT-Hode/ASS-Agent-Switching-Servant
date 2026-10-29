"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  RUNTIME_FILES, makeContext, parseArgs, buildPlan, executeInstall, prePackageGuard, pruneInstallerFiles,
} = require("../scripts/local-release.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-local-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value = "fixture") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  const pkg = { name: "agent-switching-servant", version: "0.2.6" };
  write("package.json", JSON.stringify(pkg));
  const build = (version, name = pkg.name) => {
    const relative = `release/v${version}/ASS-win32-x64`;
    for (const file of RUNTIME_FILES) write(`${relative}/${file}`);
    write(`${relative}/resources/app.asar`, JSON.stringify({ name, version }));
    return path.join(root, relative);
  };
  const target = build(pkg.version);
  let shortcut = null, writes = 0, processes = [];
  const osApi = {
    shortcutProbe: () => shortcut,
    writeShortcut: spec => { shortcut = { ...spec }; writes++; },
    processProbe: paths => processes.filter(p => paths.some(file => file.toLowerCase() === p.ExecutablePath.toLowerCase())),
  };
  const options = {
    root, package: pkg, programs: path.join(root, "mock-programs"), osApi,
    asarReader: file => JSON.parse(fs.readFileSync(file, "utf8")),
  };
  const ctx = makeContext(options);
  return {
    root, ctx, options, write, build, target, osApi,
    get writes() { return writes; },
    get shortcut() { return shortcut; },
    set shortcut(value) { shortcut = value; },
    set processes(value) { processes = value; },
    link: target => fs.symlinkSync(target, ctx.current, "junction"),
  };
}
function snapshot(root) {
  const result = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      result.push([path.relative(root, full), entry.isSymbolicLink() ? fs.readlinkSync(full) : entry.isDirectory() ? "dir" : fs.readFileSync(full).toString("base64")]);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(full);
    }
  };
  visit(root);
  return result;
}
test('successful installer builds retain one installer version without touching runtime packages or unrelated files', t => {
  const f = fixture(t), old = f.build('0.2.4');
  const oldExe = f.write('release/ASS-v0.2.4-win32-x64-setup.exe');
  const oldHash = f.write('release/ASS-v0.2.4-setup-SHA256.txt');
  const latestHash = f.write('release/ASS-v0.2.6-setup-SHA256.txt');
  const unrelated = f.write('release/user-installer.exe');
  const before = snapshot(f.root);
  assert.throws(() => pruneInstallerFiles(f.ctx), /New installer is missing/);
  assert.deepEqual(snapshot(f.root), before, 'failed builds keep the previous installer');
  const latest = f.write('release/ASS-v0.2.6-win32-x64-setup.exe');
  assert.deepEqual(pruneInstallerFiles(f.ctx).sort(), [path.basename(oldExe), path.basename(oldHash)].sort());
  assert.equal(fs.existsSync(oldExe), false); assert.equal(fs.existsSync(oldHash), false);
  for (const file of [latest, latestHash, unrelated, path.join(old, 'ASS.exe'), path.join(f.target, 'ASS.exe')])
    assert.equal(fs.existsSync(file), true, file);
  assert.deepEqual(pruneInstallerFiles(f.ctx), [], 'repeated cleanup is harmless');
});

test('owned resources icon is prunable, repeat install is safe, and unknown resources stay protected',t=>{
  const f=fixture(t),old=f.build('0.2.4');fs.writeFileSync(path.join(old,'resources/ass.ico'),'synthetic icon');
  assert.ok(buildPlan(f.ctx,{prune:true}).prune.candidates.some(item=>item.path===old));
  executeInstall(f.ctx,{prune:true});assert.equal(fs.existsSync(old),false);executeInstall(f.ctx,{prune:true});
  const unknown=f.build('0.2.3');fs.writeFileSync(path.join(unknown,'resources/unknown.txt'),'keep');
  assert.ok(buildPlan(f.ctx,{prune:true}).prune.unknown.includes(path.dirname(unknown)));assert.ok(fs.existsSync(unknown));
});

test("CLI defaults to read-only plan, including --prune", () => {
  assert.equal(parseArgs([]).command, "plan");
  assert.deepEqual(parseArgs(["--prune"]), { command: "plan", prune: true, json: false });
  assert.equal(parseArgs(["install", "--prune"]).command, "install");
  assert.throws(() => parseArgs(["--force"]), /unknown argument/);
});

test("plan reads builds and plans stable shortcut without any filesystem mutation", t => {
  const f = fixture(t);
  const old = f.build("0.2.4");
  f.shortcut = { TargetPath: path.join(old, "ASS.exe"), WorkingDirectory: old, IconLocation: path.join(old, "ASS.exe") + ",0" };
  const before = snapshot(f.root);
  const plan = buildPlan(f.ctx, { prune: true });
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.writes, 0);
  assert.equal(plan.shortcut.targetPath, path.join(f.ctx.current, "ASS.exe"));
  assert.equal(plan.shortcut.workingDirectory, f.ctx.current);
  assert.equal(plan.shortcut.iconLocation, path.join(f.ctx.targetPackage, "resources/ass.ico") + ",0");
  assert.equal(plan.shortcut.appUserModelId, "local.ass.desktop");
  assert.equal(plan.prune.candidates.length, 1);
});

test("install migrates old shortcut, creates junction, and is idempotent", t => {
  const f = fixture(t), old = f.build("0.2.4");
  f.shortcut = { TargetPath: path.join(old, "ASS.exe"), WorkingDirectory: old, IconLocation: path.join(old, "ASS.exe") + ",0" };
  executeInstall(f.ctx);
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(f.target));
  assert.equal(f.writes, 1);
  const before = snapshot(f.root);
  executeInstall(f.ctx);
  assert.equal(f.writes, 1);
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(fs.existsSync(old));
});

test("install repairs missing shortcut identity without switching current", t => {
  const f = fixture(t);
  executeInstall(f.ctx);
  delete f.shortcut.appUserModelId;
  const before = fs.readlinkSync(f.ctx.current);
  const plan = buildPlan(f.ctx);
  assert.ok(plan.actions.includes("write current-based ASS.lnk with app identity"));
  executeInstall(f.ctx);
  assert.equal(f.shortcut.appUserModelId, "local.ass.desktop");
  assert.equal(fs.readlinkSync(f.ctx.current), before);
  assert.equal(f.writes, 2);
});

test("install advances an owned older current junction and prunes only old packages", t => {
  const f = fixture(t), old = f.build("0.2.4");
  f.link(old);
  f.write("release/v0.2.4/release-notes.md", "unknown notes");
  f.write("release/v0.2.4/SHA256SUMS.txt", "unknown sum");
  f.write("release/v0.2.4/ASS-v0.2.4-win32-x64.zip");
  f.write("release/ASS-v0.2.4-SHA256.txt");
  f.write("release/unrelated.zip");
  f.write("release/ASS-v0.2.6-win32-x64.zip");
  executeInstall(f.ctx, { prune: true });
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(f.target));
  assert.ok(!fs.existsSync(old));
  for (const file of ["v0.2.4/release-notes.md", "v0.2.4/SHA256SUMS.txt", "unrelated.zip", "ASS-v0.2.6-win32-x64.zip"]) assert.ok(fs.existsSync(path.join(f.ctx.releaseRoot, file)), file);
});

test("foreign metadata, incomplete packages, and unknown package files are retained", t => {
  const f = fixture(t), foreign = f.build("0.2.1", "other-app"), incomplete = f.build("0.2.2"), unknown = f.build("0.2.3");
  fs.unlinkSync(path.join(incomplete, "resources.pak"));
  f.write("release/v0.2.3/ASS-win32-x64/user-settings.json", "keep");
  f.write("release/ASS-v9.9.9-win32-x64.zip", "unowned archive");
  executeInstall(f.ctx, { prune: true });
  for (const dir of [foreign, incomplete, unknown]) assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(f.ctx.releaseRoot, "ASS-v9.9.9-win32-x64.zip")));
});

test("prune removes only checksum-verified archives beside verified builds", t => {
  const f = fixture(t);
  f.build("0.2.4");
  const zipName = "ASS-v0.2.4-win32-x64.zip";
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from("fixture archive")]);
  const sha = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  f.write(`release/${zipName}`, bytes);
  f.write("release/ASS-v0.2.4-SHA256.txt", `${sha}  ${zipName}\n`);
  f.write(`release/v0.2.4/${zipName}`, "not an archive");
  f.write("release/v0.2.4/ASS-v0.2.4-SHA256.txt", "unknown content");
  const plan = buildPlan(f.ctx, { prune: true });
  assert.equal(plan.prune.candidates.filter(item => item.type === "artifact").length, 2);
  executeInstall(f.ctx, { prune: true });
  assert.ok(!fs.existsSync(path.join(f.ctx.releaseRoot, zipName)));
  assert.ok(!fs.existsSync(path.join(f.ctx.releaseRoot, "ASS-v0.2.4-SHA256.txt")));
  assert.ok(fs.existsSync(path.join(f.ctx.releaseRoot, "v0.2.4", zipName)));
  assert.ok(fs.existsSync(path.join(f.ctx.releaseRoot, "v0.2.4", "ASS-v0.2.4-SHA256.txt")));
});

test("foreign shortcut and custom arguments fail before current is created", t => {
  const f = fixture(t);
  f.shortcut = { TargetPath: path.join(f.root, "elsewhere", "ASS.exe") };
  assert.throws(() => executeInstall(f.ctx), /foreign ASS.lnk/);
  assert.ok(!fs.existsSync(f.ctx.current));
  f.shortcut = { TargetPath: path.join(f.target, "ASS.exe"), Arguments: "--custom" };
  assert.throws(() => executeInstall(f.ctx), /custom arguments/);
});

for (const where of ["current", "version", "package", "resources", "old-version", "old-package-child"]) {
  test(`refuses or retains foreign junction at ${where}`, t => {
    const f = fixture(t), outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel"), "keep");
    let link;
    if (where === "current") link = f.ctx.current;
    if (where === "version") link = path.dirname(f.target);
    if (where === "package") link = f.target;
    if (where === "resources") link = path.join(f.target, "resources");
    if (where === "old-version") link = path.join(f.ctx.releaseRoot, "v0.2.4");
    if (where === "old-package-child") link = path.join(f.build("0.2.4"), "outside-data");
    fs.rmSync(link, { force: true, recursive: true });
    fs.symlinkSync(outside, link, "junction");
    if (where === "old-package-child") assert.equal(buildPlan(f.ctx, { prune: true }).prune.candidates.length, 0);
    else assert.throws(() => executeInstall(f.ctx, { prune: true }), /junction|owned package|missing/);
    assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "keep");
  });
}

test("running old package and current alias block install without killing anything", t => {
  const f = fixture(t), old = f.build("0.2.4");
  f.link(old);
  for (const executable of [path.join(old, "ASS.exe"), path.join(f.ctx.current, "ASS.exe")]) {
    f.processes = [{ Id: 42, ExecutablePath: executable }];
    assert.equal(buildPlan(f.ctx, { prune: true }).running.length, 1);
    assert.throws(() => executeInstall(f.ctx, { prune: true }), /running.*42/);
    assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(old));
    assert.equal(f.writes, 0);
  }
});

test('keep-running pins future entries without changing the current junction or any package bytes', t => {
  const f = fixture(t), old = f.build('0.2.4'); f.link(old);
  f.processes = [{ Id: 42, ExecutablePath: path.join(f.ctx.current, 'ASS.exe') }];
  const before = snapshot(f.ctx.releaseRoot), options = { keepRunning: true };
  const plan = buildPlan(f.ctx, options);
  assert.equal(plan.activation, 'next-launch'); assert.equal(plan.running.length, 0);
  assert.equal(plan.preservedProcesses[0].Id, 42);
  const result = executeInstall(f.ctx, options);
  assert.equal(result.activeRuntimeReplaced, false); assert.equal(result.currentPreserved, true);
  assert.equal(f.shortcut.targetPath, path.join(f.target, 'ASS.exe'));
  assert.equal(f.shortcut.workingDirectory, f.target);
  assert.deepEqual(snapshot(f.ctx.releaseRoot), before);
  const writes = f.writes; executeInstall(f.ctx, options); assert.equal(f.writes, writes);
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(old));
});

test('keep-running still refuses pruning, foreign shortcuts and failed process inspection', t => {
  const f = fixture(t);
  assert.equal(parseArgs(['install','--keep-running']).keepRunning, true);
  assert.throws(() => executeInstall(f.ctx, { keepRunning:true, prune:true }), /cannot prune/);
  f.shortcut = { TargetPath: path.join(f.root,'foreign','ASS.exe') };
  assert.throws(() => executeInstall(f.ctx, { keepRunning:true }), /foreign/);
  f.shortcut = null; f.osApi.processProbe = () => { throw Error('CIM unavailable'); };
  assert.throws(() => executeInstall(f.ctx, { keepRunning:true }), /CIM unavailable/);
  assert.equal(f.writes,0);
});

test('a later normal install converges a version-pinned entry after the old process exits', t => {
  const f=fixture(t),old=f.build('0.2.4');f.link(old);
  executeInstall(f.ctx,{keepRunning:true});executeInstall(f.ctx);
  assert.equal(f.shortcut.targetPath,path.join(f.ctx.current,'ASS.exe'));
  assert.equal(fs.realpathSync(f.ctx.current),fs.realpathSync(f.target));assert.ok(fs.existsSync(old));
  const {windowsBrandSpec}=require('../scripts/local-release.cjs');
  assert.equal(windowsBrandSpec(f.ctx,{keepRunning:true}).Executable,path.join(f.target,'ASS.exe'));
});

test("unrelated running ASS does not block and current running package is not pruned", t => {
  const f = fixture(t);
  f.link(f.target);
  f.processes = [{ Id: 99, ExecutablePath: path.join(f.target, "ASS.exe") }];
  executeInstall(f.ctx, { prune: true });
  f.processes = [{ Id: 100, ExecutablePath: path.join(f.root, "unrelated", "ASS.exe") }];
  executeInstall(f.ctx, { prune: true });
  assert.ok(fs.existsSync(f.target));
});

test("pre-package guard is read-only, blocks overwrite including current alias, and allows first build", t => {
  const f = fixture(t);
  f.link(f.target);
  const before = snapshot(f.root);
  for (const executable of [path.join(f.target, "ASS.exe"), path.join(f.ctx.current, "ASS.exe")]) {
    f.processes = [{ Id: 42, ExecutablePath: executable }];
    assert.throws(() => prePackageGuard(f.options), /running/);
  }
  assert.deepEqual(snapshot(f.root), before);
  f.processes = [];
  fs.unlinkSync(f.ctx.current);
  fs.rmSync(f.ctx.releaseRoot, { recursive: true });
  assert.equal(prePackageGuard(f.options).guarded, true);
  assert.ok(!fs.existsSync(f.ctx.releaseRoot));
});

test("shortcut failure restores previous junction and leaves all old packages", t => {
  const f = fixture(t), old = f.build("0.2.4");
  f.link(old);
  f.osApi.writeShortcut = () => { throw new Error("shortcut write failed"); };
  assert.throws(() => executeInstall(f.ctx, { prune: true }), /shortcut write failed/);
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(old));
  assert.ok(fs.existsSync(old));
});

test("prune failure retains committed new junction and shortcut", t => {
  const f = fixture(t), old = f.build("0.2.4");
  f.link(old);
  f.build("0.2.5");
  let calls = 0;
  f.osApi.removeTree = dir => { if (++calls === 2) throw new Error("prune locked"); fs.rmSync(dir, { recursive: true }); };
  assert.throws(() => executeInstall(f.ctx, { prune: true }), /prune locked/);
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(f.target));
  assert.equal(f.shortcut.targetPath, path.join(f.ctx.current, "ASS.exe"));
  assert.ok(fs.existsSync(f.shortcut.targetPath));
});

test("unknown files or new processes added during shortcut write block deletion", t => {
  const f = fixture(t), old = f.build("0.2.4"), writer = f.osApi.writeShortcut;
  f.osApi.writeShortcut = spec => { writer(spec); fs.writeFileSync(path.join(old, "private.json"), "keep"); };
  assert.throws(() => executeInstall(f.ctx, { prune: true }), /unknown package file/);
  assert.ok(fs.existsSync(path.join(old, "private.json")));
  fs.unlinkSync(path.join(old, "private.json"));
  f.shortcut = null;
  f.osApi.writeShortcut = spec => { writer(spec); f.processes = [{ Id: 77, ExecutablePath: path.join(old, "ASS.exe") }]; };
  assert.throws(() => executeInstall(f.ctx, { prune: true }), /running/);
  assert.ok(fs.existsSync(old));
});

test("probe errors block install instead of being interpreted as no processes", t => {
  const f = fixture(t);
  f.osApi.processProbe = () => { throw new Error("CIM unavailable"); };
  assert.throws(() => executeInstall(f.ctx), /CIM unavailable/);
  assert.equal(f.writes, 0);
});

test("Windows COM writes and reads a stable shortcut only in the fixture", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  delete f.osApi.shortcutProbe;
  delete f.osApi.writeShortcut;
  const first = executeInstall(f.ctx);
  assert.equal(first.installed, true);
  assert.equal(buildPlan(f.ctx).shortcut.existing.AppUserModelId, "local.ass.desktop");
  const bytes = fs.readFileSync(f.ctx.shortcut);
  executeInstall(f.ctx);
  assert.deepEqual(fs.readFileSync(f.ctx.shortcut), bytes);
  assert.equal(fs.realpathSync(f.ctx.current), fs.realpathSync(f.target));
});

test("failed shortcut backup rename preserves the original shortcut", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  delete f.osApi.shortcutProbe;
  delete f.osApi.writeShortcut;
  executeInstall(f.ctx);
  const bytes = fs.readFileSync(f.ctx.shortcut);
  const reader = buildPlan(f.ctx).shortcut.existing;
  f.osApi.shortcutProbe = () => ({ ...reader, WorkingDirectory: "" });
  f.ctx.fsApi = { ...fs, renameSync: (from, to) => {
    if (from === f.ctx.shortcut) throw new Error("backup rename denied");
    return fs.renameSync(from, to);
  } };
  assert.throws(() => executeInstall(f.ctx), /backup rename denied/);
  assert.deepEqual(fs.readFileSync(f.ctx.shortcut), bytes);
  assert.ok(fs.existsSync(path.join(f.ctx.current, "ASS.exe")));
});

test("invalid current metadata or missing resources fails before mutation", t => {
  const f = fixture(t);
  f.write("release/v0.2.6/ASS-win32-x64/resources/app.asar", JSON.stringify({ name: "foreign", version: "0.2.6" }));
  assert.throws(() => executeInstall(f.ctx), /untrusted/);
  f.build("0.2.6");
  fs.unlinkSync(path.join(f.target, "ffmpeg.dll"));
  assert.throws(() => executeInstall(f.ctx), /incomplete/);
  assert.equal(f.writes, 0);
});
