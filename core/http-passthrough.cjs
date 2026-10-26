const { StringDecoder } = require('node:string_decoder');

// These fields describe one transport connection, not the proxied request.
// Also honor Connection's nominated fields on either side of the relay.
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const entityHeaders = new Set([
  'content-length', 'content-encoding', 'content-md5', 'content-digest', 'repr-digest', 'digest',
]);
function entries(headers) {
  return typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers || {});
}
function endToEndHeaders(headers, excluded) {
  const pairs = entries(headers).map(([key, value]) => [key.toLowerCase(), value]);
  const connection = pairs.find(([key]) => key === 'connection')?.[1];
  const blocked = new Set([...hopHeaders, ...entityHeaders,
    ...String(connection || '').toLowerCase().split(',').map(key => key.trim())]);
  return Object.fromEntries(pairs.filter(([key, value]) =>
    value != null && !blocked.has(key) && !excluded(key)));
}
function officialRequestHeaders(headers) {
  // Body decoding/history repair happens before forwarding, so entity framing
  // and hashes must be rebuilt. Local cookies/proxy credentials stay local.
  return endToEndHeaders(headers, key =>
    ['host', 'cookie', 'cookie2', 'expect', 'forwarded', 'via'].includes(key) ||
    /^(?:x-ass-|x-forwarded-|sec-fetch-|sec-websocket-)/.test(key));
}
function upstreamResponseHeaders(headers, secrets = []) {
  // fetch exposes decoded bytes. Forwarding its original compression or length
  // would make the client decompress twice or truncate the response.
  const forwarded = endToEndHeaders(headers, key =>
    ['set-cookie', 'set-cookie2', 'clear-site-data', 'authorization', 'x-api-key'].includes(key) ||
    key.startsWith('x-ass-'));
  return Object.fromEntries(Object.entries(forwarded).map(([key, value]) => [key, redact(value, secrets)]));
}
function redact(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  return text;
}
const diagnosticNames = new Set([
  'content-type', 'server', 'via', 'cf-ray', 'cf-mitigated', 'retry-after',
  'x-request-id', 'x-oai-request-id', 'request-id', 'x-client-request-id',
  'x-mife-upstream-status', 'x-openai-proxy-wasm', 'x-envoy-upstream-service-time',
  'x-trace-id', '_trace_id_', 'traceparent', 'openai-processing-ms',
]);
// Codex requests these read-only backend resources before enabling its new
// composer. Keep the relay narrow: no task creation or arbitrary proxying.
const codexBootstrapPathPatterns = [
  /^\/wham\/(?:settings\/user|config\/bundle|profiles\/me|usage|rate-limit-reset-credits|settings\/configs\/user-preferences)$/,
  /^\/wham\/accounts\/check(?:\/[A-Za-z0-9._-]+)?$/,
  /^\/(?:settings\/user|config\/bundle|profiles\/me|usage|rate-limit-reset-credits|settings\/configs\/user-preferences)$/,
  /^\/accounts\/check(?:\/[A-Za-z0-9._-]+)?$/,
];
function codexBootstrapRequest(url) {
  let parsed;
  try { parsed = new URL(url, 'http://127.0.0.1'); } catch { return null; }
  const prefix = '/backend-api';
  if (!parsed.pathname.startsWith(prefix)) return null;
  const backendPath = parsed.pathname.slice(prefix.length) || '/';
  if (!codexBootstrapPathPatterns.some(pattern => pattern.test(backendPath))) return null;
  return {
    path: backendPath,
    upstreamUrl: 'https://chatgpt.com/backend-api' + backendPath + parsed.search,
  };
}
// Native Codex's image tool uses the same model-provider base URL as Responses,
// but calls these sibling endpoints. Keep image generation on the official
// ChatGPT backend rather than treating its image-model name as an ASS alias.
function codexImagesRequest(url, method) {
  const match = method === 'POST' && /^\/v1\/images\/(generations|edits)$/.exec(url);
  return match ? { upstreamUrl: 'https://chatgpt.com/backend-api/codex/images/' + match[1] } : null;
}
function codexWorkspaceRequest(url, method) {
  if (!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method) ||
      typeof url !== 'string' || !url.startsWith('/backend-api/') || /[\\\r\n]/.test(url)) return null;
  const parsed = new URL(url, 'https://chatgpt.com');
  if (parsed.origin !== 'https://chatgpt.com' || !parsed.pathname.startsWith('/backend-api/')) return null;
  return { upstreamUrl: parsed.origin + parsed.pathname + parsed.search };
}
function upstreamDiagnostics(response, secrets) {
  const headers = Object.fromEntries(Object.entries(upstreamResponseHeaders(response.headers, secrets))
    .filter(([key]) => diagnosticNames.has(key) || key.startsWith('x-ratelimit-'))
    .slice(0, 32).map(([key, value]) => [key, redact(value, secrets).slice(0, 512)]));
  return { status: response.status, headers };
}
function summarizeUpstreamError(sample, status, contentType = '', secrets = []) {
  const text = redact(sample, secrets);
  let message = '上游返回 HTTP ' + status;
  const values = [];
  try {
    values.push(JSON.parse(text));
  } catch {}
  if (!values.length && /(?:^|[\r\n])data:/.test(text)) {
    for (const frame of text.replace(/\r\n?/g, '\n').split('\n\n')) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      try { values.push(JSON.parse(data)); } catch {}
    }
  }
  for (const value of values) {
    const detail = value?.error || value?.response?.error || value?.detail;
    const prose = typeof detail === 'string' ? detail : detail?.message || value?.message;
    if (typeof prose !== 'string' || !prose) continue;
    const param = typeof detail?.param === 'string' && detail.param ? `（${detail.param}）` : '';
    return { message: redact(prose + param, secrets).slice(0, 500), kind: /(?:^|[\r\n])data:/.test(text) ? 'sse_error' : 'json' };
  }
  if (values.length) return { message, kind: 'json' };
  if (/text\/html/i.test(contentType) || /<!doctype\s+html|<html\b/i.test(text)) {
    const title = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || '')
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { message: message + '（HTML 网关错误页）' + (title ? '：' + title : ''),
      kind: 'html_gateway', ...(title ? { title } : {}) };
  }
  return { message, kind: text ? 'text' : 'empty' };
}

