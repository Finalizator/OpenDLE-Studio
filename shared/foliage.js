/**
 * Painted foliage: the grass, bushes and rocks scattered over a terrain.
 *
 * Foliage is not entities. A field of ten thousand tufts is not ten thousand things the runtime
 * ticks, saves and collides with — it is decoration that has to be *drawn* cheaply and culled
 * hard. So an instance is seven numbers in a flat array, a layer is a list of them, and the
 * drawing side turns each layer into one instanced mesh per chunk:
 *
 *     foliage = {
 *       version: 1,
 *       chunkSize: 128,                       // world units per chunk, the Godot-style knob
 *       layers: [{
 *         id, name, kind: 'sprite' | 'model', assetId,
 *         density,                            // 0..1, how tightly candidates are spaced
 *         scale: { min, max },                // randomise
 *         yaw, randomYaw,                     // rotate
 *         tilt,                               // degrees of random lean ("uneven")
 *         uneven,                             // 0..1, clumping noise in the brush
 *         height,                             // what a tuft may reach, for the cull sphere
 *         visible,
 *         instances: [[x, y, z, yaw, scale, tiltX, tiltZ], ...]
 *       }]
 *     }
 *
 * An instance is `[x, height, z]` in the coordinates of the terrain board it was painted on — the
 * same space the exported model's own vertices are in — so `origin.entityId` is what places the
 * field in the level: the object the terrain became.
 *
 * Everything here is deterministic: the same stroke with the same seed produces the same tufts, so
 * a project reopens to the field its author painted and a chunk can be rebuilt without drift.
 */

export const FOLIAGE_VERSION = 1;
/** `[x, y, z, yawDegrees, scale, tiltXDegrees, tiltZDegrees]` — one instance, seven numbers. */
export const INSTANCE_STRIDE = 7;

export const FOLIAGE_KINDS = [['sprite', '2D sprite'], ['model', '3D model']];

export const FOLIAGE_LIMITS = {
  chunkSize: { min: 16, max: 4096 },
  layers: 32,
  instancesPerLayer: 20000,
  density: { min: .02, max: 1 },
  scale: { min: .05, max: 8 },
  tilt: { min: 0, max: 60 },
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function defaultFoliage() {
  return { version: FOLIAGE_VERSION, chunkSize: 128, layers: [], origin: { entityId: null } };
}

/** The project's foliage, normalised: a project that never painted any has an empty set. */
export function foliageOf(project) {
  const stored = project?.terrain?.foliage;
  const base = defaultFoliage();
  if (!stored || !Array.isArray(stored.layers)) return base;
  return {
    version: FOLIAGE_VERSION,
    chunkSize: clamp(Math.round(finite(stored.chunkSize, base.chunkSize)),
      FOLIAGE_LIMITS.chunkSize.min, FOLIAGE_LIMITS.chunkSize.max),
    layers: stored.layers.map(layer => normaliseLayer(layer)).filter(Boolean),
    // Which object the field was painted onto. Instances are stored in the terrain board's own
    // coordinates, so the object that carries them is what puts them in the level — move the
    // terrain and its grass moves with it.
    origin: { entityId: stored.origin?.entityId ? String(stored.origin.entityId) : null },
  };
}

function normaliseLayer(layer) {
  if (!layer || typeof layer !== 'object') return null;
  const kind = layer.kind === 'model' ? 'model' : 'sprite';
  const scale = layer.scale || {};
  return {
    id: String(layer.id || ''),
    name: String(layer.name || kind).slice(0, 100),
    kind,
    assetId: layer.assetId ? String(layer.assetId) : null,
    density: clamp(finite(layer.density, .5), FOLIAGE_LIMITS.density.min, FOLIAGE_LIMITS.density.max),
    scale: {
      min: clamp(finite(scale.min, 1), FOLIAGE_LIMITS.scale.min, FOLIAGE_LIMITS.scale.max),
      max: clamp(finite(scale.max, 1), FOLIAGE_LIMITS.scale.min, FOLIAGE_LIMITS.scale.max),
    },
    yaw: finite(layer.yaw, 0),
    randomYaw: layer.randomYaw !== false,
    tilt: clamp(finite(layer.tilt, 6), FOLIAGE_LIMITS.tilt.min, FOLIAGE_LIMITS.tilt.max),
    uneven: clamp(finite(layer.uneven, .35), 0, 1),
    height: clamp(finite(layer.height, 64), 1, 4096),
    visible: layer.visible !== false,
    instances: readInstances(layer.instances),
  };
}

function readInstances(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const numbers = [];
    for (let index = 0; index < INSTANCE_STRIDE; index++) {
      numbers.push(finite(entry[index], index === 4 ? 1 : 0));
    }
    if (!Number.isFinite(numbers[0]) || !Number.isFinite(numbers[2])) continue;
    out.push(numbers);
    if (out.length >= FOLIAGE_LIMITS.instancesPerLayer) break;
  }
  return out;
}

