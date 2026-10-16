// A private, process-scoped localhost CA and leaf. No certificate-store writes.
const crypto = require('node:crypto');
const der = (tag, ...parts) => {
  const data = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  const size = data.length < 128 ? Buffer.from([data.length]) : (() => {
    const bytes = []; for (let n = data.length; n; n >>>= 8) bytes.unshift(n & 255);
    return Buffer.from([128 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), size, data]);
};
const seq = (...p) => der(0x30, ...p);
const int = n => der(2, [n]);
const oid = text => {
  const [a,b,...rest] = text.split('.').map(Number), bytes = [a*40+b];
  for (const n of rest) { let v=n, p=[v&127]; while ((v >>>= 7)) p.unshift(128|(v&127)); bytes.push(...p); }
  return der(6, bytes);
};
const algorithm = seq(oid('1.2.840.113549.1.1.11'), der(5, []));
const name = s => seq(der(0x31, seq(oid('2.5.4.3'), der(12, s))));
const time = date => der(0x17, date.toISOString().slice(2,19).replace(/[-:T]/g,'')+'Z');
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [der(1,[255])] : []), der(4,value));
const pem = (label, value) => `-----BEGIN ${label}-----\n${value.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
function certificate(subject, publicKey, issuer, signingKey, isCa, now) {
  const serial = crypto.randomBytes(16); serial[0] &= 127; serial[0] |= 1;
  const extensions = [ext('2.5.29.19', isCa ? seq(der(1,[255]), int(0)) : seq(), true),
    ext('2.5.29.15', der(3, isCa ? [1,6] : [5,160]), true)];
  if (!isCa) extensions.push(ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
    ext('2.5.29.17', seq(der(0x82,'localhost'),der(0x87,[127,0,0,1]))));
  const tbs = seq(der(0xa0,int(2)), der(2,serial), algorithm, name(issuer),
    seq(time(new Date(now-86400000)), time(new Date(now+365*86400000))), name(subject),
    publicKey.export({type:'spki',format:'der'}), der(0xa3,seq(...extensions)));
  return pem('CERTIFICATE',seq(tbs,algorithm,der(3,Buffer.concat([Buffer.from([0]),crypto.sign('sha256',tbs,signingKey)]))));
}
function createLoopbackCertificate(now = Date.now()) {
  const ca=crypto.generateKeyPairSync('rsa',{modulusLength:2048}), leaf=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const issuer='ASS localhost workspace CA';
  return { version:1, ca:certificate(issuer,ca.publicKey,issuer,ca.privateKey,true,now),
    cert:certificate('localhost',leaf.publicKey,issuer,ca.privateKey,false,now),
    key:leaf.privateKey.export({type:'pkcs8',format:'pem'}) };
}
function validateLoopbackCertificate(bundle, now = Date.now()) {
  if (bundle?.version!==1) throw Error('本机 HTTPS 证书记录无效');
  const ca=new crypto.X509Certificate(bundle.ca), leaf=new crypto.X509Certificate(bundle.cert);
  if (!ca.ca || leaf.ca || !leaf.verify(ca.publicKey) || !leaf.checkPrivateKey(crypto.createPrivateKey(bundle.key)) ||
      !leaf.checkIP('127.0.0.1') || !leaf.checkHost('localhost') ||
      Date.parse(leaf.validFrom)>now || Date.parse(leaf.validTo)<=now+86400000 || Date.parse(ca.validTo)<=now+86400000)
    throw Error('本机 HTTPS 证书无效或即将过期');
  return crypto.createHash('sha256').update(leaf.publicKey.export({type:'spki',format:'der'})).digest('base64');
}
module.exports = { createLoopbackCertificate, validateLoopbackCertificate };
