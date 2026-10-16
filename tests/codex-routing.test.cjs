const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const TOML = require("@iarna/toml");
const { ConfigManager, atomic, prepareConfig } = require("../core/config.cjs");
const { Router, routeFor } = require("../core/router.cjs");
const { parseImport, codexModelId, makeCatalog } = require("../core/models.cjs");

test("detach restores official defaults by removing ASS-owned model selections", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-official-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = "[agents]\nmax_threads = 2\n";
  atomic(manager.file, original);
  manager.attach();
  const attachedText = fs.readFileSync(manager.file, "utf8");
  const firstBlockEnd = attachedText.indexOf("# <<< ass managed end") + "# <<< ass managed end".length;
  const withDefaults = attachedText.slice(0, firstBlockEnd) +
    '\nmodel = "ASS_db99cd7795c1aef3f1baaba6::gpt-6-sol"\nmodel_reasoning_effort = "xhigh"\n' +
    'default_subagent_model = "ASS_db99cd7795c1aef3f1baaba6::gpt-6-sol"\n' +
    attachedText.slice(firstBlockEnd);
  atomic(manager.file, withDefaults);
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  record.replaced.model = null;
  record.replaced.model_reasoning_effort = null;
  record.replaced["agents.default_subagent_model"] = null;
  atomic(manager.record, JSON.stringify(record));
  manager.detach();
  const restored = TOML.parse(fs.readFileSync(manager.file, "utf8"));
  assert.equal(restored.model, undefined);
  assert.equal(restored.model_reasoning_effort, undefined);
  assert.equal(restored.agents.default_subagent_model, undefined);
  assert.equal(restored.agents.max_threads, 2);
});
test("ASS model namespaces are stable and unique; removed legacy namespaces never route", () => {
  const providers = parseImport({ providers: ["aimami_relay_abc", "aimami_relay_def"].map(id => ({
    id, baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic", models: [{ model: "gpt-6-astra" }],
  })) });
  const state = { providers }, models = makeCatalog([], providers).models.filter(m => m.slug.includes("::"));
  assert.equal(new Set(models.map(m => m.slug)).size, 2);
  assert.ok(models.every(m => /^ASS_[a-f0-9]{24}::/.test(m.slug)));
  for (const p of providers) {
    const route = routeFor({ model: codexModelId(p.id, "gpt-6-astra") }, state);
    assert.equal(route.provider.id, p.id); assert.equal(route.official, false); assert.equal(route.body.model, "gpt-6-astra");
    assert.throws(() => routeFor({ model: p.id + "::gpt-6-astra" }, state), /未启用/);
  }
  assert.equal(routeFor({ model: "gpt-6-astra" }, state).official, true);
  assert.throws(() => routeFor({ model: "ASS_missing::gpt-6-astra" }, state), /未启用/);
  state.providers.push({ ...providers[1], id: providers[0].id });
  assert.throws(() => routeFor({ model: models[0].slug }, state), /冲突/);
});

test("ASS writes only its own provider and restores the exact original endpoint, preserving auth", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = 'model = "gpt-6-astra"\nopenai_base_url = "https://original.invalid/v1"\n[features]\nkeep = true\n';
  atomic(manager.file, original);
  const auth = path.join(dir, "codex", "auth.json"); atomic(auth, '{"tokens":"synthetic-unchanged"}');
  manager.attach();
  const parsed = TOML.parse(fs.readFileSync(manager.file, "utf8"));
  assert.equal(parsed.model_provider, "ASS"); assert.equal(parsed.openai_base_url, manager.baseUrl);
  assert.deepEqual(Object.keys(parsed.model_providers), ["ASS"]);
  for (const id of ["ASS"]) {
    assert.equal(parsed.model_providers[id].base_url, manager.baseUrl);
    assert.equal(parsed.model_providers[id].supports_websockets, false);
    assert.equal(parsed.model_providers[id].requires_openai_auth, true);
  }
  assert.equal(parsed.model_providers.openai, undefined);
  manager.detach(); assert.deepEqual(TOML.parse(fs.readFileSync(manager.file, "utf8")), TOML.parse(original));
  assert.equal(fs.readFileSync(auth, "utf8"), '{"tokens":"synthetic-unchanged"}');
});

