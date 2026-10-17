const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const TOML = require("@iarna/toml");
const { Store } = require("../core/store.cjs");
const { ConfigManager, atomic } = require("../core/config.cjs");
const { HarnessManager } = require("../core/harnesses.cjs");
const { ProxyConfig } = require("../core/proxy-config.cjs");
const { Connections } = require("../core/connections.cjs");
const { InjectionFiles } = require("../core/injection-files.cjs");
const { modelRef } = require("../core/client-policy.cjs");
const { routeFor } = require("../core/router.cjs");
const { harnessRoute } = require("../core/harness-route.cjs");
const crypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-proxy-separate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), codex = path.join(root, "codex");
  fs.mkdirSync(codex);
  const original = 'model = "gpt-original"\nmodel_reasoning_effort = "high"\n[features]\nkeep = true\n';
  atomic(path.join(codex, "config.toml"), original);
  atomic(path.join(codex, "auth.json"), '{"tokens":{"access_token":"synthetic-oauth-keep"}}');
  const store = new Store(data, codex, crypt);
  store.updateProvider({ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "synthetic-relay-key", models: [
    { model: "one", wireApi: "openai-chat" }, { model: "two", wireApi: "anthropic" },
  ] });
  const manager = new HarnessManager(data, () => store.state, store.officialModels, codex, { home: root, env: {}, launchEnv: { PATH: "" }, isConnected: () => true });
  const config = new ConfigManager(codex, data);
  const proxy = new ProxyConfig(data, crypt, manager, store, config);
  manager.options.proxyConfig = proxy;
  const processes = { snapshot: () => ({ sessions: [] }), refresh: async () => {} };
  const router = { clientActive: () => 0, start: async () => {}, stop: async () => {} };
  const connections = new Connections({ dataDir: data, config, proxyConfig: proxy, injections: new InjectionFiles(data), router, processes });
  return { root, data, codex, original, store, manager, config, proxy, connections, router };
}

function legacyWorkspaceRelay(f, baseline = null) {
  const text = fs.readFileSync(f.config.file, "utf8").replace(/^chatgpt_base_url\s*=.*\n/m, "")
    .replace('# >>> ass managed start\n', '# >>> ass managed start\n' +
      `chatgpt_base_url = ${JSON.stringify(f.config.legacyChatgptBaseUrl)}\n`);
  const record = JSON.parse(fs.readFileSync(f.config.record, "utf8"));
  record.replaced.chatgpt_base_url = baseline;
  record.blocks = text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g);
  atomic(f.config.file, text); atomic(f.config.record, JSON.stringify(record));
}

test('missing Codex attachment recovers from encrypted applied snapshot after restart without applying drafts', t => {
  const f=fixture(t); f.proxy.sync('codex');
  const owned=JSON.parse(fs.readFileSync(f.config.record,'utf8'));
  fs.unlinkSync(f.config.record);
  const config=new ConfigManager(f.codex,f.data), proxy=new ProxyConfig(f.data,crypt,f.manager,f.store,config);
  f.store.updateProvider({...f.store.state.providers[0],baseUrl:'https://draft.invalid/v1'});
  const restored=fs.readFileSync(config.record);
  assert.doesNotThrow(()=>config.preflightDetach());
  assert.deepEqual(fs.readFileSync(config.record),restored,'preflight remains read only after startup recovery');
  proxy.repair('codex');
  assert.deepEqual(JSON.parse(fs.readFileSync(config.record,'utf8')),owned);
  assert.equal(proxy.clients.codex.providers[0].baseUrl,'https://relay.example/v1');
  proxy.repair('codex');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.codex,'auth.json'))).tokens.access_token,'synthetic-oauth-keep');
});

test('attachment recovery refuses corrupt present records, foreign config and missing trusted snapshot',t=>{
  const f=fixture(t); f.proxy.sync('codex');
  const owned=fs.readFileSync(f.config.record,'utf8');
  atomic(f.config.record,'{broken');assert.throws(()=>f.config.preflightDetach(),/记录|解析/);
  fs.unlinkSync(f.config.record);
  atomic(f.config.file,fs.readFileSync(f.config.file,'utf8').replace('name = "ASS"','name = "foreign"'));
  assert.throws(()=>f.config.preflightDetach(),/外部修改|不匹配/);
  atomic(f.config.record,owned); const standalone=new ConfigManager(f.codex,f.data);fs.unlinkSync(f.config.record);
  assert.throws(()=>standalone.preflightDetach(),e=>!e.message.includes('ENOENT')&&/记录.*缺失/.test(e.message));
});

test('failed missing-record recovery rolls back the record creation and can be retried',t=>{
  const f=fixture(t);f.proxy.sync('codex');fs.unlinkSync(f.config.record);
  const config=fs.readFileSync(f.config.file),catalog=fs.readFileSync(f.config.catalog);
  const persist=f.proxy.persist.bind(f.proxy);let calls=0;
  f.proxy.persist=(...args)=>{if(++calls===2)throw Error('synthetic recovery commit failure');return persist(...args)};
  assert.throws(()=>f.proxy.repair('codex'),/recovery commit failure/);
  assert.equal(fs.existsSync(f.config.record),false);assert.deepEqual(fs.readFileSync(f.config.file),config);
  assert.deepEqual(fs.readFileSync(f.config.catalog),catalog);
  f.proxy.persist=persist;f.proxy.repair('codex');assert.ok(fs.existsSync(f.config.record));f.proxy.repair('codex');
});

