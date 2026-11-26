const fs = require("node:fs");
const path = require("node:path");
const { locations } = require("./additional-harnesses.cjs");
const { read, safePath } = require("./native-fields.cjs");
const { hash, known, num, label, dayKey, localHour, normalized } = require("./usage-common.cjs");

function rootsFor(client, options) {
  return locations(client, { home: options.home, env: options.env || {}, override: options.overrides?.[client] }).map((v) => v.dir);
}

function zcodeFiles(options, source) {
  const env = options.env || {}, configured = [];
  // Native aliases obey environment iteration order, just like parseEnvConfig.
  for (const [key, value] of Object.entries(env))
    if (["ZCODE_SESSION_DB", "ZCODE_SESSION_DB_PATH"].includes(key) && value) configured.push(value);
  if (configured.length) {
    const file = configured.at(-1).replace(/^~(?=[/\\]|$)/, options.home);
    if (!path.isAbsolute(file)) { source.partial = true; return []; }
    return [path.resolve(file)];
  }
  // The session DB is independent of the v2 credential/data root. Do not infer
  // a different database from the account directory or desktop dataBaseDir.
  return [path.join(options.home, ".zcode/cli/db/db.sqlite")];
}

function kimiContext(file, roots) {
  const root = roots.find((dir) => file.startsWith(path.join(dir, "sessions") + path.sep));
  if (!root) throw Error("unknown-kimi-session-root");
  const parts = path.relative(path.join(root, "sessions"), file).split(path.sep);
  if (parts.length < 3 || parts.at(-1) !== "wire.jsonl") throw Error("unknown-kimi-session-path");
  const sessionDir = path.join(root, "sessions", parts[0], parts[1]);
  let state;
  try { state = JSON.parse(read(path.join(sessionDir, "state.json")) || "{}"); }
  catch { throw Error("unreadable-kimi-session-state"); }
  return { session: parts[1], imported: state.custom?.imported_from_kimi_cli === true,
    signature: hash(JSON.stringify([state.custom?.imported_from_kimi_cli, state.forkedFrom, state.createdAt])) };
}

function kimiParser(fileKey, context = {}) {
  const rows = new Map(), requests = new Map();
  let ordinal = 0;
  const session = hash("kimi\0" + (context.session || fileKey));
  const put = (key, time, usage, model, provider) => {
    if (!known(time) || !dayKey(time)) return;
    rows.set(key, { key: hash("kimi\0" + key), client: "kimi", session, day: dayKey(time),
      hour: localHour(time), model: label(model), provider: label(provider), calls: 1, ...usage });
  };
  return { rows, accept(x, line = ++ordinal) {
    if (context.imported) return;
    if (x.type === "forked") {
      // The native fork copies old wire records, then appends this marker.
      // Only actual requests made after the marker belong to the new session.
      rows.clear(); requests.clear(); return;
    }
    if (x.type === "llm.request") { requests.set(x.agentId || "main", x); return; }
    if (x.type === "usage.record") {
      const u = x.usage;
      if (!u || !known(u.inputOther) || !known(u.output)) return;
      const id = x.agentId || "main", request = requests.get(id);
      // One request context per usage event. Never infer historic provider from
      // today's config; compaction/model overrides may differ from the TUI.
      const matched = request && [request.model, request.modelAlias].includes(x.model);
      put(fileKey + "\0" + line, x.time,
        normalized(u.inputOther, u.output, u.inputCacheRead, u.inputCacheCreation, 0),
        matched ? request.model : x.model, matched ? request.provider : undefined);
      requests.delete(id);
    } else if (x.message?.type === "StatusUpdate") {
      const p = x.message.payload, u = p?.token_usage;
      if (!u || !known(u.input_other) || !known(u.output) || !known(x.timestamp)) return;
      // Legacy timestamps are seconds, not milliseconds. Stable message IDs
      // deduplicate revisions and copied/forked histories across native files.
      const key = typeof p.message_id === "string" && p.message_id
        ? "legacy-message\0" + p.message_id : fileKey + "\0" + line;
      put(key, x.timestamp * 1000,
        normalized(u.input_other, u.output, u.input_cache_read, u.input_cache_creation, 0));
    }
  } };
}