let layerSequence = 0;

export function createFoliageLayer(partial = {}) {
  return normaliseLayer({
    id: partial.id || `foliage_${++layerSequence}_${Date.now().toString(36)}`,
    name: partial.name || (partial.kind === 'model' ? 'Model foliage' : 'Grass'),
    kind: partial.kind, assetId: partial.assetId,
    density: partial.density, scale: partial.scale, yaw: partial.yaw,
    randomYaw: partial.randomYaw, tilt: partial.tilt, uneven: partial.uneven,
    height: partial.height, visible: partial.visible, instances: partial.instances,
  });
}

export function addFoliageLayer(foliage, partial = {}) {
  const next = foliageOf({ terrain: { foliage } });
  if (next.layers.length >= FOLIAGE_LIMITS.layers) {
    throw new Error(`${FOLIAGE_LIMITS.layers} foliage layers maximum. Remove one before adding another.`);
  }
  const layer = createFoliageLayer(partial);
  next.layers.push(layer);
  return { foliage: next, layer };
}

export function removeFoliageLayer(foliage, id) {
  const next = foliageOf({ terrain: { foliage } });
  next.layers = next.layers.filter(layer => layer.id !== id);
  return next;
}

export function updateFoliageLayer(foliage, id, patch = {}) {
  const next = foliageOf({ terrain: { foliage } });
  next.layers = next.layers.map(layer => layer.id === id
    ? normaliseLayer({ ...layer, ...patch, scale: { ...layer.scale, ...(patch.scale || {}) },
      instances: patch.instances ?? layer.instances })
    : layer);
  return next;
}

export function clearFoliageLayer(foliage, id) {
  return updateFoliageLayer(foliage, id, { instances: [] });
}

export function foliageInstanceCount(foliage) {
  return (foliage?.layers || []).reduce((total, layer) => total + layer.instances.length, 0);
}

/**
 * A chunker setting that changes the drawing, so a rebuild is only paid when it must be.
 *
 * The signature covers what the meshes are made of — assets, chunk size, visibility — and not the
 * instances themselves: a stroke changes one chunk, not the whole field.
 */
export function foliageSignature(foliage) {
  const layers = (foliage?.layers || []).map(layer =>
    `${layer.id}:${layer.kind}:${layer.assetId || ''}:${layer.visible ? 1 : 0}:${layer.instances.length}`);
  return `${foliage?.chunkSize || 0}|${layers.join('|')}`;
}

// ---------------------------------------------------------------- deterministic randomness

