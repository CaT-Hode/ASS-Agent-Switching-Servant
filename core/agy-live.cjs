const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { atomic } = require("./config.cjs");
const { safePath } = require("./native-fields.cjs");
const { hash, known, num, label } = require("./usage-common.cjs");
const { locations } = require("./antigravity-status.cjs");
const { findExecutable } = require("./client-launcher.cjs");
const { sanitizeHookPayload } = require("./agy-hook-relay.cjs");

const HOOK_KEY = "ass-monitor";
const MAX_SEEN = 4000;
const ACTIVE_TTL_MS = 5 * 60 * 1000;

function hooksFilePath(home = os.homedir()) {
  return path.join(home, ".gemini", "config", "hooks.json");
}

function runtimeFilePath(dataDir) {
  return path.join(dataDir, "agy-hook-runtime.json");
}

function readHooksFile(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {}, error: "" };
  try {
    safePath(file);
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, data: null, error: "hooks.json 根结构不是 JSON 对象" };
    }
    return { exists: true, data: parsed, error: "" };
  } catch {
    return { exists: true, data: null, error: "hooks.json 无法读取或 JSON 无效" };
  }
}

function hookStatus({ home = os.homedir() } = {}) {
  const file = hooksFilePath(home);
  const parsed = readHooksFile(file);
  if (parsed.error) {
    return { installed: false, enabled: false, file, error: parsed.error };
  }
  const entry = parsed.data?.[HOOK_KEY];
  const installed = !!entry && typeof entry === "object";
  const enabled = installed && entry.enabled !== false;
  return { installed, enabled, file, error: "" };
}

function buildHookCommand({ dataDir, relayScript = path.join(__dirname, "agy-hook-relay.cjs"), env = process.env }) {
  const runtimeFile = runtimeFilePath(dataDir);
  const nodeExe = findExecutable("node", env);
  if (nodeExe) {
    // Copy relay out of app.asar into dataDir so system node.exe can execute it.
    const stagedRelay = path.join(dataDir, "agy-hook-relay.cjs");
    safePath(stagedRelay);
    atomic(stagedRelay, fs.readFileSync(relayScript, "utf8"));
    return `"${nodeExe}" "${stagedRelay}" "${runtimeFile}"`;
  }
  // Fallback: PowerShell one-liner if Node.js is not in PATH (packaged Electron).
  const psScript = path.join(dataDir, "agy-hook-relay.ps1");
  const scriptContent = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$rtFile = '${runtimeFile.replace(/'/g, "''")}'`,
    "try {",
    "  if (Test-Path $rtFile) {",
    "    $rt = Get-Content -Raw -Encoding UTF8 $rtFile | ConvertFrom-Json",
    "    $raw = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "    $ev = [string]$raw.hookEventName",
    "    if ($ev -in @('SessionStart','PreInvocation','PostInvocation','Stop')) {",
    "      $body = @{ hookEventName = $ev; conversationId = [string]$raw.conversationId; modelName = [string]$raw.modelName; invocationNum = $raw.invocationNum } | ConvertTo-Json -Compress",
    "      Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $rt.port + '/agy-events') -Headers @{ 'x-ass-hook-token' = [string]$rt.token } -ContentType 'application/json' -Body $body -TimeoutSec 1 | Out-Null",
    "    }",
    "  }",
    "} catch {}",
    "[Console]::Write('{}')",
  ].join("\n");
  safePath(psScript);
  atomic(psScript, scriptContent);
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScript}"`;
}

function installHook({ home = os.homedir(), dataDir, command, env = process.env }) {
  const file = hooksFilePath(home);
  const parsed = readHooksFile(file);
  if (parsed.error) throw Error("无法写入 Antigravity hooks.json：" + parsed.error);
  const cmd = command || buildHookCommand({ dataDir, env });
  const handler = [{ type: "command", command: cmd, timeout: 2 }];
  const next = {
    ...(parsed.data || {}),
    [HOOK_KEY]: {
      enabled: true,
      PreInvocation: handler,
      PostInvocation: handler,
      Stop: handler,
    },
  };
  safePath(file);
  atomic(file, JSON.stringify(next, null, 2) + "\n");
  return hookStatus({ home });
}