test('legacy attachment migration tolerates unreadable records and requires owned config before adoption',t=>{
  const f=fixture(t);f.proxy.sync('codex');
  const legacy=structuredClone(f.proxy.clients.codex);delete legacy.attachment;
  f.proxy.persist({codex:legacy});
  const native=fs.readFileSync(f.config.file,'utf8'),record=fs.readFileSync(f.config.record,'utf8');
  const applied=fs.readFileSync(f.proxy.file);
  const originalRead=fs.readFileSync;
  fs.readFileSync=function(file,...args){
    if(file===f.config.record)throw Object.assign(Error('synthetic access failure'),{code:'EACCES'});
    return originalRead.call(this,file,...args);
  };
  try {
    for(let i=0;i<2;i++){
      let proxy;assert.doesNotThrow(()=>{proxy=new ProxyConfig(f.data,crypt,f.manager,f.store,new ConfigManager(f.codex,f.data))});
      assert.equal(proxy.clients.codex.attachment,undefined);
    }
  } finally { fs.readFileSync=originalRead; }
  for(const text of [null,f.original]){
    if(text===null)fs.unlinkSync(f.config.file);else atomic(f.config.file,text);
    for(let i=0;i<2;i++){
      const proxy=new ProxyConfig(f.data,crypt,f.manager,f.store,new ConfigManager(f.codex,f.data));
      assert.equal(proxy.clients.codex.attachment,undefined);
      assert.deepEqual(fs.readFileSync(f.proxy.file),applied);
      assert.equal(fs.readFileSync(f.config.record,'utf8'),record);
    }
  }
  atomic(f.config.file,native);
  const proxy=new ProxyConfig(f.data,crypt,f.manager,f.store,new ConfigManager(f.codex,f.data));
  assert.deepEqual(proxy.clients.codex.attachment,JSON.parse(record));
  const migrated=fs.readFileSync(proxy.file);
  new ProxyConfig(f.data,crypt,f.manager,f.store,new ConfigManager(f.codex,f.data));
  assert.deepEqual(fs.readFileSync(proxy.file),migrated);
});

