import React from "react";
import { ChevronRight, Layers3, Terminal, Monitor } from "./icons.jsx";
import { providerBrand } from "./provider-brand.mjs";
const api = window.ass;
const protocols = { "openai-chat": "Chat Completions", "openai-responses": "Responses", anthropic: "Anthropic Messages" };

export function ClientInjection({ client, state, act, busy, onManage }) {
  const injection = client.injection || { models: [], excludedProviders: [] };
  const groups = Map.groupBy(injection.models, (m) => m.providerId);
  const connection = state.connections.clients[client.id];
  const accountlessHint = !connection?.accountless ? ""
    : !connection.applied ? connection.syncError ? "无账号配置异常 · 请修复接入" : "无账号配置待同步"
    : "";
  const excluded = new Set(injection.excludedProviders || []);
  const enabled = [...groups].filter(([id, models]) => !excluded.has(id) && models.some((m) => !m.issue)).length;
  const defaultModels = ['codex', 'claude'].includes(client.id) ? injection.models.filter((m) => m.included && !m.issue) : [];
  const officialModels = connection?.accountless ? [] : injection.officialModels || [];
  const selectedDefault = [...officialModels, ...defaultModels].some(m => m.ref === injection.defaultModel) ? injection.defaultModel : '';
  const selectedReview = defaultModels.some(m => m.ref === injection.autoModeModel) ? injection.autoModeModel : '';
  return <section className="client-injection" aria-label={client.name + " 模型接入"}>
    <header><h3>供应商接入 {!client.injectionUnsupported && <span className="injection-count" title="已纳入 / 已配置供应商" aria-label={`已纳入 ${enabled} 个供应商，共 ${groups.size} 个`}>{enabled} / {groups.size}</span>}</h3>
    </header>
    {["codex", "claude"].includes(client.id) && <div className="accountless-control">
      <div><strong>无账号启动</strong>{accountlessHint && <small>{accountlessHint}</small>}</div>
      {connection?.accountless && !(client.id === "codex" && client.desktop) && <button className="button" disabled={!!busy || !connection.accountlessAvailable || !client.launcher?.ready}
        title={client.id === "codex" && client.desktop ? "打开桌面端；已运行的窗口需重启加载配置" : client.id === "claude" ? "启动 Claude Code 命令行终端" : "以独立配置启动，不读取官方 OAuth"}
        onClick={() => act("accountless-launch", () => api.call(client.id === "codex" && client.desktop ? "client-open-desktop" : "client-accountless-launch", client.id), client.id === "claude" ? "已打开 Claude Code 终端" : "已启动客户端")}>
        <Terminal size={15} />{client.id === "claude" ? "启动终端" : "启动"}</button>}
      {client.id === "claude" && connection?.accountless && client.desktop && <button className="button"
        disabled={!!busy || !connection.accountlessAvailable || !state.claudeDesktop?.current}
        onClick={() => act("claude-desktop-launch", () => api.call("client-open-desktop", "claude"))}>
        <Monitor size={15} />启动桌面版</button>}
      <button type="button" role="switch" className="provider-injection-switch" aria-label={client.name + " 无账号启动"}
        aria-checked={!!connection?.accountless} disabled={!!busy || state.connections.busy || (!connection?.accountless && !connection?.accountlessAvailable)}
        title={!connection?.accountlessAvailable && !connection?.accountless ? "请先开启接入并同步至少一个模型" : "仅影响此客户端，官方登录保留"}
        onClick={() => onManage({ scope: client.id, enabled: true, accountless: !connection?.accountless, name: client.name })}><i /></button>
    </div>}
    {client.id === "claude" && (connection?.accountless || state.claudeDesktop?.owned) && <details className="claude-desktop-setup">
      <summary>Claude 桌面版 Gateway{state.claudeDesktop?.current && <small>已配置</small>}<ChevronRight size={15} /></summary>
      <div className="claude-desktop-setup-body">
        <p>{state.claudeDesktop?.error || (state.claudeDesktop?.conflict ? "检测到其他生效配置，ASS 不会覆盖。" : state.claudeDesktop?.current
          ? "重新打开 Claude，选择 Continue with Gateway。" : "桌面版配置待同步，请点击页首刷新。")}</p>
        <div className="claude-desktop-setup-actions">
          <button className="button" onClick={() => act("claude-desktop-url", () => api.call("claude-desktop-copy", "url"), "网关地址已复制")}>复制网关地址</button>
          <button className="button" onClick={() => act("claude-desktop-key", () => api.call("claude-desktop-copy", "key"), "本机密钥已复制")}>复制本机密钥</button>
        </div>
        <small>与无账号开关联动，使用时 ASS 需保持运行。</small>
      </div>
    </details>}
    {client.id === 'codex' && !connection?.enabled && (connection?.resumeRecovery?.count > 0 || connection?.resumeRecovery?.pending) && <button
      className="button" disabled={!!busy || state.connections.busy}
      title="恢复 ASS 对话的官方供应商和模型绑定；需先关闭 Codex"
      onClick={() => onManage({ scope: client.id, enabled: false, restoreSessions: true, name: client.name })}>恢复官方续聊</button>}
    {['codex', 'claude'].includes(client.id) && (defaultModels.length > 0 || officialModels.length > 0) && <label className="client-default-model">
      <span>{client.id === 'claude' ? 'CLI 默认模型' : '默认模型'}</span>
      <select aria-label={client.id === 'claude' ? 'Claude Code CLI 默认模型' : 'Codex 默认模型'} value={selectedDefault} disabled={!!busy || state.connections.busy}
        onChange={(e) => act("client-injection-default", () => api.call("client-injection", client.id, {
          excludedProviders: [...excluded], defaultModel: e.target.value || null,
        }))}>
        <option value="">自动选择首个已纳入模型</option>
        {officialModels.length > 0 && <optgroup label="OpenAI 官方订阅">{officialModels.map(m => <option key={m.ref} value={m.ref}>{m.name || m.model}</option>)}</optgroup>}
        {defaultModels.length > 0 && <optgroup label="已注入模型">{defaultModels.map((m) => <option key={m.ref} value={m.ref}>{m.providerName} / {m.name || m.model}</option>)}</optgroup>}
      </select>
    </label>}
    {client.id === 'claude' && defaultModels.length > 0 && <>
      <label className="client-default-model">
        <span>Auto Mode 审查模型</span>
        <select aria-label="Claude Code Auto Mode 审查模型" value={selectedReview} disabled={!!busy || state.connections.busy}
          onChange={e => act('client-injection-review', () => api.call('client-injection', 'claude', { autoModeModel: e.target.value || null }))}>
          <option value="">跟随当前终端模型</option>
          {defaultModels.map(m => <option key={m.ref} value={m.ref}>{m.providerName} / {m.name || m.model}</option>)}
        </select>
      </label>
      <p className="codex-tool-mode-hint">同步后用于新开的 ASS 模型终端；开启无账号启动后，直接运行 claude 也生效。审查在 CLI 内发起；兼容旧版时也映射 sonnet 别名，不改变权限模式。</p>
      {!connection?.accountless && <button className="button" disabled={!!busy || state.connections.busy || !connection?.applied || !client.launcher?.ready}
        onClick={() => act('claude-default-launch', () => api.call('client-model-launch', 'claude', selectedDefault || defaultModels[0].ref), '已打开 Claude Code 默认模型终端')}>
        <Terminal size={15} />启动默认模型终端</button>}
    </>}
    {client.id === 'codex' && !connection?.accountless && <p className="codex-tool-mode-hint">
      普通接入保留原生归档与提示词预测通道。更新接入并重新加载 Codex 后生效；预测仍需官方功能开放与模型支持。
    </p>}
    {client.id === 'codex' && !connection?.accountless &&
      (connection?.resumeRecovery?.predictionCount > 0 || connection?.resumeRecovery?.pending) && <div className="accountless-control">
      <div><strong>旧对话预测待修复{connection.resumeRecovery.predictionCount > 0 ? ` · ${connection.resumeRecovery.predictionCount} 个` : ''}</strong>
        <small>任务结束后正常退出 Codex，再点修复；或在更新接入时确认重启。保留原模型与聊天内容，ASS 保持运行。</small></div>
      <button className="button" disabled={!!busy || state.connections.busy || !connection.predictionCompatibility || !connection.applied}
        title={!connection.predictionCompatibility || !connection.applied ? '请先更新接入以应用原生兼容' : '仅修复旧对话的预测通道；请先正常退出 Codex'}
        onClick={() => act('prediction-repair', () => api.call('codex-prediction-repair'))}>修复旧对话预测</button>
    </div>}
    {client.id === 'codex' && injection.models.some(m => m.protocol === 'openai-responses') && <p className="codex-tool-mode-hint">
      展开供应商，在模型菜单中设置工具兼容。工具调用变成普通文字时可切换“兼容模式”；更改后同步接入生效。
    </p>}
    {!client.injectionUnsupported && groups.size > 0 && <p className="codex-tool-mode-hint">
      可为每个模型选择接口协议，仅影响此客户端；自动模式按检测结果选择。更改后同步接入生效。
    </p>}
    {client.injectionUnsupported ? <p className="client-support-note">{client.injectionUnsupported}</p> :
      groups.size ? <div className="client-provider-list">{[...groups].map(([id, models]) => {
        const provider = state.providers.find((p) => p.id === id);
        const brand = providerBrand(provider || {}, state.officialProviderIds?.[id]);
        const compatible = models.filter((m) => !m.issue);
        const checked = !excluded.has(id) && compatible.length > 0;
        return <section className="client-provider" key={id} aria-label={models[0].providerName + " 接入供应商"}>
          <details>
            <summary><span className="client-provider-logo" aria-hidden="true">{brand ? <img src={"./providers/" + brand + ".svg"} alt="" /> : <Layers3 size={21} data-motion-icon={undefined} />}</span>
              <strong>{models[0].providerName}</strong><small>{compatible.length} 个模型</small><ChevronRight className="provider-disclosure" size={16} /></summary>
            <div className="client-provider-models">{models.map((m) => <div key={m.ref} className={m.issue ? "unavailable" : ""}>
              <span title={m.model}>{m.name || m.model}<small>{m.name !== m.model ? m.model : ""}</small>
                <small>{m.issue || m.adapter || protocols[m.protocol] || m.protocol}</small></span>
              <div className="client-model-controls">
              <label className="model-protocol">
                <span>接口协议</span>
                <select aria-label={`${m.providerName} / ${m.name || m.model} 接口协议`}
                  value={m.protocolOverride || 'auto'} disabled={!!busy || state.connections.busy}
                  onChange={e => { const protocol = e.target.value;
                    act('model-protocol', () => api.call('client-injection', client.id, {
                      modelProtocol: { ref: m.ref, protocol },
                    }));
                  }}>
                  <option value="auto">{!m.protocolOverride || m.protocolOverride === 'auto' ? `自动（${protocols[m.protocol] || m.protocol}）` : '自动选择'}</option>
                  {Object.entries(protocols).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              {client.id === 'codex' && m.protocol === 'openai-responses' && <label className="codex-tool-mode">
                <span>Codex 工具兼容</span>
                <select aria-label={`${m.providerName} / ${m.name || m.model} Codex 工具兼容`}
                  value={m.codexToolMode || 'auto'} disabled={!!busy || state.connections.busy}
                  title="自动识别：按服务判断；兼容模式：转换自定义工具和命名空间；原生格式：直接传递工具格式"
                  onChange={e => { const mode = e.target.value;
                    act('codex-tool-mode', () => api.call('client-injection', 'codex', {
                      codexToolMode: { ref: m.ref, mode },
                    }));
                  }}>
                  <option value="auto">自动识别</option>
                  <option value="compatible">兼容模式</option>
                  <option value="native">原生格式</option>
                </select>
              </label>}
              </div>
            </div>)}</div>
          </details>
          <button type="button" role="switch" className="provider-injection-switch" aria-label={models[0].providerName + " 供应商接入"}
            aria-checked={checked} disabled={!!busy || !compatible.length} title={!compatible.length ? "没有已启用的兼容模型或缺少凭据" : checked ? "排除此供应商" : "纳入此供应商"}
            onClick={() => { const next = new Set(excluded); checked ? next.add(id) : next.delete(id);
              act("client-injection", () => api.call("client-injection", client.id, { excludedProviders: [...next] }));
            }}><i /></button>
        </section>;
      })}</div> : <div className="injection-empty"><Layers3 size={20} /><span>暂无可接入的供应商</span></div>}
  </section>;
}
