const path=require('node:path'), {spawn}=require('node:child_process');
function launchCodexDesktop(executable, options, spawnProcess=spawn) {
  if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'chatgpt.exe' ||
      !/^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/.test(options?.args?.[0] || '') || options.args.length!==1 ||
      Object.keys(options.env || {}).sort().join(',')!==['CODEX_APP_SERVER_CHATGPT_BASE_URL','CODEX_CA_CERTIFICATE'].sort().join(','))
    throw Error('无效的 Codex 专用 HTTPS 启动配置');
  const base=new URL(options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL);
  if (base.protocol!=='https:' || base.hostname!=='127.0.0.1' || !base.port || base.pathname!=='/backend-api/' ||
      base.username || base.password || base.search || base.hash ||
      options.env.CODEX_APP_SERVER_CHATGPT_BASE_URL!==base.href || !path.isAbsolute(options.env.CODEX_CA_CERTIFICATE))
    throw Error('Codex 官方服务启动地址不属于本机 HTTPS');
  return new Promise((resolve,reject)=>{
    const env={...process.env,...options.env};
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const child=spawnProcess(executable,options.args,{env,cwd:path.dirname(executable),stdio:'ignore',detached:true,windowsHide:false});
    child.once('error',()=>reject(Error('Codex 桌面端启动失败，请检查安装入口')));
    child.once('spawn',()=>{child.unref();resolve({launched:true});});
  });
}

// Shared by the desktop button and its regression tests. No task termination,
// credential changes, shell trampoline, or native fallback on a relay failure.
async function openCodexDesktop({desktop,rediscover,workspaceOptions,preview,openNative,accountless=false,launchDesktop=launchCodexDesktop}) {
  let executable=desktop();
  if(!executable) { await rediscover(); executable=desktop(); }
  if(!executable) throw Error('未找到 Codex 桌面主程序 ChatGPT.exe，请重新自动识别或选择安装目录');
  if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='chatgpt.exe')
    throw Error('Codex 桌面入口不是 ChatGPT.exe，未使用更新跳板或命令行程序启动');
  const options=await workspaceOptions();
  if(options) {
    const observed=await preview();
    if(!observed?.value) throw Error('无法确认 Codex 运行状态，未重复启动；请结束任务后手动退出 Codex，再重试。');
    if(observed.available) return {ok:true,message:'Codex 已在运行；请在任务结束后通过接入菜单重启，或完全退出后再从 ASS 打开，以启用官方服务 HTTPS 中转。'};
    await launchDesktop(executable,options);
    return {ok:true,message:'已通过 ASS 打开 Codex，官方服务使用专用 HTTPS 中转。'};
  }
  const error=await openNative(executable);
  if(error) throw Error('无法打开 Codex 桌面客户端，请检查安装文件');
  return {ok:true,message:accountless
    ? '已打开 Codex 桌面端。若已有窗口仍使用旧配置，请结束任务后通过接入菜单重启。'
    : '已打开 Codex 桌面端；当前未启用 ASS 官方服务修复通道。'};
}
module.exports={launchCodexDesktop,openCodexDesktop};
