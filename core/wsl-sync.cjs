const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const TOML = require('@iarna/toml');
const { atomic } = require('./config.cjs');
const { document, edit, hash } = require('./native-fields.cjs');
const { claudeModelSettings, claudeModelEnv } = require('./accountless.cjs');
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
  if (format !== 'toml') return edit(text, 'json', keys, value);
  const data = document(text, 'toml').data;
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
      for (const field of old?.fields || []) if (!equal(fieldAt(data, field.keys), field.after))
        throw Error('WSL 受管配置被外部修改：' + field.keys.join('.'));
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
      model_context_window: source.contextWindow, model_auto_compact_token_limit: source.compactLimit,
      model_provider: 'openai', cli_auth_credentials_store: 'file', openai_base_url: base + '/clients/ASS/v1', model_catalog_json: file('ass-models.json') }, 'toml'),
      fields('auth.json', { auth_mode: 'apikey', OPENAI_API_KEY: source.plan.localToken, tokens: undefined }),
      { file: file('ass-models.json'), format: 'raw', text: JSON.stringify(source.plan.catalog, null, 2) }];
  }
  if (id === 'claude') {
    const selected = source.plan.defaultModel?.model;
    if (!selected) throw Error('请先同步 Windows Claude Code 接入');
    const settings = claudeModelSettings(source.plan.providers, selected);
    const env = { ...claudeModelEnv(source.plan.providers, selected, source.plan.autoModeModel),
      ANTHROPIC_BASE_URL: base + '/clients/claude/models', ANTHROPIC_AUTH_TOKEN: source.token,
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    return [{ ...fields('settings.json', settings), fields: [
      ...Object.entries(settings).map(([key, value]) => ({ keys: [key], value })),
      ...Object.entries(env).map(([key, value]) => ({ keys: ['env', key], value })),
    ] }];
  }
  return source.files.map(row => ({ file: file(row.name), format: 'json', fields: row.fields }));
}
function windowsSources({ proxyConfig, nativeConfig, config, connections, router }) {
  return Object.fromEntries(CLIENTS.map(id => {
    if (!connections.enabled[id]) return [id, null];
    if (id !== 'pi') {
      const plan = proxyConfig.clients[id];
      if (!plan) return [id, null];
      if (id === 'claude') return [id, { plan, token: plan.localToken || router.clientToken }];
      const native = document(fs.readFileSync(config.file, 'utf8'), 'toml').data;
      return [id, { plan, model: native.model, effort: native.model_reasoning_effort,
        contextWindow: native.model_context_window, compactLimit: native.model_auto_compact_token_limit }];
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
    this.state = { version: 1, distro: 'Ubuntu', enabled: {}, records: {} };
    this.status = {}; this.distros = []; this.busy = false; this.lastFingerprint = '';
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
  async detect() {
    const stdout = await new Promise((resolve, reject) => execFile('wsl.exe', ['--list', '--quiet'],
      { windowsHide: true, encoding: 'buffer', timeout: 5000 }, (error, data) => error ? reject(Error('未检测到 WSL')) : resolve(data)));
    this.distros = stdout.toString('utf16le').replaceAll('\0', '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (this.distros.includes(this.state.distro)) this.info = await this.run(this.state.distro, { action: 'inspect' });
    this.onChange(); return this.public();
  }
  public() {
    return { distro: this.state.distro, distros: this.distros, busy: this.busy, error: this.error || '',
      clients: Object.fromEntries(CLIENTS.map(id => [id, { enabled: !!this.state.enabled[id],
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
  async configure(id, { enabled, distro = this.state.distro } = {}) {
    if (!CLIENTS.includes(id) || typeof enabled !== 'boolean' || !/^[\w .-]{1,100}$/.test(distro)) throw Error('WSL 同步设置无效');
    if (this.busy) throw Error('WSL 正在同步');
    if (distro !== this.state.distro && Object.values(this.state.records).some(r => r?.length)) throw Error('请先撤回原发行版的同步');
    this.state.distro = distro; this.state.enabled[id] = enabled; this.save();
    await this.sync([id]); return this.public();
  }
  async sync(ids = CLIENTS.filter(id => this.state.enabled[id] || this.state.records[id]?.length)) {
    if (this.busy || !ids.length) return;
    this.busy = true; this.onChange();
    try {
      await this.recover();
      this.info = await this.run(this.state.distro, { action: 'inspect' });
      const sources = this.sources(), base = ids.some(id => this.state.enabled[id] && sources[id] && id !== 'pi') ? await this.bridge() : '';
      for (const id of ids) {
        try {
          let source = this.state.enabled[id] ? sources[id] : null;
          if (id === 'pi' && source) source = await this.piSource(source);
          const desired = source ? projection(id, source, this.info, base) : [];
          const previous = this.state.records[id] || [];
          const names = [...new Set([...desired, ...previous].map(f => f.file))];
          const contents = names.length ? await this.run(this.state.distro, { action: 'read', files: names }) : {};
          const plan = planFiles(desired, previous, contents);
          this.state.pending = { id, ...plan }; this.save();
          if (plan.files.length) await this.run(this.state.distro, { action: 'write', files: plan.files });
          this.state.records[id] = plan.records; delete this.state.pending; this.save();
          this.status[id] = { status: source ? '已同步' : this.state.enabled[id] ? '等待 Windows 接入' : '已撤回',
            lastSync: new Date().toISOString(), error: '', route: id === 'pi' ? '供应商直连' : base };
        } catch (error) { this.status[id] = { ...this.status[id], error: error.message }; if (this.state.pending) break; }
      }
      this.lastFingerprint = hash(JSON.stringify(this.sources()));
    } catch (error) { for (const id of ids) this.status[id] = { ...this.status[id], error: error.message }; }
    finally { this.nextCheck = Date.now() + 30000; this.busy = false; this.onChange(); }
  }
  start() {
    if (this.error) return;
    this.timer = setInterval(() => {
      if (Object.values(this.state.enabled).some(Boolean) && !this.busy) {
        try { if (Date.now() >= this.nextCheck || hash(JSON.stringify(this.sources())) !== this.lastFingerprint) void this.sync(); }
        catch (error) { for (const id of CLIENTS) this.status[id] = { ...this.status[id], error: error.message }; this.onChange(); }
      }
    }, 5000); this.timer.unref();
    if (Object.values(this.state.enabled).some(Boolean)) void this.sync();
  }
  stop() { clearInterval(this.timer); }
}
module.exports = { WslSync, windowsSources, projection, planFiles };