function uninstallHook({ home = os.homedir() } = {}) {
  const file = hooksFilePath(home);
  const parsed = readHooksFile(file);
  if (parsed.error) throw Error("无法清理 Antigravity hooks.json：" + parsed.error);
  if (!parsed.exists || !Object.hasOwn(parsed.data, HOOK_KEY)) {
    return hookStatus({ home });
  }
  const next = { ...parsed.data };
  delete next[HOOK_KEY];
  if (Object.keys(next).length === 0) {
    try { fs.unlinkSync(file); } catch {}
  } else {
    safePath(file);
    atomic(file, JSON.stringify(next, null, 2) + "\n");
  }
  return hookStatus({ home });
}

function writeHookRuntime(dataDir, { port, token }) {
  const file = runtimeFilePath(dataDir);
  safePath(file);
  atomic(file, JSON.stringify({ port, token }));
}

function clearHookRuntime(dataDir) {
  const file = runtimeFilePath(dataDir);
  try { fs.unlinkSync(file); } catch {}
}

class AgyLiveMonitor {
  constructor({
    home = os.homedir(),
    override = "",
    onRecord = () => {},
    onActivity = () => {},
    now = Date.now,
  } = {}) {
    this.home = home;
    this.override = override;
    this.onRecord = onRecord;
    this.onActivity = onActivity;
    this.now = now;
    this.watchers = [];
    this.offsets = new Map();
    this.partials = new Map();
    this.timers = new Map();
    this.seen = new Set();
    this.activeInvocations = new Map();
    this.seq = 0;
    this.running = false;
  }

  brainDirs() {
    return locations({ home: this.home, override: this.override }).map((loc) =>
      path.join(loc.dir, "brain"),
    );
  }

  seedOffsets() {
    for (const brain of this.brainDirs()) {
      let entries;
      try {
        entries = fs.readdirSync(brain, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = path.join(brain, entry.name, ".system_generated", "logs", "transcript.jsonl");
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) this.offsets.set(file, stat.size);
        } catch {}
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.seedOffsets();
    for (const brain of this.brainDirs()) {
      if (!fs.existsSync(brain)) continue;
      try {
        const watcher = fs.watch(brain, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const rel = String(filename).replaceAll("/", path.sep);
          if (!rel.endsWith(path.sep + "transcript.jsonl") && rel !== "transcript.jsonl") return;
          const full = path.join(brain, rel);
          this.scheduleRead(full);
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // Recursive fs.watch unavailable on non-Windows/network dirs; fail quietly.
      }
    }
  }

  stop() {
    this.running = false;
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  scheduleRead(file) {
    const existing = this.timers.get(file);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(file);
      this.readAppended(file);
    }, 300);
    timer.unref?.();
    this.timers.set(file, timer);
  }

  remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }

