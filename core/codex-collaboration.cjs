const messageTools = new Set(['spawn_agent', 'send_message', 'followup_task']);

function plaintextCall(item) {
  if (item?.type !== 'function_call' || item.namespace !== 'collaboration' || !messageTools.has(item.name) ||
      item.encrypted_function_args != null || typeof item.arguments !== 'string') return item;
  let args;
  try { args = JSON.parse(item.arguments); } catch { return item; }
  if (typeof args?.message !== 'string' || !args.message.trim()) return item;

  // Codex distinguishes ordinary collaboration messages from encrypted tool
  // arguments using a present, empty list. Compatible providers omit it.
  return { ...item, encrypted_function_args: [] };
}

function plaintextCollaborationResponse(response) {
  if (!Array.isArray(response?.output)) return response;
  const output = response.output.map(plaintextCall);
  return output.some((item, index) => item !== response.output[index]) ? { ...response, output } : response;
}

function plaintextCollaborationEvent(event) {
  if (event.type === 'response.output_item.done') {
    const item = plaintextCall(event.item);
    if (item !== event.item) return { ...event, item };
  }
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    const response = plaintextCollaborationResponse(event.response);
    if (response !== event.response) return { ...event, response };
  }
  return event;
}

module.exports = { plaintextCollaborationEvent, plaintextCollaborationResponse };
