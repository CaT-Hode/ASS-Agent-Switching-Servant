import React, { useMemo, useState } from "react";
import { ChevronRight, RefreshCw, Terminal, MessagesSquare } from "./icons.jsx";
import { usageModelName } from "./usage-view.mjs";

const api = window.ass;

function groupCliModels(models = []) {
  const groups = new Map();
  for (const m of models) {
    const id = usageModelName(m.id, "antigravity");
    const label = usageModelName(m.label || m.id, "antigravity");
    const existing = groups.get(id);
    if (existing) {
      if (!existing.variants.includes(m.id)) existing.variants.push(m.id);
    } else {
      groups.set(id, { id, label, variants: [m.id] });
    }
  }
  return [...groups.values()];
}

export function AntigravityPanel({ client, act, busy }) {
  const [cliInfo, setCliInfo] = useState(null);
  const [cliError, setCliError] = useState("");
  const [loadingCli, setLoadingCli] = useState(false);

  const [convs, setConvs] = useState(null);
  const [convError, setConvError] = useState("");
  const [loadingConvs, setLoadingConvs] = useState(false);
  const groupedCliModels = useMemo(() => groupCliModels(cliInfo?.models), [cliInfo?.models]);

  const loadCli = async () => {
    setLoadingCli(true);
    setCliError("");
    try {
      setCliInfo(await api.call("antigravity-cli-info"));
    } catch (error) {
      setCliError(error.message || "无法读取 Antigravity CLI 信息");
    } finally {
      setLoadingCli(false);
    }
  };

  const loadConvs = async () => {
    setLoadingConvs(true);
    setConvError("");
    try {
      setConvs(await api.call("antigravity-conversations"));
    } catch (error) {
      setConvError(error.message || "无法读取 Antigravity 会话列表");
    } finally {
      setLoadingConvs(false);
    }
  };

  return (
    <section className="agy-panel" aria-label="Antigravity 原生目录与会话">
      {client.launcher?.ready && (
        <details
          className="agy-disclosure"
          onToggle={(e) => {
            if (e.currentTarget.open && !cliInfo && !loadingCli) void loadCli();
          }}
        >
          <summary>
            <span>原生 CLI 模型目录{cliInfo?.version ? ` · v${cliInfo.version}` : ""}</span>
            <ChevronRight size={15} className="provider-disclosure" />
          </summary>
          <div className="agy-disclosure-body">
            <div className="agy-disclosure-toolbar">
              {cliInfo?.currentModel ? (
                <small>
                  当前默认：{cliInfo.currentModel.label}
                  {cliInfo.effort?.current ? ` · 思维 ${cliInfo.effort.current}` : ""}
                </small>
              ) : (
                <small>只读查询 agy models / /model / /effort（0 模型消耗）</small>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="刷新 Antigravity 原生模型"
                title="刷新原生模型目录"
                disabled={loadingCli}
                onClick={loadCli}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {cliError && <p className="error-box">{cliError}</p>}
            {groupedCliModels.length ? (
              <div className="agy-model-chips">
                {groupedCliModels.map((m) => (
                  <span
                    key={m.id}
                    title={m.variants.join(" / ")}
                    className={
                      cliInfo.currentModel?.id &&
                      (m.variants.includes(cliInfo.currentModel.id) ||
                        usageModelName(cliInfo.currentModel.id, "antigravity") === m.id)
                        ? "active"
                        : ""
                    }
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            ) : !loadingCli && !cliError ? (
              <small className="muted">暂无可显示的原生模型。</small>
            ) : null}
          </div>
        </details>
      )}

      <details
        className="agy-disclosure"
        onToggle={(e) => {
          if (e.currentTarget.open && !convs && !loadingConvs) void loadConvs();
        }}
      >
        <summary>
          <span>
            <MessagesSquare size={14} /> 本机会话列表（只读）{convs ? ` · ${convs.rows.length}` : ""}
          </span>
          <ChevronRight size={15} className="provider-disclosure" />
        </summary>
        <div className="agy-disclosure-body">
          <div className="agy-disclosure-toolbar">
            <small>只读读取 App / CLI 的 conversation_summaries.db；CLI 会话支持一键续聊，App 会话可在 CLI 内 /resume → Other 导入。</small>
            <button
              type="button"
              className="icon-button"
              aria-label="刷新 Antigravity 会话列表"
              title="刷新会话列表"
              disabled={loadingConvs}
              onClick={loadConvs}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {convError && <p className="error-box">{convError}</p>}
          {convs?.rows?.length ? (
            <div className="agy-conv-list">
              {convs.rows.slice(0, 30).map((row) => (
                <div key={row.id} className="agy-conv-row">
                  <div className="agy-conv-meta">
                    <strong>{row.title}</strong>
                    <small>
                      {row.surfaceLabel} · {row.stepCount} 步
                      {row.workspace ? ` · ${row.workspace}` : ""}
                    </small>
                  </div>
                  {row.canResume && client.launcher?.ready ? (
                    <button
                      type="button"
                      className="button"
                      disabled={!!busy}
                      onClick={() =>
                        act(
                          "antigravity-resume",
                          () => api.call("antigravity-resume", row.id, row.workspace),
                          "已打开 Antigravity CLI 续聊窗口",
                        )
                      }
                    >
                      <Terminal size={13} /> 续聊
                    </button>
                  ) : (
                    <span className="agy-conv-tag">只读</span>
                  )}
                </div>
              ))}
            </div>
          ) : !loadingConvs && !convError ? (
            <small className="muted">未检测到 Antigravity 本机会话记录。</small>
          ) : null}
        </div>
      </details>
    </section>
  );
}
