const crypto = require("node:crypto");
const { RequestMetrics } = require('./request-metrics.cjs');
const { readTaskJSON } = require('./task-outcome.cjs');
const { endpoint, codexProviderId } = require("./models.cjs");
const { sseMessages } = require("./adapters.cjs");
const { write: writeResponse } = require("./stream-write.cjs");
const { readJSON } = require("./request-body.cjs");
const { messagesTransport, providerSessionHeaders } = require("./provider-transport.cjs");
const { messagesRequest, messagesEvents, messagesJSON, normalizeMessages } = require("./messages-adapter.cjs");
const { claudeModels, resolveClaudeModel } = require("./claude-models.cjs");
const { withOutputLimit } = require('./output-tokens.cjs');
const { classifyFailure, requestFailure, responseFailure } = require('./diagnostic-failure.cjs');
const { upstreamRequestId } = require('./http-passthrough.cjs');
function authorized(value, token) {
  const a = Buffer.from(value || ""),
    b = Buffer.from(token || "");
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function harnessRoute(url, body, state) {
  // Claude's base URL is process-wide. Namespaced model IDs allow /model to
  // select any injected Messages model without changing the logged-in account.
  if (/^\/models\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(url)) {
    body.model = resolveClaudeModel(state.providers, body.model);
    const split = typeof body.model === "string" ? body.model.indexOf("::") : -1;
    if (split < 1) throw Object.assign(new Error("请选择完整的供应商::模型 ID"), { status: 400 });
    const provider = state.providers.find(p => p.enabled && codexProviderId(p.id) === body.model.slice(0, split));
    if (!provider) throw Object.assign(new Error("请选择 ASS 注入的模型 ID"), { status: 404 });
    body.model = body.model.slice(split + 2);
    url = url.replace("/models/", "/harness/" + provider.id + "/");
  }
  const match =
    /^\/harness\/([\w-]+)\/v1\/(responses(?:\/compact)?|messages(?:\/count_tokens)?|chat\/completions)(?:\?[^#]*)?$/.exec(
      url,
    );
  if (!match) throw Object.assign(new Error("未知客户端路由"), { status: 404 });
  const p = state.providers.find((p) => p.id === match[1] && p.enabled);
  // Claude's Default/long-context choice can append a documented UI suffix.
  // It is not part of the provider's model ID; only normalize to an exact
  // enabled entry, never choose another model or a built-in fallback.
  let m = p?.models.find((m) => m.enabled && m.model === body.model);
  if (!m && match[2].startsWith("messages") && typeof body.model === "string" && /\[1m\]$/i.test(body.model)) {
    m = p?.models.find((m) => m.enabled && m.model === body.model.replace(/\[1m\]$/i, ""));
    if (m) body.model = m.model;
  }
  if (!p || !m)
    throw Object.assign(new Error("该账户或模型未启用"), { status: 404 });
  if (!p.apiKey)
    throw Object.assign(new Error("该账户缺少 API Key"), { status: 401 });
  const protocol = match[2].startsWith("messages")
    ? "anthropic"
    : match[2] === "chat/completions"
      ? "openai-chat"
      : "openai-responses";
  if (protocol !== m.wireApi && protocol !== "anthropic")
    throw Object.assign(
      new Error("客户端协议与所选模型不一致，请重新选择兼容模型"),
      { status: 400 },
    );
  const suffix = match[2].endsWith("/count_tokens")
    ? "/count_tokens"
    : match[2].endsWith("/compact")
      ? "/compact"
      : "";
  const transport = protocol === "anthropic" ? messagesTransport(p, m) : null;
  if (transport?.adapted && suffix)
    throw Object.assign(Error("此跨协议模型没有精确 token 计数接口"), { status: 501 });
  if (!suffix) Object.assign(body, withOutputLimit(body, m, protocol));
  return {
    p,
    m,
    protocol: transport?.protocol || protocol,
    adapted: transport?.adapted || false,
    url: transport ? transport.url + suffix : endpoint(p.baseUrl, protocol, suffix),
    stream: body.stream === true && !suffix,
  };
}
async function forwardHarness(router, req, res) {
  const began = Date.now(),
    controller = new AbortController();
  const metrics = new RequestMetrics({ began }), requestId = crypto.randomUUID();
  const client = router.requests.get(req)?.client;
  let route, timer, httpStatus = null, upstreamId, upstreamFailure;
  let failureLayer = 'local';
  const secrets = [router.clientToken, req.headers['x-api-key'], req.headers.authorization?.replace(/^Bearer /i, '')];
  const operation = /\/count_tokens/.test(req.url) ? 'count_tokens' : /\/compact/.test(req.url) ? 'compaction' : undefined;
  const write = value => writeResponse(res, value);
  try {
    const credential =
      req.headers["x-api-key"] ||
      req.headers.authorization?.replace(/^Bearer /i, "");
    const state = router.getState(client);
    // Accountless mode accepts the local token, plus the retained native grant
    // for Codex conversations that still belong to the built-in provider.
    if (!router.authorizeLocal(client, state, credential))
      throw Object.assign(
        new Error("客户端路由凭据已失效，请从 ASS 重新启动客户端"),
        { status: 401 },
      );
    if (req.method === "GET" && /^\/models\/v1\/models(?:\?[^#]*)?$/.test(req.url)) {
      const data = claudeModels(state.providers).map(m => ({
        id: m.discoveryId, type: "model", display_name: m.label, description: m.description, created_at: "2026-01-01T00:00:00Z",
        ...(m.claudeIdentity ? { anthropic_family_tier: m.claudeIdentity.tier } : {}),
      }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null }));
      return;
    }
    if (req.method !== "POST")
      throw Object.assign(new Error("仅支持 POST"), { status: 405 });
    const body = await readJSON(req);
    route = harnessRoute(req.url, body, state);
    const { p, m, protocol } = route;
    secrets.push(p.apiKey);
    const pending = router.requests.get(req);
    if (operation !== 'count_tokens') router.monitorRequest(req, {
      requestId, model: m.model, source: p.name, protocol, providerId: p.id,
      ...(operation ? { operation } : {}),
    }, metrics);
    const headers = {
      ...p.extraHeaders,
      ...providerSessionHeaders(p, req.headers),
      "content-type": "application/json",
      accept: route.stream || route.adapted ? "text/event-stream" : "application/json",
    };
    if (protocol === "anthropic") {
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      if (req.headers["anthropic-beta"])
        headers["anthropic-beta"] = req.headers["anthropic-beta"];
    } else headers.authorization = "Bearer " + p.apiKey;
    router.active++;
    router.controllers.add(controller);
    timer = setTimeout(() => controller.abort(Object.assign(Error('上游请求超过 5 分钟，请重试'),
      { name: 'TimeoutError', code: 'upstream_timeout' })), 300000);
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const upstreamBody = JSON.stringify(route.adapted ? messagesRequest(body, m, protocol) : protocol === "anthropic" ? normalizeMessages(body) : body);
    failureLayer = 'network';
    const upstreamResponse = await router.fetch(
      route.url,
      {
        method: "POST",
        headers,
        body: upstreamBody,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      },
      p.network,
    );
    const response = metrics.observe(upstreamResponse, controller.signal);
    httpStatus = response.status;
    failureLayer = 'upstream';
    upstreamId = upstreamRequestId(response.headers, secrets);
    if (pending?.monitor) Object.assign(pending.monitor, { httpStatus, upstreamRequestId: upstreamId });
    if (!response.ok) {
      upstreamFailure = await responseFailure(response, { signal: controller.signal });
      throw Object.assign(
        new Error(
          "上游返回 HTTP " + response.status + "；请检查账户、模型和协议",
        ),
        { status: response.status },
      );
    }
    if (route.adapted || route.stream) failureLayer = 'stream';
    if (route.adapted) {
      const events = messagesEvents(response.body, protocol, m.model, body.stop_sequences);
      if (route.stream) {
        res.writeHead(response.status, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.flushHeaders();
        for await (const event of events) await write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
      } else {
        const result = await messagesJSON(events);
        res.writeHead(response.status, { "content-type": "application/json" });
        await write(JSON.stringify(result));
      }
    } else if (route.stream) {
      res.writeHead(response.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      let terminal = false;
      for await (const event of sseMessages(response.body, controller.signal)) {
        if (
          event.type === "error" ||
          event.type === "response.failed" ||
          event.error
        )
          throw Object.assign(Error('上游返回错误事件'), {
            diagnostic: classifyFailure(null, { httpStatus, layer: 'stream', body: event }),
          });
        if (
          (protocol === "anthropic" && event.type === "message_stop") ||
          (protocol === "openai-chat" &&
            event.done) ||
          (protocol === "openai-responses" &&
            ["response.completed", "response.incomplete"].includes(event.type))
        )
          terminal = true;
        if (event.done) await write("data: [DONE]\n\n");
        else
          await write(
            (event.type ? "event: " + event.type + "\n" : "") +
              "data: " +
              JSON.stringify(event) +
              "\n\n",
          );
        if (terminal) break;
      }
      if (!terminal) throw new Error("上游流提前结束");
    } else {
      const { text } = await readTaskJSON(response);
      res.writeHead(response.status, { "content-type": "application/json" });
      await write(text);
    }
    res.end();
    router.log({
      time: new Date().toISOString(),
      source: p.name,
      model: m.model,
      status: response.status,
      ms: Date.now() - began,
      ok: true,
      httpStatus, httpOk: httpStatus >= 200 && httpStatus < 300, taskOk: true,
      requestId, upstreamRequestId: upstreamId, client, protocol, providerId: p.id, ...metrics.snapshot(),
      startedAt: new Date(began).toISOString(),
      ...(operation ? { operation } : {}),
    });
  } catch (error) {
    const failure = upstreamFailure || metrics.taskFailure || requestFailure(error, { httpStatus, layer: failureLayer, signal: controller.signal });
    // Never put raw provider error bodies or parser excerpts into logs.
    let message =
      error instanceof SyntaxError
        ? "上游返回无效流数据"
        : controller.signal.aborted
          ? "请求取消或超时"
          : error.message;
    for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[REDACTED]');
    if (!res.headersSent) {
      res.writeHead(error.status || 502, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message },
        }),
      );
    } else if (!res.destroyed) {
      res.end(
        "event: error\ndata: " +
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "上游流中断" },
          }) +
          "\n\n",
      );
    }
    router.log({
      time: new Date().toISOString(),
      source: route?.p.name || "客户端",
      model: route?.m.model || "",
      status: error.status || 502,
      ms: Date.now() - began,
      ok: false,
      httpStatus, httpOk: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, taskOk: false,
      error: failure.message, failure: failure.failure,
      requestId, upstreamRequestId: upstreamId, client, protocol: route?.protocol, providerId: route?.p.id, ...metrics.snapshot(),
      startedAt: new Date(began).toISOString(),
      ...(operation ? { operation } : {}),
    });
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (router.controllers.delete(controller)) router.active--;
  }
}
module.exports = { harnessRoute, authorized, forwardHarness };
