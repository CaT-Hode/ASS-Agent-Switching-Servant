const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const TOML = require('@iarna/toml');
const { atomic } = require('./config.cjs');
const { document, edit, hash } = require('./native-fields.cjs');
const { claudeModelSettings, claudeModelEnv } = require('./accountless.cjs');
const { compactTokenLimit } = require('./context-budget.cjs');
const { codexModelId } = require('./models.cjs');
const CLIENTS = ['codex', 'claude', 'pi'];
const present = value => ({ exists: true, value });
const fieldAt = (data, keys) => {
  for (const key of keys) {
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, key)) return { exists: false };
    data = data[key];
  }
  return present(data);
};
function change(text, format, keys, value) {
  const data = document(text, format).data;
  if (equal(fieldAt(data, keys), value)) return text;
  if (format !== 'toml') return edit(text, 'json', keys, value);
  let parent = data;
  for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
  if (value.exists) parent[keys.at(-1)] = value.value;
  else delete parent[keys.at(-1)];
  return TOML.stringify(data);
}
function planFiles(desired, previous = [], contents) {
  const result = [], records = [];
  for (const file of new Set([...desired.map(d => d.file), ...previous.map(d => d.file)])) {
    const next = desired.find(d => d.file === file), old = previous.find(d => d.file === file);
    const before = contents[file] ?? null;
    let after = before;
    const format = next?.format || old.format;
    if (format === 'raw') {
      if (old && before !== old.after) throw Error('WSL 模型目录被外部修改，请先处理冲突');
      after = next ? next.text : old.before;
      if (next) records.push({ ...next, before: old ? old.before : before, after });
    } else {
      const data = document(before, format).data;
      for (const field of old?.fields || []) {
        const current = fieldAt(data, field.keys), desired = next?.fields.find(f => equal(f.keys, field.keys));
        if (!equal(current, field.after) && !(next && equal(current,
          desired?.value === undefined ? { exists: false } : present(desired.value))))
          throw Error('WSL 受管配置被外部修改：' + field.keys.join('.'));
      }
      if (!next && old && before === old.after) after = old.before;
      else {
        for (const field of old?.fields || []) if (!next?.fields.some(f => equal(f.keys, field.keys)))
          after = change(after, format, field.keys, field.before);
        const fields = (next?.fields || []).map(field => {
          const prior = old?.fields.find(f => equal(f.keys, field.keys));
          return { keys: field.keys, before: prior?.before || fieldAt(data, field.keys),
            after: field.value === undefined ? { exists: false } : present(field.value) };
        });
        for (const field of fields) after = change(after, format, field.keys, field.after);
        if (next) records.push({ file, format, before: old ? old.before : before, after, fields });
      }
    }
    if (after !== before) result.push({ file, before, beforeHash: hash(before), after });
  }
  return { files: result, records };
}
function projection(id, source, info, base) {
  const dir = info.dirs[id], file = name => path.posix.join(dir, name);
  const fields = (name, values, format = 'json') => ({ file: file(name), format,
    fields: Object.entries(values).map(([key, value]) => ({ keys: [key], value })) });
  if (id === 'codex') {
    const model = source.model || source.plan.defaultModel?.model;
    if (!model || !source.plan.localToken) throw Error('请先同步 Windows Codex 接入');
    return [fields('config.toml', { model, model_reasoning_effort: source.effort,
      model_context_window: source.contextWindow,
      model_auto_compact_token_limit: compactTokenLimit(source.contextWindow),
      model_provider: 'openai', cli_auth_credentials_store: 'file', openai_base_url: base + '/clients/ASS/v1', model_catalog_json: file('ass-models.json') }, 'toml'),
      fields('auth.json', { auth_mode: 'apikey', OPENAI_API_KEY: source.plan.localToken, tokens: undefined }),
      { file: file('ass-models.json'), format: 'raw', text: JSON.stringify(source.plan.catalog, null, 2) }];
  }
  if (id === 'claude') {
    const selected = source.plan.defaultModel?.model;
    if (!selected) throw Error('请先同步 Windows Claude Code 接入');
    const { modelSettings, ...settings } = claudeModelSettings(source.plan.providers, selected);
    const env = { ...claudeModelEnv(source.plan.providers, selected, source.plan.autoModeModel),
      ANTHROPIC_BASE_URL: base + '/clients/claude/models', ANTHROPIC_AUTH_TOKEN: source.token,
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    return [{ ...fields('settings.json', settings), fields: [
      ...Object.entries(settings).map(([key, value]) => ({ keys: [key], value })),
      ...Object.entries(modelSettings).map(([model, value]) => ({ keys: ['modelSettings', model, 'autoCompactWindow'], value: value.autoCompactWindow })),
      ...Object.entries(env).map(([key, value]) => ({ keys: ['env', key], value })),
    ] }];
  }
  return source.files.map(row => ({ file: file(row.name), format: 'json', fields: row.fields }));
}
function filterProviders(id, source, excluded = []) {
  if (!source || !excluded.length) return source;
  if (id === 'pi') {
    const { providerId } = require('./native-config.cjs');
    const removed = new Set(excluded.flatMap(id => ['openai-responses', 'openai-chat', 'anthropic']
      .map(protocol => providerId({ id }, protocol))));
    const settings = source.files.find(row => row.name === 'settings.json');
    const defaultRemoved = removed.has(settings?.fields.find(f => f.keys[0] === 'defaultProvider')?.value);
    const files = source.files.map(row => ({ ...row, fields: row.fields.filter(({ keys: [key, sub] }) => {
      if (row.name === 'models.json') return !removed.has(sub);
      if (row.name === 'auth.json') return !removed.has(key);
      if (key === 'modelThinkingLevels') return !removed.has(sub?.split('/')[0]);
      return !defaultRemoved || !['defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(key);
    }) })).filter(row => row.fields.length);
    return files.some(row => row.name === 'models.json') ? { files } : null;
  }
  const removed = new Set(excluded), applied = source.plan.providers || [];
  const providers = applied.filter(p => !removed.has(p.id));
  if (providers.length === applied.length) return source;
  const allowed = new Set(providers.flatMap(p => p.models.filter(m => m.enabled !== false).map(m => codexModelId(p.id, m.model))));
  const plan = { ...source.plan, providers };
  if (id === 'claude') {
    if (!allowed.size) return null;
    if (!allowed.has(plan.defaultModel?.model)) plan.defaultModel = { model: allowed.values().next().value };
    if (!allowed.has(plan.autoModeModel)) delete plan.autoModeModel;
    return { ...source, plan };
  }
  const models = plan.catalog.models.filter(m => !m.slug.includes('::') || allowed.has(m.slug));
  if (!models.length) return null;
  plan.catalog = { ...plan.catalog, models };
  if (models.some(m => m.slug === source.model)) return { ...source, plan };
  const next = models.find(m => m.slug === plan.defaultModel?.model) ||
    models.find(m => m.visibility !== 'hide') || models[0];
  return { ...source, plan, model: next.slug, effort: next.default_reasoning_level,
    contextWindow: next.context_window || next.max_context_window };
}
function windowsSources({ proxyConfig, nativeConfig, config, connections, router }) {
  return Object.fromEntries(CLIENTS.map(id => {
    if (!connections.enabled[id]) return [id, null];
    if (id !== 'pi') {
      const plan = proxyConfig.clients[id];
      if (!plan) return [id, null];
      if (id === 'claude') return [id, { plan, token: plan.localToken || router.clientToken }];
      const native = document(fs.readFileSync(config.file, 'utf8'), 'toml').data;
      const catalogModel = plan.catalog?.models?.find(row => row.slug === native.model);
      const contextWindow = catalogModel?.context_window || catalogModel?.max_context_window || native.model_context_window;
      return [id, { plan, model: native.model, effort: native.model_reasoning_effort,
        contextWindow }];
    }
    const target = require('./native-config.cjs').locations('pi', nativeConfig.manager);
    const entries = nativeConfig.fields.entries.filter(e => e.harness === 'pi' && [target.config, target.auth, target.settings].includes(e.file));
    const files = ['models.json', 'auth.json', 'settings.json'].map(name => ({ name,
      fields: entries.filter(e => path.basename(e.file) === name).map(e => ({ keys: e.path, value: e.after.value })) })).filter(f => f.fields.length);
    return [id, files.length ? { files } : null];
  }));
}
class WslSync {
  constructor({ dataDir, crypto, sources, port, executable = process.execPath, onChange = () => {}, run }) {
    Object.assign(this, { dataDir, crypto, sources, port, executable, onChange });
    this.file = path.join(dataDir, 'wsl-sync.enc.json');
    this.helper = fs.readFileSync(path.join(__dirname, 'wsl-agent.py'), 'utf8');
    this.run = run || this.execute.bind(this);
    this.state = { version: 1, distro: '', enabled: {}, records: {} };
    this.status = {}; this.distros = []; this.busy = false; this.lastFingerprint = ''; this.nextCheck = 0;
    try {
      if (fs.existsSync(this.file)) this.state = JSON.parse(crypto.decryptString(Buffer.from(JSON.parse(fs.readFileSync(this.file)).data, 'base64')));
      if (this.state.version !== 1 || !this.state.enabled || !this.state.records) throw Error('WSL 同步记录格式无效');
    } catch (error) { this.error = 'WSL 同步记录无法读取：' + error.message; }
  }
  save() {
    if (this.error) throw Error(this.error);
    if (!this.crypto.isEncryptionAvailable()) throw Error('系统加密不可用，未保存 WSL 接入凭据');
    atomic(this.file, JSON.stringify({ data: this.crypto.encryptString(JSON.stringify(this.state)).toString('base64') }));
  }
  execute(distro, input) {
    return new Promise((resolve, reject) => {
      const child = execFile('wsl.exe', ['-d', distro, '--', 'python3', '-c', this.helper],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 ** 2, encoding: 'utf8' }, (error, stdout) => {
          let result; try { result = JSON.parse(stdout); } catch { return reject(Error('WSL 调用失败，请确认 Ubuntu 和 Python 3 可用')); }
          if (error || !result.ok) reject(Error(result.error || 'WSL 同步失败'));
          else resolve(result.value);
        });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
    });
  }
  async detect(runningOnly = false) {
    const args = ['--list', ...(runningOnly ? ['--running'] : []), '--quiet'];
    const stdout = await new Promise((resolve, reject) => execFile('wsl.exe', args,
      { windowsHide: true, encoding: 'buffer', timeout: 5000 }, (error, data) => {
        if (!error || runningOnly) resolve(error ? Buffer.alloc(0) : data);
        else reject(Error('未检测到 WSL'));
      }));
    const distros = stdout.toString('utf16le').replaceAll('\0', '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const previous = this.public();
    this.distros = runningOnly ? [...new Set([...this.distros, ...distros])] : distros;
    const distro = this.state.distro ||= distros[0] || '';
    const info = distros.includes(distro) ? await this.run(distro, { action: 'inspect' }) : undefined;
    if (distro === this.state.distro) this.info = info;
    const state = this.public();
    if (!equal(previous, state)) this.onChange();
    return state;
  }
  enabled(id) { return this.state.enabled[id] ?? !!this.info?.binaries[id]; }
  public() {
    return { distro: this.state.distro, distros: this.distros, busy: this.busy, error: this.error || '',
      clients: Object.fromEntries(CLIENTS.map(id => [id, { enabled: this.enabled(id),
        excludedProviders: this.state.excludedProviders?.[id] || [],
        configured: !!this.state.records[id]?.length, binary: this.info?.binaries[id] || '', ...this.status[id] }])) };
  }
  async recover() {
    const pending = this.state.pending;
    if (!pending) return;
    const actual = await this.run(this.state.distro, { action: 'read', files: pending.files.map(f => f.file) });
    if (pending.files.every(f => actual[f.file] === f.after)) this.state.records[pending.id] = pending.records;
    else {
      if (pending.files.some(f => actual[f.file] !== f.after && actual[f.file] !== f.before)) throw Error('WSL 待恢复配置已被外部修改');
      await this.run(this.state.distro, { action: 'write', files: pending.files.filter(f => actual[f.file] !== f.before)
        .map(f => ({ file: f.file, beforeHash: hash(actual[f.file]), after: f.before })) });
    }
    delete this.state.pending; this.save();
  }
  async bridge(port = this.port) {
    const relay = path.join(this.dataDir, 'wsl-relay.cjs');
    atomic(relay, fs.readFileSync(path.join(__dirname, 'wsl-socket.cjs'), 'utf8'));
    const executable = await new Promise((resolve, reject) => execFile('wsl.exe', ['-d', this.state.distro, '--', 'wslpath', '-u', this.executable.replaceAll('\\', '/')],
      { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(Error('Windows 启动路径转换失败')) : resolve(stdout.trim())));
    const state = await this.run(this.state.distro, { action: 'bridge', source: this.helper,
      config: { executable, script: relay, port } });
    await this.run(this.state.distro, { action: 'probe', port: state.port });
    return 'http://127.0.0.1:' + state.port;
  }
  async piSource(source) {
    const result = structuredClone(source), routes = new Map();
    for (const row of result.files.filter(row => row.name === 'models.json')) for (const field of row.fields) {
      const value = field.value;
      if (!value?.baseUrl) continue;
      const url = new URL(value.baseUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) continue;
      if (url.protocol !== 'http:') throw Error('WSL 的本机 HTTPS 供应商需使用 Linux 可访问的地址');
      const port = Number(url.port || 80);
      if (!routes.has(port)) routes.set(port, await this.bridge(port));
      value.baseUrl = routes.get(port) + url.pathname + url.search;
    }
    return result;
  }
  async configure(id, { enabled, providerId, distro = this.state.distro || 'Ubuntu' } = {}) {
    if (!CLIENTS.includes(id) || (enabled !== undefined && typeof enabled !== 'boolean') ||
        (providerId !== undefined && (typeof providerId !== 'string' || !providerId || typeof enabled !== 'boolean')) ||
        !/^[\w .-]{1,100}$/.test(distro)) throw Error('WSL 同步设置无效');
    if (this.busy) throw Error('WSL 正在同步');
    if (distro !== this.state.distro && Object.values(this.state.records).some(r => r?.length)) throw Error('请先撤回原发行版的同步');
    const changedDistro = distro !== this.state.distro;
    this.state.distro = distro;
    if (providerId !== undefined) {
      const exclusions = this.state.excludedProviders ||= {};
      const next = new Set(exclusions[id]);
      if (enabled) next.delete(providerId); else next.add(providerId);
      exclusions[id] = [...next];
    } else if (enabled !== undefined) this.state.enabled[id] = enabled;
    this.save();
    if (changedDistro) {
      this.info = undefined; this.status = {};
      await this.detect();
    }
    await this.sync(changedDistro && enabled === undefined ? undefined : [id]);
    return this.public();
  }
  async sync(ids = CLIENTS.filter(id => this.enabled(id) || this.state.records[id]?.length), info) {
    if (this.busy || !ids.length) return;
    this.busy = true; this.onChange();
    try {
      await this.recover();
      this.info = info || await this.run(this.state.distro, { action: 'inspect' });
      const sources = this.sources();
      let base = '';
      for (const id of ids) {
        try {
          const enabled = this.enabled(id);
          if (enabled && !this.info.binaries[id]) throw Error('未检测到此客户端的 WSL 命令');
          let source = enabled ? filterProviders(id, sources[id], this.state.excludedProviders?.[id]) : null;
          if (id === 'pi' && source) source = await this.piSource(source);
          if (id !== 'pi' && source) base ||= await this.bridge();
          const desired = source ? projection(id, source, this.info, base) : [];
          const previous = this.state.records[id] || [];
          const names = [...new Set([...desired, ...previous].map(f => f.file))];
          if (names.length) {
            const contents = await this.run(this.state.distro, { action: 'read', files: names });
            const plan = planFiles(desired, previous, contents);
            if (plan.files.length) {
              this.state.pending = { id, ...plan }; this.save();
              await this.run(this.state.distro, { action: 'write', files: plan.files });
            }
            if (plan.files.length || !equal(previous, plan.records)) {
              this.state.records[id] = plan.records; delete this.state.pending; this.save();
            }
          }
          this.status[id] = { status: source ? '已同步' : !enabled ? '已撤回' : sources[id] ? '没有供应商同步到 WSL' : '等待 Windows 接入',
            lastSync: new Date().toISOString(), error: '', route: source ? (id === 'pi' ? '供应商直连' : base) : '' };
        } catch (error) { this.status[id] = { ...this.status[id], error: error.message }; if (this.state.pending) break; }
      }
      this.lastFingerprint = hash(JSON.stringify(sources));
    } catch (error) { for (const id of ids) this.status[id] = { ...this.status[id], error: error.message }; }
    finally { this.nextCheck = Date.now() + 30000; this.busy = false; this.onChange(); }
  }
  start() {
    if (this.error) return;
    let checking = false;
    const check = async () => {
      if (this.busy || checking) return;
      checking = true;
      try {
        const due = Date.now() >= this.nextCheck;
        if (due) {
          this.nextCheck = Date.now() + 30000;
          await this.detect(true);
        }
        if (this.info && (due || hash(JSON.stringify(this.sources())) !== this.lastFingerprint)) await this.sync(undefined, this.info);
      } catch (error) {
        for (const id of CLIENTS) this.status[id] = { ...this.status[id], error: error.message };
        this.onChange();
      } finally {
        checking = false;
      }
    };
    this.timer = setInterval(check, 5000); this.timer.unref();
    void check();
  }
  stop() { clearInterval(this.timer); }
}
module.exports = { WslSync, windowsSources, projection, planFiles };
