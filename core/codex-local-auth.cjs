const { read, safePath } = require('./native-fields.cjs');
const { nativeCredential } = require('./codex-official-auth.cjs');

function document(text) {
  const value = JSON.parse((text ?? '{}').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Codex 登录记录无法识别，未覆盖');
  return value;
}
function validate(record, token) {
  if (!record) return;
  if ((record.before !== null && typeof record.before !== 'string') || typeof record.after !== 'string')
    throw Error('Codex 本机认证恢复记录无效');
  const after = document(record.after);
  if (after.auth_mode !== 'apikey' || after.OPENAI_API_KEY !== token)
    throw Error('Codex 本机认证与接入凭据不匹配');
  document(record.before);
}
function plan(config, applied, previous) {
  validate(previous?.localAuth, previous?.localToken);
  safePath(config.auth);
  const current = read(config.auth);
  // Restore only an unchanged ASS fallback. A subsequent native login owns its
  // new file, so resync/detach must preserve that login instead of replaying it.
  const baseline = previous?.localAuth && current === previous.localAuth.after ? previous.localAuth.before : current;
  let after = baseline, record;
  if (applied?.accountless) {
    const value = document(baseline);
    if (!nativeCredential(value)) {
      after = JSON.stringify({ ...value, auth_mode: 'apikey', OPENAI_API_KEY: applied.localToken }, null, 2) + '\n';
      record = { before: baseline, after };
    }
  }
  return { record, files: current === after ? [] : [{ file: config.auth, before: current, after }] };
}
function isFallback(config, auth) {
  const local = config?.model_providers?.ASS;
  return auth?.auth_mode === 'apikey' && /^[a-f0-9]{64}$/.test(auth.OPENAI_API_KEY || '') &&
    local?.requires_openai_auth === false && local.experimental_bearer_token === auth.OPENAI_API_KEY;
}
module.exports = { plan, validate, isFallback };
