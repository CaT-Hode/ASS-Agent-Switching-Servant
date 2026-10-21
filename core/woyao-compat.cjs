// WOYAO's Gemini Responses bridge differs from its GPT/Claude channels.
// Match the service and model, never a user-editable supplier display name.
function woyaoGemini(provider, model) {
  try {
    const url = new URL(provider?.baseUrl);
    return url.origin === 'https://api.iiiiitoken.com' && !url.username && !url.password &&
      !url.search && !url.hash && ['', '/v1'].includes(url.pathname.replace(/\/$/, '')) &&
      /^gemini-/i.test(String(model?.model || '').split('/').at(-1));
  } catch { return false; }
}
module.exports = { woyaoGemini };
