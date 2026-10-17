const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RELAUNCH_FLAG = '--ass-desktop-profile';
const canonical = value => value.replace(/^\\\\\?\\/, '').replaceAll('/', '\\').toLowerCase();

// MSIX descendants can have no package identity and still inherit AppData
// redirection. Check both reads and writes: an existing shadow file may override
// the physical one even when a newly created file goes to the physical profile.
function redirectedProfile(directory, io = fs) {
  const redirected = file => canonical(io.realpathSync.native(file)) !== canonical(file) &&
    /\\packages\\[^\\]+\\localcache\\(?:roaming|local)\\/.test(canonical(io.realpathSync.native(file)));
  for (const file of [directory, path.join(directory, 'Local State'), path.join(directory, 'settings.json')])
    if (io.existsSync(file) && redirected(file)) return true;
  const existed = io.existsSync(directory);
  io.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.ass-location-${randomUUID()}.tmp`);
  try {
    io.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    return redirected(probe);
  } finally {
    if (io.existsSync(probe)) io.unlinkSync(probe);
    if (!existed) try { io.rmdirSync(directory); } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
    }
  }
}

function quoteArg(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

const DESKTOP_LAUNCH = `
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
$window = 0
$desktop = $shell.Windows().FindWindowSW(0, 0, 8, [ref]$window, 1)
if ($null -eq $desktop) { throw 'Windows desktop shell unavailable' }
# Use the existing Explorer desktop's automation object. A new Shell.Application
# object alone launches in the caller's redirected context.
$desktop.Document.Application.ShellExecute($request.executable, $request.arguments, $request.cwd, 'open', 1)
`;

function ensureDesktopProfile({ directory, platform = process.platform,
  explicit = false, executable = process.execPath, args = process.argv.slice(1),
  cwd = process.cwd(), env = process.env, io = fs, run = spawnSync } = {}) {
  if (platform !== 'win32' || explicit || !redirectedProfile(directory, io)) return false;
  if (args.includes(RELAUNCH_FLAG))
    throw Error('Windows 仍将 ASS 数据写入应用副本，已停止启动以保护现有配置。请从开始菜单直接启动 ASS。');
  const command = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = run(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DESKTOP_LAUNCH, 'utf16le').toString('base64')], {
    input: JSON.stringify({ executable, arguments: [...args, RELAUNCH_FLAG].map(quoteArg).join(' '), cwd }),
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8192,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw Error('无法通过 Windows 桌面启动 ASS，已停止使用重定向的数据副本。请从开始菜单直接启动 ASS。');
  return true;
}

module.exports = { ensureDesktopProfile, redirectedProfile, quoteArg, RELAUNCH_FLAG };
