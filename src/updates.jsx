import React from "react";
import { AssLogo } from "./ass-logo.jsx";
import {
  ArrowUpRight,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  X,
  BellRing,
  Loader2,
  ExternalLink,
} from "./icons.jsx";
import "./updates.css";
const api = window.ass;
const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未检查";
export function UpdateBanner({ updates, onView, act }) {
  if (!updates.notify) return null;
  return (
    <section className="update-banner" aria-label="ASS 新版本提示">
      <BellRing size={19} />
      <div>
        <strong>ASS v{updates.latest.version} 已发布</strong>
        <span>
          {updates.status === "cached" || updates.status === "error"
            ? "上次检查发现的版本 · "
            : ""}
        </span>
      </div>
      <button className="text-button" onClick={onView}>
        查看更新
        <ArrowUpRight size={14} />
      </button>
      <button
        className="icon-button"
        aria-label="稍后提醒此版本"
        title="收起此版本提示，关于页仍可查看"
        onClick={() => act("update-dismiss", () => api.call("update-dismiss"))}
      >
        <X size={16} />
      </button>
    </section>
  );
}
export function Updates({ state, act, busy }) {
  const u = state.updates,
    latest = u.latest,
    checking = u.status === "checking";
  const title = checking
    ? "正在检查 ASS 新版本…"
    : u.status === "error"
      ? "暂时无法检查更新"
      : u.available
        ? `ASS v${latest.version} 可供更新`
        : u.lastCheckedAt
          ? latest
            ? "当前版本无需更新"
            : "此更新渠道暂无发布版本"
          : "检查 ASS 更新";
  const open = (kind) =>
    act("update-open", () => api.call("update-open", kind));
  return (
    <div className="updates-page">
      <section className="ass-brand-hero">
        <AssLogo />
        <div>
          <div className="ass-wordmark">
            ASS<span>v{state.version}</span>
          </div>
          <p>Agent-Switching-Servant</p>
        </div>
      </section>
      <section className="update-card" aria-label="软件更新">
        <div className="update-card-heading">
          <div
            className={
              "update-status-icon " + (u.status === "error" ? "warning" : "")
            }
          >
            {checking ? (
              <Loader2 size={23} className="spin" />
            ) : u.status === "error" ? (
              <AlertCircle size={23} />
            ) : u.available ? (
              <Download size={23} />
            ) : (
              <CheckCircle2 size={23} />
            )}
          </div>
          <div className="update-status-copy" role="status">
            <h2>{title}</h2>
            {u.status === "error" && <p>{u.message}</p>}
            {u.status === "cached" && <p>上次检查结果</p>}
          </div>
          <button
            className="button"
            disabled={checking || !!busy}
            onClick={() => act("update-check", () => api.call("update-check"))}
          >
            {checking ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}
            检查更新
          </button>
        </div>
        <div className="update-meta">
          <span>
            当前版本 <strong>v{state.version}</strong>
          </span>
          <span>
            上次成功检查 <strong>{date(u.lastCheckedAt)}</strong>
          </span>
          {u.retryAt > 0 && (
            <span>
              限流重试 <strong>{date(u.retryAt)}</strong>
            </span>
          )}
        </div>
        <div className="update-preferences">
          <label className="update-toggle">
            <span><strong>开机启动</strong></span>
            <input type="checkbox" role="switch" aria-label="开机启动" checked={state.autoStart} disabled={!!busy}
              onChange={(e) => act("auto", () => api.call("autostart", e.target.checked))} />
          </label>
          <label className="update-toggle">
            <span>
              <strong>自动检查更新</strong>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="自动检查更新"
              checked={u.automatic}
              disabled={!!busy && !checking}
              onChange={(e) =>
                act("update-preferences", () =>
                  api.call("update-preferences", {
                    automatic: e.target.checked,
                  }),
                )
              }
            />
          </label>
          <label className="update-toggle">
            <span>
              <strong>包含预览版本</strong>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="包含预览版本"
              checked={u.includePreview}
              disabled={!!busy && !checking}
              onChange={(e) =>
                act("update-preferences", () =>
                  api.call("update-preferences", {
                    includePreview: e.target.checked,
                  }),
                )
              }
            />
          </label>
        </div>
        {u.available && (
          <div className="release-panel">
            <div className="section-heading">
              <div>
                <h3>
                  ASS v{latest.version}{" "}
                  <span className="tag">
                    {latest.prerelease ? "预览版" : "正式版"}
                  </span>
                </h3>
                <p className="hint">
                  {latest.publishedAt
                    ? date(latest.publishedAt) + " 发布"
                    : "已发布"}
                  {latest.download
                    ? ` · Windows x64 · ${(latest.download.size / 1024 / 1024).toFixed(1)} MiB`
                    : " · 暂无已上传完成的 Windows 安装包"}
                </p>
              </div>
            </div>
            <div className="release-notes">
              {latest.notes || "此版本未附发布说明，请在 GitHub 发布页查看。"}
            </div>
            <div className="actions">
              <button
                className="button primary"
                disabled={!latest.download}
                onClick={() => open("download")}
              >
                <Download size={15} />
                下载 Windows 版
              </button>
              <button className="button" onClick={() => open("release")}>
                <ExternalLink size={15} />
                发布说明
              </button>
              {latest.checksum && (
                <button
                  className="text-button"
                  onClick={() => open("checksum")}
                >
                  校验文件
                  <ArrowUpRight size={13} />
                </button>
              )}
            </div>
            {latest.download?.sha256 && (
              <details className="release-digest">
                <summary>查看发布包 SHA-256</summary>
                <code>{latest.download.sha256}</code>
                <p>
                  来自 GitHub
                  发布元数据；下载后请核对文件，不代表已在本机完成校验。
                </p>
              </details>
            )}
          </div>
        )}
        <div className="update-safety">
          <ShieldCheck size={18} />
          <p>
            只检查版本，不上传账户、密钥或模型配置；跟随 Windows 系统代理并保留
            TLS 校验。下载在浏览器中完成，不静默安装，也不自动重启
            ASS。更新前先等待路由请求结束，再从托盘退出旧版。
          </p>
        </div>
      </section>
      <footer className="ass-about-footer">
        <button className="text-button" onClick={() => open("releases")}>
          所有发布版本
          <ArrowUpRight size={14} />
        </button>
      </footer>
    </div>
  );
}
