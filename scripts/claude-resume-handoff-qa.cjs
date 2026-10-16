// Real installed Claude Code CLI, isolated home and local Messages endpoint.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {encode,slug}=require('../core/project-codecs.cjs');
const {clearRoutedSelections}=require('../core/claude-native.cjs');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'ass-claude-resume-')),home=path.join(out,'claude');fs.mkdirSync(home);
const id=require('node:crypto').randomUUID(),requests=[];
const source=encode('claude',{id,cwd:out,title:'fixture',model:'claude-ass-1234567890',messages:[
  {role:'user',text:'original fixture question',timestamp:new Date().toISOString()},
  {role:'assistant',text:'original fixture answer',timestamp:new Date().toISOString()}]});
const file=path.join(home,'projects',slug(out),id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source.bytes);
fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify(clearRoutedSelections({model:'claude-ass-1234567890',availableModels:['claude-ass-1234567890'],enforceAvailableModels:true})));
fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,projects:{[out]:{hasTrustDialogAccepted:true,lastModel:'sonnet'}}}));
const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({input_tokens:10}));return;}
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
  requests.push(body);const message={id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'native fixture answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:3}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
  const events=[{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'native fixture answer'}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const installed=path.join(process.env.APPDATA,'npm','node_modules','@anthropic-ai','claude-code');
  const binary=path.join(installed,'bin','claude.exe'),entry=path.join(installed,'cli.js');
  if(!fs.existsSync(binary)&&!fs.existsSync(entry))throw Error('Installed Claude Code entry unavailable');
  const env={...process.env,CLAUDE_CONFIG_DIR:home,ANTHROPIC_API_KEY:'synthetic-local-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  for(const key of ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','ANTHROPIC_MODEL'])delete env[key];
  const args=['--resume',file,'--print','continue fixture question','--output-format','json'];
  const child=spawn(fs.existsSync(binary)?binary:process.execPath,fs.existsSync(binary)?args:[entry,...args],{env,cwd:out,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
  const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Fixture CLI timeout '+error.slice(-300)));},30000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve(code);});});
  assert.equal(exit,0,error.slice(-400));assert.ok(requests.length>0);
  const last=requests.findLast(r=>Array.isArray(r.messages));assert.ok(!last.model.includes('::')&&!last.model.startsWith('claude-ass-'));
  assert.ok(JSON.stringify(last.messages).includes('original fixture question'));assert.ok(JSON.stringify(last.messages).includes('original fixture answer'));
  console.log(JSON.stringify({passed:true,model:last.model,historyRetained:true,realCloudCalls:0,out}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
