const { SseParser } = require('./sse-parser.cjs');
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const requestTps = (tokens, ms) => tokenCount(tokens) !== null && Number.isFinite(ms) && ms > 0 ? tokens * 1000 / ms : null;

// Observation only. No prompt/output text, credentials or response headers are
// retained. A metrics parse failure must never change the inference stream.
class RequestMetrics {
  constructor({ now = Date.now, began = now() } = {}) {
    this.now = now; this.began = began; this.usage = null; this.first = null; this.last = null;
    this.outputUnits = 0; this.reportedAtUnits = 0;
  }
  event(event) {
    const delta = event.delta;
    const pieces = [];
    if (/\.delta$/.test(event.type || '') && /output_text|reasoning|function_call_arguments|custom_tool_call_input/.test(event.type)) pieces.push(delta);
    if (event.type === 'content_block_delta') pieces.push(delta?.text, delta?.thinking, delta?.partial_json);
    if (event.type === 'content_block_start') pieces.push(event.content_block?.text, event.content_block?.thinking);
    for (const choice of event.choices || []) {
      pieces.push(choice.delta?.content, choice.delta?.reasoning_content, choice.delta?.reasoning);
      for (const tool of choice.delta?.tool_calls || []) pieces.push(tool.function?.arguments);
    }
    for (const text of pieces) if (typeof text === 'string' && text.length) {
      this.first ??= this.now();
      // Keep numeric estimates only. A usage report in this same event covers
      // these deltas too, so apply its cumulative count after observing them.
      for (const character of text) this.outputUnits += character.codePointAt(0) < 128 ? .25 : 1;
    }
    const usage = event.response?.usage || event.message?.usage || event.usage;
    if (usage && typeof usage === 'object') {
      const anthropic = event.type?.startsWith('message_') || event.type === 'message' ||
        Object.hasOwn(usage, 'cache_read_input_tokens') || Object.hasOwn(usage, 'cache_creation_input_tokens');
      const patch = {
        inputTokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
        outputTokens: tokenCount(usage.output_tokens ?? usage.completion_tokens),
        cacheReadTokens: tokenCount(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens),
        cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
        reasoningTokens: tokenCount(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
      };
      this.usage ||= {};
      for (const [key, value] of Object.entries(patch)) if (value !== null) this.usage[key] = value;
      if (patch.outputTokens !== null) this.reportedAtUnits = this.outputUnits;
      // Anthropic's input_tokens excludes cache reads/writes. OpenAI's includes
      // them. Normalize both to total input without adding repeated snapshots.
      if (anthropic) {
        if (patch.inputTokens !== null) this.anthropicInput = patch.inputTokens;
        if (this.anthropicInput !== undefined) this.usage.inputTokens = this.anthropicInput +
          (this.usage.cacheReadTokens || 0) + (this.usage.cacheWriteTokens || 0);
      }
    }
    if (event.usage || event.response?.usage || ['response.completed', 'response.incomplete', 'message_stop'].includes(event.type)) this.last = this.now();
  }
  observe(response, signal, onData = () => {}) {
    if (!response.body) return response;
    const contentType = response.headers.get('content-type') || '';
    let mode = /event-stream/i.test(contentType) ? 'sse' : /json/i.test(contentType) ? 'json' : null;
    let parser = new SseParser(), chunks = [], size = 0, disabled = false;
    const feed = (chunk, done = false) => {
      if (disabled) return;
      try {
        if (!mode && chunk) mode = /^\s*[\[{]/.test(Buffer.from(chunk).toString('utf8')) ? 'json' : 'sse';
        if (mode === 'sse') {
          for (const frame of parser.feed(chunk, done)) this.event(frame.event);
        } else if (mode === 'json') {
          if (chunk) { size += chunk.byteLength; if (size > 4 * 1024 * 1024) { disabled = true; chunks = []; return; } chunks.push(Buffer.from(chunk)); }
          if (done && size) { this.event(JSON.parse(Buffer.concat(chunks).toString('utf8'))); chunks = []; }
        }
      } catch { disabled = true; chunks = []; parser = null; }
    };
    const body = response.body.pipeThrough(new TransformStream({
      transform: (chunk, controller) => { if (chunk.byteLength) onData(); feed(chunk); controller.enqueue(chunk); },
      flush: () => { feed(null, true); this.last = this.now(); },
    }), { signal });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  snapshot({ live = false } = {}) {
    const until = live ? this.now() : this.last;
    const generationMs = this.first !== null && until > this.first ? until - this.first : null;
    const elapsedMs = until === null ? null : Math.max(0, until - this.began);
    const estimated = live && this.outputUnits > this.reportedAtUnits;
    const outputTokens = live ? (this.usage?.outputTokens || 0) + Math.ceil(this.outputUnits - this.reportedAtUnits) : this.usage?.outputTokens;
    return { usage: live && (this.usage || outputTokens) ? { ...this.usage, ...(outputTokens ? { outputTokens } : {}) } : this.usage,
      ttftMs: this.first === null ? null : Math.max(0, this.first - this.began), generationMs,
      // All output tokens include hidden reasoning. The matching interval must
      // include the wait before visible output, not just its final short burst.
      tps: live && (this.first === null || elapsedMs < 1000) ? null : requestTps(outputTokens, elapsedMs),
      ...(live ? { tpsEstimated: estimated, outputEstimated: estimated } : {}) };
  }
}
module.exports = { RequestMetrics, requestTps };
