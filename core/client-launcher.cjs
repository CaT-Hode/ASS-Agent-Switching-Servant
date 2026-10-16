// Detection probes external installations; even stat(app.asar) must bypass
// Electron's native ASAR cache so ASS cannot hold an updater's archive open.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { readDesktopJson } = require("./desktop-metadata.cjs");

const PACKAGES = {
  codex: ["@openai/codex"],
  claude: ["@anthropic-ai/claude-code"],
  opencode: ["@opencode/cli", "opencode-ai"],
  pi: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
  dsh: ["@deepseek-ai/dsh"],
  kimi: ["@moonshot-ai/kimi-code"],
  zcode: ["@zcode/cli"],
  antigravity: [],
};
const COMMANDS = { antigravity: "agy" };
const trustedVersion = (value) =>
  typeof value === "string" &&
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
    ? value
    : null;
function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
function directories(root, pattern) {
  if (!root) return [];
  try { return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && pattern.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map(e => path.join(root, e.name)); } catch { return []; }
}
function json(file) {
  try {
    const info = stat(file);
    if (!info?.isFile() || info.size > 512 * 1024) return {};
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function hasElectronArchive(directory) {
  const archive = path.join(directory, "resources", "app.asar");
  const info = stat(archive);
  // original-fs sees a real archive file (or a real development directory).
  // Product package names are private details (Claude's need not be "claude").
  return !!(info?.isFile() || (info?.isDirectory() && stat(path.join(archive, "package.json"))?.isFile()));
}
function findExecutable(name, env = process.env) {
  const dirs = (env.Path || env.PATH || "")
    .split(path.delimiter)
    .map((s) => s.replace(/^"|"$/g, ""));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  dirs.push(path.join(env.USERPROFILE || os.homedir(), ".local", "bin"));
  for (const dir of dirs.filter(Boolean))
    for (const ext of [".exe", ".cmd", ".ps1"])
      if (stat(path.join(dir, name + ext))?.isFile())
        return path.resolve(dir, name + ext);
  return "";
}
function resolveLauncher(harness, selectedPath, env = process.env) {
  const location = selectedPath ? path.resolve(selectedPath) : "";
  const fail = (message) => ({
    ready: false,
    location,
    executable: "",
    args: [],
    kind: "missing",
    message,
    command: "",
  });
  const launch = (
    executable,
    args,
    kind,
    message,
    entryPoint = executable,
  ) => ({
    ready: true,
    location,
    executable,
    args,
    kind,
    message,
    entryPoint,
    command: [executable, ...args].map((s) => JSON.stringify(s)).join(" "),
  });
  const nodeEntry = (entry, kind, message, loader) => {
    const node = findExecutable("node", env);
    if (!node)
      return fail("已找到入口，但未找到 Node.js；请安装 Node.js 24+ 后刷新");
    return launch(
      node,
      [...(loader ? ["--import", pathToFileURL(loader).href] : []), entry],
      kind,
      message,
      entry,
    );
  };
  if (!PACKAGES[harness]) return fail("未知客户端");
  if (!selectedPath) return fail("未检测到安装；可选择程序或源码目录");
  if (!path.isAbsolute(selectedPath)) return fail("请选择绝对路径");
  const info = stat(location);
  if (!info) return fail("原路径已不存在，请重新选择程序或目录");
  // Electron Desktop is not the CLI: it ignores auth/model arguments and uses
  // a shared application profile. Detect it without launching it or injecting
  // account-specific settings into the user's existing desktop instance.
  if (harness === "codex") {
    const candidates = info.isDirectory()
      ? [location, path.join(location, "app")].flatMap(dir =>
        ["ChatGPT.exe", "Codex.exe"].map(name => path.join(dir, name)))
      : [location];
    for (const desktop of candidates) {
      if (!/^(?:ChatGPT|Codex)\.exe$/i.test(path.basename(desktop)) || !stat(desktop)?.isFile()) continue;
      const root = path.dirname(desktop);
      const manifests = ["resources/app.asar/package.json", "resources/app/package.json"]
        .map(relative => readDesktopJson(path.join(root, relative)));
      if (manifests.some(manifest => manifest.name === "openai-codex-electron")) {
        // Codex.exe is an update/activation trampoline, not the Electron main.
        // Both selections resolve to one desktop; never fall back to the helper.
        const primary = path.join(root, "ChatGPT.exe");
        if (!stat(primary)?.isFile()) return { ...fail("Codex 安装缺少 ChatGPT.exe；不能使用 Codex.exe 更新跳板启动，请修复安装后重新识别"), installed: true };
        return { ...fail("已安装 Codex 桌面端；命令行账户操作需要 Codex CLI"),
          installed: true, kind: "desktop", desktopExecutable: primary };
      }
    }
  }
  if (harness === "claude") {
    const desktop = info.isDirectory() ? path.join(location, "claude.exe") : location;
    if (/^claude\.exe$/i.test(path.basename(desktop)) && stat(desktop)?.isFile() &&
        (hasElectronArchive(path.dirname(desktop)) ||
          /claude/i.test(readDesktopJson(path.join(path.dirname(desktop), "resources/app.asar/package.json")).name || "") ||
          /claude/i.test(readDesktopJson(path.join(path.dirname(desktop), "resources/app/package.json")).name || "")))
      return { ...fail("Claude 桌面版 · 通过 Gateway 接入；终端启动请使用 Claude Code CLI"), installed: true,
        kind: "desktop", desktopExecutable: desktop };
  }
  if (harness === "antigravity") {
    const files = info.isDirectory() ? ["Antigravity.exe", "Antigravity IDE.exe"].map((name) => path.join(location, name)) : [location];
    for (const desktop of files) {
      if (!stat(desktop)?.isFile() || !/^antigravity(?: ide)?\.exe$/i.test(path.basename(desktop))) continue;
      const root = path.dirname(desktop);
      // A renamed EXE or an arbitrary Electron app is not evidence of an
      // Antigravity install. Read bounded metadata without Electron's ASAR cache.
      const manifest = ["resources/app.asar/package.json", "resources/app/package.json"].map((f) => readDesktopJson(path.join(root, f)))
        .find((p) => p.name === "antigravity" && p.productName === "Antigravity");
      const product = readDesktopJson(path.join(root, "resources/app/product.json"));
      const ide = [product.nameShort, product.nameLong].some((name) => ["Antigravity", "Antigravity IDE"].includes(name)) &&
        ["antigravity", "antigravity-ide"].includes(product.applicationName);
      if (!manifest && !ide) return fail("未找到 Antigravity 产品元数据，请选择实际安装目录");
      const variant = manifest ? "desktop" : "ide";
      const version = manifest?.version || readDesktopJson(path.join(root, "resources/app/package.json")).version;
      return { ...fail(variant === "ide" ? "Antigravity IDE · 原生账户" : "Antigravity 2.0 · 原生账户"),
        installed: true, kind: "desktop", desktopExecutable: desktop, nativeVariant: variant,
        ...(typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? { version } : {}) };
    }
  }
  if (harness === "zcode") {
    const desktop = info.isDirectory() ? ["ZCode.exe", "ZCode Preview.exe"].map((name) => path.join(location, name))
      .find((file) => stat(file)?.isFile()) : location;
    if (desktop && /^zcode(?: preview)?\.exe$/i.test(path.basename(desktop)) &&
        (hasElectronArchive(path.dirname(desktop)) ||
          readDesktopJson(path.join(path.dirname(desktop), "resources/app.asar/package.json")).name === "@zcode/desktop" ||
          readDesktopJson(path.join(path.dirname(desktop), "resources/app/package.json")).name === "@zcode/desktop"))
      return { ...fail("已安装 ZCode Desktop · 使用原生账户与配置"), installed: true, kind: "desktop", desktopExecutable: desktop };
  }
  if (harness === "opencode") {
    const desktop = info.isDirectory()
      ? path.join(location, "OpenCode.exe")
      : location;
    if (
      path.basename(desktop).toLowerCase() === "opencode.exe" &&
      stat(desktop)?.isFile() &&
      (hasElectronArchive(path.dirname(desktop)) ||
        // Both packed ASAR and loose desktop metadata are supported.
        readDesktopJson(path.join(path.dirname(desktop), "resources", "app.asar", "package.json")).name === "@opencode-ai/desktop" ||
        readDesktopJson(path.join(path.dirname(desktop), "resources", "app", "package.json")).name === "@opencode-ai/desktop")
    ) {
      const bundledCli = path.join(path.dirname(desktop), "resources", "opencode-cli.exe");
      if (info.isDirectory() && stat(bundledCli)?.isFile())
        return launch(bundledCli, [], "desktop-cli", "OpenCode Desktop · 随附 CLI");
      return {
        ...fail("已安装 OpenCode Desktop；独立账户与路由接入需要 OpenCode CLI"),
        installed: true,
        kind: "desktop",
        desktopExecutable: desktop,
      };
    }
  }
  if (info.isFile()) {
    const ext = path.extname(location).toLowerCase();
    if ([".exe", ".cmd", ".ps1"].includes(ext))
      return launch(location, [], "executable", "可执行文件");
    if ([".js", ".mjs", ".cjs"].includes(ext))
      return nodeEntry(location, "node", "Node.js 入口");
    return fail("请选择 exe / cmd / ps1 / js 文件，或客户端目录");
  }
  if (!info.isDirectory()) return fail("所选位置不是文件或目录");
  const manifest = json(path.join(location, "package.json"));
  if (harness === "dsh" && manifest.name === "@deepseek-ai/dsh-root") {
    const cliDir = path.join(location, "apps", "cli");
    if (json(path.join(cliDir, "package.json")).name !== "@deepseek-ai/dsh")
      return fail("DSH 源码缺少 apps/cli/package.json");
    const built = path.join(cliDir, "lib", "bin.js");
    if (stat(built)?.isFile())
      return nodeEntry(built, "source-built", "DSH 源码目录 · 已构建 CLI");
    const source = path.join(cliDir, "src", "bin.ts");
    if (stat(source)?.isFile()) {
      try {
        const loader = createRequire(source).resolve("tsx/esm");
        if (stat(loader)?.isFile())
          return nodeEntry(
            source,
            "source-tsx",
            "DSH 源码目录 · 本地 tsx 入口",
            loader,
          );
      } catch {}
    }
    return fail(
      "已识别 DSH 源码，但未找到构建产物或本地 tsx；请先按项目说明安装依赖并构建",
    );
  }
  if (PACKAGES[harness].includes(manifest.name)) {
    const bin =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[COMMANDS[harness] || harness];
    if (typeof bin !== "string")
      return fail("已识别客户端包，但没有对应的 bin 入口");
    const entry = path.resolve(location, bin);
    if (!entry.startsWith(location + path.sep))
      return fail("客户端 bin 入口超出所选目录，已拒绝");
    if (!stat(entry)?.isFile())
      return fail("客户端 bin 入口不存在，请先完成安装或构建");
    let nativeBinary = false;
    try {
      const fd = fs.openSync(entry, 'r'), bytes = Buffer.alloc(4);
      try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
      nativeBinary = bytes.subarray(0, 2).toString() === 'MZ' || bytes.toString('hex') === '7f454c46' || ['cffaedfe', 'feedfacf', 'cafebabe'].includes(bytes.toString('hex'));
    } catch {}
    if (nativeBinary) {
      const result = launch(entry, [], 'npm-package', 'npm 客户端包入口');
      return { ...result, ...(trustedVersion(manifest.version) ? { version: manifest.version } : {}) };
    }
    if (path.extname(entry).toLowerCase() === '.exe') return fail('原生客户端安装未完成；请完成官方包的安装步骤后刷新');
    if (
      [".js", ".mjs", ".cjs"].includes(path.extname(entry).toLowerCase()) ||
      !path.extname(entry)
    ) {
      const result = nodeEntry(entry, "npm-package", "npm 客户端包入口");
      const packageVersion = trustedVersion(manifest.version);
      return packageVersion ? { ...result, version: packageVersion } : result;
    }
    return fail("客户端包的 bin 类型尚不支持，请直接选择启动程序");
  }
  for (const relative of ["", "bin", "node_modules/.bin"])
    for (const ext of [".exe", ".cmd", ".ps1"]) {
      const entry = path.join(location, relative, (COMMANDS[harness] || harness) + ext);
      if (stat(entry)?.isFile())
        return launch(entry, [], "directory", "安装目录 · 可执行入口");
    }
  for (const pkg of PACKAGES[harness]) {
    const packageDir = path.join(location, "node_modules", pkg);
    if (stat(path.join(packageDir, "package.json"))?.isFile()) {
      const result = resolveLauncher(harness, packageDir, env);
      return { ...result, location };
    }
  }
  return fail("此目录中未识别到该客户端；请选择安装根目录或受支持的源码根目录");
}
function searchLocations(harness, env = process.env) {
  const home = env.USERPROFILE || os.homedir();
  const locations = [findExecutable(COMMANDS[harness] || harness, env)];
  if (harness === "codex" && env.ProgramFiles) {
    const packageName = /^OpenAI\.Codex_[\d.]+_(?:x64|arm64|x86)__2p2nqsd0c76g0$/i;
    const packages = [];
    // Prefer user registration; directory enumeration is a fallback. Only run
    // during explicit/startup discovery, never from periodic UI snapshots.
    if (process.platform === "win32" && env.ProgramFiles === process.env.ProgramFiles) {
      try {
        const output = execFileSync(
          path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-Command",
            "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation"],
          { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] },
        );
        packages.push(...output.split(/\r?\n/).map(value => value.trim())
          .filter(dir => path.isAbsolute(dir) && packageName.test(path.basename(dir))));
      } catch {}
    }
    // Registration wins over leftover newer package folders after a rollback.
    if (!packages.length) packages.push(...directories(path.join(env.ProgramFiles, "WindowsApps"), packageName));
    for (const dir of packages) locations.push(path.join(dir, "app/ChatGPT.exe"), path.join(dir, "app/Codex.exe"));
  }
  if (harness === "claude") {
    if (env.LOCALAPPDATA) {
      const squirrel = path.join(env.LOCALAPPDATA, "AnthropicClaude");
      locations.push(path.join(squirrel, "claude.exe"), path.join(env.LOCALAPPDATA, "Programs/Claude/claude.exe"),
        ...directories(squirrel, /^app-\d/).map(dir => path.join(dir, "claude.exe")));
    }
    if (env.ProgramFiles) {
      const packageName = /^Claude_[\d.]+_(?:x64|arm64|x86)__pzs8sxrjxfjjc$/i;
      const packages = directories(path.join(env.ProgramFiles, "WindowsApps"), packageName);
      // WindowsApps enumeration may be denied even when the installed app is
      // accessible by its exact path. Query registration only during detection.
      if (!packages.length && process.platform === "win32" && env.ProgramFiles === process.env.ProgramFiles) {
        try {
          const output = execFileSync(
            path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-Command",
              "Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation"],
            { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] },
          );
          packages.push(...output.split(/\r?\n/).map(s => s.trim())
            .filter(dir => path.isAbsolute(dir) && packageName.test(path.basename(dir))));
        } catch {}
      }
      locations.push(path.join(env.ProgramFiles, "Claude/claude.exe"), ...packages.map(dir => path.join(dir, "app/claude.exe")));
    }
  }
  if (harness === "antigravity") {
    if (env.LOCALAPPDATA) locations.push(path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
    for (const root of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean))
      for (const name of ["Antigravity", "Antigravity IDE"])
        locations.push(path.join(root, name, name + ".exe"));
    if (env.ProgramFiles) locations.push(path.join(env.ProgramFiles, "Google/antigravity-cli/agy.exe"));
  }
  if (harness === "zcode") {
    for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean))
      for (const name of ["ZCode", "ZCode Preview"])
        locations.push(path.join(base, name, name + ".exe"));
  }
  if (harness === "opencode") {
    // Windows Desktop installers do not necessarily register a PATH command.
    // Keep this bounded to known install locations; never recursively scan disks.
    const roots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
    ].filter(Boolean);
    for (const root of roots)
      for (const folder of ["@opencode-aidesktop", "OpenCode"])
        locations.push(
          path.join(root, folder, "resources", "opencode-cli.exe"),
          path.join(root, folder, "OpenCode.exe"),
        );
    locations.push(
      path.join(home, ".opencode", "bin", "opencode.exe"),
      path.join(home, ".bun", "bin", "opencode.exe"),
    );
  }
  if (harness === "dsh") {
    const roots = [
      home,
      path.join(home, "source", "repos"),
      path.join(home, "projects"),
      path.join(home, "Documents"),
      path.join(home, "dev"),
    ];
    if (process.platform === "win32")
      roots.push(path.parse(home).root, "D:\\", "E:\\");
    for (const root of roots)
      locations.push(path.join(root, "deepseek-harness"));
  }
  return locations.filter(Boolean);
}
function discoverLaunchers(
  harness,
  env = process.env,
  locations = searchLocations(harness, env),
) {
  const found = [],
    seen = new Set();
  for (const location of locations) {
    const result = resolveLauncher(harness, location, env);
    if (!result.ready && result.kind !== "desktop") continue;
    const identity = JSON.stringify([
      result.desktopExecutable || result.executable,
      result.args,
    ]).toLowerCase();
    if (!seen.has(identity)) {
      seen.add(identity);
      found.push(result);
    }
  }
  return found;
}
module.exports = { findExecutable, resolveLauncher, discoverLaunchers };
