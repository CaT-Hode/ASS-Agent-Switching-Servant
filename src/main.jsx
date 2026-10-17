import React, { useState, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Network,
  LayoutGrid,
  Boxes,
  Activity,
  ChevronRight,
  Settings2,
  X,
  Download,
  Folder,
  Monitor,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  Square,
  MessagesSquare,
} from "./icons.jsx";
import "./style.css";
import "./controls.css";
import "./polish.css";
import "./clients.css";
import "./sidebar.css";
import { Clients } from "./clients.jsx";
import { ConnectionDialog } from "./connections.jsx";
import { useIconMotion } from "./icon-motion.jsx";
import { Providers } from "./providers.jsx";
import { Updates, UpdateBanner } from "./updates.jsx";
import { modelKey, ModelCheckButton } from "./model-inspection.jsx";
import { DiagnosticTime } from "./diagnostic-time.jsx";
import { Overview } from "./overview.jsx";
import { latestSnapshot } from "./state-snapshot.mjs";
import { ThemeControl, applyTheme } from "./theme.jsx";
import { InteractiveBrand } from "./interactive-brand.jsx";
import { AssLogo } from "./ass-logo.jsx";
import { WindowControls } from "./window-controls.jsx";
import { DiagnosticDetails } from "./diagnostic-details.jsx";
import "./theme.css";
import "./motion.css";
const api = window.ass;
const Conversations = lazy(() => import("./conversations.jsx").then((m) => ({ default: m.Conversations })));
const date = (value) =>
  new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
