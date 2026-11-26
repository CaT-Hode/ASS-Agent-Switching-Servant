import React, { useState } from 'react';
import { Check, ChevronRight, Folder, Search } from './icons.jsx';
import { Modal } from './editors.jsx';
import { WslSyncControl } from './wsl-sync.jsx';

export function ClientSettings({ state, act, busy }) {
  const [selected, select] = useState(state.preferences.client);
  const clients = state.harnesses.clients;
  const client = clients.find(row => row.id === selected) || clients[0];
  if (!client) return null;
  return <>
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-copy"><strong>默认工作目录</strong>
          <p><code className="settings-path">{state.harnesses.workspace || 'ASS 独立工作目录'}</code></p></div>
        <button type="button" className="button" disabled={!!busy} onClick={() => act('client-workspace', () => window.ass.call('client-workspace'))}>
          <Folder size={15} />选择工作目录</button>
      </div>
    </div>
    <section className="settings-group" aria-label="客户端安装与同步">
      <div className="settings-group-heading">
        <h4>安装位置与同步</h4>
        <select className="settings-select" aria-label="选择要配置的客户端" value={client.id}
          disabled={!!busy} onChange={event => select(event.target.value)}>
          {clients.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </div>
      <ClientLocations key={client.id} {...{ client, state, act, busy }} />
    </section>
  </>;
}

function ClientLocations({ client, state, act, busy }) {
  const [candidates, setCandidates] = useState(null);
  const [notice, setNotice] = useState('');
  const call = (task, operation, ...args) => act(task, () => window.ass.call(operation, client.id, ...args));
  const detect = () => act('client-detect', async () => {
    const result = await window.ass.call('client-detect', client.id);
    if (!result.selected && result.candidates.length > 1) setCandidates(result.candidates);
    else setNotice(result.selected ? '已识别并选择客户端入口。' : '未找到客户端，请选择安装或源码目录。');
  });
  const installed = client.launcher?.ready || client.launcher?.installed;
  return <div className="settings-card settings-client-card">
    <div className="settings-row">
      <div className="settings-row-copy"><strong>程序入口</strong>
        <p className={installed ? 'success' : ''}>{installed && <Check size={13} aria-hidden="true" />}{client.launcher?.message || '未检测到安装'}</p>
        {client.launcher?.location && <p><code className="settings-path">{client.launcher.location}</code></p>}
      </div>
      <div className="actions">
        <button type="button" className="button" disabled={!!busy} onClick={detect}><Search size={14} />自动识别</button>
        <button type="button" className="button" disabled={!!busy}
          onClick={() => call('client-directory', 'client-executable', true)}>选择目录</button>
        <button type="button" className="button" disabled={!!busy}
          onClick={() => call('client-path', 'client-executable')}>选择文件</button>
      </div>
    </div>
    {(notice || client.launcher?.ready) && <div className="settings-client-detail">
      {notice && <p role="status">{notice}</p>}
      {client.launcher?.ready && <details className="launcher-command"><summary>查看启动入口</summary><code>{client.launcher.command}</code></details>}
    </div>}
    {client.id === 'kimi' && <div className="settings-row">
      <div className="settings-row-copy"><strong>Kimi 配置版本</strong></div>
      <select className="settings-select" aria-label="Kimi 配置版本" value={client.nativeVariant || 'auto'}
        disabled={!!busy || state.connections.clients.kimi?.enabled}
        onChange={event => call('client-native-variant', 'client-native-variant', event.target.value)}>
        <option value="auto">自动识别</option><option value="current">Kimi Code（新版）</option><option value="legacy">Kimi CLI（旧版）</option>
      </select>
    </div>}
    <div className="settings-row">
      <div className="settings-row-copy"><strong>凭据检测位置</strong>
        {client.credentialHome && <p><code className="settings-path">{client.credentialHome}</code></p>}
      </div>
      <div className="actions">
        {client.credentialHome && <button type="button" className="text-button" disabled={!!busy}
          onClick={() => call('client-credentials', 'client-credentials', true)}>恢复默认</button>}
        <button type="button" className="button" disabled={!!busy}
          onClick={() => call('client-credentials', 'client-credentials')}>指定凭据目录</button>
      </div>
    </div>
    {client.credentialSources?.length > 0 && <div className="settings-client-detail credential-sources">{client.credentialSources.map(row =>
      <div key={row.file}><code>{row.file}</code><span>{row.message}</span></div>)}</div>}
    <WslSyncControl {...{ client, state, act, busy }} />
    {candidates && <Modal title="选择识别到的客户端" description="选择要使用的位置。" onClose={() => setCandidates(null)}>
      <div className="launcher-candidates">{candidates.map(candidate => <button type="button" className="account-row" key={candidate.location}
        disabled={!!busy} onClick={() => act('client-location', async () => {
          await window.ass.call('client-location', client.id, candidate.location);
          setCandidates(null);
          setNotice('已选择客户端入口。');
        })}>
        <Folder size={18} /><span className="account-content"><strong>{candidate.message}</strong><small>{candidate.location}</small></span>
        <ChevronRight size={16} />
      </button>)}</div>
    </Modal>}
  </div>;
}