test("Codex OAuth and accountless injection preserve the native account backend", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-codex-bootstrap-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codex = path.join(dir, "codex"), data = path.join(dir, "data");
  fs.mkdirSync(codex);
  const manager = new ConfigManager(codex, data, 32123);
  for (const endpoint of [null, "https://chatgpt.com/backend-api/", "https://workspace.example/backend-api/"]) {
    const baseline = (endpoint ? `chatgpt_base_url = ${JSON.stringify(endpoint)}\n` : "") + '[features]\nkeep=true\n';
    for (const gatewayAuth of [true, false]) {
      const prepared = prepareConfig(baseline, manager.catalog, manager.baseUrl, null, "a".repeat(64), gatewayAuth);
      assert.equal(TOML.parse(prepared.text).chatgpt_base_url, endpoint ?? undefined);
      assert.equal(Object.hasOwn(prepared.replaced, "chatgpt_base_url"), false);
      atomic(manager.record, JSON.stringify({ replaced: prepared.replaced,
        blocks: prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
      atomic(manager.file, prepared.text);
      assert.equal(manager.status().legacyWorkspaceRelay, false);
      assert.deepEqual(TOML.parse(manager.preflightDetach().next), TOML.parse(baseline));
    }
  }
});

test("old provider records are rejected by repair, resync and withdrawal without writes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-reject-old-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  atomic(manager.file, 'model = "official-original"\n[features]\nkeep = true\n');
  manager.attach();
  const current = fs.readFileSync(manager.file, "utf8");
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  for (const provider of ["ass_router", "aimai1", "unknown"]) {
    const old = current.replace('model_provider = "ASS"', `model_provider = "${provider}"`)
      .replace("[model_providers.ASS]", `[model_providers.${provider}]`);
    const saved = JSON.stringify({ ...record, blocks: old.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) });
    atomic(manager.file, old); atomic(manager.record, saved);
    assert.equal(manager.status().attached, false);
    for (const action of [() => manager.prepareRepair(), () => manager.attach(), () => manager.detach()]) {
      assert.throws(action, /不匹配/);
      assert.equal(fs.readFileSync(manager.file, "utf8"), old);
      assert.equal(fs.readFileSync(manager.record, "utf8"), saved);
    }
  }
  assert.throws(() => prepareConfig('[model_providers.aimai1]\nname="other"', "catalog"), /其他工具/);
});

test("repair rejects legacy and foreign saved endpoints without writes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-reject-endpoint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  atomic(manager.file, 'model = "official"\n'); manager.attach();
  const current = fs.readFileSync(manager.file, "utf8");
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  for (const endpoint of [manager.baseUrl.replace("/clients/ASS/", "/clients/codex/"), "http://127.0.0.1:25819/v1", "https://foreign.invalid/v1"]) {
    for (const old of [current.replaceAll(manager.baseUrl, endpoint), current.replace('openai_base_url = ' + JSON.stringify(manager.baseUrl),
      'openai_base_url = ' + JSON.stringify(endpoint))]) {
      const saved = JSON.stringify({ ...record, blocks: old.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) });
      atomic(manager.file, old); atomic(manager.record, saved);
      for (const action of [() => manager.prepareRepair(), () => manager.attach(), () => manager.detach()]) assert.throws(action, /不匹配/);
      assert.equal(fs.readFileSync(manager.file, "utf8"), old);
      assert.equal(fs.readFileSync(manager.record, "utf8"), saved);
    }
  }
  const conflict = current + '\n# >>> aimami-relay codex-router top start\n';
  atomic(manager.file, conflict); atomic(manager.record, JSON.stringify(record));
  assert.throws(() => manager.prepareRepair(), /其他路由工具/);
  assert.equal(fs.readFileSync(manager.file, "utf8"), conflict);
});

test("attach preserves native namespaced selections without guessing their ownership", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-selected-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = 'model="aimami_relay_fixture::gpt-6-astra"\nmodel_reasoning_effort="max"\n';
  atomic(manager.file, original); manager.attach();
  const current = TOML.parse(fs.readFileSync(manager.file, "utf8"));
  assert.equal(current.model, "aimami_relay_fixture::gpt-6-astra"); assert.equal(current.model_reasoning_effort, "max");
  manager.detach(); assert.deepEqual(TOML.parse(fs.readFileSync(manager.file, "utf8")), TOML.parse(original));
});

