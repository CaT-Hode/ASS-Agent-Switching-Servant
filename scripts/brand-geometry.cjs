"use strict";

// Narrow each traced petal in its own radial frame, then fit the central hub
// to the resulting roots and gap-width bridges. The reference SVG stays intact.
const fs = require("node:fs");
const path = require("node:path");
const SPEC = Object.freeze({
  size: 1254, center: [626.5, 627], petals: 8, gap: 20, petalWidthScale: 0.93,
  rootDepth: 32, simplifyTolerance: 1.5, holeRadius: 132, centerScale: 1.24,
  petalColor: "#ffffff", petalOutlineWidth: 80, canvasPadding: 64, hubColor: "#dc782f",
});
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, n) => [a[0] * n, a[1] * n];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const length = (a) => Math.hypot(...a);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const unit = (a) => mul(a, 1 / length(a));
const radius = (a) => length(sub(a, SPEC.center));
const n = (v) => String(Number(v.toFixed(5)));
const point = (p) => p.map(n).join(" ");

function loadPetals() {
  const svg = fs.readFileSync(path.join(__dirname, "../public/ass-logo-reference.svg"), "utf8");
  const petals = [...svg.matchAll(/<path\b[^>]*id="(petal-\d+)"[^>]*d="([^"]+)"[^>]*\/>/g)]
    .map(match => ({ id: match[1], d: match[2], tag: match[0] }));
  if (petals.length !== 8) throw Error("The exact eight reference petals are required");
  return petals;
}
function samplePath(d) {
  const tokens = d.match(/[MLCZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) || [];
  const result = [];
  let i = 0, current, start, command;
  const read = () => [Number(tokens[i++]), Number(tokens[i++])];
  while (i < tokens.length) {
    if (/^[MLCZ]$/i.test(tokens[i])) command = tokens[i++];
    if (command === "M") { current = read(); start = current; result.push(current); command = "L"; }
    else if (command === "L") {
      const end = read(), begin = current, steps = Math.max(1, Math.ceil(length(sub(end, begin)) / 1.5));
      for (let s = 1; s <= steps; s++) result.push(add(begin, mul(sub(end, begin), s / steps)));
      current = end;
    } else if (command === "C") {
      const begin = current, a = read(), b = read(), end = read();
      const steps = Math.max(4, Math.ceil((length(sub(a, begin)) + length(sub(b, a)) + length(sub(end, b))) / 1.5));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        result.push([0, 1].map(k => begin[k] * u ** 3 + 3 * a[k] * u ** 2 * t + 3 * b[k] * u * t ** 2 + end[k] * t ** 3));
      }
      current = end;
    } else if (command === "Z") { current = start; command = undefined; }
    else throw Error("Unsupported reference path command");
  }
  if (length(sub(result[0], result[result.length - 1])) < 0.1) result.pop();
  return result;
}
function pointSegmentDistance(p, a, b) {
  const edge = sub(b, a), squared = dot(edge, edge);
  const t = squared ? Math.max(0, Math.min(1, dot(sub(p, a), edge) / squared)) : 0;
  return length(sub(p, add(a, mul(edge, t))));
}
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let maximum = 0, split = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maximum) { maximum = distance; split = i; }
  }
  if (maximum <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify(points.slice(split), tolerance)];
}
function rootContour(petal) {
  const samples = samplePath(petal.d), radii = samples.map(radius);
  const minimum = Math.min(...radii), middle = radii.indexOf(minimum), limit = minimum + SPEC.rootDepth;
  const at = (i) => (i + samples.length) % samples.length;
  let left = middle, right = middle;
  while (radii[at(left - 1)] <= limit && at(left - 1) !== right) left = at(left - 1);
  while (radii[at(right + 1)] <= limit && at(right + 1) !== left) right = at(right + 1);
  const chain = [];
  for (let i = left; ; i = at(i + 1)) { chain.push(samples[i]); if (i === right) break; }
  const angle = Math.atan2(samples[middle][1] - SPEC.center[1], samples[middle][0] - SPEC.center[0]);
  const relativeAngle = (p) => {
    let a = Math.atan2(p[1] - SPEC.center[1], p[0] - SPEC.center[0]) - angle;
    while (a < -Math.PI) a += 2 * Math.PI;
    while (a > Math.PI) a -= 2 * Math.PI;
    return a;
  };
  if (relativeAngle(chain[0]) > relativeAngle(chain[chain.length - 1])) chain.reverse();
  const contour = simplify(chain, SPEC.simplifyTolerance);
  return { id: petal.id, angle, minimum, samples, contour };
}
function narrowPetal(petal) {
  const samples = samplePath(petal.d), centroid = samples.reduce((a, p) => add(a, p), [0, 0]).map(v => v / samples.length);
  const radial = unit(sub(centroid, SPEC.center)), tangent = [-radial[1], radial[0]];
  const tokens = petal.d.match(/[MLCZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi), transformed = [];
  for (let i = 0; i < tokens.length;) {
    if (/^[MLCZ]$/i.test(tokens[i])) { transformed.push(tokens[i++]); continue; }
    const offset = sub([Number(tokens[i++]), Number(tokens[i++])], SPEC.center);
    transformed.push(point(add(SPEC.center, add(mul(radial, dot(offset, radial)), mul(tangent, dot(offset, tangent) * SPEC.petalWidthScale)))));
  }
  const d = transformed.join(' ').replace(/\s*Z\s*$/i, '') + ' Z';
  // Only the outside half of this stroke is visible: the original petal
  // silhouettes are punched out below, so white occupies their surrounding gaps.
  const tag = `<path id="${petal.id}" d="${d}" fill="none" stroke="${SPEC.petalColor}" stroke-width="${SPEC.petalOutlineWidth * 2}" stroke-linejoin="round"/>`;
  return { ...petal, d, tag };
}
function createGeometry() {
  const petals = loadPetals().map(narrowPetal), roots = petals.map(rootContour).sort((a, b) => a.angle - b.angle);
  const perimeter = [], kinds = [];
  for (const root of roots) {
    for (let i = 0; i < root.contour.length; i++) {
      // Enlarge the fitted center and its clearance mask together. The traced
      // petal curves remain intact; only their concealed roots are clipped.
      perimeter.push(add(SPEC.center, mul(sub(root.contour[i], SPEC.center), SPEC.centerScale)));
      kinds.push(i + 1 < root.contour.length ? { type: "petal", id: root.id } : { type: "gap", id: root.id });
    }
  }
  const facets = perimeter.map((a, i) => {
    const b = perimeter[(i + 1) % perimeter.length], direction = unit(sub(b, a));
    const outward = [direction[1], -direction[0]];
    return { a: sub(a, mul(outward, SPEC.gap)), direction, outward, ...kinds[i] };
  });
  const hub = facets.map((edge, i) => {
    const previous = facets[(i + facets.length - 1) % facets.length];
    const divisor = cross(previous.direction, edge.direction);
    if (Math.abs(divisor) < 1e-8) return mul(add(previous.a, edge.a), 0.5);
    return add(previous.a, mul(previous.direction, cross(sub(edge.a, previous.a), edge.direction) / divisor));
  });
  return { spec: SPEC, petals, roots, perimeter, facets, hub };
}
function buildLogoSvg(geometry = createGeometry()) {
  const outer = `M ${point(geometry.hub[0])} ` + geometry.hub.slice(1).map(p => `L ${point(p)}`).join(" ") + " Z";
  const [cx, cy] = SPEC.center, r = SPEC.holeRadius;
  const hole = `M ${n(cx + r)} ${n(cy)} A ${r} ${r} 0 1 0 ${n(cx - r)} ${n(cy)} A ${r} ${r} 0 1 0 ${n(cx + r)} ${n(cy)} Z`;
  const centerClearance = `M ${point(geometry.perimeter[0])} ` + geometry.perimeter.slice(1).map(p => `L ${point(p)}`).join(" ") + " Z";
  const cutouts = geometry.petals.map(p => `<path d="${p.d}" fill="#000000"/>`).join("\n");
  const padding = SPEC.canvasPadding, side = SPEC.size + padding * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="${-padding} ${-padding} ${side} ${side}" role="img" aria-labelledby="title">\n<title id="title">ASS — joined bold white outlines with hollow petals and an orange gear</title>\n<defs>\n<mask id="petal-cutouts" maskUnits="userSpaceOnUse" x="${-padding}" y="${-padding}" width="${side}" height="${side}" style="mask-type:luminance">\n<rect x="${-padding}" y="${-padding}" width="${side}" height="${side}" fill="#ffffff"/>\n${cutouts}\n<path d="${centerClearance}" fill="#000000"/>\n</mask>\n</defs>\n<g mask="url(#petal-cutouts)">\n${geometry.petals.map(p => p.tag).join("\n")}\n</g>\n<path id="hub-fitted" fill="${SPEC.hubColor}" fill-rule="evenodd" d="${outer} ${hole}"/>\n</svg>\n`;
}
module.exports = { SPEC, loadPetals, narrowPetal, samplePath, createGeometry, buildLogoSvg, pointSegmentDistance };
