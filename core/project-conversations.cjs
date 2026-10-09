const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { atomic, safePath } = require('./native-fields.cjs');
const { HARNESSES } = require('./project-codecs.cjs');
class ProjectConversations {
  constructor({ dataDir, crypto: encryption, sources, history, releaseImports, assertIdle, assertDeletionIdle, now = Date.now }) {
    this.vault = path.join(dataDir, 'project-conversations'); this.file = path.join(this.vault, 'index.enc.json');
    this.encryption = encryption; this.sources = sources; this.history = history; this.releaseImports = releaseImports; this.assertIdle = assertIdle;
    this.assertDeletionIdle = assertDeletionIdle;
    this.now = now; this.queue = Promise.resolve(); this.candidates = []; this.recordsCache = [];
    this.state = { version: 1, secret: '', projects: [], observed: {} }; this.error = ''; this.job = null;
    try { safePath(this.file); const raw = fs.existsSync(this.file) ? (() => {
      if (fs.statSync(this.file).size > 64 * 1024 ** 2) throw Error(); return fs.readFileSync(this.file, 'utf8');
    })() : null; if (raw) {
      const state = JSON.parse(encryption.decryptString(Buffer.from(JSON.parse(raw).encrypted, 'base64')));
      if (state.version !== 1 || !Array.isArray(state.projects) || Buffer.from(state.secret || '', 'base64').length !== 32) throw Error();
      this.state = { observed: {}, ...state };
      for (const entry of this.state.trash || []) {
        Object.assign(entry, require('./conversation-trash.cjs').status(this.vault, entry));
        if (entry.phase === 'restored') {
          const restored = new Set(entry.rows.map(row => row.harness + '\0' + row.sessionId));
          this.state.deleted = (this.state.deleted || []).filter(id => !restored.has(id));
        }
      }
      for (const entry of this.state.removals || []) {
        Object.assign(entry, require('./conversation-trash.cjs').status(this.vault, entry));
        this.state.deleted = [...new Set([...(this.state.deleted || []), ...(entry.removed || [])])];
      }
    } } catch { this.error = '项目对话索引无法解密，未覆盖'; }
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  persist() {
    if (this.error) throw Error(this.error);
    if (!this.encryption.isEncryptionAvailable()) throw Error('本机加密不可用，未启用项目同步');
    this.state.secret ||= crypto.randomBytes(32).toString('base64');
    atomic(this.file, JSON.stringify({ encrypted: this.encryption.encryptString(JSON.stringify(this.state)).toString('base64') }));
  }
  async recoverPrepare() {
    if (!this.state.pendingPrepare) return;
    const old = this.state, r = await this.run('prepare-publish'); this.state = r.state;
    try { this.persist(); } catch (e) { this.state = old; throw e; }
    return r;
  }
  run(action, args = {}) {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'project-conversation-worker.cjs'), { workerData: {
        action, vault: this.vault, state: this.state, sources: this.sources(), ...args,
      } }); let done = false;
      const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
      const timer = setTimeout(() => { w.terminate(); finish(Error('项目同步超时，原生历史未覆盖')); }, 120000);
      w.once('message', (r) => finish(r.error ? Error(r.error) : null, r.result));
      w.once('error', () => finish(Error('项目对话读取失败'))); w.once('exit', () => finish(Error('项目同步意外结束')));
    });
  }
  project(id) { const p = this.state.projects.find((p) => p.id === id); if (!p) throw Error('项目不存在，请刷新'); return p; }
  summary(p) { return { id: p.id, cwd: p.cwd, name: p.name, enabled: p.enabled, targets: p.targets, count: p.enabled ? p.threads.length : this.recordsCache.filter((r) => r.projectId === p.id).length,
    branches: p.threads.filter((r) => r.branchOf).length, lastSync: p.lastSync, errors: p.errors || [] }; }
  async list({ scope = 'active' } = {}) {
    if (!['active', 'inactive', 'all'].includes(scope)) throw Error('对话范围无效');
    this.scope = scope;
    return this.serial(async () => {
      await this.recoverPrepare();
      const r = await this.run('discover', { scope, history: await this.history?.() || [] }); this.candidates = r.projects; this.recordsCache = r.records;
      for (const p of this.state.projects) {
        const native = r.projects.find(row => row.id === p.id);
        if (native?.nativeName) p.name = native.nativeName;
      }
      if (!this.error) { this.state.observed = r.observed; this.state.catalog = r.catalog; this.persist(); }
      const map = new Map(r.projects.map((p) => [p.id, { ...p, enabled: false, targets: HARNESSES, lastSync: '', branches: 0 }]));
      for (const p of this.state.projects) if ((p.enabled && scope !== 'inactive') || map.has(p.id)) {
        const native = map.get(p.id); map.set(p.id, { ...native, ...this.summary(p), ...(scope === 'inactive' ? { enabled: false, count: native.count } : {}) });
      }
      return { items: [...map.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
        scope, inactive: r.inactive, retained: Object.fromEntries(HARNESSES.map((h) => [h, r.records.filter((r) => r.harness === h && r.retained).length])), errors: r.errors, error: this.error || this.lastError || '' };
    });
  }
  async configure(id, { enabled, targets = HARNESSES } = {}) {
    if (typeof enabled !== 'boolean' || !Array.isArray(targets) || !targets.length || targets.some((h) => !HARNESSES.includes(h))) throw Error('项目同步选项无效');
    if (id === 'unassigned') throw Error('无项目会话只管理内容，不支持同步');
    if (!enabled && this.state.projects.find((p) => p.id === id)?.enabled) {
      await this.assertIdle?.(id); await this.sync(id);
      return this.serial(async () => {
        await this.assertIdle?.(id);
        const plan = await this.run('release-plan', { projectId: id });
        this.state = plan.state; this.project(id).releasePlan = plan; delete plan.state; this.persist();
        if (plan.imports.length || plan.returns.length) {
          if (!this.releaseImports) throw Error('此项目包含 OpenCode 同步副本，需要可用的 CLI 才能关闭同步');
          await this.releaseImports(plan);
        }
        const r = await this.run('release-commit', { projectId: id, plan }); this.state = r.state;
        delete this.project(id).releasePlan; this.persist(); this.recordsCache = [];
        return { ...this.summary(this.project(id)), removed: r.removed, message: '同步已关闭，已完成内容归回初始客户端；同步副本已移除，可从 ASS 备份恢复。' };
      });
    }
    await this.serial(async () => {
      await this.recoverPrepare();
      let p = this.state.projects.find((p) => p.id === id);
      if (!p) {
        const candidate = this.candidates.find((p) => p.id === id); if (!candidate || !path.isAbsolute(candidate.cwd)) throw Error('请先从记录中选择项目');
        safePath(candidate.cwd); if (!fs.statSync(candidate.cwd).isDirectory()) throw Error('项目目录不存在');
        p = { id, cwd: candidate.cwd, name: candidate.name, enabled: false, targets: [], threads: [], origins: {}, errors: [] }; this.state.projects.push(p);
      }
      const before = { enabled: p.enabled, targets: p.targets }; p.enabled = enabled; p.targets = [...new Set(targets)];
      try { this.persist(); } catch (e) { Object.assign(p, before); throw e; }
    });
    if (enabled) await this.sync(id);
    return this.summary(this.project(id));
  }
  async sync(id) {
    return this.serial(async () => {
      await this.recoverPrepare();
      if (id) this.project(id); if (!this.state.projects.some((p) => p.enabled && (!id || p.id === id))) return { updated: 0 };
      this.persist(); const r = await this.run('sync', { projectId: id });
      const old = this.state; this.state = r.state;
      try { this.persist(); } catch (e) { this.state = old; throw e; }
      const errors = this.state.projects.filter((p) => p.enabled).reduce((n, p) => n + p.errors.length, 0);
      return { updated: r.updated, message: (r.updated ? `已同步 ${r.updated} 条对话更新` : '项目对话已同步') + (errors ? `；${errors} 个来源暂时无法读取` : ''), projects: this.state.projects.map((p) => this.summary(p)) };
    });
  }
  async threads(id, { offset = 0, query = '', cached = false } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || typeof query !== 'string' || query.length > 500 || typeof cached !== 'boolean') throw Error('对话查询无效');
    if (!cached) await this.sync(id); const p = this.project(id);
    const filtered = p.threads.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { ...this.summary(p), total: filtered.length, offset, items: filtered.slice(offset, offset + 40).map((t) => ({ id: t.id, title: t.title, count: t.refs.length, updatedAt: t.updatedAt,
      branchOf: t.branchOf || '', originHarness: t.home?.harness || t.origins[0]?.harness, harnesses: [...new Set(t.origins.map((o) => o.harness))], projections: t.routes.map((r) => ({ harness: r.harness, mode: r.mode })) })) };
  }
  async records(id, { offset = 0, query = '', harness = '', pinned = false } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || typeof query !== 'string' || query.length > 500 || (harness && !HARNESSES.includes(harness))) throw Error('会话查询无效');
    if (!this.recordsCache.length || !this.candidates.some((p) => p.id === id) && !this.state.projects.some((p) => p.id === id)) await this.list();
    const all = this.recordsCache.filter((r) => r.projectId === id && (!harness || r.harness === harness));
    const filtered = all.filter((r) => (!pinned || r.pinned) && `${r.title} ${r.sessionId}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    return { total: filtered.length, offset, items: filtered.slice(offset, offset + 40).map((r) => ({ ...r, kind: 'native' })) };
  }
  search({ query = '', harness, nativeView = false } = {}) {
    if (typeof query !== 'string' || query.length > 500 || !HARNESSES.includes(harness) || typeof nativeView !== 'boolean') throw Error('会话查询无效');
    const term = query.trim().toLowerCase();
    const projects = new Map(this.candidates.map((p) => [p.id, p]));
    for (const p of this.state.projects) if (p.enabled && this.scope !== 'inactive') projects.set(p.id, { ...projects.get(p.id), ...p });
    const native = new Map();
    for (const r of this.recordsCache) if (r.harness === harness) {
      if (!native.has(r.projectId)) native.set(r.projectId, []);
      native.get(r.projectId).push(r);
    }
    const items = [];
    for (const p of projects.values()) {
      const shared = p.enabled && p.targets.includes(harness) && !nativeView;
      if (!shared && !native.has(p.id)) continue;
      const rows = shared ? this.project(p.id).threads : native.get(p.id) || [];
      const projectMatch = `${p.name} ${p.cwd || ''}`.toLowerCase().includes(term);
      const matches = rows.filter((r) => `${r.title} ${r.sessionId || ''}`.toLowerCase().includes(term)).length;
      if (projectMatch || matches) items.push({ id: p.id, projectMatch, matches });
    }
    // Metadata already discovered by list()/sync(); typing never rescans logs,
    // projects or message bodies and does not trigger native synchronization.
    return { query: query.trim(), harness, nativeView, items };
  }
  record(id) { const r = this.recordsCache.find((r) => r.id === id); if (!r) throw Error('会话不存在，请刷新'); return r; }
  trashList({ includeRestored = false } = {}) {
    for (const entry of this.state.trash || []) Object.assign(entry, require('./conversation-trash.cjs').status(this.vault, entry));
    const items = (this.state.trash || []).filter((r) => includeRestored || r.phase !== 'restored').map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, count: r.rows.length, phase: r.phase,
      bytes: require('./conversation-storage.cjs').trashFiles(this.vault, r).reduce((n, f) => n + f.bytes, 0) }));
    return { items, bytes: items.reduce((n, r) => n + r.bytes, 0) };
  }
  async purgeTrash({ id, confirmed } = {}) {
    if (confirmed !== true) throw Error('请确认永久清理删除备份');
    return this.serial(() => {
      const entry = this.state.trash?.find((r) => r.id === id);
      if (!entry || !['deleted', 'restored', 'purging'].includes(entry.phase)) throw Error('删除尚未完成，保留恢复备份');
      const plans = require('./conversation-storage.cjs').trashFiles(this.vault, entry);
      if (entry.phase !== 'restored') this.state.deleted = [...new Set([...(this.state.deleted || []), ...entry.rows.map(r => r.harness + '\0' + r.sessionId)])];
      const phase = entry.phase; entry.phase = 'purging';
      try { this.persist(); } catch (e) { entry.phase = phase; throw e; }
      let bytes = 0;
      for (const item of plans) if (fs.existsSync(item.file)) {
        safePath(item.file); const stat = fs.lstatSync(item.file);
        if (!stat.isFile() || require('./conversation-files.cjs').signature(stat) !== item.stamp) throw Error('删除备份已变化，请刷新后重试清理');
        fs.unlinkSync(item.file); bytes += item.bytes;
      }
      for (const dir of [path.join(this.vault, 'trash', id, 'records'), path.join(this.vault, 'trash', id)]) {
        safePath(dir); try { fs.rmdirSync(dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; }
      }
      this.state.trash = this.state.trash.filter(r => r.id !== id); this.persist(); this.recordsCache = [];
      return { bytes, message: '删除备份已永久清理。' };
    });
  }
  async remove({ projectId, recordId, threadId, confirmed } = {}) {
    if (confirmed !== true) throw Error('请确认删除本地记录');
    if (!projectId || (recordId && threadId)) throw Error('删除选项无效');
    const active = this.state.projects.find((p) => p.id === projectId && p.enabled);
    if (active) throw Error('请先关闭项目同步，再删除原生对话');
    await this.list({ scope: this.scope || 'active' });
    const selected = this.recordsCache.filter((r) => r.nativePresent && r.projectId === projectId && (!recordId || r.id === recordId));
    if (threadId) throw Error('请先关闭项目同步，再删除原生对话');
    if (!selected.length) throw Error('没有可删除的原生对话；保留副本请在“历史与存储”中清理');
    const initialGuard = await this.assertDeletionIdle?.(selected, undefined, { allowArchivedCodex: true });
    return this.serial(async () => {
      this.persist();
      const label = recordId ? selected[0].title : this.candidates.find((p) => p.id === projectId)?.name || '项目对话';
      const entry = await this.run('trash-plan', { rows: selected, label, backup: false });
      // Only identity/phase metadata survives restart, never transcript content,
      // native DB row snapshots or a new restorable trash entry.
      const removal = { id: entry.id, recoverable: false, phase: 'prepared', rows: entry.rows.map(({ harness, sessionId }) => ({ harness, sessionId })) };
      (this.state.removals ||= []).push(removal); this.persist();
      const finalGuard = await this.assertDeletionIdle?.(selected, undefined, { allowArchivedCodex: true });
      let updated;
      try {
        if (entry.imports.length) {
          if (!this.releaseImports) throw Error('OpenCode CLI 不可用，未删除');
          await this.releaseImports({ imports: entry.imports, returns: [] });
        }
        updated = await this.run('trash-commit', { entry, liveCodex: !!(initialGuard?.liveCodex || finalGuard?.liveCodex) });
      } catch (error) {
        let saved = require('./conversation-trash.cjs').status(this.vault, entry);
        // Includes partially completed native OpenCode CLI deletion.
        try { saved = await this.run('delete-failed', { entry }); } catch {}
        removal.phase = saved.phase; removal.removed = saved.removed || [];
        this.state.deleted = [...new Set([...(this.state.deleted || []), ...removal.removed])]; this.recordsCache = []; this.persist(); throw error;
      }
      removal.phase = updated.phase; removal.removed = updated.removed || [];
      this.recordsCache = []; this.state.deleted = [...new Set([...(this.state.deleted || []), ...entry.rows.map(r => r.harness + '\0' + r.sessionId)])]; this.persist();
      return { id: entry.id, message: `已删除 ${entry.rows.length} 个本地对话，未保存备份。` };
    });
  }
  async restoreTrash(id) {
    const entry = this.state.trash?.find((r) => r.id === id && r.phase !== 'restored');
    if (!entry) throw Error('备份不存在');
    await this.assertDeletionIdle?.(entry.rows);
    return this.serial(async () => {
      if (entry.imports.length) {
        if (!this.releaseImports) throw Error('OpenCode CLI 不可用，未恢复');
        const returns = [];
        try {
          for (const item of entry.imports) {
            const bundle = require('./conversation-trash.cjs').importBundle(this.vault, this.state.secret, entry, item);
            try { const current = require('./project-codecs.cjs').openCodeBundle(item.file, item.sessionId);
              if (!require('./opencode-version.cjs').equal(current, bundle)) throw Error('OpenCode 已有同 ID 的记录，未覆盖'); continue;
            } catch (e) { if (!/会话不存在/.test(e.message)) throw e; }
            const file = path.join(this.vault, 'trash', entry.id, item.sessionId + '.restore.json');
            atomic(file, JSON.stringify(bundle)); returns.push({ ...item, file, signature: undefined });
          }
          await this.releaseImports({ returns, imports: [] });
        } finally { for (const item of returns) if (fs.existsSync(item.file)) fs.unlinkSync(item.file); }
      }
      let updated;
      try { updated = await this.run('trash-restore', { entry }); }
      catch (error) { Object.assign(entry, require('./conversation-trash.cjs').status(this.vault, entry)); this.persist(); throw error; }
      Object.assign(entry, updated);
      const keys = new Set(entry.rows.map(r => r.harness + '\0' + r.sessionId));
      this.state.deleted = (this.state.deleted || []).filter(key => !keys.has(key));
      // An explicit restoration of an existing old backup overrides later
      // permanent-delete markers. Its old metadata journal must not hide the
      // newly restored native record on the next restart.
      for (const removal of this.state.removals || []) {
        removal.rows = removal.rows.filter(row => !keys.has(row.harness + '\0' + row.sessionId));
        removal.removed = (removal.removed || []).filter(key => !keys.has(key));
      }
      this.persist();
      return { message: '本地对话已恢复，项目文件未改动。' };
    });
  }
  async nativePreview(id, before = 0) {
    if (!Number.isInteger(before) || before < 0) throw Error('会话页码无效');
    return this.run('native-preview', { row: this.record(id), before });
  }
  async preview(projectId, threadId, before = 0) {
    if (!Number.isInteger(before) || before < 0) throw Error('对话页码无效');
    return this.serial(() => this.run('preview', { projectId, threadId, before }));
  }
  async prepare(projectId, threadId, harness, dir, nativeVersion = 1) {
    if (!HARNESSES.includes(harness) || !path.isAbsolute(dir)) throw Error('客户端目录无效');
    await this.sync(projectId);
    return this.serial(async () => {
      const p = this.project(projectId); if (!p.enabled || !p.targets.includes(harness)) throw Error('请先启用此项目与客户端的同步');
      this.persist(); const plan = await this.run('prepare-plan', { projectId, threadId, harness, dir, nativeVersion });
      let r;
      if (plan.existing) {
        const old = this.state; this.state = plan.state;
        try { this.persist(); } catch (e) { this.state = old; throw e; }
        r = plan;
      } else {
        this.state.pendingPrepare = plan.intent;
        try { this.persist(); } catch (e) { delete this.state.pendingPrepare; throw e; }
        r = await this.recoverPrepare();
      }
      const { state, existing, ...result } = r; return result;
    });
  }
  start() {
    this.timer = setInterval(() => {
      if (this.job || !this.state.projects.some((p) => p.enabled)) return;
      this.job = this.sync().catch((e) => { this.lastError = e.message; }).finally(() => { this.job = null; });
    }, 15000); this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
}
module.exports = { ProjectConversations };
