import React, { useEffect, useRef, useState } from "react";
import {
  Terminal,
  KeyRound,
  UserRound,
  Plus,
  Folder,
  LogIn,
  LogOut,
  Check,
  RefreshCw,
  ChevronRight,
  Search,
  Settings2,
  Wallet,
  Unlink,
  ExternalLink,
  ArrowRightLeft,
  MessagesSquare,
} from "./icons.jsx";
import { Modal } from "./editors.jsx";
import { transitionUI } from './surface-motion.jsx';
import {
  AddAccount,
  NativeKeyAccounts,
  NativeKeyForm,
  OfficialApiForm,
} from "./account-dialogs.jsx";
import { ActionMenu } from "./menus.jsx";
import { AccountProfile, AccountPlan } from "./account-profile.jsx";
import { ConnectionStatus, ConnectionPill, ConnectionService, ClientActivity } from "./connections.jsx";
import { ClientInjection } from "./client-injection.jsx";
import { ClientProcessChoice } from "./client-process-choice.jsx";
import { CodexDesktopLaunch } from "./codex-desktop-launch.jsx";
import { detectedClients } from "./usage-view.mjs";
const api = window.ass;
const clientBrands = { codex: "openai", claude: "anthropic", opencode: "opencode", dsh: "deepseek", pi: "pi", kimi: "kimi", zcode: "zai" };
function ClientEntry({ client: c, activeClient, onSelect }) {
  return <div className={"client-entry" + (c.id === activeClient ? " active" : "")}>
    <button className="client-select" aria-label={c.name} aria-pressed={c.id === activeClient} onClick={() => onSelect(c.id)}>
      <span className="client-glyph" aria-hidden="true">{clientBrands[c.id] ? <img src={"./providers/" + clientBrands[c.id] + ".svg"} alt="" /> : <Terminal size={23} data-motion-icon={undefined} />}</span>
      <strong>{c.name}</strong><i className={"client-detected-dot" + (c.detected ? " found" : "")} title={c.detected ? "已识别" : "未识别"} /><ChevronRight size={14} />
    </button>
  </div>;
}

