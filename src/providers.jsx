import React, { useEffect, useRef, useState } from "react";
import {
  Plus,
  Search,
  ChevronRight,
  Settings2,
  Wallet,
  Trash2,
  Check,
  Layers,
  GripVertical,
  RefreshCw,
  AlertTriangle,
} from "./icons.jsx";
import { Modal, ModelEditor, ProviderEditor } from "./editors.jsx";
import { ActionMenu } from "./menus.jsx";
import {
  modelKey,
  ModelCheckButton,
  ModelCapabilities,
  ModelProtocolBadges,
  ProviderModelCatalog,
} from "./model-inspection.jsx";
import "./providers.css";
import { DiagnosticTime } from "./diagnostic-time.jsx";
import { SupplierQuota, SupplierQuotaRefresh, quotaAccountCaption, useSupplierQuota } from "./supplier-quota.jsx";
import { AccountProfile } from "./account-profile.jsx";
import { accountPlan } from "./account-plan.mjs";
import { providerBrand } from "./provider-brand.mjs";
import { orderProviders } from "./provider-order.mjs";
import { useProviderDrag } from "./provider-drag.jsx";
const api = window.ass;
const protocols = {
  "openai-responses": "Responses",
  "openai-chat": "Chat Completions",
  anthropic: "Anthropic Messages",
};
const number = (value) =>
  value != null && value !== "" && Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN")
    : "未知";
