const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { atomic } = require("./config.cjs");
const { safePath } = require("./native-fields.cjs");
const { findExecutable } = require("./client-launcher.cjs");
const { authorized } = require("./harness-route.cjs");
const { readJSON } = require("./request-body.cjs");
const { RequestMetrics } = require("./request-metrics.cjs");
const { protocolEndpoint } = require("./provider-transport.cjs");
const { forwardErrorBody, summarizeUpstreamError, redact, upstreamRequestId } = require("./http-passthrough.cjs");
const { requestFailure } = require('./diagnostic-failure.cjs');
const {
  agyModelCatalog,
  defaultAgyModelId,
  normalizeAgyEfforts,
  resolveAgyModel,
  agyGatewayEnv,
} = require("./agy-injection.cjs");
const { geminiRequest, geminiEvents, geminiJSON } = require("./gemini-adapter.cjs");

const MCP_SERVER_KEY = "ass-router";
const ALLOWED_WORKER_MODES = ["plan", "accept-edits", "auto"];
const ALLOWED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MAX_CONCURRENT_WORKERS = 4;
const MAX_ASK_PROMPT_CHARS = 400000;
const MAX_WORKER_TASK_CHARS = 200000;
const MAX_WORKER_STDERR = 64 * 1024;
const MAX_WORKER_TEXT_FALLBACK = 2 * 1024 * 1024;

let activeWorkers = 0;

function mcpConfigPath(home = os.homedir()) {
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

function mcpRuntimePath(dataDir) {
  return path.join(dataDir, "agy-mcp-runtime.json");
}

function readMcpConfig(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {}, error: "" };
  try {
    safePath(file);
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, data: null, error: "mcp_config.json 根结构不是 JSON 对象" };
    }
    if (
      parsed.mcpServers !== undefined &&
      (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))
    ) {
      return { exists: true, data: null, error: "mcp_config.json 中 mcpServers 不是有效对象" };
    }
    return { exists: true, data: parsed, error: "" };
  } catch {
    return { exists: true, data: null, error: "mcp_config.json 无法读取或 JSON 无效" };
  }
}

function mcpStatus({ home = os.homedir() } = {}) {
  const file = mcpConfigPath(home);
  const parsed = readMcpConfig(file);
  if (parsed.error) {
    return { installed: false, file, command: "", error: parsed.error };
  }
  const entry = parsed.data?.mcpServers?.[MCP_SERVER_KEY];
  const installed = !!entry && typeof entry === "object" && typeof entry.command === "string" && entry.command.length > 0;
  return {
    installed,
    file,
    command: installed ? entry.command : "",
    error: "",
  };
}

function buildMcpServerEntry({
  dataDir,
  serverScript = path.join(__dirname, "agy-mcp-stdio.cjs"),
  env = process.env,
  execPath = process.execPath,
}) {
  const stagedServer = path.join(dataDir, "ass-mcp-server.cjs");
  const runtimeFile = mcpRuntimePath(dataDir);
  safePath(stagedServer);
  atomic(stagedServer, fs.readFileSync(serverScript, "utf8"));
  const nodeExe = findExecutable("node", env);
  if (nodeExe) {
    return {
      command: nodeExe,
      args: [stagedServer, runtimeFile],
    };
  }
  if (!execPath || typeof execPath !== "string") {
    throw Error("未找到 Node.js 或可用运行时来启动 ASS MCP 服务");
  }
  return {
    command: execPath,
    args: [stagedServer, runtimeFile],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function installMcp({
  home = os.homedir(),
  dataDir,
  serverScript = path.join(__dirname, "agy-mcp-stdio.cjs"),
  env = process.env,
  execPath = process.execPath,
} = {}) {
  if (!dataDir) throw Error("缺少 ASS 数据目录");
  const file = mcpConfigPath(home);
  const parsed = readMcpConfig(file);
  if (parsed.error) throw Error("无法写入 Antigravity mcp_config.json：" + parsed.error);
  const entry = buildMcpServerEntry({ dataDir, serverScript, env, execPath });
  const existing = parsed.data || {};
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      [MCP_SERVER_KEY]: entry,
    },
  };
  safePath(file);
  atomic(file, JSON.stringify(next, null, 2) + "\n");
  return mcpStatus({ home });
}

