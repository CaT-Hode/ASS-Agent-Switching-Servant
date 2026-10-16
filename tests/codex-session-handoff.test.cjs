const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { CodexSessionHandoff } = require('../core/codex-session-handoff.cjs');
const { ConfigManager, atomic } = require('../core/config.cjs');
const { clearRoutedSelections } = require('../core/claude-native.cjs');
const { Store } = require('../core/store.cjs');
const { HarnessManager } = require('../core/harnesses.cjs');
const { ProxyConfig } = require('../core/proxy-config.cjs');
const { codexModelId } = require('../core/models.cjs');
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function fixture(t, assertIdle = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-handoff-')); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const codex = path.join(root,'codex'), data = path.join(root,'data'); fs.mkdirSync(codex); fs.mkdirSync(data);
  atomic(path.join(codex,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
  const file = path.join(codex,'sessions','2026','10','rollout-fixture.jsonl'), id = '01a11111-1111-7111-8111-111111111111';
  const original = [{type:'session_meta',payload:{id,model_provider:'ASS',cwd:root}},
    {type:'turn_context',payload:{model:codexModelId('provider','mimo'),effort:'xhigh',cwd:root,turn_id:'turn-1'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'preserve user message'}]}},
    {type:'response_item',payload:{type:'function_call',name:'read',call_id:'call-1',arguments:'{}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'call-1',output:'preserve tool result'}},
    {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'preserve answer'}]}}];
  atomic(file,original.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const database = path.join(codex,'state_5.sqlite'), db = new DatabaseSync(database);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,model TEXT,rollout_path TEXT,title TEXT,archived INTEGER,updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,'ASS',codexModelId('provider','mimo'),file,'preserve title',1,100);
  db.close();
  const config = new ConfigManager(codex,data);
  const handoff = new CodexSessionHandoff({codexDir:codex,dataDir:data,crypto:crypt,config,officialModels:()=>[{slug:'gpt-6.1-sol'}],assertIdle});
  return {root,codex,data,id,file,database,original,config,handoff};
}
test('detach restores provider, index and resume selection without rewriting messages, tools or archive state',async t=>{
  const f=fixture(t);assert.equal(f.handoff.status().count,1);
  const result=await f.handoff.restore();assert.equal(result.count,1);
  const rows=fs.readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].payload.model_provider,'openai');
  assert.deepEqual(rows.slice(1,-1),f.original.slice(1));assert.equal(rows.at(-1).payload.model,'gpt-6.1-sol');
  const db=new DatabaseSync(f.database,{readOnly:true}),row=db.prepare('SELECT * FROM threads').get();db.close();
  assert.equal(row.model_provider,'openai');assert.equal(row.model,'gpt-6.1-sol');
  assert.equal(row.archived,1);assert.equal(row.title,'preserve title');assert.equal(row.updated_at,100);
  assert.equal(fs.existsSync(f.handoff.journal),false);assert.equal((await f.handoff.restore()).count,0);
});
test('live-client guard leaves config, session and index untouched',async t=>{
  const f=fixture(t,async()=>{throw Error('Codex is running');}), before=fs.readFileSync(f.file);
  await assert.rejects(f.handoff.restore(),/running/);assert.deepEqual(fs.readFileSync(f.file),before);
  assert.equal(f.handoff.status().count,1);assert.equal(fs.existsSync(f.handoff.journal),false);
});
test('official replay excludes foreign reasoning but retains its original log and active compacted messages',async t=>{
  const f=fixture(t),reasoning={type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'preserve original thinking'}],encrypted_content:'foreign'};
  const kept={type:'message',role:'user',content:[{type:'input_text',text:'only active context'}]};
  fs.appendFileSync(f.file,JSON.stringify({type:'compacted',payload:{message:'existing compact',replacement_history:[kept,reasoning]}})+'\n');
  await f.handoff.restore();
  const rows=fs.readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse),snapshots=rows.filter(r=>r.type==='compacted');
  assert.deepEqual(snapshots[0].payload.replacement_history,[kept,reasoning]);
  assert.deepEqual(snapshots.at(-1).payload.replacement_history,[kept]);
  assert.ok(fs.readFileSync(f.file,'utf8').includes('preserve original thinking'));
});
test('unknown legacy context edits block replay rather than reintroducing removed messages',async t=>{
  const f=fixture(t);fs.appendFileSync(f.file,JSON.stringify({type:'event_msg',payload:{type:'thread_rolled_back',num_turns:1}})+'\n'+
    JSON.stringify({type:'response_item',payload:{type:'reasoning',content:[{type:'reasoning_text',text:'foreign'}]}})+'\n');
  const before=fs.readFileSync(f.file);await assert.rejects(f.handoff.restore(),/旧版压缩或回退/);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.handoff.status().count,1);
});
test('foreign provider sessions and official selections are not changed',async t=>{
  const f=fixture(t), db=new DatabaseSync(f.database);
  db.prepare('UPDATE threads SET model_provider=?,model=?').run('another-router','other-model');db.close();
  const before=fs.readFileSync(f.file);assert.equal((await f.handoff.restore()).count,0);assert.deepEqual(fs.readFileSync(f.file),before);
});

