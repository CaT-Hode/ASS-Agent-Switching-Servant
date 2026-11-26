import React, { useSyncExternalStore } from "react";
import { relativeTime, exactTime, quotaResetText } from "./relative-time.mjs";

// One clock for all visible model rows; never poll the main process or upstream.
const listeners = new Set();
let now = Date.now(),
  timer;
function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}
function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(tick, 15000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    }
  };
}
const getSnapshot = () => now;
export function ElapsedTime({ value, prefix = "更新于 " }) {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <time dateTime={value} title={exactTime(value)}>
      {prefix}
      {relativeTime(value, current)}
    </time>
  );
}
export function QuotaResetTime({ value }) {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  const label = quotaResetText(value, current);
  return label ? <time dateTime={value} title={exactTime(value)}>{label}</time> : null;
}
export function DiagnosticTime({ result }) {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <span className="diagnostic-time muted">
      <time
        dateTime={result.time}
        title={"上次测试：" + exactTime(result.time)}
      >
        上次测试：{relativeTime(result.time, current)}
      </time>
      {result.saveError && (
        <span className="danger"> · {result.saveError}</span>
      )}
      {result.stale && <span> · 需重新检测</span>}
    </span>
  );
}
