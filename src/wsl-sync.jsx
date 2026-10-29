import React from 'react';
import { RefreshCw } from './icons.jsx';
const api = window.ass;
export function WslSyncControl({ client, state, act, busy }) {
  if (!['codex', 'claude', 'pi'].includes(client.id) || !state.wslSync) return null;
  const wsl = state.wslSync, item = wsl.clients[client.id];
  const working = !!busy || wsl.busy || state.connections.busy;
  return <section className="wsl-sync" aria-label={client.name + ' WSL 同步'}>
    <header><div><strong>WSL 自动同步</strong><small>继承 Windows 已应用的模型和路由，保留 WSL 会话与其他设置。</small></div>
      <button type="button" role="switch" className="provider-injection-switch" aria-label={client.name + ' WSL 自动同步'}
        aria-checked={item.enabled} disabled={working}
        onClick={() => act('wsl-configure', () => api.call('wsl-configure', client.id, { enabled: !item.enabled }))}><i /></button>
    </header>
    <div className="wsl-sync-actions">
      <label>发行版<select aria-label="WSL 发行版" value={wsl.distro} disabled={working || Object.values(wsl.clients).some(c => c.configured)}
        onChange={e => act('wsl-configure', () => api.call('wsl-configure', client.id, { distro: e.target.value, enabled: false }))}>
        {[...new Set([wsl.distro, ...wsl.distros])].map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>
      <button className="button" disabled={working} onClick={() => act('wsl-detect', () => api.call('wsl-detect'))}>检测 WSL</button>
      <button className="button" disabled={working || !item.enabled} onClick={() => act('wsl-sync', () => api.call('wsl-sync', client.id))}>
        <RefreshCw size={14} />立即同步</button>
    </div>
    <p role="status">{wsl.error || item.error || (wsl.busy ? '正在同步…' : item.status || '尚未开启')}
      {item.lastSync && <small>最近同步：{new Date(item.lastSync).toLocaleString()}</small>}</p>
    {item.binary && <code>{item.binary}</code>}
    <small>{client.id === 'pi' ? '继承 Windows 已接入的 API 模型，自动转接 Windows 本机 HTTP 地址；官方登录独立保留。' : '通过 WSL 本地转接连接 ASS，支持 NAT；无需重启 WSL 或修改网络模式。'}
      {client.id === 'codex' && '使用本地网关凭据，原 WSL 登录字段加密备份。'}开关关闭后恢复同步前的受管字段；新开的 CLI 会话加载配置。</small>
  </section>;
}
