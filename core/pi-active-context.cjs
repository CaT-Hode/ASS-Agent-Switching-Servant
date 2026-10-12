// Match pi 1.0.0's buildContextEntries/buildSessionProjection, without loading
// extensions, migrating files or interpreting historical tools as live calls.
function projectContext(active) {
  const compact = active.findLastIndex(row => row.type === 'compaction');
  let selected = active;
  if (compact >= 0) {
    const checkpoint = active[compact];
    const first = active.slice(0, compact).findIndex(row => row.id === checkpoint.firstKeptEntryId);
    selected = [checkpoint, ...(first < 0 ? [] : active.slice(first, compact)
      .filter(row => !(row.type === 'message' && row.message?.role === 'system'))), ...active.slice(compact + 1)];
  }
  const edits = new Map();
  for (const row of selected) if (row.type === 'context_edit') {
    if (typeof row.targetId !== 'string' || !(row.replacement === null ||
        row.replacement && (typeof row.replacement.content === 'string' || Array.isArray(row.replacement.content))))
      throw Error('pi 上下文修改记录无法识别，未同步旧内容');
    edits.set(row.targetId, row);
  }
  const rows = selected.flatMap((row, index) => {
    if (row.type === 'compaction' && index > 0) return [];
    const edit = edits.get(row.id);
    if (row.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(row.message?.role) || !edit) return [row];
    if (edit.replacement === null) return [];
    return [{ ...row, message: { ...row.message, content: edit.replacement.content } }];
  });
  return { rows, modifiers: selected.filter(row => ['compaction', 'context_edit'].includes(row.type))
    .map(row => row.type === 'compaction' ? { type: row.type, id: row.id, firstKeptEntryId: row.firstKeptEntryId, summary: row.summary }
      : { type: row.type, id: row.id, targetId: row.targetId, replacement: row.replacement }) };
}
module.exports = { projectContext };
