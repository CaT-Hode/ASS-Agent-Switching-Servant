const fs=require('node:fs'), path=require('node:path'), https=require('node:https');
const { atomic }=require('./config.cjs');
const { safePath }=require('./native-fields.cjs');
const { createLoopbackCertificate, validateLoopbackCertificate }=require('./loopback-certificate.cjs');

class CodexWorkspaceRelay {
  constructor({ dataDir, crypto, router, env=process.env }) {
    Object.assign(this,{dataDir,crypto,router,env}); this.server=null; this.starting=null;
  }
  save(bundle) {
    const file=path.join(this.dataDir,'codex-workspace-tls.enc.json'); safePath(file);
    atomic(file,JSON.stringify({version:1,encrypted:this.crypto.encryptString(JSON.stringify(bundle)).toString('base64')}));
  }
  material() {
    if (!this.crypto.isEncryptionAvailable()) throw Error('系统凭据加密不可用，未创建本机 HTTPS 接入');
    const file=path.join(this.dataDir,'codex-workspace-tls.enc.json'); safePath(file);
    let bundle;
    if (fs.existsSync(file)) {
      try {
        if (fs.statSync(file).size>64*1024) throw Error();
        const envelope=JSON.parse(fs.readFileSync(file,'utf8'));
        if (envelope.version!==1 || typeof envelope.encrypted!=='string') throw Error();
        bundle=JSON.parse(this.crypto.decryptString(Buffer.from(envelope.encrypted,'base64')));
      } catch { throw Error('本机 HTTPS 凭据记录无法读取，未覆盖'); }
    } else {
      bundle=createLoopbackCertificate();
      this.save(bundle);
    }
    if (bundle.port!==undefined && (!Number.isInteger(bundle.port) || bundle.port<1024 || bundle.port>65535))
      throw Error('本机 HTTPS 端口记录无效，未覆盖');
    const pin=validateLoopbackCertificate(bundle);
    let ca=bundle.ca;
    const extra=this.env.CODEX_CA_CERTIFICATE?.trim() || this.env.SSL_CERT_FILE?.trim();
    if (extra) {
      if (!path.isAbsolute(extra) || fs.statSync(extra).size>8*1024*1024) throw Error('现有 Codex CA 配置无法安全合并');
      const text=fs.readFileSync(extra,'utf8');
      const certs=text.match(/-----BEGIN (?:TRUSTED )?CERTIFICATE-----[\s\S]*?-----END (?:TRUSTED )?CERTIFICATE-----/g);
      if (!certs?.length) throw Error('现有 Codex CA 配置没有证书，未覆盖');
      ca+='\n'+certs.join('\n')+'\n';
    }
    const caFile=path.join(this.dataDir,'codex-workspace-ca.pem'); safePath(caFile);
    if (!fs.existsSync(caFile) || fs.readFileSync(caFile,'utf8')!==ca) atomic(caFile,ca);
    return {...bundle,pin,caFile};
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.server) return this.options;
    this.starting=(async()=>{
      const bundle=this.material();
      const server=https.createServer({key:bundle.key,cert:bundle.cert+bundle.ca},(req,res)=>{
        req.assWorkspaceRelay=true;
        res.once('finish',()=>{this.lastRequest={time:new Date().toISOString(),status:res.statusCode};});
        this.router.handle(req,res);
      });
      server.requestTimeout=300000; server.headersTimeout=60000;
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(bundle.port || 0,'127.0.0.1',resolve);});
      // Keep the endpoint across ASS restarts: an already-open Codex still holds
      // its process-scoped URL and SPKI pin. Never silently move an occupied port.
      try { if (!bundle.port) this.save({...bundle,port:server.address().port}); }
      catch (error) { server.close(); throw error; }
      this.server=server;
      const base=`https://127.0.0.1:${server.address().port}/backend-api/`;
      this.options={args:[`--ignore-certificate-errors-spki-list=${bundle.pin}`],env:{
        CODEX_APP_SERVER_CHATGPT_BASE_URL:base, CODEX_CA_CERTIFICATE:bundle.caFile,
      }};
      return this.options;
    })().finally(()=>{this.starting=null;});
    return this.starting;
  }
  status() {
    return {running:!!this.server,port:this.server?.address()?.port || null,lastRequest:this.lastRequest || null};
  }
  async stop() {
    if (this.starting) await this.starting.catch(()=>{});
    const s=this.server; this.server=null;
    if (s) {s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
  }
}
module.exports={CodexWorkspaceRelay};
