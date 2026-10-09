// The ChatGPT Codex backend accepts reasoning history only with empty content.
// Some Responses-compatible providers return plaintext reasoning (and their own
// encrypted state) here. Neither can be replayed to the official backend.
// This is an outbound-only, schema-scoped filter, not a provider-ID heuristic:
// keep native empty/encrypted reasoning, messages, phases and tool pairs intact.
function officialCodexHistory(body) {
  if (!Array.isArray(body?.input)) return body;
  const input = body.input.filter(item => !(
    item?.type === "reasoning" && Array.isArray(item.content) && item.content.length > 0
  ));
  // Remove the whole incompatible item, not just its plaintext: a foreign
  // encrypted_content is not made valid by deleting content from the same item.
  return input.length === body.input.length ? body : { ...body, input };
}

module.exports = { officialCodexHistory };
