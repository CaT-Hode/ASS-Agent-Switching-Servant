const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { atomic } = require("./config.cjs");

const { ids: clientIds } = require("./client-registry.cjs");

const JOURNAL = "client-processes.json";
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_ADAPTER_OUTPUT = 1024 * 1024;
const MAX_SESSIONS = 128;
const HELPER_TIMEOUT_MS = 15_000;
const HARNESSES = new Set(clientIds("processTracked"));

const PS_INSPECT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$all = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    creationDate = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    commandLine = [string]$_.CommandLine
  }
})
$byPid = @{}
foreach ($p in $all) { $byPid[[string]$p.pid] = $p }
$result = @()
foreach ($r in @($request.records)) {
  $root = $byPid[[string][int]$r.pid]
  $matched = $false
  if ($null -ne $root -and $root.creationDate) {
    $encoded = $null
    if ($root.commandLine -match '(?i)(?:-|/)EncodedCommand(?:\s+|[:=])(?:"([^"\s]+)"|([^\s]+))') {
      $encoded = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    }
    if ($encoded) {
      try {
        $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
        $matched = $decoded.Contains([string]$r.marker)
      } catch { $matched = $false }
    }
    if ($r.creationDate -and $root.creationDate -ne [string]$r.creationDate) { $matched = $false }
  }
  $desc = @()
  $invalid = $false
  if ($matched) {
    $known = @{ [string]$root.pid = $root }
    do {
      $added = $false
      foreach ($p in $all) {
        $parent = $known[[string]$p.parentPid]
        if ($p.pid -ne [int]$r.pid -and $p.pid -ne [int]$request.ownerPid -and $p.pid -ne $PID -and
            -not $known.ContainsKey([string]$p.pid) -and $null -ne $parent) {
          if (-not $p.creationDate -or -not $parent.creationDate -or
              [DateTime]::Parse($p.creationDate).ToUniversalTime() -lt [DateTime]::Parse($parent.creationDate).ToUniversalTime()) {
            $invalid = $true
            continue
          }
          $known[[string]$p.pid] = $p
          $desc += [pscustomobject]@{ pid=$p.pid; parentPid=$p.parentPid; creationDate=$p.creationDate }
          $added = $true
        }
      }
    } while ($added)
  }
  $safeRoot = if ($null -eq $root) { $null } else { [pscustomobject]@{
    pid=$root.pid; parentPid=$root.parentPid; creationDate=$root.creationDate; markerMatched=$matched
  }}
  $result += [pscustomobject]@{ id=[string]$r.id; root=$safeRoot; descendants=@($desc); invalid=$invalid }
}
@($result) | ConvertTo-Json -Depth 5 -Compress
`;

const PS_STOP = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @()
foreach ($t in @($request.targets)) {
  $pidNumber = [int]$t.pid
  $all = @(Get-CimInstance Win32_Process)
  $byPid = @{}
  foreach ($p in $all) { $byPid[[string][int]$p.ProcessId] = $p }
  $root = $byPid[[string][int]$t.root.pid]
  $owned = $null -ne $root
  if ($owned) {
    $rootCreated = if ($root.CreationDate) { $root.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    $owned = $rootCreated -eq [string]$t.root.creationDate
    $encoded = $null
    if ($owned -and [string]$root.CommandLine -match '(?i)(?:-|/)EncodedCommand(?:\s+|[:=])(?:"([^"\s]+)"|([^\s]+))') {
      $encoded = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    }
    if ($owned -and $encoded) {
      try { $owned = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)).Contains([string]$t.root.marker) }
      catch { $owned = $false }
    } else { $owned = $false }
  }
  $targetRow = $byPid[[string]$pidNumber]
  if ($owned -and $pidNumber -ne [int]$t.root.pid -and $null -eq $targetRow) {
    $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; stopped=$true; error=$null }
    continue
  }
  $previous = $null
  foreach ($link in @($t.chain)) {
    $row = $byPid[[string][int]$link.pid]
    if ($null -eq $row -or -not $row.CreationDate) { $owned = $false; break }
    $created = $row.CreationDate.ToUniversalTime().ToString('o')
    if ($created -ne [string]$link.creationDate) { $owned = $false; break }
    if ($null -ne $previous -and [int]$previous.ParentProcessId -ne [int]$link.pid) { $owned = $false; break }
    $previous = $row
  }
  if (-not $owned -or $pidNumber -eq [int]$request.ownerPid -or $pidNumber -eq $PID) {
    $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; stopped=$false; error='ownership-changed' }
    continue
  }
  $liveChild = $false
  $targetCreated = [DateTime]::Parse([string]$t.creationDate).ToUniversalTime()
  foreach ($candidate in $all) {
    if ([int]$candidate.ParentProcessId -eq $pidNumber -and $candidate.CreationDate -and
        $candidate.CreationDate.ToUniversalTime() -ge $targetCreated) {
      $liveChild = $true
      break
    }
  }
  if ($liveChild) {
    $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; stopped=$false; error='child-still-running' }
    continue
  }
  try {
    Stop-Process -Id $pidNumber -Force -ErrorAction Stop
    $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; stopped=$true; error=$null }
  } catch {
    $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; stopped=$false; error='stop-failed' }
  }
}
@($result) | ConvertTo-Json -Depth 4 -Compress
`;

