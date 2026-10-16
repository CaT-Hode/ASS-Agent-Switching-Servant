// Real Electron UI; temporary credentials and no native clients closed.
const { _electron: electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-sync-dialog-'));
const codex = path.join(out,'codex'); fs.mkdirSync(codex);
fs.writeFileSync(path.join(codex,'config.toml'),'model = "gpt-6-astra"\n');
fs.writeFileSync(path.join(codex,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic'}}));
(async()=>{
  const env={...process.env,ASS_TEST_DATA:path.join(out,'data'),ASS_TEST_CODEX:codex,ASS_TEST_PORT:'25872'}; delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[root,'--qa'],env});
  try{
    const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForSelector('.theme-toggle');
    await app.evaluate(async()=>{const t=global.assTest;t.setFetch(async()=>Response.json({}, {status:405}));t.protocols.ensureProviders=async()=>{};});
    await page.evaluate(()=>window.ass.call('save-provider',{id:'test',name:'Test',baseUrl:'https://example.test/v1',apiKey:'synthetic',models:[{model:'third-party',wireApi:'openai-responses'}]}));
    await app.evaluate(()=>{const t=global.assTest;t.harnesses.options.proxyConfig.sync('codex');t.connections.enabled.codex=true;
      t.syncProbe={refreshCalls:0,previewCalls:0};
      t.harnesses.refreshOAuth=async()=>{t.syncProbe.refreshCalls++;await new Promise(r=>setTimeout(r,3000));};
      t.processes.refresh=async()=>{t.syncProbe.previewCalls++;await new Promise(r=>{t.releaseSyncPreview=r;});};});
    await page.getByRole('button',{name:'客户端与账户',exact:true}).click();
    const sync=page.getByRole('button',{name:'同步接入配置',exact:true});await sync.waitFor();
    const started=Date.now();await sync.click();
    const dialog=page.getByRole('dialog',{name:'同步 Codex 接入？',exact:true});await dialog.waitFor({timeout:1000});
    const visibleMs=Date.now()-started;assert.ok(visibleMs<1000);
    assert.equal(await app.evaluate(()=>global.assTest.syncProbe.refreshCalls),0);
    assert.ok(await dialog.getByRole('button',{name:'取消',exact:true}).isEnabled());
    await page.screenshot({path:path.join(out,'immediate-sync-dialog.png')});
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await app.evaluate(()=>{global.assTest.releaseSyncPreview?.();global.assTest.processes.refresh=async()=>{};});
    await page.getByRole('combobox',{name:'Codex 默认模型',exact:true}).selectOption(JSON.stringify(['official','gpt-6-astra']));
    await page.waitForFunction(()=>document.querySelector('select[aria-label="Codex 默认模型"]').value===JSON.stringify(['official','gpt-6-astra']));
    assert.equal(await app.evaluate(()=>global.assTest.harnesses.options.proxyConfig.desired('codex').defaultModel.model),'gpt-6-astra');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,visibleMs,refreshBeforeDialog:0,cancelDuringPreview:true,officialDefaultSelected:true,out}));
  }finally{await app.evaluate(()=>global.assTest.quit()).catch(()=>{});await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
