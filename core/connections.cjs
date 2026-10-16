const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomic, prepareConfig } = require("./config.cjs");
const { IDS: LEGACY_IDS, hash } = require("./injection-files.cjs");
// New native clients do not belong to the legacy proxy-file allowlist.
const IDS = [...LEGACY_IDS, "kimi", "zcode"];
const NAMES = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "pi",
  dsh: "DeepSeek Harness",
  kimi: "Kimi Code",
  zcode: "ZCode",
};
class Connections {
  constructor({
    dataDir,
    router,
    config,
    injections,
    processes,
    nativeConfig,
    proxyConfig,
    port = 25819,
    writeCatalog = () => {},
    onChange = () => {},
    extraActive = () => 0,
    restarter,
    sessionHandoff,
  }) {
    Object.assign(this, {
      router,
      config,
      injections,
      processes,
      nativeConfig,
      proxyConfig,
      port,
      writeCatalog,
      onChange,
      extraActive,
      restarter,
      sessionHandoff,
    });
    this.file = path.join(dataDir, "connections.json");
    this.enabled = Object.fromEntries(
      IDS.map((id) => [
        id,
        (id === "codex" && !!config.status().managed) ||
          injections.entries.some((e) => e.harness === id) ||
          (nativeConfig?.list([id]).length || 0) > 0,
      ]),
    );
    this.busy = false;
    this.blocked = new Set();
    this.tickets = new Map();
    this.revision = 0;
    this.error = "";
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 8192) throw Error();
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (LEGACY_IDS.some((id) => typeof saved[id] !== "boolean") ||
            ["kimi", "zcode"].some((id) => saved[id] !== undefined && typeof saved[id] !== "boolean")) throw Error();
        this.enabled = Object.fromEntries(IDS.map((id) => [id, saved[id] ?? false]));
        // A crashed shutdown must not hide a still-injected Codex config.
        if (config.status().managed) this.enabled.codex = true;
        for (const id of IDS)
          if (nativeConfig?.list([id]).length) this.enabled[id] = true;
      } else atomic(this.file, JSON.stringify(this.enabled));
    } catch {
      this.error = "接入状态文件损坏，请先检查数据目录；没有自动覆盖";
    }
  }
  allow(id) {
    if (this.blocked.has(id) || this.error) return false;
    if (id === "diagnostics") return true;
    return IDS.includes(id) && this.enabled[id];
  }
  needsRouter(id) {
    return (
      !this.nativeConfig?.isDirect(id) ||
      this.injections.entries.some((e) => e.harness === id) ||
      this.processes
        .snapshot()
        .sessions.some(
          (s) =>
            s.harness === id && s.status !== "gone" && s.transport !== "native",
        )
    );
  }
  routerEnabled(excluding = []) {
    return IDS.some(
      (id) =>
        !excluding.includes(id) && this.enabled[id] && this.needsRouter(id),
    );
  }
  exitStatus() {
    const sessions = this.processes.snapshot().sessions;
    const ids = IDS.filter(id => this.needsRouter(id) && (
      this.enabled[id] || this.proxyConfig?.clients[id] ||
      (id === "codex" && this.config.status().managed) ||
      this.injections.entries.some(e => e.harness === id) ||
      sessions.some(s => s.harness === id && s.status !== "gone" && s.transport !== "native")
    ));
    const safeNeeded = ids.length > 0 || !!this.error || !!this.injections.error;
    const active = this.router.clientActive() + this.extraActive();
    return { safeNeeded, names: ids.map(id => NAMES[id]), active,
      canDirectExit: !safeNeeded && active === 0 && !this.busy };
  }
  directExit(acknowledged, quit) {
    if (acknowledged !== true) throw Error("请先确认直接退出");
    // Do not quit halfway through an injection transaction. Active requests,
    // config drift and unavailable process inspection do not block this path.
    if (this.busy) throw Error("接入配置正在写入，请稍后再退出");
    quit();
    return { ok: true, quit: true, preserved: true };
  }
  snapshot() {
    return {
      busy: this.busy,
      error: this.error || this.injections.error,
      clients: Object.fromEntries(
        IDS.map((id) => {
          const native = this.proxyConfig?.supports(id)
            ? this.proxyConfig.status(id, this.enabled[id])
            : this.nativeConfig?.status(id, this.enabled[id]) || {};
          return [
            id,
            {
              enabled: this.enabled[id],
              active: this.router.clientActive(id),
              files:
                this.injections.entries.filter((e) => e.harness === id).length +
                (native.files?.length || 0),
              mode: native.mode || "proxy",
              syncError: native.error || "",
              pending: native.pending || false,
              modelCount: native.modelCount,
              applied: native.applied,
              runtimeStatus: native.runtimeStatus,
              accountless: this.proxyConfig?.clients[id]?.accountless === true,
              ...(id === 'codex' && this.sessionHandoff ? { resumeRecovery: this.sessionHandoff.status() } : {}),
              accountlessAvailable: ["codex", "claude"].includes(id) && this.enabled[id] && native.applied === true && native.modelCount > 0,
              configAttached:
                id === "codex" ? this.config.status().attached : undefined,
            },
          ];
        }),
      ),
      processes: this.processes.snapshot(),
    };
  }
  ids(scope) {
    if (scope === "all") return IDS;
    if (!IDS.includes(scope)) throw Error("未知客户端接入");
    return [scope];
  }
  fingerprint(ids, enabled = false, quit = false, includeSessions = true) {
    return hash(
      JSON.stringify([
        this.enabled,
        this.revision,
        this.injections.fingerprint(ids),
        quit ? null : this.nativeConfig?.fingerprint(ids, enabled),
        this.proxyConfig?.fingerprint(ids, enabled),
        ids.includes("codex") && fs.existsSync(this.config.file)
          ? hash(fs.readFileSync(this.config.file))
          : null,
        includeSessions ? this.processes
          .snapshot()
          .sessions.filter((s) => ids.includes(s.harness))
          .map((s) => s.id)
          .sort() : null,
      ]),
    );
  }
  preflight(ids, enabled, quit = false, accountless) {
    if (this.error) throw Error(this.error);
    this.injections.preflight(ids);
    if (!quit) this.nativeConfig?.preflight(ids, enabled);
    this.proxyConfig?.preflight(ids, enabled, accountless);
    if (ids.includes("codex")) {
      if (!enabled) this.config.preflightDetach();
      else if (!this.config.status().attached) {
        const text = fs.existsSync(this.config.file)
          ? fs.readFileSync(this.config.file, "utf8")
          : "";
        if (text.includes("# >>> ass managed start"))
          throw Error("Codex 存在不完整的接入配置，请先断开并恢复");
        prepareConfig(text, this.config.catalog, this.config.baseUrl);
      }
    }
  }
  async preview(scope, enabled, quit = false, accountless) {
    if (accountless !== undefined) {
      if (typeof accountless !== "boolean" || !["codex", "claude"].includes(scope) || !enabled || quit || !this.enabled[scope])
        throw Error("请先开启并同步此客户端的模型接入");
      if (accountless) {
        this.proxyConfig.requireApplied(scope);
        if (!this.proxyConfig.clients[scope]?.providers.some((p) => p.models.length)) throw Error("请先注入至少一个模型");
      }
    }
    if (
      typeof enabled !== "boolean" ||
      (scope === "all" && enabled) ||
      (quit && scope !== "all")
    )
      throw Error("无效接入操作");
    if (this.busy) throw Error("正在切换或启动客户端，请稍后重试");
    await this.processes.refresh();
    const ids = this.ids(scope).filter((id) => !quit || this.needsRouter(id));
    this.preflight(ids, enabled, quit, accountless);
    const restart = !quit && this.restarter ? await this.restarter.preview(ids) : null;
    const snapshot = this.processes.snapshot();
    const ticket = crypto.randomBytes(24).toString("hex");
    for (const [key, p] of this.tickets)
      if (p.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size > 20) this.tickets.clear();
    this.tickets.set(ticket, {
      scope,
      ids,
      enabled,
      quit,
      fingerprint: this.fingerprint(ids, enabled, quit),
      expires: Date.now() + 180000,
      restart,
      accountless,
    });
    return {
      ticket,
      ...(!enabled && ids.includes('codex') && this.sessionHandoff ? { restoreSessions: this.sessionHandoff.status().count } : {}),
      accountless,
      restart: this.restarter?.public(restart),
      scope,
      enabled,
      quit,
      retainedNative: quit
        ? IDS.filter(
            (id) => this.enabled[id] && this.nativeConfig?.isDirect(id),
          ).map((id) => NAMES[id])
        : [],
      names: ids.map((id) => NAMES[id]),
      active:
        scope === "all"
          ? this.router.clientActive()
          : this.router.clientActive(scope),
      sessions: snapshot.sessions.filter(
        (s) =>
          ids.includes(s.harness) &&
          s.status !== "gone" &&
          (!quit || s.transport !== "native"),
      ),
      processError: snapshot.error,
      files: [
        ...this.injections.list(ids).map((e) => e.relative),
        ...(this.nativeConfig?.list(ids) || []),
      ],
      native: ids.some((id) => this.nativeConfig?.isDirect(id)),
      codexConfig: ids.includes("codex") ? this.config.file : "",
      stopService: !enabled && !this.routerEnabled(ids),
      retained: IDS.filter((id) => !ids.includes(id) && this.enabled[id]).map(
        (id) => NAMES[id],
      ),
    };
  }
  async apply({ ticket, mode, acknowledged, restart = false, close = false } = {}) {
    const plan = this.tickets.get(ticket);
    if (!plan || plan.expires < Date.now())
      throw Error("确认已过期，请重新打开接入菜单");
    if (plan.kind === "repair") throw Error("请使用一键修复操作");
    if (this.busy) throw Error("已有接入操作正在执行");
    if (acknowledged !== true || !["safe", "terminate"].includes(mode))
      throw Error("请先阅读影响范围并确认");
    if (plan.enabled && mode !== "safe")
      throw Error("开启接入不允许终止客户端");
    if (typeof restart !== "boolean" || (restart && (plan.quit || !plan.restart?.available || !this.restarter)))
      throw Error("此操作没有已确认的重启目标");
    if (typeof close !== "boolean" || restart && close || (close && (plan.quit || plan.scope === "all" || !plan.restart?.closeAvailable || !this.restarter)))
      throw Error("此操作没有已确认的关闭目标");
    this.tickets.delete(ticket);
    this.busy = true;
    const restartFirst = (restart && ["codex", "claude"].includes(plan.scope)) || close;
    const stopName = plan.scope === "codex" ? "Codex" : NAMES[plan.scope];
    let desktopStopped = false;
    let restoredSessions = 0;
    try {
      await this.processes.refresh();
      if (
        this.fingerprint(plan.ids, plan.enabled, plan.quit) !== plan.fingerprint
      )
        throw Error("配置或窗口清单已变化，请重新预览后确认");
      this.preflight(plan.ids, plan.enabled, plan.quit, plan.accountless);
      if (restart) await this.restarter.validate(plan.restart);
      if (restartFirst) {
        this.blocked.add(plan.scope);
        const stopService = !plan.enabled && !this.routerEnabled(plan.ids);
        if (stopService) {
          this.blocked.add("diagnostics");
          if (this.router.clientActive() - this.router.clientActive(plan.scope) + this.extraActive())
            throw Error(`其他客户端或连接诊断仍有请求正在进行，未关闭 ${stopName}；请稍后重试`);
        }
        const observed = this.processes.snapshot();
        if (observed.error || observed.sessions.some((s) => s.harness === plan.scope && !["running", "gone"].includes(s.status)))
          throw Error(`部分 ${stopName} 窗口身份无法确认，请手动关闭并刷新后再操作`);
        if (!close && !plan.enabled && mode === "safe" && observed.sessions.some((s) => s.harness === plan.scope && s.status === "running"))
          throw Error("仍有 ASS 启动的客户端窗口；请先自行退出，或明确选择结束这些窗口");
        const before = this.fingerprint(plan.ids, plan.enabled, plan.quit, false);
        await this.restarter[close ? "close" : "stop"](plan.restart);
        desktopStopped = true;
        await this.router.cancelClient(plan.scope);
        await this.processes.refresh();
        if (this.fingerprint(plan.ids, plan.enabled, plan.quit, false) !== before)
          throw Error("关闭期间配置已变化，请重新预览后确认");
        this.preflight(plan.ids, plan.enabled, plan.quit, plan.accountless);
      }
      if (plan.enabled) {
        // Model/routing changes affect later requests of the same task too.
        // A confirmed force restart has already closed the desktop and drained
        // only its requests. Otherwise uploads/in-flight responses block writes.
        for (const id of plan.ids) this.blocked.add(id);
        if (plan.ids.some((id) => this.router.clientActive(id)))
          throw Error("仍有请求正在进行，未同步；请等待任务结束后重新确认");
        for (const id of plan.ids) this.nativeConfig?.sync(id);
        if (plan.ids.some((id) => this.needsRouter(id)))
          await this.router.start(this.port);
        for (const id of plan.ids) this.proxyConfig?.sync(id, plan.accountless);
        if (plan.ids.includes("codex") && !this.proxyConfig) {
          this.writeCatalog();
          this.config.attach();
        }
        for (const id of plan.ids) this.enabled[id] = true;
      } else {
        const stopService = !this.routerEnabled(plan.ids);
        for (const id of plan.ids) this.blocked.add(id);
        if (stopService) this.blocked.add("diagnostics");
        const active = stopService
          ? this.router.clientActive() + this.extraActive()
          : plan.ids.reduce((n, id) => n + this.router.clientActive(id), 0);
        if (active)
          throw Error(
            `仍有 ${active} 条请求正在进行，未断开；请等待任务完成后重新确认`,
          );
        const observed = this.processes.snapshot();
        if (observed.error)
          throw Error(
            "进程身份检查失败，未停止服务或恢复注入：" + observed.error,
          );
        const sessions = observed.sessions.filter(
          (s) =>
            plan.ids.includes(s.harness) &&
            s.status !== "gone" &&
            (!plan.quit || s.transport !== "native"),
        );
        if (sessions.some((s) => s.status !== "running"))
          throw Error("部分窗口身份无法确认，请手动关闭并刷新后再操作");
        if (sessions.length && mode === "safe")
          throw Error(
            "仍有 ASS 启动的客户端窗口；请先自行退出，或明确选择结束这些窗口",
          );
        if (sessions.length) {
          const result = await this.processes.stop(sessions.map((s) => s.id));
          if (
            result.error ||
            result.sessions.some(
              (s) => sessions.some((x) => x.id === s.id) && s.status !== "gone",
            )
          )
            throw Error(
              "未能确认所有选定窗口已结束，未继续清理注入；部分窗口可能已关闭，请刷新检查",
            );
        }
        // Recheck after asynchronous process operations. Never overwrite concurrent user edits.
        this.preflight(plan.ids, false, plan.quit);
        if (plan.ids.includes("codex")) {
          restoredSessions = (await this.sessionHandoff?.restore())?.count || 0;
          this.config.detach();
        }
        if (!plan.quit) this.nativeConfig?.restore(plan.ids);
        this.injections.restore(plan.ids);
        this.proxyConfig?.restore(plan.ids);
        for (const id of plan.ids)
          if (!plan.quit || !this.nativeConfig?.isDirect(id))
            this.enabled[id] = false;
        if (stopService) await this.router.stop();
      }
      atomic(this.file, JSON.stringify(this.enabled));
      this.revision++;
      let restarted;
      if (restart) {
        try { restarted = await this.restarter[restartFirst ? "launch" : "restart"](plan.restart, () => {
          // The old desktop is gone and configuration is committed. Let the
          // new instance use the route immediately instead of receiving 503.
          for (const id of plan.ids) this.blocked.delete(id);
        }); }
        catch { restarted = { ok: false }; }
      }
      if (restart) return {
        ok: true, quit: false, restart: restarted,
        message: restarted.ok ? "接入配置已更新，所选桌面客户端已重启。"
          : "接入配置已更新，但客户端重启未完成；请检查窗口并从开始菜单手动重启。",
      };
      if (close) return { ok: true, quit: false, closed: true, restoredSessions,
        message: `${restoredSessions ? `已恢复 ${restoredSessions} 个对话的官方模型绑定。` : ''}接入配置已更新，${stopName} 已关闭；未重新启动。` };
      return {
        ok: true,
        quit: plan.quit,
        message: plan.enabled
          ? plan.ids.includes("codex")
            ? "已开启接入。Codex App 请在任务结束后手动重启。"
            : plan.ids.includes("dsh") && this.nativeConfig?.isDirect("dsh")
              ? "已同步 DSH 原生配置；后端会热加载，已打开页面需刷新后才能看到新模型。"
          : plan.ids.some((id) => this.nativeConfig?.isDirect(id))
              ? "已同步原生配置；客户端直连供应商，不依赖 ASS 路由。"
            : plan.ids.includes("claude") && this.proxyConfig?.clients.claude?.accountless
              ? "终端与 Claude 桌面版无账号启动已配置。桌面版重新打开后选择 Continue with Gateway；请保持 ASS 运行。"
              : "已开启接入，从 ASS 新启动客户端时生效。"
          : "已断开所选客户端、恢复其注入文件；账户与会话数据保留。",
      };
    } catch (error) {
      if (desktopStopped) throw Error(`${stopName} 已关闭，但接入切换未完成：${error.message}。请检查接入状态后手动打开客户端。`, { cause: error });
      throw error;
    } finally {
      this.busy = false;
      this.blocked.clear();
      this.onChange();
    }
  }
  async repairPreview(scope) {
    const [id] = this.ids(scope);
    if (scope === "all") throw Error("请逐个客户端修复接入");
    if (this.busy) throw Error("已有接入操作正在执行");
    if (this.error) throw Error(this.error);
    if (!this.enabled[id]) throw Error("此客户端尚未开启接入");
    const adapter = this.proxyConfig?.supports(id) ? this.proxyConfig : this.nativeConfig;
    if (!adapter?.repairPlan) throw Error("此客户端没有可恢复的接入记录");
    this.injections.preflight([id]);
    const plan = adapter.repairPlan(id);
    if (!plan.files.length && !plan.routeOnly) throw Error("受管字段已经一致，无需修复");
    const restart = ["codex", "claude"].includes(id) && this.restarter ? await this.restarter.preview([id]) : null;
    const ticket = crypto.randomBytes(24).toString("hex");
    for (const [key, p] of this.tickets)
      if (p.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size > 20) this.tickets.clear();
    this.tickets.set(ticket, { kind: "repair", scope, ids: [id], restart,
      fingerprint: this.fingerprint([id], false), expires: Date.now() + 180000 });
    // Do not send credential values or encrypted-journal contents to the UI.
    return { ticket, names: [NAMES[id]], files: plan.files.length,
      restart: this.restarter?.public(restart), ...(plan.migration ? { migration: true } : {}) };
  }
  async repairApply({ ticket, acknowledged, restart = false, close = false } = {}) {
    const plan = this.tickets.get(ticket);
    if (!plan || plan.kind !== "repair" || plan.expires < Date.now())
      throw Error("修复确认已过期，请重新打开接入菜单");
    if (this.busy) throw Error("已有接入操作正在执行");
    if (acknowledged !== true) throw Error("请先确认修复");
    if (typeof restart !== "boolean" || (restart && (!["codex", "claude"].includes(plan.scope) || !plan.restart?.available || !this.restarter)))
      throw Error("此操作没有已确认的重启目标");
    if (typeof close !== "boolean" || restart && close || (close && (!plan.restart?.closeAvailable || !this.restarter))) throw Error("此操作没有已确认的关闭目标");
    this.tickets.delete(ticket);
    this.busy = true;
    const id = plan.scope;
    let desktopStopped = false;
    try {
      if (this.error) throw Error(this.error);
      if (!this.enabled[id] || this.fingerprint([id], false) !== plan.fingerprint)
        throw Error("配置已变化，请重新打开弹窗后修复");
      this.blocked.add(id);
      if (restart || close) {
        const before = this.fingerprint([id], false, false, false);
        await this.restarter[close ? "close" : "stop"](plan.restart);
        desktopStopped = true;
        await this.router.cancelClient(id);
        if (this.fingerprint([id], false, false, false) !== before)
          throw Error("关闭期间配置已变化，请重新打开弹窗后修复");
      }
      if (this.router.clientActive(id)) throw Error("仍有请求正在进行，请等待任务结束后修复");
      this.injections.preflight([id]);
      const adapter = this.proxyConfig?.supports(id) ? this.proxyConfig : this.nativeConfig;
      const result = adapter.repair(id);
      // Ensure a stopped proxy is available again, without stopping or replacing
      // an existing listener. Only explicit Codex restart can close a desktop.
      if (this.proxyConfig?.supports(id)) await this.router.start(this.port);
      this.revision++;
      if (restart) {
        let restarted;
        try { restarted = await this.restarter.launch(plan.restart, () => this.blocked.delete(id)); }
        catch { restarted = { ok: false }; }
        return { ok: true, files: result.files, restart: restarted,
          message: restarted.ok ? `已修复 ${NAMES[id]} 接入并保存加密备份，客户端已重启。`
            : `已修复 ${NAMES[id]} 接入并保存加密备份，但重启未完成；请从开始菜单手动打开。` };
      }
      if (close) return { ok: true, files: result.files, closed: true, message: `已修复 ${NAMES[id]} 接入，客户端已关闭；未重新启动。` };
      return { ok: true, files: result.files,
        message: `已${result.migrated ? "迁移" : "修复"} ${NAMES[id]} 接入并保存加密备份。` +
          (id === "dsh" ? "请刷新 DSH 页面加载模型。" : id === "claude" ? "后续从 ASS 打开的窗口使用修复后的接入。" : "客户端重新加载配置后生效。") };
    } catch (error) {
      if (desktopStopped) throw Error(`${id === "codex" ? "Codex" : NAMES[id]} 已关闭，但修复未完成：${error.message}。请检查接入状态后手动打开客户端。`, { cause: error });
      throw error;
    } finally {
      this.busy = false;
      this.blocked.clear();
      this.onChange();
    }
  }
  async launch(work) {
    if (this.busy) throw Error("正在切换接入，请稍后启动客户端");
    this.busy = true;
    this.revision++;
    try {
      return await work();
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
}
module.exports = { Connections };
