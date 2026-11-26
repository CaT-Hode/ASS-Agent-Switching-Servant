export const switchLens = { width: 62.05, height: 39.1, overscan: 4 };
export const rangeLens = { width: 60, height: 40, overscan: 10 };

const density = 2;
const convexHeight = t => (1 - Math.max(0, 1 - t) ** 4) ** .25;

// The lip transitions from a raised outer edge into a shallow inner curve.
function lipHeight(t) {
  const convex = (1 - Math.max(0, 1 - 2 * t) ** 4) ** .25;
  const concave = 1.1 - Math.sqrt(t * (2 - t));
  const blend = t ** 3 * (10 + t * (-15 + 6 * t));
  return convex + (concave - convex) * blend;
}

function rayOffset(t, bevelWidth, thickness, profile, index) {
  const height = profile(t);
  const slope = (profile(t + .0001) - height) / .0001;
  const incidence = Math.atan(slope);
  const transmitted = Math.asin(Math.sin(incidence) / index);
  return Math.tan(incidence - transmitted) * (thickness + height * bevelWidth);
}

function buildOptics({ width, height, overscan }, bevelWidth, thickness, profile, index) {
  const radius = height / 2;
  const imageWidth = width + 2 * overscan, imageHeight = height + 2 * overscan;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(imageWidth * density);
  canvas.height = Math.ceil(imageHeight * density);
  const context = canvas.getContext('2d');
  if (!context) return null;

  const displacement = context.createImageData(canvas.width, canvas.height);
  const highlight = context.createImageData(canvas.width, canvas.height);
  const offsets = Array.from({ length: 128 }, (_, i) => rayOffset(i / 128, bevelWidth, thickness, profile, index));
  const channel = value => Math.round(128 + 127 * value / 100);
  // One shared map in the untransformed capsule's local coordinates. The extra
  // source area stays available when the visible rim moves across the track.
  const halfStraight = width / 2 - radius;
  for (let y = 0; y < canvas.height; y++) {
    const dy = (y + .5) * imageHeight / canvas.height - imageHeight / 2;
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * imageWidth / canvas.width - imageWidth / 2;
      const dx = Math.sign(px) * Math.max(0, Math.abs(px) - halfStraight);
      const distance = Math.hypot(dx, dy);
      const depth = radius - distance;
      const inBezel = depth >= 0 && depth < bevelWidth;
      const vx = inBezel ? dx / distance : 0, vy = inBezel ? dy / distance : 0;
      const offset = inBezel ? offsets[Math.floor(depth / bevelWidth * offsets.length)] : 0;
      const i = (y * canvas.width + x) * 4;
      displacement.data.set([channel(-vx * offset), channel(-vy * offset), 0, 255], i);
      if (depth > 0 && depth < 2) {
        const incidence = Math.abs(.5 * vx - .866 * vy);
        const strength = incidence * Math.sqrt(depth * (2 - depth));
        const gray = Math.round(255 * strength);
        highlight.data.set([gray, gray, gray, Math.round(255 * strength ** 2)], i);
      }
    }
  }
  context.putImageData(displacement, 0, 0);
  const map = canvas.toDataURL();
  context.putImageData(highlight, 0, 0);
  const result = { width: imageWidth, height: imageHeight, map, highlight: canvas.toDataURL(), scale: Math.max(...offsets.map(Math.abs)) };
  canvas.width = canvas.height = 0;
  return result;
}

let switchTexture, rangeTexture;
export function switchOptics() {
  if (switchTexture === undefined) switchTexture = buildOptics(switchLens, 8.075, 19.975, lipHeight, 1.5);
  return switchTexture;
}
export function rangeOptics() {
  if (rangeTexture === undefined) rangeTexture = buildOptics(rangeLens, 10.667, 53.333, convexHeight, 1.45);
  return rangeTexture;
}