test("current records containing legacy provider aliases are rejected without writes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-remove-aliases-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = 'model = "official"\n[features]\nkeep = true\n';
  atomic(manager.file, original); manager.attach();
  const current = fs.readFileSync(manager.file, "utf8");
  const definition = current.match(/\[model_providers\.ASS\]\n([\s\S]*?)# <<< ass managed end/)[1];
  const old = current.replace(/(\[model_providers\.ASS\][\s\S]*?)(# <<< ass managed end)/,
    '$1\n[model_providers.ass_router]\n' + definition + '\n[model_providers.aimai1]\n' + definition + '$2');
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  record.blocks = old.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g);
  atomic(manager.file, old); atomic(manager.record, JSON.stringify(record));
  assert.equal(manager.status().attached, false);
  const saved = fs.readFileSync(manager.record, "utf8");
  for (const action of [() => manager.prepareRepair(), () => manager.attach(), () => manager.detach()]) assert.throws(action, /不匹配/);
  assert.equal(fs.readFileSync(manager.file, "utf8"), old);
  assert.equal(fs.readFileSync(manager.record, "utf8"), saved);
});

const negotiate = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port, path: route, headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "c3ludGhldGljLXRlc3Q=", "Sec-WebSocket-Version": "13", ...headers,
  } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", reject); req.setTimeout(2000, () => req.destroy(Error("upgrade timed out"))); req.end();
});
test("old attachment without saved blocks is rejected without reading its backup", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-legacy-attachment-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = 'model="official"\n';
  const backup = path.join(dir, "backup.toml"); atomic(backup, original);
  const old = '# >>> ass managed start\nmodel_provider = "ass_router"\nmodel_catalog_json = ' + JSON.stringify(manager.catalog) +
    '\n# <<< ass managed end\n' + original + '\n# >>> ass managed start\n[model_providers.ass_router]\nname = "AI Switch Servant"\nbase_url = "http://127.0.0.1:25819/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n# <<< ass managed end\n';
  atomic(manager.file, old); atomic(manager.record, JSON.stringify({ backup, replaced: { model_provider: null, model_catalog_json: null } }));
  const saved = fs.readFileSync(manager.record, "utf8");
  fs.unlinkSync(backup);
  for (const action of [() => manager.prepareRepair(), () => manager.attach(), () => manager.detach()]) assert.throws(action, /管理区段记录/);
  assert.equal(fs.readFileSync(manager.file, "utf8"), old);
  assert.equal(fs.readFileSync(manager.record, "utf8"), saved);
});
test("current model-only ownership survives repair and resync and restores its exact baseline", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-current-selection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  const original = 'model="relay::gpt"\nmodel_reasoning_effort="max"\n[features]\nkeep=true\n';
  atomic(manager.file, original); manager.attach();
  const selection = codexModelId("relay", "gpt");
  const current = fs.readFileSync(manager.file, "utf8").replace('model="relay::gpt"\n', "")
    .replace("# <<< ass managed end", `model = ${JSON.stringify(selection)}\n# <<< ass managed end`);
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  record.replaced.model = "relay::gpt";
  record.blocks = current.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g);
  atomic(manager.file, current); atomic(manager.record, JSON.stringify(record));
  assert.equal(manager.prepareRepair().after, current);
  assert.deepEqual(TOML.parse(manager.preflightDetach().next), TOML.parse(original));
  manager.attach(); manager.attach();
  const synced = TOML.parse(fs.readFileSync(manager.file, "utf8"));
  assert.equal(synced.model, selection);
  assert.equal(synced.model_reasoning_effort, "max");
  const saved = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  assert.equal(saved.replaced.model, "relay::gpt");
  assert.equal(Object.hasOwn(saved.replaced, "model_reasoning_effort"), false);
  const repair = manager.prepareRepair();
  assert.equal(repair.before, repair.after);
  manager.detach();
  assert.deepEqual(TOML.parse(fs.readFileSync(manager.file, "utf8")), TOML.parse(original));
});
test("repair rejects unknown ownership and preserves non-ASS fields", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-reject-ownership-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, "codex"), path.join(dir, "app"));
  atomic(manager.file, '[features]\nkeep=true\n'); manager.attach();
  const current = fs.readFileSync(manager.file, "utf8");
  const record = JSON.parse(fs.readFileSync(manager.record, "utf8"));
  for (const changed of [
    { ...record, replaced: { ...record.replaced, unrelated: "must-not-write" } },
    { ...record, replaced: null },
    { ...record, blocks: [record.blocks[0], record.blocks[1].replace('name = "ASS"', 'name = "unknown"')] },
    { ...record, blocks: [record.blocks[0], record.blocks[1].replace('wire_api = "responses"', 'wire_api = "chat"')] },
    { ...record, blocks: [record.blocks[0].replace("# <<< ass managed end", 'model = "unknown::gpt"\n# <<< ass managed end'), record.blocks[1]] },
  ]) {
    const saved = JSON.stringify(changed); atomic(manager.record, saved);
    for (const action of [() => manager.prepareRepair(), () => manager.attach(), () => manager.detach()]) assert.throws(action, /记录无效|不匹配/);
    assert.equal(fs.readFileSync(manager.file, "utf8"), current);
    assert.equal(fs.readFileSync(manager.record, "utf8"), saved);
  }
  atomic(manager.record, JSON.stringify(record));
  const mixed = current.replace('name = "ASS"', 'name = "ASS"\nuser_field = "keep"');
  atomic(manager.file, mixed);
  assert.throws(() => manager.prepareRepair(), /非 ASS 字段/);
  assert.equal(fs.readFileSync(manager.file, "utf8"), mixed);
  const unmarked = current.replaceAll("# >>> ass managed start\n", "").replaceAll("# <<< ass managed end\n", "");
  atomic(manager.file, unmarked);
  assert.throws(() => manager.prepareRepair(), /无法确认归属/);
  assert.throws(() => manager.attach(), /其他工具/);
  assert.throws(() => manager.detach(), /无法归属/);
  assert.equal(fs.readFileSync(manager.file, "utf8"), unmarked);
});

