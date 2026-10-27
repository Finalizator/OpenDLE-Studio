// Rolling frame-time counters so preview stalls are visible without a profiler.
// Purely arithmetic: no DOM access and no allocation on push().
export function createFrameStats({ window = 120, stallMs = 50 } = {}) {
  const size = Math.max(1, Math.floor(window));
  const samples = new Float64Array(size);
  let count = 0, cursor = 0, max = 0, total = 0, stalls = 0;
  // Session totals: the rolling window forgets, but a playtest report needs to know
  // that two frames stalled five minutes apart.
  let sessionStalls = 0, worst = 0, sessionFrames = 0;
  function recomputeMax() {
    max = 0;
    for (let index = 0; index < count; index++) if (samples[index] > max) max = samples[index];
  }
  function push(ms) {
    const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
    let droppedMax = false;
    if (count === size) {
      const dropped = samples[cursor];
      total -= dropped;
      if (dropped > stallMs) stalls--;
      if (dropped >= max) droppedMax = true;
    } else count++;
    samples[cursor] = value;
    cursor = (cursor + 1) % size;
    total += value;
    if (value > stallMs) { stalls++; sessionStalls++; }
    if (value > worst) worst = value;
    sessionFrames++;
    if (droppedMax) recomputeMax();
    if (value > max) max = value;
    return value;
  }
  function reset() {
    samples.fill(0); count = 0; cursor = 0; max = 0; total = 0; stalls = 0;
    sessionStalls = 0; worst = 0; sessionFrames = 0;
  }
  function summary() {
    return {
      frames: count, window: size,
      last: count ? samples[(cursor - 1 + size) % size] : 0,
      max, mean: count ? total / count : 0, stalls, stallMs,
      sessionFrames, sessionStalls, worst,
    };
  }
  return { push, reset, summary, get max() { return max; }, get stalls() { return stalls; }, get frames() { return count; } };
}

// Writes canvas.dataset only when the value changed, so per-frame bookkeeping does
// not dirty the DOM attributes of the preview canvas every single frame.
export function createDatasetWriter(canvas) {
  const previous = new Map();
  return function write(key, value) {
    const text = String(value);
    if (previous.get(key) === text) return false;
    previous.set(key, text);
    canvas.dataset[key] = text;
    return true;
  };
}

/**
 * Whole-frame timing for the preview loop.
 *
 * `createFrameStats` only sees the renderer's draw call, so a pause in the physics
 * step, an audio decode, a texture upload or a garbage collection between frames is
 * invisible. This keeps the worst frame together with what the frame was doing.
 */
export function createFrameBudget({ slowMs = 120 } = {}) {
  let frames = 0, worst = 0, slow = 0, slowest = null;
  function push(total, parts) {
    const ms = Number.isFinite(total) && total > 0 ? total : 0;
    frames++;
    if (ms > worst) worst = ms;
    if (ms < slowMs) return null;
    slow++;
    if (!slowest || ms > slowest.ms) {
      slowest = { ms: Math.round(ms), ...(parts || {}) };
      for (const key of Object.keys(slowest)) if (key !== 'ms') slowest[key] = Math.round(slowest[key]);
    }
    return slowest;
  }
  function reset() { frames = 0; worst = 0; slow = 0; slowest = null; }
  return {
    push, reset, slowMs,
    get frames() { return frames; },
    get slow() { return slow; },
    get worst() { return worst; },
    get slowest() { return slowest ? { ...slowest } : null; },
  };
}
