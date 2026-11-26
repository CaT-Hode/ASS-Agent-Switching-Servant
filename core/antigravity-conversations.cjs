const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { safePath } = require("./native-fields.cjs");
const { locations } = require("./antigravity-status.cjs");

const SURFACE_LABELS = {
  cli: "Antigravity CLI",
  desktop: "Antigravity 2.0",
  ide: "Antigravity IDE",
  custom: "Antigravity",
};

function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max);
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  // Convert Go datetime format ("2026-11-24 07:05:59.1869198+00:00") to ISO-8601.
  const iso = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function parseWorkspace(rawUris) {
  if (typeof rawUris !== "string" || !rawUris.trim()) return "";
  let list = [];
  try {
    const parsed = JSON.parse(rawUris);
    if (Array.isArray(parsed)) list = parsed;
    else if (typeof parsed === "string") list = [parsed];
  } catch {
    list = [rawUris];
  }
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      if (item.startsWith("file://")) return fileURLToPath(item);
      if (path.isAbsolute(item)) return path.resolve(item);
    } catch {}
  }
  return "";
}

function readDbRows(dbFile, variant) {
  if (!fs.existsSync(dbFile)) return [];
  safePath(dbFile);
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const stmt = db.prepare(`
      SELECT conversation_id, title, step_count, last_modified_time, workspace_uris,
             status, source, agent_name, parent_conversation_id, nesting_depth
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
      LIMIT 300
    `);
    const rows = [];
    for (const r of stmt.iterate()) {
      const id = cleanText(r.conversation_id, 128);
      if (!id) continue;
      const isCli = variant === "cli" || r.source === "CORTEX_TRAJECTORY_SOURCE_CLI";
      const surface = isCli ? "cli" : variant;
      const updatedMs = parseTimestamp(r.last_modified_time);
      const workspace = parseWorkspace(r.workspace_uris);
      const parentId = cleanText(r.parent_conversation_id, 128);
      rows.push({
        id,
        surface,
        surfaceLabel: SURFACE_LABELS[surface] || "Antigravity",
        title: cleanText(r.title, 160) || `会话 ${id.slice(0, 8)}`,
        stepCount: Number.isSafeInteger(r.step_count) && r.step_count >= 0 ? r.step_count : 0,
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : "",
        updatedMs,
        workspace,
        status: cleanText(r.status, 64),
        agentName: cleanText(r.agent_name, 80),
        parentId,
        isSubagent: Boolean(parentId || (Number(r.nesting_depth) || 0) > 0),
        canResume: surface === "cli",
      });
    }
    return rows;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function listAntigravityConversations({ home = os.homedir(), override = "", limit = 100, includeSubagents = false } = {}) {
  const byId = new Map();
  for (const { dir, variant } of locations({ home, override })) {
    const dbFile = path.join(dir, "conversation_summaries.db");
    for (const row of readDbRows(dbFile, variant)) {
      const existing = byId.get(row.id);
      if (!existing) {
        byId.set(row.id, row);
      } else {
        // Prefer CLI entry (resumable) or newer / richer title.
        const preferNew =
          (row.canResume && !existing.canResume) ||
          (row.canResume === existing.canResume && row.updatedMs > existing.updatedMs);
        if (preferNew) {
          byId.set(row.id, {
            ...row,
            title: row.title.startsWith("会话 ") && !existing.title.startsWith("会话 ") ? existing.title : row.title,
            workspace: row.workspace || existing.workspace,
          });
        } else if (!existing.workspace && row.workspace) {
          existing.workspace = row.workspace;
        }
      }
    }
  }
  const rows = [...byId.values()]
    .filter((r) => includeSubagents || !r.isSubagent)
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(({ updatedMs, ...rest }) => rest);
  return { rows, total: byId.size };
}

module.exports = {
  listAntigravityConversations,
  parseWorkspace,
  parseTimestamp,
};
