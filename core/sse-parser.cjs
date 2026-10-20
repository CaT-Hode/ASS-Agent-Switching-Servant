// Complete bounded SSE frames; CR, LF and split CRLF share one parser.
const { assertTaskOutcome } = require('./task-outcome.cjs');
class SseParser {
  constructor(limit = 16 * 1024 * 1024) {
    this.decoder = new TextDecoder(); this.limit = limit;
    this.line = ''; this.lines = []; this.size = 0; this.cr = false;
  }
  feed(bytes, done = false, terminal = () => false) {
    if (this.ended) return [];
    const text = done ? this.decoder.decode() : this.decoder.decode(bytes, { stream: true });
    const frames = [];
    const lineEnd = () => {
      if (this.line) this.lines.push(this.line);
      else {
        const lines = this.lines; this.lines = []; this.size = 0;
        const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        const type = lines.find(l => l.startsWith('event:'))?.slice(6).replace(/^ /, '');
        if (data) {
          let event;
          try { event = data === '[DONE]' ? { done: true } : JSON.parse(data); }
          catch { throw Error('上游 SSE 事件不是有效 JSON'); }
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('上游 SSE 事件格式无效');
          assertTaskOutcome(event, { layer: 'stream' });
          if (event.error || ['error', 'response.failed'].some(value => value === event.type || value === type)) throw Error('上游流返回失败事件，请检查供应商状态或模型参数');
          frames.push({ event, raw: lines.join('\n') + '\n\n' });
          if (terminal(event)) this.ended = true;
        }
      }
      this.line = '';
    };
    for (const char of text) {
      if (this.ended) break;
      if (this.cr) { this.cr = false; if (char === '\n') continue; }
      const code = char.codePointAt(0); this.size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (this.size > this.limit) throw Error('上游 SSE 单个事件超过限制');
      if (char === '\r' || char === '\n') { lineEnd(); this.cr = char === '\r'; }
      else this.line += char;
    }
    if (done && !this.ended && (this.line || this.lines.some(l => !l.startsWith(':')))) throw Error('上游 SSE 事件未完整结束');
    return frames;
  }
}
module.exports = { SseParser };
