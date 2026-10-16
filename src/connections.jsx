import React, { useEffect, useState } from "react";
import { Power, Loader2, Wrench } from "./icons.jsx";
import { Modal } from "./editors.jsx";
import { ClientLocationRecovery } from "./client-location.jsx";
import { ClientProcessChoice } from "./client-process-choice.jsx";
import "./connections.css";
const api = window.ass;
export function ConnectionPill({ client, state, onManage, busy }) {
  const connection = state.connections.clients[client.id], enabled = connection.enabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={client.name + " ASS 接入"}
      title={
        connection.syncError ? "查看并修复 " + client.name + " 接入" : enabled
          ? "断开 " + client.name + " 接入"
          : "开启 " + client.name + " 接入"
      }
      className="connection-switch"
      data-error={connection.syncError ? "true" : undefined}
      disabled={!!busy || state.connections.busy}
      onClick={() => onManage({ scope: client.id, enabled: !enabled, issue: connection.syncError, name: client.name })}
    >
      <span>{enabled ? (state.connections.clients[client.id].syncError ? "接入异常" : state.connections.clients[client.id].pending ? "待同步" : "接入已开启") : "未接入"}</span>
      <span className="connection-pill-track" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}
export function ConnectionStatus({ client, state, busy, onManage }) {
  const connection = state.connections.clients[client.id];
  const sessions = state.connections.processes.sessions.filter(
    (s) => s.harness === client.id && s.status !== "gone",
  );
  if (!connection || client.injectionUnsupported) return null;
  const note = connection.syncError ? connection.syncError : connection.pending ? "模型变更待同步" : "";
  if (!note && !sessions.length && !connection.active) return null;
  return (
    <section
      className="connection-status"
      aria-label={client.name + " 接入控制"}
    >
      <div className="connection-overview">
        <small role={connection.syncError ? "alert" : "status"}>{note}</small>
        {(sessions.length > 0 || connection.active > 0) && <div className="connection-metrics">
          {connection.active > 0 && <span>{connection.active} 个请求</span>}
          {sessions.length > 0 && <span>{sessions.length} 个窗口</span>}
        </div>}
      </div>
    </section>
  );
}
export function ConnectionDialog(props) {
  return props.request.quit ? <ExitDialog onClose={props.onClose} /> : <ConnectionChangeDialog {...props} />;
}
function ExitDialog({ onClose }) {
  const [status, setStatus] = useState(null), [plan, setPlan] = useState(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true;
    async function inspect() {
      try {
        const value = await api.call("app-exit-preview");
        if (!active) return;
        if (value.canDirectExit) {
          setBusy("direct");
          await api.call("app-exit-direct", true);
          return;
        }
        setStatus(value);
        if (value.error) { setError(value.error); return; }
        if (value.safeNeeded) {
          const safePlan = await api.call("connection-preview", "all", false, true);
          if (active) setPlan(safePlan);
        }
      } catch (e) {
        if (active) {
          setStatus(previous => previous || { safeNeeded: true });
          setError(cleanError(e));
        }
      }
    }
    inspect();
    return () => { active = false; };
  }, []);
  async function exit(mode) {
    if (busy || (mode === "safe" && !plan)) return;
    setBusy(mode);
    setError("");
    try {
      if (mode === "direct") await api.call("app-exit-direct", true);
      else await api.call("connection-apply", { ticket: plan.ticket, mode: "terminate", acknowledged: true });
    } catch (e) {
      setError(cleanError(e));
      if (mode === "safe") setPlan(null);
      setBusy("");
    }
  }
  return <Modal title="退出 ASS？" className="connection-confirm connection-exit"
    closeButton={false} dismissible={!busy} onClose={onClose}>
    <dl className="exit-options">
      <div><dt>直接退出</dt><dd id="exit-direct-description">保留所有接入与免登录配置，不关闭客户端窗口。路由请求会中断，依赖 ASS 的模型需重新启动 ASS 后才能继续使用。</dd></div>
      {status?.safeNeeded && <div><dt>安全退出</dt><dd id="exit-safe-description">撤回依赖 ASS 的注入后退出，官方账户、会话与原生直连配置保留。
        {plan?.sessions.length > 0 && <span>将关闭 {plan.sessions.length} 个由 ASS 启动的路由窗口。</span>}
        <span>请先结束客户端中的任务。</span></dd></div>}
    </dl>
    {status === null && <p className="connection-repair-note" role="status">正在检查是否需要安全退出…</p>}
    {status?.active > 0 && <p className="connection-repair-note" role="status">当前有 {status.active} 个路由请求；安全退出需等待请求结束。</p>}
    {error && <p className="connection-confirm-message exit-error" role="alert">{error}</p>}
    <footer>
      <button className="button" data-autofocus disabled={!!busy} onClick={onClose}>取消</button>
      {status?.safeNeeded && <button className="button" disabled={!!busy || !plan || plan.active > 0}
        aria-describedby="exit-safe-description" onClick={() => exit("safe")}>
        {busy === "safe" && <Loader2 size={14} className="spin" />}安全退出
      </button>}
      <button className="button primary" disabled={!!busy} aria-describedby="exit-direct-description" onClick={() => exit("direct")}>
        {busy === "direct" && <Loader2 size={14} className="spin" />}直接退出
      </button>
    </footer>
  </Modal>;
}
function ConnectionChangeDialog({ request, state, onClose, onComplete }) {
  const [plan, setPlan] = useState(null),
    [repair, setRepair] = useState(null),
    [repairReason, setRepairReason] = useState(""),
    [error, setError] = useState(""),
    [processMode, setProcessMode] = useState("none"),
    [busy, setBusy] = useState(false),
    [locating, setLocating] = useState(false),
    [checking, setChecking] = useState(true),
    [revision, setRevision] = useState(0);
  const client = state?.harnesses.clients.find(c => c.id === request.scope);
  const issue = state?.connections.clients[request.scope]?.syncError ?? request.issue;
  useEffect(() => {
    let active = true;
    setPlan(null);
    setRepair(null);
    setRepairReason("");
    setError("");
    setProcessMode("none");
    setChecking(true);
    async function preview() {
      let failed = false;
      try {
        const value = await api.call("connection-preview", request.scope, request.enabled, false, request.accountless);
        if (active) setPlan(value);
      } catch (e) {
        failed = true;
        if (active) setError(cleanError(e));
      }
      if (active && request.accountless === undefined && (failed || issue) && request.scope !== "all" && !client?.launcher?.ambiguous) {
        try {
          const value = await api.call("connection-repair-preview", request.scope);
          if (active) setRepair(value);
        } catch (e) {
          if (active) setRepairReason(cleanError(e));
        }
      }
      if (active) setChecking(false);
    }
    preview();
    return () => {
      active = false;
    };
  }, [request.scope, request.enabled, issue, request.accountless, client?.launcher?.location, client?.launcher?.ambiguous, revision]);
  const target = plan?.names.join("、") || repair?.names.join("、") || request.name || client?.name || "客户端";
  const hasIssue = request.accountless === undefined && request.scope !== "all" && (!!issue || !!error);
  const showLocation = request.scope !== "all" && (!!error || !!issue || client?.launcher?.ambiguous);
  const locked = busy || locating || checking;
  const restartPlan = hasIssue ? repair?.restart : plan?.restart;
  const restart = processMode === "restart", close = processMode === "close";
  const title = request.restoreSessions ? `恢复 ${target} 官方续聊？` : request.accountless !== undefined ? `${request.accountless ? "开启" : "关闭"} ${target} 无账号启动？` : hasIssue ? `${target} 接入异常` : request.scope === "all"
      ? "停止全部接入？"
      : request.enabled
        ? `${request.sync ? "同步" : "开启"} ${target} 接入？`
        : `断开 ${target} 接入？`;
  let warning = "正在检查接入状态…";
  if (plan) {
    if (request.accountless !== undefined) {
      warning = request.accountless ? request.scope === "claude"
        ? "终端和桌面版使用注入模型，按 API 计费；桌面版允许工具访问外网。重新打开后选择 Continue with Gateway，原有登录保留。"
        : "仅使用已注入模型，按供应商 API 计费。原有官方登录保留。"
        : "恢复正常账户启动；已有窗口需重启后生效。";
    } else if (plan.enabled) {
      warning = plan.codexConfig
        ? "将更新 Codex 接入配置，保留原有登录与会话。"
        : plan.native
          ? request.scope === "dsh"
            ? "将同步模型及凭据。DSH 后端会热加载，已打开页面仍需刷新。"
            : "将同步模型及其凭据。请先结束客户端任务；原有登录保留。"
          : `后续从 ASS 启动的 ${target} 将使用路由配置，不影响已有窗口。`;
    } else {
      const windows = plan.sessions.length
        ? `并关闭 ${plan.sessions.length} 个由 ASS 启动的窗口`
        : "";
      warning = `将恢复接口配置${windows}${plan.stopService ? "，停止路由服务" : ""}。${restart || close ? "请先结束任务。" : "请先结束任务，并退出自行启动的客户端。"}`;
    }
  }
  async function commit() {
    if (!plan || locked) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.call("connection-apply", {
        ticket: plan.ticket,
        mode: plan.enabled ? "safe" : "terminate",
        acknowledged: true,
        restart,
        close,
      });
      onComplete(result.message, result.restart?.ok === false);
      onClose();
    } catch (e) {
      setError(
        e.message.replace(/^Error invoking remote method '[^']+': Error: /, ""),
      );
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }
  async function repairConnection() {
    if (!repair || locked) return;
    setBusy(true);
    try {
      const result = await api.call("connection-repair", { ticket: repair.ticket, acknowledged: true, restart, close });
      onComplete(result.message, result.restart?.ok === false);
      onClose();
    } catch (e) {
      setError(cleanError(e));
      setRepair(null);
      setRepairReason("请重新打开弹窗，检查最新配置后再修复。");
      setPlan(null);
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title={title}
      className="connection-confirm"
      closeButton={false}
      dismissible={!busy && !locating}
      onClose={onClose}
    >
      <p
        className="connection-confirm-message"
        role={error ? "alert" : "status"}
      >
        {checking ? "正在更新接入状态…" : error || issue || warning}
      </p>
      {showLocation && <ClientLocationRecovery key={request.scope} clientId={request.scope}
        disabled={busy || checking} onBusy={setLocating} onUpdated={() => setRevision(v => v + 1)} />}
      {hasIssue && !client?.launcher?.ambiguous && <p className="connection-repair-note">
        {repair ? repair.migration ? "将备份并迁移到 DSH 当前 profile，不重启客户端。" : `将备份并恢复上次接入配置${repair.files ? `（${repair.files} 个文件）` : ""}。${restart || close ? "" : "不关闭客户端，请先结束任务。"}` : repairReason || "正在检查可修复内容…"}
      </p>}
      <ClientProcessChoice plan={restartPlan} value={processMode} onChange={setProcessMode} disabled={busy} />
      {plan?.restoreSessions > 0 && <p className="connection-repair-note">将恢复 {plan.restoreSessions} 个对话的官方模型绑定。请先关闭 Codex，或选择强制关闭 / 重启。</p>}
      <footer>
        <button
          className="button"
          data-autofocus
          disabled={busy || locating}
          onClick={onClose}
        >
          取消
        </button>
        {(plan || !hasIssue) && <button
          className="button primary"
          disabled={!plan || locked || (restart && !plan.restart?.available) || (close && !plan.restart?.closeAvailable)}
          onClick={commit}
        >
          {busy && <Loader2 size={14} className="spin" />}
          {hasIssue ? request.enabled ? "同步" : "断开接入" : "确定"}
        </button>}
        {hasIssue && !client?.launcher?.ambiguous && <button className="button primary connection-repair" disabled={!repair || locked} onClick={repairConnection}>
          {busy ? <Loader2 size={14} className="spin" /> : <Wrench size={15} />}
          {busy ? "修复中…" : "一键修复"}
        </button>}
      </footer>
    </Modal>
  );
}
function cleanError(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
export function ConnectionService({ state, onManage, busy }) {
  return (
    <div className="connection-service">
      <div>
        <strong>服务与接入管理</strong>
      </div>
      <button
        className="button"
        disabled={busy || state.connections.busy}
        onClick={() => onManage({ scope: "all", enabled: false })}
      >
        <Power size={15} />
        停止全部接入与服务…
      </button>
    </div>
  );
}