test("native model/effort writes and formatting do not invalidate immutable ASS routing ownership", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ass-native-selection-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manager=new ConfigManager(path.join(dir,'codex'),path.join(dir,'data'));
  atomic(manager.file,'model="gpt-original"\nmodel_reasoning_effort="low"\n[features]\nkeep=true\n');
  const prepared=manager.prepareAttach({model:'gpt-6.1-sol',effort:'high'},'a'.repeat(64),true);
  atomic(manager.record,JSON.stringify({replaced:prepared.replaced,blocks:prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)}));
  atomic(manager.file,prepared.text);
  const savedRecord=fs.readFileSync(manager.record,'utf8');
  for(const model of ['gpt-6-astra',codexModelId('fixture','deepseek-flash')]) {
    const current=prepared.text.replace('model = "gpt-6.1-sol"',`model = ${JSON.stringify(model)}`).replace('model_reasoning_effort = "high"','model_reasoning_effort = "max"');
    atomic(manager.file,current);
    assert.equal(TOML.parse(manager.preflightDetach().next).model,'gpt-original');
    const repair=manager.prepareRepair();
    assert.equal(TOML.parse(repair.after).model,model);
    assert.equal(TOML.parse(repair.after).model_reasoning_effort,'max');
    assert.equal(repair.after,current);
    assert.equal(fs.readFileSync(manager.record,'utf8'),savedRecord);
    assert.equal(fs.readFileSync(manager.file,'utf8'),current);
    atomic(manager.file,current.replaceAll('\n','\r\n').replace('name = "ASS"',"name = 'ASS' # native formatting"));
    assert.doesNotThrow(()=>manager.preflightDetach());
    for(const [before,after] of [['base_url = '+JSON.stringify(manager.baseUrl),'base_url = "https://foreign.invalid/v1"'],
      ['requires_openai_auth = true','requires_openai_auth = false'],['supports_websockets = false','supports_websockets = true'],
      ['model_provider = "ASS"','model_provider = "other"'],['wire_api = "responses"','wire_api = "chat"'],
      ['name = "ASS"','name = "ASS"\nforeign_field = "keep"']]) {
      atomic(manager.file,current.replace(before,after));
      assert.throws(()=>manager.preflightDetach(),/外部修改/);
    }
  }
});

