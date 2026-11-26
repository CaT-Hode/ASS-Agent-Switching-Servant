import React, { useEffect, useMemo, useRef, useState } from "react";
import { UsageMeter } from './usage-meter.jsx';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Layers,
  RefreshCw,
  ChevronRight,
  Info,
  Zap,
  UserRound,
  Pin,
} from "./icons.jsx";
import {
  CLIENT_NAMES,
  detectedClients,
  dayKey,
  groupQuotaWindows,
  overviewAccounts,
  overviewAccountPriority,
  quotaAmountText,
  summarize,
} from "./usage-view.mjs";
import { ElapsedTime, QuotaResetTime } from "./diagnostic-time.jsx";
import { quotaDateTime } from "./relative-time.mjs";
import { hasFreshQuotaSample, quotaWindowKey } from "../core/quota-history.mjs";
import { QuotaHistory, ResetCreditDetails } from "./quota-monitor.jsx";
import { UsageDrilldown } from "./usage-drilldown.jsx";
import { harnessLogo } from "./provider-brand.mjs";
import "./overview.css";
const api = window.ass;
const count = (n) => n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const hasQuotaCard = (row) =>
  overviewAccountPriority(row) > 0 || (row.client.id === "antigravity" && row.canRefresh);
const compact = (n) =>
  n >= 1e9
    ? (n / 1e9).toFixed(2) + "B"
    : n >= 1e6
      ? (n / 1e6).toFixed(2) + "M"
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + "K"
        : count(n);
