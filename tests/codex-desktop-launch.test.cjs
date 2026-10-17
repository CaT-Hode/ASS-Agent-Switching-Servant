const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {openCodexDesktop}=require('../core/codex-desktop-launch.cjs');
const exe=path.join(os.tmpdir(),'codex-desktop-fixture','ChatGPT.exe');
function fixture(overrides={}) {
  const calls=[],options={args:['scoped-pin'],env:{CODEX_APP_SERVER_CHATGPT_BASE_URL:'https://127.0.0.1:12345/backend-api/'}};
  return {calls,options,dependencies:{desktop:()=>exe,rediscover:()=>calls.push('rediscover'),
    workspaceOptions:async()=>options,preview:async()=>({value:{apps:[],targets:[]},available:false}),
    openNative:async file=>{calls.push(['native',file]);return '';},
    launchDesktop:async(file,opts)=>{calls.push(['relay',file,opts]);},...overrides}};
}
test('Codex desktop button uses the primary with exactly the relay launch options',async()=>{
  const f=fixture();const result=await openCodexDesktop(f.dependencies);
  assert.deepEqual(f.calls,[['relay',exe,f.options]]);assert.match(result.message,/专用 HTTPS 中转/);
});
test('missing cached desktop is rediscovered before launching and no trampoline is accepted',async()=>{
  let detected=false;
  const f=fixture({desktop:()=>detected?exe:null,rediscover:()=>{detected=true;}});
  await openCodexDesktop(f.dependencies);assert.deepEqual(f.calls,[['relay',exe,f.options]]);
  for(const entry of [path.join(os.tmpdir(),'Codex.exe'),path.join(os.tmpdir(),'codex.cmd'),'ChatGPT.exe']) {
    const invalid=fixture({desktop:()=>entry});await assert.rejects(openCodexDesktop(invalid.dependencies),/入口不是 ChatGPT.exe/);
    assert.deepEqual(invalid.calls,[]);
  }
});
for(const available of [true,undefined]) test(`running/unknown Codex uses native window activation without a relay relaunch (${available})`,async()=>{
  const f=fixture({preview:async()=>available?{available:true,value:{apps:[{}]}}:{available:false}});
  const result=await openCodexDesktop(f.dependencies);
  assert.match(result.message,available?/已唤起正在运行/:/无法确认运行状态/);
  assert.deepEqual(f.calls,[['native',exe]]);
});
test('an optional relay preparation failure does not block native OAuth launch, including repeated clicks',async()=>{
  const f=fixture({workspaceOptions:async()=>{throw Error('synthetic missing record');}});
  for(let i=0;i<2;i++) {
    const result=await openCodexDesktop(f.dependencies);
    assert.equal(result.degraded,true);assert.match(result.message,/官方服务通道未就绪/);
  }
  assert.deepEqual(f.calls,[['native',exe],['native',exe]]);
  const failed=fixture({workspaceOptions:async()=>{throw Error('synthetic missing record');},openNative:async()=> 'synthetic shell failure'});
  await assert.rejects(openCodexDesktop(failed.dependencies),/无法打开 Codex/);
});
test('a failed actual relay launch is not duplicated through another launcher',async()=>{
  const f=fixture({launchDesktop:async()=>{throw Error('synthetic relay failure');}});
  await assert.rejects(openCodexDesktop(f.dependencies),/synthetic relay failure/);
  assert.deepEqual(f.calls,[]);
});
test('native launch is explicit when the relay is disabled; missing desktop remains actionable',async()=>{
  const f=fixture({workspaceOptions:async()=>null});
  assert.match((await openCodexDesktop(f.dependencies)).message,/未启用 ASS 官方服务修复通道/);
  assert.deepEqual(f.calls,[['native',exe]]);
  const missing=fixture({desktop:()=>null});
  await assert.rejects(openCodexDesktop(missing.dependencies),/未找到 Codex 桌面主程序/);
  assert.deepEqual(missing.calls,['rediscover']);
});