  readAppended(file) {
    let stat;
    try {
      safePath(file);
      stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
    } catch {
      return;
    }
    let offset = this.offsets.get(file);
    if (offset === undefined) offset = 0;
    if (stat.size < offset) {
      offset = 0;
      this.partials.delete(file);
    }
    if (stat.size === offset) return;
    const toRead = Math.min(stat.size - offset, 8 * 1024 * 1024);
    let fd;
    let text = "";
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.allocUnsafe(toRead);
      const read = fs.readSync(fd, buf, 0, toRead, offset);
      this.offsets.set(file, offset + read);
      text = buf.toString("utf8", 0, read);
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    const combined = (this.partials.get(file) || "") + text;
    const lines = combined.split(/\r?\n/);
    const tail = lines.pop();
    if (tail && tail.length < 4 * 1024 * 1024) this.partials.set(file, tail);
    else this.partials.delete(file);

    const convDir = path.dirname(path.dirname(path.dirname(file)));
    const conversationId = path.basename(convDir) || "unknown";
    let emitted = false;
    for (const line of lines) {
      if (!line.includes('"PLANNER_RESPONSE"')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (this.processTranscriptStep(conversationId, parsed)) emitted = true;
    }
    if (emitted) this.onActivity();
  }

  processTranscriptStep(conversationId, step) {
    if (step?.type !== "PLANNER_RESPONSE") return false;
    if (!known(step.input_tokens) || !known(step.output_tokens)) return false;
    const cacheRead = num(step.cache_read_tokens);
    if (step.input_tokens + step.output_tokens + cacheRead === 0) return false;
    // Skip requests already routed & logged by ASS /clients/agy to avoid double counting.
    if (typeof step.model === "string" && step.model.startsWith("ass-")) return false;
    const stepKey = `${conversationId}:${step.step_index ?? step.created_at ?? ""}`;
    if (!this.remember(stepKey)) return false;

    const totalInput = step.input_tokens + cacheRead;
    // Hook invocationNum counts model invocations. The transcript's step_index
    // counts trajectory steps, so neither timing nor identity can be joined here.
    this.onRecord({
      time: new Date(this.now()).toISOString(),
      source: "Google 官方",
      model: label(step.model),
      ms: null,
      ok: true,
      taskOk: true,
      requestId: "agy-transcript-" + hash(stepKey),
      client: "antigravity",
      protocol: "antigravity-native",
      providerId: "google-antigravity",
      observation: "antigravity-transcript",
      usage: {
        inputTokens: totalInput,
        outputTokens: step.output_tokens,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      },
    });
    return true;
  }

  handleHookEvent(raw) {
    const payload = sanitizeHookPayload(raw);
    if (!payload) return false;
    const t = this.now();
    const convId = payload.conversationId || "default";
    const key = `${convId}:${payload.invocationNum ?? "current"}`;

    if (payload.hookEventName === "PreInvocation") {
      // A conversation only runs one active model invocation at a time; retire any
      // leftover live entry from an earlier invocation that never emitted Post/Stop.
      for (const [k, v] of this.activeInvocations) {
        if (v.conversationId === convId) this.activeInvocations.delete(k);
      }
      this.activeInvocations.set(key, {
        requestId: `agy-${convId.slice(0, 8)}-${++this.seq}`,
        conversationId: convId,
        client: "antigravity",
        source: "Google 官方",
        protocol: "antigravity-native",
        providerId: "google-antigravity",
        model: payload.modelName || "Antigravity",
        startedAt: new Date(t).toISOString(),
        began: t,
        inProgress: true,
        phase: "waiting-output",
      });
      this.onActivity();
      return true;
    }

    if (payload.hookEventName === "PostInvocation") {
      if (this.activeInvocations.delete(key)) this.onActivity();
      return true;
    }

    if (payload.hookEventName === "Stop") {
      for (const [k, v] of this.activeInvocations) {
        if (v.conversationId === convId) this.activeInvocations.delete(k);
      }
      this.onActivity();
      return true;
    }

    return false;
  }

  activeSnapshot() {
    const t = this.now();
    const out = [];
    for (const [key, item] of this.activeInvocations) {
      if (t - item.began > ACTIVE_TTL_MS) {
        this.activeInvocations.delete(key);
        continue;
      }
      out.push({
        requestId: item.requestId,
        model: item.model,
        source: item.source,
        protocol: item.protocol,
        providerId: item.providerId,
        time: item.startedAt,
        client: "antigravity",
        observation: "antigravity-hook",
        inProgress: true,
        phase: item.phase,
        ms: Math.max(0, t - item.began),
        usage: null,
        ttftMs: null,
        generationMs: null,
        visibleTokens: null,
        visibleMs: null,
        tps: null,
        tpsEstimated: false,
        endToEndTps: null,
      });
    }
    return out;
  }
}

module.exports = {
  HOOK_KEY,
  hooksFilePath,
  runtimeFilePath,
  hookStatus,
  installHook,
  uninstallHook,
  writeHookRuntime,
  clearHookRuntime,
  AgyLiveMonitor,
};
