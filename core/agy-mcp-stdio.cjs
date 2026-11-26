#!/usr/bin/env node
// Standalone zero-dependency MCP (Model Context Protocol) stdio server for ASS.
// Bridges Antigravity Desktop / CLI / IDE (running under a personal Google Account)
// to ASS-configured third-party models and headless agy workers via loopback HTTP.
// Never prints non-JSON-RPC output to stdout; never reads or exposes provider keys.
const fs = require("node:fs");
const http = require("node:http");

const SUPPORTED_PROTOCOLS = new Set(["2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL = "2025-03-26";
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const TOOLS = [
  {
    name: "ass_list_models",
    description:
      "List all enabled third-party models configured in ASS (Agent-Switching-Servant) for Antigravity, including routeId, provider, protocol, context window, and headless agy worker readiness.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ass_ask_model",
    description:
      "Send a single-turn prompt to a third-party model routed through ASS (e.g. code review, second opinion, reasoning, or summarization). Requests are tracked in ASS Request Monitor and Floating Widget.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "ASS routeId (from ass_list_models) or unique model name. Omit to use ASS's default Antigravity model.",
        },
        prompt: {
          type: "string",
          description: "User prompt to send to the model.",
        },
        system: {
          type: "string",
          description: "Optional system instruction.",
        },
        temperature: {
          type: "number",
          minimum: 0,
          maximum: 2,
          description: "Optional sampling temperature (0-2).",
        },
        max_tokens: {
          type: "integer",
          minimum: 1,
          maximum: 262144,
          description: "Optional maximum output tokens.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "ass_run_agy_worker",
    description:
      "Run a headless Antigravity CLI (agy -p) coding worker powered by a third-party model via ASS Gateway. The worker gets full Antigravity coding tools inside cwd while every LLM call routes through ASS with live Request Monitor visibility. Default mode is 'plan' (read-only); pass 'accept-edits' or 'auto' when file edits are intended.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "ASS routeId (from ass_list_models) or unique model name. Omit to use ASS's default Antigravity model.",
        },
        task: {
          type: "string",
          description: "Detailed coding/analysis task prompt for the headless agy worker.",
        },
        cwd: {
          type: "string",
          description: "Optional absolute directory path for the worker. Defaults to ASS's configured workspace.",
        },
        mode: {
          type: "string",
          enum: ["plan", "accept-edits", "auto"],
          description: "Execution mode: 'plan' (read-only, default), 'accept-edits', or 'auto'.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Optional reasoning effort level for the worker session.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 10,
          maximum: 600,
          description: "Worker execution timeout in seconds (10-600, default 180).",
        },
        conversation_id: {
          type: "string",
          description: "Optional previous worker conversation_id to continue a multi-turn worker session.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
];

function readRuntime(runtimeFile) {
  if (!runtimeFile) return null;
  try {
    if (!fs.existsSync(runtimeFile)) return null;
    const raw = fs.readFileSync(runtimeFile, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const port = Number(parsed?.port);
    const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return null;
    return { port, token };
  } catch {
    return null;
  }
}

function requestAss({ port, token, method = "GET", path: reqPath, body, timeoutMs = 60000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      accept: "application/json",
      "x-ass-mcp-token": token,
      ...(payload
        ? {
            "content-type": "application/json",
            "content-length": payload.length,
          }
        : {}),
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let overflow = false;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            overflow = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          cleanup();
          if (overflow) {
            return reject(Object.assign(Error("ASS 响应体过大"), { code: "RESPONSE_TOO_LARGE" }));
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode || 500, data, text });
        });
        res.on("error", (err) => {
          cleanup();
          reject(err);
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(Object.assign(Error("请求本机 ASS 超时"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      req.destroy(Object.assign(Error("请求已取消"), { code: "ABORT_ERR" }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      return reject(Object.assign(Error("请求已取消"), { code: "ABORT_ERR" }));
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", (err) => {
      cleanup();
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function formatListModelsResult(data) {
  const models = Array.isArray(data?.models) ? data.models : [];
  const lines = [
    `ASS Antigravity Third-Party Models (${models.length} enabled)`,
    `Headless agy worker: ${data?.agyCliReady ? `ready (${data.agyVersion || "detected"})` : "unavailable (install agy CLI to use ass_run_agy_worker)"}`,
    ...(data?.defaultRouteId ? [`Default routeId: ${data.defaultRouteId}`] : []),
    ...(data?.workspace ? [`Default workspace: ${data.workspace}`] : []),
    "",
  ];
  if (!models.length) {
    lines.push("No third-party models are currently enabled for Antigravity in ASS.");
  } else {
    for (const m of models) {
      const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "";
      const out = m.maxOutputTokens ? `${Math.round(m.maxOutputTokens / 1000)}k out` : "";
      lines.push(
        `- ${m.routeId} | ${m.label} | protocol=${m.protocol} | ${[ctx, out].filter(Boolean).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

function formatAskResult(data) {
  const parts = [];
  if (typeof data?.text === "string" && data.text) {
    parts.push(data.text);
  }
  if (!parts.length && typeof data?.reasoning === "string" && data.reasoning) {
    parts.push(data.reasoning);
  }
  const usage = data?.metrics?.usage;
  const meta = [
    `model=${data?.model || ""}`,
    `provider=${data?.provider || ""}`,
    `routeId=${data?.routeId || ""}`,
    Number.isFinite(data?.ms) ? `ms=${data.ms}` : "",
    Number.isFinite(usage?.inputTokens) ? `in=${usage.inputTokens}` : "",
    Number.isFinite(usage?.outputTokens) ? `out=${usage.outputTokens}` : "",
    Number.isFinite(usage?.cacheReadTokens) && usage.cacheReadTokens > 0
      ? `cache_read=${usage.cacheReadTokens}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");
  if (meta) {
    parts.push("", `[ASS · ${meta}]`);
  }
  return parts.join("\n");
}

function formatWorkerResult(data) {
  const parts = [];
  if (typeof data?.response === "string" && data.response) {
    parts.push(data.response);
  }
  if (data?.error && !parts.length) {
    parts.push(`Worker error: ${data.error}`);
  }
  const usage = data?.usage;
  const toolCount = Array.isArray(data?.toolCalls) ? data.toolCalls.length : 0;
  const meta = [
    `status=${data?.status || "unknown"}`,
    data?.model ? `model=${data.model}` : "",
    data?.provider ? `provider=${data.provider}` : "",
    data?.routeId ? `routeId=${data.routeId}` : "",
    data?.mode ? `mode=${data.mode}` : "",
    data?.conversationId ? `conversation_id=${data.conversationId}` : "",
    Number.isFinite(data?.numTurns) ? `turns=${data.numTurns}` : "",
    toolCount > 0 ? `tools=${toolCount}` : "",
    Number.isFinite(data?.durationSeconds) ? `duration=${data.durationSeconds.toFixed(1)}s` : "",
    Number.isFinite(usage?.input_tokens) ? `in=${usage.input_tokens}` : "",
    Number.isFinite(usage?.output_tokens) ? `out=${usage.output_tokens}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  if (meta) {
    parts.push("", `[ASS Worker · ${meta}]`);
  }
  return parts.join("\n");
}

function toolText(text, isError = false) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    ...(isError ? { isError: true } : {}),
  };
}

function createMcpHandler({
  runtimeFile,
  readRuntimeFn = readRuntime,
  callAss = requestAss,
  env = process.env,
} = {}) {
  const inflight = new Map();

  function abortAll() {
    for (const controller of inflight.values()) {
      try {
        controller.abort();
      } catch {}
    }
    inflight.clear();
  }

  async function callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};

    if (!TOOLS.some((t) => t.name === name)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(name || "")}` },
      };
    }

    if (name === "ass_run_agy_worker" && Number(env?.ASS_MCP_WORKER_DEPTH || 0) >= 1) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolText("禁止在 ASS Headless Worker 内部递归调用 ass_run_agy_worker；请直接在当前 worker 中完成任务。", true),
      };
    }

    const runtime = readRuntimeFn(runtimeFile);
    if (!runtime) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolText("ASS 未运行或 MCP 桥接未就绪，请先打开 ASS 并确认已开启 Antigravity MCP 桥接后重试。", true),
      };
    }

    const controller = new AbortController();
    const key = String(id);
    inflight.set(key, controller);
    try {
      let response;
      if (name === "ass_list_models") {
        response = await callAss({
          ...runtime,
          method: "GET",
          path: "/agy-mcp/models",
          timeoutMs: 15000,
          signal: controller.signal,
        });
      } else if (name === "ass_ask_model") {
        response = await callAss({
          ...runtime,
          method: "POST",
          path: "/agy-mcp/ask",
          body: args,
          timeoutMs: 310000,
          signal: controller.signal,
        });
      } else {
        const timeoutSec = Math.max(10, Math.min(600, Math.floor(Number(args.timeout_seconds) || 180)));
        response = await callAss({
          ...runtime,
          method: "POST",
          path: "/agy-mcp/worker",
          body: args,
          timeoutMs: (timeoutSec + 30) * 1000,
          signal: controller.signal,
        });
      }

      if (response.status < 200 || response.status >= 300) {
        const errMsg =
          response.data?.error?.message ||
          response.data?.error ||
          response.text ||
          `ASS 返回 HTTP ${response.status}`;
        return {
          jsonrpc: "2.0",
          id,
          result: toolText(errMsg, true),
        };
      }

      if (name === "ass_list_models") {
        return { jsonrpc: "2.0", id, result: toolText(formatListModelsResult(response.data)) };
      }
      if (name === "ass_ask_model") {
        return { jsonrpc: "2.0", id, result: toolText(formatAskResult(response.data)) };
      }
      const isErr = response.data?.ok === false;
      return { jsonrpc: "2.0", id, result: toolText(formatWorkerResult(response.data), isErr) };
    } catch (err) {
      const code = err?.code || "";
      let message;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") {
        message = "无法连接到本机 ASS 服务（可能已退出或端口未启动），请先打开 ASS 后重试。";
      } else if (code === "ETIMEDOUT") {
        message = "调用本机 ASS 服务超时，请检查上游模型响应或增大 timeout_seconds。";
      } else if (code === "ABORT_ERR") {
        message = "请求已取消。";
      } else {
        message = `ASS MCP 桥接请求失败：${err?.message || "未知错误"}`;
      }
      return { jsonrpc: "2.0", id, result: toolText(message, true) };
    } finally {
      inflight.delete(key);
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === "notifications/initialized") {
      return null;
    }
    if (method === "notifications/cancelled") {
      const targetId = params?.requestId;
      if (targetId !== undefined && targetId !== null) {
        inflight.get(String(targetId))?.abort();
      }
      return null;
    }
    if (isNotification) {
      return null;
    }

    if (method === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "ass-router",
            version: "1.0.0",
          },
          instructions:
            "ASS Router bridges Antigravity to third-party LLM providers configured in ASS while preserving your personal Google Account session. Call ass_list_models to see available models, ass_ask_model for fast single-turn prompts, and ass_run_agy_worker to delegate multi-step coding tasks to a headless agy worker powered by a third-party model.",
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }

    if (method === "tools/call") {
      return callTool(id, params);
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(method || "")}` },
    };
  }

  return { handleMessage, abortAll };
}

function runStdio(runtimeFile) {
  const handler = createMcpHandler({ runtimeFile });
  let buffer = "";
  let writeChain = Promise.resolve();
  const pending = new Set();

  const send = (payload) => {
    if (!payload) return;
    const line = JSON.stringify(payload) + "\n";
    writeChain = writeChain.then(
      () =>
        new Promise((resolve) => {
          if (process.stdout.destroyed || process.stdout.writableEnded) return resolve();
          if (process.stdout.write(line)) return resolve();
          process.stdout.once("drain", resolve);
        }),
    );
  };

  const processLine = (rawLine) => {
    const trimmed = rawLine.replace(/\r$/, "").trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const task = Promise.resolve(handler.handleMessage(parsed))
      .then((resp) => {
        if (resp) send(resp);
      })
      .catch((err) => {
        if (parsed && parsed.id !== undefined && parsed.id !== null) {
          send({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32603, message: err?.message || "Internal error" },
          });
        }
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES && !buffer.includes("\n")) {
      buffer = "";
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } });
      return;
    }
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line);
    }
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) processLine(buffer);
    buffer = "";
    void Promise.allSettled([...pending])
      .then(() => writeChain)
      .finally(() => process.exit(0));
  });

  const shutdown = () => {
    handler.abortAll();
    process.exit(0);
  };
  process.stdin.on("error", shutdown);
  process.stdout.on("error", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  runStdio(process.argv[2]);
}

module.exports = {
  TOOLS,
  SUPPORTED_PROTOCOLS,
  readRuntime,
  requestAss,
  createMcpHandler,
  formatListModelsResult,
  formatAskResult,
  formatWorkerResult,
};
