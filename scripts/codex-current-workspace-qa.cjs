// Read-only metadata probe through the CURRENT running ASS HTTPS listener.
// It is explicitly a diagnostic client, not proof the live Codex uses the relay.
// No configuration writes, copied credentials, inference or client restart.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const port=Number(process.argv[2]);
assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,'Pass the observed ASS loopback HTTPS port');
const dataDir=process.env.ASS_DATA_DIR||path.join(process.env.APPDATA,'AI Switch Servant');
const home=process.env.CODEX_HOME||path.join(process.env.USERPROFILE,'.codex');
const sourceFiles=['auth.json','config.toml'].map(n=>path.join(home,n));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=sourceFiles.map(hash);
const ca=fs.readFileSync(path.join(dataDir,'codex-workspace-ca.pem'));
const auth=JSON.parse(fs.readFileSync(sourceFiles[0],'utf8'));
assert.ok(auth.tokens?.access_token&&auth.tokens.account_id,'Native OAuth workspace required');
function request(endpoint,authenticated=true) {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port,path:endpoint,method:'GET',ca,agent:false,
      headers:authenticated?{authorization:'Bearer '+auth.tokens.access_token,'chatgpt-account-id':auth.tokens.account_id,
        accept:'application/json',originator:'Codex Desktop','user-agent':'ASS explicit metadata diagnostic'}:{}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)req.destroy(Error('Diagnostic response limit'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
        resolve({status:res.statusCode,json,requestId:res.headers['x-ass-request-id'],cfRay:res.headers['cf-ray']});});
    });
    req.setTimeout(30000,()=>req.destroy(Error('Metadata probe timeout')));req.on('error',reject);req.end();
  });
}
function projectPath() {
  const base=path.join(process.env.LOCALAPPDATA,'Codex/Logs'),files=[];
  for(const y of fs.readdirSync(base).filter(n=>/^\d{4}$/.test(n)))
    for(const m of fs.readdirSync(path.join(base,y)).filter(n=>/^\d{2}$/.test(n)))
      for(const d of fs.readdirSync(path.join(base,y,m)).filter(n=>/^\d{2}$/.test(n)))
        for(const n of fs.readdirSync(path.join(base,y,m,d)).filter(n=>n.includes('-t0-')&&n.endsWith('.log')))
          files.push(path.join(base,y,m,d,n));
  for(const file of files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,10)) {
    const match=/url=(\/gizmos\/g-p-[a-f0-9]+\/conversations)(?:\?|\s)/.exec(fs.readFileSync(file,'utf8'));
    if(match)return '/backend-api'+match[1]+'?limit=5&owned_only=false';
  }
  throw Error('No observed project-list endpoint');
}
(async()=>{
  const health=await request('/health',false);assert.equal(health.status,200);assert.equal(health.json?.service,'ass');
  const results=[];
  for(const [kind,endpoint] of [['native-workspace-settings','/backend-api/wham/settings/user'],
    ['desktop-workspace-settings','/backend-api/settings/user'],['project-list',projectPath()]]) {
    const response=await request(endpoint);
    const validJSON=!!response.json&&typeof response.json==='object';
    const row={kind,status:response.status,json:validJSON,keys:validJSON?Object.keys(response.json).slice(0,12):[],
      ...(kind==='project-list'?{itemsArray:Array.isArray(response.json?.items)}:{}),requestId:response.requestId,cfRay:response.cfRay};
    results.push(row);
  }
  assert.deepEqual(sourceFiles.map(hash),before);
  console.log(JSON.stringify({diagnosticOnly:true,liveCodexRoutingNotChanged:true,port,results,originalAuthAndConfigUnchanged:true,inferenceRequests:0}));
  assert.ok(results.every(r=>r.status===200&&r.json&&(r.kind!=='project-list'||r.itemsArray)),'At least one live ASS metadata route failed');
})().catch(error=>{console.error(JSON.stringify({error:error.message}));process.exitCode=1;});
