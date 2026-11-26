import React, { useId, useState } from 'react';
import { Activity, Download, Folder, Info, Monitor, Settings2, Upload } from './icons.jsx';
import { ThemeControl } from './theme.jsx';
import { Updates } from './updates.jsx';
import { ExportConfigDialog } from './config-export.jsx';
import { SettingsSwitch } from './settings-switch.jsx';
import { SettingsRange } from './settings-range.jsx';
import { ClientSettings } from './settings-client.jsx';
import { SettingsWidgetPreview } from './settings-widget-preview.jsx';
import { widgetWidth, widgetWidthSetting } from '../core/request-widget-view.mjs';
import './settings.css';

const sections = [
  ['general', '常规', Settings2], ['widget', '请求悬浮窗', Activity], ['clients', '客户端', Monitor],
  ['data', '用量与数据', Folder], ['updates', '版本与更新', Info],
];

export function SettingsRow({ label, detail, children }) {
  return <div className="settings-row">
    <div className="settings-row-copy"><strong>{label}</strong>{detail && <p>{detail}</p>}</div>
    <div className="settings-row-control">{children}</div>
  </div>;
}

function SwitchRow({ label, detail, ...props }) {
  const id = useId();
  return <SettingsRow label={label} detail={detail && <span id={id}>{detail}</span>}>
    <SettingsSwitch label={label} describedBy={detail ? id : undefined} {...props} />
  </SettingsRow>;
}

function NumberOptions({ label, value, values, format = String, onChange, disabled }) {
  const options = [...new Set([...values, value])].sort((a, b) => a - b);
  return <select className="settings-select" aria-label={label} value={value} disabled={disabled}
    onChange={event => onChange(Number(event.target.value))}>
    {options.map(option => <option key={option} value={option}>{format(option)}</option>)}
  </select>;
}

const columns = [
  ['provider', '供应商', '显示实际处理请求的供应商或订阅来源。'],
  ['throughput', '可见输出 TPS', '显示文本和工具参数的接收速率。'],
  ['cache', '缓存命中率', '显示缓存读取占输入的比例。'],
  ['duration', '请求耗时', '进行中的请求显示实时耗时。'],
];

const widgetRanges = [
  { key: 'width', label: '窗口宽度', min: widgetWidth(320), max: widgetWidth(640), unit: 'DIP', fallback: 340 },
  { key: 'radius', label: '窗口圆角', min: 8, max: 48, unit: 'DIP', fallback: 36 },
  { key: 'rows', label: '最多请求行数', min: 1, max: 8, unit: '行', fallback: 5 },
];

function WidgetSettings({ widget, theme, act, busy }) {
  const [draft, setDraft] = useState(null);
  const configure = patch => act('widget-settings', () => window.ass.call('request-widget', patch));
  const disabled = !!busy;
  return <div className="settings-widget-layout">
    <div className="settings-widget-options">
      <div className="settings-card">
        <SwitchRow label="显示请求悬浮窗" detail="在桌面置顶显示进行中和近期完成的请求。可拖动，按 Esc 隐藏。"
          checked={widget.enabled} disabled={disabled} onChange={enabled => configure({ enabled })} />
        {widget.error && <p role="status" className="settings-card-message">{widget.error}</p>}
      </div>
      <section className="settings-group" aria-label="悬浮窗外观">
        <div className="settings-group-heading"><h4>外观</h4>
          <button type="button" className="text-button" disabled={disabled} onClick={() => configure({ rows: 5, width: 340, radius: 36 })}>恢复默认外观</button>
        </div>
        <div className="settings-card">
          {widgetRanges.map(({ key, fallback, ...range }) => {
            const value = widget[key] ?? fallback;
            const patch = next => ({ [key]: key === 'width' ? widgetWidthSetting(next) : next });
            return <div key={key} className="settings-row settings-widget-range-row">
              <div className="settings-row-copy"><strong>{range.label}</strong></div>
              <SettingsRange {...range} value={key === 'width' ? widgetWidth(value) : value} disabled={disabled}
                onPreview={next => setDraft(next === null ? null : patch(next))} onCommit={next => configure(patch(next))} />
            </div>;
          })}
        </div>
      </section>
      <section className="settings-group" aria-label="悬浮窗显示内容">
        <div className="settings-group-heading"><h4>显示内容</h4></div>
        <div className="settings-card">
          {columns.map(([key, label, detail]) => <SwitchRow key={key} label={label} detail={detail}
            checked={widget.columns?.[key] !== false} disabled={disabled} onChange={value => configure({ columns: { [key]: value } })} />)}
          <SwitchRow label="今日 Token 热力图" detail="按小时显示今天的 Token 用量。"
            checked={widget.showHeatmap !== false} disabled={disabled} onChange={showHeatmap => configure({ showHeatmap })} />
          <SwitchRow label="今日 Token 汇总" detail="显示今日总量、输入和输出，可独立于热力图开启。"
            checked={widget.showUsage} disabled={disabled} onChange={showUsage => configure({ showUsage })} />
        </div>
      </section>
    </div>
    <SettingsWidgetPreview widget={draft ? { ...widget, ...draft } : widget} theme={theme} />
  </div>;
}

