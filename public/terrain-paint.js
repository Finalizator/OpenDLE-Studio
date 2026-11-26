/**
 * Surface painting: the material layers painted onto a terrain.
 *
 * The runtime reads `surfacePaint` from the manual source and draws it as a per-cell weight per
 * layer. Its own field is a 1024 × 1024 grid split into 4 × 4 tiles of 256 × 256, with four layers'
 * weights packed into one tile's fourth channel (`slot >> 2` groups the layers eight to a tile set).
 * A document is:
 *
 *     {
 *       version: 2,
 *       origin: { x, z }, span: { x, z }, resolution: 1024,
 *       layers: [{ id, materialInstanceId, name, slot, visible, locked, opacity }],
 *       tiles: [{ key: 'tx,ty,group', data: '<base64 of zlib(tile bytes)>' }]
 *     }
 *
 * That format is reproduced here rather than guessed: a tile's key must match `^[0-3],[0-3],[0-7]$`
 * and its inflated size must be exactly 256 · 256 · 4, or the runtime refuses the whole document.
 * Only touched tiles are stored, so painting a corner of a board stays small.
 */
import { zlibSync, unzlibSync } from 'fflate';

export const PAINT_TILE = 256;
export const PAINT_GRID = 4;
export const PAINT_RESOLUTION = PAINT_TILE * PAINT_GRID;
export const PAINT_TOOLS = [['paint', 'Paint'], ['erase', 'Erase'], ['blend', 'Blend'], ['eraseAll', 'Erase all']];

