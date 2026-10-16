const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { archiveBuffer } = require("../scripts/desktop-metadata-qa.cjs");
const {
  resolveLauncher,
  discoverLaunchers,
} = require("../core/client-launcher.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (p, value = "") => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), value);
  };
  write("runtime/node.exe");
  return {
    root,
    write,
    env: { PATH: path.join(root, "runtime"), USERPROFILE: root },
  };
}
test("DSH source directory resolves built CLI without changing working directory", (t) => {
  const { root, write, env } = fixture(t);
  write("repo/package.json", '{"name":"@deepseek-ai/dsh-root"}');
  write("repo/apps/cli/package.json", '{"name":"@deepseek-ai/dsh"}');
  write("repo/apps/cli/lib/bin.js");
  const source = path.join(root, "repo"),
    result = resolveLauncher("dsh", source, env);
  assert.equal(result.ready, true);
  assert.equal(result.kind, "source-built");
  assert.deepEqual(result.args, [path.join(source, "apps/cli/lib/bin.js")]);
  assert.equal(result.cwd, undefined);
  assert.equal(fs.existsSync(path.join(source, "dsh-ass.cmd")), false);
  assert.equal(discoverLaunchers("dsh", env, [source, source]).length, 1);
});

test("Codex Store desktop and CLI are discovered separately, latest installed desktop first", (t) => {
  const { root, write, env } = fixture(t);
  write("runtime/codex.cmd");
  const packages = ["26.1012.1.0", "26.1013.3656.0"].map(version =>
    "programs/WindowsApps/OpenAI.Codex_" + version + "_x64__2p2nqsd0c76g0");
  for (const relative of packages) {
    write(relative + "/app/ChatGPT.exe");
    write(relative + "/app/Codex.exe", "synthetic activation trampoline");
    const pkg = Buffer.from('{"name":"openai-codex-electron","productName":"Codex"}');
    write(relative + "/app/resources/app.asar", archiveBuffer({ files: { "package.json": { size: pkg.length, offset: "0" } } }, pkg));
  }
  const candidates = discoverLaunchers("codex", { ...env, ProgramFiles: path.join(root, "programs") });
  assert.equal(candidates.filter(c => c.ready).length, 1);
  const desktops = candidates.filter(c => c.kind === "desktop");
  assert.equal(desktops.length, 2);
  assert.equal(desktops[0].desktopExecutable, path.join(root, packages[1], "app/ChatGPT.exe"));
  assert.equal(desktops[0].installed, true);
  assert.equal(desktops[0].ready, false);
  assert.equal(desktops[0].executable, "");
  assert.equal(resolveLauncher("codex", path.join(root, packages[1]), env).kind, "desktop");
  assert.equal(resolveLauncher("codex", path.join(root, packages[1], "app/Codex.exe"), env).desktopExecutable, desktops[0].desktopExecutable);
  fs.unlinkSync(desktops[0].desktopExecutable);
  assert.equal(discoverLaunchers("codex", env, [desktops[0].desktopExecutable]).length, 0);
});

