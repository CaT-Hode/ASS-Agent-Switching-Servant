const clamp = (value) => Math.max(0, Math.min(1, value));
// Match click selection to the thumb's physical stops, including its inset.
export function themeAtPoint(clientX, left, width) {
  const position = clamp((clientX - left - 19) / Math.max(1, width - 38));
  return ["light", "system", "dark"][Math.round(position * 2)];
}
// Closed-form critically damped spring. Retargeting keeps presentation position
// and velocity, including when the pointer grabs a still-moving thumb.
export function springStep(position, velocity, target, seconds, frequency = 28) {
  const displacement = position - target, c = velocity + frequency * displacement;
  const decay = Math.exp(-frequency * seconds);
  return { position: target + (displacement + c * seconds) * decay,
    velocity: (velocity - frequency * c * seconds) * decay };
}
export function dragPosition(value) {
  const bound = clamp(value), over = value - bound;
  return bound + over * .15 / (1 + Math.abs(over) * 4);
}
export function themeMotion(initial, paint, clock = {
  request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id), now: () => performance.now(),
}) {
  let position = initial, velocity = 0, target = initial, frame = null, previous;
  const stop = () => { if (frame !== null) clock.cancel(frame); frame = null; };
  const draw = (settled = false) => paint(clamp(position), dragPosition(position), settled);
  const tick = (time) => {
    const next = springStep(position, velocity, target, Math.min(.064, Math.max(0, (time - previous) / 1000)));
    previous = time; position = next.position; velocity = next.velocity;
    if (Math.abs(position - target) < .001 && Math.abs(velocity) < .015) {
      position = target; velocity = 0; frame = null; draw(true); return;
    }
    draw(); frame = clock.request(tick);
  };
  draw(true);
  return {
    get position() { return position; },
    get velocity() { return velocity; },
    grab() { stop(); draw(); return position; },
    drag(value) { stop(); position = value; velocity = 0; draw(); },
    settle(next, { speed, instant = false } = {}) {
      if (frame !== null && target === next && speed === undefined && !instant) return;
      stop(); target = clamp(next);
      if (instant) { position = target; velocity = 0; draw(true); return; }
      if (Number.isFinite(speed)) velocity = speed;
      previous = clock.now(); frame = clock.request(tick);
    },
    dispose: stop,
  };
}
