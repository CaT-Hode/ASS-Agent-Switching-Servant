// Match observed Gemini gateway limitations by endpoint and model family,
// independently of the user's supplier display name.
function geminiAt(provider, model, origin) {
  try {
    const url = new URL(provider?.baseUrl);
    return url.origin === origin && !url.username && !url.password &&
      !url.search && !url.hash && ['', '/v1'].includes(url.pathname.replace(/\/$/, '')) &&
      /^gemini-/i.test(String(model?.model || '').split('/').at(-1));
  } catch { return false; }
}
const woyaoGemini = (provider, model) => geminiAt(provider, model, 'https://api.iiiiitoken.com');
const mifyTeamGemini = (provider, model) => geminiAt(provider, model, 'https://api.llm.mioffice.cn');
module.exports = { woyaoGemini, mifyTeamGemini };
