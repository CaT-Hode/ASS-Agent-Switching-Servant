// Measurements describe this request, including any ASS adaptation and local hop.
// Never persist response content or headers; only timing/count/usage scalars.
function diagnosticMetrics(protocol, route, clock = () => performance.now()) {
  const started = clock();
  const values = { protocol, route, phase: "connect", eventCount: 0, responseBytes: 0 };
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  let streamStart;
  return {
    headers(response, { relay = false } = {}) {
      // A local 502 may mean no upstream HTTP response was received at all.
      values.httpStatus = relay && !response.ok ? null : response.status;
      if (relay) values.localStatus = response.status;
      values.headersMs = elapsed();
      values.phase = "headers";
      streamStart = clock();
    },
    observe(event) {
      values.phase = "stream";
      values.firstEventMs ??= elapsed();
      values.eventCount++;
      values.responseBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      const output = event.response?.output || (event.item ? [event.item] : []);
      const text = (event.type === "response.output_text.delta" && event.delta) ||
        (event.delta?.type === "text_delta" && event.delta.text) ||
        (event.content_block?.type === "text" && event.content_block.text) ||
        event.choices?.[0]?.delta?.content ||
        output.some((i) => i.type === "message" && i.content?.some((c) => c.type === "output_text" && c.text));
      if (text) values.firstTextMs ??= elapsed();
      const usage = event.response?.usage || event.message?.usage || event.usage;
      for (const [key, value] of Object.entries({
        inputTokens: usage?.input_tokens ?? usage?.prompt_tokens,
        outputTokens: usage?.output_tokens ?? usage?.completion_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens,
      })) if (Number.isFinite(value) && value >= 0) values[key] = value;
    },
    finish(ok = false) {
      if (ok) values.phase = "complete";
      if (streamStart !== undefined) values.streamMs = Math.max(0, Math.round(clock() - streamStart));
      return { ...values, ms: elapsed() };
    },
  };
}
module.exports = { diagnosticMetrics };