test('official catalog refresh changes native metadata only; drafts, bindings and OAuth stay intact',t=>{
  const f=fixture(t);f.proxy.sync('codex');
  const applied=structuredClone(f.proxy.clients.codex),native=fs.readFileSync(f.config.file,'utf8'),auth=fs.readFileSync(path.join(f.codex,'auth.json'),'utf8');
  atomic(path.join(f.codex,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',context_window:500000,max_context_window:872000,default_reasoning_level:'low'}]}));
  f.store.updateProvider({...f.store.state.providers[0],baseUrl:'https://unapplied.invalid/v1'});
  assert.equal(f.proxy.refreshOfficialCatalog(),true);assert.equal(f.proxy.refreshOfficialCatalog(),false);
  assert.equal(f.proxy.clients.codex.catalog.models[0].context_window,500000);
  assert.equal(f.proxy.clients.codex.catalog.models[0].max_context_window,872000);
  assert.deepEqual(f.proxy.clients.codex.providers,applied.providers);
  assert.deepEqual(f.proxy.clients.codex.catalog.models.filter(m=>m.slug.includes('::')),applied.catalog.models.filter(m=>m.slug.includes('::')));
  assert.equal(fs.readFileSync(f.config.file,'utf8'),native);assert.equal(fs.readFileSync(path.join(f.codex,'auth.json'),'utf8'),auth);
  atomic(f.config.catalog,'{}');
  atomic(path.join(f.codex,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',context_window:600000}]}));
  assert.throws(()=>f.proxy.refreshOfficialCatalog(),/外部修改/);assert.equal(fs.readFileSync(f.config.catalog,'utf8'),'{}');
});

test('applied DeepSeek tool metadata repairs without syncing drafts or changing OAuth and selections',t=>{
  const f=fixture(t);
  f.manager.save();
  f.store.updateProvider({id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',apiKey:'synthetic-deepseek',models:[{model:'deepseek-flash',wireApi:'openai-responses',contextWindow:900000,defaultEffort:'max'}]});
  f.proxy.sync('codex');
  const plan=structuredClone(f.proxy.clients.codex);
  const entry=plan.catalog.models.find(m=>m.slug.endsWith('::deepseek-flash'));
  Object.assign(entry,{use_responses_lite:true,tool_mode:'direct',apply_patch_tool_type:null,supports_parallel_tool_calls:false});
  f.proxy.persist({...f.proxy.clients,codex:plan});
  atomic(f.config.catalog,JSON.stringify(plan.catalog,null,2));
  const native=fs.readFileSync(f.config.file),auth=fs.readFileSync(path.join(f.codex,'auth.json')),clients=fs.readFileSync(f.manager.file),applied=structuredClone(f.proxy.clients.codex);
  f.store.updateProvider({...f.store.state.providers.find(p=>p.id==='deepseek'),baseUrl:'https://unapplied.invalid/v1',name:'Unapplied draft'});
  assert.equal(f.proxy.refreshOfficialCatalog(),true);assert.equal(f.proxy.refreshOfficialCatalog(),false);
  const repaired=f.proxy.clients.codex.catalog.models.find(m=>m.slug===entry.slug);
  assert.equal(repaired.tool_mode,null);assert.equal(repaired.use_responses_lite,false);assert.equal(repaired.apply_patch_tool_type,'freeform');
  assert.equal(repaired.context_window,900000);assert.equal(repaired.default_reasoning_level,'max');
  assert.deepEqual(f.proxy.clients.codex.providers,applied.providers);assert.deepEqual(f.proxy.clients.codex.defaultModel,applied.defaultModel);
  assert.deepEqual(f.proxy.clients.codex.catalog.models.filter(m=>!m.slug.includes('::')),applied.catalog.models.filter(m=>!m.slug.includes('::')));
  assert.deepEqual(fs.readFileSync(f.config.file),native);assert.deepEqual(fs.readFileSync(path.join(f.codex,'auth.json')),auth);assert.deepEqual(fs.readFileSync(f.manager.file),clients);
  const old=structuredClone(f.proxy.clients.codex);old.catalog.models.find(m=>m.slug===entry.slug).tool_mode='direct';
  f.proxy.persist({...f.proxy.clients,codex:old});atomic(f.config.catalog,'{}');
  assert.throws(()=>f.proxy.refreshOfficialCatalog(),/外部修改/);assert.equal(fs.readFileSync(f.config.catalog,'utf8'),'{}');
});

test('prediction compatibility is opt-in, preserves OAuth, survives repair and reverses cleanly',t=>{
  const f=fixture(t),auth=fs.readFileSync(path.join(f.codex,'auth.json'),'utf8');
  f.proxy.sync('codex');assert.equal(TOML.parse(fs.readFileSync(f.config.file,'utf8')).model_provider,'ASS');
  f.manager.setInjection('codex',{excludedProviders:[],predictionCompatibility:true});
  for(let i=0;i<2;i++) {
    f.proxy.sync('codex');
    const parsed=TOML.parse(fs.readFileSync(f.config.file,'utf8'));
    assert.equal(parsed.model_provider,'openai');assert.equal(parsed.openai_base_url,f.config.baseUrl);
    assert.equal(parsed.chatgpt_base_url,undefined);assert.equal(parsed.model_providers.openai,undefined);
    assert.equal(parsed.model_providers.ASS.requires_openai_auth,true);
    assert.equal(f.config.status().attached,true);assert.equal(f.proxy.status('codex',true).applied,true);
    f.proxy.repair('codex');assert.equal(fs.readFileSync(path.join(f.codex,'auth.json'),'utf8'),auth);
  }
  f.proxy.sync('codex',true);assert.equal(f.proxy.clients.codex.predictionCompatibility,undefined);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file,'utf8')).model_provider,'ASS');
  f.manager.setInjection('codex',{predictionCompatibility:false});f.proxy.sync('codex',false);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file,'utf8')).model_provider,'ASS');
  f.config.detach();assert.deepEqual(TOML.parse(fs.readFileSync(f.config.file,'utf8')),TOML.parse(f.original));
  assert.throws(()=>f.manager.setInjection('pi',{predictionCompatibility:true}),/无效/);
  assert.throws(()=>f.manager.setInjection('codex',{predictionCompatibility:'yes'}),/无效/);
});

test('Codex per-model tool choice applies only on sync and survives repeated sync, repair and restart',t=>{
  const f=fixture(t),ref=modelRef('relay','one');
  f.store.updateProvider({...f.store.state.providers[0],models:f.store.state.providers[0].models.map(m=>({...m,wireApi:'openai-responses'}))});
  const source=structuredClone(f.store.state.providers),auth=fs.readFileSync(path.join(f.codex,'auth.json'));
  f.proxy.sync('codex');const applied=structuredClone(f.proxy.clients.codex);
  f.manager.setInjection('codex',{codexToolMode:{ref,mode:'compatible'}});
  assert.equal(f.proxy.status('codex',true).pending,true);
  assert.deepEqual(f.proxy.clients.codex,applied,'saving injection choices never mutates applied routing');
  assert.equal(f.proxy.desired('claude').providers[0].models[0].codexToolMode,undefined);
  const bridge=require('../core/deepseek-compat.cjs').needsResponsesToolBridge;
  const body={tools:[{type:'custom',name:'check'}]};
  for(const mode of ['compatible','native','auto','compatible']) {
    f.manager.setInjection('codex',{codexToolMode:{ref,mode}});
    for(let i=0;i<2;i++) {
      f.proxy.sync('codex');
      const plan=f.proxy.clients.codex,p=plan.providers[0],m=p.models[0],entry=plan.catalog.models.find(m=>m.slug.endsWith('::one'));
      assert.equal(bridge(p,body,m),mode==='compatible');
      assert.equal(entry.tool_mode,mode==='compatible'?null:'direct');
      assert.equal(entry.apply_patch_tool_type,mode==='compatible'?'freeform':null);
      assert.equal(p.models[1].codexToolMode,undefined,'other models keep their own choice');
      assert.deepEqual(plan.catalog.models.filter(m=>!m.slug.includes('::')),applied.catalog.models.filter(m=>!m.slug.includes('::')));
      f.proxy.repair('codex');assert.equal(f.proxy.status('codex',true).applied,true);
      const reloaded=new ProxyConfig(f.data,crypt,f.manager,f.store,new ConfigManager(f.codex,f.data));
      assert.equal(bridge(reloaded.clients.codex.providers[0],body,reloaded.clients.codex.providers[0].models[0]),mode==='compatible');
    }
  }
  assert.deepEqual(f.store.state.providers,source);assert.deepEqual(fs.readFileSync(path.join(f.codex,'auth.json')),auth);
});