test("native-added selection remains on detach if ASS never owned its rollback baseline", t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ass-native-selection-added-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manager=new ConfigManager(path.join(dir,'codex'),path.join(dir,'data'));
  atomic(manager.file,'[features]\nkeep=true\n');manager.attach();
  const current=fs.readFileSync(manager.file,'utf8').replace('# <<< ass managed end','model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n# <<< ass managed end');
  atomic(manager.file,current);manager.detach();
  const restored=TOML.parse(fs.readFileSync(manager.file,'utf8'));
  assert.equal(restored.model,'gpt-6-astra');assert.equal(restored.model_reasoning_effort,'high');assert.equal(restored.features.keep,true);
});

test("native root settings written inside marker comments survive validation, repair, resync and detach", t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ass-native-root-writes-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manager=new ConfigManager(path.join(dir,'codex'),path.join(dir,'data'));
  const original='model="gpt-original"\n[features]\nkeep=true\n';atomic(manager.file,original);
  const prepared=manager.prepareAttach({model:'gpt-6.1-sol',effort:'high'},'a'.repeat(64),true);
  atomic(manager.record,JSON.stringify({replaced:prepared.replaced,blocks:prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)}));
  const native=prepared.text.replace('# <<< ass managed end','notify = ["fixture-notify", "turn-ended"]\n# <<< ass managed end')
    .replace(/(# <<< ass managed end)\s*$/, '[desktop]\nfollowUpQueueMode="steer"\n[plugins."fixture@bundled"]\nenabled=true\n[mcp_servers.fixture]\ncommand="fixture-mcp"\n$1\n');
  const expected=TOML.parse(native);
  const check=text=>{const parsed=TOML.parse(text);for(const k of ['notify','desktop','plugins','mcp_servers','features'])assert.deepEqual(parsed[k],expected[k],k);};
  atomic(manager.file,native);
  check(manager.preflightDetach().next);
  assert.equal(manager.prepareRepair().after,native,'normal native additions need no writes');
  atomic(manager.file,native.replace('name = "ASS"','name = "damaged"'));
  const repair=manager.prepareRepair();check(repair.after);
  atomic(manager.file,repair.after);assert.doesNotThrow(()=>manager.preflightDetach());
  const sync=manager.prepareAttach({model:'gpt-6-astra',effort:'xhigh'},'a'.repeat(64),true);check(sync.text);
  atomic(manager.record,JSON.stringify({replaced:sync.replaced,blocks:sync.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)}));
  atomic(manager.file,sync.text);manager.detach();check(fs.readFileSync(manager.file,'utf8'));
  assert.equal(TOML.parse(fs.readFileSync(manager.file,'utf8')).model,'gpt-original');
});

test("retained built-in WS explicitly falls back to SSE without sending credentials upstream", async t => {
  let calls = 0, allow = true;
  const router = new Router({ getState: () => ({ providers: [] }), fetchUpstream: async () => { calls++; throw Error("unexpected"); }, allowClient: () => allow });
  await router.start(0); t.after(() => router.stop());
  assert.equal(await negotiate(router.port, "/clients/ASS/v1/responses"), 426);
  for (const route of ["/clients/codex/v1/responses", "/v1/responses"]) {
    assert.equal(await negotiate(router.port, route), 404);
    const reply = await fetch(`http://127.0.0.1:${router.port}${route}`, { method: "POST" });
    assert.equal(reply.status, 404); await reply.text();
  }
  assert.equal(await negotiate(router.port, "/clients/ASS/v1/responses", { Origin: "https://untrusted.invalid" }), 403);
  assert.equal(await negotiate(router.port, "/clients/claude/v1/responses"), 404);
  allow = false; assert.equal(await negotiate(router.port, "/clients/ASS/v1/responses"), 503);
  assert.equal(calls, 0); assert.equal(router.active, 0);
});