function capabilityText(state, p, m) {
  const d =
    state.providerModels?.[p.id]?.models.find((item) => item.model === m.model)
      ?.declared || m.declared;
  const report = state.capabilities?.[modelKey(p.id, m.model)];
  if (report) return "已有能力实测";
  const parts = [];
  if (d?.tools != null)
    parts.push("工具" + (d.tools ? "声明支持" : "声明不支持"));
  if (d?.vision != null)
    parts.push("视觉" + (d.vision ? "声明支持" : "声明不支持"));
  return parts.join(" · ") || "工具 / 视觉未检测";
}
function ProviderActions({ p, act, busy, onSelect, onEdit }) {
  return (
    <ActionMenu
      label={p.name + " 更多操作"}
      disabled={!!busy}
      items={[
        onSelect && { label: p.nativeAccountId ? "查看账户" : "查看模型", icon: Layers, action: onSelect },
        !p.readOnly &&
          p.id !== "official" && {
            label: "编辑供应商",
            icon: Settings2,
            action: onEdit,
          },
        !p.readOnly &&
          p.id !== "official" && {
            label: "查询余额",
            icon: Wallet,
            action: () =>
              act("balance-" + p.id, () => api.call("balance", p.id)),
          },
        !p.readOnly &&
          p.id !== "official" && {
            label: p.enabled === false ? "启用供应商" : "停用供应商",
            action: () =>
              act("provider-enable", () =>
                api.call("save-provider", {
                  ...p,
                  enabled: p.enabled === false,
                }),
              ),
          },
        !p.readOnly &&
          p.id !== "official" && {
            label: "移除供应商",
            icon: Trash2,
            danger: true,
            action: () =>
              act("delete-provider", () => api.call("delete-provider", p.id)),
          },
      ]}
    />
  );
}
function SourceCard({
  p,
  state,
  act,
  busy,
  onSelect,
  onEdit,
  buttonRef,
  draftCount,
  dragProps,
}) {
  const [failedBrand, setFailedBrand] = useState(null);
  const brand = providerBrand(p, state.officialProviderIds[p.id]);
  const quota = useSupplierQuota(p, state);
  const accountInHeader = !!(p.nativeAccountId && quota.account);
  const caption = accountInHeader ? quotaAccountCaption(quota.account) : "";
  const accountLine = accountInHeader ? [
    caption === p.name ? null : caption,
    quota.profile?.remote && quota.profile.source?.replace(" · 上次查询", "") || quota.client?.name,
    "OAuth", accountPlan(quota.account),
  ].filter(Boolean).join(" · ") : "";
  return (
    <article
      className="supplier-card"
      data-icon-control="provider"
      aria-label={p.name + " 供应商"}
      data-provider-id={p.id}
      onClick={(event) => {
        if (!event.target.closest("button, select, option, input, a"))
          onSelect();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="supplier-open"
        data-icon-scope="parent"
        aria-label={"查看 " + p.name + (p.nativeAccountId ? " 的账户" : " 的模型")}
        onClick={onSelect}
      />
      <header>
        <span className="supplier-symbol">
          {brand && failedBrand !== brand ? (
            <img
              src={"./providers/" + brand + ".svg"}
              alt={brand + " logo"}
              draggable={false}
              onError={() => setFailedBrand(brand)}
            />
          ) : (
            p.name.slice(0, 1).toUpperCase()
          )}
        </span>
        <div className="supplier-title">
          <h2
            title={p.name + (p.baseUrl ? " · " + new URL(p.baseUrl).host : "")}
          >
            {p.name}
          </h2>
          <span title={accountLine || undefined}>
            {accountLine || (p.nativeAccountId
              ? "OAuth"
              : p.id === "official"
                ? "OAuth 订阅"
                : p.readOnly
                  ? "原生账户"
                  : "API")}
          </span>
        </div>
        {accountInHeader && <SupplierQuotaRefresh name={p.name} quota={quota} />}
        <button
          type="button"
          className="model-icon provider-drag-handle"
          aria-label={"拖动排序 " + p.name}
          title="拖动排序；方向键移动，Esc 取消"
          {...dragProps}
        >
          <GripVertical size={17} />
        </button>
        <ProviderActions {...{ p, act, busy, onSelect, onEdit }} />
      </header>
      {!accountInHeader && <div className="supplier-meta">
        <span>{p.nativeAccountId ? `${p.accountCount} 个账户` : `${p.models.length} 个模型`}</span>
        {p.enabled === false && <span>已停用</span>}
        {!!draftCount && <span className="danger">{draftCount} 项未保存</span>}
        <ChevronRight size={15} />
      </div>}
      <SupplierQuota p={p} quota={quota} accountInHeader={accountInHeader} />
    </article>
  );
}
function InlineModel({
  p,
  model,
  draft,
  change,
  discard,
  state,
  act,
  busy,
  onDetails,
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [deleting, setDeleting] = useState(null);
  const deleteButton = useRef(null),
    deletePending = useRef(false);
  const value = draft?.value || model,
    dirty = !!draft,
    disabled = saving || !!busy;
  const update = (key, next) => {
    setError("");
    setMessage("");
    change(key, next);
  };
  async function save(e) {
    e.preventDefault();
    if (!dirty || disabled) return;
    setSaving(true);
    setError("");
    try {
      await api.call(
        "save-model",
        p.id,
        {
          ...value,
          contextSource:
            value.contextWindow !== model.contextWindow
              ? "手动配置"
              : value.contextSource,
        },
        model.model,
        draft.original,
      );
      discard();
      setMessage("已保存");
    } catch (e) {
      setError(
        e.message.replace(/^Error invoking remote method '[^']+': Error: /, ""),
      );
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (deletePending.current || !deleting) return;
    deletePending.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await api.call(
        "delete-model",
        p.id,
        deleting.model,
        deleting,
      );
      if (!result?.removed) throw Error("删除未完成，请重试");
      setDeleting(null);
    } catch (e) {
      setError(
        "删除失败：" +
          e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
      );
    } finally {
      deletePending.current = false;
      setSaving(false);
    }
  }
  const diagnostic = state.diagnostics[modelKey(p.id, model.model)];
  return (
    <form
      className={"inline-model" + (dirty ? " dirty" : "")}
      aria-label={model.model + " 行内配置"}
      onSubmit={save}
    >
      <div className="inline-model-fields">
        <label>
          模型 ID
          <input
            aria-label={model.model + " 模型 ID"}
            required
            maxLength={250}
            value={value.model}
            onChange={(e) => update("model", e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          显示名称
          <input
            aria-label={model.model + " 显示名称"}
            required
            maxLength={250}
            value={value.displayName}
            onChange={(e) => update("displayName", e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          初始接口
          <select
            aria-label={model.model + " 接口类型"}
            title={
                p.id === "official" ? "官方订阅接口固定为 Responses" : "未取得实测结果时的初始接口；注入时按模型检测结果自动选择"
            }
            value={value.wireApi}
            onChange={(e) => update("wireApi", e.target.value)}
            disabled={disabled}
          >
            {Object.entries(protocols)
              .filter(
                ([id]) => p.id !== "official" || id === "openai-responses",
              )
              .map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label>
          上下文长度
          <input
            aria-label={model.model + " 上下文长度"}
            type="number"
            min={4096}
            max={10000000}
            step={1}
            required
            value={value.contextWindow}
            onChange={(e) =>
              update(
                "contextWindow",
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            disabled={disabled}
          />
        </label>
        <label>
          默认思维强度
          <select
            aria-label={model.model + " 默认思维强度"}
            value={value.defaultEffort}
            onChange={(e) => update("defaultEffort", e.target.value)}
            disabled={disabled}
          >
            {value.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <footer>
        <div className="inline-model-meta">
          <label className="check-field small">
            <input
              type="checkbox"
              aria-label={model.model + " 启用"}
              checked={value.enabled !== false}
              onChange={(e) => update("enabled", e.target.checked)}
              disabled={disabled}
            />
            启用
          </label>
          <span>{value.efforts.join(" · ")}</span>
          <ModelProtocolBadges provider={p} model={model} state={state} />
          <span
            className={
              diagnostic ? (diagnostic.ok ? "success" : "danger") : "muted"
            }
          >
            {diagnostic
              ? `${diagnostic.ok ? "连接通过" : "连接失败"} · ${Math.round(diagnostic.ms)} ms`
              : capabilityText(state, p, model)}
          </span>
          {diagnostic && <DiagnosticTime result={diagnostic} />}
        </div>
        <div className="actions">
          {dirty ? (
            <>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  discard();
                  setError("");
                }}
                disabled={disabled}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={disabled}
              >
                <Check size={14} />
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          ) : (
            <>
              <ModelCheckButton provider={p} {...{ model, state, act, busy }} />
              <button
                type="button"
                className="model-icon"
                aria-label={"模型详情 " + model.model}
                title="模型详情"
                onClick={onDetails}
                disabled={disabled}
              >
                <Settings2 size={17} />
              </button>
              <button
                type="button"
                ref={deleteButton}
                className="model-icon delete-model"
                aria-label={"删除模型 " + model.model}
                title="删除模型"
                onClick={() => {
                  setError("");
                  setDeleting(structuredClone(model));
                }}
                disabled={disabled}
              >
                <Trash2 size={17} />
              </button>
            </>
          )}
        </div>
      </footer>
      {deleting && (
        <Modal
          title="删除此模型？"
          className="model-delete-confirm"
          anchorRef={deleteButton}
          closeButton={false}
          dismissible={!saving}
          onClose={() => setDeleting(null)}
          fallbackFocus={() =>
            document.querySelector(
              '.provider-model-dialog input[aria-label="搜索已配置模型"]',
            )
          }
        >
          <p className="delete-target">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{deleting.model}</span>
          </p>
          {error && (
            <p className="inline-model-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              type="button"
              className="button"
              data-autofocus
              disabled={saving}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger"
              disabled={saving}
              onClick={remove}
            >
              {saving ? "删除中…" : "确定"}
            </button>
          </footer>
        </Modal>
      )}
      {error && !deleting && (
        <p className="inline-model-error" role="alert">
          {error}
        </p>
      )}
      {message && !dirty && (
        <span className="inline-model-saved" role="status">
          {message}
        </span>
      )}
    </form>
  );
}
export function Providers({
  state,
  providers,
  act,
  busy,
  activeProvider,
  onOpenProvider,
  onBack,
}) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [modelSearch, setModelSearch] = useState(""),
    [editor, setEditor] = useState(null),
    [providerEditor, setProviderEditor] = useState(null),
    [directory, setDirectory] = useState(null),
    [drafts, setDrafts] = useState({});
  const gallerySearch = useRef(null),
    cardButtons = useRef(new Map());
  const [ordering, setOrdering] = useState(false),
    [orderError, setOrderError] = useState("");
  const all = orderProviders(
    state.modelSources || providers,
    state.preferences.providerOrder,
  );
  const matches = all.filter(
    (p) =>
      (filter === "all" ||
        (filter === "native"
          ? p.readOnly || p.id === "official"
          : !p.readOnly && p.id !== "official")) &&
      `${p.name} ${p.models.map((m) => m.model + " " + m.displayName).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const p = all.find((p) => p.id === activeProvider);
  const accountClient = p?.nativeAccountId
    ? state.harnesses.clients.find((client) => client.id === p.id.slice(7))
    : null;
  const nativeAccount = accountClient?.accounts.find((account) => account.id === p.nativeAccountId);
  const dragProps = useProviderDrag({
    ids: all.map((p) => p.id),
    visibleIds: matches.map((p) => p.id),
    disabled: ordering,
    onReorder: async (providerOrder) => {
      setOrdering(true);
      setOrderError("");
      try {
        await api.call("ui-preferences", { providerOrder });
      } catch {
        setOrderError("排序保存失败，已保留原顺序");
      } finally {
        setOrdering(false);
      }
    },
  });
  const sideOpen = !!(editor || directory || providerEditor);
  const revision = state.modelDirectoryRevisions?.[p?.id] || 0;
  useEffect(() => {
    if (p && !p.nativeAccountId && (p.readOnly || p.hasKey || p.id === "official"))
      api.call("models-discover", p.id).catch(() => {});
  }, [p?.id, p?.hasKey, p?.readOnly, p?.nativeAccountId, revision]);
  const directoryProvider = all.find((p) => p.id === directory);
  function select(p) {
    onOpenProvider(p.id);
    setModelSearch("");
  }
  function editDraft(m, key, value) {
    const id = modelKey(p.id, m.model);
    setDrafts((old) => ({
      ...old,
      [id]: {
        original: old[id]?.original || m,
        value: { ...(old[id]?.value || m), [key]: value },
      },
    }));
  }
  function discard(m) {
    const id = modelKey(p.id, m.model);
    setDrafts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  }
  return (
    <>
      <section className="provider-gallery" aria-label="供应商卡片">
        <div className="inventory-toolbar page-action-bar">
          <label className="search">
            <Search size={16} />
            <input
              ref={gallerySearch}
              aria-label="搜索供应商或模型"
              placeholder="搜索供应商或模型"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select
            aria-label="来源筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部来源</option>
            <option value="api">API 供应商</option>
            <option value="native">订阅 / 原生目录</option>
          </select>
          <span>
            {all.reduce((n, p) => n + p.models.length, 0)} 个模型 · {all.length}{" "}
            个来源
          </span>
          <div className="page-actions">
            <button className="button primary" onClick={() => setProviderEditor({})}>
              <Plus size={15} />
              添加供应商
            </button>
          </div>
        </div>
        {orderError && (
          <p className="danger" role="alert">
            {orderError}
          </p>
        )}
        <div className="supplier-grid">
          {matches.map((source) => (
            <SourceCard
              key={source.id}
              p={source}
              dragProps={dragProps(source.id)}
              {...{ state, act, busy }}
              onSelect={() => select(source)}
              buttonRef={(button) => {
                if (button) cardButtons.current.set(source.id, button);
                else cardButtons.current.delete(source.id);
              }}
              draftCount={
                source.models.filter(
                  (m) => drafts[modelKey(source.id, m.model)],
                ).length
              }
              onEdit={() => setProviderEditor({ provider: source })}
            />
          ))}
        </div>
        {!matches.length && (
          <div className="empty">
            <Layers size={25} />
            <p>{all.length ? "没有匹配的供应商或模型" : "还没有模型来源"}</p>
            <button className="button" onClick={() => setProviderEditor({})}>
              添加供应商
            </button>
          </div>
        )}
      </section>
      {p?.nativeAccountId && (
        <Modal
          title={p.name + " · 账户"}
          description="Antigravity 原生 OAuth"
          onClose={onBack}
          fallbackFocus={() => cardButtons.current.get(p.id) || gallerySearch.current}
        >
          {nativeAccount ? (
            <AccountProfile account={nativeAccount} client={accountClient} {...{ state, act, busy }} />
          ) : <p className="muted">账户已变更，请重新打开供应商。</p>}
        </Modal>
      )}
      {p && !p.nativeAccountId && (
        <Modal
          title={p.name + " · 模型"}
          description={p.baseUrl || p.catalogSource || "原生客户端目录"}
          className={"provider-model-dialog" + (sideOpen ? " side-open" : "")}
          onClose={onBack}
          fallbackFocus={() =>
            cardButtons.current.get(p.id) || gallerySearch.current
          }
        >
          <div className="provider-dialog-toolbar">
            <span className="tag">
              {p.readOnly
                ? "只读目录"
                : p.enabled === false
                  ? "已停用"
                  : "已启用"}
            </span>
            {!p.readOnly && p.id !== "official" && (
              <>
                <button
                  className="button"
                  onClick={() => setProviderEditor({ provider: p })}
                  disabled={!!busy}
                >
                  <Settings2 size={15} />
                  供应商设置
                </button>
                <ProviderActions
                  {...{ p, act, busy }}
                  onEdit={() => setProviderEditor({ provider: p })}
                />
              </>
            )}
          </div>
          <section
            className="configured-models"
            aria-label={p.name + " 模型配置"}
          >
            <div className="section-heading">
              <div>
                <h2>
                  {p.readOnly ? "原生客户端模型" : "已配置模型"}
                  <span className="count">{p.models.length}</span>
                </h2>
                {p.readOnly && (
                  <p className="catalog-caption">{p.catalogSource}</p>
                )}
              </div>
              <div className="actions">
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label="搜索已配置模型"
                    placeholder="搜索模型"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                  />
                </label>
                {p.readOnly && (
                  <button
                    className="button"
                    disabled={!!state.modelDirectoryJobs[p.id]}
                    onClick={() =>
                      act("native-catalog", () =>
                        api.call("models-discover", p.id, true),
                      )
                    }
                  >
                    <RefreshCw
                      size={14}
                      className={
                        state.modelDirectoryJobs[p.id] ? "spin" : undefined
                      }
                    />
                    刷新目录
                  </button>
                )}
                {!p.readOnly && (
                  <>
                    <button
                      className="button"
                      onClick={() => setDirectory(p.id)}
                    >
                      <Search size={14} />
                      发现模型
                    </button>
                    {p.id !== "official" && (
                      <button
                        className="button primary"
                        onClick={() => setEditor({ provider: p, model: null })}
                      >
                        <Plus size={14} />
                        手动添加
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {!p.readOnly && (
              <p className="catalog-caption catalog-state" role="status">
                {state.modelDirectoryJobs[p.id]
                  ? "正在读取供应商模型目录…"
                  : state.providerModels[p.id]?.error
                    ? "模型目录读取失败，可在“发现模型”中重试。"
                    : state.providerModels[p.id]
                      ? `已读取 ${state.providerModels[p.id].models.length} 个可用模型，可在“发现模型”中添加。`
                      : p.hasKey || p.id === "official"
                        ? "尚未读取目录"
                        : "填写 API Key 后自动读取模型目录"}
              </p>
            )}
            {p.readOnly &&
              (p.catalogError || state.modelDirectoryJobs[p.id]) && (
                <p className="catalog-caption" role="status">
                  {state.modelDirectoryJobs[p.id]
                    ? "正在读取原生账户模型目录…"
                    : p.catalogError}
                </p>
              )}
            {p.readOnly && p.entitlementNotice && (
              <p className="catalog-caption" role="status">{p.entitlementNotice}</p>
            )}
            {!p.models.length && (
              <p className="supplier-empty">
                {p.readOnly
                  ? "没有可读取的本机目录，请在原生客户端查看可用模型。"
                  : "从“发现模型”中添加，或手动配置模型。"}
              </p>
            )}
            {!!p.models.length &&
              !p.models.some((m) =>
                `${m.model} ${m.displayName}`
                  .toLowerCase()
                  .includes(modelSearch.toLowerCase()),
              ) && <p className="supplier-empty">没有匹配的模型</p>}
            {p.models
              .filter((m) =>
                `${m.model} ${m.displayName}`
                  .toLowerCase()
                  .includes(modelSearch.toLowerCase()),
              )
              .map((m) =>
                p.readOnly ? (
                  <div
                    className="native-model-row"
                    key={modelKey(m.diagnosticProviderId || p.id, m.model)}
                  >
                    <div>
                      <strong>{m.displayName || m.model}</strong>
                      <small>
                        {m.nativeProvider ? m.nativeProvider + " / " : ""}
                        {m.model}
                      </small>
                      {m.nativeAccountLabel && <small>{m.nativeAccountLabel}</small>}
                    </div>
                    <span>
                      {protocols[m.wireApi] || m.wireApi || "原生协议"}
                    </span>
                    <span>上下文 {number(m.contextWindow)}</span>
                    <span>{m.efforts?.join(" · ") || "思维档位未声明"}</span>
                    <div className="native-model-check">
                      <ModelCheckButton provider={p} model={m} {...{ state, act, busy }} />
                      {state.diagnostics[modelKey(m.diagnosticProviderId || p.id, m.model)] && (
                        <DiagnosticTime result={state.diagnostics[modelKey(m.diagnosticProviderId || p.id, m.model)]} />
                      )}
                    </div>
                  </div>
                ) : (
                  <InlineModel
                    key={modelKey(p.id, m.model)}
                    p={p}
                    model={m}
                    draft={drafts[modelKey(p.id, m.model)]}
                    change={(k, v) => editDraft(m, k, v)}
                    discard={() => discard(m)}
                    {...{ state, act, busy }}
                    onDetails={() => setEditor({ provider: p, model: m })}
                  />
                ),
              )}
          </section>
        </Modal>
      )}
      {directoryProvider && (
        <Modal
          title={directoryProvider.name + " · 发现模型"}
          className="provider-side-dialog"
          onClose={() => setDirectory(null)}
        >
          <ProviderModelCatalog
            key={directoryProvider.id}
            provider={directoryProvider}
            {...{ state, act, busy }}
          />
        </Modal>
      )}
      {editor && (
        <ModelEditor
          {...editor}
          className="provider-side-dialog"
          capabilities={
            editor.model && (
              <ModelCapabilities {...editor} {...{ state, act, busy }} />
            )
          }
          onClose={() => setEditor(null)}
          onSave={(m) =>
            api.call(
              "save-model",
              editor.provider.id,
              m,
              editor.model?.model,
              editor.model || undefined,
            )
          }
        />
      )}
      {providerEditor && (
        <ProviderEditor
          presets={state.providerPresets}
          balancePresets={state.balancePresets}
          provider={providerEditor.provider}
          className={p ? "provider-side-dialog" : undefined}
          onClose={() => setProviderEditor(null)}
          onSave={(m) => api.call("save-provider", m)}
        />
      )}
    </>
  );
}
