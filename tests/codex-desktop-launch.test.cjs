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
for(const available of [true,undefined]) test(`running/unknown Codex is not reopened or stopped (${available})`,async()=>{
  const f=fixture({preview:async()=>available?{available:true,value:{apps:[{}]}}:{available:false}});
  if(available) assert.match((await openCodexDesktop(f.dependencies)).message,/已在运行/);
  else await assert.rejects(openCodexDesktop(f.dependencies),/无法确认 Codex 运行状态/);
  assert.deepEqual(f.calls,[]);
});
test('relay preparation and launch failures never fall back to a normal native launch',async()=>{
  for(const failedStep of ['workspaceOptions','launchDesktop']) {
    const f=fixture({[failedStep]:async()=>{throw Error('synthetic relay failure');}});
    await assert.rejects(openCodexDesktop(f.dependencies),/synthetic relay failure/);
    assert.deepEqual(f.calls,[]);
  }
});
test('native launch is explicit when the relay is disabled; missing desktop remains actionable',async()=>{
  const f=fixture({workspaceOptions:async()=>null});
  assert.match((await openCodexDesktop(f.dependencies)).message,/未启用 ASS 官方服务修复通道/);
  assert.deepEqual(f.calls,[['native',exe]]);
  const missing=fixture({desktop:()=>null});
  await assert.rejects(openCodexDesktop(missing.dependencies),/未找到 Codex 桌面主程序/);
  assert.deepEqual(missing.calls,['rediscover']);
});