const PS_VERIFY = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @()
foreach ($t in @($request.targets)) {
  $pidNumber = [int]$t.pid
  $row = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $pidNumber) -ErrorAction SilentlyContinue
  $alive = $false
  if ($null -ne $row -and $row.CreationDate) {
    $created = $row.CreationDate.ToUniversalTime().ToString('o')
    $alive = $created -eq [string]$t.creationDate
  }
  $result += [pscustomobject]@{ pid=$pidNumber; creationDate=[string]$t.creationDate; alive=$alive }
}
@($result) | ConvertTo-Json -Depth 3 -Compress
`;

function powershellPath() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runPowerShell(script, input, timeoutMs = HELPER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("PowerShell 进程操作超时"));
    }, timeoutMs);
    timer.unref?.();
    const collect = (name) => (chunk) => {
      if (stdout.length + stderr.length + chunk.length > MAX_ADAPTER_OUTPUT) {
        child.kill();
        finish(new Error("PowerShell 返回内容过大"));
        return;
      }
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", collect("stdout"));
    child.stderr.setEncoding("utf8").on("data", collect("stderr"));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("PowerShell 进程操作失败"));
      try {
        const value = JSON.parse(stdout.trim() || "[]");
        finish(null, Array.isArray(value) ? value : [value]);
      } catch {
        finish(new Error("PowerShell 返回了无效结果"));
      }
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(JSON.stringify(input));
  });
}

class NativePowerShellAdapter {
  inspect(records) {
    return runPowerShell(PS_INSPECT, { records, ownerPid: process.pid });
  }
  terminate(targets) {
    return runPowerShell(PS_STOP, { targets, ownerPid: process.pid });
  }
  verify(targets) {
    return runPowerShell(PS_VERIFY, { targets });
  }
}

function cleanText(value, name, max = 120) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\0-\x1f\x7f]/.test(value)
  )
    throw new Error(name + " 无效");
  return value.trim();
}

function cleanPid(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff)
    throw new Error("PID 无效");
  return value;
}

function validCreationDate(value) {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function validateHarness(value) {
  if (!HARNESSES.has(value)) throw new Error("客户端无效");
  return value;
}

function targetKey(row) {
  return `${row.pid}\0${row.creationDate}`;
}

function publicSession(row, status = row.status || "unknown") {
  return {
    id: row.id,
    harness: row.harness,
    label: row.label,
    pid: row.pid,
    status,
    transport: row.transport || "proxy",
  };
}

class ClientProcesses {
  constructor({ dataDir, adapter, onChange } = {}) {
    if (!dataDir || typeof dataDir !== "string")
      throw new Error("dataDir 无效");
    this.file = path.join(dataDir, JOURNAL);
    this.adapter = adapter || new NativePowerShellAdapter();
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.sessions = [];
    this.error = null;
    this.journalFault = false;
    this.queue = Promise.resolve();
    this.#load();
  }

  #load() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size > MAX_JOURNAL_BYTES)
        throw new Error("进程记录文件过大，已拒绝读取");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions))
        throw new Error("进程记录格式无效");
      if (parsed.sessions.length > MAX_SESSIONS)
        throw new Error("进程记录格式无效");
      this.sessions = parsed.sessions.map((row) => this.#validateStored(row));
      const ids = new Set(),
        markers = new Set(),
        identities = new Set();
      for (const row of this.sessions) {
        const identity = targetKey(row);
        if (
          ids.has(row.id) ||
          markers.has(row.marker) ||
          identities.has(identity)
        )
          throw new Error("进程记录格式无效");
        ids.add(row.id);
        markers.add(row.marker);
        identities.add(identity);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      this.sessions = [];
      this.error = error.message?.includes("过大")
        ? error.message
        : "进程记录格式无效，已拒绝使用";
      this.journalFault = true;
    }
  }

  #validateStored(row) {
    const result = {
      id: cleanText(row?.id, "会话 ID"),
      harness: validateHarness(row?.harness),
      account: cleanText(row?.account, "账户", 160),
      transport: row?.transport === "native" ? "native" : "proxy",
      label: cleanText(row?.label, "名称", 160),
      pid: cleanPid(row?.pid),
      marker: cleanText(row?.marker, "marker", 200),
      creationDate: row?.creationDate,
      status: "unknown",
    };
    if (result.marker.length < 16) throw new Error("marker 过短");
    if (!validCreationDate(result.creationDate))
      throw new Error("创建时间无效");
    return result;
  }

  #pruneGone() {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((row) => row.status !== "gone");
    if (this.sessions.length !== before) this.#save();
  }

  #inventory(session, row) {
    if (!row || row.id !== session.id)
      throw new Error(`会话 ${session.id} 的进程清单缺失`);
    if (row.root === null)
      return { state: "gone", descendants: [], chains: new Map() };
    const root = row.root;
    if (
      !root ||
      row.invalid ||
      !root.markerMatched ||
      root.pid !== session.pid ||
      root.creationDate !== session.creationDate ||
      !validCreationDate(root.creationDate)
    )
      return { state: "unverifiable", descendants: [], chains: new Map() };
    if (!Array.isArray(row.descendants) || row.descendants.length > 4096)
      throw new Error(`会话 ${session.id} 的后代清单无效`);
    const byPid = new Map([
      [
        root.pid,
        {
          pid: root.pid,
          parentPid: root.parentPid,
          creationDate: root.creationDate,
        },
      ],
    ]);
    for (const child of row.descendants) {
      const pid = cleanPid(child?.pid),
        parentPid = cleanPid(child?.parentPid);
      if (
        pid === root.pid ||
        pid === process.pid ||
        byPid.has(pid) ||
        !validCreationDate(child.creationDate)
      )
        throw new Error(`会话 ${session.id} 的后代清单无效`);
      byPid.set(pid, { pid, parentPid, creationDate: child.creationDate });
    }
    const chains = new Map();
    const depth = (pid, seen = new Set()) => {
      if (seen.has(pid)) throw new Error(`会话 ${session.id} 的后代链成环`);
      seen.add(pid);
      const child = byPid.get(pid);
      if (!child) throw new Error(`会话 ${session.id} 的后代链缺失`);
      if (pid === root.pid)
        return [{ pid: root.pid, creationDate: root.creationDate }];
      const parent = byPid.get(child.parentPid);
      if (
        !parent ||
        Date.parse(child.creationDate) < Date.parse(parent.creationDate)
      )
        throw new Error(`会话 ${session.id} 的后代链无效`);
      return [
        { pid: child.pid, creationDate: child.creationDate },
        ...depth(parent.pid, seen),
      ];
    };
    for (const child of row.descendants)
      chains.set(child.pid, depth(child.pid));
    return { state: "running", descendants: row.descendants, chains };
  }

  #save() {
    const sessions = this.sessions.map(({ status, ...row }) => row);
    atomic(this.file, JSON.stringify({ version: 1, sessions }, null, 2));
  }

  #exclusive(work) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  #emit() {
    const value = this.snapshot();
    if (this.onChange) {
      try {
        this.onChange(value);
      } catch {
        /* observers cannot break supervision */
      }
    }
    return value;
  }

  snapshot() {
    return {
      sessions: this.sessions.map((row) => publicSession(row)),
      error: this.error,
    };
  }

  register(input) {
    return this.#exclusive(async () => {
      if (this.journalFault) throw new Error(this.error || "进程记录不可用");
      this.#pruneGone();
      if (this.sessions.length >= MAX_SESSIONS)
        throw new Error("进程会话数量已达上限");
      const candidate = {
        id: cleanText(input?.id, "会话 ID"),
        harness: validateHarness(input?.harness),
        account: cleanText(input?.account, "账户", 160),
        transport: input?.transport === "native" ? "native" : "proxy",
        label: cleanText(input?.label, "名称", 160),
        pid: cleanPid(input?.pid),
        marker: cleanText(input?.marker, "marker", 200),
      };
      if (candidate.marker.length < 16) throw new Error("marker 过短");
      if (this.sessions.some((row) => row.id === candidate.id))
        throw new Error("会话 ID 已存在");
      if (this.sessions.some((row) => row.marker === candidate.marker))
        throw new Error("marker 已存在");
      const inspected = await this.adapter.inspect([candidate]);
      const matches = inspected.filter((row) => row.id === candidate.id);
      if (matches.length !== 1) throw new Error("无法验证新进程身份");
      const root = matches[0].root;
      if (
        !root?.markerMatched ||
        root.pid !== candidate.pid ||
        !validCreationDate(root.creationDate)
      )
        throw new Error("无法验证新进程身份");
      if (
        this.sessions.some(
          (existing) => targetKey(existing) === targetKey(root),
        )
      )
        throw new Error("PID 和创建时间已登记");
      const row = {
        ...candidate,
        creationDate: root.creationDate,
        status: "running",
      };
      this.sessions.push(row);
      this.error = null;
      this.#save();
      return this.#emit();
    });
  }

  refresh() {
    return this.#exclusive(async () => {
      if (this.journalFault) return this.#emit();
      this.#pruneGone();
      try {
        const inventory = await this.adapter.inspect(this.sessions);
        const errors = [];
        for (const session of this.sessions) {
          const matches = inventory.filter((row) => row.id === session.id);
          try {
            if (matches.length !== 1)
              throw new Error(`会话 ${session.id} 的进程清单缺失`);
            session.status = this.#inventory(session, matches[0]).state;
          } catch (error) {
            session.status = "unverifiable";
            errors.push(error.message);
          }
        }
        this.error = errors.length ? errors.join("；") : null;
      } catch (error) {
        for (const session of this.sessions) session.status = "unverifiable";
        this.error = error.message || "无法刷新进程状态";
      }
      return this.#emit();
    });
  }

  stop(ids) {
    return this.#exclusive(async () => {
      if (this.journalFault) throw new Error(this.error || "进程记录不可用");
      const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
      const selected = this.sessions.filter((row) => wanted.has(row.id));
      if (!selected.length || selected.length !== wanted.size)
        throw new Error("会话不存在");
      try {
        const inventory = await this.adapter.inspect(selected);
        const errors = [];
        for (const session of selected) {
          const matches = inventory.filter((item) => item.id === session.id);
          if (matches.length !== 1) {
            session.status = "unverifiable";
            errors.push(`会话 ${session.id} 的进程清单缺失`);
            continue;
          }
          let checked;
          try {
            checked = this.#inventory(session, matches[0]);
          } catch (error) {
            session.status = "unverifiable";
            errors.push(error.message);
            continue;
          }
          if (checked.state === "gone") {
            session.status = "gone";
            continue;
          }
          if (checked.state !== "running") {
            session.status = "unverifiable";
            errors.push(`会话 ${session.id} 的根进程身份无法验证`);
            continue;
          }
          const descendants = [...checked.descendants].sort(
            (a, b) =>
              checked.chains.get(b.pid).length -
              checked.chains.get(a.pid).length,
          );
          const rootIdentity = {
            pid: session.pid,
            creationDate: session.creationDate,
            marker: session.marker,
          };
          const targets = descendants.map((child) => ({
            pid: child.pid,
            creationDate: child.creationDate,
            root: rootIdentity,
            chain: checked.chains.get(child.pid),
          }));
          targets.push({
            pid: session.pid,
            creationDate: session.creationDate,
            root: rootIdentity,
            chain: [{ pid: session.pid, creationDate: session.creationDate }],
          });
          let failed = 0;
          for (const target of targets) {
            const result = await this.adapter.terminate([target]);
            if (
              !Array.isArray(result) ||
              result.length !== 1 ||
              result[0].pid !== target.pid ||
              result[0].creationDate !== target.creationDate ||
              !result[0].stopped
            ) {
              failed += 1;
              break;
            }
          }
          const verification = await this.adapter.verify(targets);
          const verified = new Map();
          if (Array.isArray(verification))
            for (const result of verification)
              if (result && typeof result.alive === "boolean")
                verified.set(targetKey(result), result.alive);
          let alive = 0,
            missing = 0;
          for (const target of targets) {
            const value = verified.get(targetKey(target));
            if (value === undefined) missing += 1;
            else if (value) alive += 1;
          }
          if (failed || alive || missing) {
            session.status = "unverifiable";
            errors.push(
              `会话 ${session.id} 未能完整终止（失败 ${failed}，仍存活 ${alive}，验证缺失 ${missing}）`,
            );
          } else {
            session.status = "gone";
          }
        }
        this.error = errors.length ? errors.join("；") : null;
      } catch (error) {
        this.error = error.message || "停止进程失败";
        for (const session of selected)
          if (session.status !== "gone") session.status = "unverifiable";
      }
      return this.#emit();
    });
  }
}

module.exports = { ClientProcesses, NativePowerShellAdapter, runPowerShell };