/** A 32-bit hash of a grid coordinate, `[0, 1)`. The same cell always answers the same way. */
export function hash01(seed, x, y) {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothed value noise from `hash01`, sampled on a `cell`-sized grid and interpolated. */
export function valueNoise(seed, x, y, cell) {
  const size = Math.max(1, cell);
  const gx = Math.floor(x / size), gy = Math.floor(y / size);
  const fx = x / size - gx, fy = y / size - gy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash01(seed, gx, gy), b = hash01(seed, gx + 1, gy);
  const c = hash01(seed, gx, gy + 1), d = hash01(seed, gx + 1, gy + 1);
  const top = a + (b - a) * sx, bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/** The distance between candidate tufts a density asks for: dense is close, sparse is wide. */
export function spacingForDensity(density) {
  const value = clamp(finite(density, .5), FOLIAGE_LIMITS.density.min, FOLIAGE_LIMITS.density.max);
  // 1 → 10 units apart, .02 → 96 units apart, geometric so the knob feels even.
  return 96 * Math.pow(10 / 96, value);
}

// ---------------------------------------------------------------- painting

/**
 * A brush over one layer.
 *
 * Held for the length of a stroke so the occupied-cell index is built once rather than per sample:
 * a drag arrives a dozen times a second and a field can hold twenty thousand tufts.
 */
export function createFoliageScatter(layer) {
  const spacing = spacingForDensity(layer.density);
  const occupied = new Set();
  const cellOf = (x, z) => `${Math.floor(x / spacing)},${Math.floor(z / spacing)}`;
  for (const instance of layer.instances) occupied.add(cellOf(instance[0], instance[2]));
  let added = 0;

  return {
    spacing,
    added: () => added,
    /**
     * One brush sample.
     *
     * `ground(x, z)` answers the surface height at a candidate, so a tuft stands on the slope it
     * was painted onto instead of at the height of the brush centre. `salt` changes per stroke, so
     * a second pass over the same ground can fill the gaps the first left.
     */
    sample({ x, z, y = 0, radius, strength = 1, uneven = layer.uneven, salt = 1, ground = null }) {
      const reach = Math.max(spacing, finite(radius, 120));
      const cells = Math.ceil(reach / spacing);
      const centreX = Math.floor(x / spacing), centreZ = Math.floor(z / spacing);
      const started = added;
      // The seed is the stroke's own, not the field's size: the same stroke over the same ground
      // must land on the same cells (and add nothing), while a new stroke rolls different ones.
      const strokeSeed = ((finite(salt, 1) * 2654435761) >>> 0);
      for (let gz = centreZ - cells; gz <= centreZ + cells; gz++) {
        for (let gx = centreX - cells; gx <= centreX + cells; gx++) {
          if (layer.instances.length + added >= FOLIAGE_LIMITS.instancesPerLayer) return added - started;
          const key = `${gx},${gz}`;
          if (occupied.has(key)) continue;
          // The candidate sits somewhere inside its own cell, so a field never looks like a grid.
          const jitterX = hash01(strokeSeed ^ 0x9e3779b9, gx, gz);
          const jitterZ = hash01(strokeSeed ^ 0x85ebca6b, gx, gz);
          const px = (gx + .15 + jitterX * .7) * spacing;
          const pz = (gz + .15 + jitterZ * .7) * spacing;
          const distance = Math.hypot(px - x, pz - z);
          if (distance > reach) continue;
          // A round brush that fades at the rim rather than a hard-edged coin.
          const falloff = 1 - (distance / reach) ** 2;
          const noise = 1 - finite(uneven, 0) + finite(uneven, 0) * valueNoise(layer.id.length * 7919, px, pz, spacing * 6);
          const chance = clamp(finite(strength, 1), 0, 1) * falloff * noise;
          if (hash01(strokeSeed ^ 0xc2b2ae35, gx, gz) >= chance) continue;
          const lowScale = Math.min(layer.scale.min, layer.scale.max);
          const highScale = Math.max(layer.scale.min, layer.scale.max);
          const tilt = finite(layer.tilt, 0);
          layer.instances.push([
            px,
            typeof ground === 'function' ? finite(ground(px, pz), y) : y,
            pz,
            finite(layer.yaw, 0) + (layer.randomYaw ? hash01(strokeSeed ^ 0x27d4eb2f, gx, gz) * 360 : 0),
            lowScale + (highScale - lowScale) * hash01(strokeSeed ^ 0x165667b1, gx, gz),
            (hash01(strokeSeed ^ 0x9e3779b1, gx, gz) - .5) * 2 * tilt,
            (hash01(strokeSeed ^ 0x85ebca77, gx, gz) - .5) * 2 * tilt,
          ]);
          occupied.add(key);
          added++;
        }
      }
      return added - started;
    },
  };
}

/**
 * Where one instance stands in the level, from the board it was painted on.
 *
 * Both renderers — the tab's preview and the game's — place tufts through this, so a field looks
 * the same in the editor as it does in play and there is one place to be wrong. The rotation is
 * `YXZ`: yaw first, then the two lean angles, which is what makes a tilted tuft lean in the
 * direction it was randomised into rather than spinning about the world's up axis.
 *
 * `origin` is the object the terrain was exported as (`{ x, z, height, yaw }`, yaw in degrees).
 */
export function instanceTransform(instance, origin = null) {
  const [x, y, z, yaw, scale, tiltX, tiltZ] = instance;
  const base = origin || { x: 0, z: 0, height: 0, yaw: 0 };
  const turn = (Number(base.yaw) || 0) * Math.PI / 180;
  const cos = Math.cos(turn), sin = Math.sin(turn);
  // A board turned with its object turns its tufts the same way about the object's own origin.
  const localX = x, localZ = z;
  const position = {
    x: (Number(base.x) || 0) + localX * cos - localZ * sin,
    y: (Number(base.height) || 0) + (Number(y) || 0),
    z: (Number(base.z) || 0) + localX * sin + localZ * cos,
  };
  return {
    position,
    scale: Math.abs(scale) || 1,
    yaw: (Number(base.yaw) || 0) + (Number(yaw) || 0),
    tiltX: Number(tiltX) || 0,
    tiltZ: Number(tiltZ) || 0,
  };
}

/**
 * The quaternion a `YXZ` Euler of the transform's angles makes, as `[x, y, z, w]`.
 *
 * Written as the product `Y · X · Z` with each factor a unit quaternion, so the order is the one
 * three.js's `'YXZ'` Euler uses instead of a hand-expanded formula that is easy to get wrong.
 */
export function transformQuaternion({ yaw = 0, tiltX = 0, tiltZ = 0 } = {}) {
  const half = value => (Number(value) || 0) * Math.PI / 360;
  const axisY = [0, Math.sin(half(yaw)), 0, Math.cos(half(yaw))];
  const axisX = [Math.sin(half(tiltX)), 0, 0, Math.cos(half(tiltX))];
  const axisZ = [0, 0, Math.sin(half(tiltZ)), Math.cos(half(tiltZ))];
  const multiply = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  return multiply(multiply(axisY, axisX), axisZ);
}

// ---------------------------------------------------------------- chunking and culling

/**
 * The instanced meshes a field is drawn as, one per chunk per layer.
 *
 * This is the Godot "multimesh" shape: a layer of a hundred thousand tufts becomes a few hundred
 * draws, each with the bounding sphere a frustum test needs.
 */
export function chunkFoliage(foliage, { extent = null } = {}) {
  const chunks = [];
  if (!foliage) return chunks;
  // The drawn size of a tuft is the artwork's, not the layer's `height`: a 128-pixel sprite on a
  // 64-unit layer is drawn twice the height the bounds assumed, and a tilted tuft leans its top
  // corner out by most of its height again. The caller knows the asset table, so it answers
  // `extent(layer) -> { width, height }`; without it a square of `layer.height` is assumed.
  const drawnSize = layer => {
    const asked = typeof extent === 'function' ? extent(layer) : null;
    const width = finite(asked?.width, finite(layer.height, 64));
    const height = finite(asked?.height, finite(layer.height, 64));
    return { halfWidth: Math.max(1, width) / 2, height: Math.max(1, height) };
  };
  const defaultSize = clamp(Math.round(finite(foliage.chunkSize, 128)),
    FOLIAGE_LIMITS.chunkSize.min, FOLIAGE_LIMITS.chunkSize.max);
  for (const layer of foliage.layers || []) {
    if (!layer.visible || !layer.instances.length) continue;
    const size = clamp(Math.round(finite(layer.chunkSize, defaultSize)),
      FOLIAGE_LIMITS.chunkSize.min, FOLIAGE_LIMITS.chunkSize.max);
    const groups = new Map();
    for (const instance of layer.instances) {
      const cx = Math.floor(instance[0] / size), cz = Math.floor(instance[2] / size);
      const key = `${cx},${cz}`;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { cx, cz, instances: [] });
      group.instances.push(instance);
    }
    for (const group of groups.values()) {
      // The instance height is scaled by the tuft's own scale, so the sphere covers the tallest
      // one in the chunk and a chunk is not culled while its tips are still on screen.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (const instance of group.instances) {
        const scale = Math.abs(instance[4]) || 1;
        const size = drawnSize(layer);
        // How far the tuft can reach sideways: half its width, plus the lean of its top edge at the
        // tilt it was placed with (the two tilt components add in the worst case).
        const tilt = (Math.abs(finite(instance[5], 0)) + Math.abs(finite(instance[6], 0))) * Math.PI / 180;
        const lean = Math.sin(Math.min(tilt, Math.PI / 2)) * size.height * scale;
        const reach = Math.hypot(size.halfWidth * scale, lean) + size.halfWidth * scale * 0.5;
        minX = Math.min(minX, instance[0] - reach); maxX = Math.max(maxX, instance[0] + reach);
        minZ = Math.min(minZ, instance[2] - reach); maxZ = Math.max(maxZ, instance[2] + reach);
        const rise = Math.cos(tilt) * size.height * scale + size.halfWidth * scale;
        minY = Math.min(minY, instance[1]);
        maxY = Math.max(maxY, instance[1] + rise);
      }
      const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
      const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
      chunks.push({
        layerId: layer.id, kind: layer.kind, assetId: layer.assetId, size,
        key: `${layer.id}/${group.cx},${group.cz}`, cx: group.cx, cz: group.cz,
        instances: group.instances,
        bounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
        centre, radius: Math.max(radius, 1),
      });
    }
  }
  return chunks;
}