for (const action of ["sync", "repair"]) {
  for (const baseline of [null, "https://chatgpt.com/backend-api/", "https://workspace.example/backend-api/"]) {
    test(`Codex ${action} retires v0.3.28 account relay with baseline ${baseline || "native default"}`, t => {
      const f = fixture(t);
      if (baseline) atomic(f.config.file, `chatgpt_base_url = ${JSON.stringify(baseline)}\n` + f.original);
      f.proxy.sync("codex");
      const clients = structuredClone(f.proxy.clients);
      const auth = fs.readFileSync(path.join(f.codex, "auth.json"));
      legacyWorkspaceRelay(f, baseline);
      const before = [f.config.file, f.config.record].map(file => fs.readFileSync(file));
      const restarted = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
      assert.equal(restarted.status("codex", true).pending, true);
      assert.equal(restarted.status("codex", true).error, "");
      for (const [i, file] of [f.config.file, f.config.record].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
      if (action === "repair") assert.equal(f.proxy.repair("codex").migrated, true);
      else f.proxy.sync("codex");
      assert.equal(TOML.parse(fs.readFileSync(f.config.file, "utf8")).chatgpt_base_url, baseline ?? undefined);
      const record = JSON.parse(fs.readFileSync(f.config.record, "utf8"));
      assert.equal(Object.hasOwn(record.replaced, "chatgpt_base_url"), false);
      assert.ok(record.blocks.every(block => !block.includes("chatgpt_base_url")));
      assert.deepEqual(f.proxy.clients, clients);
      assert.equal(f.proxy.status("codex", true).applied, true);
      assert.equal(f.config.status().legacyWorkspaceRelay, false);
      assert.equal(new ProxyConfig(f.data, crypt, f.manager, f.store, f.config).status("codex", true).applied, true);
      assert.deepEqual(fs.readFileSync(path.join(f.codex, "auth.json")), auth);
      f.config.detach(); f.proxy.restore(["codex"]);
      assert.deepEqual(TOML.parse(fs.readFileSync(f.config.file, "utf8")), {
        ...TOML.parse(f.original), ...(baseline ? { chatgpt_base_url: baseline } : {}),
      });
    });
  }

  test(`Codex ${action} rollback keeps both old relay and ownership record recoverable`, t => {
    const f = fixture(t); f.proxy.sync("codex"); legacyWorkspaceRelay(f, "https://chatgpt.com/backend-api/");
    const files = [f.config.file, f.config.record, f.config.catalog, path.join(f.codex, "auth.json")];
    const before = files.map(file => fs.readFileSync(file));
    const persist = f.proxy.persist.bind(f.proxy); let calls = 0;
    f.proxy.persist = (...args) => { if (++calls === 2) throw Error("synthetic relay migration failure"); return persist(...args); };
    assert.throws(() => f.proxy[action]("codex"), /relay migration failure/);
    assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
    assert.equal(f.proxy.pending, null);
    f.proxy.persist = persist;
    f.proxy[action]("codex");
    assert.equal(f.proxy.status("codex", true).applied, true);
  });
}

test("Codex legacy relay repair preserves applied routes and later account backend edits", t => {
  const f = fixture(t); f.proxy.sync("codex"); legacyWorkspaceRelay(f);
  const clients = structuredClone(f.proxy.clients);
  f.store.updateProvider({ ...f.store.state.providers[0], baseUrl: "https://pending.example/v1", apiKey: "pending-key" });
  f.proxy.repair("codex");
  assert.deepEqual(f.proxy.clients, clients);
  assert.equal(f.proxy.status("codex", true).pending, true);
  atomic(f.config.file, 'chatgpt_base_url = "https://user.example/backend-api/"\n' + fs.readFileSync(f.config.file, "utf8"));
  f.config.detach();
  assert.equal(TOML.parse(fs.readFileSync(f.config.file, "utf8")).chatgpt_base_url, "https://user.example/backend-api/");
});

test("Codex legacy relay without an account backend baseline cannot be migrated or removed", t => {
  const f = fixture(t); f.proxy.sync("codex"); legacyWorkspaceRelay(f);
  const record = JSON.parse(fs.readFileSync(f.config.record, "utf8")); delete record.replaced.chatgpt_base_url;
  atomic(f.config.record, JSON.stringify(record));
  const files = [f.config.file, f.config.record, f.config.catalog], before = files.map(file => fs.readFileSync(file));
  assert.throws(() => f.proxy.sync("codex"), /不匹配/);
  assert.throws(() => f.proxy.repair("codex"), /不匹配/);
  assert.throws(() => f.config.detach(), /不匹配/);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});
test("proxy drafts never change attached catalog or routing; provider sync writes the selected ASS default and restart", (t) => {
  const f = fixture(t);
  f.manager.setInjection("codex", { excludedProviders: [], defaultModel: modelRef("relay", "two") });
  f.proxy.sync("codex");
  const before = fs.readFileSync(f.config.catalog, "utf8");
  const selected = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(selected.model, "ASS_682fbae20f3428bcec4c117c::two");
  assert.equal(selected.model_reasoning_effort, "medium");
  assert.equal(f.proxy.status("codex", true).applied, true);
  assert.equal(JSON.parse(before).models.some((m) => m.slug === require("../core/models.cjs").codexModelId("relay", "two")), true);
  const p = f.store.state.providers[0];
  f.store.updateProvider({ ...p, apiKey: "new-synthetic-key", baseUrl: "https://new.example/v1" });
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), before);
  const route = routeFor({ model: require("../core/models.cjs").codexModelId("relay", "one") }, f.proxy.routingState("codex"));
  assert.equal(route.provider.apiKey, "synthetic-relay-key");
  assert.match(route.url, /^https:\/\/relay.example/);
  assert.equal(f.proxy.status("codex", true).pending, true);
  assert.throws(() => f.manager.modelPlan("codex", modelRef("relay", "one"), "local"), /尚未同步/);
  const restartedStore = new Store(f.data, f.codex, crypt);
  const restarted = new ProxyConfig(f.data, crypt, f.manager, restartedStore, f.config);
  assert.equal(restarted.status("codex", true).pending, true);
  assert.equal(restarted.routingState("codex").providers[0].apiKey, "synthetic-relay-key");
  f.proxy.sync("codex");
  assert.equal(f.proxy.routingState("codex").providers[0].apiKey, "new-synthetic-key");
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  f.proxy.sync("codex");
  assert.equal(f.proxy.routingState("codex").providers.length, 0);
  assert.equal(f.proxy.status("codex", true).applied, true);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file, "utf8")).model, "gpt-original");
  atomic(f.config.file, fs.readFileSync(f.config.file, "utf8").replace("keep = true", "keep = false"));
  f.config.detach(); f.proxy.restore(["codex"]);
  const restored = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(restored.features.keep, false);
  assert.equal(restored.model_reasoning_effort, "high");
  assert.equal(fs.readFileSync(path.join(f.codex, "auth.json"), "utf8"), '{"tokens":{"access_token":"synthetic-oauth-keep"}}');
});
test("unsupported gpt-6-luna selection falls back to gpt-6-sol with xhigh", t => {
  const f = fixture(t);
  const provider = f.store.state.providers[0];
  f.store.updateProvider({ ...provider, models: [...provider.models, { model: "gpt-6-sol", wireApi: "openai-responses" }] });
  f.manager.setInjection("codex", { excludedProviders: [], defaultModel: modelRef("relay", "gpt-6-luna") });
  f.proxy.sync("codex");
  const current = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(current.model, "ASS_682fbae20f3428bcec4c117c::gpt-6-sol");
  assert.equal(current.model_reasoning_effort, "xhigh");
});
test("old and unknown applied catalog or default IDs are rejected without applying drafts", t => {
  const f = fixture(t); f.proxy.sync("codex");
  const original = structuredClone(f.proxy.clients);
  const { codexModelId } = require("../core/models.cjs");
  f.store.updateProvider({ ...f.store.state.providers[0], baseUrl: "https://pending.example/v1", apiKey: "synthetic-pending" });
  for (const id of ["relay::one", "unknown::one", "ASS_000000000000000000000000::one"]) {
    for (const field of ["catalog", "defaultModel"]) {
      const clients = structuredClone(original);
      if (field === "catalog") clients.codex.catalog.models.find(m => m.slug === codexModelId("relay", "one")).slug = id;
      else clients.codex.defaultModel = { model: id, effort: "high" };
      f.proxy.persist(clients); atomic(f.config.catalog, JSON.stringify(clients.codex.catalog, null, 2));
      const files = [f.proxy.file, f.config.file, f.config.record, f.config.catalog, path.join(f.codex, "auth.json")];
      const before = files.map(file => fs.readFileSync(file, "utf8"));
      assert.throws(() => f.proxy.repair("codex"), /旧版或不明/);
      assert.throws(() => f.proxy.sync("codex"), /旧版或不明/);
      assert.match(f.proxy.status("codex", true).error, /旧版或不明/);
      const reloaded = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
      assert.ok(reloaded.error);
      assert.deepEqual(reloaded.routingState("codex").providers, []);
      assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
    }
  }
});

