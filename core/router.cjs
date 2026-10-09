const http = require("node:http");
const { endpoint, normalizeEffort, codexProviderId } = require("./models.cjs");
const { convertRequest, translateStream } = require("./adapters.cjs");
const { SseMonitor } = require("./sse-monitor.cjs");
const { readTaskJSON } = require('./task-outcome.cjs');
const { forwardHarness, authorized } = require("./harness-route.cjs");
const { providerSessionHeaders, protocolEndpoint } = require("./provider-transport.cjs");
const crypto = require("node:crypto");
const { toolBridge } = require("./tool-bridge.cjs");
const { readJSON } = require("./request-body.cjs");
const { officialCodexHistory } = require("./response-history.cjs");
const forwarded = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "session_id",
  "conversation_id",
  "originator",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-openai-subagent",
  "x-openai-parent-request-id",
];
const pickHeaders = (h) =>
  Object.fromEntries(forwarded.filter((k) => h[k]).map((k) => [k, h[k]]));
async function write(res, data) {
  if (res.destroyed) throw Error("客户端已断开");
  if (!res.write(data)) await new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", done); res.off("close", closed); res.off("error", failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const closed = () => failed(Error("客户端已断开"));
    res.once("drain", done); res.once("close", closed); res.once("error", failed);
  });
}
function routeFor(body, state, suffix = "") {
  if (typeof body.model !== "string" || !body.model)
    throw Object.assign(new Error("请求缺少 model"), { status: 400 });
  const split = body.model.indexOf("::");
  if (split < 0)
    return {
      source: "OpenAI 官方",
      url: "https://chatgpt.com/backend-api/codex/responses" + suffix,
      protocol: "openai-responses",
      network: "system",
      body: officialCodexHistory(body),
      official: true,
    };
  const namespace = body.model.slice(0, split);
  const candidates = state.providers.filter((p) => p.enabled && codexProviderId(p.id) === namespace);
  if (candidates.length > 1) throw Object.assign(new Error("模型路由标识冲突，请检查供应商配置"), { status: 409 });
  const p = candidates[0];
  const m = p?.models.find(
    (m) => m.model === body.model.slice(split + 2) && m.enabled,
  );
  if (!m)
    throw Object.assign(
      new Error("供应商或模型未启用；请在 ASS 检查配置"),
      { status: 404 },
    );
  if (!p.apiKey)
    throw Object.assign(new Error("供应商缺少 API Key"), { status: 401 });
  if (suffix && m.wireApi !== "openai-responses")
    throw Object.assign(
      new Error("该协议不支持服务端 compact，请使用完整历史或客户端压缩"),
      { status: 400 },
    );
  const updated = { ...body, model: m.model };
  if (updated.reasoning?.effort)
    updated.reasoning = {
      ...updated.reasoning,
      effort: normalizeEffort(updated.reasoning.effort),
    };
  else
    updated.reasoning = {
      ...(updated.reasoning || {}),
      effort: normalizeEffort(m.defaultEffort),
    };
  return {
    source: p.name,
    url: protocolEndpoint(p, m.wireApi, suffix),
    protocol: m.wireApi,
    network: p.network,
    provider: p,
    model: m,
    body: updated,
    official: false,
  };
}
class Router {
  constructor({
    getState,
    fetchUpstream,
    log = () => {},
    allowClient = () => true,
    onActivity = () => {},
  }) {
    this.getState = getState;
    this.fetch = fetchUpstream;
    this.log = log;
    this.allowClient = allowClient;
    this.onActivity = onActivity;
    this.requests = new Map();
    this.server = null;
    this.controllers = new Set();
    this.active = 0;
    this.port = 25819;
    this.clientToken = crypto.randomBytes(32).toString("hex");
  }
  async start(port = this.port) {
    if (this.starting) return this.starting;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw Error("无效本机端口");
    if (!this.server) this.port = port;
    if (this.server) return;
    const server = http.createServer((q, s) => this.handle(q, s));
    // Retained built-in OpenAI sessions enable WS independently of our custom
    // provider. Codex explicitly treats 426 as HTTP/SSE fallback (not 405).
    // Never upgrade or forward auth during this transport negotiation.
    server.on("upgrade", (req, socket) => {
      const local = !req.headers.origin && req.headers["sec-fetch-site"] !== "cross-site" &&
        [`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host);
      const route = req.url === "/clients/ASS/v1/responses";
      const status = !local ? "403 Forbidden" : !route ? "404 Not Found" :
        !this.allowClient("codex") ? "503 Service Unavailable" : "426 Upgrade Required";
      socket.on("error", () => {});
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    server.requestTimeout = 300000;
    server.headersTimeout = 60000;
    this.starting = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", resolve);
    })
      .then(() => {
        this.server = server;
        this.port = server.address().port;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    if (!this.server) return;
    for (const c of this.controllers) c.abort();
    const s = this.server;
    this.server = null;
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  clientActive(id) {
    return [...this.requests.values()].filter((r) => !id || r.client === id)
      .length;
  }
  async cancelClient(id) {
    if (!["codex", "claude", "opencode", "pi", "dsh"].includes(id)) throw Error("无效的请求终止范围");
    // The caller blocks new admissions first. Never abort another client's or
    // a diagnostic request when restarting one desktop.
    for (const [req, pending] of this.requests) if (pending.client === id) {
      pending.controller.abort();
      pending.res.destroy();
      req.destroy();
    }
    const deadline = Date.now() + 2000;
    while (this.clientActive(id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.clientActive(id)) throw Error("客户端请求尚未结束，未继续切换配置");
  }
  async handle(req, res) {
    const began = Date.now();
    let route;
    const controller = new AbortController();
    let timer;
    let httpStatus = null;
    try {
      const expected = `127.0.0.1:${this.port}`;
      if (
        req.headers.origin ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.host !== expected &&
          req.headers.host !== `localhost:${this.port}`)
      )
        throw Object.assign(new Error("仅允许本机应用请求"), { status: 403 });
      if (req.url !== "/health") {
        if (/^\/(?:clients\/codex|v1)(?:\/|$)/.test(req.url))
          throw Object.assign(Error("旧路由入口已移除，请重新同步 ASS 接入配置"), { status: 404 });
        const scoped = /^\/clients\/(ASS|claude|opencode|pi|dsh)(\/.*)$/.exec(
          req.url,
        );
        let client =
          scoped?.[1] || (req.url.startsWith("/harness/") ? "legacy" : "codex");
        if (client === "ASS") client = "codex"; // Public route name; same auth, isolation and lifecycle.
        if (scoped) req.url = scoped[2];
        if (req.url.startsWith("/diagnostics/")) {
          if (req.headers["x-ass-probe-token"] !== this.clientToken)
            throw Object.assign(new Error("无效检测凭据"), { status: 401 });
          client = "diagnostics";
          req.url = req.url.slice("/diagnostics".length);
          if (!this.allowClient(client))
            throw Object.assign(new Error("接入正在切换，请稍后检测"), {
              status: 503,
            });
        } else if (!this.allowClient(client)) {
          throw Object.assign(
            new Error(
              "此客户端的 ASS 接入已关闭或正在切换，请从客户端页面重新接入",
            ),
            { status: 503 },
          );
        }
        // Count at admission, including uploads: a stop must not race a request body.
        this.requests.set(req, { client, res, controller });
        this.onActivity();
      }
      if (req.url.startsWith("/harness/") || req.url.startsWith("/models/")) {
        await forwardHarness(this, req, res);
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ service: "ass", version: 1, active: this.active }),
        );
        return;
      }
      const match = /^\/v1\/responses(\/compact)?$/.exec(req.url);
      if (req.method !== "POST" || !match)
        throw Object.assign(
          new Error("此路由仅支持 POST /v1/responses 或 /compact"),
          { status: 404 },
        );
      if (!/^Bearer\s+\S+$/i.test(req.headers.authorization || ""))
        throw Object.assign(new Error("需要 Codex 登录凭据"), { status: 401 });
      const body = await readJSON(req);
      const state = this.getState(this.requests.get(req)?.client);
      if (state.accountless) {
        if (!authorized(req.headers.authorization.replace(/^Bearer\s+/i, ""), state.localToken))
          throw Object.assign(Error("无账号模式已启用，请重新启动客户端加载本机接入凭据"), { status: 401 });
        if (typeof body.model !== "string" || !body.model.includes("::"))
          throw Object.assign(Error("无账号模式仅允许使用已注入的模型"), { status: 403 });
      }
      route = routeFor(body, state, match[1] || "");
      if (route.official && req.headers.authorization.replace(/^Bearer\s+/i, "") === this.clientToken)
        throw Object.assign(new Error("此窗口使用模型 API 凭据，不能请求 ChatGPT 订阅模型；请从官方账户卡片启动"), { status: 403 });
      const headers = route.official
        ? pickHeaders(req.headers)
        : { ...route.provider.extraHeaders, ...providerSessionHeaders(route.provider, req.headers) };
      headers["content-type"] = "application/json";
      headers.accept = "text/event-stream";
      if (!route.official) {
        if (route.protocol === "anthropic") {
          headers["x-api-key"] = route.provider.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else headers.authorization = "Bearer " + route.provider.apiKey;
      }
      const bridge = route.protocol !== "openai-responses" ? toolBridge(route.body) : null;
      const request =
        route.protocol === "openai-responses"
          ? route.body
          : convertRequest(bridge.request, route.model, route.protocol);
      this.active++;
      this.controllers.add(controller);
      timer = setTimeout(() => controller.abort(), 300000);
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const response = await this.fetch(
        route.url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
        },
        route.network,
      );
      httpStatus = response.status;
      if (!response.ok) {
        const raw = (await response.text()).slice(0, 4000);
        let message = "上游返回 HTTP " + response.status;
        try {
          const parsed = JSON.parse(raw);
          message = String(
            parsed.error?.message || parsed.detail || message,
          ).slice(0, 500);
        } catch {
          if (raw.includes("<html")) message += "（HTML 网关错误页）";
        }
        for (const key of [
          route.provider?.apiKey,
          req.headers.authorization?.replace(/^Bearer /i, ""),
        ].filter(Boolean))
          message = message.split(key).join("[REDACTED]");
        throw Object.assign(new Error(message), { status: response.status });
      }
      if (route.protocol === "openai-responses") {
        let contentType = response.headers.get("content-type");
        const streaming = body.stream !== false && !match[1];
        if (!streaming) {
          const { text } = await readTaskJSON(response);
          res.writeHead(response.status, { 'content-type': 'application/json', 'x-ass-provider': route.official ? 'official' : route.provider.id });
          await write(res, text);
        } else {
        const reader = response.body.getReader();
        const monitor = streaming ? new SseMonitor() : null;
        try {
          let first;
          if (
            streaming &&
            (!contentType || !contentType.includes("text/event-stream"))
          ) {
            // Some trusted enterprise gateways omit Content-Type. Verify bytes, never accept HTML/JSON as SSE.
            const chunks = [];
            let length = 0;
            let sample = "";
            while (length < 16384) {
              const next = await reader.read();
              if (next.done) break;
              chunks.push(Buffer.from(next.value));
              length += next.value.length;
              sample = Buffer.concat(chunks).toString("utf8");
              if (sample.includes("\n")) break;
            }
            if (!/^\s*(?:event:|data:|:)/.test(sample))
              throw Object.assign(
                new Error("上游未返回 SSE 流，请检查模型协议设置"),
                { status: 502 },
              );
            first = Buffer.concat(chunks);
            contentType = "text/event-stream";
          }
          res.writeHead(response.status, {
            "content-type": contentType || "application/json",
            "cache-control": "no-cache",
            "x-ass-provider": route.official ? "official" : route.provider.id,
          });
          res.flushHeaders();
          if (first) {
            if (monitor) { for (const frame of monitor.feed(first)) await write(res, frame); }
            else await write(res, first);
          }
          while (!monitor?.ended) {
            const { value, done } = await reader.read();
            if (done) {
              if (monitor) { for (const frame of monitor.feed(null, true)) await write(res, frame); }
              break;
            }
            if (monitor) { for (const frame of monitor.feed(value)) await write(res, frame); }
            else await write(res, Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        }
      } else if (body.stream === false) {
        let final;
        for await (const event of bridge.restore(translateStream(
          response.body,
          route.protocol,
          body.model,
        )))
          if (
            event.response?.status === "completed" ||
            event.response?.status === "incomplete"
          )
            final = event.response;
        res.writeHead(200, { "content-type": "application/json" });
        res.write(JSON.stringify(final));
      } else {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.flushHeaders();
        for await (const event of bridge.restore(translateStream(
          response.body,
          route.protocol,
          body.model,
        )))
          await write(
            res,
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
      }
      res.end();
      this.log({
        time: new Date().toISOString(),
        source: route.source,
        model: body.model,
        status: response.status,
        ms: Date.now() - began,
        ok: true,
        httpStatus, httpOk: httpStatus >= 200 && httpStatus < 300, taskOk: true,
      });
    } catch (error) {
      let message = controller.signal.aborted
        ? "请求已取消或超过 5 分钟"
        : error instanceof SyntaxError
          ? "请求或上游流中的 JSON 数据无效"
          : error.message;
      for (const secret of [
        route?.provider?.apiKey,
        req.headers.authorization?.replace(/^Bearer /i, ""),
      ].filter(Boolean))
        message = message.split(secret).join("[REDACTED]");
      if (res.headersSent) {
        if (!res.destroyed) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: "stream_failed", message: "上游流中断，请重试" } })}\n\n`,
          );
          res.end();
        }
      } else {
        res.writeHead(error.status || 502, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: { code: error.code || "route_error", message },
          }),
        );
      }
      this.log({
        time: new Date().toISOString(),
        source: route?.source || "本地",
        model: route?.body.model || "",
        status: error.status || 502,
        ms: Date.now() - began,
        ok: false,
        httpStatus, httpOk: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, taskOk: false,
        error: message.slice(0, 500),
      });
    } finally {
      this.requests.delete(req);
      controller.abort();
      clearTimeout(timer);
      if (this.controllers.delete(controller)) this.active--;
      this.onActivity();
    }
  }
}
module.exports = { Router, routeFor };
