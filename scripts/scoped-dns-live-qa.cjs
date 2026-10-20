// Explicit opt-in, free GET /models only. Never logs keys, models or response bodies.
// Launch as a separate Electron main, NOT the running ASS or its app profile.
const { app, session, safeStorage } = require("electron");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ScopedDns } = require("../core/scoped-dns.cjs");
if (!process.env.ASS_DNS_QA_SETTINGS || !process.env.ASS_DNS_QA_PROVIDER) throw Error("Explicit settings path and provider name required");
const qaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ass-scoped-dns-qa-"));
// v10 safeStorage needs the profile's DPAPI-encrypted os_crypt key. Copy only
// that encrypted envelope to the isolated profile; never open/write the live
// browser profile or export a plaintext credential.
const localState = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.ASS_DNS_QA_SETTINGS), "Local State"), "utf8"));
fs.writeFileSync(path.join(qaDirectory, "Local State"), JSON.stringify({ os_crypt: localState.os_crypt }));
app.setPath("userData", qaDirectory);
let route, stage = "settings";
app.whenReady().then(async () => {
  try {
    const state = JSON.parse(fs.readFileSync(process.env.ASS_DNS_QA_SETTINGS, "utf8"));
    const matches = state.providers.filter(p => p.name === process.env.ASS_DNS_QA_PROVIDER);
    if (matches.length !== 1) throw Error("Expected one provider");
    stage = "decrypt";
    const p = matches[0], secrets = JSON.parse(safeStorage.decryptString(Buffer.from(p.secrets, "base64")));
    stage = "session";
    const resolverSession = session.fromPartition("qa-dns-resolver");
    await resolverSession.setProxy({ mode: "system" });
    route = new ScopedDns({ sessionFor: name => session.fromPartition(name), dnsFetch: (u, init) => resolverSession.fetch(u, init) });
    const url = new URL(p.baseUrl);
    url.pathname = url.pathname.replace(/\/$/, "") + (/\/v\d+$/.test(url.pathname) ? "/models" : "/v1/models");
    stage = "request";
    const response = await route.fetch(url.toString(), {
      headers: { ...secrets.extraHeaders, authorization: "Bearer " + secrets.apiKey },
      signal: AbortSignal.timeout(30000),
    });
    stage = "response";
    const json = response.ok ? await response.json() : null;
    console.log(JSON.stringify({ ok: response.ok, httpStatus: response.status, models: Array.isArray(json?.data) ? json.data.length : null,
      tls: "Chromium default verification", globalDnsChanged: false, liveAssModified: false }));
    if (response.ok && process.env.ASS_DNS_QA_INFERENCE === "1") {
      const responses = process.env.ASS_DNS_QA_PROTOCOL === "responses";
      const protocol = responses ? "openai-responses" : "anthropic";
      const model = p.models.find(m => m.wireApi === protocol && (responses ? /sol/i : /haiku/i).test(m.model));
      if (!model) throw Error("No configured small probe model");
      stage = "stream";
      const { protocolEndpoint } = require("../core/provider-transport.cjs");
      const { inspectConnectionResponse } = require("../core/connection-diagnostic.cjs");
      const inference = await route.fetch(protocolEndpoint(p, protocol), {
        method: "POST", signal: AbortSignal.timeout(45000),
        headers: { "content-type": "application/json", ...(responses
          ? { authorization: "Bearer " + secrets.apiKey }
          : { "anthropic-version": "2023-06-01", "x-api-key": secrets.apiKey }), ...secrets.extraHeaders },
        body: JSON.stringify(responses
          ? { model: model.model, max_output_tokens: 128, stream: true, reasoning: { effort: "low" }, input: "Reply with OK only." }
          : { model: model.model, max_tokens: 16, stream: true, messages: [{ role: "user", content: "Reply with OK only." }] }),
      });
      const result = await inspectConnectionResponse(inference, protocol);
      console.log(JSON.stringify({ ok: true, protocol, inferenceHttpStatus: inference.status, completedStream: !!result, maxOutputTokens: responses ? 128 : 16 }));
    }
    app.exitCode = response.ok ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || error.cause?.code || error.name,
    stage, chromiumCode: error.message?.match(/net::ERR_[A-Z_]+/)?.[0], credentialsWithheld: true })); app.exitCode = 1; }
  finally { route?.close(); app.exit(app.exitCode || 0); }
});
