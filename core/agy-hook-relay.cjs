#!/usr/bin/env node
// Lightweight Antigravity hook relay for ASS live request monitoring.
// Never forwards lastUserInput, prompts, workspace paths, or transcript content.
// Always prints `{}` to stdout and exits 0 so it never blocks Antigravity.
const fs = require("node:fs");
const http = require("node:http");

const ALLOWED_EVENTS = new Set(["SessionStart", "PreInvocation", "PostInvocation", "Stop"]);
const safeText = (value, max = 160) =>
  typeof value === "string" && value.trim() && !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim().slice(0, max)
    : "";

function sanitizeHookPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = safeText(raw.hookEventName, 40);
  if (!ALLOWED_EVENTS.has(event)) return null;
  const conversationId = safeText(raw.conversationId, 128);
  const modelName = safeText(raw.modelName, 160);
  const payload = {
    hookEventName: event,
    conversationId,
    modelName,
  };
  if (Number.isSafeInteger(raw.invocationNum) && raw.invocationNum >= 0) {
    payload.invocationNum = raw.invocationNum;
  }
  if (Number.isSafeInteger(raw.initialNumSteps) && raw.initialNumSteps >= 0) {
    payload.initialNumSteps = raw.initialNumSteps;
  }
  if (event === "Stop") {
    const reason = safeText(raw.terminationReason, 64);
    if (reason) payload.terminationReason = reason;
    if (typeof raw.fullyIdle === "boolean") payload.fullyIdle = raw.fullyIdle;
  }
  return payload;
}

function deliverHookEvent({ port, token, payload, timeoutMs = 1200 }) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || !token || !payload) return resolve(false);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/agy-events",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-ass-hook-token": token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

async function runCli(runtimeFile) {
  try {
    if (!runtimeFile || !fs.existsSync(runtimeFile)) {
      process.stdout.write("{}");
      return;
    }
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 512 * 1024) break;
      chunks.push(chunk);
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const payload = sanitizeHookPayload(raw);
    if (payload) {
      await deliverHookEvent({
        port: Number(runtime.port),
        token: String(runtime.token || ""),
        payload,
      });
    }
  } catch {
    // Fail open: never block Antigravity execution.
  }
  process.stdout.write("{}");
}

if (require.main === module) {
  void runCli(process.argv[2]);
}

module.exports = { sanitizeHookPayload, deliverHookEvent, ALLOWED_EVENTS };