function uninstallMcp({ home = os.homedir() } = {}) {
  const file = mcpConfigPath(home);
  const parsed = readMcpConfig(file);
  if (parsed.error) throw Error("无法清理 Antigravity mcp_config.json：" + parsed.error);
  if (!parsed.exists || !parsed.data?.mcpServers || !Object.hasOwn(parsed.data.mcpServers, MCP_SERVER_KEY)) {
    return mcpStatus({ home });
  }
  const nextServers = { ...parsed.data.mcpServers };
  delete nextServers[MCP_SERVER_KEY];
  const next = { ...parsed.data };
  if (Object.keys(nextServers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = nextServers;
  }
  if (Object.keys(next).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {}
  } else {
    safePath(file);
    atomic(file, JSON.stringify(next, null, 2) + "\n");
  }
  return mcpStatus({ home });
}

function writeMcpRuntime(dataDir, { port, token }) {
  const file = mcpRuntimePath(dataDir);
  safePath(file);
  atomic(file, JSON.stringify({ port, token }));
}

function clearMcpRuntime(dataDir) {
  const file = mcpRuntimePath(dataDir);
  try {
    fs.unlinkSync(file);
  } catch {}
}

function resolveDefaultOrRequestedModel(requestedModel, state) {
  if (typeof requestedModel === "string" && requestedModel.trim()) {
    return resolveAgyModel(requestedModel.trim(), state, { allowFuzzy: true });
  }
  if (state?.defaultModel) {
    try {
      return resolveAgyModel(state.defaultModel, state, { allowFuzzy: true });
    } catch {}
  }
  const catalog = agyModelCatalog(state?.providers || [], state?.capabilities || {});
  if (!catalog.length) {
    throw Object.assign(
      Error("Antigravity 接入列表中没有可用的已启用模型；请先在 ASS 添加并启用至少一个供应商与模型"),
      { status: 404 },
    );
  }
  return resolveAgyModel(catalog[0].routeId, state);
}

function resolveWorkerCwd(requestedCwd, defaultWorkspace) {
  const candidate =
    typeof requestedCwd === "string" && requestedCwd.trim()
      ? requestedCwd.trim()
      : typeof defaultWorkspace === "string" && defaultWorkspace.trim()
        ? defaultWorkspace.trim()
        : os.homedir();
  if (!path.isAbsolute(candidate)) {
    throw Object.assign(Error("cwd 必须是绝对目录路径"), { status: 400 });
  }
  let stat;
  try {
    safePath(candidate);
    stat = fs.statSync(candidate);
  } catch {
    throw Object.assign(Error("指定的工作目录不存在或无法访问：" + candidate), { status: 400 });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(Error("指定路径不是目录：" + candidate), { status: 400 });
  }
  return candidate;
}

function buildWorkerInvocation({
  launcher,
  routeId,
  task,
  cwd,
  defaultWorkspace = "",
  mode = "plan",
  effort = "",
  timeoutSeconds = 180,
  conversationId = "",
  port = 25819,
  localToken,
  launchEnv = process.env,
}) {
  if (!launcher?.ready || !launcher.executable) {
    throw Object.assign(Error("未找到可用的 agy CLI，请先安装 Antigravity CLI 并在 ASS 中重新识别"), { status: 503 });
  }
  if (typeof task !== "string" || !task.trim()) {
    throw Object.assign(Error("task 不能为空"), { status: 400 });
  }
  if (task.length > MAX_WORKER_TASK_CHARS) {
    throw Object.assign(Error(`task 超过最大长度限制（${MAX_WORKER_TASK_CHARS} 字符）`), { status: 400 });
  }
  const normalizedMode = mode ? String(mode).trim() : "plan";
  if (!ALLOWED_WORKER_MODES.includes(normalizedMode)) {
    throw Object.assign(Error(`不支持的 mode：${normalizedMode}（仅允许 plan / accept-edits / auto）`), {
      status: 400,
    });
  }
  const normalizedEffort = effort ? String(effort).trim().toLowerCase() : "";
  if (normalizedEffort && !ALLOWED_EFFORTS.includes(normalizedEffort)) {
    throw Object.assign(Error(`不支持的 effort：${normalizedEffort}`), { status: 400 });
  }
  const rawTimeout = Number(timeoutSeconds);
  const clampedTimeout = Number.isFinite(rawTimeout)
    ? Math.max(10, Math.min(600, Math.floor(rawTimeout)))
    : 180;
  const normalizedConvId = conversationId ? String(conversationId).trim() : "";
  if (normalizedConvId && !/^[a-zA-Z0-9._-]{4,128}$/.test(normalizedConvId)) {
    throw Object.assign(Error("conversation_id 格式无效"), { status: 400 });
  }

  const resolvedCwd = resolveWorkerCwd(cwd, defaultWorkspace);
  const env = { ...(launchEnv || {}) };
  for (const key of Object.keys(env)) {
    if (/^(AGY_LLM_GATEWAY_|GEMINI_API_KEY$|GOOGLE_GEMINI_BASE_URL$|ELECTRON_RUN_AS_NODE$)/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, agyGatewayEnv({ port, localToken, wireProtocol: "genai" }));
  env.ASS_MCP_WORKER_DEPTH = "1";

  // In agy 1.5.16, --disable-slash-commands causes --mode plan to have no effect.
  // For plan mode, omit --disable-slash-commands and neutralize a leading "/" in task
  // so untrusted task text cannot trigger CLI slash commands (e.g. /logout).
  const safeTask = normalizedMode === "plan" && /^\s*\//.test(task) ? `Task: ${task}` : task;

  const args = [
    ...(Array.isArray(launcher.args) ? launcher.args : []),
    "-p",
    safeTask,
    "--model",
    routeId,
    "--output-format",
    "stream-json",
    ...(normalizedMode === "plan" ? [] : ["--disable-slash-commands"]),
    "--mode",
    normalizedMode,
    "--print-timeout",
    `${clampedTimeout}s`,
    ...(normalizedConvId ? ["--conversation", normalizedConvId] : []),
    ...(normalizedEffort ? ["--effort", normalizedEffort] : []),
  ];

  return {
    executable: launcher.executable,
    args,
    cwd: resolvedCwd,
    env,
    mode: normalizedMode,
    timeoutSeconds: clampedTimeout,
  };
}

function createWorkerAccumulator() {
  let conversationId = "";
  let finalResponse = "";
  let fallbackText = "";
  let status = "";
  let numTurns = null;
  let durationSeconds = null;
  let usage = null;
  let errorMessage = "";
  const toolCalls = [];
  const seenToolSteps = new Set();

  const appendFallback = (text) => {
    if (typeof text !== "string" || !text) return;
    if (fallbackText.length < MAX_WORKER_TEXT_FALLBACK) {
      fallbackText += text.slice(0, MAX_WORKER_TEXT_FALLBACK - fallbackText.length);
    }
  };

  const extractMessageText = (msg) => {
    if (typeof msg === "string") return msg;
    if (typeof msg?.text === "string") return msg.text;
    if (typeof msg?.content === "string") return msg.content;
    if (Array.isArray(msg?.content)) {
      return msg.content
        .filter((part) => part && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
    return "";
  };

  const applyResultPayload = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const cid = payload.conversation_id || payload.conversationId || payload.session_id;
    if (typeof cid === "string" && cid) conversationId = cid;
    if (typeof payload.status === "string" && payload.status) status = payload.status;
    const resp = payload.response ?? payload.result ?? payload.text;
    if (typeof resp === "string" && resp) finalResponse = resp;
    const turns = payload.num_turns ?? payload.numTurns;
    if (Number.isFinite(turns)) numTurns = turns;
    const dur = payload.duration_seconds ?? payload.durationSeconds;
    if (Number.isFinite(dur)) durationSeconds = dur;
    if (payload.usage && typeof payload.usage === "object") usage = payload.usage;
    if (typeof payload.error === "string" && payload.error) errorMessage = payload.error;
    else if (typeof payload.error?.message === "string" && payload.error.message) errorMessage = payload.error.message;
  };

  function feedLine(rawLine) {
    const trimmed = String(rawLine || "").trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

    const cid =
      obj.conversation_id ||
      obj.conversationId ||
      obj.session_id ||
      obj.step_update?.conversation_id ||
      obj.result?.conversation_id;
    if (typeof cid === "string" && cid) conversationId = cid;

    // Antigravity CLI 1.5.x stream-json envelope: { event: "init" | "step_update" | "result" | "error", ... }
    const eventName = String(obj.event || "").toLowerCase();
    if (eventName === "result") {
      applyResultPayload(obj.result && typeof obj.result === "object" ? obj.result : obj);
      return;
    }
    if (eventName === "step_update" && obj.step_update && typeof obj.step_update === "object") {
      const su = obj.step_update;
      if (su.step_type === "tool") {
        const toolName = su.tool_name || su.tool_info?.name;
        const stepKey = Number.isInteger(su.step_index) ? `step:${su.step_index}` : "";
        if (typeof toolName === "string" && toolName && (!stepKey || !seenToolSteps.has(stepKey))) {
          if (stepKey) seenToolSteps.add(stepKey);
          toolCalls.push(toolName);
        }
      } else if (su.step_type === "agent_response") {
        if (typeof su.text_delta === "string" && su.text_delta) appendFallback(su.text_delta);
        else if (typeof su.text === "string" && su.text) appendFallback(su.text);
      }
      return;
    }
    if (eventName === "error") {
      const errObj = obj.error && typeof obj.error === "object" ? obj.error : obj;
      const msg = typeof obj.error === "string" ? obj.error : errObj.message;
      if (typeof msg === "string" && msg) errorMessage = msg;
      return;
    }
    if (eventName === "init") {
      return;
    }

    const type = String(obj.type || "").toLowerCase();

    if (type === "result" || type === "final" || type === "complete" || (!type && !eventName && ("response" in obj || "status" in obj))) {
      applyResultPayload(obj);
      return;
    }

    if (type === "error" || obj.error) {
      const msg = typeof obj.error === "string" ? obj.error : obj.error?.message || obj.message;
      if (typeof msg === "string" && msg) errorMessage = msg;
      return;
    }

    if (["tool_call", "tool_use", "tool_start", "tool_call_start"].includes(type)) {
      const toolName = obj.name || obj.tool_name || obj.tool?.name || obj.function?.name;
      if (typeof toolName === "string" && toolName) toolCalls.push(toolName);
      return;
    }

    if (["assistant", "message", "text", "delta", "content_delta", "text_delta"].includes(type)) {
      if (typeof obj.delta === "string") appendFallback(obj.delta);
      else if (typeof obj.text === "string") appendFallback(obj.text);
      else if (obj.message) appendFallback(extractMessageText(obj.message));
      else if (obj.content) appendFallback(extractMessageText(obj));

      const calls = obj.tool_calls || obj.message?.tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.name || tc?.function?.name;
          if (typeof name === "string" && name) toolCalls.push(name);
        }
      }
      if (Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "tool_use" && typeof block.name === "string") toolCalls.push(block.name);
        }
      }
    }
  }

  function finalize({ exitCode, timedOut = false, aborted = false, stderr = "", elapsedMs = 0 } = {}) {
    const response = finalResponse || fallbackText.trim();
    const ok = !timedOut && !aborted && exitCode === 0 && (!status || status.toUpperCase() === "SUCCESS");
    let finalStatus = status;
    if (aborted) finalStatus = "ABORTED";
    else if (timedOut) finalStatus = "TIMEOUT";
    else if (!finalStatus) finalStatus = ok ? "SUCCESS" : "ERROR";

    let error = errorMessage;
    if (!ok && !error) {
      if (aborted) error = "请求已取消，已终止 headless agy worker";
      else if (timedOut) error = "headless agy worker 执行超时并已终止";
      else error = stderr.trim().slice(0, 600) || `agy worker 退出码 ${exitCode}`;
    }

    return {
      ok,
      status: finalStatus,
      conversationId,
      response,
      numTurns,
      durationSeconds: durationSeconds ?? elapsedMs / 1000,
      usage,
      toolCalls,
      ...(error ? { error } : {}),
    };
  }

  return { feedLine, finalize };
}

function terminateChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill();
  } catch {}
  if (process.platform === "win32" && child.pid) {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      }
    }, 1500);
    forceTimer.unref?.();
  }
}

async function handleMcpAsk(router, req, res) {
  const began = Date.now();
  const controller = new AbortController();
  const metrics = new RequestMetrics({ began });
  const requestId = crypto.randomUUID();
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

  let resolved;
  let httpStatus = null;
  let upstreamId, upstreamFailure;
  let failureLayer = 'local';
  const secrets = [router.clientToken].filter(Boolean);

  try {
    const body = await readJSON(req, 4 * 1024 * 1024);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      throw Object.assign(Error("prompt 不能为空"), { status: 400 });
    }
    if (prompt.length > MAX_ASK_PROMPT_CHARS) {
      throw Object.assign(Error(`prompt 超过最大长度限制（${MAX_ASK_PROMPT_CHARS} 字符）`), { status: 400 });
    }
    const system = typeof body?.system === "string" ? body.system.trim() : "";
    const temperature =
      typeof body?.temperature === "number" && Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2
        ? body.temperature
        : undefined;
    const maxTokens =
      Number.isInteger(body?.max_tokens) && body.max_tokens > 0 ? Math.min(262144, body.max_tokens) : undefined;

    const state = router.getState("antigravity") || {};
    resolved = resolveDefaultOrRequestedModel(body?.model, state);
    const { provider, model, routeId } = resolved;
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
        operation: "mcp-ask",
      },
      metrics,
    );

    const geminiBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      },
    };
    const upstreamBody = geminiRequest(geminiBody, model, protocol);

    const headers = {
      ...provider.extraHeaders,
      "content-type": "application/json",
      accept: "text/event-stream",
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
    failureLayer = 'stream';

    const events = geminiEvents(response.body, protocol, model.model, controller.signal);
    const payload = await geminiJSON(events);
    const parts = payload.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const reasoning = parts
      .filter((p) => p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const snap = metrics.snapshot();
    const ms = Date.now() - began;

    router.log({
      time: new Date().toISOString(),
      source: provider.name,
      model: model.model,
      status: response.status,
      ms,
      ok: true,
      httpStatus,
      httpOk: httpStatus >= 200 && httpStatus < 300,
      taskOk: true,
      requestId,
      upstreamRequestId: upstreamId,
      client: "antigravity",
      operation: "mcp-ask",
      protocol,
      providerId: provider.id,
      startedAt: new Date(began).toISOString(),
      ...snap,
    });

    res.writeHead(200, { "content-type": "application/json", "x-ass-request-id": requestId });
    res.end(
      JSON.stringify({
        ok: true,
        routeId,
        provider: provider.name,
        model: model.model,
        protocol,
        text,
        ...(reasoning ? { reasoning } : {}),
        finishReason: payload.candidates?.[0]?.finishReason || "STOP",
        ms,
        metrics: snap,
      }),
    );
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

    router.log({
      time: new Date().toISOString(),
      source: resolved?.provider?.name || "Antigravity MCP",
      model: resolved?.model?.model || "",
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
      operation: "mcp-ask",
      protocol: resolved?.model?.wireApi,
      providerId: resolved?.provider?.id,
      startedAt: new Date(began).toISOString(),
      ...metrics.snapshot(),
    });

    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message, code: error.code || "mcp_ask_error" } }));
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (router.controllers.delete(controller)) router.active--;
  }
}