function zcodeInput(row) {
  const input = num(row.input_tokens), cache = num(row.cache_creation_input_tokens) + num(row.cache_read_input_tokens);
  if (!input) return cache;
  const total = row.provider_total_tokens ?? row.computed_total_tokens, output = num(row.output_tokens);
  // Same interpretation as native inputSideTokensFromStoredUsage: current AI
  // SDK input includes cache; older rows can carry cache-exclusive input.
  return cache && known(total) && total > 0 && Math.abs(total - input - cache - output) < Math.abs(total - input - output)
    ? input + cache : input;
}
function readZCode(file) {
  safePath(file);
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = [];
    // Do not read raw_usage_json, provider metadata, prompts, errors or messages.
    const query = db.prepare(`SELECT id, session_id, provider_id, model_id, started_at,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, provider_total_tokens, computed_total_tokens
      FROM model_usage WHERE status IN ('completed','error','cancelled')`);
    for (const r of query.iterate()) {
      if (!r.id || !r.session_id || !known(r.started_at) || !dayKey(r.started_at) || !known(r.input_tokens) || !known(r.output_tokens)) continue;
      rows.push({ key: hash("zcode\0" + r.id), client: "zcode", at: r.started_at,
        session: hash("zcode\0" + r.session_id), day: dayKey(r.started_at), hour: localHour(r.started_at),
        provider: label(r.provider_id), model: label(r.model_id), calls: 1,
        ...normalized(zcodeInput(r), r.output_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens, r.reasoning_tokens, true) });
    }
    return { rows, malformed: 0 };
  } finally { db.close(); }
}

function retainZCodeHistory(entry, previous, now) {
  const earliest = now - 365 * 86400000, nativeCutoff = now - 30 * 86400000;
  const rows = new Map((previous?.rows || []).filter((r) => r.client === "zcode" && r.at >= earliest && r.at < nativeCutoff).map((r) => [r.key, r]));
  for (const row of entry.rows) if (row.at >= earliest) rows.set(row.key, row);
  return { ...entry, rows: [...rows.values()] };
}

const antigravityUsageSession = (conversationId) => hash("antigravity\0" + conversationId);

function excludedAntigravityUsageSessions(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, "usage-exclusions.json"), "utf8"));
    const ids = Array.isArray(value?.antigravity) ? value.antigravity : [];
    return new Set(ids.filter(id => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
      .map(antigravityUsageSession));
  } catch { return new Set(); }
}

function antigravityFiles(options, source) {
  const dirs = rootsFor("antigravity", options);
  const found = [];
  for (const dir of dirs) {
    const brain = path.join(dir, "brain");
    let entries;
    try {
      safePath(brain);
      entries = fs.readdirSync(brain, { withFileTypes: true });
    } catch (e) {
      if (e.code !== "ENOENT") source.partial = true;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      found.push(path.join(brain, entry.name, ".system_generated", "logs", "transcript.jsonl"));
      if (found.length >= 5000) {
        source.partial = true;
        return found;
      }
    }
  }
  return found;
}

function antigravityContext(file) {
  const logsDir = path.dirname(file);
  const sysDir = path.dirname(logsDir);
  const convDir = path.dirname(sysDir);
  const conversationId = path.basename(convDir) || hash(file);
  return { conversationId, signature: conversationId };
}

function antigravityParser(fileKey, context = {}) {
  const rows = new Map();
  let ordinal = 0;
  const conversationId = context.conversationId || fileKey;
  const session = antigravityUsageSession(conversationId);
  return {
    rows,
    accept(x, line = ++ordinal) {
      if (x?.type !== "PLANNER_RESPONSE") return;
      if (!known(x.input_tokens) || !known(x.output_tokens)) return;
      if (x.input_tokens + x.output_tokens + num(x.cache_read_tokens) === 0) return;
      const day = dayKey(x.created_at);
      if (!day) return;
      const stepKey = Number.isSafeInteger(x.step_index)
        ? `${conversationId}\0${x.step_index}`
        : `${fileKey}\0${line}`;
      const model = label(x.model);
      const provider =
        typeof x.model === "string" && x.model.startsWith("ass-")
          ? "ASS 注入"
          : "Google Antigravity";
      rows.set(stepKey, {
        key: hash("antigravity\0" + stepKey),
        client: "antigravity",
        session,
        day,
        hour: localHour(x.created_at),
        model,
        provider,
        calls: 1,
        updatedAt: Date.parse(x.created_at) || 0,
        // Antigravity transcript input_tokens excludes cache_read_tokens.
        ...normalized(x.input_tokens, x.output_tokens, x.cache_read_tokens, 0, 0, false),
      });
    },
  };
}

module.exports = {
  rootsFor,
  zcodeFiles,
  kimiContext,
  kimiParser,
  readZCode,
  retainZCodeHistory,
  antigravityFiles,
  antigravityUsageSession,
  excludedAntigravityUsageSessions,
  antigravityContext,
  antigravityParser,
};
