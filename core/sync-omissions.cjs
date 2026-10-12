// Presence/provenance only. Never archive prompt bodies, permission settings or
// credentials as portable instructions, nor promote user text to system role.
function omissions(harness, rows) {
  const found = new Set();
  for (const row of rows) {
    const payload = row.payload || row.message || {};
    if (['system', 'developer'].includes(payload.role) || row.type === 'system' ||
        row.type === 'session_meta' && row.payload?.base_instructions ||
        row.attachment?.type === 'prompt_snapshot' && row.attachment.systemPrompt?.length ||
        row.type === 'compaction' && row.systemMessage) found.add('system');
    const content = payload.content || row.data?.content || row.data?.message?.content;
    if (Array.isArray(content)) for (const item of content) {
      if (['image', 'input_image', 'file'].includes(item?.type)) found.add('media');
      if (['tool_use', 'tool_result', 'toolCall', 'tool-result'].includes(item?.type)) found.add('tool-structure');
    }
    if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(payload.type)) found.add('tool-structure');
    if (harness === 'dsh' && row.data?.source?.kind && !['user', 'model'].includes(row.data.source.kind)) found.add('dsh-non-dialogue');
  }
  return [...found];
}
module.exports = { omissions };