test("current repair restores applied config and catalog without changing rollback record or OAuth", t => {
  const f = fixture(t); f.proxy.sync("codex", true);
  const clients = structuredClone(f.proxy.clients);
  const record = fs.readFileSync(f.config.record, "utf8");
  const auth = fs.readFileSync(path.join(f.codex, "auth.json"), "utf8");
  const current = fs.readFileSync(f.config.file, "utf8");
  atomic(f.config.file, current.replace('name = "ASS"', 'name = "damaged"').replace("keep = true", "keep = false"));
  atomic(f.config.catalog, "{}");
  f.store.updateProvider({ ...f.store.state.providers[0], baseUrl: "https://pending.example/v1", apiKey: "synthetic-pending" });
  f.proxy.repair("codex");
  assert.deepEqual(f.proxy.clients, clients);
  assert.equal(fs.readFileSync(f.config.record, "utf8"), record);
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), JSON.stringify(clients.codex.catalog, null, 2));
  assert.equal(fs.readFileSync(path.join(f.codex, "auth.json"), "utf8"), auth);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file, "utf8")).features.keep, false);
  assert.equal(f.proxy.status("codex", true).error, "");
  assert.equal(f.proxy.status("codex", true).pending, true);
  f.config.detach();
  const restored = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(restored.model, "gpt-original");
  assert.equal(restored.model_reasoning_effort, "high");
  assert.equal(restored.features.keep, false);
});