// Preserve the complete error body, with backpressure, without buffering/logging
// an entire gateway page. Hold only a secret-sized suffix to redact credentials
// even when the server splits them (or UTF-8 characters) across chunks.
async function forwardErrorBody(response, write, secrets = []) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...values.map(value => value.length - 1));
  const decoder = new StringDecoder('utf8');
  let pending = '', sample = '';
  async function flush(text, final = false) {
    pending += text;
    const limit = final ? pending.length : Math.max(0, pending.length - keep);
    let cursor = 0, output = '';
    while (cursor < limit) {
      let index = limit, matched;
      for (const value of values) {
        const found = pending.indexOf(value, cursor);
        if (found >= cursor && found < index) { index = found; matched = value; }
      }
      output += pending.slice(cursor, index);
      if (matched) { output += '[REDACTED]'; cursor = index + matched.length; }
      else cursor = limit;
    }
    pending = pending.slice(cursor);
    if (output) {
      sample += output.slice(0, Math.max(0, 4096 - sample.length));
      await write(output);
    }
  }
  if (response.body) for await (const chunk of response.body)
    await flush(decoder.write(Buffer.from(chunk)));
  await flush(decoder.end(), true);
  return sample;
}

module.exports = {
  officialRequestHeaders, upstreamResponseHeaders, upstreamDiagnostics,
  summarizeUpstreamError, forwardErrorBody, redact, codexBootstrapRequest, codexImagesRequest, codexWorkspaceRequest,
};
