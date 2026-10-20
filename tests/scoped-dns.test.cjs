const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { ScopedDns, publicIPv4, parseAnswer } = require("../core/scoped-dns.cjs");
const { normalizeProvider } = require("../core/models.cjs");
const answer = (ttl = 60) => ({ Status: 0, Answer: [
  { name: "fixture.example.", type: 5, data: "edge.example.", TTL: ttl },
  { name: "edge.example.", type: 1, data: "93.184.216.34", TTL: ttl },
] });
test("public DoH answers follow only the requested CNAME chain and obey TTL", () => {
  assert.deepEqual(parseAnswer("fixture.example", answer()), { addresses: ["93.184.216.34"], ttl: 60 });
  assert.equal(parseAnswer("fixture.example", answer(99999)).ttl, 600);
  assert.throws(() => parseAnswer("unrelated.example", answer()), { code: "ENOTFOUND" });
  assert.throws(() => parseAnswer("fixture.example", { Status: 3 }), { code: "ENOTFOUND" });
  for (const address of ["0.1.2.3", "10.2.3.4", "127.0.0.1", "169.254.1.1", "172.17.2.1",
    "100.64.2.1", "192.168.1.1", "198.18.1.1", "224.0.0.1", "::1", "93.184.216.34.evil"])
    assert.equal(publicIPv4(address), false, address);
});
test("resolver carries no provider credentials, deduplicates queries, caches then expires", async () => {
  let now = 0, calls = 0;
  const route = new ScopedDns({ now: () => now, dnsFetch: async (input, init) => {
    calls++; assert.equal(new URL(input).searchParams.get("name"), "fixture.example");
    assert.deepEqual(init.headers, { accept: "application/dns-json" });
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    return Response.json(answer(2));
  } });
  assert.deepEqual(await Promise.all([route.resolve("fixture.example"), route.resolve("fixture.example")]),
    [["93.184.216.34"], ["93.184.216.34"]]);
  await route.resolve("fixture.example"); assert.equal(calls, 1);
  now = 2001; await route.resolve("fixture.example"); assert.equal(calls, 2);
  route.close();
});
test("DNS failure is classified before sending any model POST", async () => {
  let sessions = 0;
  const route = new ScopedDns({ sessionFor: () => { sessions++; }, dnsFetch: async () => Response.json({ Status: 3 }) });
  await assert.rejects(route.fetch("https://fixture.example/v1/responses", { method: "POST", body: "synthetic" }), { code: "ENOTFOUND" });
  assert.equal(sessions, 0); route.close();
});
test("dedicated CONNECT carries bytes untouched and cannot tunnel to a different host", async t => {
  const echo = net.createServer(socket => { socket.on("error", () => {}); socket.pipe(socket); });
  echo.listen(0, "127.0.0.1"); await once(echo, "listening"); t.after(() => echo.close());
  let proxy;
  const route = new ScopedDns({ resolve: async () => ["127.0.0.1"], sessionFor: () => ({
    setProxy: async settings => { proxy = settings; },
    fetch: async () => Response.json({ fixture: true }),
  }) });
  t.after(() => route.close());
  await route.fetch("https://fixture.example:" + echo.address().port + "/v1/responses", { method: "POST" });
  assert.equal(proxy.mode, "fixed_servers");
  const proxyPort = Number(new URL(proxy.proxyRules).port);
  const connect = authority => new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1"); t.after(() => socket.destroy());
    socket.on("error", reject); socket.setTimeout(3000, () => reject(Error("fixture timeout")));
    socket.once("connect", () => socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n"));
    socket.once("data", data => resolve({ socket, data: data.toString() }));
  });
  const denied = await connect("other.example:443"); assert.match(denied.data, /403/); denied.socket.destroy();
  const allowed = await connect("fixture.example:" + echo.address().port);
  assert.match(allowed.data, /200 Connection Established/);
  const received = once(allowed.socket, "data"); allowed.socket.write("opaque-fixture-bytes");
  assert.equal((await received)[0].toString(), "opaque-fixture-bytes"); allowed.socket.destroy();
});
test("opt-in network mode persists; defaults and ordinary direct are unchanged", () => {
  for (const network of ["system", "direct", "direct-doh"]) {
    const result = normalizeProvider({ id: "fixture", baseUrl: "https://fixture.example", network });
    assert.equal(result.network, network);
  }
  assert.equal(normalizeProvider({ id: "fixture", baseUrl: "https://fixture.example" }).network, "system");
});
test("existing injection inherits only the selected transport, never changed keys, URLs or models", () => {
  const { ProxyConfig } = require("../core/proxy-config.cjs");
  const applied = { id: "fixture", baseUrl: "https://fixture.example", apiKey: "synthetic", network: "direct",
    models: [{ model: "applied", wireApi: "anthropic" }] };
  const current = { ...applied, network: "direct-doh", models: [{ model: "new-draft" }] };
  const fake = { supports: () => true, clients: { codex: { providers: [applied] } },
    store: { state: { providers: [current] } } };
  const read = () => ProxyConfig.prototype.routingState.call(fake, "codex").providers[0];
  assert.equal(read().network, "direct-doh"); assert.deepEqual(read().models, applied.models);
  assert.equal(applied.network, "direct");
  current.apiKey = "replacement"; assert.equal(read(), applied);
  current.apiKey = applied.apiKey; current.baseUrl = "https://changed.example"; assert.equal(read(), applied);
});
