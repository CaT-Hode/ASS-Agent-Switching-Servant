const crypto = require("node:crypto");
const { RequestMetrics } = require("./request-metrics.cjs");
const { authorized } = require("./harness-route.cjs");
const { readJSON } = require("./request-body.cjs");
const { write } = require("./stream-write.cjs");
const { protocolEndpoint, providerSessionHeaders } = require("./provider-transport.cjs");
const { forwardErrorBody, summarizeUpstreamError, redact, upstreamRequestId } = require("./http-passthrough.cjs");
const { requestFailure } = require('./diagnostic-failure.cjs');
const { agyGatewayModels, resolveAgyModel, resolveAgyRoute } = require("./agy-injection.cjs");
const { geminiError, geminiRequest, geminiEvents, geminiJSON } = require("./gemini-adapter.cjs");
const {
  openaiError,
  chatUpstreamRequest,
  chatCompletionEvents,
  chatCompletionJSON,
} = require("./agy-chat-adapter.cjs");

function geminiModelEntry(item) {
  return {
    name: `models/${item.id}`,
    displayName: item.displayLabel || item.label,
    description: `${item.providerName} · ${item.model} (${item.protocol})`,
    inputTokenLimit: item.contextWindow,
    outputTokenLimit: item.maxOutputTokens,
    ...(item.thinking ? { thinking: true } : {}),
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  };
}

function openaiModelEntry(item) {
  return {
    id: item.id,
    object: "model",
    created: 1700000000,
    owned_by: item.providerName,
    context_window: item.contextWindow,
    max_output_tokens: item.maxOutputTokens,
  };
}

function isOpenAiChatPath(pathname) {
  return pathname === "/v1/chat/completions" || pathname === "/chat/completions";
}

function isOpenAiModelsPath(pathname) {
  return pathname === "/v1/models";
}

function isGeminiModelsListPath(pathname) {
  return pathname === "/v1beta/models" || pathname === "/models" || pathname === "/v1/beta/models";
}

