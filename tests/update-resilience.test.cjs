const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../core/store.cjs');
const { HarnessManager } = require('../core/harnesses.cjs');
const { atomic } = require('../core/config.cjs');
const { RuntimeHealth } = require('../core/runtime-health.cjs');
const { OAuthHistory } = require('../core/oauth-history.cjs');
const vault = { isEncryptionAvailable:()=>true, encryptString:s=>Buffer.from(s), decryptString:b=>b.toString() };
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-update-resilience-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codex=path.join(root,'codex'),data=path.join(root,'data');fs.mkdirSync(codex);fs.mkdirSync(data);
  return {root,codex,data};
}
test('Codex cache replacement refreshes official context while WOYAO and custom settings survive restarts',t=>{
  const f=fixture(t),cache=path.join(f.codex,'models_cache.json');
  atomic(cache,JSON.stringify({models:[{slug:'gpt-6.1-sol',context_window:272000}]}));
  const store=new Store(f.data,f.codex,vault);
  store.updateProvider({id:'woyao',name:'WOYAO',apiKey:'synthetic-key',baseUrl:'https://woyao.invalid/v1',models:[{model:'custom',contextWindow:999999}]});
  store.state.officialOverrides['gpt-6.1-sol']={model:'gpt-6.1-sol',contextWindow:272000,efforts:['high'],defaultEffort:'high'};store.save();
  const before=fs.readFileSync(store.file,'utf8'),shared=store.officialModels;
  atomic(cache,JSON.stringify({models:[{slug:'gpt-6.1-sol',context_window:500000,max_context_window:872000,default_reasoning_level:'low'}]}));
  for(let i=0;i<2;i++) {
    const state=store.public();assert.equal(state.officialModels[0].contextWindow,500000);
    assert.equal(state.officialModels[0].defaultEffort,'low');assert.equal(state.providers[0].name,'WOYAO');
    assert.equal(state.providers[0].models[0].contextWindow,999999);
    assert.equal(new Store(f.data,f.codex,vault).public().providers[0].name,'WOYAO');
  }
  assert.equal(shared,store.officialModels);assert.equal(shared[0].max_context_window,872000);
  atomic(cache,'{in-progress-update');assert.equal(store.public().officialModels[0].contextWindow,500000);
  assert.equal(fs.readFileSync(store.file,'utf8'),before,'native refresh never rewrites saved settings');
});
test('durable settings commits retain an encrypted previous generation and fsync failure preserves saved state',t=>{
  const f=fixture(t),store=new Store(f.data,f.codex,vault);
  const p={id:'woyao',name:'WOYAO',baseUrl:'https://woyao.invalid/v1',apiKey:'synthetic-secret',models:[{model:'custom'}]};
  store.updateProvider(p);const before=fs.readFileSync(store.file,'utf8');
  const sync=fs.fsyncSync;fs.fsyncSync=()=>{throw Object.assign(Error('synthetic disk failure'),{code:'ENOSPC'})};
  try {assert.throws(()=>store.updateProvider({...p,name:'unsaved'}),/disk failure/);}
  finally {fs.fsyncSync=sync;}
  assert.equal(fs.readFileSync(store.file,'utf8'),before);assert.equal(store.state.providers[0].name,'WOYAO');
  store.updateProvider({...p,name:'WOYAO updated'});
  const backup=fs.readFileSync(path.join(f.data,'backups/settings.previous.json'),'utf8');
  assert.equal(backup,before);assert.ok(!backup.includes('synthetic-secret'));
  store.updateProvider({...p,name:'WOYAO updated'});assert.equal(new Store(f.data,f.codex,vault).state.providers[0].name,'WOYAO updated');
});
test('old client manager cannot overwrite newer persisted injection preferences',t=>{
  const f=fixture(t),get=()=>({providers:[]}),options={home:f.root,env:{},launchEnv:{PATH:''}};
  const old=new HarnessManager(f.data,get,[],f.codex,options),fresh=new HarnessManager(f.data,get,[],f.codex,options);
  fresh.setInjection('codex',{excludedProviders:['new-setting']});const before=fs.readFileSync(fresh.file,'utf8');
  for(let i=0;i<2;i++) assert.throws(()=>old.setInjection('codex',{excludedProviders:['stale-setting']}),/外部更新/);
  assert.equal(fs.readFileSync(fresh.file,'utf8'),before);
  assert.deepEqual(new HarnessManager(f.data,get,[],f.codex,options).state.injections.codex.excludedProviders,['new-setting']);
});
test('native discovery failures retry without throwing or discarding OAuth records; diagnostics are bounded and redacted',async t=>{
  const f=fixture(t),health=new RuntimeHealth(f.data,vault,'0.3.41');
  await health.background('native-scan',()=>{throw Object.assign(Error('sk-private-do-not-log'),{code:'ENOENT'})});
  assert.equal(health.events.at(-1).component,'native-scan');
  const history=Object.create(OAuthHistory.prototype);Object.assign(history,{errors:{},entries:[{id:'keep'}]});
  history.scan=()=>{throw Error('native updating')};for(let i=0;i<2;i++)assert.equal(history.scanSafe(),false);
  assert.deepEqual(history.entries,[{id:'keep'}]);history.scan=()=>true;assert.equal(history.scanSafe(),true);
  for(let i=0;i<45;i++)health.record('test');
  assert.equal(health.events.length,40);const record=fs.readFileSync(health.file,'utf8');assert.ok(record.length<64*1024);
  assert.ok(!vault.decryptString(Buffer.from(JSON.parse(record).encrypted,'base64')).includes('sk-private'));
  assert.equal(new RuntimeHealth(f.data,vault,'0.3.41').events.length,40);
});