async function handleMcpWorker(router, req, res, ctx) {
  const began = Date.now();
  const secrets = [router.clientToken].filter(Boolean);
  let acquired = false;
  let child = null;
  let timer = null;

  try {
    if (activeWorkers >= MAX_CONCURRENT_WORKERS) {
      throw Object.assign(
        Error(`并发 headless agy worker 已达上限（${MAX_CONCURRENT_WORKERS}），请等待已有任务完成`),
        { status: 429 },
      );
    }

    const body = await readJSON(req, 1024 * 1024);
    const state = router.getState("antigravity") || {};
    const resolved = resolveDefaultOrRequestedModel(body?.model, state);
    const { provider, model, routeId, baseRouteId } = resolved;
    secrets.push(provider.apiKey);

    // Gateway advertises effort-suffixed model IDs when a model supports >=2 efforts.
    // Passing both a suffixed --model and --effort causes agy to reject them as conflicting.
    const { efforts, defaultEffort } = normalizeAgyEfforts(model.efforts, model.defaultEffort);
    let workerModelId = routeId;
    let workerEffort = body?.effort || "";
    if (efforts.length >= 2) {
      const requestedEffort = String(resolved.effort || body?.effort || "").trim().toLowerCase();
      const chosenEffort = efforts.includes(requestedEffort) ? requestedEffort : defaultEffort;
      if (chosenEffort) {
        workerModelId = `${baseRouteId || routeId}-${chosenEffort}`;
        workerEffort = "";
      }
    }

    const launcher = ctx.getLauncher?.();
    const invocation = buildWorkerInvocation({
      launcher,
      routeId: workerModelId,
      task: body?.task,
      cwd: body?.cwd,
      defaultWorkspace: ctx.getWorkspace?.() || "",
      mode: body?.mode,
      effort: workerEffort,
      timeoutSeconds: body?.timeout_seconds,
      conversationId: body?.conversation_id,
      port: router.port,
      localToken: state.localToken || router.clientToken,
      launchEnv: ctx.launchEnv || process.env,
    });

    activeWorkers++;
    acquired = true;

    const acc = createWorkerAccumulator();
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const spawnFn = ctx.spawn || spawn;
    child = spawnFn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onClose = () => {
      if (!res.writableFinished) {
        aborted = true;
        terminateChildProcess(child);
      }
    };
    res.on("close", onClose);

    timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
    }, (invocation.timeoutSeconds + 15) * 1000);
    timer.unref?.();

    const exitCode = await new Promise((resolve, reject) => {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let idx;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          acc.feedLine(line);
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < MAX_WORKER_STDERR) {
          stderr += chunk.slice(0, MAX_WORKER_STDERR - stderr.length);
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (stdoutBuffer.trim()) acc.feedLine(stdoutBuffer);
        stdoutBuffer = "";
        resolve(code ?? 1);
      });
    });

    res.off("close", onClose);
    const result = acc.finalize({
      exitCode,
      timedOut,
      aborted,
      stderr: redact(stderr, secrets),
      elapsedMs: Date.now() - began,
    });

    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...result,
          routeId,
          provider: provider.name,
          model: model.model,
          mode: invocation.mode,
          cwd: invocation.cwd,
        }),
      );
    }
  } catch (error) {
    const status = error.status || 500;
    const message = redact(error.message || "Worker 执行失败", secrets);
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message, code: error.code || "mcp_worker_error" } }));
    }
  } finally {
    clearTimeout(timer);
    if (child) terminateChildProcess(child);
    if (acquired) activeWorkers = Math.max(0, activeWorkers - 1);
  }
}

