/**
 * Freehand sculpting: a height-delta field over the board.
 *
 * The runtime's manual source carries `sculpt`, and its manual field adds that grid to whatever the
 * shapes and the base produce. The document is deliberately small — one float per cell, base64 — so a
 * sculpted world saves with the project instead of as an image:
 *
 *     { version: 1, resolution: 256, data: '<base64 of resolution² Float32>' }
 *
 * The grid covers the same square the board does, so a cell is `span / resolution` world units
 * across and the values are world-unit heights, exactly like a shape's `height`.
 */

export const SCULPT_TOOLS = [
  ['raise', 'Raise'],
  ['lower', 'Lower'],
  ['smooth', 'Smooth'],
];

/** Cell counts the field offers. 256 is a 1-unit cell on a 256-unit board and 8 on a 2048 one. */
export const SCULPT_RESOLUTIONS = [128, 256, 512];

const BASE64_CHUNK = 8192;

function bytesToBase64(bytes) {
  let text = '';
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK)
    text += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
  return btoa(text);
}

function base64ToBytes(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

const smoothstep = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/**
 * A sculpt field.
 *
 * `origin` and `span` are the board's square in world units — the same rectangle the shapes use —
 * so a stroke at a world position lands on the cell the pointer is over. Everything is in world
 * units: `radius` is a distance, `strength` a height in units per stamp.
 */
export function createSculptField({ resolution = 256 } = {}) {
  let size = SCULPT_RESOLUTIONS.includes(resolution) ? resolution : 256;
  let delta = new Float32Array(size * size);

  function ensure(nextSize) {
    if (nextSize === size) return;
    const copy = new Float32Array(nextSize * nextSize);
    // A resolution change keeps the sculpt where it was, resampled nearest-neighbour: losing a
    // stroke because the grid got coarser is not a thing an author expects from a control.
    for (let y = 0; y < nextSize; y++) for (let x = 0; x < nextSize; x++) {
      const sx = Math.min(size - 1, Math.floor(x / nextSize * size));
      const sy = Math.min(size - 1, Math.floor(y / nextSize * size));
      copy[y * nextSize + x] = delta[sy * size + sx];
    }
    size = nextSize;
    delta = copy;
  }

  const index = (x, y) => y * size + x;

  /**
   * One dab of the brush.
   *
   * Returns how many cells changed, which is what lets the caller skip a rebuild when a stroke
   * lands entirely outside the board.
   */
  function stamp({ x, z, radius, strength = 1, tool = 'raise', origin = { x: 0, z: 0 }, span = { x: 1, z: 1 } }) {
    if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const cx = (x - origin.x) / span.x * size, cy = (z - origin.z) / span.z * size;
    const rx = radius / span.x * size, ry = radius / span.z * size;
    const minX = Math.max(0, Math.floor(cx - rx)), maxX = Math.min(size - 1, Math.ceil(cx + rx));
    const minY = Math.max(0, Math.floor(cy - ry)), maxY = Math.min(size - 1, Math.ceil(cy + ry));
    if (minX > maxX || minY > maxY) return 0;
    const sign = tool === 'lower' ? -1 : 1;
    let changed = 0;
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const distance = Math.hypot((px - cx) / rx, (py - cy) / ry);
      if (distance > 1) continue;
      const weight = smoothstep(1 - distance);
      const at = index(px, py);
      let next;
      if (tool === 'smooth') {
        // The average of the four neighbours plus the cell: pulls a ridge down without moving the
        // landmass underneath it, which is what "smooth" means to a hand on a brush.
        let sum = delta[at], count = 1;
        if (px > 0) { sum += delta[index(px - 1, py)]; count++; }
        if (px < size - 1) { sum += delta[index(px + 1, py)]; count++; }
        if (py > 0) { sum += delta[index(px, py - 1)]; count++; }
        if (py < size - 1) { sum += delta[index(px, py + 1)]; count++; }
        next = delta[at] + (sum / count - delta[at]) * weight;
      } else next = delta[at] + sign * strength * weight;
      if (next !== delta[at]) { delta[at] = next; changed++; }
    }
    return changed;
  }

  function isEmpty() {
    for (let at = 0; at < delta.length; at++) if (Math.abs(delta[at]) > 1e-4) return false;
    return true;
  }

  /** The document the project stores, or null when nothing was sculpted. */
  function document() {
    if (isEmpty()) return null;
    return { version: 1, resolution: size, data: bytesToBase64(new Uint8Array(delta.buffer.slice(0))) };
  }

  /** Loads a stored document. A different resolution is resampled into the current grid. */
  function load(stored) {
    if (!stored || stored.version !== 1 || typeof stored.data !== 'string') { clear(); return; }
    const bytes = base64ToBytes(stored.data);
    if (bytes.length % 4) { clear(); return; }
    const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const storedSize = Math.max(1, Math.round(Number(stored.resolution) || 0));
    if (values.length !== storedSize * storedSize) { clear(); return; }
    if (storedSize === size) { delta.set(values); return; }
    ensure(SCULPT_RESOLUTIONS.includes(storedSize) ? storedSize : size);
    if (storedSize === size) { delta.set(values); return; }
    // A size the field does not offer still has to land somewhere: sample it into the current grid.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const sx = Math.min(storedSize - 1, Math.floor(x / size * storedSize));
      const sy = Math.min(storedSize - 1, Math.floor(y / size * storedSize));
      delta[index(x, y)] = values[sy * storedSize + sx];
    }
  }

  function clear() { delta = new Float32Array(size * size); }

  /** How much of the board a cell is worth, for reporting in the panel. */
  const cellSize = span => span.x / size;

  return {
    stamp, document, load, clear, isEmpty, cellSize,
    resolution: () => size,
    setResolution(next) { if (SCULPT_RESOLUTIONS.includes(next)) ensure(next); return size; },
    /** Min/max of what has been sculpted, so the panel can say something true about it. */
    extent() {
      // Seeded at the extremes, not at zero: an all-positive sculpt has a positive minimum, and
      // seeding at zero reported a stroke that lifted the land as reaching no lower than nothing.
      let low = Infinity, high = -Infinity, touched = 0;
      for (let at = 0; at < delta.length; at++) {
        const value = delta[at];
        if (Math.abs(value) <= 1e-4) continue;
        touched++;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (!touched) return { low: 0, high: 0, touched: 0, cells: delta.length };
      return { low, high, touched, cells: delta.length };
    },
  };
}
