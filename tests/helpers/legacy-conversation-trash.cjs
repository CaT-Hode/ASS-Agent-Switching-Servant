// Seed a pre-change recoverable deletion, to test existing backups without
// enabling backups on the application's new permanent-delete endpoint.
async function legacyDelete(library, { projectId, recordId, confirmed }) {
  if (confirmed !== true) throw Error('请确认');
  await library.list({ scope: library.scope || 'active' });
  const rows = library.recordsCache.filter(r => r.nativePresent && r.projectId === projectId && (!recordId || r.id === recordId));
  await library.assertDeletionIdle?.(rows);
  library.persist();
  const entry = await library.run('trash-plan', { rows, label: 'Existing legacy backup', backup: true });
  (library.state.trash ||= []).push(entry); library.persist();
  await library.assertDeletionIdle?.(rows);
  if (entry.imports.length) await library.releaseImports({ imports: entry.imports, returns: [] });
  Object.assign(entry, await library.run('trash-commit', { entry }));
  library.state.deleted = [...new Set([...(library.state.deleted || []), ...entry.rows.map(r => r.harness + '\0' + r.sessionId)])];
  library.recordsCache = []; library.persist(); return { id: entry.id };
}
module.exports = { legacyDelete };