async function handleAgyMcp(router, req, res, ctx = {}) {
  const token = String(req.headers["x-ass-mcp-token"] || "");
  if (!authorized(token, router.clientToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { message: "无效 ASS MCP 凭据" } }));
    return;
  }
  if (!router.allowClient("antigravity")) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { message: "Antigravity 路由暂不可用" } }));
    return;
  }

  const pathname = String(req.url || "").split("?")[0];

  if (pathname === "/agy-mcp/models") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "仅支持 GET" } }));
      return;
    }
    const state = router.getState("antigravity") || {};
    const models = agyModelCatalog(state.providers || [], state.capabilities || {});
    let defaultRouteId = models[0]?.routeId || "";
    if (state.defaultModel) {
      const matched = models.find((m) => m.ref === state.defaultModel || m.routeId === state.defaultModel);
      if (matched) defaultRouteId = matched.routeId;
    }
    const launcher = ctx.getLauncher?.();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        ok: true,
        models,
        defaultRouteId,
        agyCliReady: Boolean(launcher?.ready),
        agyVersion: launcher?.version || "",
        workspace: ctx.getWorkspace?.() || "",
      }),
    );
    return;
  }

  if (pathname === "/agy-mcp/ask") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "仅支持 POST" } }));
      return;
    }
    await handleMcpAsk(router, req, res);
    return;
  }

  if (pathname === "/agy-mcp/worker") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "仅支持 POST" } }));
      return;
    }
    await handleMcpWorker(router, req, res, ctx);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: { message: "未知 ASS MCP 端点" } }));
}

module.exports = {
  MCP_SERVER_KEY,
  ALLOWED_WORKER_MODES,
  ALLOWED_EFFORTS,
  mcpConfigPath,
  mcpRuntimePath,
  mcpStatus,
  installMcp,
  uninstallMcp,
  writeMcpRuntime,
  clearMcpRuntime,
  buildWorkerInvocation,
  createWorkerAccumulator,
  handleAgyMcp,
};
