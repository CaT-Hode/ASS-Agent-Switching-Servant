const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SPEC, loadPetals, narrowPetal, samplePath, createGeometry, buildLogoSvg, pointSegmentDistance } = require("../scripts/brand-geometry.cjs");
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test("eight individually traced petals become narrower while keeping their radial length and flat silhouette", () => {
  const reference = loadPetals(), svg = buildLogoSvg();
  assert.equal(reference.length, 8);
  for (const petal of reference) {
    const narrowed = narrowPetal(petal); assert.notEqual(narrowed.d, petal.d); assert.ok(svg.includes(narrowed.tag), petal.id);
    assert.ok(narrowed.tag.includes(`id="${petal.id}"`)); assert.ok(narrowed.tag.includes(` d="${narrowed.d}"`));
    assert.match(narrowed.d, / Z$/);
    assert.ok(narrowed.tag.includes('fill="none" stroke="#ffffff"'));
    const original = samplePath(petal.d), next = samplePath(narrowed.d);
    const mean = original.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map(v => v / original.length);
    const radial = sub(mean, SPEC.center), len = Math.hypot(...radial), axis = radial.map(v => v / len), tangent = [-axis[1], axis[0]];
    const span = (points, direction) => { const values = points.map(p => dot(sub(p, SPEC.center), direction)); return Math.max(...values) - Math.min(...values); };
    assert.ok(Math.abs(span(next, tangent) / span(original, tangent) - 0.93) < 0.001);
    assert.ok(Math.abs(span(next, axis) / span(original, axis) - 1) < 0.001);
  }
  assert.ok(SPEC.gap > 16);
  assert.equal((svg.match(/id="petal-\d+"/g) || []).length, 8);
  assert.ok(svg.includes('mask="url(#petal-cutouts)"'));
  assert.equal((svg.match(/fill="#000000"/g) || []).length, 9);
  assert.ok(svg.includes('id="hub-fitted"'));
  assert.ok(svg.includes(`A ${SPEC.holeRadius} ${SPEC.holeRadius}`));
  assert.doesNotMatch(svg, /<use|rotate\(|gradient|filter=|opacity=|<image|data:image|<script/i);
});
test("actual petal-root facets AND all eight gap-width bridges share the same hub clearance", () => {
  const { hub, perimeter, facets } = createGeometry();
  assert.equal(facets.filter(f => f.type === "gap").length, 8);
  assert.equal(new Set(facets.filter(f => f.type === "petal").map(f => f.id)).size, 8);
  for (let i = 0; i < perimeter.length; i++) {
    const next = (i + 1) % hub.length;
    for (const p of [hub[i], hub[next]]) near(dot(sub(perimeter[i], p), facets[i].outward), SPEC.gap);
    near(dot(sub(hub[next], hub[i]), facets[i].outward), 0);
    assert.ok(hub[i].every(Number.isFinite));
  }
});
test("enlarged fitted hub stays clear of the shared petal clipping perimeter and keeps a substantial circular band", () => {
  const { hub, perimeter } = createGeometry();
  let closest = Infinity;
  for (let i = 0; i < hub.length; i++) {
    const a = hub[i], b = hub[(i + 1) % hub.length];
    for (let step = 0; step <= 4; step++) {
      const p = a.map((v, k) => v + (b[k] - v) * step / 4);
      assert.ok(Math.hypot(...sub(p, SPEC.center)) > SPEC.holeRadius + 32);
      for (let j = 0; j < perimeter.length; j++) closest = Math.min(closest,
        pointSegmentDistance(p, perimeter[j], perimeter[(j + 1) % perimeter.length]));
    }
  }
  assert.ok(closest >= SPEC.gap - SPEC.simplifyTolerance - 1.1, `hub clearance: ${closest}`);
});
