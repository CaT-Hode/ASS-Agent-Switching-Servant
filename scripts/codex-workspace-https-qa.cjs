// Read-only native account + Chromium project-list acceptance. No inference,
// no live desktop restart, no auth refresh, no original config/credential writes.
const {app,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),{createHash}=require('node:crypto');
const load=require('node:module').createRequire(path.join(process.env.ASS_QA_RUNTIME_ROOT||path.resolve(__dirname,'..'),'package.json'));
const {createLoopbackCertificate,validateLoopbackCertificate}=load('./core/loopback-certificate.cjs');
const {CodexWorkspaceRelay}=load('./core/codex-workspace-relay.cjs');
const {Router}=load('./core/router.cjs');
const {prepareConfig,atomic}=load('./core/config.cjs'),{makeCatalog}=load('./core/models.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-workspace-https-qa-'));
const bundle=createLoopbackCertificate();
// The same exact per-leaf Chromium command-line pin used by the production
// launcher. This probe uses a temporary fixture, not the live ASS certificate.
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list',validateLoopbackCertificate(bundle));
app.setPath('userData',path.join(root,'electron'));
app.disableHardwareAcceleration();
const fixtureCrypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
atomic(path.join(root,'codex-workspace-tls.enc.json'),JSON.stringify({version:1,encrypted:Buffer.from(JSON.stringify(bundle)).toString('base64')}));
let router,relay,child,sourceFiles,before;
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function observedProject() {
  const base=path.join(process.env.LOCALAPPDATA,'Codex/Logs');
  const files=[];
  for (const year of fs.readdirSync(base).filter(n=>/^\d{4}$/.test(n)))
    for (const month of fs.readdirSync(path.join(base,year)).filter(n=>/^\d{2}$/.test(n)))
      for (const day of fs.readdirSync(path.join(base,year,month)).filter(n=>/^\d{2}$/.test(n)))
        for (const name of fs.readdirSync(path.join(base,year,month,day)).filter(n=>n.includes('-t0-')&&n.endsWith('.log')))
          files.push(path.join(base,year,month,day,name));
  for (const file of files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,12)) {
    const project=/url=(\/gizmos\/g-p-[a-f0-9]+\/conversations)(?:\?|\s)/.exec(fs.readFileSync(file,'utf8'))?.[1];
    if(project) return project;
  }
  throw Error('No observed project endpoint in recent native logs');
}
async function account(binary,home,env) {
  return new Promise((resolve,reject)=>{
    child=spawn(binary,['app-server','--listen','stdio://','-c','chatgpt_base_url='+JSON.stringify(env.CODEX_APP_SERVER_CHATGPT_BASE_URL)],{
      env:{...process.env,...env,CODEX_HOME:home},cwd:home,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const timer=setTimeout(()=>reject(Error('Native account probe timeout')),30000);
    child.once('error',()=>{clearTimeout(timer);reject(Error('Native probe spawn failed'));});
    createInterface({input:child.stdout}).on('line',line=>{
      let m;try{m=JSON.parse(line);}catch{return;}
      if(m.id===1) {
        if(m.error){clearTimeout(timer);return reject(Error('Native initialize failed'));}
        child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
        child.stdin.write(JSON.stringify({id:2,method:'account/read',params:{refreshToken:false}})+'\n');
      } else if(m.id===2) {clearTimeout(timer);m.error?reject(Error('Native account/read failed: '+m.error.message)):resolve(m.result);}
    });
    child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'ass_workspace_https_qa',version:'1'}}})+'\n');
  });
}
app.whenReady().then(async()=>{
  const source=path.join(process.env.USERPROFILE,'.codex');
  sourceFiles=['auth.json','config.toml'].map(n=>path.join(source,n));before=sourceFiles.map(hash);
  const raw=fs.readFileSync(sourceFiles[0]);const auth=JSON.parse(raw);
  assert.ok(auth.tokens?.access_token && auth.tokens.account_id,'Selected native OAuth workspace required');
  const exp=JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1],'base64url')).exp;
  assert.ok(exp*1000>Date.now()+120000,'Token near expiry; no refresh allowed in this probe');
  const project=observedProject();
  const transport=session.fromPartition('ass-workspace-https-qa-upstream');await transport.setProxy({mode:'system'});
  const calls=[];
  router=new Router({getState:()=>({providers:[],gatewayAuth:true,localToken:'a'.repeat(64)}),fetchUpstream:async(url,init)=>{
    assert.ok(url.startsWith('https://chatgpt.com/backend-api/'));
    const response=await transport.fetch(url,{...init,signal:AbortSignal.timeout(25000)});
    calls.push({kind:url.includes('/gizmos/')?'project':'workspace',status:response.status});return response;
  }});
  await router.start(0);
  relay=new CodexWorkspaceRelay({dataDir:root,crypto:fixtureCrypto,router,env:{}});
  const options=await relay.start();
  const home=path.join(root,'codex');fs.mkdirSync(home);atomic(path.join(home,'auth.json'),raw);
  const catalog=path.join(home,'catalog.json');atomic(catalog,JSON.stringify(makeCatalog([],[])));
  atomic(path.join(home,'config.toml'),prepareConfig('',catalog,`http://127.0.0.1:${router.port}/clients/ASS/v1`,null,'a'.repeat(64),true).text);
  const binaryRoot=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');
  const binary=process.argv[2]||fs.readdirSync(binaryRoot).map(n=>path.join(binaryRoot,n,'codex.exe')).filter(fs.existsSync)
    .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  assert.ok(binary && path.isAbsolute(binary),'No verified native binary');
  const native=await account(binary,home,options.env);
  assert.equal(native.account?.type,'chatgpt');assert.equal(native.requiresOpenaiAuth,true);
  assert.equal(native.workspaceRouting?.backendOrigin,new URL(options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL).origin);
  const downstream=session.fromPartition('ass-workspace-https-qa-downstream');await downstream.setProxy({mode:'direct'});
  for(const [kind,endpoint] of [['workspace','wham/accounts/check'],['project',project.slice(1)]]) {
    const response=await downstream.fetch(options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL+endpoint,{headers:{authorization:'Bearer '+auth.tokens.access_token,
      'chatgpt-account-id':auth.tokens.account_id,accept:'application/json',originator:'codex_desktop_rs'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200,kind+' status');
    const data=await response.json();
    if(kind==='project') assert.ok(Array.isArray(data.items) && Object.hasOwn(data,'cursor'),'Native project-list shape');
    else assert.ok(data.accounts,'Native workspace shape');
  }
  assert.deepEqual(sourceFiles.map(hash),before);
  console.log(JSON.stringify({passed:true,nativeAccountVisible:true,nativeWorkspaceRouting:true,
    chromiumExactSpkiPin:true,projectListJson:true,calls,sourceAuthAndConfigUnchanged:true,inferenceRequests:0}));
}).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;}).finally(async()=>{
  if(child?.exitCode===null && child?.pid) {
    const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();
    const reap=setTimeout(()=>child.kill(),1000);await exited;clearTimeout(reap);
  }
  await relay?.stop();await router?.stop();
  try {if(before)assert.deepEqual(sourceFiles.map(hash),before);}catch{console.error('Original native files changed');process.exitCode=1;}
  try{fs.rmSync(root,{recursive:true,force:true});}catch{}
  app.exit(process.exitCode||0);
});
