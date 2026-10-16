// Launch the INSTALLED Codex Desktop with a disposable profile and copied OAuth.
// Only GET/HEAD metadata may reach upstream; no inference or mutation is sent.
// Stop only the exact process tree spawned here; never touch the live desktop.
const {app,session,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const load=require('node:module').createRequire(path.join(process.env.ASS_QA_RUNTIME_ROOT||path.resolve(__dirname,'..'),'package.json'));
const {Router}=load('./core/router.cjs'),{CodexWorkspaceRelay}=load('./core/codex-workspace-relay.cjs');
const {launchCodexDesktop}=load('./core/codex-desktop-launch.cjs');
const {prepareConfig,atomic,ConfigManager}=load('./core/config.cjs'),{makeCatalog}=load('./core/models.cjs');
const {DesktopRestartAdapter}=load('./core/client-restart.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-real-desktop-relay-'));
app.setPath('userData',path.join(root,'controller'));app.disableHardwareAcceleration();
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let relay,router,child,original,before,adapter=new DesktopRestartAdapter(),nativeAuthFile,baseline;
const calls=[],blocked=[];const started=Date.now();
app.whenReady().then(async()=>{
  const inventory=await adapter.inventory(['codex']);baseline=inventory;
  assert.equal(inventory.apps.length,1,'Need one verified installed desktop');
  const source=path.join(process.env.USERPROFILE,'.codex');
  original=['auth.json','config.toml'].map(n=>path.join(source,n));before=original.map(hash);
  const raw=fs.readFileSync(original[0]),auth=JSON.parse(raw);
  assert.ok(auth.tokens?.access_token&&auth.tokens.account_id,'OAuth workspace required');
  const exp=JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1],'base64url')).exp;
  assert.ok(exp*1000>Date.now()+180000,'Token near expiry; do not refresh in QA');
  const transport=session.fromPartition('ass-real-desktop-official');await transport.setProxy({mode:'system'});
  router=new Router({getState:()=>({providers:[],gatewayAuth:true,localToken:'a'.repeat(64)}),fetchUpstream:async(url,init)=>{
    const pathname=new URL(url).pathname;
    const kind=pathname.includes('/gizmos/')?pathname.includes('/conversations')?'project-list':'project-index':pathname.includes('/accounts/')?'account':'other';
    if(!['GET','HEAD'].includes(init.method)||/\/responses(?:\/|$)/.test(pathname)) {
      blocked.push({kind,method:init.method});return Response.json({error:'Read-only desktop QA blocks writes'},{status:409});
    }
    const response=await transport.fetch(url,{...init,signal:AbortSignal.timeout(25000)});
    const row={kind,status:response.status};
    if(kind==='project-list') {
      try {const data=await response.clone().json();row.list=Array.isArray(data.items);}catch{row.list=false;}
    }
    calls.push(row);return response;
  }});
  await router.start(0);relay=new CodexWorkspaceRelay({dataDir:path.join(root,'relay'),crypto:safeStorage,router,env:{}});
  const options=await relay.start();
  const home=path.join(root,'codex'),user=path.join(root,'user'),userdata=path.join(root,'desktop');
  for(const p of [home,user,userdata,path.join(user,'AppData/Roaming'),path.join(user,'AppData/Local')])fs.mkdirSync(p,{recursive:true});
  nativeAuthFile=path.join(home,'auth.json');atomic(nativeAuthFile,raw);
  // Copy only sidebar expansion preferences, never drafts, transcript data,
  // browser storage or authentication state. Expand existing project cards so
  // the actual desktop requests their conversation lists without UI automation.
  const stateFile=path.join(source,'.codex-global-state.json');
  if(fs.existsSync(stateFile)) {
    const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    const atoms=state['electron-persisted-atom-state']||{};
    const sidebar=Object.fromEntries(Object.entries(atoms).filter(([k,v])=>
      /^sidebar-project-expanded-v1-chatgpt:g-p-[a-f0-9]+$/.test(k)&&typeof v==='boolean'));
    if(typeof atoms.last_completed_onboarding==='number')sidebar.last_completed_onboarding=atoms.last_completed_onboarding;
    atomic(path.join(home,'.codex-global-state.json'),JSON.stringify({'electron-persisted-atom-state':sidebar}));
  }
  const catalog=path.join(home,'catalog.json');atomic(catalog,JSON.stringify(makeCatalog([],[])));
  const manager=new ConfigManager(home,home,router.port);
  const prepared=prepareConfig('',catalog,manager.baseUrl,{model:'gpt-6.1-sol',effort:'high'},'a'.repeat(64),true);
  atomic(path.join(home,'config.toml'),prepared.text);
  atomic(manager.record,JSON.stringify({replaced:prepared.replaced,blocks:prepared.text.match(/# >>> ass managed start[\s\S]*?# <<< ass managed end/g)}));
  const binRoot=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');
  const cli=fs.readdirSync(binRoot).map(n=>path.join(binRoot,n,'codex.exe')).filter(fs.existsSync).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  assert.ok(cli,'Verified native CLI required');
  const spawnFixture=(exe,args,settings)=>{
    const env={...settings.env,CODEX_HOME:home,CODEX_CLI_PATH:cli,CODEX_APP_SERVER_FORCE_CLI:'1',CODEX_ELECTRON_USER_DATA_PATH:userdata,
      USERPROFILE:user,HOME:user,APPDATA:path.join(user,'AppData/Roaming'),LOCALAPPDATA:path.join(user,'AppData/Local')};
    for(const k of Object.keys(env))if(/^(OPENAI_|CHATGPT_|CODEX_(?:API_KEY|ACCESS_TOKEN|INTERNAL|THREAD))/i.test(k))delete env[k];
    delete env.CODEX_API_BASE_URL;
    child=spawn(exe,args,{...settings,env});return child;
  };
  await launchCodexDesktop(inventory.apps[0].exe,options,spawnFixture);
  const deadline=Date.now()+45000;
  while(Date.now()<deadline&&!calls.some(r=>r.kind==='project-list'&&r.status===200&&r.list)) {
    if(child.exitCode!==null)throw Error('Isolated desktop exited before request verification');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const after=await adapter.inventory(['codex']);
  assert.ok(after.rows.some(r=>r.pid===child.pid&&r.exe.toLowerCase()===inventory.apps[0].exe.toLowerCase()),'Fixture desktop identity');
  for(const row of inventory.rows.filter(r=>r.exe?.toLowerCase()===inventory.apps[0].exe.toLowerCase()))
    assert.ok(after.rows.some(r=>r.pid===row.pid&&r.created===row.created),'Live desktop unchanged');
  assert.deepEqual(original.map(hash),before);
  assert.doesNotThrow(()=>manager.preflightDetach(),'Native desktop writes must preserve valid ASS ownership');
  const counts={};for(const row of calls){const key=row.kind+':'+row.status;counts[key]=(counts[key]||0)+1;}
  console.log(JSON.stringify({installedDesktop:true,isolatedProfile:true,relayRequests:counts,
    projectLists:calls.filter(r=>r.kind==='project-list').map(r=>({status:r.status,list:r.list})),
    writesBlocked:blocked.length,inferenceRequests:0,nativeConfigOwnershipValid:true,sourceAuthAndConfigUnchanged:true,liveDesktopPreserved:true}));
  assert.ok(calls.some(r=>r.kind==='project-list'&&r.status===200&&r.list),'Real desktop did not load a project list through the HTTPS relay');
}).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;}).finally(async()=>{
  // Remove the credential copy before process inventory/cleanup can fail.
  if(nativeAuthFile&&fs.existsSync(nativeAuthFile))fs.unlinkSync(nativeAuthFile);
  try {
  if(child?.pid && child.exitCode===null) {
    const inventory=await adapter.inventory(['codex']);
    const rootRow=inventory.rows.find(r=>r.pid===child.pid&&r.exe.toLowerCase()===baseline.apps[0].exe.toLowerCase()&&Date.parse(r.created)>=started-1000);
    if(rootRow) {
      const targets=[];const visit=(row,depth)=>{assert.ok(depth<32&&Date.parse(row.created)>=started-1000);targets.push({...row,depth});for(const item of inventory.rows.filter(r=>r.parentPid===row.pid))visit(item,depth+1);};
      visit(rootRow,0);
      try { await adapter.stop(targets); }
      catch {
        // The normal root may already have exited during a successful partial
        // sweep. Re-admit only this fixture's exact still-matching identities.
        if(child.exitCode===null)child.kill();
        const fresh=(await adapter.inventory(['codex'])).rows;
        const remaining=targets.filter(t=>fresh.some(r=>r.pid===t.pid&&r.exe===t.exe&&r.created===t.created&&r.parentPid===t.parentPid)).map(t=>({...t,depth:0}));
        if(remaining.length)await adapter.stop(remaining);
      }
    }
  }
  } catch(e) { console.error(JSON.stringify({cleanupError:e.message}));process.exitCode=1; }
  await relay?.stop();await router?.stop();
  if(before)assert.deepEqual(original.map(hash),before);
  // Retain only non-credential native logs if the read-only probe failed.
  if(!process.exitCode)try{fs.rmSync(root,{recursive:true,force:true});}catch{}
  else console.error(JSON.stringify({diagnosticDirectory:root}));
  app.exit(process.exitCode||0);
});
