const { SseParser } = require('./sse-parser.cjs');
class SseMonitor {
  constructor(mapEvent) { this.parser = new SseParser(); this.ended = false; this.mapEvent = mapEvent; }
  feed(bytes, done = false) {
    const frames = this.parser.feed(bytes, done, event => ['response.completed', 'response.incomplete'].includes(event.type)), output = [];
    for (const frame of frames) {
      if (this.ended) break;
      const event = this.mapEvent ? this.mapEvent(frame.event) : frame.event;
      if (event === frame.event) output.push(frame.raw);
      else {
        const lines = frame.raw.split('\n');
        const first = lines.findIndex(line => line.startsWith('data:'));
        lines[first] = 'data: ' + JSON.stringify(event);
        output.push(lines.filter((line, index) => index <= first || !line.startsWith('data:')).join('\n'));
      }
      if (['response.completed', 'response.incomplete'].includes(frame.event.type)) this.ended = true;
    }
    if (done && !this.ended) throw Error('上游流提前断开，未收到结束事件');
    return output;
  }
}
module.exports = { SseMonitor };
