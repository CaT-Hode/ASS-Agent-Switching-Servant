const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {Router}=require('../core/router.cjs');
const {CodexWorkspaceRelay}=require('../core/codex-workspace-relay.cjs');
const {createLoopbackCertificate,validateLoopbackCertificate}=require('../core/loopback-certificate.cjs');
const {launchCodexDesktop,openCodexDesktop}=require('../core/codex-desktop-launch.cjs');
const crypt={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};

test('loopback chain verifies localhost/IP and the leaf key; unrelated and expired keys fail',()=>{
  const bundle=createLoopbackCertificate(), ca=new crypto.X509Certificate(bundle.ca),leaf=new crypto.X509Certificate(bundle.cert);
  assert.equal(ca.ca,true);assert.equal(leaf.ca,false);assert.ok(leaf.verify(ca.publicKey));
  assert.equal(leaf.checkIP('127.0.0.1'),'127.0.0.1');assert.equal(leaf.checkHost('chatgpt.com'),undefined);
  assert.match(validateLoopbackCertificate(bundle),/^[A-Za-z0-9+/]{43}=$/);
  assert.throws(()=>validateLoopbackCertificate({...bundle,key:crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'})}));
  assert.throws(()=>validateLoopbackCertificate(bundle,Date.now()+366*86400000));
});

test('HTTPS official relay preserves real lists/errors and raw requests, isolates credentials and shares client admission',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-workspace-relay-test-'));
  const state={providers:[],gatewayAuth:true,localToken:'a'.repeat(64)};const calls=[],logs=[];let enabled=true;
  const router=new Router({getState:()=>state,allowClient:()=>enabled,log:r=>logs.push(r),fetchUpstream:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/denied')) return new Response('<html>Forbidden</html>',{status:403,headers:{'content-type':'text/html','cf-ray':'fixture'}});
    if(url.endsWith('/binary')) return new Response(Buffer.from([0,255,128,1]),{headers:{'content-type':'application/octet-stream'}});
    return Response.json({items:[],cursor:null},{headers:{'x-request-id':'fixture'}});
  }});
  const relay=new CodexWorkspaceRelay({dataDir:root,crypto:crypt,router,env:{}});
  t.after(async()=>{await relay.stop();await router.stop();fs.rmSync(root,{recursive:true,force:true});});
  await router.start(0);const options=await relay.start();
  let launched;
  await openCodexDesktop({desktop:()=>path.join(root,'ChatGPT.exe'),rediscover:()=>assert.fail('unexpected rediscovery'),
    workspaceOptions:()=>relay.start(),preview:async()=>({value:{apps:[],targets:[]},available:false}),openNative:()=>assert.fail('must not bypass relay'),
    launchDesktop:(exe,opts)=>launchCodexDesktop(exe,opts,(exe,args,settings)=>{
      launched={exe,args,settings};const child=new (require('node:events').EventEmitter)();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
    })});
  assert.equal(path.basename(launched.exe),'ChatGPT.exe');assert.deepEqual(launched.args,options.args);
  assert.equal(launched.settings.env.CODEX_APP_SERVER_CHATGPT_BASE_URL,options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL);
  assert.equal(launched.settings.env.CODEX_CA_CERTIFICATE,options.env.CODEX_CA_CERTIFICATE);
  assert.equal(relay.status().running,true);assert.equal(relay.status().lastRequest,null);
  const ca=fs.readFileSync(options.env.CODEX_CA_CERTIFICATE);
  const request=(pathname,method='GET',headers={},body)=>new Promise((resolve,reject)=>{
    const base=new URL(options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL);
    const req=https.request({hostname:base.hostname,port:base.port,path:pathname,method,ca,agent:false,
      headers:{authorization:'Bearer native-oauth',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
    req.on('error',reject);req.end(body);
  });
  const list=await request('/backend-api/gizmos/g-p-project/conversations?limit=20');
  assert.equal(list.status,200);assert.deepEqual(JSON.parse(list.body),{items:[],cursor:null});
  assert.equal(relay.status().lastRequest.status,200);
  assert.equal(list.headers['x-request-id'],'fixture');
  assert.equal(calls[0].url,'https://chatgpt.com/backend-api/gizmos/g-p-project/conversations?limit=20');
  assert.equal(calls[0].init.headers.authorization,'Bearer native-oauth');
  const payload=Buffer.from('{ "message": "unchanged" }');
  await request('/backend-api/sentinel/heartbeat','POST',{'content-type':'application/json','content-encoding':'gzip','user-agent':'native-agent',cookie:'never-forward'},zlib.gzipSync(payload));
  assert.deepEqual(calls.at(-1).init.body,payload);assert.equal(calls.at(-1).init.headers['content-encoding'],undefined);
  assert.equal(calls.at(-1).init.headers['user-agent'],undefined);assert.equal(calls.at(-1).init.headers.cookie,undefined);
  const denied=await request('/backend-api/denied');assert.equal(denied.status,403);assert.equal(denied.body.toString(),'<html>Forbidden</html>');
  assert.deepEqual((await request('/backend-api/binary')).body,Buffer.from([0,255,128,1]));
  const count=calls.length;
  assert.equal((await request('/backend-api/gizmos/g-p-project/conversations','GET',{authorization:''})).status,401);
  assert.equal((await request('/backend-api/gizmos/g-p-project/conversations','GET',{origin:'https://foreign.invalid'})).status,403);
  assert.equal((await request('/not-backend')).status,404);assert.equal(calls.length,count);
  state.accountless=true;assert.equal((await request('/backend-api/wham/accounts/check')).status,401);
  state.accountless=false;enabled=false;assert.equal((await request('/backend-api/wham/accounts/check')).status,503);
  assert.equal(calls.length,count);assert.equal(router.clientActive('codex'),0);
  assert.equal(logs.find(r=>r.status===200).source,'OpenAI 官方服务');
  assert.ok(!JSON.stringify(logs).includes('native-oauth'));
  assert.equal(fs.readFileSync(path.join(root,'codex-workspace-tls.enc.json'),'utf8').includes('PRIVATE KEY'),false);
  await relay.stop();
  assert.deepEqual(await relay.start(),options);
  assert.equal((await request('/backend-api/wham/accounts/check')).status,503);
});

test('workspace launch is process-scoped and rejects remote endpoints or broad certificate bypass flags',async()=>{
  const {EventEmitter}=require('node:events');let launched;
  const originalBase=process.env.CODEX_API_BASE_URL;
  const options={args:['--ignore-certificate-errors-spki-list='+Buffer.alloc(32,1).toString('base64')],env:{
    CODEX_APP_SERVER_CHATGPT_BASE_URL:'https://127.0.0.1:25820/backend-api/',CODEX_CA_CERTIFICATE:path.join(os.tmpdir(),'fixture.pem')}};
  const spawn=(exe,args,settings)=>{launched={exe,args,settings};const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
  const exe=path.join(os.tmpdir(),'ChatGPT.exe');await launchCodexDesktop(exe,options,spawn);
  assert.equal(launched.settings.env.CODEX_API_BASE_URL,originalBase);
  assert.equal(launched.settings.env.CODEX_APP_SERVER_CHATGPT_BASE_URL,options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL);
  assert.equal(launched.settings.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
  assert.equal(launched.settings.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(launched.settings.stdio,'ignore');assert.equal(process.env.CODEX_API_BASE_URL,originalBase);
  assert.throws(()=>launchCodexDesktop(exe,{...options,args:['--ignore-certificate-errors']},spawn));
  assert.throws(()=>launchCodexDesktop(exe,{...options,env:{...options.env,CODEX_APP_SERVER_CHATGPT_BASE_URL:'https://foreign.invalid/backend-api/'}},spawn));
  assert.throws(()=>launchCodexDesktop(exe,{...options,env:{...options.env,CODEX_API_BASE_URL:options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL}},spawn));
  assert.throws(()=>launchCodexDesktop(path.join(os.tmpdir(),'Codex.exe'),options,spawn));
});