test("native selection writes stay applied and pending model drafts do not block official project transport", t=>{
  const f=fixture(t);f.proxy.sync('codex');
  const before=fs.readFileSync(path.join(f.codex,'auth.json'),'utf8');
  const text=fs.readFileSync(f.config.file,'utf8');
  const parsed=TOML.parse(text);
  atomic(f.config.file,text.replace('model = '+JSON.stringify(parsed.model),'model = "gpt-6-astra"')
    .replace('model_reasoning_effort = '+JSON.stringify(parsed.model_reasoning_effort),'model_reasoning_effort = "xhigh"'));
  assert.equal(f.proxy.status('codex',true).applied,true);
  assert.doesNotThrow(()=>f.proxy.requireCodexOfficialService());
  f.proxy.repair('codex');
  assert.equal(TOML.parse(fs.readFileSync(f.config.file,'utf8')).model,'gpt-6-astra');
  f.store.updateProvider({...f.store.state.providers[0],baseUrl:'https://pending.invalid/v1'});
  assert.equal(f.proxy.status('codex',true).pending,true);
  assert.doesNotThrow(()=>f.proxy.requireCodexOfficialService());
  assert.equal(fs.readFileSync(path.join(f.codex,'auth.json'),'utf8'),before);
  atomic(f.config.file,fs.readFileSync(f.config.file,'utf8').replace('base_url = '+JSON.stringify(f.config.baseUrl),'base_url = "https://foreign.invalid/v1"'));
  assert.throws(()=>f.proxy.requireCodexOfficialService(),/外部修改/);
});

test('restart ignores storage placeholders and native Codex model preferences, but preserves real injection edits',t=>{
  const f=fixture(t);f.manager.save();f.proxy.sync('codex');
  const files=[f.config.file,f.config.record,f.config.catalog,f.proxy.file,f.manager.file,path.join(f.codex,'auth.json')];
  for(const [model,effort] of [['gpt-native-choice','max'],[require('../core/models.cjs').codexModelId('relay','two'),'low']]){
    const parsed=TOML.parse(fs.readFileSync(f.config.file,'utf8'));
    atomic(f.config.file,fs.readFileSync(f.config.file,'utf8').replace('model = '+JSON.stringify(parsed.model),'model = '+JSON.stringify(model))
      .replace('model_reasoning_effort = '+JSON.stringify(parsed.model_reasoning_effort),'model_reasoning_effort = '+JSON.stringify(effort)));
    const before=files.map(file=>fs.readFileSync(file));
    const store=new Store(f.data,f.codex,crypt);
    assert.equal(Object.hasOwn(store.state.providers[0],'secrets'),true,'exercise the real reload placeholder');
    const manager=new HarnessManager(f.data,()=>store.state,store.officialModels,f.codex,{home:f.root,env:{},launchEnv:{PATH:''},isConnected:()=>true});
    const proxy=new ProxyConfig(f.data,crypt,manager,store,new ConfigManager(f.codex,f.data));
    assert.equal(proxy.status('codex',true).pending,false);assert.equal(proxy.status('codex',true).applied,true);
    assert.doesNotThrow(()=>proxy.requireApplied('codex'));
    assert.equal(Object.hasOwn(proxy.desired('codex').providers[0],'secrets'),false);
    assert.deepEqual(files.map(file=>fs.readFileSync(file)),before,'status and restart preserve native selections, applied routes and credentials');
    manager.setInjection('codex',{defaultModel:modelRef('relay','two')});
    assert.equal(proxy.status('codex',true).pending,true,'an explicit ASS default-model edit still needs sync');
    manager.setInjection('codex',{defaultModel:null});
  }
});

test("leaving accountless mode keeps the shared ASS model until the connection is disabled", t => {
  const f = fixture(t); f.proxy.sync("codex", true);
  const selected = TOML.parse(fs.readFileSync(f.config.file, "utf8")).model;
  assert.match(selected, /^ASS_[a-f0-9]{24}::/);
  f.proxy.sync("codex", false);
  const config = TOML.parse(fs.readFileSync(f.config.file, "utf8"));
  assert.equal(config.model, selected);
  assert.equal(config.model_reasoning_effort, "medium");
  assert.equal(config.model_providers.ASS.requires_openai_auth, true);
  assert.equal(config.model_providers.ASS.experimental_bearer_token, undefined);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.config.record, "utf8")).replaced, "model"), true);
  assert.equal(fs.readFileSync(path.join(f.codex, "auth.json"), "utf8"), '{"tokens":{"access_token":"synthetic-oauth-keep"}}');
  f.config.detach();
  assert.deepEqual(TOML.parse(fs.readFileSync(f.config.file, "utf8")), TOML.parse(f.original));
});

