import React, { useId, useState } from "react";
import { Play, Loader2 } from "./icons.jsx";

export function CodexDesktopLaunch({ desktop, connection, busy, onLaunch }) {
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false),
    [dismissed, setDismissed] = useState(false);
  const showTip = (hovered || focused) && !dismissed;
  const officialRelay = connection?.enabled && !connection.accountless;
  const opening = busy === "client-open-desktop";
  const unavailable = connection?.accountless && !connection.accountlessAvailable;
  return <div className="codex-desktop-launch" role="group" aria-label="Codex 启动与连接修复"
    onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => { setFocused(true); setDismissed(false); }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }} onKeyDown={(event) => { if (event.key === "Escape") setDismissed(true); }}>
    <button type="button" className="button primary codex-launch-button"
      disabled={!!busy || unavailable} aria-busy={opening}
      aria-label={opening ? "正在打开 Codex…" : "通过 ASS 启动 Codex"}
      aria-describedby={tooltipId} onClick={onLaunch}>
      {opening ? <Loader2 size={16} className="spin" /> : <Play size={15} fill="currentColor" data-motion-icon={undefined} />}
      {opening ? "正在打开…" : "启动 Codex"}
    </button>
    <div id={tooltipId} role="tooltip" className="codex-launch-tooltip" hidden={!showTip}>
    <div className="codex-launch-copy">
      <h3>{officialRelay ? "启动与连接修复" : "启动 Codex 桌面端"}</h3>
      {officialRelay ? <>
        <p>通过 ASS 启动，启用官方服务 HTTPS 通道，可尝试修复：</p>
        <ul className="codex-launch-issues">
          <li>Couldn’t load workspace settings</li>
          <li>Could not load project chats</li>
        </ul>
      </> : <p>{connection?.accountless
        ? "按已注入的无账号配置启动，不使用官方 OAuth。"
        : "当前未开启接入，仅打开原生客户端；开启接入后可使用官方服务连接修复通道。"}</p>}
    </div>
    {unavailable && <p className="codex-launch-detection">请先同步无账号接入配置。</p>}
    {!desktop && <p className="codex-launch-detection">尚未识别到 Codex 桌面端；点击启动会重新识别，也可在客户端设置中指定安装目录。</p>}
    <p className="codex-launch-guidance">
      已有窗口会尝试唤起；新接入配置需在任务结束后完全退出再启动，不会自动关闭任务。
      {officialRelay && "普通开始菜单 / 任务栏入口不会启用此通道。"}
    </p>
    {officialRelay && <p className="codex-launch-boundary">仅处理连接链路，不解除账号权限、订阅额度或官方网关限制。</p>}
    </div>
  </div>;
}