/**
 * Whether a chunk should be drawn.
 *
 * `maxDistance` is the far cut: a tuft a hundred metres away is a pixel and not worth a draw. The
 * frustum test is the renderer's own (a chunk is given its bounding sphere), so this covers the
 * part a renderer cannot do for itself — the distance budget and a cheap early exit by circle.
 */
export function chunkVisible(chunk, { x = 0, z = 0, maxDistance = Infinity, minDistance = 0 } = {}) {
  if (!chunk) return false;
  const distance = Math.hypot(chunk.centre.x - x, chunk.centre.z - z) - chunk.radius;
  if (distance > maxDistance) return false;
  if (distance + chunk.radius * 2 < minDistance) return false;
  return true;
}

/** The chunks a field would draw from a point, and how many instances that is. */
export function visibleChunks(chunks, options = {}) {
  const visible = chunks.filter(chunk => chunkVisible(chunk, options));
  return { chunks: visible, instances: visible.reduce((total, chunk) => total + chunk.instances.length, 0) };
}

/** Field-level defaults for a layer an author has not filled in. */
export function foliageLayerDefaults(kind = 'sprite') {
  return kind === 'model'
    ? { kind: 'model', density: .5, scale: { min: .8, max: 1.4 }, tilt: 4, uneven: .35, height: 96 }
    : { kind: 'sprite', density: .6, scale: { min: .7, max: 1.3 }, tilt: 8, uneven: .45, height: 64 };
}

