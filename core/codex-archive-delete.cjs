// Codex 0.162+ WriterLockCoordinator contract (codex-rs/rollout/src/writer_lock.rs).
// Hold home coordination AND each thread's OS byte-range lock through commit.
// Checking that a .lock file exists is NOT evidence of a live writer.
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { safePath } = require('./native-fields.cjs');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function eligible(row) {
  return row.harness === 'codex' && row.archived === true && row.nativePresent === true &&
    UUID.test(row.sessionId || '') && path.isAbsolute(row.dir || '') && path.isAbsolute(row.file || '') &&
    path.relative(row.dir, row.file).split(path.sep)[0] === 'archived_sessions';
}
async function assertSupported(executables) {
  if (!Array.isArray(executables) || !executables.length) throw Error('无法确认 Codex 的会话锁版本，未删除归档记录');
  for (const exe of new Set(executables)) {
    if (!path.isAbsolute(exe) || path.basename(exe).toLowerCase() !== 'codex.exe') throw Error('Codex 后端路径无法确认，未删除');
    const version = await new Promise((resolve, reject) => execFile(exe, ['--version'],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => error ? reject(Error('Codex 版本检测失败，未删除')) : resolve(stdout)));
    const match = /^codex-cli (\d+)\.(\d+)\./m.exec(version);
    // Fail closed on an unreviewed future major / changed lock contract.
    if (!match || Number(match[1]) !== 0 || Number(match[2]) < 162)
      throw Error('当前 Codex 版本不支持安全的运行中归档删除，请先关闭 Codex');
  }
}
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::ReadLine() | ConvertFrom-Json
$locks = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
try {
 foreach ($group in @($request.groups)) {
  [IO.Directory]::CreateDirectory([string]$group.directory) | Out-Null
  foreach ($name in @('.coordination.lock') + @($group.ids | ForEach-Object { [string]$_ + '.lock' })) {
   $file = [IO.File]::Open([IO.Path]::Combine([string]$group.directory, $name), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
   $locks.Add($file)
   $file.Lock(0, [long]::MaxValue)
  }
 }
 [Console]::WriteLine('ASS_LOCKED')
 [Console]::Out.Flush()
 # EOF on parent/worker failure also releases locks. Never delete lock files:
 # another process may already have an open handle to the same file.
 [Console]::ReadLine() | Out-Null
} catch {
 [Console]::WriteLine('ASS_LOCK_FAILED')
 [Console]::Out.Flush()
 exit 1
} finally { foreach ($file in $locks) { $file.Dispose() } }
`;
function lockGroups(rows) {
  if (!rows.length || !rows.every(eligible)) throw Error('只允许安全删除原生 Codex 归档记录');
  const groups = new Map();
  for (const row of rows) {
    safePath(row.dir); safePath(row.file);
    const directory = path.join(row.dir, 'thread-writer-locks'); safePath(directory);
    const key = path.resolve(directory).toLowerCase();
    if (!groups.has(key)) groups.set(key, { directory, ids: new Set() });
    groups.get(key).ids.add(row.sessionId);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => ({ ...value, ids: [...value.ids].sort() }));
}
function assertUnreferenced(rows) {
  for (const dir of new Set(rows.map(r => r.dir))) {
    const targets = new Set(rows.filter(r => r.dir === dir).map(r => r.sessionId.toLowerCase()));
    let count = 0;
    const walk = (directory, depth = 0) => {
      safePath(directory); if (!fs.existsSync(directory)) return;
      if (depth > 16) throw Error('历史引用超出检查范围，未删除');
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name); safePath(file);
        if (entry.isDirectory()) { walk(file, depth + 1); continue; }
        if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/.test(entry.name)) continue;
        if (++count > 20000) throw Error('历史引用超出检查范围，未删除');
        if (entry.name.endsWith('.zst')) throw Error('存在压缩历史，无法完整核验引用；请先关闭 Codex 再删除');
        const fd = fs.openSync(file, 'r'); let meta;
        try {
          const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024));
          const read = fs.readSync(fd, bytes, 0, bytes.length, 0), text = bytes.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '');
          const first = JSON.parse(text.split('\n', 1)[0]);
          if (first.type !== 'session_meta' || !UUID.test(first.payload?.id || '')) throw Error('Unknown metadata');
          meta = first.payload;
        } catch { throw Error('无法完整核验会话的历史引用，未删除'); }
        finally { fs.closeSync(fd); }
        if (meta.history_base && targets.has(String(meta.history_base.thread_id).toLowerCase()) && !targets.has(meta.id.toLowerCase()))
          throw Error('其他分支仍引用这段历史，未删除；请先处理关联分支');
      }
    };
    // Unlike the display scanner, include subagents and compressed rollouts:
    // hidden/native records can still hold a live reference to this history.
    for (const name of ['sessions', 'archived_sessions']) walk(path.join(dir, name));
  }
}
async function withLocks(rows, action, launch = spawn) {
  if (process.platform !== 'win32') throw Error('当前平台不支持运行中归档删除');
  const groups = lockGroups(rows);
  const child = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let ready = false, lockLost = false, buffer = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const acquired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('归档会话锁检测超时，未删除')), 10000);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.includes('ASS_LOCK_FAILED')) { clearTimeout(timer); reject(Error('该归档对话仍被 Codex 占用，未删除；请关闭该对话后重试')); }
      else if (!ready && buffer.includes('ASS_LOCKED')) { ready = true; clearTimeout(timer); resolve(); }
    });
    child.once('error', () => { lockLost = true; clearTimeout(timer); reject(Error('无法取得归档会话锁，未删除')); });
    child.once('close', () => { lockLost = true; clearTimeout(timer); if (!ready) reject(Error('无法取得归档会话锁，未删除')); });
  });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ groups }) + '\n');
  try {
    await acquired;
    // action must check ownership before every mutation. Do not race an ongoing
    // deletion with lock loss and release locks while file work is still alive.
    const assertHeld = () => { if (lockLost || child.exitCode !== null || child.signalCode || child.killed) throw Error('归档会话锁已丢失，停止删除'); };
    assertHeld(); return await action(assertHeld);
  } finally {
    child.stdin.end('\n');
    if (!ready) child.kill();
    await closed;
  }
}
module.exports = { eligible, assertSupported, withLocks, lockGroups, assertUnreferenced };
