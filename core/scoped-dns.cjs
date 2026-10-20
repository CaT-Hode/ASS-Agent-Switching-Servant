// Opt-in provider-only DoH. Chromium still performs end-to-end TLS and streams.
// The loopback CONNECT hop sees no API headers, bodies or decrypted TLS data.
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");

const DNS_SERVICES = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];
const dnsError = () => Object.assign(Error("供应商 HTTPS DNS 解析失败"), { code: "ENOTFOUND" });
function publicIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
    a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
function parseAnswer(host, data) {
  if (data?.Status !== 0 || !Array.isArray(data.Answer)) throw dnsError();
  const name = s => String(s).toLowerCase().replace(/\.$/, "");
  const names = new Set([name(host)]);
  for (let i = 0; i < 8; i++) for (const row of data.Answer)
    if (row.type === 5 && names.has(name(row.name))) names.add(name(row.data));
  const answers = data.Answer.filter(row => row.type === 1 && names.has(name(row.name)) && publicIPv4(row.data));
  if (!answers.length) throw dnsError();
  return { addresses: [...new Set(answers.map(row => row.data))],
    ttl: Math.max(1, Math.min(600, ...answers.map(row => Number.isFinite(row.TTL) ? row.TTL : 60))) };
}
async function limitedJSON(response) {
  if (!response.ok) throw dnsError();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) throw dnsError();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
class ScopedDns {
  constructor({ sessionFor, dnsFetch, resolve, dial = options => net.connect(options), now = Date.now }) {
    this.sessionFor = sessionFor; this.dnsFetch = dnsFetch; this.dial = dial; this.now = now;
    this.resolveOverride = resolve; this.cache = new Map(); this.pending = new Map(); this.entries = new Map(); this.closed = false;
  }
  async resolve(host) {
    const saved = this.cache.get(host);
    if (saved?.until > this.now()) return saved.addresses;
    if (this.pending.has(host)) return this.pending.get(host);
    const task = (async () => {
      if (this.resolveOverride) return this.resolveOverride(host);
      for (const base of DNS_SERVICES) {
        try {
          const url = new URL(base); url.searchParams.set("name", host); url.searchParams.set("type", "A");
          const response = await this.dnsFetch(url.toString(), {
            headers: { accept: "application/dns-json" }, credentials: "omit", redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          const answer = parseAnswer(host, await limitedJSON(response));
          this.cache.set(host, { addresses: answer.addresses, until: this.now() + answer.ttl * 1000 });
          return answer.addresses;
        } catch { /* Try the second HTTPS resolver; never switch global DNS. */ }
      }
      throw dnsError();
    })();
    this.pending.set(host, task);
    try { return await task; } finally { this.pending.delete(host); }
  }
  async entry(url) {
    const origin = url.origin;
    if (this.entries.has(origin)) return this.entries.get(origin);
    const task = this.create(url);
    this.entries.set(origin, task);
    try { return await task; } catch (error) { this.entries.delete(origin); throw error; }
  }
  async create(url) {
    const host = url.hostname, port = Number(url.port || 443), sockets = new Set();
    const state = { lastError: null, errorTime: 0, sockets };
    const server = http.createServer((_, response) => { response.writeHead(405); response.end(); });
    const track = socket => {
      sockets.add(socket); socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket)); socket.setTimeout(180000, () => socket.destroy());
    };
    server.on("connection", track);
    server.on("connect", async (request, client, head) => {
      client.on("error", () => {});
      if (request.url !== host + ":" + port || sockets.size > 64 || this.closed) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      let remote;
      const closeRemote = () => remote?.destroy();
      client.once("close", closeRemote);
      try {
        const addresses = await this.resolve(host);
        if (client.destroyed || this.closed) return;
        // Rotate on successive connections. No POST replay after a connection.
        const address = addresses[state.nextAddress++ % addresses.length];
        remote = this.dial({ host: address, port }); track(remote);
        remote.setTimeout(10000, () => remote.destroy(Object.assign(Error("连接超时"), { code: "ETIMEDOUT" })));
        remote.once("connect", () => {
          if (client.destroyed) { remote.destroy(); return; }
          remote.setTimeout(180000, () => remote.destroy());
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) remote.write(head);
          client.pipe(remote); remote.pipe(client);
        });
        remote.once("error", () => client.destroy());
        remote.once("close", () => client.destroy());
      } catch (error) {
        state.lastError = error; state.errorTime = this.now();
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
    state.nextAddress = 0;
    const stop = () => { for (const socket of sockets) socket.destroy(); server.close(); };
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
      });
      if (this.closed) throw Error("DNS route closed");
      const session = this.sessionFor("ass-provider-dns-" + crypto.createHash("sha256").update(url.origin).digest("hex"));
      await session.setProxy({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:" + server.address().port, proxyBypassRules: "<-loopback>" });
      return { ...state, session, server, stop, getError: () => state.lastError, errorTime: () => state.errorTime };
    } catch (error) { stop(); throw error; }
  }
  async fetch(input, init) {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || net.isIP(url.hostname) ||
        !url.hostname.includes(".") || /(?:^|\.)(localhost|local|internal|invalid)$/.test(url.hostname))
      throw Error("HTTPS DNS 仅支持公网 HTTPS 供应商域名");
    if (this.closed) throw Error("DNS route closed");
    // Resolve before sending an inference request; failure cannot replay a POST.
    await this.resolve(url.hostname);
    const entry = await this.entry(url), started = this.now();
    try { return await entry.session.fetch(input, { ...init, credentials: "omit", redirect: "error" }); }
    catch (error) {
      if (entry.getError()?.code === "ENOTFOUND" && entry.errorTime() >= started) throw entry.getError();
      throw error;
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) void entry.then(value => value.stop()).catch(() => {});
    this.entries.clear(); this.cache.clear();
  }
}
module.exports = { ScopedDns, parseAnswer, publicIPv4 };
