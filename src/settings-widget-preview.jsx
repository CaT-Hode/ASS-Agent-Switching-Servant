import React, { useLayoutEffect, useRef, useState } from 'react';
import { todayHeatmap, widgetHeight, widgetWidth } from '../core/request-widget-view.mjs';
import { WidgetSurface } from './widget-surface.jsx';

const sampleEntries = Array.from({ length: 8 }, (_, index) => {
  const [model, provider, tps, cache, ms] = [
    ['Codex', 'ASS 示例', 46.8, 89, 4200],
    ['Gemini', 'ASS 示例', 28.5, 76, 6900],
    ['Claude', 'ASS 示例', null, null, 1700],
    ['DeepSeek', 'ASS 示例', 36.2, 91, 8700],
  ][index % 4];
  return { index, row: { id: `sample-${index}`, rawModel: model, model, provider, tps, cache, ms,
    endToEndTps: null, inProgress: index % 4 === 0 || index % 4 === 2, phase: index % 4 === 0 ? 'streaming' : 'queued', ok: true } };
});
const sampleHours = [0, 6, 4, 0, 0, 0, 0, 17, 26, 68, 112, 38, 15, 91, 124, 55];
const sampleUsage = todayHeatmap({ rows: sampleHours.map((value, hour) => ({
  day: '2026-01-01', hour, input: value * 14000, output: value * 1100,
})) }, [], new Date(2026, 0, 1, 15, 30));

export function SettingsWidgetPreview({ widget, theme }) {
  const stage = useRef(null);
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
  const width = widgetWidth(widthSetting), height = widgetHeight(rows, rows, widthSetting, showHeatmap, showUsage);
  const scale = Math.min(1, Math.max(1, (available ?? width + 28) - 28) / width);
  const color = theme === 'dark' || theme === 'system' && systemDark ? 'dark' : 'light';
  return <aside className="settings-widget-preview" aria-label="请求悬浮窗预览">
    <div className="settings-preview-heading"><h4>预览</h4><span>{width} × {height} DIP</span></div>
    <div ref={stage} className="settings-preview-stage">
      <div className="settings-preview-fit" style={{ width: width * scale, height: height * scale }}>
        <div className="settings-preview-window" style={{ width, height, scale }}>
          <WidgetSurface preview frame={{ theme: color, glass: true, radius: widget.radius ?? 36, columns: widget.columns,
            showHeatmap, showUsage, heat: sampleUsage, usageSummary: sampleUsage }} entries={sampleEntries.slice(0, rows)} />
        </div>
      </div>
    </div>
    <p>示例数据 · 桌面材质会随背景变化{scale < 1 ? ' · 已缩放' : ''}</p>
  </aside>;
}