test('unfinished rollout tail cannot be joined to a resumed context',async t=>{
  const f=fixture(t), before=fs.readFileSync(f.file,'utf8').trimEnd();fs.writeFileSync(f.file,before);
  await assert.rejects(f.handoff.restore(),/尚未完整写入/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(f.handoff.status().count,1);
  assert.equal(fs.existsSync(f.handoff.journal),false);
});

test('client reopening before transaction keeps the original guard error and all data',async t=>{
  let calls=0;const f=fixture(t,async()=>{if(++calls>=2)throw Error('client reopened');}),before=fs.readFileSync(f.file);
  await assert.rejects(f.handoff.restore(),/client reopened/);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.handoff.status().count,1);
  assert.equal(fs.existsSync(f.handoff.journal),true);
});
test('concurrent session edits prevent handoff and remain intact',async t=>{
  let calls=0,file;const f=fixture(t,async()=>{if(++calls===2)fs.appendFileSync(file,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'external'}})+'\n');});file=f.file;
  await assert.rejects(f.handoff.restore(),/同时被修改/);
  assert.ok(fs.readFileSync(file,'utf8').includes('external'));assert.equal(f.handoff.status().count,1);
  assert.equal(fs.existsSync(f.handoff.journal),true);
});
test('CC returns to native model selection, preserves transcripts and respects an independent gateway',()=>{
  const source={model:'claude-ass-123456',lastModel:'p::m',projects:{one:{lastModel:'p::m',other:'keep'},two:{lastModel:'opus'}},
    availableModels:['claude-ass-123456'],enforceAvailableModels:true,env:{ANTHROPIC_MODEL:'p::m',other:'keep'}};
  const next=clearRoutedSelections(source);
  assert.equal(next.model,undefined);assert.equal(next.lastModel,undefined);assert.equal(next.projects.one.lastModel,undefined);
  assert.equal(next.projects.two.lastModel,'opus');assert.equal(next.projects.one.other,'keep');assert.equal(next.env.other,'keep');
  assert.equal(next.enforceAvailableModels,undefined);assert.equal(source.model,'claude-ass-123456');
  assert.deepEqual(clearRoutedSelections({...source,env:{ANTHROPIC_BASE_URL:'https://independent.example'}}),{...source,env:{ANTHROPIC_BASE_URL:'https://independent.example'}});
  const independent={lastModel:'p::m',env:{ANTHROPIC_BASE_URL:'https://independent.example'}};
  assert.deepEqual(clearRoutedSelections({...source,projects:{independent}}).projects.independent,independent);
});
test('OAuth enables official GPT defaults, accountless hides them, and config restores the original selection',t=>{
  const f=fixture(t);atomic(path.join(f.codex,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic'}}));
  atomic(path.join(f.codex,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT native',context_window:500000}]}));
  const store=new Store(f.data,f.codex,crypt);store.updateProvider({id:'relay',name:'relay',baseUrl:'https://relay.example/v1',apiKey:'synthetic',models:[{model:'mimo',wireApi:'openai-responses'}]});
  const manager=new HarnessManager(f.data,()=>store.state,store.officialModels,f.codex,{home:f.root,env:{},launchEnv:{PATH:''}});
  const proxy=new ProxyConfig(f.data,crypt,manager,store,f.config);manager.options.proxyConfig=proxy;
  assert.equal(manager.injection('codex').officialModels[0].model,'gpt-6.1-sol');
  manager.setInjection('codex',{defaultModel:JSON.stringify(['official','gpt-6.1-sol'])});
  assert.equal(proxy.desired('codex').defaultModel.model,'gpt-6.1-sol');
  assert.ok(proxy.desired('codex',true).defaultModel.model.includes('::'));
  proxy.sync('codex');assert.equal(proxy.error,'');assert.equal(proxy.status('codex',true).applied,true);
  assert.ok(fs.readFileSync(f.config.file,'utf8').includes('model = "gpt-6.1-sol"'));
  f.config.detach();assert.ok(fs.readFileSync(f.config.file,'utf8').includes('gpt-6.1-sol'));
  fs.unlinkSync(path.join(f.codex,'auth.json'));assert.equal(manager.injection('codex').officialModels.length,0);
});
