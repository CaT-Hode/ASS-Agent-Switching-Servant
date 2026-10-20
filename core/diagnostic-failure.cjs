// Diagnostic-only, bounded error interpretation. Never persist provider prose,
// response bodies, URLs, headers or credentials as diagnostic evidence.
const INFO = {
  dns: ["DNS 解析失败", "无法解析供应商域名，尚未收到上游 HTTP 响应", "检查供应商域名与当前网络的 DNS 策略；此结果不能判断密钥或额度是否有效。"],
  authentication: ["认证失败", "密钥或登录凭据未被接受", "检查此模型使用的 API Key 或 OAuth 登录；不要将认证失败当作额度耗尽。"],
  quota: ["额度或余额耗尽", "上游明确报告额度或余额不足", "检查供应商余额、套餐额度或额度重置时间。更换模型不一定能解除账户级额度限制。"],
  rate_limit: ["请求受限", "上游返回限流或请求频率限制", "稍后重试并检查并发限制；没有明确的余额或额度错误证据时，不判定为额度耗尽。"],
  payment: ["付款或余额问题", "上游要求付款或检查余额", "查看供应商账单；仅凭 HTTP 402 不能确定是余额耗尽还是其他付款问题。"],
  gateway: ["网关拒绝或异常", "上游返回 HTML 网关错误页", "检查供应商网关或网络策略；HTML 错误页不能证明密钥失效或额度耗尽。"],
  permission: ["访问被拒绝", "上游拒绝访问此模型或接口", "检查模型权限、账户状态及网关策略；HTTP 403 不等同于密钥失效。"],
  tls: ["TLS 连接失败", "无法建立经过证书校验的安全连接", "检查系统时间、证书信任和网络出口；不要关闭 TLS 校验。"],
  timeout: ["请求超时", "连接或响应等待超时", "检查网络和供应商响应情况；超时不代表凭据失效或额度耗尽。"],
  network: ["网络连接失败", "未能完成与供应商的网络连接", "检查代理、网络出口及供应商可达性。"],
  server: ["上游服务异常", "上游返回服务错误", "稍后重试或查看供应商服务状态；保留上游实际 HTTP 状态。"],
  request: ["请求或协议不兼容", "上游未接受此模型的请求", "检查模型 ID、接口协议与参数配置。"],
  stream: ["响应未完整结束", "未收到完整结束事件", "HTTP 成功不代表模型任务成功；检查流中断或供应商协议支持。"],
  local: ["本机检测失败", "ASS 本机路由未能完成检测", "检查 ASS 服务和模型配置；未收到上游响应时不能判断密钥或额度。"],
  unknown: ["原因未明确", "连接检测失败，未获得可分类的错误证据", "可重新检测以获取详细原因；旧版通用 502 记录不能用于判断 DNS、密钥或额度。"],
};
const CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ERR_NAME_NOT_RESOLVED", "ERR_NAME_RESOLUTION_FAILED", "ERR_DNS_TIMED_OUT",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_INTERNET_DISCONNECTED", "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_DATE_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_SSL_PROTOCOL_ERROR",
  "invalid_api_key", "authentication_error", "invalid_token", "token_expired", "invalid_access_token", "expired_token", "unauthorized",
  "insufficient_quota", "insufficient_balance", "insufficient_credits", "credit_balance_too_low", "billing_hard_limit_reached", "usage_limit_reached", "credits_exhausted",
  "rate_limit_exceeded", "rate_limit_error", "too_many_requests", "overloaded_error", "permission_denied", "permission_error",
]);
const status = (v) => Number.isInteger(v) && v >= 100 && v <= 599 ? v : null;
function failureDetails(value) {
  if (!value || !Object.hasOwn(INFO, value.kind) || !["network", "upstream", "stream", "local", "unknown"].includes(value.layer)) return null;
  const [label, , hint] = INFO[value.kind];
  return { kind: value.kind, layer: value.layer, label, hint, ...(CODES.has(value.code) ? { code: value.code } : {}) };
}
function failureResult(kind, layer, httpStatus, code, localStatus) {
  const failure = failureDetails({ kind, layer, code });
  return { failure, message: INFO[kind][1], httpStatus: status(httpStatus),
    ...(status(localStatus) ? { localStatus } : {}) };
}
function savedFailure(result) {
  const f = failureDetails(result?.failure);
  return f ? failureResult(f.kind, f.layer, result.httpStatus, f.code, result.localStatus) : null;
}
function classifyFailure(error, options = {}) {
  // Only our own exceptions carry this member. Never accept it from provider JSON.
  const known = savedFailure(error?.diagnostic);
  if (known) return known;
  const httpStatus = status(options.httpStatus), localStatus = status(options.localStatus);
  const layer = options.layer || (httpStatus ? "upstream" : "network");
  const make = (kind, code) => failureResult(kind, layer, httpStatus, code, localStatus);
  const chain = [];
  for (let e = error; e && chain.length < 5; e = e.cause) chain.push(e);
  const networkText = chain.map(e => `${e.code || ""} ${e.name || ""} ${e.message || ""}`).join(" ").slice(0, 8192);
  const code = [...CODES].find(c => c === c.toUpperCase() && new RegExp(`\\b${c}\\b`).test(networkText));
  if (code) {
    if (/ENOTFOUND|EAI_AGAIN|NAME_|DNS_/.test(code)) return make("dns", code);
    if (/CERT|SSL|TLS|VERIFY/.test(code)) return make("tls", code);
    if (/TIMEDOUT|TIMEOUT|TIMED_OUT/.test(code)) return make("timeout", code);
    return make("network", code);
  }
  if (/TimeoutError|请求超时/.test(networkText)) return make("timeout");
  if (/未找到 ChatGPT 登录|OAuth 访问令牌已到期/.test(networkText))
    return failureResult("authentication", httpStatus ? layer : "local", httpStatus, undefined, localStatus);
  if (/未收到完整结束事件|上游流提前断开/.test(networkText)) return make("stream");
  let body = options.body;
  if (typeof body === "string") {
    if (/html/i.test(options.contentType || "") || /^\s*(?:<!doctype html|<html)/i.test(body)) return make("gateway");
    try { body = JSON.parse(body.slice(0, 8192)); } catch { body = null; }
  }
  const detail = body?.error || body?.response?.error || body?.detail;
  const codes = [detail?.code, detail?.type, body?.code, body?.type].filter(v => typeof v === "string");
  const providerCode = codes.find(c => CODES.has(c));
  const message = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : typeof body?.message === "string" ? body.message : "";
  // Inspect only explicit error fields, never successful model text. Keep no prose.
  if (codes.some(c => /^(insufficient_quota|insufficient_balance|insufficient_credits|credit_balance_too_low|billing_hard_limit_reached|usage_limit_reached|credits_exhausted)$/.test(c))) return make("quota", providerCode);
  if (codes.some(c => /^(invalid_api_key|authentication_error|invalid_token|token_expired|invalid_access_token|expired_token|unauthorized)$/.test(c))) return make("authentication", providerCode);
  if (codes.some(c => /^(rate_limit_exceeded|rate_limit_error|too_many_requests)$/.test(c))) return make("rate_limit", providerCode);
  if (httpStatus === 401) return make("authentication", providerCode);
  if (/insufficient (?:credits?|balance|quota)|credit balance is too low|exceeded your current quota|(?:余额|额度)(?:已)?(?:不足|耗尽|用尽)|配额(?:已)?(?:耗尽|用尽)/i.test(message.slice(0, 4096))) return make("quota", providerCode);
  if (httpStatus === 402) return make("payment", providerCode);
  if (httpStatus === 403) return make("permission", providerCode);
  if (httpStatus === 429) return make("rate_limit", providerCode);
  if (httpStatus === 408 || httpStatus === 504) return make("timeout", providerCode);
  if (httpStatus >= 500) return make("server", providerCode);
  if (httpStatus >= 400) return make("request", providerCode);
  if (layer === "stream") return make("stream", providerCode);
  if (layer === "local") return make("local");
  return make("unknown");
}
function diagnosticError(result) {
  return Object.assign(Error(result.message), { diagnostic: result });
}
async function errorSample(response, signal) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (size < 8192) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, 8192 - size);
      chunks.push(chunk); size += chunk.length;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", cancel); cancel(); reader.releaseLock();
  }
}
async function responseFailure(response, { relay = false, signal } = {}) {
  let body = "";
  try { body = await errorSample(response, signal); } catch (error) { signal?.throwIfAborted(); }
  if (relay) {
    // Private diagnostic endpoint only. Upstream headers never reach this path.
    if (response.headers.get("x-ass-diagnostic-error") === "1") {
      try {
        const known = savedFailure(JSON.parse(body).diagnostic);
        if (known) return { ...known, localStatus: response.status };
      } catch {}
    }
    return classifyFailure(null, { layer: "local", localStatus: response.status });
  }
  return classifyFailure(null, { httpStatus: response.status, body, contentType: response.headers.get("content-type") });
}
module.exports = { classifyFailure, diagnosticError, responseFailure, failureDetails, savedFailure };
