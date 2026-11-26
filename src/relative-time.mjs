export function relativeTime(value, now = Date.now()) {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "时间未知";
  if (elapsed < -60000) return "时间异常";
  if (elapsed < 60000) return "刚刚";
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return `${Math.floor(elapsed / 86400000)} 天前`;
}

export function quotaResetText(value, now = Date.now()) {
  const remaining = Date.parse(value) - now;
  if (!Number.isFinite(remaining)) return "";
  if (remaining <= 0) return "已到重置时间";
  if (remaining < 60000) return "不到 1 分钟后重置";
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const segments = days
    ? [days + " 天", hours ? hours + " 小时" : ""]
    : [hours ? hours + " 小时" : "", mins ? mins + " 分钟" : ""];
  return segments.filter(Boolean).join(" ") + "后重置";
}

const quotaClock = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function quotaDateTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? quotaClock.format(ms) : "";
}

export function exactTime(value) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "时间未知";
  return time.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
