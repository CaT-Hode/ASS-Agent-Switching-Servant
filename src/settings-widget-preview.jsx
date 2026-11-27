import React, { useLayoutEffect, useRef, useState } from 'react';
import { WIDGET_FRAME_INSET, WIDGET_GLASS_DEFAULTS, WIDGET_MAX_RADIUS, WIDGET_ROW_INLINE_PADDING, todayHeatmap,
  widgetContentInsets, widgetHeight, widgetVisibleColumns, widgetWidth } from '../core/request-widget-view.mjs';
import { WidgetSurface } from './widget-surface.jsx';
import { WidgetPreviewMaterial } from './widget-preview-material.jsx';
import { WidgetColumnHeader } from './widget-column-header.jsx';

export const sampleEntries = [
  ['codex', 'GPT-6.2 Astra', 'OpenAI', 46.8, 89, 4200, 'streaming'],
  ['claude', 'Claude Fable 5.2', 'Anthropic', 35.5, 88, 6100],
  ['antigravity', 'Gemini 4 Neon', 'Google', 28.5, 76, 6900],
  ['opencode', 'MiniMax M3.1 Flash', 'OpenCode Go', 41.7, 81, 5700],
  ['pi', 'Qwen4 Max', 'OpenRouter', 26.3, 68, 4600, 'streaming'],
  ['dsh', 'DeepSeek V4.1 Flash', 'DeepSeek', 36.2, 91, 8700],
  ['kimi', 'Kimi K3.1 Pro', 'Moonshot', 32.4, 73, 5300],
  ['zcode', 'GLM-5.4', 'Z.ai', null, null, 1700, 'queued'],
].map(([client, model, provider, tps, cache, ms, phase], index) => ({
  index, row: { id: 'sample-' + client, client, rawModel: model, model, provider, tps, cache, ms,
    endToEndTps: null, inProgress: !!phase, phase, ok: true },
}));
const sampleHours = [0, 6, 4, 0, 0, 0, 0, 17, 26, 68, 112, 38, 15, 91, 124, 55];
export const sampleUsage = todayHeatmap({ rows: sampleHours.map((value, hour) => ({
  day: '2026-01-01', hour, input: value * 14000, output: value * 1100,
})) }, [], new Date(2026, 0, 1, 15, 30));

export function SettingsWidgetPreview({ widget, quotaBars, theme, disabled, onColumnWidths }) {
  const stage = useRef(null), panel = useRef(null);
  const [available, setAvailable] = useState(null);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useLayoutEffect(() => {
    const node = stage.current, media = matchMedia('(prefers-color-scheme: dark)');
    const measure = () => setAvailable(node.clientWidth);
    const syncTheme = () => setSystemDark(media.matches);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    media.addEventListener('change', syncTheme);
    return () => { observer.disconnect(); media.removeEventListener('change', syncTheme); };
  }, []);
  const widthSetting = widget.width ?? 340, rows = widget.rows ?? 5;
  const showHeatmap = widget.showHeatmap !== false, showUsage = widget.showUsage === true;
  const radius = widget.radius ?? WIDGET_MAX_RADIUS;
  const width = widgetWidth(widthSetting), height = widgetHeight(rows, rows, widthSetting, showHeatmap, showUsage, quotaBars.length, radius);
  const scale = Math.min(1, Math.max(1, (available ?? width + 40) - 40) / width);
  const color = theme === 'dark' || theme === 'system' && systemDark ? 'dark' : 'light';
  const { bezelWidth, distortion } = { ...WIDGET_GLASS_DEFAULTS, ...widget };
  const fields = widgetVisibleColumns(widget.columns);
  const inlineInset = WIDGET_FRAME_INSET + widgetContentInsets(radius).horizontal + WIDGET_ROW_INLINE_PADDING;
  const headerWidth = (width - 2 * inlineInset) * scale;
  return <aside className="settings-widget-preview" aria-label="请求悬浮窗预览">
    <div className="settings-preview-heading"><h4>预览</h4><span>{width} × {height} DIP</span>
      {Object.keys(widget.columnWidths || {}).length > 0 && <button type="button" className="text-button"
        disabled={disabled} onClick={() => onColumnWidths(null)}>重置列宽</button>}
    </div>
    <div ref={stage} className="settings-preview-stage widget-demo-stage">
      <div className="settings-preview-sample">
        <WidgetColumnHeader {...{ fields, scale, disabled, panel }} widths={widget.columnWidths} width={headerWidth} onCommit={onColumnWidths} />
        <div className="settings-preview-fit" style={{ width: width * scale, height: height * scale }}>
          <div className="settings-preview-window" style={{ width, height, scale }}>
            <WidgetSurface preview panelRef={panel} frame={{ theme: color, glass: true, radius, columns: widget.columns,
              columnWidths: widget.columnWidths, quotaBars, showHeatmap, showUsage, heat: sampleUsage, usageSummary: sampleUsage }}
              entries={sampleEntries.slice(0, rows)} />
          </div>
        </div>
      </div>
      <WidgetPreviewMaterial panel={panel} {...{ radius, bezelWidth, distortion, scale }} theme={color} />
    </div>
    <p>{fields.length > 1 ? '拖动表头分隔线调整列宽 · ' : ''}请求与热力图为示例{scale < 1 ? ' · 已缩放' : ''}</p>
  </aside>;
}
