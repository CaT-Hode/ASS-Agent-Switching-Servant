import React, { useState } from "react";
import { quotaRetentionMs, quotaTrend, quotaWindowKey } from "../core/quota-history.mjs";
import { exactTime, quotaDateTime } from "./relative-time.mjs";

const percent = value => Number(value.toFixed(1)) + "%";
export const quotaWindowName = field => [field.group, field.label].filter(Boolean).join(" · ");

export function ResetCreditDetails({ credit }) {
  const [open, setOpen] = useState(false);
  const recorded = Array.isArray(credit.expiries);
  const expiries = recorded ? credit.expiries : [credit.expiresAt].filter(Boolean);
  if (!expiries.length && !credit.missingExpiryCount) return null;
  return (
    <details className="overview-reset-credits" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{expiries.length ? <>最近到期 <time dateTime={expiries[0]}>{quotaDateTime(expiries[0])}</time></> : "到期明细"}</summary>
      {open && <ul>
        {expiries.map((date, index) => <li key={date + ":" + index}><time dateTime={date}>{exactTime(date)}</time></li>)}
        {credit.missingExpiryCount > 0 && <li>未提供到期时间 × {credit.missingExpiryCount}</li>}
        {!recorded && Number(credit.value) > expiries.length && <li>刷新额度后可查看全部到期时间</li>}
      </ul>}
    </details>
  );
}

export function QuotaHistory({ windows, history, focus, now }) {
  const [selected, setSelected] = useState("");
  const key = windows.some(window => quotaWindowKey(window) === selected) ? selected : quotaWindowKey(focus);
  const points = (history?.[key] || []).filter(([when]) => when >= now - quotaRetentionMs);
  const trend = quotaTrend(points, now);
  const latest = points.at(-1), first = points[0];
  return (
    <details className="overview-quota-history">
      <summary>额度历史</summary>
      <label className="overview-quota-picker">
        窗口
        <select value={key} onChange={event => setSelected(event.target.value)}>
          {windows.map(window => <option key={quotaWindowKey(window)} value={quotaWindowKey(window)}>{quotaWindowName(window)}</option>)}
        </select>
      </label>
      {latest ? <>
        <p className="overview-history-stats">
          <span>{points.length} 次实测 · 近 14 天内</span>
          {trend && <span>近段消耗 {Number(trend.perHour.toFixed(2))} 个百分点/小时</span>}
          {trend?.depletion && <span>按当前速度约 <time dateTime={new Date(trend.depletion).toISOString()}>{quotaDateTime(new Date(trend.depletion).toISOString())}</time> 耗尽</span>}
        </p>
        {points.length >= 4 && <div className="overview-quota-plot" aria-hidden="true">
          <small>100%</small><small>0%</small>
          {points.map(([time, remaining]) => <i key={time} style={{
            "--point-time": (time - first[0]) / (latest[0] - first[0]) * 100 + "%",
            "--point-remaining": remaining + "%",
          }} />)}
        </div>}
        <details className="overview-quota-samples">
          <summary>查看 {points.length} 次实测记录</summary>
          <table>
            <thead><tr><th scope="col">查询时间</th><th scope="col">剩余</th><th scope="col">该次重置时间</th></tr></thead>
            <tbody>{points.toReversed().map(([time, remaining, reset]) => <tr key={time}>
              <td><time dateTime={new Date(time).toISOString()}>{quotaDateTime(new Date(time).toISOString())}</time></td>
              <td>{percent(remaining)}</td>
              <td>{reset ? <time dateTime={new Date(reset).toISOString()}>{quotaDateTime(new Date(reset).toISOString())}</time> : "未知"}</td>
            </tr>)}</tbody>
          </table>
        </details>
      </> : <p className="overview-history-stats">刷新额度后开始记录成功查询。</p>}
    </details>
  );
}