test('legacy OAuth-coupled injection becomes pending without writes and upgrades only on explicit sync', t => {
  const f = fixture(t); f.proxy.sync('codex');
  const legacy = { ...f.proxy.clients.codex }; delete legacy.gatewayAuth; delete legacy.localToken;
  const old = f.config.prepareAttach(legacy.defaultModel);
  atomic(f.config.record, JSON.stringify({ replaced: old.replaced, blocks: old.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g) }));
  atomic(f.config.file, old.text); f.proxy.persist({ codex: legacy });
  const before = fs.readFileSync(f.config.file), auth = fs.readFileSync(path.join(f.codex, 'auth.json'));
  const restarted = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.equal(restarted.error, ''); assert.equal(restarted.status('codex', true).pending, true);
  assert.deepEqual(fs.readFileSync(f.config.file), before);
  restarted.sync('codex');
  assert.equal(restarted.status('codex', true).applied, true);
  assert.equal(restarted.clients.codex.gatewayAuth, true);
  assert.equal(TOML.parse(fs.readFileSync(f.config.file, 'utf8')).model_providers.ASS.requires_openai_auth, true);
  assert.deepEqual(fs.readFileSync(path.join(f.codex, 'auth.json')), auth);
  const token = restarted.clients.codex.localToken;
  const again = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.equal(again.clients.codex.localToken, token); assert.equal(again.status('codex', true).pending, false);
});
test('legacy Codex bearer mode is pending for ordinary OAuth routing and sync removes only the old ASS auth fields', t => {
  const f = fixture(t); f.proxy.sync('codex');
  const token = f.proxy.clients.codex.localToken;
  const current = fs.readFileSync(f.config.file, 'utf8');
  const legacyProvider = current.replace(
    'requires_openai_auth = true\n',
    `requires_openai_auth = false\nexperimental_bearer_token = "${token}"\n`,
  );
  const record = JSON.parse(fs.readFileSync(f.config.record, 'utf8'));
  record.blocks[1] = record.blocks[1].replace(
    'requires_openai_auth = true\n',
    `requires_openai_auth = false\nexperimental_bearer_token = "${token}"\n`,
  );
  atomic(f.config.file, legacyProvider); atomic(f.config.record, JSON.stringify(record));
  assert.equal(f.config.status().authMode, 'accountless');
  assert.equal(f.proxy.status('codex', true).pending, true);
  f.proxy.sync('codex');
  const repaired = TOML.parse(fs.readFileSync(f.config.file, 'utf8'));
  assert.equal(repaired.model_providers.ASS.requires_openai_auth, true);
  assert.equal(repaired.model_providers.ASS.experimental_bearer_token, undefined);
  assert.equal(f.proxy.status('codex', true).applied, true);
});
test("failed current repair rolls back config, catalog and ownership record", t => {
  const f = fixture(t); f.proxy.sync("codex");
  atomic(f.config.catalog, "{}");
  atomic(f.config.file, fs.readFileSync(f.config.file, "utf8").replace('name = "ASS"', 'name = "damaged"'));
  const files = [f.config.file, f.config.record, f.config.catalog, path.join(f.codex, "auth.json")];
  const before = files.map(file => fs.readFileSync(file, "utf8"));
  const clients = structuredClone(f.proxy.clients);
  const persist = f.proxy.persist.bind(f.proxy);
  let calls = 0;
  f.proxy.persist = (...args) => { if (++calls === 2) throw Error("synthetic repair commit failure"); return persist(...args); };
  assert.throws(() => f.proxy.repair("codex"), /repair commit failure/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
  assert.deepEqual(f.proxy.clients, clients);
  assert.equal(f.proxy.pending, null);
});

test("preview tracks model settings, concurrent changes and active requests fail closed", async (t) => {
  const f = fixture(t);
  const enable = async () => f.connections.apply({ ticket: (await f.connections.preview("codex", true)).ticket, mode: "safe", acknowledged: true });
  await enable();
  let plan = await f.connections.preview("codex", true);
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  await assert.rejects(f.connections.apply({ ticket: plan.ticket, mode: "safe", acknowledged: true }), /已变化/);
  f.router.clientActive = () => 1;
  await assert.rejects(enable(), /请求正在进行/);
  assert.equal(f.proxy.routingState("codex").providers[0].models.length, 2);
  f.router.clientActive = () => 0;
  await enable();
  assert.equal(f.connections.snapshot().clients.codex.applied, true);
  assert.equal(f.connections.snapshot().clients.codex.modelCount, 0);
});
test("external ownership conflicts and persistence failure never overwrite user edits or claim applied", (t) => {
  const f = fixture(t);
  f.proxy.sync("codex");
  const config = fs.readFileSync(f.config.file, "utf8"), catalog = fs.readFileSync(f.config.catalog, "utf8");
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  f.proxy.persist = () => { throw Error("synthetic write failure"); };
  assert.throws(() => f.proxy.sync("codex"), /write failure/);
  assert.equal(fs.readFileSync(f.config.file, "utf8"), config);
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), catalog);
  assert.equal(f.proxy.status("codex", true).pending, true);
  atomic(f.config.file, config.replace('name = "ASS"', 'name = "changed"'));
  assert.throws(() => f.proxy.sync("codex"), /外部修改/);
  atomic(f.config.file, config);
  atomic(f.config.catalog, "{}");
  assert.throws(() => f.proxy.sync("codex"), /外部修改/);
});
test("Claude global Messages range works without account binding; switching models keeps namespaces separate", (t) => {
  const f = fixture(t);
  f.proxy.sync("claude");
  assert.equal(f.proxy.status("claude", true).modelCount, 2);
  const plan = f.manager.modelPlan("claude", modelRef("relay", "two"), "local-only-token");
  assert.match(plan.env.ANTHROPIC_BASE_URL, /clients\/claude\/models$/);
  assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(plan.args.slice(0, 2), ["--model", "relay::two"]);
  assert.ok(plan.args.includes("--settings"));
  const body = { model: "relay::two" };
  const route = harnessRoute("/models/v1/messages", body, f.proxy.routingState("claude"));
  assert.equal(body.model, "two");
  assert.equal(route.p.id, "relay");
  assert.equal(harnessRoute("/models/v1/messages", { model: "relay::one" }, f.proxy.routingState("claude")).adapted, true);
  assert.deepEqual(f.manager.state.accountBindings.claude || [], []);
});
test("Codex isolated OAuth launches receive the applied catalog without changing auth or applying drafts", (t) => {
  const f = fixture(t);
  f.proxy.sync("codex");
  const nativeAccount = f.manager.snapshot().clients.find((c) => c.id === "codex").accounts.find((a) => a.kind === "native");
  const nativePlan = f.manager.plan("codex", nativeAccount.id);
  assert.equal(nativePlan.routed, true, "native OAuth window using attached global config must be tracked as proxy-dependent");
  f.manager.materialize(nativePlan);
  const account = f.manager.add("codex", "Second OpenAI");
  const plan = f.manager.plan("codex", account);
  const config = TOML.parse(plan.files.find(([name]) => name === "config.toml")[1]);
  assert.equal(config.model_catalog_json, f.config.catalog);
  assert.equal(config.openai_base_url, f.config.baseUrl);
  const routedProvider = config.model_providers.ASS || config.model_providers.ass_official;
  assert.equal(config.openai_base_url, routedProvider.base_url);
  assert.equal(config.model_providers.openai, undefined);
  assert.equal(routedProvider.requires_openai_auth, true);
  assert.equal(plan.files.some(([name]) => name === "auth.json"), false);
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  assert.equal(f.manager.plan("codex", account).files[0][1], plan.files[0][1]);
  f.manager.options.port = 32123;
  const relocated = TOML.parse(f.manager.plan("codex", account).files.find(([name]) => name === "config.toml")[1]);
  assert.equal(relocated.openai_base_url, "http://127.0.0.1:32123/clients/ASS/v1");
  assert.equal((relocated.model_providers.ASS || relocated.model_providers.ass_official).base_url, relocated.openai_base_url);
});

