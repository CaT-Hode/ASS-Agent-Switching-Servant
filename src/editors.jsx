import React, { useState, useRef, useEffect, useId } from "react";
import {
  X,
  Loader2,
  Wallet,
  RotateCcw,
  Settings2,
  ScanSearch,
  ChevronDown,
} from "./icons.jsx";
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const protocols = {
  "openai-responses": "Responses",
  "openai-chat": "Chat Completions",
  anthropic: "Anthropic Messages",
};
function Button({ children, primary, busy, ...props }) {
  return (
    <button
      className={"button" + (primary ? " primary" : "")}
      disabled={busy}
      {...props}
    >
      {busy && <Loader2 className="spin" size={15} />} {children}
    </button>
  );
}
function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, {
        id,
        "aria-describedby": hint ? id + "-hint" : undefined,
      })}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function Modal({
  title,
  description,
  onClose,
  children,
  dismissible = true,
  className = "wide",
  closeButton = true,
  fallbackFocus,
  anchorRef,
}) {
  const ref = useRef(null),
    closing = useRef(false),
    outsidePointer = useRef(null);
  useEffect(() => {
    const el = ref.current,
      previous = document.activeElement;
    el.showModal();
    function position() {
      if (!anchorRef?.current) return;
      const anchor = anchorRef.current.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      const left = Math.max(
        12,
        Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 12),
      );
      const top =
        anchor.bottom + bounds.height + 8 <= innerHeight - 12
          ? anchor.bottom + 8
          : Math.max(12, anchor.top - bounds.height - 8);
      el.style.left = left + "px";
      el.style.top = top + "px";
    }
    position();
    const observer = anchorRef ? new ResizeObserver(position) : null;
    observer?.observe(el);
    if (anchorRef) window.addEventListener("resize", position);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const offset = el.classList.contains("provider-side-dialog")
      ? "translateX(12px)"
      : "translateY(6px) scale(.985)";
    const animation = el.animate(
      [
        {
          opacity: 0,
          transform: reduce ? "none" : offset,
        },
        { opacity: 1, transform: "none" },
      ],
      { duration: reduce ? 100 : 180, easing: "cubic-bezier(0.23,1,0.32,1)" },
    );
    el.querySelector("[data-autofocus],input,select")?.focus({
      preventScroll: true,
    });
    return () => {
      animation.cancel();
      observer?.disconnect();
      window.removeEventListener("resize", position);
      if (el.open) el.close();
      const target =
        previous?.isConnected && previous !== document.body
          ? previous
          : fallbackFocus?.();
      target?.focus?.({ preventScroll: true });
    };
  }, []);
  function close() {
    if (!dismissible) return;
    if (closing.current) return;
    closing.current = true;
    const el = ref.current,
      current = getComputedStyle(el);
    const from = { opacity: current.opacity, transform: current.transform };
    el.getAnimations().forEach((a) => a.cancel());
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const offset = el.classList.contains("provider-side-dialog")
      ? "translateX(12px)"
      : "translateY(6px) scale(.985)";
    el.animate(
      [
        from,
        {
          opacity: 0,
          transform: reduce ? "none" : offset,
        },
      ],
      {
        duration: reduce ? 80 : 130,
        easing: "cubic-bezier(0.23,1,0.32,1)",
        fill: "forwards",
      },
    )
      .finished.then(onClose)
      .catch(() => {});
  }
  function outside(e) {
    if (e.target !== ref.current) return false;
    const r = ref.current.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  }
  return (
    <dialog
      ref={ref}
      className={"modal " + className}
      aria-label={title}
      onPointerDown={(e) => {
        outsidePointer.current =
          e.button === 0 && outside(e) ? e.pointerId : null;
      }}
      onPointerCancel={() => {
        outsidePointer.current = null;
      }}
      onPointerUp={(e) => {
        const dismiss = outsidePointer.current === e.pointerId && outside(e);
        outsidePointer.current = null;
        if (!dismiss) return;
        // Keep the modal in the top layer until its exit finishes. This click
        // must not fall through to the parent dialog or close two levels.
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {closeButton && (
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={!dismissible}
            onClick={close}
          >
            <X size={19} />
          </button>
        )}
      </header>
      {children}
    </dialog>
  );
}
function Stops({ selected }) {
  return (
    <div className="effort-stops">
      {efforts.map((e, i) => (
        <span key={e} className={selected.includes(e) ? "active" : ""}>
          <i />
          {e}
        </span>
      ))}
    </div>
  );
}
function ModelDetailSection({
  title,
  icon: Icon,
  open,
  onToggle,
  disabled,
  children,
}) {
  const id = useId();
  if (!title) return children;
  return (
    <section className="model-detail-section">
      <h3>
        <button
          type="button"
          className="model-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          disabled={disabled}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{title}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </h3>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
export function ModelEditor({
  provider,
  model,
  onSave,
  onClose,
  className,
  capabilities,
}) {
  const [section, setSection] = useState("configuration");
  const [draft, setDraft] = useState(() =>
    model
      ? structuredClone(model)
      : {
          model: "",
          displayName: "",
          wireApi: provider.wireApi || "openai-responses",
          contextWindow: 272000,
          contextSource: "输入模型名称后自动匹配",
          efforts: efforts.slice(0, 5),
          defaultEffort: "medium",
          maxOutputTokens: 131072,
          enabled: true,
        },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [allowUltra, setAllowUltra] = useState(
      () => model?.efforts.includes("ultra") || false,
    );
  const pending = useRef(0);
  useEffect(() => () => { pending.current++; }, []);
  const dirty = !!model && JSON.stringify(draft) !== JSON.stringify(model);
  const gpt = draft.model.split("/").at(-1).toLowerCase().startsWith("gpt");
  const ceiling = gpt || allowUltra ? 5 : 4;
  const indexes = draft.efforts.map((e) => efforts.indexOf(e)),
    low = Math.min(...indexes),
    high = Math.max(...indexes);
  const set = (key, value) => { pending.current++; setError(''); setDraft((d) => ({ ...d, [key]: value })); };
  function selected(list) {
    if (!list.length) return;
    pending.current++;
    setDraft((d) => ({
      ...d,
      efforts: list,
      defaultEffort: list.includes(d.defaultEffort) ? d.defaultEffort : list[0],
    }));
  }
  function range(from, to) {
    selected(efforts.slice(from, to + 1));
  }
  async function reset() {
    if (!draft.model.trim()) return;
    const request = ++pending.current;
    try {
      const d = await window.ass.call("model-defaults", provider, draft.model);
      if (request === pending.current) {
        setDraft((old) => ({
          ...old,
          ...d,
          displayName: old.displayName || d.displayName,
        }));
        setAllowUltra(d.efforts.includes("ultra"));
      }
    } catch (e) {
      if (request === pending.current) setError(e.message);
    }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ ...draft, displayName: draft.displayName || draft.model });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={model ? "模型详情" : "添加模型"}
      description={provider.name + (model ? " / " + model.model : "")}
      className={className}
      dismissible={!busy}
      onClose={onClose}
    >
      <ModelDetailSection
        title={capabilities ? "配置" : undefined}
        icon={Settings2}
        open={section === "configuration"}
        onToggle={() =>
          setSection(section === "configuration" ? null : "configuration")
        }
        disabled={busy}
      >
        <form onSubmit={save}>
          <div className="form-grid">
            <Field label="模型 ID">
              <input
                required
                value={draft.model}
                onChange={(e) => set("model", e.target.value)}
                onBlur={() => {
                  if (!model) reset();
                }}
                placeholder="例如 xiaomi/mimo-x-pro-preview"
              />
            </Field>
            <Field label="显示名称">
              <input
                value={draft.displayName}
                onChange={(e) => set("displayName", e.target.value)}
              />
            </Field>
            <Field label="初始接口（注入时自动检测）">
              <select
                value={draft.wireApi}
                disabled={provider.id === "official"}
                onChange={(e) => set("wireApi", e.target.value)}
              >
                {Object.entries(protocols).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="最大输出 tokens（默认 128K）">
              <input
                type="number"
                min="1024"
                max={draft.contextWindow}
                value={draft.maxOutputTokens}
                onChange={(e) => set("maxOutputTokens", Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="form-section">
            <div className="section-heading">
              <h3>上下文窗口</h3>
              <button
                type="button"
                className="text-button"
                disabled={!draft.model}
                onClick={reset}
              >
                <RotateCcw size={13} />
                {provider.id === "official"
                  ? "恢复本机目录默认"
                  : "恢复模型默认值"}
              </button>
            </div>
            <div className="context-input">
              <input
                aria-label="上下文 tokens"
                type="number"
                min="4096"
                max="10000000"
                value={draft.contextWindow}
                onChange={(e) => {
                  pending.current++;
                  setDraft((d) => ({
                    ...d,
                    contextWindow: Number(e.target.value),
                    maxOutputTokens: Math.min(d.maxOutputTokens, Number(e.target.value) || d.maxOutputTokens),
                    contextSource: "手动配置",
                  }));
                }}
              />
              <span>tokens</span>
            </div>
            <p className="hint">
              来源：{draft.contextSource}。默认规则不是上游能力承诺。
            </p>
          </div>
          <div className="form-section">
            <div className="section-heading">
              <h3>可选思维强度范围</h3>
              <span className="range-value">
                {efforts[low]} — {efforts[high]}
              </span>
            </div>
            <p className="hint">
              拖动两端选择进入 Codex 菜单的范围；实际支持以供应商响应为准。
            </p>
            <div className="range-control">
              <div className="range-rail">
                <i
                  style={{
                    left: (low / 5) * 100 + "%",
                    width: ((high - low) / 5) * 100 + "%",
                  }}
                />
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="1"
                value={low}
                aria-label="最低可选强度"
                aria-valuetext={efforts[low]}
                onChange={(e) =>
                  range(Math.min(Number(e.target.value), high), high)
                }
              />
              <input
                type="range"
                min="0"
                max="5"
                step="1"
                value={high}
                aria-label="最高可选强度"
                aria-valuetext={efforts[high]}
                onChange={(e) =>
                  range(
                    low,
                    Math.max(low, Math.min(Number(e.target.value), ceiling)),
                  )
                }
              />
            </div>
            <Stops selected={draft.efforts} />
            {!gpt && (
              <label className="check-field ultra-opt">
                <input
                  type="checkbox"
                  checked={allowUltra}
                  onChange={(e) => {
                    pending.current++;
                    setAllowUltra(e.target.checked);
                    if (!e.target.checked)
                      selected(
                        draft.efforts.filter((x) => x !== "ultra").length
                          ? draft.efforts.filter((x) => x !== "ultra")
                          : ["max"],
                      );
                  }}
                />
                允许非 GPT 模型使用 ultra（默认关闭，需上游支持）
              </label>
            )}
            <details className="effort-details">
              <summary>逐项选择（非连续范围）</summary>
              <div className="effort-options">
                {efforts.map((e, i) => (
                  <label
                    key={e}
                    className={draft.efforts.includes(e) ? "selected" : ""}
                  >
                    <input
                      type="checkbox"
                      aria-label={"启用 " + e}
                      disabled={i > ceiling}
                      checked={draft.efforts.includes(e)}
                      onChange={() =>
                        selected(
                          draft.efforts.includes(e)
                            ? draft.efforts.filter((x) => x !== e)
                            : efforts.filter(
                                (x) => draft.efforts.includes(x) || x === e,
                              ),
                        )
                      }
                    />
                    {e}
                  </label>
                ))}
              </div>
            </details>
            <div className="default-effort-heading">
              <label htmlFor="default-effort">默认思维强度</label>
              <strong>{draft.defaultEffort}</strong>
            </div>
            <input
              id="default-effort"
              className="single-range"
              type="range"
              min="0"
              max={draft.efforts.length - 1}
              step="1"
              value={Math.max(0, draft.efforts.indexOf(draft.defaultEffort))}
              aria-valuetext={draft.defaultEffort}
              onChange={(e) =>
                set("defaultEffort", draft.efforts[Number(e.target.value)])
              }
            />
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            在模型菜单中启用
          </label>
          {error && <p className="error-box">{error}</p>}
          <footer>
            <Button type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button primary busy={busy} type="submit">
              保存模型
            </Button>
          </footer>
        </form>
      </ModelDetailSection>
      {capabilities && (
        <ModelDetailSection
          title="能力与检测"
          icon={ScanSearch}
          open={section === "capabilities"}
          onToggle={() =>
            setSection(section === "capabilities" ? null : "capabilities")
          }
          disabled={busy}
        >
          {dirty && (
            <p className="hint" role="status">
              修改尚未保存；检测仍使用已保存的 {model.model} 配置。
            </p>
          )}
          {capabilities}
        </ModelDetailSection>
      )}
    </Modal>
  );
}
export function ProviderEditor({
  provider,
  initialPreset,
  presets = [],
  balancePresets = [],
  onSave,
  onClose,
  className,
}) {
  const [draft, setDraft] = useState(() =>
    provider
      ? {
          ...provider,
          apiKey: "",
          extraHeaders: undefined,
          balance: { preset: "auto", ...provider.balance },
        }
      : {
          name: "",
          baseUrl: "",
          wireApi: "openai-chat",
          brand: "generic",
          network: "system",
          apiKey: "",
          models: [],
          enabled: true,
          balance: {
            preset: "auto",
            path: "",
            field: "",
            unit: "",
            scale: 1,
            auth: "bearer",
          },
          ...initialPreset,
          id: undefined,
        },
  );
  const [tab, setTab] = useState("general"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const bal = (k, v) =>
    setDraft((d) => ({ ...d, balance: { ...d.balance, [k]: v } }));
  const preset = balancePresets.find((x) => x.id === draft.balance.preset);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        provider ? "供应商设置" : initialPreset ? "添加 API 账户" : "添加供应商"
      }
      description="连接、凭据与余额接口"
      className={className}
      onClose={onClose}
      dismissible={!busy}
    >
      <div className="tabs">
        <button
          className={tab === "general" ? "active" : ""}
          onClick={() => setTab("general")}
        >
          连接配置
        </button>
        <button
          className={tab === "balance" ? "active" : ""}
          onClick={() => setTab("balance")}
        >
          余额接口
        </button>
      </div>
      <form onSubmit={save}>
        {tab === "general" ? (
          <>
            {!provider && (
              <Field label="供应商预设">
                <select
                  defaultValue={initialPreset?.id || ""}
                  onChange={(e) => {
                    const p = presets.find((x) => x.id === e.target.value);
                    if (p) setDraft((d) => ({ ...d, ...p, id: undefined }));
                  }}
                >
                  <option value="">自定义供应商</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="form-grid">
              <Field label="供应商名称">
                <input
                  required
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="默认协议">
                <select
                  value={draft.wireApi}
                  onChange={(e) => set("wireApi", e.target.value)}
                >
                  {Object.entries(protocols).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="API 基础地址"
              hint="远程地址必须使用 HTTPS；更改域名后需重新填写 Key。"
            >
              <input
                type="url"
                required
                value={draft.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
              />
            </Field>
            <Field
              label="API Key"
              hint={
                provider?.hasKey
                  ? "已有密钥，留空保持不变。保存后由 Windows 加密。"
                  : "仅在本机加密保存，不写入请求日志。"
              }
            >
              <input
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={provider?.hasKey ? "•••••••• 已保存" : ""}
                onChange={(e) => set("apiKey", e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="网络出口">
                <select
                  value={draft.network}
                  onChange={(e) => set("network", e.target.value)}
                >
                  <option value="system">跟随系统代理</option>
                  <option value="direct">直接连接</option>
                  <option value="direct-doh">直接连接 · HTTPS DNS（仅此供应商）</option>
                </select>
              </Field>
              <Field
                label="额外请求头（JSON，可选）"
                hint="留空保留现有头；填 {} 清除。"
              >
                <input
                  placeholder={'{"X-Custom":"value"}'}
                  value={
                    typeof draft.extraHeaders === "string"
                      ? draft.extraHeaders
                      : ""
                  }
                  onChange={(e) =>
                    set("extraHeaders", e.target.value || undefined)
                  }
                />
              </Field>
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              启用此供应商
            </label>
          </>
        ) : (
          <>
            <div className="info-box">
              <Wallet size={20} />
              <div>
                余额 / 用量预设
                <small>
                  全部使用当前供应商同源 GET 请求；不跨域、不跟随重定向。
                </small>
              </div>
            </div>
            <Field label="余额接口预设">
              <select
                value={draft.balance.preset}
                onChange={(e) => {
                  const p = balancePresets.find((x) => x.id === e.target.value);
                  set("balance", {
                    preset: p.id,
                    path: p.path,
                    field: p.field,
                    unit: p.unit,
                    scale: p.scale || 1,
                    auth: "bearer",
                  });
                }}
              >
                {balancePresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            {preset?.description && (
              <p className="hint">{preset.description}</p>
            )}
            {draft.balance.preset !== "auto" && (
              <>
                <Field label="余额接口路径">
                  <input
                    readOnly={draft.balance.preset !== "custom"}
                    value={draft.balance.path}
                    onChange={(e) => bal("path", e.target.value)}
                  />
                </Field>
                <Field
                  label="余额字段路径"
                  hint="自定义支持点号嵌套和数组索引，例如 data.balance。"
                >
                  <input
                    readOnly={draft.balance.preset !== "custom"}
                    value={draft.balance.field}
                    onChange={(e) => bal("field", e.target.value)}
                  />
                </Field>
              </>
            )}
            {draft.balance.preset === "custom" && (
              <div className="form-grid">
                <Field label="显示币种 / 单位">
                  <input
                    value={draft.balance.unit}
                    onChange={(e) => bal("unit", e.target.value)}
                  />
                </Field>
                <Field label="换算系数">
                  <input
                    type="number"
                    step="any"
                    min="0.000000001"
                    value={draft.balance.scale}
                    onChange={(e) => bal("scale", Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
            <Field label="余额接口认证">
              <select
                value={draft.balance.auth || "bearer"}
                onChange={(e) => bal("auth", e.target.value)}
              >
                <option value="bearer">Authorization: Bearer（默认）</option>
                <option value="x-api-key">x-api-key</option>
              </select>
            </Field>
          </>
        )}
        {error && <p className="error-box">{error}</p>}
        <footer>
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button primary busy={busy} type="submit">
            保存供应商
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
