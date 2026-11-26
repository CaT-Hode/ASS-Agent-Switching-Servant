import React, { useState } from "react";
import { Modal } from "./editors.jsx";
import { AlertTriangle, Download } from "./icons.jsx";
import "./config-export.css";

export function ExportConfigDialog({ onClose }) {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await window.ass.call("export", { includeSecrets, acknowledged: includeSecrets });
      if (result?.saved) onClose();
    } catch (e) {
      setError(e.message || "导出失败，请重新选择保存位置");
    } finally {
      setSaving(false);
    }
  }
  return <Modal title="导出供应商配置" className="config-export-dialog" onClose={onClose} dismissible={!saving}>
    <p className="muted">导出已配置的 API 供应商及模型，不包含 OAuth 登录令牌。</p>
    <label className="export-secret-option">
      <input type="checkbox" checked={includeSecrets} disabled={saving} onChange={(e) => setIncludeSecrets(e.target.checked)} />
      包含 API 密钥及额外请求头
    </label>
    {includeSecrets ? <div className="export-secret-warning" role="alert">
      <AlertTriangle size={20} />
      <p><strong>密钥将以明文保存</strong><span>拿到文件即可使用这些密钥。请勿公开分享或提交到代码仓库；仅保存到可信位置。</span></p>
    </div> : <p className="hint">默认移除密钥和额外请求头；导入后需重新填写。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <footer>
      <button className="button" disabled={saving} onClick={onClose}>取消</button>
      <button className="button primary" disabled={saving} onClick={save}><Download size={16} />{saving ? "正在保存…" : "选择保存位置"}</button>
    </footer>
  </Modal>;
}