test("proxy write-ahead recovery survives restart and refuses intervening external edits", (t) => {
  const f = fixture(t);
  f.proxy.sync("codex");
  const before = fs.readFileSync(f.config.catalog, "utf8"), after = "{\"models\":[]}";
  f.proxy.persist(f.proxy.clients, { files: [{ file: f.config.catalog, before, after }] });
  atomic(f.config.catalog, after);
  const restarted = new ProxyConfig(f.data, crypt, f.manager, f.store, f.config);
  assert.match(restarted.status("codex", true).error, /事务待恢复/);
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), after, "startup is read-only");
  restarted.sync("codex");
  assert.equal(restarted.status("codex", true).applied, true);
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), before);
  restarted.persist(restarted.clients, { files: [{ file: f.config.catalog, before, after }] });
  atomic(f.config.catalog, "external change");
  assert.throws(() => restarted.sync("codex"), /外部修改/);
  assert.equal(fs.readFileSync(f.config.catalog, "utf8"), "external change");
});

test("failed final proxy commit rolls back the complete applied config and record", (t) => {
  const f = fixture(t);
  f.proxy.sync("codex");
  const files = [f.config.file, f.config.record, f.config.catalog].map((file) => [file, fs.readFileSync(file)]);
  const persist = f.proxy.persist.bind(f.proxy);
  let calls = 0;
  f.proxy.persist = (...args) => { if (++calls === 2) throw Error("synthetic final commit failure"); return persist(...args); };
  f.manager.setInjection("codex", { excludedProviders: ["relay"] });
  assert.throws(() => f.proxy.sync("codex"), /final commit failure/);
  for (const [file, content] of files) assert.deepEqual(fs.readFileSync(file), content);
  assert.equal(f.proxy.pending, null);
  assert.equal(f.proxy.status("codex", true).pending, true);
});