function Segments({ label, value, items, onChange }) {
  return (
    <div className="usage-segments" role="group" aria-label={label}>
      {items.map(([id, text]) => (
        <button
          key={id}
          aria-pressed={id === value}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
function UsageRefreshGlyph({ busy = false, large = false }) {
  return (
    <span
      className={`usage-refresh-glyph${busy ? " is-reading" : ""}${large ? " is-large" : ""}`}
      aria-hidden="true"
    >
      <RefreshCw size={large ? 20 : 16} strokeWidth={1.7} />
    </span>
  );
}
function DayDetail({ data }) {
  return (
    <span className="usage-day-detail" role="status">
      {data ? (
        <>
          <strong>{data.label || data.day}</strong>
          <span>
            {data.observations ? count(data.calls) + " 次调用" : "无记录"}
          </span>
          {data.observations > 0 && (
            <span>{count(data.input + data.output)} Tokens</span>
          )}
        </>
      ) : (
        <span>指向格子查看用量，点击查看会话</span>
      )}
    </span>
  );
}
function HeatCell({ data, max, onSelect, onDrill }) {
  return (
    <button
      className="heatmap-cell"
      data-current={data.current || undefined}
      aria-current={data.current ? 'time' : undefined}
      data-level={
        data.calls ? Math.max(1, Math.ceil((data.calls / max) * 4)) : 0
      }
      aria-label={`${data.label || data.day} · ${data.observations ? count(data.calls) + " 次调用 · " + count(data.input + data.output) + " Tokens" : "无记录"}`}
      onMouseEnter={() => onSelect(data)}
      onMouseLeave={() => onSelect(null)}
      onFocus={() => onSelect(data)}
      onBlur={() => onSelect(null)}
      onClick={data.observations ? (event) => onDrill(data, event.currentTarget) : undefined}
    />
  );
}
function HeatFooter({ selected }) {
  return (
    <div className="heatmap-footer">
      <DayDetail data={selected} />
      <div className="heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((n) => (
          <i key={n} data-level={n} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
function PeriodHeatmap({ stats, selected, onSelect, onDrill }) {
  const max = Math.max(1, ...stats.timeline.map((d) => d.calls));
  const buckets = new Map(stats.timeline.map((d) => [d.key, d]));
  const isWeek = stats.range === "week";
  const dayCount = isWeek
    ? 7
    : new Date(
        stats.start.getFullYear(),
        stats.start.getMonth() + 1,
        0,
      ).getDate();
  const columnsPerDay = isWeek ? 4 : 1;
  const dates = Array.from({ length: dayCount }, (_, i) => {
    const date = new Date(stats.start);
    date.setDate(date.getDate() + i);
    return date;
  });
  return (
    <div
      className={`usage-heatmap usage-periodmap ${isWeek ? "usage-hourmap" : "usage-monthmap"}`}
      style={{ "--columns": dayCount * columnsPerDay }}
    >
      <div className="periodmap-surface">
        <div className="periodmap-days">
          {dates.map((date, i) => (
            <span
              key={i}
              style={{ gridColumn: `span ${columnsPerDay}` }}
              title={dayKey(date)}
            >
              {isWeek
                ? `周${["一", "二", "三", "四", "五", "六", "日"][i]} ${date.getMonth() + 1}/${date.getDate()}`
                : date.getDate()}
            </span>
          ))}
        </div>
        {isWeek && (
          <div className="periodmap-hours">
            {Array.from({ length: dayCount * columnsPerDay }, (_, i) => (
              <span key={i}>{String((i % 4) * 6).padStart(2, "0")}</span>
            ))}
          </div>
        )}
        <div className="periodmap-grid">
          {dates.flatMap((date) => {
            const day = dayKey(date);
            return Array.from({ length: 24 / stats.periodHours }, (_, i) => {
              const hour = i * stats.periodHours,
                key = `${day}T${String(hour).padStart(2, "0")}`,
                d = buckets.get(key);
              return d ? (
                <HeatCell key={key} data={d} {...{ max, onSelect, onDrill }} />
              ) : (
                <span
                  key={key}
                  className="periodmap-future"
                  aria-label={`${day} ${hour}:00 · 尚未到来`}
                />
              );
            });
          })}
        </div>
      </div>
      <HeatFooter selected={selected} />
    </div>
  );
}
function Heatmap({ stats, selected, onSelect, onDrill }) {
  if (stats.grain === "hour")
    return <PeriodHeatmap {...{ stats, selected, onSelect, onDrill }} />;
  const max = Math.max(1, ...stats.timeline.map((d) => d.calls));
  const pad = (stats.start.getDay() + 6) % 7;
  const cells = [...Array(pad).fill(null), ...stats.timeline];
  const weeks = Math.ceil(cells.length / 7);
  return (
    <div className="usage-heatmap" style={{ "--weeks": weeks }}>
      <div className="heatmap-months">
        {Array.from({ length: weeks }, (_, i) => {
          const day = cells.slice(i * 7, i * 7 + 7).find(Boolean);
          const prev = cells.slice((i - 1) * 7, i * 7).find(Boolean);
          return (
            <span key={i}>
              {day && (!prev || day.day.slice(0, 7) !== prev.day.slice(0, 7))
                ? Number(day.day.slice(5, 7)) + "月"
                : ""}
            </span>
          );
        })}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-weekdays">
          {["一", "", "三", "", "五", "", "日"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="heatmap-grid">
          {cells.map((d, i) =>
            d ? (
              <HeatCell key={d.key} data={d} {...{ max, onSelect, onDrill }} />
            ) : (
              <span key={"pad" + i} />
            ),
          )}
        </div>
      </div>
      <HeatFooter selected={selected} />
    </div>
  );
}
function TokenChart({ stats, selected, onSelect, onDrill }) {
  const max = Math.max(1, ...stats.timeline.map((d) => d.input + d.output));
  return (
    <>
      <div className="token-legend">
        <span>
          <i className="token-input" />
          非缓存输入
        </span>
        <span>
          <i className="token-cache" />
          缓存输入
        </span>
        <span>
          <i className="token-output" />
          输出
        </span>
      </div>
      <div className="token-chart">
        <div className="token-axis">
          <span>{compact(max)}</span>
          <span>{compact(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="token-bars">
          {stats.timeline.map((d) => (
            <button
              key={d.key}
              aria-label={`${d.label || d.day} · ${count(d.input + d.output)} Tokens${!d.observations ? " · 无记录" : ""}`}
              onMouseEnter={() => onSelect(d)}
              onFocus={() => onSelect(d)}
              onClick={d.observations ? (event) => onDrill(d, event.currentTarget) : undefined}
            >
              <span
                className="token-stack"
                style={{ height: ((d.input + d.output) / max) * 100 + "%" }}
              >
                <i className="token-output" style={{ flex: d.output }} />
                <i
                  className="token-cache"
                  style={{ flex: d.cacheRead + d.cacheWrite }}
                />
                <i
                  className="token-input"
                  style={{
                    flex: Math.max(0, d.input - d.cacheRead - d.cacheWrite),
                  }}
                />
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="token-dates">
        <span>
          {stats.grain === "hour"
            ? stats.timeline[0]?.label.split("–")[0]
            : stats.from}
        </span>
        <span>
          {stats.grain === "hour" ? stats.timeline.at(-1)?.label : stats.to}
        </span>
      </div>
      <DayDetail data={selected} />
    </>
  );
}
function DailyOnly({ stats, onDrill }) {
  if (!stats.unallocated.observations) return null;
  return (
    <details className="usage-daily-only">
      <summary>
        <span>仅按日记录</span>
        <strong>
          {count(stats.unallocated.input + stats.unallocated.output)} Tokens
        </strong>
        <span>已计入总量，未分配到小时</span>
      </summary>
      <dl>
        {stats.dailyOnly.map((d) => (
          <div key={d.key}>
            <dt><button type="button" className="usage-drill-trigger" onClick={(event) => onDrill(d, event.currentTarget)}>{d.day}</button></dt>
            <dd>{count(d.calls)} 次调用</dd>
            <dd>
              <strong>{count(d.input + d.output)} Tokens</strong>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
function AccountCard({ row, refresh, busy, monitor, changeMonitor, now }) {
  const { account: a } = row;
  const logo = harnessLogo(row.client.id);
  const antigravity = row.client.id === "antigravity";
  const codex = row.client.id === "codex" && a.kind !== "api";
  const monitored = a.kind !== "api" && ["antigravity", "claude", "codex"].includes(row.client.id);
  const pinnedKey = monitor.pinned?.[row.quotaKey];
  const pinned = row.quotas.find(field => quotaWindowKey(field) === pinnedKey);
  const tightest = antigravity && row.quotas.length > 1
    ? row.quotas.reduce((lowest, q) => q.remainingPercent < lowest.remainingPercent ? q : lowest)
    : null;
  const ordered = pinned ? [pinned, ...row.quotas.filter(field => field !== pinned)] : row.quotas;
  const accountStatus = <>
    <span className={"overview-account-present" + (!a.ready ? " danger" : "")}>
      <i />
      {a.status === "expired" ? "授权已到期"
        : a.status === "refresh-required" ? "待客户端刷新"
          : a.ready ? "已添加" : "待配置"}
    </span>
    {row.source && <span>{row.source.replace(" · 上次查询", "")}</span>}
    {row.updatedAt && <ElapsedTime value={row.updatedAt} prefix={row.source ? "查询于 " : "更新于 "} />}
    {row.error && <span className="danger" title={row.error}>刷新失败</span>}
  </>;
  const renderQuota = (q) => {
    const title = codex && q.label === "5h" ? "5 小时额度"
      : codex && q.label === "周" ? "每周额度" : q.label;
    const label = [q.group, title].filter(Boolean).join(" · ");
    const key = quotaWindowKey(q);
    const observed = row.quotaHistory?.[key]?.at(-1);
    const low = monitor.lowThreshold > 0 && hasFreshQuotaSample(observed, now) && q.remainingPercent <= monitor.lowThreshold;
    return (
      <div className="overview-quota-window" key={key} data-tightest={q === tightest || undefined}
        data-pinned={q === pinned || undefined} data-low={low || undefined}>
        <div className="overview-quota-title">
          <span>{title}</span>
          <strong>
            {Number(q.remainingPercent.toFixed(1))}% <small>剩余</small>
          </strong>
        </div>
        <UsageMeter label={label + " 剩余额度"} value={q.remainingPercent} quota={q} />
        <div className="overview-quota-reset">
          {q.resetsAt ? <QuotaResetTime value={q.resetsAt} /> : <span>重置时间未知</span>}
          {codex && q.resetsAt && <time dateTime={q.resetsAt}>{quotaDateTime(q.resetsAt)}</time>}
        </div>
        {monitored && <div className="overview-quota-actions">
          <button type="button" className="overview-quota-pin" aria-pressed={q === pinned}
            aria-label={(q === pinned ? "取消关注 " : "关注 ") + label}
            onClick={() => changeMonitor({ pinned: { [row.quotaKey]: q === pinned ? null : key } })}>
            <Pin size={12} />{q === pinned ? "已关注" : "关注"}
          </button>
          {low && <span className="overview-quota-low">低额度</span>}
          {q === tightest && <span className="overview-quota-tightest">最紧窗口</span>}
        </div>}
      </div>
    );
  };
  return (
    <article className="overview-account" data-expanded-codex={codex || undefined} data-antigravity={antigravity || undefined}>
      <header>
        <span className="overview-account-avatar" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <UserRound size={19} />}
        </span>
        <div>
          <strong title={row.name}>{row.name}</strong>
          <span>
            {row.clients.join(" · ")} ·{" "}
            {a.badge || (a.kind === "api" ? "API Key" : "OAuth")}
            {row.plan ? " · " + row.plan : ""}
          </span>
        </div>
        {row.canRefresh && (
          <button
            className="model-icon"
            aria-label={row.name + " 刷新额度"}
            title="刷新额度"
            disabled={!!busy}
            onClick={() => refresh(row)}
          >
            <RefreshCw
              size={14}
              className={busy === row.key ? "spin" : undefined}
            />
          </button>
        )}
      </header>
      {antigravity && <div className="overview-account-meta">
        {accountStatus}
        {row.amounts.map((field) => (
          <span className="overview-account-amount" key={field.id}
            title={field.unknown ? "接口未返回可确认的数值" : undefined}>
            {field.label} <strong>{quotaAmountText(field)}</strong>
          </span>
        ))}
      </div>}
      {!!row.quotas.length && <div className="overview-quota-groups">
        {groupQuotaWindows(ordered).map(([group, windows]) => (
          <div key={group} role={group ? "group" : undefined} aria-label={group || undefined}>
            {(group || codex) && <h3 className="quota-group-title">{group || "订阅额度"}</h3>}
            <div className="overview-quota-windows" data-primary={codex && !group || undefined}>{windows.map(renderQuota)}</div>
          </div>
        ))}
      </div>}
      {!antigravity && !!row.amounts.length && (
        <div className="overview-amounts">
          {row.amounts.map((f) => (
            <span key={f.id} title={f.unknown ? "接口未返回可确认的数值" : undefined}>
              <small>{f.label}</small>
              <strong>{quotaAmountText(f)}</strong>
              {codex && f.id === "codex-reset-credits" && <ResetCreditDetails credit={f} />}
            </span>
          ))}
        </div>
      )}
      {monitored && row.quotas.length > 0 &&
        <QuotaHistory windows={row.quotas} history={row.quotaHistory} focus={pinned || tightest || row.quotas[0]} now={now} />}
      {!antigravity && <footer>{accountStatus}</footer>}
    </article>
  );
}
export function Overview({ state, act, setView, setClientTarget, onOpenUsageConversation }) {
  const savedOptions = state.preferences.usage || {
    client: "all",
    range: "month",
    tab: "activity",
    group: "client",
  };
  const clients = detectedClients(state);
  const visibleIds = new Set(clients.map((c) => c.id));
  const options = { ...savedOptions, client: visibleIds.has(savedOptions.client) ? savedOptions.client : "all" };
  const usage = state.usage || { rows: [], sources: [] };
  const [selected, setSelected] = useState(null),
    [refreshing, setRefreshing] = useState("");
  const [drill, setDrill] = useState(null);
  const drillOpener = useRef(null);
  const [today, setToday] = useState(() => new Date());
  const stats = useMemo(
    () => summarize(usage.rows.filter((r) => visibleIds.has(r.client)), options, today),
    [usage.rows, options.client, options.range, options.group, today, clients.map((c) => c.id).join(",")],
  );
  const accounts = overviewAccounts(state, options.client);
  const quotaAccounts = accounts.filter(hasQuotaCard);
  const otherAccounts = accounts.filter((row) => !hasQuotaCard(row));
  const quotaMonitor = state.preferences.quotaMonitor || {};
  const quotaNow = Date.now();
  const changeQuotaMonitor = patch => act("quota-monitor", () => api.call("ui-preferences", { quotaMonitor: patch }));
  const filteredSources = usage.sources.filter(
    (s) => visibleIds.has(s.client) && (options.client === "all" || s.client === options.client),
  );
  const change = (patch) => {
    setSelected(null);
    setDrill(null);
    act("usage-options", () => api.call("ui-preferences", { usage: patch }));
  };
  const refresh = () => act("usage-refresh", () => api.call("usage-refresh"));
  useEffect(() => {
    const read = () => {
      if (!document.hidden) {
        setToday(new Date());
        api.call("usage-refresh", true).catch(() => {});
      }
    };
    read();
    const timer = setInterval(read, 60000);
    return () => clearInterval(timer);
  }, []);
  async function refreshAccount(row) {
    setRefreshing(row.key);
    try {
      await act("quota-" + row.key, () =>
        api.call("account-info", row.client.id, row.account.id),
      );
    } finally {
      setRefreshing("");
    }
  }
  const hasData = stats.total.observations > 0;
  const day = selected && stats.timeline.find((d) => d.key === selected.key);
  const hasTimedData = stats.timeline.some((d) => d.observations > 0);
  function openDrill(label, query, trigger) {
    drillOpener.current = trigger;
    setDrill({ label, query: {
      from: stats.from, to: stats.to, cutoffDay: stats.to, cutoffHour: today.getHours(),
      filterClients: options.client === 'all' ? [...visibleIds] : [options.client], ...query,
    } });
  }
  function openPeriod(bucket, trigger) {
    openDrill(bucket.label || bucket.day, { from: bucket.day, to: bucket.day,
      ...(Number.isInteger(bucket.hour) ? { hours: [bucket.hour, bucket.hour + stats.periodHours] } : {}),
      ...(bucket.key.endsWith('-daily') ? { dayOnly: true } : {}),
    }, trigger);
  }
  function closeDrill() {
    setDrill(null);
    drillOpener.current?.focus();
  }
  return (
    <div className="usage-overview">
      <div
        className="overview-client-tabs"
        role="group"
        aria-label="用量客户端"
      >
        <button
          aria-pressed={options.client === "all"}
          onClick={() => change({ client: "all" })}
        >
          <Layers size={16} />
          汇总
        </button>
        {clients.map((c) => (
          <button
            key={c.id}
            aria-pressed={options.client === c.id}
            onClick={() => change({ client: c.id })}
          >
            <span
              className={
                "client-presence" +
                (c.accounts.some((a) => a.ready) ? " present" : "")
              }
            />
            {CLIENT_NAMES[c.id]}
            <small>{c.accounts.filter((a) => a.ready).length}</small>
          </button>
        ))}
      </div>
      <div className="usage-toolbar">
        <Segments
          label="用量视图"
          value={options.tab}
          items={[
            ["activity", "活跃趋势"],
            ["tokens", "Token"],
            ["quota", "账户与额度"],
          ]}
          onChange={(tab) => change({ tab })}
        />
        <div className="actions">
          {options.tab !== "quota" && (
            <Segments
              label="统计时间范围"
              value={options.range}
              items={[
                ["week", "本周"],
                ["month", "本月"],
                ["year", "近一年"],
              ]}
              onChange={(range) => change({ range })}
            />
          )}
          <button
            type="button"
            className="usage-refresh-button"
            aria-label="刷新本地用量"
            aria-disabled={usage.loading === true}
            aria-busy={usage.loading === true}
            title={usage.loading ? "读取本地用量…" : "刷新本地用量"}
            onClick={() => { if (!usage.loading) refresh(); }}
          >
            <UsageRefreshGlyph busy={usage.loading} />
          </button>
        </div>
      </div>
      {options.tab !== "quota" && (
        <>
          <div className="usage-kpis">
            {[
              ["总 Token", stats.total.input + stats.total.output, Layers],
              ["输入", stats.total.input, ArrowDownLeft],
              ["输出", stats.total.output, ArrowUpRight],
              ["缓存读取", stats.total.cacheRead, Zap],
            ].map(([name, value, Icon]) => (
              <div className="usage-kpi" key={name}>
                <span>
                  <Icon size={15} />
                  {name}
                </span>
                <strong title={hasData ? count(value) : "暂无记录"}>
                  {hasData ? compact(value) : "—"}
                </strong>
              </div>
            ))}
          </div>
          <section
            className="usage-chart-panel"
            aria-label={options.tab === "tokens" ? "Token 趋势" : "活跃趋势"}
          >
            <header>
              <h2>
                {options.client === "all"
                  ? "全部客户端"
                  : CLIENT_NAMES[options.client]}
                {options.tab === "tokens" ? " Token 趋势" : "活跃趋势"}
              </h2>
              <span>
                {options.range !== "year" && (
                  <span className="usage-grain">
                    {stats.periodHours === 4 ? "每 4 小时" : "按小时"}
                  </span>
                )}
                {stats.from} — {stats.to}
              </span>
            </header>
            {usage.loading && !usage.updatedAt ? (
              <div className="usage-empty usage-loading" role="status">
                <UsageRefreshGlyph busy large />
                <span>读取本地用量…</span>
              </div>
            ) : !hasData ? (
              <div className="usage-empty">
                <Activity size={28} />
                <strong>此范围暂无用量记录</strong>
              </div>
            ) : stats.grain === "hour" && !hasTimedData ? (
              <div className="usage-empty">
                <Activity size={28} />
                <strong>此范围只有日汇总，暂无小时记录</strong>
              </div>
            ) : options.tab === "tokens" ? (
              <TokenChart
                {...{ stats, selected: day, onSelect: setSelected, onDrill: openPeriod }}
              />
            ) : (
              <Heatmap {...{ stats, selected: day, onSelect: setSelected, onDrill: openPeriod }} />
            )}
            <DailyOnly stats={stats} onDrill={openPeriod} />
            <div className="usage-chart-meta">
              <span>
                {hasData
                  ? `${count(stats.total.calls)} 次调用 · ${stats.total.sessions.size} 个活跃会话`
                  : "—"}
                {filteredSources.some((s) => s.partial) && (
                  <span
                    className="usage-partial"
                    title="部分本地记录未能读取，当前值只包含已读记录"
                  >
                    {" "}
                    · 部分记录
                  </span>
                )}
              </span>
              {usage.updatedAt && <ElapsedTime value={usage.updatedAt} />}
            </div>
          </section>
          <section className="usage-breakdown">
            <header>
              <h2>用量分类</h2>
              <Segments
                label="分类维度"
                value={options.group}
                items={[
                  ["client", "客户端"],
                  ["model", "模型"],
                ]}
                onChange={(group) => change({ group })}
              />
            </header>
            {stats.groups.length ? (
              <div className="usage-group-list">
                {stats.groups.map((g) => (
                  <button type="button" className="usage-group" key={g.name}
                    onClick={(event) => openDrill(g.name, options.group === 'model' ? { model: g.name } : {
                      filterClients: clients.filter((client) => (CLIENT_NAMES[client.id] || client.id) === g.name).map((client) => client.id),
                    }, event.currentTarget)}>
                    <span className="usage-group-label" title={g.name}>{g.name}</span>
                    <span className="usage-group-track" aria-hidden="true">
                      <i
                        style={{
                          width:
                            (stats.total.input + stats.total.output
                              ? ((g.input + g.output) /
                                  (stats.total.input + stats.total.output)) *
                                100
                              : 0) + "%",
                        }}
                      />
                    </span>
                    <strong title={count(g.input + g.output)}>
                      {compact(g.input + g.output)}
                    </strong>
                    <small>{count(g.calls)} 次</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted tiny">暂无记录</p>
            )}
          </section>
          {drill ? <UsageDrilldown key={JSON.stringify(drill.query)} selection={drill} act={act}
            onClose={closeDrill} onOpenConversation={onOpenUsageConversation} /> : null}
        </>
      )}
      <section className="overview-accounts">
        <header>
          <h2>
            账户与额度 <span className="count">{quotaAccounts.length}</span>
          </h2>
          <button
            className="text-button"
            onClick={() => {
              if (options.client !== "all") setClientTarget(options.client);
              setView("clients");
            }}
          >
            管理账户
            <ChevronRight size={14} />
          </button>
        </header>
        {quotaAccounts.length ? (
          <div className="overview-accounts-grid">
            {quotaAccounts.map((row) => (
              <AccountCard
                key={row.key}
                row={row}
                busy={refreshing}
                refresh={refreshAccount}
                monitor={quotaMonitor}
                changeMonitor={changeQuotaMonitor}
                now={quotaNow}
              />
            ))}
          </div>
        ) : (
          <p className="muted tiny">{accounts.length ? "暂无额度或订阅信息" : "没有已添加的账户"}</p>
        )}
        {!!otherAccounts.length && (
          <details className="overview-other-accounts">
            <summary>其他账户 <span className="count">{otherAccounts.length}</span></summary>
            <div className="overview-accounts-grid">
              {otherAccounts.map((row) => (
                <AccountCard key={row.key} row={row} busy={refreshing} refresh={refreshAccount}
                  monitor={quotaMonitor} changeMonitor={changeQuotaMonitor} now={quotaNow} />
              ))}
            </div>
          </details>
        )}
      </section>
      {usage.error && (
        <p className="danger tiny" role="alert">
          {usage.error}
        </p>
      )}
      <details className="usage-sources">
        <summary>
          <Info size={13} />
          数据范围
        </summary>
        <p>
          Token
          来自 Windows、WSL 与项目隔离目录的本地记录；输入包含缓存读取与写入，推理包含于输出。订阅额度为各账户上次查询结果，不折算
          Token、不跨账户相加。时间按 {usage.timeZone || "本机时区"} 统计。
        </p>
        {filteredSources.map((s) => (
          <div key={s.client}>
            <strong>{CLIENT_NAMES[s.client]}</strong>
            <span>{s.format}</span>
            <span>
              {s.status === "partial"
                ? "部分记录未能读取"
                : s.status === "empty"
                  ? "没有记录"
                  : s.files + " 个文件"}
            </span>
          </div>
        ))}
        <p>
          DSH 使用已有 cost-meter
          账本的日期范围；不重复叠加路由日志。按客户端、模型汇总，不猜测历史请求使用的登录账户。
        </p>
      </details>
    </div>
  );
}