/** The materials a paint layer may name, in the runtime's own ids. */
export const PAINT_MATERIALS = [
  ['grass', 'Grass'], ['rock', 'Rock'], ['sand', 'Sand'], ['mud', 'Mud'], ['alien', 'Alien'],
];

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
const clamp01 = value => Math.max(0, Math.min(1, value));
const smoothstep = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** A paint document over a board's rectangle. */
export function createPaintField({ origin = { x: 0, z: 0 }, span = { x: 1, z: 1 } } = {}) {
  let layers = [];
  const tiles = new Map();
  let nextId = 1;

  const key = (x, y, group) => `${Math.floor(x / PAINT_TILE)},${Math.floor(y / PAINT_TILE)},${group}`;
  const offset = (x, y, slot) => ((y % PAINT_TILE) * PAINT_TILE + (x % PAINT_TILE)) * 4 + (slot % 4);

  function read(x, y, slot) {
    if (x < 0 || y < 0 || x >= PAINT_RESOLUTION || y >= PAINT_RESOLUTION) return 0;
    return (tiles.get(key(x, y, slot >> 2))?.[offset(x, y, slot)] || 0) / 255;
  }

  function write(x, y, slot, value) {
    const tileKey = key(x, y, slot >> 2);
    let tile = tiles.get(tileKey);
    if (!tile) { tile = new Uint8Array(PAINT_TILE * PAINT_TILE * 4); tiles.set(tileKey, tile); }
    const at = offset(x, y, slot), encoded = Math.round(clamp01(value) * 255);
    if (tile[at] !== encoded) tile[at] = encoded;
  }

  function addLayer(materialInstanceId = 'grass', name = null) {
    if (layers.length >= 32) throw new Error('32 paint layers maximum. Remove a layer before adding another.');
    const used = new Set(layers.map(layer => layer.slot));
    const slot = Array.from({ length: 32 }, (_, index) => index).find(index => !used.has(index));
    const layer = {
      id: `paint_${nextId++}`, materialInstanceId, name: name || materialInstanceId,
      slot, visible: true, locked: false, opacity: 1,
    };
    layers.push(layer);
    return layer;
  }

  function updateLayer(id, patch) {
    layers = layers.map(layer => layer.id === id
      ? { ...layer, ...patch, id: layer.id, slot: layer.slot,
        opacity: patch.opacity === undefined ? layer.opacity : clamp01(Number(patch.opacity)) }
      : layer);
  }

  function removeLayer(id) {
    const layer = layers.find(item => item.id === id);
    if (!layer) return;
    layers = layers.filter(item => item.id !== id);
    // A removed layer's weights go with it: a slot that no layer owns would paint nothing but still
    // be stored, and the runtime refuses a document whose slots are not unique.
    for (const tile of tiles.values()) for (let at = layer.slot % 4; at < tile.length; at += 4) tile[at] = 0;
  }

  const layerById = id => layers.find(layer => layer.id === id) || null;

  /**
   * One dab of the brush, mirroring the runtime's own `stamp`.
   *
   * `radius` is world units, `span` the board, so the same brush narrows as the board widens. The
   * falloff is smoothstepped rather than linear: a linear edge reads as a hard disc on a shaded
   * surface, which is how painting on terrain looks wrong.
   */
  function stamp({ x, z, radius, strength = .45, falloff = .72, tool = 'paint', layerId }) {
    const layer = layerById(layerId);
    if (!layer || layer.locked || !layer.visible) return 0;
    if (!(radius > 0)) return 0;
    const cx = (x - origin.x) / span.x * PAINT_RESOLUTION;
    const cy = (z - origin.z) / span.z * PAINT_RESOLUTION;
    const rx = radius / span.x * PAINT_RESOLUTION, ry = radius / span.z * PAINT_RESOLUTION;
    const minX = Math.max(0, Math.floor(cx - rx)), maxX = Math.min(PAINT_RESOLUTION - 1, Math.ceil(cx + rx));
    const minY = Math.max(0, Math.floor(cy - ry)), maxY = Math.min(PAINT_RESOLUTION - 1, Math.ceil(cy + ry));
    if (minX > maxX || minY > maxY) return 0;

    const smooth = tool === 'blend' ? new Map() : null;
    if (smooth) for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += read(px + dx, py + dy, layer.slot);
      smooth.set(py * PAINT_RESOLUTION + px, sum / 9);
    }

    let changed = 0;
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const distance = Math.hypot((px - cx) / rx, (py - cy) / ry);
      if (distance > 1) continue;
      const alpha = smoothstep((1 - distance) / Math.max(.02, falloff)) * clamp01(strength);
      const current = read(px, py, layer.slot);
      if (tool === 'eraseAll') {
        for (const other of layers) if (!other.locked) write(px, py, other.slot, read(px, py, other.slot) * (1 - alpha));
      } else if (tool === 'erase') write(px, py, layer.slot, current * (1 - alpha));
      else if (tool === 'blend') write(px, py, layer.slot, current + (smooth.get(py * PAINT_RESOLUTION + px) - current) * alpha);
      else write(px, py, layer.slot, current + (1 - current) * alpha);
      changed++;
    }
    return changed;
  }

  function isEmpty() {
    for (const tile of tiles.values()) if (tile.some(value => value)) return false;
    return true;
  }

  /** The document the project stores, or null when nothing was painted. */
  function document() {
    if (!layers.length || isEmpty()) return null;
    const payload = [];
    for (const [tileKey, data] of tiles) {
      if (!data.some(value => value)) continue;
      payload.push({ key: tileKey, data: bytesToBase64(zlibSync(data)) });
    }
    if (!payload.length) return null;
    return {
      version: 2,
      origin: { ...origin }, span: { ...span }, resolution: PAINT_RESOLUTION,
      layers: layers.map(layer => ({ ...layer })),
      tiles: payload,
    };
  }

  /** Loads a stored document, replacing everything. A malformed one clears the field. */
  function load(stored) {
    layers = [];
    tiles.clear();
    if (!stored || stored.version !== 2 || !Array.isArray(stored.layers)) return;
    if (stored.layers.length > 32) return;
    const slots = new Set(stored.layers.map(layer => layer.slot));
    if (slots.size !== stored.layers.length) return;
    layers = stored.layers.map(layer => ({ ...layer }));
    if (stored.origin) origin = { ...stored.origin };
    if (stored.span) span = { ...stored.span };
    for (const entry of stored.tiles || []) {
      if (!/^[0-3],[0-3],[0-7]$/.test(entry.key) || typeof entry.data !== 'string') continue;
      try {
        const bytes = unzlibSync(base64ToBytes(entry.data));
        if (bytes.length === PAINT_TILE * PAINT_TILE * 4) tiles.set(entry.key, bytes);
      } catch { /* a tile that will not inflate is left out rather than failing the world */ }
    }
    let highest = 0;
    for (const layer of layers) highest = Math.max(highest, Number(layer.slot) + 1);
    nextId = Math.max(1, highest + 1);
  }

  function clear() {
    layers = [];
    tiles.clear();
  }

  return {
    addLayer, updateLayer, removeLayer, layerById, stamp, document, load, clear, isEmpty,
    layers: () => layers.map(layer => ({ ...layer })),
    /** How much of the board a layer covers, for the panel to report it truthfully. */
    coverage(layerId) {
      const layer = layerById(layerId);
      if (!layer) return 0;
      let painted = 0;
      for (const [tileKey, data] of tiles) {
        if (Number(tileKey.split(',')[2]) !== layer.slot >> 2) continue;
        for (let at = layer.slot % 4; at < data.length; at += 4) if (data[at] > 8) painted++;
      }
      return painted / (PAINT_RESOLUTION * PAINT_RESOLUTION);
    },
  };
}
