// Only the inner part of each outline moves. Outer control points stay fixed,
// so gathering the roots never reads as shrinking the entire flower.
export function gatherInnerPath(path, { cx, cy }) {
  const tokens = path.match(/[A-Za-z]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g) || [];
  if (tokens.some(token => /^[A-Za-z]$/.test(token) && !['M', 'L', 'C', 'Z'].includes(token))) return path;
  for (let i = 0; i < tokens.length; i++) {
    if (/^[A-Za-z]$/.test(tokens[i])) continue;
    const x = Number(tokens[i]), y = Number(tokens[i + 1]);
    if (!Number.isFinite(y)) return path;
    const dx = x - cx, dy = y - cy, radius = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, (radius - 270) / 250));
    const weight = 1 - t * t * (3 - 2 * t);
    if (weight > 0 && radius > 0) {
      const nextRadius = radius - (radius - 12) * weight;
      const angle = Math.atan2(dy, dx) + weight * .12;
      tokens[i] = (cx + Math.cos(angle) * nextRadius).toFixed(3);
      tokens[i + 1] = (cy + Math.sin(angle) * nextRadius).toFixed(3);
    }
    i++;
  }
  return tokens.join(' ');
}
