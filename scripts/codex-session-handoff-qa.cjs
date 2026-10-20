// Installed Codex app-server + local synthetic Responses; never touches live homes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline'), assert = require('node:assert/strict');
const { CodexSessionHandoff } = require('../core/codex-session-handoff.cjs');
const { ConfigManager, atomic } = require('../core/config.cjs');
const { normalizeProvider, makeCatalog, codexModelId } = require('../core/models.cjs');
const crypt = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const out = fs.mkdtempSync(path.join(os.tmpdir(),'ass-codex-resume-')), codex = path.join(out,'codex'), data = path.join(out,'data');
fs.mkdirSync(codex); fs.mkdirSync(data);
const binaries = path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
const executable = process.env.ASS_QA_CODEX_BIN || fs.readdirSync(binaries).map(d=>path.join(binaries,d,'codex.exe')).find(f=>fs.existsSync(f));
const requests = []; let processHandle, sequence=0;
const prediction = process.env.ASS_QA_PREDICTION === '1';
const oauth = prediction || process.env.ASS_QA_OAUTH === '1';
function launch() {
  const env={...process.env,CODEX_HOME:codex,OPENAI_API_KEY:'synthetic-local-key'};
  for(const key of ['CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_IDENTITY_TOKEN_FILE'])delete env[key];
  if (oauth) delete env.OPENAI_API_KEY;
  const child=spawn(executable,['app-server','--listen','stdio://'],{env,windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:out});processHandle=child;
  const pending=new Map(),events=[];let stderr='';child.stderr.on('data',b=>{stderr+=b.toString();});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else events.push(m);});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout '+stderr.slice(-500)));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const completed=async turn=>{const end=Date.now()+20000;while(Date.now()<end){const event=events.find(e=>e.method==='turn/completed'&&e.params.turn.id===turn);if(event){assert.equal(event.params.turn.status,'completed');return;}await new Promise(r=>setTimeout(r,25));}throw Error('turn completion timeout '+stderr.slice(-500));};
  const close=async()=>{child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('fixture app-server failed to exit'));},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});if(processHandle===child)processHandle=null;};
  return {rpc,completed,close,notify:(method,params)=>child.stdin.write(JSON.stringify({method,params})+'\n')};
}
const nativeModels=makeCatalog([],[]).models.map(m=>({...m,slug:'gpt-6.1-sol',display_name:'GPT fixture',base_instructions:'You are a fixture assistant. Use the provided tools.'}));
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:nativeModels,data:[{id:'gpt-6.1-sol'}]}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);let bytes=Buffer.concat(chunks);
  const zlib=require('node:zlib'),decoder={zstd:zlib.zstdDecompressSync,gzip:zlib.gunzipSync,br:zlib.brotliDecompressSync,deflate:zlib.inflateSync}[req.headers['content-encoding']];
  if(decoder)bytes=decoder(bytes);const body=JSON.parse(bytes);requests.push(body);
  if (oauth && body.input?.some(item=>item.type==='reasoning'&&item.content?.length)) {
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'foreign reasoning was replayed to official backend'}}));return;
  }
  const text=body.text?.format?.type==='json_schema'?JSON.stringify({suggestion:'fixture suggestion'}):'fixture answer';
  const message={type:'message',id:'msg_fixture_'+requests.length,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const response={id:'resp_fixture_'+requests.length,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output:[message],usage:{input_tokens:6,output_tokens:4,total_tokens:10,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
    {type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'fixture answer'},
    {type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
});
server.on('upgrade',(_,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  atomic(path.join(codex,'config.toml'),`model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\nchatgpt_base_url = "http://127.0.0.1:${port}/backend-api/"\n`);
  if (oauth) {
    const token='fixture.'+Buffer.from(JSON.stringify({sub:'fixture',exp:Math.floor(Date.now()/1000)+86400,email:'fixture@example.test',
      'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account',chatgpt_plan_type:'pro'}})).toString('base64url')+'.fixture';
    atomic(path.join(codex,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:token,access_token:token,refresh_token:'synthetic-refresh',account_id:'fixture-account'},last_refresh:new Date().toISOString()}));
  }
  atomic(path.join(codex,'models_cache.json'),JSON.stringify({models:nativeModels}));
  const provider=normalizeProvider({id:'fixture',baseUrl:'https://example.test/v1',apiKey:'synthetic',models:[{model:'mimo',wireApi:'openai-responses'}]});
  const config=new ConfigManager(codex,data,port);atomic(config.catalog,JSON.stringify(makeCatalog(nativeModels,[provider])));
  config.attach({model:codexModelId(provider.id,'mimo'),effort:'medium'});
  let client=launch();await client.rpc('initialize',{clientInfo:{name:'ass_resume_qa',version:'1'},capabilities:{experimentalApi:true}});client.notify('initialized',{});
  const started=await client.rpc('thread/start',{cwd:out,approvalPolicy:'never',sandbox:'read-only'});const id=started.thread.id;
  const first=await client.rpc('turn/start',{threadId:id,input:[{type:'text',text:'original fixture question'}]});await client.completed(first.turn.id);
  await client.close();
  if (oauth && !prediction) {
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(codex,fs.readdirSync(codex).find(f=>/^state_\d+\.sqlite$/.test(f))),{readOnly:true});
    const file=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id).rollout_path;db.close();
    fs.appendFileSync(file,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'foreign reasoning fixture'}],encrypted_content:'foreign-encrypted-fixture'}})+'\n');
  }
  const handoff=new CodexSessionHandoff({codexDir:codex,dataDir:data,crypto:crypt,config,officialModels:()=>nativeModels,
    assertIdle:async()=>{if(processHandle&&processHandle.exitCode===null)throw Error('fixture Codex running');}});
  assert.ok(handoff.status().count>0);
  if(prediction){
    const prepared=config.prepareAttach({model:codexModelId(provider.id,'mimo'),effort:'medium'},'synthetic',true,true);
    atomic(config.record,JSON.stringify({replaced:prepared.replaced,blocks:prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)}));
    atomic(config.file,prepared.text);
  }
  const migrated=await (prediction?handoff.restorePrediction():handoff.restore());if(!prediction)config.detach();
  client=launch();await client.rpc('initialize',{clientInfo:{name:'ass_resume_qa',version:'1'},capabilities:{experimentalApi:true}});client.notify('initialized',{});
  const resumed=await client.rpc('thread/resume',{threadId:id});assert.equal(resumed.thread.modelProvider,'openai');
  const expectedModel=prediction?codexModelId(provider.id,'mimo'):'gpt-6.1-sol';assert.equal(resumed.model,expectedModel);
  const second=await client.rpc('turn/start',{threadId:id,input:[{type:'text',text:'continue fixture question'}]});await client.completed(second.turn.id);
  const last=requests.findLast(body=>Array.isArray(body.input)&&typeof body.model==='string');assert.equal(last?.model,expectedModel);
  assert.ok(JSON.stringify(last.input).includes('original fixture question'));assert.ok(JSON.stringify(last.input).includes('fixture answer'));
  if(prediction){
    const fork=await client.rpc('thread/fork',{threadId:id,experimentalPredictionMode:true,ephemeral:true,excludeTurns:true});
    assert.equal(fork.thread.modelProvider,'openai');
    const schema={type:'object',properties:{suggestion:{type:['string','null']}},required:['suggestion'],additionalProperties:false};
    const predicted=await client.rpc('turn/start',{threadId:fork.thread.id,input:[{type:'text',text:'Predict the next fixture message'}],outputSchema:schema});
    await client.completed(predicted.turn.id);
    assert.equal(requests.at(-1).text?.format?.type,'json_schema');
  }
  await client.close();console.log(JSON.stringify({passed:true,migrated:migrated.count,modelProvider:resumed.thread.modelProvider,model:resumed.model,historyRetained:true,oauth,predictionFork:prediction,realCloudCalls:0,out}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{processHandle?.kill();server.closeAllConnections();server.close();});
