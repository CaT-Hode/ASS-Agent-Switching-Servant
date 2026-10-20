const { createHash } = require('node:crypto');
const PREFIX = 'ass-reasoning-v1:';
const CONTENT_LIMIT = 2 * 1024 * 1024, CAPSULE_LIMIT = 4 * 1024 * 1024;
const fail = (message, status = 502) => Object.assign(Error(message), { status, code: 'reasoning_state_failed' });
const raw = item => item?.type === 'reasoning' && Array.isArray(item.content) && item.content.some(part => part?.text?.length);

// DeepSeek returns replayable plaintext reasoning rather than a summary or an
// encrypted provider state. Codex renders that plaintext even after completion.
// Keep its live deltas, but use our existing OS encryption for completed history.
// No sidecar or process-local replay cache is needed after restart.
class CodexReasoning {
  constructor(encryption) { this.crypto = encryption; }
  available() {
    if (typeof this.crypto?.encryptString !== 'function' || typeof this.crypto?.decryptString !== 'function' ||
        this.crypto.isEncryptionAvailable?.() === false)
      throw fail('本机思考状态加密不可用，未丢弃模型续聊状态', 503);
  }
  expand(body) {
    if (!Array.isArray(body.input)) return body;
    let changed = false;
    const input = body.input.map(item => {
      if (item?.type !== 'reasoning' || typeof item.encrypted_content !== 'string' || !item.encrypted_content.startsWith(PREFIX)) return item;
      this.available();
      let payload;
      try {
        const text = item.encrypted_content.slice(PREFIX.length);
        if (!text.length || text.length > CAPSULE_LIMIT) throw Error();
        const bytes = Buffer.from(text, 'base64');
        if (bytes.toString('base64') !== text) throw Error();
        const decoded = this.crypto.decryptString(bytes);
        if (Buffer.byteLength(decoded) > CONTENT_LIMIT) throw Error();
        payload = JSON.parse(decoded);
        if (payload.kind !== 'ass-codex-reasoning' || payload.version !== 1 || !raw(payload.item) ||
            !payload.item.content.every(part => ['reasoning_text', 'text'].includes(part?.type) && typeof part.text === 'string')) throw Error();
      } catch { throw fail('ASS 思考状态无法解密或已损坏，未丢弃历史；请使用原设备及原 ASS 数据目录重试', 400); }
      changed = true;
      return payload.item;
    });
    return changed ? { ...body, input } : body;
  }
  view() {
    const cache = new Map();
    const seal = item => {
      if (!raw(item)) return item;
      this.available();
      if (!item.content.every(part => ['reasoning_text', 'text'].includes(part?.type) && typeof part.text === 'string'))
        throw fail('上游思考状态格式无效，未丢弃模型续聊状态');
      const payload = JSON.stringify({ kind: 'ass-codex-reasoning', version: 1, item });
      if (Buffer.byteLength(payload) > CONTENT_LIMIT) throw fail('上游思考状态超过大小限制，未丢弃模型续聊状态');
      const key = createHash('sha256').update(payload).digest('hex');
      if (!cache.has(key)) {
        const encrypted = this.crypto.encryptString(payload).toString('base64');
        if (encrypted.length > CAPSULE_LIMIT) throw fail('加密思考状态超过大小限制，未丢弃模型续聊状态');
        const { content, ...rest } = item;
        cache.set(key, { ...rest, summary: item.summary || [], encrypted_content: PREFIX + encrypted });
      }
      return cache.get(key);
    };
    const response = value => ({ ...value, ...(Array.isArray(value.output) ? { output: value.output.map(seal) } : {}) });
    async function* restore(events) {
      const pending = new Map(), completed = new Set(); let sequence = 0;
      const output = event => ({ ...event, sequence_number: sequence++ });
      const key = event => event.item?.id || event.item_id || event.output_index;
      const final = event => {
        const state = pending.get(key(event)), item = event.item;
        // Some compatible streams omit content on the done item. Keep the
        // complete streamed state instead of replacing it with an empty item.
        if (item.encrypted_content?.startsWith(PREFIX)) return item;
        return seal(!raw(item) && state?.parts.size ? { ...item, content: [...state.parts.entries()]
          .sort(([a], [b]) => a - b).map(([, text]) => ({ type: 'reasoning_text', text })) } : item);
      };
      for await (const event of events) {
        if (event.type === 'response.output_item.added' && event.item?.type === 'reasoning') {
          pending.set(key(event), { parts: new Map((event.item.content || []).map((part, index) => [index, part.text || ''])) });
          const { content, ...item } = event.item;
          yield output({ ...event, item });
          continue;
        }
        if (['response.reasoning_text.delta', 'response.reasoning_text.done'].includes(event.type)) {
          const state = pending.get(key(event)), index = event.content_index ?? 0;
          if (state) {
            const text = event.type.endsWith('.done') ? event.text : (state.parts.get(index) || '') + event.delta;
            if (typeof text === 'string') state.parts.set(index, text);
            if ([...state.parts.values()].reduce((size, part) => size + Buffer.byteLength(part), 0) > CONTENT_LIMIT)
              throw fail('上游思考状态超过大小限制，未丢弃模型续聊状态');
          }
        }
        if (event.type === 'response.content_part.done' && ['reasoning_text', 'text'].includes(event.part?.type)) {
          const state = pending.get(key(event));
          if (state && typeof event.part.text === 'string') state.parts.set(event.content_index ?? 0, event.part.text);
        }
        if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') {
          if (completed.has(key(event))) continue;
          const item = final(event); completed.add(key(event));
          yield output({ ...event, item });
          continue;
        }
        if (['response.completed', 'response.incomplete'].includes(event.type)) {
          const items = event.response?.output;
          if (Array.isArray(items)) {
            const restored = items.map((item, output_index) => item?.type === 'reasoning' ? final({ item, output_index }) : item);
            // Clear the live item even if the upstream only supplies its final
            // reasoning in response.completed, without output_item.done.
            for (let i = 0; i < items.length; i++) if (items[i]?.type === 'reasoning' && !completed.has(items[i].id || i)) {
              yield output({ type: 'response.output_item.done', output_index: i, item: restored[i] });
              completed.add(items[i].id || i);
            }
            yield output({ ...event, response: { ...event.response, output: restored } });
            continue;
          }
        }
        yield output(event);
      }
    }
    return { response, restore };
  }
}
module.exports = { CodexReasoning, PREFIX, CONTENT_LIMIT, CAPSULE_LIMIT };