export function AccountForm({ client, onClose, onSave, initialProvider = "" }) {
  const [label, setLabel] = useState(""),
    [provider, setProvider] = useState(initialProvider),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={"添加 " + client.name + " 授权账户"}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(label, provider);
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          账户名称
          <input
            required
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如 个人账户 / 工作账户"
          />
        </label>
        {client.id === "pi" && (
          <label className="field">
            授权服务
            <select required
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            ><option value="">选择本机 pi 支持的 OAuth</option>
              {(client.oauthProviders || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {error && (
          <p role="alert" className="error-box">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "正在创建…" : "创建账户"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function AccountCard({
  account: a,
  client,
  state,
  act,
  busy,
  run,
  openProvider,
  editProvider,
  switchOAuth,
}) {
  const selected = a.oauthRecordId ? a.oauthCurrent : a.id === client.selected;
  const warning = [
    "expired",
    "refresh-required",
    "unreadable",
    "incomplete",
    "external",
  ].includes(a.status);
  const provider = state.providers.find((p) => p.id === a.providerId);
  const service = state.officialServices.find(
    (s) => s.id === state.officialProviderIds[a.providerId],
  );
  const balance = state.balances[a.providerId];
  return (
    <article
      className={"client-account-card" + (selected ? " selected" : "")}
      aria-label={a.label + " 账户"}
    >
      <header>
        <span className="account-symbol">
          {a.kind === "api" || a.authType === "api" ? (
            <KeyRound size={18} />
          ) : (
            <UserRound size={18} />
          )}
        </span>
        <div className="account-card-title">
          <h3>{a.profile?.fields?.find((f) => f.id === "email")?.value || a.profile?.fields?.find((f) => ["name", "keyLabel"].includes(f.id))?.value || a.label}</h3>
        </div>
        <AccountPlan account={a} />
        <span className="tag">{a.badge}</span>
        {provider && (
          <ActionMenu
            label={a.label + " 账户操作"}
            disabled={!!busy}
            items={[
              {
                label: "编辑凭据",
                icon: Settings2,
                action: () => editProvider(provider),
              },
              {
                label: "管理模型",
                icon: ChevronRight,
                action: () => openProvider(a.providerId),
              },
              {
                label: "查询余额",
                icon: Wallet,
                action: () =>
                  act("balance-" + a.providerId, () =>
                    api.call("balance", a.providerId),
                  ),
              },
              service && {
                label: "官方控制台",
                icon: ExternalLink,
                action: () =>
                  act("official-open", () =>
                    api.call("official-open", service.id, "console"),
                  ),
              },
              {
                label: "移除此账户卡片",
                icon: Unlink,
                danger: true,
                action: () =>
                  act("account-unbind", () =>
                    api.call(
                      "account-bind-api",
                      client.id,
                      a.providerId,
                      false,
                    ),
                  ),
              },
            ]}
          />
        )}
      </header>
      <AccountProfile account={a} hideIdentity {...{ client, state, act, busy }} />
      {(warning || !a.ready) && (
        <p
          className={
            "account-status" + (warning ? " warning" : a.ready ? " ready" : "")
          }
        >
          <i aria-hidden="true" />
          {a.message}
        </p>
      )}
      {balance && !(a.profile?.fields || []).some((f) => f.kind === "amount") && (
        <p className="account-balance-summary">
          {balance.ok
            ? (balance.rows || [balance])
                .map((r) => `${r.label || ""} ${r.value} ${r.unit || ""}`)
                .join(" · ")
            : balance.message}
        </p>
      )}
      {(!client.nativeLoginOnly || a.oauthRecordId) && <footer>
        {a.oauthRecordId ? <button
          className={"text-button account-choice" + (a.oauthCurrent ? " chosen" : "")}
          disabled={!!busy || a.oauthCurrent || !a.ready}
          title={a.oauthCurrent ? "原生凭据文件当前记录的账户" : "切换原生客户端的 OAuth 凭据"}
          onClick={() => switchOAuth(a)}
        >
          {a.oauthCurrent ? <Check size={13} /> : <ArrowRightLeft size={13} />}
          {a.oauthCurrent ? "当前账户" : "切换账户"}
        </button> : <button
          className={"text-button account-choice" + (selected ? " chosen" : "")}
          disabled={!!busy || selected}
          onClick={() =>
            act("account-select", () =>
              api.call("account-select", client.id, a.id),
            )
          }
        >
          {selected && <Check size={13} />}
          {selected ? "下次启动使用" : "设为启动账户"}
        </button>}
        {!client.nativeLoginOnly && a.kind !== "oauth-history" && <div className="actions">
          {a.kind !== "api" && a.authType !== "api" && (
            <>
              <button
                className="icon-button"
                title="登录授权"
                aria-label={a.label + " 登录授权"}
                disabled={!client.executable || !!busy}
                onClick={() => run(a, "login")}
              >
                <LogIn size={15} />
              </button>
              <button
                className="icon-button"
                title="退出授权"
                aria-label={a.label + " 退出授权"}
                disabled={!client.executable || !!busy}
                onClick={() => run(a, "logout")}
              >
                <LogOut size={15} />
              </button>
            </>
          )}
          <button
            className="button"
            title={
              client.launcher?.kind === "desktop"
                ? `独立账户启动需要 ${client.name} CLI；可在右上角打开桌面端`
                : undefined
            }
            disabled={
              !client.executable ||
              !!busy ||
              state.connections.clients[client.id]?.accountless ||
              (a.kind === "api" && !a.ready)
            }
            onClick={() => run(a, "launch")}
          >
            <Terminal size={14} />
            启动
          </button>
        </div>}
      </footer>}
    </article>
  );
}

export function Clients({
  state,
  act,
  busy,
  onManage,
  initialClient = "codex",
  onSelectClient,
  openProvider,
  onConversations,
}) {
  const [selected, setSelected] = useState(initialClient),
    [adding, setAdding] = useState(false),
    [oauth, setOAuth] = useState(false),
    [editor, setEditor] = useState(null),
    [nativeKey, setNativeKey] = useState(null),
    [candidates, setCandidates] = useState(null),
    [switching, setSwitching] = useState(null),
    [loggingIn, setLoggingIn] = useState(null),
    [refreshResult, setRefreshResult] = useState(null),
    [launchNotice, setLaunchNotice] = useState(""),
    [notice, setNotice] = useState("");
  const client =
    state.harnesses.clients.find((c) => c.id === selected) ||
    state.harnesses.clients[0];
  const nativeService = state.officialServices.find(
    (s) =>
      s.nativeKey &&
      s.id === selected &&
      state.nativeAccounts.some((a) => a.vendorId === s.id),
  );
  const nativeServices = state.officialServices.filter(
    (s) => s.nativeKey && state.nativeAccounts.some((a) => a.vendorId === s.id),
  );
  const activeClient = nativeService?.id || client.id;
  const panelRef = useRef(null);
  const recognized = detectedClients(state);
  const otherClients = state.harnesses.clients.filter((c) => !recognized.some((r) => r.id === c.id));
  const selectClient = (id) => {
    transitionUI(() => { setSelected(id); onSelectClient?.(id); setNotice(""); setLaunchNotice(""); setCandidates(null); });
    if (panelRef.current?.getBoundingClientRect().top < 0)
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "start", behavior: "instant" }));
  };
  const addButton = useRef(null);
  function closeAdding() {
    setAdding(false);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  function closeOAuth() {
    setOAuth(false);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  // Returning from a native login window refreshes status without running auth helpers.
  useEffect(() => {
    let mounted = true, pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { await api.call("snapshot"); }
      catch { if (mounted) setNotice("状态读取失败，请点击刷新状态。"); }
      finally { pending = false; }
    };
    const tick = setInterval(() => {
      if (document.hasFocus()) refresh();
    }, 15000);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      mounted = false;
      clearInterval(tick);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const run = (account, action, model) =>
    act("client-" + action, async () => {
      const r = await api.call(
        "client-launch",
        client.id,
        account.id,
        action,
        model,
      );
      if (r?.message) setNotice(r.message);
      return r;
    });
  const detect = () =>
    act("client-detect", async () => {
      const result = await api.call("client-detect", client.id);
      if (!result.selected && result.candidates.length > 1) setCandidates(result.candidates);
      else
        setNotice(
          result.selected
            ? "已识别并选择客户端入口。"
            : "未找到客户端，请选择安装或源码目录。",
        );
    });
  const openDesktop = () => {
    setLaunchNotice("");
    return act("client-open-desktop", async () => {
      const result = await api.call("client-open-desktop", client.id);
      if (client.id === "codex") setLaunchNotice(result.message);
      else setNotice(result.message);
      return result;
    });
  };
  return (
    <>
      {state.connections.error && (
        <p role="alert" className="error-box">
          {state.connections.error}
        </p>
      )}
      <div className="clients-toolbar">
        <button className="button" disabled={!!busy || state.connections.busy || !Object.values(state.connections.clients).some(c => c.enabled)}
          title="刷新所有已开启的接入；不重启客户端，跳过正在请求或有配置冲突的项"
          onClick={() => act("connections-refresh", async () => {
            setRefreshResult(null);
            const result = await api.call("connections-refresh");
            setRefreshResult(result);
            return result;
          })}>
          <RefreshCw size={15} className={busy === "connections-refresh" ? "spin" : undefined} />
          {busy === "connections-refresh" ? "正在刷新注入…" : "刷新全部注入"}
        </button>
      </div>
      {refreshResult && <div className="clients-refresh-result" role="status">
        <p>{refreshResult.message}</p>
        {refreshResult.skipped?.length > 0 && <ul>{refreshResult.skipped.map(item => <li key={item.id}>{item.name}：{item.reason}</li>)}</ul>}
      </div>}
      <div className="clients-layout">
        <nav className="client-list" aria-label="客户端列表">
          <h3 className="client-rail-title">已识别的客户端</h3>
          {recognized.map((c) => <ClientEntry key={c.id} client={c} {...{ activeClient }} onSelect={selectClient} />)}
          {!recognized.length && <p className="client-rail-empty">尚未识别到客户端</p>}
          {!!otherClients.length && <details className="more-clients" open={otherClients.some((c) => c.id === activeClient) || undefined}>
            <summary>更多客户端 <ChevronRight size={14} /></summary>
            {otherClients.map((c) => <ClientEntry key={c.id} client={c} {...{ activeClient }} onSelect={selectClient} />)}
          </details>}
          {nativeServices.map((s) => (
            <div
              className={"client-entry" + (selected === s.id ? " active" : "")}
              key={s.id}
            >
              <button
                className="client-select"
                aria-pressed={selected === s.id}
                onClick={() => {
                  setSelected(s.id);
                  onSelectClient?.(s.id);
                  setNotice("");
                }}
              >
                <KeyRound size={19} />
                <span>
                  <strong>{s.name}</strong>
                  <small>原生 Key 保管</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </div>
          ))}
          <button
            className="text-button native-key-add"
            onClick={() =>
              setNativeKey(state.officialServices.find((s) => s.nativeKey))
            }
          >
            <Plus size={14} />
            添加原生客户端 Key
          </button>
        </nav>
        {nativeService ? (
          <NativeKeyAccounts
            service={nativeService}
            accounts={state.nativeAccounts.filter(
              (a) => a.vendorId === nativeService.id,
            )}
            {...{ state, act, busy }}
          />
        ) : (
          <section
            ref={panelRef}
            className="client-panel"
            aria-label={client.name + " 账户管理"}
          >
            <header className="client-heading">
              <div className="client-heading-title">
                <h2>{client.name}</h2><ClientActivity {...{ client, state }} />
              </div>
              <div className="actions">
                <button className="icon-button" aria-label="自动识别客户端" title="自动识别客户端"
                  disabled={!!busy} onClick={detect}><Search size={16} /></button>
                {client.desktop && client.id !== "codex" && (
                  <button
                    className="icon-button"
                    title={"打开 " + client.name + " 桌面端"}
                    aria-label={"打开 " + client.name + " 桌面端"}
                    disabled={!!busy}
                    onClick={openDesktop}
                  >
                    <ExternalLink size={16} />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label={state.connections.clients[client.id]?.enabled ? "同步接入配置" : "刷新状态"}
                  title={state.connections.clients[client.id]?.enabled ? "同步接入配置" : "刷新账户、额度和模型"}
                  disabled={!!busy}
                  onClick={() => {
                    if (state.connections.clients[client.id]?.enabled)
                      onManage({ scope: client.id, enabled: true, sync: true, name: client.name });
                    else act("client-refresh", () => api.call("client-refresh", client.id));
                  }}
                >
                  <RefreshCw size={14} />
                </button>
                {["codex", "claude"].includes(client.id) && <button className="icon-button" aria-label="查看保留的对话" title="对话管理"
                  onClick={() => onConversations?.(client.id)}><MessagesSquare size={18} /></button>}
                {client.id === "codex" && <CodexDesktopLaunch desktop={client.desktop}
                  connection={state.connections.clients.codex} {...{ busy }} onLaunch={openDesktop} />}
                {!client.injectionUnsupported && <ConnectionPill {...{ client, state, busy, onManage }} />}
              </div>
            </header>
            <ConnectionStatus {...{ client, state, busy, onManage }} />
            {launchNotice && <p className="codex-launch-result" role="status">{launchNotice}</p>}
            <ClientInjection key={"injection:" + client.id} {...{ client, state, act, busy, onManage }} />
            <header className="client-accounts-heading"><h3>官方账户 <span className="count">{client.accounts.length}</span></h3>
              {!client.nativeLoginOnly && <button className="button" ref={addButton} onClick={() => setAdding(true)}><Plus size={14} />添加账户</button>}
              {["kimi", "zcode"].includes(client.id) && <button className="icon-button" disabled={!!busy}
                aria-label={"登录 " + client.name + " 账户"} title="登录账户"
                onClick={() => act("native-login-preview", async () => {
                  setLoggingIn(await api.call("native-login-preview", client.id));
                })}><LogIn size={17} /></button>}
            </header>
            {client.oauthHistoryError && <p className="error-box" role="alert">{client.oauthHistoryError}</p>}
            <div className="client-account-grid">
              {client.accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  {...{ client, state, act, busy, run, openProvider }}
                  editProvider={setEditor}
                  switchOAuth={(a) => act("oauth-switch-preview", async () => {
                    const preview = await api.call("oauth-switch-preview", client.id, a.oauthRecordId);
                    setSwitching({ ...preview, clientName: client.name });
                  })}
                />
              ))}
              {!client.accounts.length && (
                <div className="empty">
                  <KeyRound size={23} />
                  <p>
                    {client.nativeLoginOnly && !["kimi", "zcode"].includes(client.id) ? "在原生客户端中管理登录" : "暂无官方账户"}
                  </p>
                </div>
              )}
            </div>
            <details className="client-settings" key={"paths:" + client.id}>
              <summary><Settings2 size={16} />客户端设置 <ChevronRight size={15} /></summary>
              <div className="client-location-actions" aria-label="客户端位置">
                <button className="button" disabled={!!busy} onClick={detect}>
                  <Search size={14} />
                  自动识别
                </button>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    act("client-directory", () =>
                      api.call("client-executable", client.id, true),
                    )
                  }
                >
                  <Folder size={14} />
                  选择目录
                </button>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    act("client-path", () =>
                      api.call("client-executable", client.id),
                    )
                  }
                >
                  选择文件
                </button>
              </div>
              <div className="client-location" role="status">
                <p
                  className={
                    "launcher-state " +
                    (client.launcher?.ready || client.launcher?.installed
                      ? "ready"
                      : "")
                  }
                >
                  {(client.launcher?.ready || client.launcher?.installed) && (
                    <Check size={14} />
                  )}
                  {client.launcher?.message || "未检测到安装"}
                </p>
                {client.launcher?.location && (
                  <p className="client-path mono">{client.launcher.location}</p>
                )}
                {client.launcher?.ready && (
                  <details className="launcher-command">
                    <summary>查看启动入口</summary>
                    <code>{client.launcher.command}</code>
                  </details>
                )}
              </div>
              {client.id === "kimi" && <label className="field">
                Kimi 配置版本
                <select aria-label="Kimi 配置版本" value={client.nativeVariant || "auto"}
                  disabled={!!busy || state.connections.clients.kimi?.enabled}
                  onChange={(event) => act("client-native-variant", () => api.call("client-native-variant", client.id, event.target.value))}>
                  <option value="auto">自动识别</option>
                  <option value="current">Kimi Code（新版）</option>
                  <option value="legacy">Kimi CLI（旧版）</option>
                </select>
              </label>}
              <div className="section-heading">
                <h3>凭据检测位置</h3>
                <div className="actions">
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      act("client-credentials", () =>
                        api.call("client-credentials", client.id),
                      )
                    }
                  >
                    指定凭据目录
                  </button>
                  {client.credentialHome && (
                    <button
                      className="text-button"
                      onClick={() =>
                        act("client-credentials", () =>
                          api.call("client-credentials", client.id, true),
                        )
                      }
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              </div>
              <div className="credential-sources">
                {client.credentialSources.map((s) => (
                  <div key={s.file}>
                    <code>{s.file}</code>
                    <span>{s.message}</span>
                  </div>
                ))}
              </div>
            </details>
            <div className="client-workspace">
              <Folder size={15} />
              <span className="ellipsis" title={state.harnesses.workspace}>
                {state.harnesses.workspace || "ASS 独立工作目录"}
              </span>
              <button
                className="text-button"
                onClick={() =>
                  act("client-workspace", () => api.call("client-workspace"))
                }
              >
                选择工作目录
              </button>
            </div>
            {client.id === "pi" && (
              <details className="pi-import">
                <summary>
                  从其他客户端导入 OAuth{" "}
                  <span className="count">
                    {state.harnesses.oauthSources.length}
                  </span>
                </summary>
                <p className="hint">
                  {state.harnesses.piOAuthProviders.length
                    ? "本机 pi 支持：" +
                      state.harnesses.piOAuthProviders
                        .map((p) => p.name)
                        .join("、")
                    : "未确认本机 pi 的 OAuth 能力，请选择 pi 程序后刷新。"}
                </p>
                {state.harnesses.oauthSources.map((s) => (
                  <div className="oauth-source" key={s.id}>
                    <div>
                      <strong>{s.label}</strong>
                      <small>
                        {!s.compatible && s.reason ? s.reason : s.provider + (s.expired ? ' · 需客户端刷新' : '')}
                      </small>
                    </div>
                    <button
                      className="button"
                      disabled={!s.compatible || !!busy}
                      title={!s.compatible ? s.reason : s.warning}
                      onClick={() =>
                        act("pi-import", () =>
                          api.call("pi-import-oauth", s.id, s.label + " → pi"),
                        )
                      }
                    >
                      {s.compatible ? "导入到 pi" : "未确认兼容"}
                    </button>
                  </div>
                ))}
                <p className="hint">
                  当前支持 Codex、Claude Code、OpenCode → pi 单向导入；不支持 pi → OpenCode 或 OpenCode OAuth 历史切号。
                  导入会新建独立账户，不覆盖来源。仅核对格式，未验证刷新或订阅权益；两端共享 refresh grant，分别刷新或撤销可能使另一端失效。
                </p>
              </details>
            )}
            {notice && (
              <p className="client-notice" role="status">
                {notice}
              </p>
            )}
          </section>
        )}
      </div>
      <ConnectionService {...{ state, busy, onManage }} />
      {switching && <OAuthSwitchDialog
        preview={switching}
        onClose={() => setSwitching(null)}
        onDone={(message) => { setSwitching(null); setNotice(message); }}
      />}
      {loggingIn && <NativeLoginDialog preview={loggingIn}
        onClose={() => setLoggingIn(null)}
        onDone={(message) => { setLoggingIn(null); setNotice(message); }} />}
      {adding && (
        <AddAccount
          key={client.id}
          client={client}
          state={state}
          onClose={closeAdding}
          onOAuth={() => {
            setAdding(false);
            setOAuth(true);
          }}
        />
      )}
      {editor && (
        <OfficialApiForm
          client={client}
          profiles={[]}
          provider={editor}
          onClose={() => setEditor(null)}
        />
      )}
      {nativeKey && (
        <NativeKeyForm service={nativeKey} onClose={() => setNativeKey(null)} />
      )}
      {oauth && (
        <AccountForm
          client={client}
          onClose={closeOAuth}
          onSave={async (label, provider) => {
            await api.call("account-add", client.id, label, provider);
            await act("account-refresh", () => api.call("snapshot"));
          }}
        />
      )}
      {candidates && (
        <Modal
          title="选择识别到的客户端"
          description="选择要使用的位置。"
          onClose={() => setCandidates(null)}
        >
          <div className="launcher-candidates">
            {candidates.map((candidate) => (
              <button
                className="account-row"
                key={candidate.location}
                disabled={!!busy}
                onClick={() =>
                  act("client-location", async () => {
                    await api.call(
                      "client-location",
                      client.id,
                      candidate.location,
                    );
                    setCandidates(null);
                    setNotice("已选择客户端入口。");
                  })
                }
              >
                <Folder size={18} />
                <span className="account-content">
                  <strong>{candidate.message}</strong>
                  <small>{candidate.location}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function NativeLoginDialog({ preview, onClose, onDone }) {
  const [choice, setChoice] = useState(preview.selected);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  return <Modal title={"登录 " + preview.clientName} className="oauth-switch-dialog"
    onClose={onClose} dismissible={!pending}
    fallbackFocus={() => document.querySelector('.client-accounts-heading button')}>
    <div className="native-login-options" role="group" aria-label="登录区域或供应商">
      {preview.choices.map((item) => <button key={item.id} className="button"
        aria-pressed={item.id === choice} disabled={pending} onClick={() => setChoice(item.id)}>{item.label}</button>)}
    </div>
    <p>请先结束客户端内的任务。登录会更新当前账户，可能调整默认模型；旧账户先保存，不自动重启客户端。</p>
    <details className="account-origin"><summary>登录位置</summary><code>{preview.target}</code></details>
    {error && <p className="error-box" role="alert">{error}</p>}
    <footer>
      <button className="button" disabled={pending} onClick={onClose} data-autofocus>取消</button>
      <button className="button primary" disabled={pending} onClick={async () => {
        setPending(true); setError("");
        try { const result = await api.call("native-login-apply", preview.ticket, choice, true); onDone(result.message); }
        catch (e) { setError(e.message); }
        finally { setPending(false); }
      }}>{pending ? "打开中…" : "确定"}</button>
    </footer>
  </Modal>;
}

function OAuthSwitchDialog({ preview, onClose, onDone }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [mode, setMode] = useState("none");
  return <Modal title={"切换 " + preview.clientName + " 账户"} className="oauth-switch-dialog"
    onClose={onClose} dismissible={!pending}
    fallbackFocus={() => document.querySelector('.client-heading button[aria-label="刷新状态"]')}>
    <p>切换到 <strong>{preview.label}</strong>？当前登录与本地对话会保留。</p>
    <ClientProcessChoice plan={preview.lifecycle} value={mode} onChange={setMode} disabled={pending} actionLabel="仅切换账户" />
    <details className="account-origin"><summary>目标凭据位置</summary><code>{preview.target}</code></details>
    {error && <p className="error-box" role="alert">{error}</p>}
    <footer>
      <button className="button" disabled={pending} onClick={onClose} data-autofocus>取消</button>
      <button className="button primary" disabled={pending} onClick={async () => {
        setPending(true); setError("");
        try { const result = await api.call("oauth-switch-apply", preview.ticket, true, mode); onDone(result.message); }
        catch (e) { setError(e.message); }
        finally { setPending(false); }
      }}>{pending ? "切换中…" : "确定"}</button>
    </footer>
  </Modal>;
}
