const { inspectStream } = require("./model-inspection.cjs");
const { responseFailure, classifyFailure, diagnosticError } = require("./diagnostic-failure.cjs");
async function inspectConnectionResponse(response, protocol, metrics, { relay = false, signal } = {}) {
  metrics?.headers(response, { relay });
  if (!response.ok) throw diagnosticError(await responseFailure(response, { relay, signal }));
  try {
    const inspected = await inspectStream(response.body, protocol, undefined, metrics?.observe, signal);
    if (!inspected.completed || !inspected.text) throw Error("未收到完整结束事件");
    return { message: "连接成功 · 完整流式响应", protocol };
  } catch (error) {
    signal?.throwIfAborted();
    throw diagnosticError(classifyFailure(error, { httpStatus: response.status, layer: "stream" }));
  }
}
module.exports = { inspectConnectionResponse };
