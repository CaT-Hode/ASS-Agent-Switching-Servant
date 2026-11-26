import React, { useState } from "react";
import { Search, Folder, Loader2 } from "./icons.jsx";

// Inline recovery: keep installation choices inside the current confirmation.
export function ClientLocationRecovery({ clientId, disabled, onUpdated, onBusy }) {
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function run(location) {
    if (busy || disabled) return;
    setBusy(true); onBusy(true); setError("");
    try {
      if (location) {
        await window.ass.call("client-location", clientId, location);
        setCandidates([]);
      } else {
        const result = await window.ass.call("client-detect", clientId);
        setCandidates(result.selected ? [] : result.candidates);
        if (!result.candidates.length) setError("未找到安装位置，请在「设置 → 客户端」中选择文件或目录。");
      }
      onUpdated();
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally { setBusy(false); onBusy(false); }
  }
  return <section className="connection-location" aria-label="客户端安装位置">
    <button className="button" disabled={busy || disabled} onClick={() => run()}>
      {busy ? <Loader2 size={15} className="spin" /> : <Search size={15} />}自动识别
    </button>
    <small>检查安装位置，不启动或关闭客户端。</small>
    {candidates.length > 0 && <div className="launcher-candidates">
      {candidates.map(c => <button key={c.location} className="account-row"
        disabled={busy || disabled} onClick={() => run(c.location)}>
        <Folder size={16} /><span className="account-content"><strong>{c.message}</strong><small>{c.location}</small></span>
      </button>)}
    </div>}
    {error && <p role="alert" className="error-box">{error}</p>}
  </section>;
}