function Button({
  children,
  primary = false,
  icon: Icon,
  busy = false,
  ...props
}) {
  return (
    <button
      className={"button" + (primary ? " primary" : "")}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy ? (
        <Loader2 className="spin" size={16} />
      ) : Icon ? (
        <Icon size={16} />
      ) : null}
      {children}
    </button>
  );
}
function ProviderIcon({ p }) {
  return (
    <span
      className={"provider-icon " + (p.id === "official" ? "official" : "")}
    >
      <span>
        {p.id === "official" ? (
          <Network size={23} />
        ) : (
          p.name.slice(0, 1).toUpperCase()
        )}
      </span>
    </span>
  );
}
function RequestTable({ rows }) {
  return (
    <div className="request-table">
      <div className="table-head request-row">
        <span>时间</span>
        <span>模型</span>
        <span>来源</span>
        <span>状态</span>
        <span>耗时</span>
      </div>
      {!rows.length ? (
        <div className="empty">
          <Activity size={26} />
          <p>等待第一个请求</p>
        </div>
      ) : (
        rows.slice(0, 8).map((r, i) => (
          <div className="request-row" key={r.time + i}>
            <span className="muted mono">{date(r.time)}</span>
            <span className="ellipsis" title={r.model}>
              {r.model.split("::").at(-1)}
            </span>
            <span className="muted">{r.source}</span>
            <span className={r.ok ? "success" : "danger"} title={r.error}>
              {r.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{" "}
              {r.taskOk === false && r.httpOk ? `任务失败 · HTTP ${r.httpStatus}` : r.ok ? "成功" : r.status}
            </span>
            <span className="muted mono">{(r.ms / 1000).toFixed(2)} s</span>
          </div>
        ))
      )}
    </div>
  );
}
function Diagnostics({ state, providers, act, busy }) {
  const batch = state.diagnosticBatch;
  const results = new Map((batch?.entries || []).map((e) => [e.key, e]));
  const available = providers.flatMap((p) =>
    p.enabled !== false && (p.id === "official" ? state.authReady : p.hasKey)
      ? p.models.filter((m) => m.enabled !== false)
      : [],
  ).length;
  return (
    <>
      <div className="diagnostic-toolbar">
        <div>
          <h2>
            模型连接测试 <span className="count">{available}</span>
          </h2>
          <p className="muted">
            测试可能产生 API 费用。
          </p>
        </div>
        {batch?.running ? (
          <Button
            icon={Square}
            disabled={batch.stopping}
            onClick={() =>
              act("diag-cancel", () => api.call("diagnose-cancel"))
            }
          >
            {batch.stopping ? "正在取消…" : "取消测试"}
          </Button>
        ) : (
          <Button
            icon={Play}
            primary
            disabled={!!busy || !available || state.connections.busy}
            onClick={() => act("diag-all", () => api.call("diagnose-all"))}
          >
            一键测试
          </Button>
        )}
      </div>
      {state.diagnosticHistoryError && (
        <p className="danger" role="alert">
          {state.diagnosticHistoryError}
        </p>
      )}
      {!!batch?.entries.length && (
        <div className="diagnostic-progress" role="status" aria-live="polite">
          <div>
            <strong>
              {batch.restored ? "上次测试" : batch.running
                ? "测试中"
                : batch.cancelled
                  ? "测试已取消"
                  : "测试完成"}{" "}
              · {batch.completed} / {batch.total}
            </strong>
            <span>
              通过 {batch.passed} · 失败 {batch.failed} · 跳过 {batch.skipped}
              {batch.cancelled ? " · 取消 " + batch.cancelled : ""}
            </span>
          </div>
          <progress
            aria-label="一键测试进度"
            value={batch.completed}
            max={batch.total || 1}
          />
          {batch.startedAt && <DiagnosticTime result={{ time: batch.finishedAt || batch.startedAt }} />}
          {batch.interrupted && <small className="muted">上次关闭时测试未完成，可重新测试。</small>}
        </div>
      )}
      <div className="diagnostic-list">
        {providers.flatMap((p) =>
          p.models.map((m) => {
            const d = state.diagnostics[modelKey(p.id, m.model)];
            const entry = results.get(modelKey(p.id, m.model));
            const run =
              batch?.running ||
              !d ||
              !batch?.finishedAt ||
              d.time <= batch.finishedAt
                ? entry
                : null;
            const showResult =
              d && (!run || ["passed", "failed"].includes(run.status));
            return (
              <div className="diagnostic" key={modelKey(p.id, m.model)}>
                <ProviderIcon p={p} />
                <div className="diagnostic-content">
                  <h3>
                    {p.name} / {m.displayName}
                  </h3>
                  <p
                    className={
                      (run ? run.status === "failed" : d && !d.ok)
                        ? "danger"
                        : "muted"
                    }
                  >
                    {run?.message || d?.message || "尚未执行连接检测"}
                  </p>
                  {d && (
                    <small>
                      {showResult
                        ? `${d.model} · ${(d.ms / 1000).toFixed(2)} s · `
                        : ""}
                      <DiagnosticTime result={d} />
                    </small>
                  )}
                  {d && <DiagnosticDetails result={d} />}
                </div>
                <ModelCheckButton
                  provider={p}
                  model={m}
                  {...{ state, act, busy }}
                />
              </div>
            );
          }),
        )}
      </div>
      <div className="diagnostic-settings">
        <h2>本机状态</h2>
        <dl>
          <div>
            <dt>路由入口</dt>
            <dd className="mono">
              http://127.0.0.1:{state.service.port}/clients/ASS/v1
            </dd>
          </div>
          <div>
            <dt>Codex 接入</dt>
            <dd>{state.codex.attached ? "已接入 ASS" : "未接入"}</dd>
          </div>
          <div>
            <dt>TLS 校验</dt>
            <dd>已开启 · Chromium 系统网络栈</dd>
          </div>
          <div>
            <dt>数据目录</dt>
            <dd className="ellipsis" title={state.dataDir}>
              {state.dataDir}
            </dd>
          </div>
        </dl>
        <div className="actions">
          <Button
            icon={Folder}
            onClick={() => act("data", () => api.call("open-data"))}
          >
            打开数据目录
          </Button>
          <Button
            icon={Download}
            onClick={() => act("export", () => api.call("export"))}
          >
            导出配置（无密钥）
          </Button>
        </div>
      </div>
      <section className="recent-section">
        <h2>最近请求</h2>
        <RequestTable rows={state.recent} />
      </section>
    </>
  );
}
function App() {
  useIconMotion();
  const [state, setState] = useState(null),
    [view, setViewLocal] = useState("overview"),
    [clientTarget, setClientTargetLocal] = useState("codex"),
    [busy, setBusy] = useState(""),
    [toast, setToast] = useState(null);
  const [connectionRequest, setConnectionRequest] = useState(null);
  const [providerDetail, setProviderDetail] = useState(null);
  const [conversationTarget, setConversationTarget] = useState(null);
  function remember(input) {
    api
      .call("ui-preferences", input)
      .catch((e) =>
        setToast({ error: true, message: "设置保存失败：" + e.message }),
      );
  }
  function setView(next) {
    setProviderDetail(null);
    setViewLocal(next);
    remember({ view: next });
  }
  function setClientTarget(next) {
    setClientTargetLocal(next);
    remember({ client: next });
  }
  function setProviderTarget(next) {
    remember({ provider: next });
  }
  function openProvider(id) {
    setProviderTarget(id);
    setView("providers");
    setProviderDetail(id);
  }
  useEffect(
    () =>
      api?.onManage((request) => {
        setView("clients");
        setConnectionRequest((previous) => previous || request);
      }),
    [],
  );
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (!api) return;
    api
      .call("snapshot")
      .then((next) => {
        setState((current) => latestSnapshot(current, next));
        setViewLocal("overview");
        applyTheme(next.preferences.theme);
        setClientTargetLocal(next.preferences.client);
      })
      .catch((e) => setToast({ error: true, message: e.message }));
    const unsubscribe = api.subscribe((next) => setState((current) => latestSnapshot(current, next)));
    const unsubscribeError = api.onStateError((message) => setToast({ error: true, message }));
    return () => { unsubscribe(); unsubscribeError(); };
  }, []);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 7000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  async function act(key, fn, success) {
    setBusy(key);
    try {
      const r = await fn();
      if (r?.ok === false) setToast({ error: true, message: r.message });
      else if (success) setToast({ message: success });
      else if (key === "import" && r)
        setToast({
          message: `已导入 ${r.providers} 个供应商、${r.models} 个模型`,
        });
      const next = await api.call("snapshot");
      setState((current) => latestSnapshot(current, next));
      return r;
    } catch (e) {
      setToast({
        error: true,
        message: e.message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      });
    } finally {
      setBusy("");
    }
  }
  if (!api)
    return (
      <div className="loading">
        <Monitor size={32} />
        <h2>请从 ASS 桌面应用打开</h2>
        <p>此界面通过本机桌面通道管理路由，不提供网页管理入口。</p>
      </div>
    );
  if (!state)
    return (
      <div className="loading">
        <Loader2 className="spin" />
        <p>正在加载本机路由…</p>
      </div>
    );
  const providers = [
    {
      id: "official",
      name: "OpenAI 官方",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: state.officialModels,
    },
    ...state.providers,
  ];
  const title = {
    overview: "路由总览",
    providers: "供应商与模型",
    clients: "客户端与账户",
    conversations: "对话管理",
    diagnostics: "连接诊断",
    updates: "关于 ASS",
  }[view];
  const brand = <InteractiveBrand>
    <AssLogo interactive />
    <div><div className="brand-title"><strong className="brand-wordmark" aria-label="ASS"><span className="brand-letter" data-letter="A">A</span><span className="brand-letter" data-letter="S">S</span><span className="brand-letter" data-letter="S">S</span></strong>
      <button className="version-button" aria-label="查看 ASS 版本与更新" title={state.updates.available ? "发现新版本" : "版本与更新"} onClick={() => setView("updates")}>
        {state.updates.available && <span className="update-dot" />}<span className="brand-version-label" data-version={`v${state.version}`}>v{state.version}</span>
      </button>
    </div><small>AI 路由</small></div>
  </InteractiveBrand>;
  return (
    <div
      className="app-shell"
      data-window-chrome={api.windowChrome || undefined}
      data-input="keyboard"
      onPointerDownCapture={(e) => {
        e.currentTarget.dataset.input = "pointer";
      }}
      onPointerMoveCapture={(e) => {
        if (e.pointerType === "mouse")
          e.currentTarget.dataset.input = "pointer";
      }}
      onKeyDownCapture={(e) => {
        e.currentTarget.dataset.input = "keyboard";
      }}
    >
      {api.windowChrome && <header className="window-chrome" aria-label="应用顶栏">{brand}<WindowControls onError={(message) => setToast({ error: true, message })} /></header>}
      <aside className="sidebar">
        {!api.windowChrome && brand}
        <div className="nav-label">工作空间</div>
        <nav aria-label="主导航">
          {[
            ["overview", LayoutGrid, "路由总览"],
            ["providers", Boxes, "供应商与模型"],
            ["clients", Monitor, "客户端与账户"],
            ["conversations", MessagesSquare, "对话管理"],
            ["diagnostics", Activity, "连接诊断"],
            ["updates", Download, "关于 ASS"],
          ].map(([id, Icon, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <section
            className={
              "sidebar-service" + (!state.service.running ? " stopped" : "")
            }
            aria-label="路由服务状态"
          >
            <div className="sidebar-service-heading" role="status">
              <span className="status-dot" aria-hidden="true" />
              <strong>
                {state.service.running ? "路由服务已就绪" : "路由服务已停止"}
              </strong>
            </div>
            <span className="mono">127.0.0.1:{state.service.port}</span>
            <small>
              {state.service.running
                ? "HTTP · 本机路由"
                : "当前请求无法经由 ASS 转发"}
            </small>
            <Button icon={Settings2} onClick={() => setView("clients")}>
              管理客户端接入
            </Button>
          </section>
          <ThemeControl value={state.preferences.theme} onChange={(theme) => remember({ theme })} />
        </div>
      </aside>
      <main>
        <h1 className="page-heading-accessible">{title}</h1>
        {state.startupError && (
          <div className="error-box">{state.startupError}</div>
        )}
        {state.nativeScanError && <div role="status" className="error-box">{state.nativeScanError}</div>}
        {view !== "updates" && (
          <UpdateBanner
            updates={state.updates}
            act={act}
            onView={() => setView("updates")}
          />
        )}
        {view === "overview" ? (
          <Overview
            {...{ state, act, setView, setClientTarget }}
          />
        ) : view === "providers" ? (
          <Providers
            {...{ state, providers, act, busy }}
            activeProvider={providerDetail}
            onOpenProvider={(id) => {
              setProviderTarget(id);
              setProviderDetail(id);
            }}
            onBack={() => setProviderDetail(null)}
          />
        ) : view === "clients" ? (
          <Clients
            {...{ state, act, busy }}
            onManage={setConnectionRequest}
            initialClient={clientTarget}
            onSelectClient={setClientTarget}
            openProvider={openProvider}
            onConversations={(id) => { setConversationTarget(id); setView("conversations"); }}
          />
        ) : view === "conversations" ? (
          <Suspense fallback={<div className="empty"><Loader2 className="spin" /><p>读取对话管理…</p></div>}>
            <Conversations state={state} initialHarness={conversationTarget}
              onNotify={(message, error = false) => setToast({ message, error })}
              onClient={(id) => { setClientTarget(id); setView("clients"); }} />
          </Suspense>
        ) : view === "updates" ? (
          <Updates {...{ state, act, busy }} />
        ) : (
          <Diagnostics {...{ state, providers, act, busy }} />
        )}
      </main>
      {connectionRequest && (
        <ConnectionDialog
          state={state}
          request={connectionRequest}
          onClose={() => setConnectionRequest(null)}
          onComplete={(message, error = false) => {
            setToast({ message, error });
            api
              .call("snapshot")
              .then((next) => setState((current) => latestSnapshot(current, next)))
              .catch(() => {});
          }}
        />
      )}
      {toast && (
        <div role="status" aria-live={toast.error ? "assertive" : "polite"} aria-atomic="true" className={"toast " + (toast.error ? "error" : "")}>
          {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="关闭通知">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
