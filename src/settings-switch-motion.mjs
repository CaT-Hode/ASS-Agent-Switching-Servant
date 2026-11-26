const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const unit = value => clamp(value, 0, 1);
const atRest = value => ({ value, velocity: 0 });

export const switchTravel = (160 - 67 - (146 - 92) * .65) * .425;
const stops = {
  rest: { scale: .65, fill: 1, refraction: .4 },
  press: { scale: .9, fill: .1, refraction: .9 },
};

// Analytic damped oscillator. Each axis keeps its velocity when redirected.
function spring(stiffness, damping) {
  const drag = damping * .9 / 2;
  const delta = stiffness * .9 ** 2 - drag ** 2;
  const frequency = Math.sqrt(Math.abs(delta));
  return (axis, target, seconds) => {
    const offset = axis.value - target;
    if (delta > 0) {
      const c = (axis.velocity + drag * offset) / frequency;
      const cosine = Math.cos(frequency * seconds), sine = Math.sin(frequency * seconds);
      const decay = Math.exp(-drag * seconds);
      axis.value = target + decay * (offset * cosine + c * sine);
      axis.velocity = decay * ((-drag * offset + frequency * c) * cosine + (-drag * c - frequency * offset) * sine);
      return;
    }
    const slow = -drag + frequency, fast = -drag - frequency;
    const first = (axis.velocity - fast * offset) / (slow - fast);
    const slowPart = first * Math.exp(slow * seconds), fastPart = (offset - first) * Math.exp(fast * seconds);
    axis.value = target + slowPart + fastPart;
    axis.velocity = slow * slowPart + fast * fastPart;
  };
}

const positionSpring = spring(1000, 80);
const thumbSpring = spring(2000, 80);
const refractionSpring = spring(100, 10);
const clock = {
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
};

export function createSettingsSwitchMotion(checked, paint, frames = clock, materialStops = stops) {
  let target = Number(!!checked), position = atRest(target);
  const scale = atRest(materialStops.rest.scale), stretch = atRest(0), fill = atRest(materialStops.rest.fill), refraction = atRest(materialStops.rest.refraction);
  let pressed = false, dragging = false, previous = 0, started = 0, sampledAt = 0, frame = null;

  const draw = moving => paint({ position: position.value, scaleX: scale.value * (1 + stretch.value), scaleY: scale.value * (1 - stretch.value),
    fill: unit(fill.value), refraction: unit(refraction.value), moving });
  function stop() {
    if (frame !== null) frames.cancel(frame);
    frame = null;
  }
  function updateAxis(axis, goal, seconds, step) {
    step(axis, goal, seconds);
    if (Math.abs(axis.value - goal) > .0008 || Math.abs(axis.velocity) > .012) return false;
    axis.value = goal;
    axis.velocity = 0;
    return true;
  }
  function tick(time) {
    frame = null;
    const seconds = clamp((time - previous) / 1000, 0, .064);
    previous = time;
    const material = pressed ? materialStops.press : materialStops.rest;
    const positionDone = pressed || updateAxis(position, target, seconds, positionSpring);
    const scaleDone = updateAxis(scale, material.scale, seconds, thumbSpring);
    const stretchGoal = dragging && time - sampledAt < 80 ? Math.min(.3, Math.abs(position.velocity) * switchTravel / 5000) : 0;
    const stretchDone = updateAxis(stretch, stretchGoal, seconds, thumbSpring);
    const fillDone = updateAxis(fill, material.fill, seconds, thumbSpring);
    const opticsDone = updateAxis(refraction, material.refraction, seconds, refractionSpring);
    const bounded = time - started > 1200;
    const moving = !bounded && (stretchGoal > 0 || !(positionDone && scaleDone && stretchDone && fillDone && opticsDone));
    if (bounded) {
      if (!pressed) position = atRest(target);
      Object.assign(scale, atRest(material.scale));
      Object.assign(stretch, atRest(0));
      Object.assign(fill, atRest(material.fill));
      Object.assign(refraction, atRest(material.refraction));
    }
    draw(moving);
    if (moving) frame = frames.request(tick);
  }
  function start() {
    started = frames.now();
    if (frame !== null) return;
    previous = started;
    frame = frames.request(tick);
  }
  function snap(keepPosition = false) {
    stop();
    if (!keepPosition) position = atRest(target);
    Object.assign(scale, atRest(materialStops.rest.scale));
    Object.assign(stretch, atRest(0));
    Object.assign(fill, atRest(materialStops.rest.fill));
    Object.assign(refraction, atRest(materialStops.rest.refraction));
    draw(false);
  }
  function release(next, { cancel = false, reduced = false } = {}) {
    target = Number(!!next);
    if (cancel || !dragging || frames.now() - sampledAt > 100) position.velocity = 0;
    pressed = dragging = false;
    if (reduced) snap();
    else start();
  }

  draw(false);
  return {
    press({ reduced = false } = {}) {
      pressed = true;
      dragging = false;
      position.velocity = 0;
      sampledAt = frames.now();
      if (reduced) snap(true);
      else start();
      return position.value;
    },
    drag(value, { reduced = false } = {}) {
      const bounded = unit(value);
      if (!pressed || !Number.isFinite(value)) return unit(position.value);
      const moved = bounded + clamp((value - bounded) / 22, -.22, .22);
      const sampled = frames.now(), elapsed = sampled - sampledAt;
      dragging = true;
      if (moved !== position.value) {
        const limit = 500 / switchTravel;
        position = { value: moved, velocity: elapsed > 0 && elapsed <= 100
          ? clamp((moved - position.value) / Math.max(.008, elapsed / 1000), -limit, limit) : 0 };
        sampledAt = sampled;
        if (reduced) snap(true);
        else {
          start();
          draw(true);
        }
      }
      return bounded;
    },
    release,
    sync(next, { reduced = false } = {}) {
      const goal = Number(!!next);
      if (goal !== target && pressed) {
        release(next, { cancel: true, reduced });
        return;
      }
      const redirected = goal !== target;
      target = goal;
      if (reduced) snap(pressed);
      else if (redirected) start();
    },
    dispose: stop,
  };
}

const rangeStops = { rest: { ...stops.rest, scale: .6 }, press: { ...stops.press, scale: 1 } };
export const createSettingsRangeMotion = paint => createSettingsSwitchMotion(false, paint, clock, rangeStops);