test("Codex desktop discovery requires product metadata, not a renamed CLI or unrelated Electron app", (t) => {
  const { root, write, env } = fixture(t);
  write("cli/codex.exe");
  assert.equal(resolveLauncher("codex", path.join(root, "cli/codex.exe"), env).kind, "executable");
  write("other/ChatGPT.exe");
  write("other/resources/app/package.json", '{"name":"another-electron-app","productName":"Codex"}');
  assert.notEqual(resolveLauncher("codex", path.join(root, "other/ChatGPT.exe"), env).kind, "desktop");
  write("desktop/ChatGPT.exe");
  write("desktop/Codex.exe");
  write("desktop/resources/app/package.json", '{"name":"openai-codex-electron"}');
  assert.equal(resolveLauncher("codex", path.join(root, "desktop/Codex.exe"), env).kind, "desktop");
  assert.equal(resolveLauncher("codex", path.join(root, "desktop"), env).kind, "desktop");
  assert.equal(discoverLaunchers("codex",env,[path.join(root,"desktop/ChatGPT.exe"),path.join(root,"desktop/Codex.exe"),path.join(root,"desktop")]).length,1);
  fs.unlinkSync(path.join(root,"desktop/ChatGPT.exe"));
  const broken=resolveLauncher("codex",path.join(root,"desktop/Codex.exe"),env);
  assert.notEqual(broken.kind,"desktop");assert.equal(broken.ready,false);
  assert.match(broken.message,/缺少 ChatGPT.exe/);
  assert.equal(discoverLaunchers("codex",env,[path.join(root,"desktop/Codex.exe")]).length,0);
});
test("source recognition reports missing dependencies and Node without executing package scripts", (t) => {
  const { root, write, env } = fixture(t);
  write(
    "repo/package.json",
    '{"name":"@deepseek-ai/dsh-root","scripts":{"dsh":"untrusted-command"}}',
  );
  write("repo/apps/cli/package.json", '{"name":"@deepseek-ai/dsh"}');
  assert.match(
    resolveLauncher("dsh", path.join(root, "repo"), env).message,
    /构建产物/,
  );
  write("repo/apps/cli/lib/bin.js");
  assert.match(
    resolveLauncher("dsh", path.join(root, "repo"), {
      PATH: "",
      USERPROFILE: root,
    }).message,
    /Node.js/,
  );
});
test("npm directories, executable paths and script entries remain compatible", (t) => {
  const { root, write, env } = fixture(t);
  write(
    "npm/package.json",
    '{"name":"@mariozechner/pi-coding-agent","bin":{"pi":"dist/cli.js"}}',
  );
  write("npm/dist/cli.js");
  write("dsh.cmd");
  assert.equal(
    resolveLauncher("pi", path.join(root, "npm"), env).kind,
    "npm-package",
  );
  assert.equal(
    resolveLauncher("dsh", path.join(root, "dsh.cmd"), env).kind,
    "executable",
  );
  assert.equal(
    resolveLauncher("pi", path.join(root, "npm/dist/cli.js"), env).kind,
    "node",
  );
  assert.equal(resolveLauncher("pi", "relative-path", env).ready, false);
});
test("ZCode npm launcher preserves only a trusted package version", (t) => {
  const { root, write, env } = fixture(t);
  write(
    "zcode/package.json",
    '{"name":"@zcode/cli","version":"3.14.0","bin":{"zcode":"dist/cli.js"}}',
  );
  write("zcode/dist/cli.js");
  const directory = path.join(root, "zcode");
  assert.equal(resolveLauncher("zcode", directory, env).version, "3.14.0");
  write(
    "zcode/package.json",
    '{"name":"@zcode/cli","version":"not-a-version","bin":{"zcode":"dist/cli.js"}}',
  );
  assert.equal(resolveLauncher("zcode", directory, env).version, undefined);
});
test("ambiguous installations are returned separately and package bin cannot escape directory", (t) => {
  const { root, write, env } = fixture(t);
  write("one/dsh.cmd");
  write("two/dsh.cmd");
  assert.equal(
    discoverLaunchers("dsh", env, [
      path.join(root, "one"),
      path.join(root, "two"),
    ]).length,
    2,
  );
  write(
    "bad/package.json",
    '{"name":"@deepseek-ai/dsh","bin":{"dsh":"../outside.js"}}',
  );
  write("outside.js");
  assert.match(
    resolveLauncher("dsh", path.join(root, "bad"), env).message,
    /超出/,
  );
});

test("Claude Store and per-user desktop installations stay distinct from the CLI", (t) => {
  const { root, write, env } = fixture(t);
  const store = "programs/WindowsApps/Claude_2.9939.2.0_x64__pzs8sxrjxfjjc/app";
  const user = "local/AnthropicClaude/app-2.9.0";
  write("runtime/claude.cmd");
  for (const dir of [store, user]) {
    write(dir + "/claude.exe");
    write(dir + "/resources/app.asar");
  }
  const candidates = discoverLaunchers("claude", {
    ...env, ProgramFiles: path.join(root, "programs"), LOCALAPPDATA: path.join(root, "local"),
  });
  assert.equal(candidates.filter(c => c.ready).length, 1);
  const desktops = candidates.filter(c => c.kind === "desktop");
  assert.equal(desktops.length, 2);
  for (const c of desktops) {
    assert.equal(c.installed, true);
    assert.equal(c.ready, false);
    assert.equal(c.executable, "");
    assert.equal(resolveLauncher("claude", path.dirname(c.desktopExecutable), env).kind, "desktop");
  }
});