export function Settings({ state, act, busy, section, setSection, remember }) {
  const [exportOpen, setExportOpen] = useState(false);
  const preferences = state.preferences;
  const current = sections.find(([id]) => id === section) || sections[0];
  return <div className="settings-page">
    <header className="settings-heading"><h2>设置</h2></header>
    <div className="settings-layout">
      <nav aria-label="设置分类" className="settings-navigation">
        {sections.map(([id, label, Icon]) => <button type="button" key={id} aria-current={id === current[0] ? 'page' : undefined}
          onClick={() => setSection(id)}><Icon size={17} /><span>{label}</span></button>)}
      </nav>
      <section className="settings-section" aria-labelledby="settings-section-heading">
        <h3 id="settings-section-heading">{current[1]}</h3>
        {section === 'general' && <div className="settings-card">
          <SettingsRow label="主题" detail="选择浅色、跟随系统或深色。">
            <ThemeControl value={preferences.theme} onChange={theme => remember({ theme })} />
          </SettingsRow>
          <SwitchRow label="开机启动" detail="登录 Windows 后在后台启动 ASS。"
            checked={state.autoStart} disabled={!!busy} onChange={value => act('auto', () => window.ass.call('autostart', value))} />
        </div>}
        {section === 'widget' && <WidgetSettings widget={state.requestWidget || preferences.requestWidget || {}} theme={preferences.theme} {...{ act, busy }} />}
        {section === 'clients' && <ClientSettings {...{ state, busy, act }} />}
        {section === 'data' && <>
          <div className="settings-card">
            <SettingsRow label="应用内低额度提醒" detail="按最近 15 分钟内的有效查询，在账户额度卡上显示提醒。">
              <NumberOptions label="应用内低额度提醒阈值" value={preferences.quotaMonitor?.lowThreshold || 0}
                values={[0, 5, 10, 15, 20, 25, 30, 40, 50]} format={n => n ? `剩余 ≤ ${n}%` : '关闭'}
                disabled={!!busy} onChange={lowThreshold => act('quota-monitor', () => window.ass.call('ui-preferences', { quotaMonitor: { lowThreshold } }))} />
            </SettingsRow>
          </div>
          <section className="settings-group" aria-label="配置文件">
            <div className="settings-group-heading"><h4>配置文件</h4></div>
            <div className="settings-card">
              <SettingsRow label="供应商配置" detail="在本机导入或导出 API 供应商与模型。导出默认移除密钥。">
                <div className="actions"><button type="button" className="button" disabled={!!busy} onClick={() => act('import', () => window.ass.call('import'))}>
                  <Upload size={15} />导入配置</button>
                <button type="button" className="button export-config-button" disabled={!!busy} onClick={() => setExportOpen(true)}>
                  <Download size={15} />导出配置</button></div>
              </SettingsRow>
              <SettingsRow label="ASS 数据目录" detail={<code className="settings-path">{state.dataDir}</code>}>
                <button type="button" className="button" disabled={!!busy} onClick={() => act('data', () => window.ass.call('open-data'))}>
                  <Folder size={15} />打开数据目录</button>
              </SettingsRow>
            </div>
          </section>
          {exportOpen && <ExportConfigDialog onClose={() => setExportOpen(false)} />}
        </>}
        {section === 'updates' && <>
          <div className="settings-card">
            <SwitchRow label="自动检查更新" detail="检查已发布的 ASS 版本。" disabled={!!busy}
              checked={state.updates.automatic} onChange={automatic => act('update-preferences', () => window.ass.call('update-preferences', { automatic }))} />
            <SwitchRow label="包含预览版本" detail="同时检查测试版本。" disabled={!!busy}
              checked={state.updates.includePreview} onChange={includePreview => act('update-preferences', () => window.ass.call('update-preferences', { includePreview }))} />
          </div>
          <Updates {...{ state, act, busy }} />
        </>}
      </section>
    </div>
  </div>;
}
