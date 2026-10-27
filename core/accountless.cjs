const path = require("node:path");
const { execFile } = require("node:child_process");
const CLAUDE_MODEL_ENV = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_AUTO_MODE_MODEL"];
function claudeModelEnv(providers, selected, review = selected) {
  const rows = require('./claude-models.cjs').claudeModels(providers);
  const cliModel = value => rows.find(row => row.model === value || row.cliModel === value)?.cliModel || value;
  selected = cliModel(selected); review = cliModel(review);
  return { ...Object.fromEntries(CLAUDE_MODEL_ENV.map(key => [key, selected])),
    // Current CLI releases select the classifier through the Sonnet alias;
    // 2.1.302+ also reads the dedicated override. Keep both on the same route.
    ANTHROPIC_DEFAULT_SONNET_MODEL: review, CLAUDE_CODE_AUTO_MODE_MODEL: review,
    CLAUDE_CODE_AUTO_MODE_SERVER: "0" };
}
function claudeVersionCommand(launcher, platform = process.platform) {
  if (!launcher?.ready || !path.isAbsolute(launcher.executable || "") ||
      !Array.isArray(launcher.args) || [launcher.executable, ...launcher.args].some(s => typeof s !== "string" || /[\0\r\n]/.test(s)))
    throw Error("Claude Code 启动入口无效，请在客户端设置中重新选择程序");
  const args = [...launcher.args, "--version"];
  if (platform !== "win32" || !/\.(?:cmd|bat|ps1)$/i.test(launcher.executable))
    return { executable: launcher.executable, args };
  // npm shims are scripts, not PE executables. Use the same literal PowerShell
  // invocation as the interactive launcher, without opening a terminal window.
  // Do not enable shell:true or interpolate paths into an unquoted command.
  const q = s => "'" + s.replace(/'/g, "''") + "'";
  const script = "$ErrorActionPreference = 'Stop'\n" +
    `& ${q(launcher.executable)} ${args.map(q).join(" ")}\n` +
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n";
  return {
    executable: path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
async function assertClaudePicker(launcher) {
  const command = claudeVersionCommand(launcher);
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      const child = execFile(command.executable, command.args, { windowsHide: true, timeout: 8000, maxBuffer: 8192 },
        (error, output) => error ? reject(error) : resolve(output));
      child.stdin?.end();
    });
  } catch (error) {
    const reason = error.killed ? "检测超时" : ["ENOENT", "EACCES", "EINVAL", "EPERM"].includes(error.code) ? error.code : "启动失败";
    throw Error(`无法确认 Claude Code 版本（${reason}），请在终端检查 claude --version，或在客户端设置中重新选择启动入口`, { cause: error });
  }
  const version = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.slice(1).map(Number);
  if (!version) throw Error("Claude Code 未返回可识别的版本号，请在客户端设置中确认启动入口");
  if (version[0] < 2 || (version[0] === 2 && (version[1] < 1 || (version[1] === 1 && version[2] < 242))))
    throw Error("仅显示注入模型需要 Claude Code 2.1.242 或更高版本，请先升级客户端");
}

function claudeModelSettings(providers, selected) {
  const rows = require("./claude-models.cjs").claudeModels(providers);
  const options = rows.map(({ model, cliModel, label, description }) => ({ model: cliModel,
    label: label + (cliModel !== model ? ' [1m]' : ''), description }));
  const entry = rows.find(m => m.model === selected || m.cliModel === selected);
  if (!entry) throw Error("启动模型不在已注入的模型列表中");
  return {
    model: entry.cliModel,
    availableModels: options.map((m) => m.model),
    enforceAvailableModels: true,
    // Older CC releases use the allowlist plus gateway discovery. v2.1.242+
    // additionally supports an explicitly ordered picker without built-in rows.
    modelPicker: { options, replaceBuiltInOptions: true },
  };
}

function configureClaudeModels(config, providers, selected, dir, review) {
  const settings = claudeModelSettings(providers, selected);
  config.files.push(["settings.json", JSON.stringify(settings, null, 2)]);
  config.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(config.env, claudeModelEnv(providers, selected, review));
  // Never load another project's credential overrides into an API-only home.
  // Managed organizational policy still applies; normal tool approval remains on.
  config.args.push("--setting-sources", "user", "--settings", path.join(dir, "settings.json"));
  return settings.model;
}
function prepareClaudeOnboarding(dir) {
  const { read, edit, atomic } = require("./native-fields.cjs");
  const file = path.join(dir, ".claude.json"), before = read(file);
  // This file is live CC state, not an injected document to remove on disconnect.
  // Keep trust decisions, MCP entries and any later state written by the client.
  const after = edit(before, "json", ["hasCompletedOnboarding"], { exists: true, value: true });
  if (after !== before) atomic(file, after);
}
module.exports = { claudeModelSettings, claudeModelEnv, CLAUDE_MODEL_ENV, configureClaudeModels, assertClaudePicker, prepareClaudeOnboarding, claudeVersionCommand };