/** Throws with a readable reason when a stored field could not be drawn. */
export function validateFoliage(foliage) {
  if (!foliage || typeof foliage !== 'object') throw new Error('Foliage must be an object');
  if (foliage.version !== FOLIAGE_VERSION) throw new Error('Unsupported foliage version ' + foliage.version);
  const size = foliage.chunkSize;
  if (!Number.isFinite(size) || size < FOLIAGE_LIMITS.chunkSize.min || size > FOLIAGE_LIMITS.chunkSize.max) {
    throw new Error('Foliage chunk size must be ' + FOLIAGE_LIMITS.chunkSize.min + '-' + FOLIAGE_LIMITS.chunkSize.max);
  }
  if (!Array.isArray(foliage.layers)) throw new Error('Foliage layers must be a list');
  const ids = new Set();
  for (const layer of foliage.layers) {
    if (!layer.id || ids.has(layer.id)) throw new Error('Foliage layer id ' + layer.id + ' is missing or repeated');
    ids.add(layer.id);
    if (layer.kind !== 'sprite' && layer.kind !== 'model') throw new Error('Foliage layer ' + layer.id + ' has no kind');
    if (layer.assetId !== null && typeof layer.assetId !== 'string') throw new Error('Foliage layer ' + layer.id + ' has a bad asset');
    if (!Array.isArray(layer.instances)) throw new Error('Foliage layer ' + layer.id + ' has no instances');
    if (layer.instances.length > FOLIAGE_LIMITS.instancesPerLayer)
      throw new Error('Foliage layer ' + layer.id + ' holds more than ' + FOLIAGE_LIMITS.instancesPerLayer + ' instances');
    for (const instance of layer.instances) {
      if (!Array.isArray(instance) || instance.length !== INSTANCE_STRIDE)
        throw new Error('Foliage layer ' + layer.id + ' has an instance that is not ' + INSTANCE_STRIDE + ' numbers');
      for (const value of instance) if (!Number.isFinite(value)) throw new Error('Foliage layer ' + layer.id + ' has a non-finite instance');
    }
  }
  return true;
}
