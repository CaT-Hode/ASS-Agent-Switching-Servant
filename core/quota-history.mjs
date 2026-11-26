const hour = 60 * 60 * 1000;
export const quotaRetentionMs = 14 * 24 * hour;
const freshQuotaMs = 15 * 60 * 1000;
const maxPointsPerWindow = 96;
const maxPointsPerAccount = 320;

export const quotaWindowKey = field => JSON.stringify([field.id, field.group || "", field.label]);

export function hasFreshQuotaSample(point, now) {
  return !!point && point[0] <= now && now - point[0] <= freshQuotaMs && (point[2] === null || point[2] > now);
}

export function recordQuotaHistory(history, fields, observedAt) {
  const points = Object.fromEntries(Object.entries(history || {}).map(([key, samples]) => [
    key, samples.filter(([time]) => time >= observedAt - quotaRetentionMs),
  ]));
  for (const field of fields) {
    if (field.kind !== "quota" || !Number.isFinite(field.remainingPercent)) continue;
    const key = quotaWindowKey(field), samples = points[key] || [];
    if (observedAt <= (samples.at(-1)?.[0] || 0)) continue;
    const reset = Date.parse(field.resetsAt);
    points[key] = [...samples, [observedAt, field.remainingPercent, reset > 0 ? reset : null]]
      .slice(-maxPointsPerWindow);
  }
  const retained = Object.entries(points).flatMap(([key, samples]) => samples.map(sample => [key, sample]))
    .sort((a, b) => b[1][0] - a[1][0]).slice(0, maxPointsPerAccount).reverse();
  const byWindow = {};
  for (const [key, sample] of retained) (byWindow[key] ||= []).push(sample);
  return byWindow;
}

export function quotaTrend(samples, now) {
  const latest = samples.at(-1);
  if (!hasFreshQuotaSample(latest, now) || latest[2] === null) return null;

  // Only use the trailing continuous series within this reset window. A balance
  // increase indicates a refill or correction and starts a new series.
  let start = samples.length - 1;
  while (start > 0) {
    const prev = samples[start - 1], next = samples[start];
    if (prev[2] !== latest[2] || prev[1] < next[1] || next[0] - prev[0] > hour || latest[0] - prev[0] > 6 * hour) break;
    start--;
  }
  const first = samples[start], duration = latest[0] - first[0], used = first[1] - latest[1];
  if (samples.length - start < 3 || duration < 20 * 60 * 1000 || used < 0.1) return null;
  const perHour = used / (duration / hour);
  const depletion = latest[0] + latest[1] / perHour * hour;
  return { perHour, depletion: depletion < latest[2] ? depletion : null };
}