function matchGeminiSingleModelPath(pathname) {
  const m = /^(?:\/v1beta)?\/models\/([^/:]+)$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function forwardAntigravity(router, req, res) {
  const began = Date.now();
  const controller = new AbortController();
  const metrics = new RequestMetrics({ began });
  const requestId = crypto.randomUUID();
  const pathname = String(req.url || "").split("?")[0];
  const openaiMode = isOpenAiChatPath(pathname) || isOpenAiModelsPath(pathname);
  const formatError = (status, message, code) =>
    openaiMode ? openaiError(status, message, code) : geminiError(status, message);

  let timer;
  const armTimeout = (idle = false) => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          Object.assign(
            new Error(idle ? "上游连续 5 分钟未返回数据，请重试" : "上游请求超过 5 分钟，请重试"),
            { name: "TimeoutError", code: idle ? "upstream_idle_timeout" : "upstream_timeout", status: 504 },
          ),
        ),
      300000,
    );
  };

  let route;
  let httpStatus = null;
  let upstreamId, upstreamFailure;
  let failureLayer = 'local';
  const credential = String(req.headers["x-goog-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
  const secrets = [credential, router.clientToken].filter(Boolean);

  try {
    const state = router.getState("antigravity") || {};
    const expectedToken = state.localToken || router.clientToken;
    if (!authorized(credential, expectedToken)) {
      throw Object.assign(Error("Antigravity 路由凭据无效，请从 ASS 重新启动 agy 模型终端"), { status: 401 });
    }

    // Dynamic model discovery endpoints for AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai|openai
    if (req.method === "GET") {
      const catalog = agyGatewayModels(state.providers || [], state.capabilities || {}, state.defaultModel || null);
      if (isGeminiModelsListPath(pathname)) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ models: catalog.map(geminiModelEntry) }));
        return;
      }
      if (isOpenAiModelsPath(pathname)) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ object: "list", data: catalog.map(openaiModelEntry) }));
        return;
      }
      const singleId = matchGeminiSingleModelPath(pathname);
      if (singleId) {
        const found = catalog.find((item) => item.id === singleId || item.baseRouteId === singleId);
        if (!found) {
          throw Object.assign(Error(`模型 ${singleId} 未启用或不存在`), { status: 404 });
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(geminiModelEntry(found)));
        return;
      }
      throw Object.assign(Error("未知 Antigravity GET 路由"), { status: 404 });
    }

    if (req.method !== "POST") {
      throw Object.assign(Error("仅支持 GET / POST"), { status: 405 });
    }

    const body = await readJSON(req);
    const chatWire = isOpenAiChatPath(pathname);
    route = chatWire ? { ...resolveAgyModel(body?.model, state), stream: body?.stream !== false } : resolveAgyRoute(req.url, state);
    const { provider, model, stream } = route;
    const protocol = model.wireApi;
    secrets.push(provider.apiKey);

    const pending = router.requests.get(req);
    router.monitorRequest(
      req,
      {
        requestId,
        model: model.model,
        source: provider.name,
        protocol,
        providerId: provider.id,
      },
      metrics,
    );

    const directChatPassthrough = chatWire && protocol === "openai-chat";
    const upstreamBody = chatWire
      ? chatUpstreamRequest(body, model, protocol, route.effort || null)
      : geminiRequest(body, model, protocol, route.effort || null);

    const headers = {
      ...provider.extraHeaders,
      ...providerSessionHeaders(provider, req.headers),
      "content-type": "application/json",
      accept: directChatPassthrough && !stream ? "application/json" : "text/event-stream",
    };
    if (protocol === "anthropic") {
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = "Bearer " + provider.apiKey;
    }

    router.active++;
    router.controllers.add(controller);
    armTimeout(true);
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const upstreamUrl = protocolEndpoint(provider, protocol);
    failureLayer = 'network';
    const upstreamResponse = await router.fetch(
      upstreamUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      },
      provider.network,
    );
    armTimeout(true);
    const response = metrics.observe(upstreamResponse, controller.signal, () => armTimeout(true));
    httpStatus = response.status;
    failureLayer = 'upstream';
    upstreamId = upstreamRequestId(response.headers, secrets);
    if (pending?.monitor) Object.assign(pending.monitor, { httpStatus, upstreamRequestId: upstreamId });

    if (!response.ok) {
      const sample = await forwardErrorBody(response, () => {}, secrets);
      const summary = summarizeUpstreamError(sample, response.status, response.headers.get("content-type"), secrets);
      upstreamFailure = summary.diagnostic;
      throw Object.assign(Error(summary.message), { status: response.status, code: "upstream_http_error" });
    }
    if (stream || !directChatPassthrough) failureLayer = 'stream';

    if (directChatPassthrough) {
      const contentType = response.headers.get("content-type") || (stream ? "text/event-stream" : "application/json");
      res.writeHead(200, {
        "content-type": contentType,
        ...(stream ? { "cache-control": "no-cache" } : {}),
        "x-ass-provider": provider.id,
        "x-ass-request-id": requestId,
      });
      if (stream) res.flushHeaders();
      if (response.body) {
        for await (const chunk of response.body) {
          await write(res, chunk);
        }
      }
    } else if (chatWire) {
      const events = chatCompletionEvents(response.body, protocol, model.model, controller.signal);
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-ass-provider": provider.id,
          "x-ass-request-id": requestId,
        });
        res.flushHeaders();
        for await (const chunk of events) {
          await write(res, `data: ${JSON.stringify(chunk)}\n\n`);
        }
        await write(res, "data: [DONE]\n\n");
      } else {
        const payload = await chatCompletionJSON(events);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-ass-provider": provider.id,
          "x-ass-request-id": requestId,
        });
        await write(res, JSON.stringify(payload));
      }
    } else {
      const events = geminiEvents(response.body, protocol, model.model, controller.signal);
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-ass-provider": provider.id,
          "x-ass-request-id": requestId,
        });
        res.flushHeaders();
        for await (const chunk of events) {
          await write(res, `data: ${JSON.stringify(chunk)}\n\n`);
        }
      } else {
        const payload = await geminiJSON(events);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-ass-provider": provider.id,
          "x-ass-request-id": requestId,
        });
        await write(res, JSON.stringify(payload));
      }
    }
    res.end();

    const taskFailure = metrics.taskFailure;
    router.log({
      time: new Date().toISOString(),
      source: provider.name,
      model: model.model,
      status: response.status,
      ms: Date.now() - began,
      ok: !taskFailure,
      httpStatus,
      httpOk: httpStatus >= 200 && httpStatus < 300,
      taskOk: !taskFailure,
      ...(taskFailure ? { error: taskFailure.message, failure: taskFailure.failure } : {}),
      requestId,
      upstreamRequestId: upstreamId,
      client: "antigravity",
      protocol,
      providerId: provider.id,
      startedAt: new Date(began).toISOString(),
      ...metrics.snapshot(),
    });
  } catch (error) {
    if (controller.signal.reason?.name === "TimeoutError") error = controller.signal.reason;
    const failure = upstreamFailure || metrics.taskFailure || requestFailure(error, { httpStatus, layer: failureLayer, signal: controller.signal });
    const status = error.status || 502;
    let message =
      controller.signal.aborted && error.name !== "TimeoutError"
        ? "请求已取消"
        : error instanceof SyntaxError
          ? "请求或上游流中的 JSON 数据无效"
          : error.message;
    message = redact(message, secrets);

    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(formatError(status, message, error.code)));
    } else if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(formatError(status, message, error.code))}\n\n`);
      res.end();
    }

    router.log({
      time: new Date().toISOString(),
      source: route?.provider?.name || "Antigravity",
      model: route?.model?.model || "",
      status,
      ms: Date.now() - began,
      ok: false,
      httpStatus,
      httpOk: httpStatus !== null && httpStatus >= 200 && httpStatus < 300,
      taskOk: false,
      error: failure.message, failure: failure.failure,
      requestId,
      upstreamRequestId: upstreamId,
      client: "antigravity",
      protocol: route?.model?.wireApi,
      providerId: route?.provider?.id,
      startedAt: new Date(began).toISOString(),
      ...metrics.snapshot(),
    });
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (router.controllers.delete(controller)) router.active--;
  }
}

module.exports = { forwardAntigravity };
