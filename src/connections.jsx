import React, { useEffect, useRef, useState } from "react";
import { Power, Loader2, Wrench } from "./icons.jsx";
import { Modal } from "./editors.jsx";
import { ClientLocationRecovery } from "./client-location.jsx";
import { ClientProcessChoice } from "./client-process-choice.jsx";
import "./connections.css";
const api = window.ass;
export function ConnectionPill({ client, state, onManage, busy }) {
  const connection = state.connections.clients[client.id], enabled = connection.enabled;
  const disabled = !!busy || state.connections.busy;
  const actionable = !!connection.syncError || enabled && connection.pending;
  const label = enabled ? connection.syncError ? "恢复已应用配置" : connection.pending ? "应用待同步更改" : "接入已开启" : "未接入";
  return (
    <div
      className="connection-switch"
      data-enabled={enabled ? "true" : undefined}
      data-error={connection.syncError ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
    >
      {actionable ? <button className="connection-state-text" type="button" disabled={disabled}
        aria-label={client.name + (connection.syncError ? " 恢复已应用配置" : " 应用待同步更改")}
        onClick={() => onManage({ scope: client.id, enabled: true, sync: true, name: client.name,
          ...(connection.syncError ? { repairOnly: true, issue: connection.syncError } : {}) })}>{label}</button> : <span>{label}</span>}
      <button className="connection-toggle" type="button" role="switch" aria-checked={enabled}
        aria-label={client.name + " ASS 接入"} disabled={disabled}
        title={(enabled ? "断开 " : "开启 ") + client.name + " 接入"}
        onClick={() => onManage({ scope: client.id, enabled: !enabled, issue: connection.syncError, name: client.name })}>
        <span className="connection-pill-track" aria-hidden="true"><i /></span>
      </button>
    </div>
  );
}
export function ClientActivity({ client, state }) {
  const active = state.connections.clients[client.id]?.active || 0;
  return <span className="client-request-count" data-idle={active ? undefined : "true"}
    aria-hidden={!active || undefined} aria-live="polite">{active} 个请求</span>;
}
export function ConnectionStatus({ client, state }) {
  const connection = state.connections.clients[client.id];
  const sessions = state.connections.processes.sessions.filter(
    (s) => s.harness === client.id && s.status !== "gone",
  );
  if (!connection || client.injectionUnsupported) return null;
  const wsl = state.wslSync?.clients?.[client.id];
  const distro = state.wslSync?.distro;
  const hasWsl = !!(wsl && distro);
  const wslStatus = hasWsl && (wsl.error || (!wsl.enabled ? wsl.configured ? "等待撤回" : "未开启" :
    !state.wslSync.distroRunning ? "等待发行版启动" : !wsl.binary ? "未检测到客户端" : wsl.status || "等待同步"));
  const lastSync = hasWsl && wsl.lastSync;
  const note = connection.syncError || (connection.pending ? "模型或路由变更待同步" : "");
  const runtimeHint = connection.applied && {
    'reload-required': '配置已写入 · 客户端重新加载时读取',
    'terminal-ready': '配置已写入 · 新终端读取',
    'new-window-only': '配置已写入 · 从 ASS 新启动的窗口读取',
    'client-refresh-required': '配置已写入 · 页面刷新后读取',
  }[connection.runtimeStatus];
  if (!note && !runtimeHint && !sessions.length && !hasWsl) return null;
  return (
    <section
      className="connection-status"
      aria-label={client.name + " 接入控制"}
    >
      <div className="connection-overview">
        {note && <small role={connection.syncError ? "alert" : "status"}>{note}</small>}
        {runtimeHint && <small>{runtimeHint}</small>}
        {sessions.length > 0 && <div className="connection-metrics">
          {sessions.length > 0 && <span>{sessions.length} 个窗口</span>}
        </div>}
      </div>
      {hasWsl && <div className="connection-wsl-status">
        <small>WSL · {distro} · {wslStatus}</small>
        {lastSync && <small>最近成功同步 <time dateTime={lastSync}>{new Date(lastSync).toLocaleString("zh-CN")}</time></small>}
      </div>}
    </section>
  );
}
const PROTOCOL = { 'openai-responses': 'Responses', 'openai-chat': 'Chat Completions', anthropic: 'Messages' };
const PROTOCOL_MODE = { auto: '自动', fixed: '固定', native: '原生 Messages' };
const SURFACE = { desktop: '桌面端', cli: 'CLI', 'ass-cli': '从 ASS 启动的 CLI', 'desktop-gateway': '桌面版 Gateway', native: '客户端原生配置' };
const RELOAD = { restart: '已有窗口需重新打开；本次默认只写入配置。', 'claude-gateway': '新开的终端读取配置。已有桌面窗口需重新打开。',
  'new-launch': '从 ASS 新启动的会话读取配置。', 'page-refresh': '后端热加载，已打开页面需刷新。', reload: '已打开的客户端需重新加载配置。' };
function ChangePreview({ changes, wslSync, enabled }) {
  return changes?.map(change => {
    const wsl = wslSync?.clients?.[change.id];
    const modelCount = change.added.length + change.removed.length + change.protocols.length;
    return <section className="connection-preview" key={change.id} aria-label={change.name + " 接入变更"}>
      <div><strong>{change.name}</strong><span>Windows · {change.surfaces.map(surface => SURFACE[surface]).join(" / ")}</span></div>
      {enabled && <small>{RELOAD[change.reload]}</small>}
      {wsl?.enabled && wslSync.distro && <small>WSL · {wslSync.distro} · {enabled
        ? "自动同步 Windows 已应用配置" + (wsl.excludedProviders?.length ? `（排除 ${wsl.excludedProviders.length} 个供应商）` : "")
        : "随 Windows 接入撤回"}{!wslSync.distroRunning && " · 等待发行版启动"}</small>}
      {[[change.defaultModel, "默认模型", "客户端默认"], [change.reviewModel, "Auto Mode 审查模型", "跟随终端模型"]].map(([selection, label, fallback]) => selection &&
        <div key={label} className="connection-preview-selection">
          <span>{label}</span><span>{selection.from || fallback} → {selection.to || fallback}</span>
          {selection.fallback && <small>所选模型 {selection.requested} 不可用，已预览将采用的模型。</small>}
        </div>)}
      {modelCount ? <details open={modelCount <= 8}>
        <summary>{change.added.length} 新增 · {change.removed.length} 移除 · {change.protocols.length} 协议调整</summary>
        <ul>{[["新增", change.added], ["移除", change.removed], ["协议", change.protocols]].flatMap(([label, rows]) =>
          rows.map((row, index) => <li key={label + index}><span>{label}</span><span>{row.provider} / {row.model}</span><small>
            {row.protocol ? PROTOCOL[row.protocol] || row.protocol
              : [PROTOCOL[row.from] || row.from, PROTOCOL_MODE[row.fromMode]].filter(Boolean).join(" · ") + " → " +
                [PROTOCOL[row.to] || row.to, PROTOCOL_MODE[row.toMode]].filter(Boolean).join(" · ")}
          </small></li>))}</ul>
      </details> : enabled && <small>模型范围与接口协议一致。</small>}
    </section>;
  });
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
    [repairChecking, setRepairChecking] = useState(false),
    [revision, setRevision] = useState(0);
  const client = state?.harnesses.clients.find(c => c.id === request.scope);
  const connection = state?.connections.clients[request.scope];
  const issue = connection?.syncError ?? request.issue;
  const canInspectRepair = request.accountless === undefined && request.scope !== "all" && (!!issue || request.repairOnly);
  const inspection = useRef(0), operation = useRef(null), currentRequest = useRef(request), mounted = useRef(false);
  currentRequest.current = request;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; inspection.current++; }; }, []);
  useEffect(() => {
    if (operation.current?.request === request) return;
    operation.current = null;
    const generation = ++inspection.current;
    const active = () => mounted.current && generation === inspection.current;
    setPlan(null);
    setRepair(null);
    setRepairReason("");
    setError("");
    setProcessMode("none");
    setBusy(false);
    setChecking(true);
    setRepairChecking(canInspectRepair);
    async function inspectRepair() {
      try {
        const value = await api.call("connection-repair-preview", request.scope);
        if (active()) setRepair(value);
      } catch (e) {
        if (active()) setRepairReason(cleanError(e));
      } finally { if (active()) setRepairChecking(false); }
    }
    // Process discovery for a normal toggle must not hold config recovery hostage.
    // A missing executable only limits the optional close/restart actions.
    if (canInspectRepair) void inspectRepair();
    async function preview() {
      try {
        const value = await api.call("connection-preview", request.scope, request.enabled, false, request.accountless);
        if (active()) setPlan(value);
      } catch (e) {
        if (active()) {
          setError(cleanError(e));
          if (!canInspectRepair && request.accountless === undefined && request.scope !== "all") {
            setRepairChecking(true);
            void inspectRepair();
          }
        }
      } finally { if (active()) setChecking(false); }
    }
    if (request.repairOnly) setChecking(false);
    else void preview();
    return () => { if (generation === inspection.current) inspection.current++; };
  }, [request, issue, canInspectRepair, client?.launcher?.location, revision]);
  const target = plan?.names.join("、") || repair?.names.join("、") || request.name || client?.name || "客户端";
  const hasIssue = request.accountless === undefined && request.scope !== "all" && (!!issue || !!error || request.repairOnly);
  const showRepair = hasIssue;
  const showLocation = request.scope !== "all" && (!!error || !!issue || client?.launcher?.ambiguous);
  const locked = busy || locating || checking || state?.connections.busy;
  const repairLocked = busy || locating || state?.connections.busy;
  const restartPlan = hasIssue ? repair?.restart : plan?.restart;
  const restart = processMode === "restart", close = processMode === "close";
  const activeRequests = request.scope === "all" && state
    ? Math.max(state.service?.active || 0, Object.values(state.connections.clients).reduce((sum, client) => sum + (client.active || 0), 0))
    : connection?.active ?? plan?.active ?? 0;
  const waitForRequests = activeRequests > 0 && !restart && !close;
  const title = request.restoreSessions ? `恢复 ${target} 官方续聊？` : request.accountless !== undefined ? `${request.accountless ? "开启" : "关闭"} ${target} 无账号启动？` : request.repairOnly ? `恢复 ${target} 上次已应用配置？` : hasIssue ? `${target} 接入异常` : request.scope === "all"
      ? "停止全部接入？"
      : request.enabled
        ? request.sync ? `应用 ${target} 待同步更改？` : `开启 ${target} 接入？`
        : `断开 ${target} 接入？`;
  let warning = request.repairOnly ? "检查并恢复上次已应用的接入配置。" : "正在检查接入状态…";
  if (plan) {
    if (request.accountless !== undefined) {
      warning = request.accountless ? request.scope === "claude"
        ? "终端和桌面版使用注入模型，按 API 计费；桌面版允许工具访问外网。重新打开后选择 Continue with Gateway，原有登录保留。"
        : "仅使用已注入模型，按供应商 API 计费。续聊无需 ChatGPT 登录；保留登录时可继续使用原生提示词预测，完全无登录时预测不可用。旧对话可在正常退出 Codex 后修复。"
        : "恢复正常账户启动；已有窗口需重启后生效。";
    } else if (plan.enabled) {
      warning = plan.codexConfig
        ? "将更新 Codex 接入配置，保留原有登录与会话。"
        : plan.native
          ? request.scope === "dsh"
            ? "将同步模型及凭据。DSH 后端会热加载，已打开页面仍需刷新。"
            : "将同步模型及其凭据。请先结束客户端任务；原有登录保留。"
          : `将更新 ${target} 路由。新建会话会读取本次应用的配置。`;
    } else {
      const windows = plan.sessions.length
        ? `并关闭 ${plan.sessions.length} 个由 ASS 启动的窗口`
        : "";
      warning = `将恢复接口配置${windows}${plan.stopService ? "，停止路由服务" : ""}。${restart || close ? "请先结束任务。" : "请先结束任务，并退出自行启动的客户端。"}`;
    }
  }
  async function commit() {
    if (!plan || locked || waitForRequests) return;
    const run = { request }; operation.current = run; inspection.current++;
    const active = () => mounted.current && currentRequest.current === request && operation.current === run;
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
      if (active()) { onComplete(result.message, result.restart?.ok === false); onClose(); }
    } catch (e) {
      if (active()) { setError(cleanError(e)); setPlan(null); }
    } finally {
      if (active()) { operation.current = null; setBusy(false); setChecking(false); setRepairChecking(false); }
    }
  }
  async function repairConnection() {
    if (repairLocked || waitForRequests || operation.current?.request === request) return;
    const run = { request }; operation.current = run; inspection.current++;
    const active = () => mounted.current && currentRequest.current === request && operation.current === run;
    setBusy(true);
    setChecking(false);
    setError("");
    setRepairReason("");
    try {
      // No cached ticket after a failure: inspect again on this click rather
      // than disabling the only recovery action until the dialog is reopened.
      const selected = repair || await api.call("connection-repair-preview", request.scope);
      if (!active()) return;
      setRepair(selected);
      const forced = restart || close;
      if (forced && (!repair || (restart ? !selected.restart?.available : !selected.restart?.closeAvailable))) {
        setProcessMode("none");
        throw Error("关闭或重启目标需要重新确认；已恢复为仅修复配置，请重试。");
      }
      const result = await api.call("connection-repair", { ticket: selected.ticket, acknowledged: true, restart, close });
      if (active()) { onComplete(result.message, result.restart?.ok === false); onClose(); }
    } catch (e) {
      if (active()) {
        setError(cleanError(e));
        setRepair(null);
        setRepairReason("可以直接重试；将重新检查最新配置。登录和会话保持不变。");
        setPlan(null);
      }
    } finally { if (active()) { operation.current = null; setBusy(false); setRepairChecking(false); } }
  }
  return (
    <Modal
      title={title}
      className={`connection-confirm${plan?.changes?.length ? " has-change-preview" : ""}`}
      closeButton={false}
      dismissible={!busy && !locating}
      onClose={onClose}
    >
      <p
        className="connection-confirm-message"
        role={error ? "alert" : "status"}
      >
        {error || issue || (checking ? "正在更新接入状态…" : warning)}
      </p>
      {plan?.changes?.length > 0 && <div className="connection-previews">
        <ChangePreview changes={plan.changes} wslSync={state?.wslSync} enabled={plan.enabled} />
      </div>}
      {waitForRequests && <p className="connection-repair-note" role="status">还有 {activeRequests} 个请求正在进行。请求结束后可应用或恢复配置。</p>}
      {showLocation && <ClientLocationRecovery key={request.scope} clientId={request.scope}
        disabled={busy || checking} onBusy={setLocating} onUpdated={() => setRevision(v => v + 1)} />}
      {showRepair && <p className="connection-repair-note" role="status">
        {repairChecking ? "正在检查可修复内容…" : repair ? repair.migration ? "将备份并迁移到 DSH 当前 profile，不重启客户端。" : `将检查并恢复上次接入配置${repair.files ? `（${repair.files} 个文件）` : "及路由服务"}，保留未同步的模型编辑。${restart || close ? "" : "不关闭客户端，请先结束任务。"}` : repairReason || "点击修复将重新检查并恢复接入。"}
      </p>}
      <ClientProcessChoice plan={restartPlan} value={processMode} onChange={setProcessMode} disabled={busy} />
      {plan?.restoreSessions > 0 && <p className="connection-repair-note">断开接入时将恢复 {plan.restoreSessions} 个对话的官方模型绑定。请先关闭 Codex，或选择强制关闭 / 重启。</p>}
      <footer>
        <button
          className="button"
          data-autofocus
          disabled={busy || locating}
          onClick={onClose}
        >
          取消
        </button>
        {!request.repairOnly && !plan && !!error && <button className="button" disabled={locked} onClick={() => setRevision(value => value + 1)}>重新预览</button>}
        {!request.repairOnly && (plan || !hasIssue) && <button
          className="button primary"
          disabled={!plan || locked || waitForRequests || (restart && !plan.restart?.available) || (close && !plan.restart?.closeAvailable)}
          onClick={commit}
        >
          {busy && <Loader2 size={14} className="spin" />}
          {request.accountless !== undefined ? "确定" : request.enabled ? request.sync || hasIssue ? "应用更改" : "开启接入" : request.scope === "all" ? "停止全部接入" : "断开接入"}
        </button>}
        {showRepair && <button className="button primary connection-repair" disabled={repairLocked || waitForRequests} onClick={repairConnection}>
          {busy ? <Loader2 size={14} className="spin" /> : <Wrench size={15} />}
          {busy ? "恢复中…" : repairReason ? "重试恢复" : "恢复上次已应用配置"}
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
