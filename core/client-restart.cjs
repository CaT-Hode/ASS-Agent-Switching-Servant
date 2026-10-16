// Optional desktop restart, scoped to verified installation + process identities.
// Discovery is read-only. No name-only taskkill and no replay of command lines.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { runPowerShell } = require("./client-processes.cjs");
const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableIdentity = ({ apps, targets }) => ({ apps, roots: targets.filter((t) => t.depth === 0) });
const PS_INVENTORY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$apps = @()
if (@($request.ids) -contains 'codex') {
  foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex')) {
    $manifest = Get-AppxPackageManifest -Package $package
    $entry = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' })
    if ($entry.Count -ne 1) { continue }
    $exe = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation ([string]$entry[0].Executable)))
    if (-not $exe.StartsWith($package.InstallLocation + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      $apps += [pscustomobject]@{ id='codex'; name='Codex 桌面端'; exe=$exe; aumid=([string]$package.PackageFamilyName + '!App') }
    }
  }
}
if (@($request.ids) -contains 'opencode' -and $request.opencode -and (Test-Path -LiteralPath $request.opencode -PathType Leaf)) {
  $apps += [pscustomobject]@{ id='opencode'; name='OpenCode Desktop'; exe=[string]$request.opencode; aumid=$null }
}
if (@($request.ids) -contains 'claude' -and $request.claude -and (Test-Path -LiteralPath $request.claude -PathType Leaf)) {
  $apps += [pscustomobject]@{ id='claude'; name='Claude 桌面端'; exe=[string]$request.claude; aumid=$null }
}
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; exe=[string]$_.ExecutablePath; created=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }
})
[pscustomobject]@{ apps=@($apps); rows=@($rows) } | ConvertTo-Json -Depth 5 -Compress
`;
const PS_STOP = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$known = @{}; $handles = @{}
function Matches($row, $target) {
  return ($row -and $row.CreationDate -and
    $row.CreationDate.ToUniversalTime().ToString('o') -eq [string]$target.created -and
    [string]$row.ExecutablePath -eq [string]$target.exe -and [int]$row.ParentProcessId -eq [int]$target.parentPid)
}
try {
  $all = @(Get-CimInstance Win32_Process)
  $map = @{}; foreach ($row in $all) { $map[[string][int]$row.ProcessId] = $row }
  foreach ($t in @($request.targets)) {
    $key = [string][int]$t.pid; $row = $map[$key]
    # A helper may exit normally, but an old PID may never authorize a new process.
    if (-not $row -and [int]$t.depth -gt 0) { continue }
    if (-not (Matches $row $t)) { throw 'identity-changed' }
    $known[$key] = $t
  }
  if (-not @($known.Values | Where-Object { [int]$_.depth -eq 0 }).Count) { throw 'missing-root' }
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  do {
    # Admit only descendants of identities already verified. Pinned process
    # handles stay open until the end, preventing PID reuse during the sweep.
    do {
      $added = $false
      foreach ($row in $all) {
        $key = [string][int]$row.ProcessId; $parent = $known[[string][int]$row.ParentProcessId]
        if ($parent -and -not $known.ContainsKey($key)) {
          if (-not $row.CreationDate -or -not $row.ExecutablePath -or
              $row.CreationDate.ToUniversalTime() -lt [DateTime]::Parse([string]$parent.created).ToUniversalTime() -or
              [int]$parent.depth -ge 64) { throw 'unreadable-child' }
          $known[$key] = [pscustomobject]@{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId;
            exe=[string]$row.ExecutablePath; created=$row.CreationDate.ToUniversalTime().ToString('o'); depth=([int]$parent.depth + 1) }
          $added = $true
        }
      }
    } while ($added)
    # Pin all live identities before terminating any of this pass.
    foreach ($t in @($known.Values)) {
      $key = [string][int]$t.pid
      if ([int]$t.pid -eq [int]$request.ownerPid -or [int]$t.pid -eq $PID) { throw 'owner-in-tree' }
      if ($handles.ContainsKey($key)) { continue }
      $proc = Get-Process -Id ([int]$t.pid) -ErrorAction SilentlyContinue
      if (-not $proc) { $known.Remove($key); continue }
      try { $null = $proc.Handle } catch { $proc.Dispose(); throw 'unreadable-process-handle' }
      $again = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$t.pid)
      if (-not $again) { $proc.Dispose(); $known.Remove($key); continue }
      if (-not (Matches $again $t)) { $proc.Dispose(); throw 'identity-changed' }
      $handles[$key] = $proc
    }
    # Root first: Electron can respawn helpers while its main process is alive.
    foreach ($t in @($known.Values | Sort-Object depth)) {
      $proc = $handles[[string][int]$t.pid]
      if ($proc -and -not $proc.HasExited) {
        try { $proc.Kill() } catch { if (-not $proc.HasExited) { throw } }
      }
    }
    $all = @(Get-CimInstance Win32_Process)
    $remaining = @($all | Where-Object { $known.ContainsKey([string][int]$_.ProcessId) -or $known.ContainsKey([string][int]$_.ParentProcessId) })
    if (-not $remaining.Count) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'still-alive' }
    Start-Sleep -Milliseconds 100
  } while ($true)
  [pscustomobject]@{ stopped=$true } | ConvertTo-Json -Compress
} finally {
  foreach ($proc in $handles.Values) { $proc.Dispose() }
}
`;
const PS_LAUNCH = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($app in @($request.apps)) {
  if ($app.aumid) {
    if ([string]$app.aumid -notmatch '^OpenAI\.Codex_[A-Za-z0-9]+!App$') { throw 'invalid-entry' }
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList @('shell:AppsFolder\' + [string]$app.aumid) -WindowStyle Hidden
  } else {
    # This is the interactive client explicitly selected for relaunch, not a background helper.
    Start-Process -FilePath ([string]$app.exe) -WorkingDirectory (Split-Path -Parent ([string]$app.exe)) -WindowStyle Normal
  }
}
[pscustomobject]@{ launched=$true } | ConvertTo-Json -Compress
`;
class DesktopRestartAdapter {
  async inventory(ids, opencode, claude) { return (await runPowerShell(PS_INVENTORY, { ids, opencode, claude }))[0]; }
  // Desktop trees can contain many helpers; allow bounded identity-checked
  // shutdown without inheriting the short read-only inventory timeout.
  async stop(targets) { return (await runPowerShell(PS_STOP, { targets, ownerPid: process.pid }, 45000))[0]; }
  async launch(apps) { return (await runPowerShell(PS_LAUNCH, { apps }))[0]; }
}
class ClientRestart {
  constructor({ adapter = new DesktopRestartAdapter(), desktop = () => null, processes, ownerPid = process.pid,
    fileInfo = (file) => { const s = fs.statSync(file); if (!s.isFile()) throw Error(); return [s.size, s.mtimeMs]; },
    wait = (ms) => new Promise((r) => setTimeout(r, ms)), launchDesktop } = {}) {
    Object.assign(this, { adapter, desktop, processes, ownerPid, fileInfo, wait, launchDesktop });
    this.stoppedPlans = new WeakSet();
  }
  async capture(ids) {
    const eligible = ids.filter((id) => ["codex", "claude", "opencode"].includes(id));
    if (!eligible.length) return { apps: [], targets: [] };
    const data = await this.adapter.inventory(eligible, eligible.includes("opencode") ? this.desktop("opencode") : null,
      eligible.includes("claude") ? this.desktop("claude") : null);
    if (!data || !Array.isArray(data.apps) || !Array.isArray(data.rows)) throw Error("无法识别客户端进程");
    const byPid = new Map(data.rows.map((r) => [r.pid, r]));
    if (byPid.size !== data.rows.length) throw Error("进程清单不一致");
    const apps = [], targets = new Map();
    for (const app of data.apps) {
      if (!eligible.includes(app.id) || !path.isAbsolute(app.exe) || apps.some((a) => a.id === app.id)) throw Error("客户端安装入口不明确");
      const matches = data.rows.filter((r) => r.exe?.toLowerCase() === app.exe.toLowerCase());
      const roots = matches.filter((r) => !matches.some((p) => p.pid === r.parentPid));
      if (!roots.length) continue;
      apps.push({ ...app, file: this.fileInfo(app.exe) });
      const visit = (row, depth, ancestors = new Set()) => {
        if (ancestors.has(row.pid) || depth > 64 || row.pid === this.ownerPid ||
          !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isFinite(Date.parse(row.created)) || !path.isAbsolute(row.exe))
          throw Error("进程身份无法确认，或此客户端承载 ASS，请手动重启");
        targets.set(row.pid, { pid: row.pid, parentPid: row.parentPid, exe: row.exe, created: row.created, depth });
        for (const child of data.rows.filter((r) => r.parentPid === row.pid)) {
          if (Date.parse(child.created) < Date.parse(row.created)) throw Error("进程身份已变化");
          visit(child, depth + 1, new Set([...ancestors, row.pid]));
        }
      };
      for (const root of roots) visit(root, 0);
    }
    return { apps: apps.sort((a, b) => a.id.localeCompare(b.id)), targets: [...targets.values()].sort((a, b) => a.pid - b.pid) };
  }
  async preview(ids) {
    const applicable = ids.some((id) => ["codex", "claude", "opencode"].includes(id));
    if (!applicable) return { applicable: false, available: false };
    try {
      const value = await this.capture(ids);
      const observed = this.processes?.snapshot() || { sessions: [], error: null };
      const managed = observed.sessions.filter((s) => ids.includes(s.harness) && s.status !== "gone");
      return { applicable, available: value.apps.length > 0, names: value.apps.map((a) => a.name),
        closeAvailable: !observed.error && managed.every((s) => s.status === "running") && (value.apps.length > 0 || managed.length > 0), managed,
        reason: value.apps.length ? "" : managed.length ? "仅可关闭 ASS 启动的窗口，桌面重启不可用。" : "未识别到可操作的运行窗口。", value, fingerprint: fingerprint(stableIdentity(value)), ids };
    } catch { return { applicable, available: false, reason: "进程或安装入口无法可靠确认，请手动重启。" }; }
  }
  public(plan) { return plan && { applicable: plan.applicable, available: plan.available, closeAvailable: !!plan.closeAvailable, names: plan.names || [], reason: plan.reason || "" }; }
  async close(plan) {
    if (!plan?.closeAvailable) throw Error("没有已确认的关闭目标");
    // A desktop opened after a managed-only preview is not an authorized target.
    const fresh = await this.capture(plan.ids);
    if (fingerprint(stableIdentity(fresh)) !== plan.fingerprint) throw Error("客户端主进程已变化，请重新确认关闭");
    await this.processes?.refresh();
    const observed = this.processes?.snapshot() || { sessions: [], error: null };
    const scoped = observed.sessions.filter((s) => plan.ids.includes(s.harness) && s.status !== "gone");
    if (observed.error || fingerprint(scoped) !== fingerprint(plan.managed || [])) throw Error("窗口状态已变化，请重新确认关闭");
    if (plan.available) { await this.stop(plan); this.stoppedPlans.delete(plan); }
    await this.processes?.refresh();
    const remaining = this.processes?.snapshot().sessions.filter((s) => plan.ids.includes(s.harness) && s.status !== "gone") || [];
    if (remaining.some((s) => s.status !== "running" || !(plan.managed || []).some((m) => m.id === s.id))) throw Error("关闭期间窗口身份已变化");
    if (remaining.length) {
      const result = await this.processes.stop(remaining.map((s) => s.id));
      if (result.error || result.sessions.some((s) => remaining.some((r) => r.id === s.id) && s.status !== "gone")) throw Error("未能完整关闭所选窗口");
    }
    return { ok: true };
  }
  async validate(plan) {
    if (!plan?.available) throw Error("客户端进程或安装入口已变化，请重新确认重启");
    const fresh = await this.capture(plan.ids);
    if (fingerprint(stableIdentity(fresh)) !== plan.fingerprint) throw Error("客户端主进程或安装入口已变化，请重新确认重启");
    const previous = new Map(plan.value.targets.map((t) => [t.pid, t]));
    for (const target of fresh.targets) {
      const old = previous.get(target.pid);
      if (old && fingerprint(old) !== fingerprint(target)) throw Error("客户端进程身份已变化，请重新确认重启");
    }
    return fresh;
  }
  async assertStopped(plan) {
    const remaining = await this.capture(plan.ids);
    if (remaining.targets.length) throw Error("仍检测到客户端进程，请手动确认后重启");
    for (const app of plan.value.apps) if (fingerprint(this.fileInfo(app.exe)) !== fingerprint(app.file)) throw Error("客户端安装已更新，请从开始菜单重启");
  }
  async stop(plan) {
    const fresh = await this.validate(plan);
    let stopped;
    try { stopped = await this.adapter.stop(fresh.targets); }
    catch (error) { throw Error("强制关闭未完成，部分窗口可能已关闭；未继续应用配置，请检查客户端后重试。", { cause: error }); }
    if (stopped?.stopped !== true) throw Error("客户端未完整关闭，请手动重启");
    await this.assertStopped(plan);
    this.stoppedPlans.add(plan);
  }
  async launch(plan, beforeLaunch = () => {}) {
    if (!this.stoppedPlans.has(plan)) throw Error("尚未确认客户端已关闭，不能重新启动");
    this.stoppedPlans.delete(plan);
    await this.assertStopped(plan);
    beforeLaunch();
    const launched = this.launchDesktop ? await this.launchDesktop(plan.value.apps, this.adapter)
      : await this.adapter.launch(plan.value.apps);
    if (launched?.launched !== true) throw Error("客户端启动失败，请手动打开");
    for (let i = 0; i < 30; i++) {
      await this.wait(500);
      const fresh = await this.capture(plan.ids);
      if (plan.value.apps.every((a) => fresh.apps.some((b) => a.id === b.id))) return { ok: true, names: plan.names };
    }
    throw Error("已发出启动请求，但未确认新进程，请检查客户端");
  }
  async restart(plan, beforeLaunch = () => {}) {
    await this.stop(plan);
    return this.launch(plan, beforeLaunch);
  }
}
module.exports = { ClientRestart, DesktopRestartAdapter };