test("OpenCode Desktop outside PATH is detected without being treated as a CLI", (t) => {
  const { root, write, env } = fixture(t);
  const relative = "local/Programs/@opencode-aidesktop";
  write(relative + "/OpenCode.exe");
  write(relative + "/resources/app.asar");
  const desktop = path.join(root, relative, "OpenCode.exe");
  const candidates = discoverLaunchers("opencode", {
    ...env, LOCALAPPDATA: path.join(root, "local"),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "desktop");
  assert.equal(candidates[0].installed, true);
  assert.equal(candidates[0].ready, false);
  assert.equal(candidates[0].executable, "");
  assert.equal(candidates[0].desktopExecutable, desktop);
  assert.equal(resolveLauncher("opencode", path.dirname(desktop), env).kind, "desktop");
  assert.match(candidates[0].message, /OpenCode CLI/);
});

test("OpenCode Desktop and CLI remain distinct, with supported bundled CLI detection", (t) => {
  const { root, write, env } = fixture(t);
  write("runtime/opencode.exe");
  write("local/Programs/OpenCode/OpenCode.exe");
  write("local/Programs/OpenCode/resources/app.asar");
  write("local/Programs/OpenCode/resources/opencode-cli.exe");
  const candidates = discoverLaunchers("opencode", {
    ...env, LOCALAPPDATA: path.join(root, "local"),
  });
  assert.equal(candidates.filter(c => c.ready).length, 2);
  assert.equal(candidates.filter(c => c.kind === "desktop").length, 1);
  const directory = resolveLauncher("opencode", path.join(root, "local/Programs/OpenCode"), env);
  assert.equal(directory.kind, "desktop-cli");
  assert.equal(directory.ready, true);
  assert.match(directory.executable, /opencode-cli\.exe$/);
});

test("OpenCode desktop detection skips stale paths and does not confuse standalone CLI", (t) => {
  const { root, write, env } = fixture(t);
  write("local/Programs/@opencode-aidesktop/resources/app.asar");
  assert.equal(discoverLaunchers("opencode", { ...env, LOCALAPPDATA: path.join(root, "local") }).length, 0);
  write("runtime/opencode.exe");
  assert.equal(resolveLauncher("opencode", path.join(root, "runtime/opencode.exe"), env).kind, "executable");
  assert.equal(discoverLaunchers("opencode", env).length, 1);
});

test("OpenCode loose app.asar directory metadata is recognized", (t) => {
  const { root, write, env } = fixture(t);
  write("desktop/OpenCode.exe");
  write("desktop/resources/app.asar/package.json", JSON.stringify({name:"@opencode-ai/desktop"}));
  assert.equal(resolveLauncher("opencode", path.join(root,"desktop/OpenCode.exe"),env).kind,"desktop");
});

test("loose app.asar keeps opaque Claude product names out of CLI discovery", (t) => {
  const { root, write, env } = fixture(t);
  write("runtime/claude.cmd");
  const relative = "programs/WindowsApps/Claude_2.9939.2.0_x64__pzs8sxrjxfjjc/app";
  write(relative + "/claude.exe");
  write(relative + "/resources/app.asar/package.json", JSON.stringify({ name: "desktop-shell", productName: "Claude" }));
  const candidates = discoverLaunchers("claude", { ...env, ProgramFiles: path.join(root, "programs") });
  assert.equal(candidates.length, 2);
  assert.equal(candidates.filter(c => c.ready).length, 1);
  assert.equal(candidates.find(c => c.kind === "desktop").desktopExecutable, path.join(root, relative, "claude.exe"));
});

test("Antigravity Hub, IDE and CLI are distinct install candidates outside PATH", (t) => {
  const { root, write, env } = fixture(t);
  const hub = "local/Programs/Antigravity", ide = "local/Programs/Antigravity IDE";
  write(hub + "/Antigravity.exe");
  write(hub + "/resources/app.asar/package.json", JSON.stringify({ name: "antigravity", productName: "Antigravity", version: "2.16.0" }));
  write(ide + "/Antigravity IDE.exe");
  write(ide + "/resources/app/product.json", JSON.stringify({ nameShort: "Antigravity IDE", applicationName: "antigravity-ide" }));
  write("local/agy/bin/agy.exe");
  const candidates = discoverLaunchers("antigravity", { ...env, LOCALAPPDATA: path.join(root, "local") });
  assert.equal(candidates.length, 3);
  assert.equal(candidates.filter((c) => c.ready).length, 1);
  assert.deepEqual(candidates.filter((c) => c.kind === "desktop").map((c) => c.nativeVariant), ["desktop", "ide"]);
  assert.equal(candidates.find((c) => c.nativeVariant === "desktop").version, "2.16.0");
  for (const c of candidates.filter((c) => c.kind === "desktop")) {
    assert.equal(c.ready, false); assert.equal(c.executable, ""); assert.equal(c.installed, true);
    assert.equal(resolveLauncher("antigravity", path.dirname(c.desktopExecutable), env).kind, "desktop");
  }
});

test("a renamed or metadata-less Antigravity EXE is not treated as a desktop or CLI install", (t) => {
  const { root, write, env } = fixture(t);
  write("other/Antigravity.exe");
  write("other/resources/app/package.json", JSON.stringify({ name: "another-app", productName: "Other" }));
  assert.equal(resolveLauncher("antigravity", path.join(root, "other/Antigravity.exe"), env).kind, "missing");
  write("other/resources/app/package.json", "null");
  write("other/resources/app/product.json", "null");
  assert.equal(resolveLauncher("antigravity", path.join(root, "other/Antigravity.exe"), env).kind, "missing");
});

test("packed desktop archives retain launcher recognition in plain Node", (t) => {
  const { root, write, env } = fixture(t);
  for (const [harness, executable, manifest] of [
    ["opencode", "OpenCode.exe", { name: "@opencode-ai/desktop" }],
    ["claude", "claude.exe", { name: "opaque-desktop-shell" }],
    ["zcode", "ZCode Preview.exe", { name: "@zcode/desktop" }],
    ["antigravity", "Antigravity.exe", { name: "antigravity", productName: "Antigravity", version: "2.16.0" }],
  ]) {
    const pkg = Buffer.from(JSON.stringify(manifest));
    write(harness + "/" + executable);
    write(harness + "/resources/app.asar", archiveBuffer({ files: { "package.json": { size: pkg.length, offset: "0" } } }, pkg));
    const selected = path.join(root, harness, executable);
    assert.equal(resolveLauncher(harness, selected, env).kind, "desktop");
    assert.equal(resolveLauncher(harness, path.dirname(selected), env).kind, "desktop");
    assert.equal(discoverLaunchers(harness, env, [selected, selected]).length, 1);
    if (harness === "antigravity") assert.equal(resolveLauncher(harness, selected, env).version, "2.16.0");
  }
});

test("packed metadata must identify Antigravity; unpackaged OpenCode still resolves", (t) => {
  const { root, write, env } = fixture(t);
  write("wrong/Antigravity.exe");
  const pkg = Buffer.from('{"name":"another-app","productName":"Antigravity"}');
  write("wrong/resources/app.asar", archiveBuffer({ files: { "package.json": { size: pkg.length, offset: "0" } } }, pkg));
  assert.equal(resolveLauncher("antigravity", path.join(root, "wrong/Antigravity.exe"), env).kind, "missing");
  write("loose/OpenCode.exe");
  write("loose/resources/app/package.json", '{"name":"@opencode-ai/desktop"}');
  assert.equal(resolveLauncher("opencode", path.join(root, "loose/OpenCode.exe"), env).kind, "desktop");
});

test("CLI package detection retains support for linked package directories", (t) => {
  const { root, write, env } = fixture(t);
  write("actual/package.json", '{"name":"@deepseek-ai/dsh","bin":{"dsh":"bin.js"}}');
  write("actual/bin.js");
  const linked = path.join(root, "linked");
  fs.symlinkSync(path.join(root, "actual"), linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal(resolveLauncher("dsh", linked, env).kind, "npm-package");
});
