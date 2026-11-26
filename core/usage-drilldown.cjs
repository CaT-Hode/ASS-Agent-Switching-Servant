const path = require('node:path');
const { hash } = require('./usage-common.cjs');
const { ids } = require('./client-registry.cjs');
const { listAntigravityConversations } = require('./antigravity-conversations.cjs');

const clients = new Set(ids('usage'));
const projectClients = new Set(['codex', 'claude', 'opencode', 'pi', 'dsh']);
const day = /^\d{4}-\d{2}-\d{2}$/;
const fields = ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const empty = () => Object.fromEntries(fields.map((field) => [field, 0]));
function add(to, row) {
  for (const field of fields) to[field] += row[field] || 0;
}
const byTokens = (a, b) => b.selected.input + b.selected.output - a.selected.input - a.selected.output;

async function selectUsage(records, selection) {
  if (!selection || typeof selection !== 'object') throw Error('用量查询无效');
  const { from, to, filterClients, model, hours, dayOnly, cutoffDay, cutoffHour } = selection;
  if (![from, to].every((value) => typeof value === 'string' && day.test(value)) || from > to ||
      !Array.isArray(filterClients) || !filterClients.length || filterClients.length > clients.size ||
      !filterClients.every((value) => clients.has(value)) ||
      (model !== undefined && (typeof model !== 'string' || model.length > 200)) ||
      (hours !== undefined && (!Array.isArray(hours) || hours.length !== 2 || !hours.every(Number.isInteger) ||
        hours[0] < 0 || hours[0] >= hours[1] || hours[1] > 24 || from !== to)) ||
      (dayOnly !== undefined && typeof dayOnly !== 'boolean') || (hours && dayOnly) ||
      (cutoffDay !== undefined && (typeof cutoffDay !== 'string' || !day.test(cutoffDay) ||
        !Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 23))) throw Error('用量查询无效');

  const { usageModelName } = await import('./model-name.mjs');
  const allowed = new Set(filterClients);
  const selected = empty(), unallocated = empty(), sessions = new Map();
  for (const row of records.values()) {
    if (!allowed.has(row.client) || row.day < from || row.day > to) continue;
    const timed = Number.isInteger(row.hour) && row.hour >= 0 && row.hour < 24;
    if (timed && row.day === cutoffDay && row.hour > cutoffHour) continue;
    if (hours && (!timed || row.hour < hours[0] || row.hour >= hours[1]) || dayOnly && timed) continue;
    if (model !== undefined && usageModelName(row.model, row.client) !== model) continue;
    add(selected, row);
    // A daily bucket may know session IDs but has no per-session attribution.
    if (!row.session) {
      add(unallocated, row);
      continue;
    }
    const key = row.client + '\0' + row.session;
    let session = sessions.get(key);
    if (!session) {
      session = { id: row.session, client: row.client, selected: empty(), total: empty() };
      sessions.set(key, session);
    }
    add(session.selected, row);
  }
  for (const row of records.values()) {
    const session = sessions.get(row.client + '\0' + row.session);
    if (session) add(session.total, row);
  }
  return { selected, unallocated, sessions: [...sessions.values()].sort(byTokens) };
}

const catalogues = new WeakMap();
function projectCatalogue(conversations) {
  const cached = catalogues.get(conversations);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = conversations.usageReferences();
  const entry = { promise, expires: Infinity };
  catalogues.set(conversations, entry);
  promise.then(() => { entry.expires = Date.now() + 15000; }, () => catalogues.delete(conversations));
  return promise;
}

async function buildUsageDrilldown(detail, projectConversations, antigravityOverride) {
  const needed = new Set(detail.sessions.map((session) => session.client));
  const [catalogue, antigravity] = await Promise.all([
    [...needed].some((client) => projectClients.has(client))
      ? projectCatalogue(projectConversations).catch(() => ({ items: [], records: [] }))
      : { items: [], records: [] },
    needed.has('antigravity') ? Promise.resolve().then(() => listAntigravityConversations({
      override: antigravityOverride, includeSubagents: true, limit: 500,
    }).rows).catch(() => []) : [],
  ]);
  const projects = new Map(catalogue.items.map((project) => [project.id, project]));
  const references = new Map();
  for (const row of catalogue.records) {
    if (!needed.has(row.harness)) continue;
    const key = row.harness + '\0' + hash(row.harness + '\0' + row.sessionId);
    const project = projects.get(row.projectId);
    references.set(key, { title: row.title, project: project && !project.nonProject ? project : null,
      target: { projectId: row.projectId, recordId: row.id, harness: row.harness,
        scope: row.historyStatus === 'active' ? 'active' : 'inactive' } });
  }
  for (const row of antigravity) {
    const key = 'antigravity\0' + hash('antigravity\0' + row.id);
    const project = row.workspace ? { id: 'agy-' + hash(path.normalize(row.workspace).toLowerCase()), name: path.basename(row.workspace) } : null;
    references.set(key, { project, title: row.title, surface: row.surfaceLabel,
      resume: row.canResume ? { id: row.id, workspace: row.workspace } : null });
  }
  const groups = new Map();
  for (const session of detail.sessions) {
    const match = references.get(session.client + '\0' + session.id);
    const id = match?.project?.id || 'unassigned';
    const group = groups.get(id) || { id, name: match?.project?.name || '项目未识别', selected: empty(), sessions: [] };
    add(group.selected, session.selected);
    group.sessions.push({ ...session, title: match?.title || '会话未匹配',
      ...(match?.surface ? { surface: match.surface } : {}),
      ...(match?.target ? { target: match.target } : {}),
      ...(match?.resume ? { resume: match.resume } : {}) });
    groups.set(id, group);
  }
  return { selected: detail.selected, unallocated: detail.unallocated, projects: [...groups.values()].sort(byTokens) };
}

module.exports = { selectUsage, buildUsageDrilldown };
