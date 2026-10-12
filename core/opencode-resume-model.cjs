const fs = require('node:fs'), path = require('node:path');
const { document, read } = require('./native-fields.cjs');

function modelRef(value) {
  if (typeof value !== 'string' || value.length > 500 || value !== value.trim() ||
      !/^[^/\s]+\/[^\r\n\0]+$/.test(value) || value.startsWith('-'))
    throw Error('OpenCode 当前模型须为 provider/model，请先选择目标模型');
  const split = value.indexOf('/');
  return { providerID: value.slice(0, split), modelID: value.slice(split + 1) };
}
function currentModel({ home, env = {}, cwd, override }) {
  if (override !== undefined) { modelRef(override); return override; }
  let selected;
  const load = file => {
    const text = read(file); if (text === null) return;
    const data = document(text, 'jsonc').data;
    if (data.model !== undefined) selected = data.model;
  };
  const names = ['config.json', 'opencode.json', 'opencode.jsonc', 'cli.json', 'cli.jsonc'];
  const global = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  names.forEach(name => load(path.join(global, name)));
  if (env.OPENCODE_CONFIG) load(path.resolve(cwd, env.OPENCODE_CONFIG));
  if (env.OPENCODE_DISABLE_PROJECT_CONFIG !== 'true' && env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1') {
    const dirs = []; let dir = cwd;
    while (true) {
      dirs.unshift(dir);
      if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
      dir = path.dirname(dir);
    }
    for (const dir of dirs) {
      for (const name of names.slice(1)) load(path.join(dir, name));
      for (const name of names.slice(1)) load(path.join(dir, '.opencode', name));
    }
  }
  if (env.OPENCODE_CONFIG_DIR) names.forEach(name => load(path.resolve(cwd, env.OPENCODE_CONFIG_DIR, name)));
  if (env.OPENCODE_CONFIG_CONTENT) {
    const data = document(env.OPENCODE_CONFIG_CONTENT, 'jsonc').data;
    if (data.model !== undefined) selected = data.model;
  }
  if (selected === undefined) return '';
  if (typeof selected === 'string') selected = selected.replace(/\{env:([^}]+)\}/g, (_, name) => env[name] || '');
  modelRef(selected); return selected;
}
module.exports = { currentModel, modelRef };
