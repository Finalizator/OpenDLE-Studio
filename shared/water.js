/**
 * Water bodies: a brush that is a volume of water rather than something solid.
 *
 * A brush is the only volume a mapper can draw freely, so a water body is a brush with
 * `kind: 'water'` and a `water` record of how it behaves. It is deliberately *not* a solid:
 * nothing walks into it, no bullet stops in it and no monster loses sight through it — the
 * volume is only ever asked "how deep is the water here", which is a question the game asks
 * about a point.
 *
 * Everything here is pure: the same record decides the swimmer's speed, the crate's buoyancy
 * and the depth a camera reports, so the editor, the playtest and the exported game cannot
 * disagree about what is wet.
 */

import { brushBounds, brushContains, facesOf, isWaterBrush } from './brushes.js';

export { isWaterBrush };

/** What a water body is when the mapper has not touched a single setting. */
export const WATER_DEFAULTS = Object.freeze({
  // The colour the surface is tinted with, and the tint the water shader is started from.
  color: '#1f7391',
  // How much of the level shows through the surface. The shader adds its own fresnel on top.
  opacity: .82,
  // 1 is neutral: a swimmer holds its depth, a crate sinks to where it displaces its weight.
  // Below 1 the water is thin and things sink; above 1 it pushes them up.
  buoyancy: 1.2,
  // The fastest a swimmer drops when the water does not hold them, and the fastest they climb.
  sinkSpeed: 90,
  swimSpeed: 210,
  // How quickly vertical speed approaches the swimmer's target, per second. A high value is
  // crisp and a low one feels like syrup.
  drag: 3,
  // Share of the walking speed that survives in water, at the deepest.
  speedScale: .62,
  // A current the volume carries, in units per second along the map's own axes.
  current: Object.freeze({ x: 0, y: 0, z: 0 }),
});

/** Doom's `waterlevel`, which is the vocabulary the rest of the engine already speaks. */
export const WATER_LEVELS = Object.freeze(['dry', 'feet', 'waist', 'submerged']);

/** How far either side of the surface an object's centre is still partly in the water. */
const FLOAT_BAND = 16;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** A water body's settings with the defaults filled in, so a caller never reads undefined. */
export function waterSettings(brush) {
  const water = brush?.water || {};
  return {
    ...WATER_DEFAULTS,
    ...water,
    current: { ...WATER_DEFAULTS.current, ...(water.current || {}) },
  };
}

/**
 * Every water body as a testable volume.
 *
 * The planes are taken the same way `brushVolumes` takes a solid one, so the two agree about
 * what the brush's outline is; only the use is different. `surfaceZ` is the top of the volume,
 * which is the water line — a water box drawn from the lake bed to the water line is the whole
 * of the authoring, exactly as a mapper draws a pool in TrenchBroom.
 */
export function waterVolumes(brushes) {
  const volumes = [];
  for (const brush of brushes || []) {
    if (!isWaterBrush(brush) || brush.visible === false) continue;
    const faces = facesOf(brush);
    if (faces.length < 4) continue;
    const box = brushBounds(brush);
    const minX = box.x, maxX = box.x + box.width;
    const minY = box.y, maxY = box.y + box.depth;
    const minZ = box.z, maxZ = box.z + box.height;
    if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) continue;
    volumes.push({
      id: brush.id, brush,
      minX, maxX, minY, maxY, minZ, maxZ,
      // The water line is the brush's own top; a mapper who wants the surface lower draws the
      // brush to that height, which keeps one number rather than two that can disagree.
      surfaceZ: Number.isFinite(brush.water?.surfaceZ) ? brush.water.surfaceZ : maxZ,
      settings: waterSettings(brush),
    });
  }
  return volumes;
}

/**
 * Whether a point is inside a water volume.
 *
 * The box test is the cheap answer and is enough for whether the volume is worth asking about;
 * the planes are what decide it, so a wedge-shaped pond holds water where the wedge holds its
 * volume instead of in the whole of its bounding box.
 */
function inBox(volume, x, y, z, margin = 0) {
  return x >= volume.minX - margin && x <= volume.maxX + margin &&
    y >= volume.minY - margin && y <= volume.maxY + margin &&
    z >= volume.minZ - margin && z <= volume.maxZ + margin;
}

function inVolume(volume, x, y, z, margin = 0) {
  if (!inBox(volume, x, y, z, margin)) return false;
  return brushContains(volume.brush, [x, y, clamp(z, volume.minZ, volume.maxZ)], margin);
}

/**
 * The water at a point: the volume that reaches highest there, and how far the point is under
 * its surface. `null` when the point is dry.
 */
export function waterAt(volumes, point) {
  const [x, y, z] = point;
  let best = null;
  for (const volume of volumes || []) {
    if (z > volume.surfaceZ) continue;
    if (!inVolume(volume, x, y, z, 1e-3)) continue;
    if (best && best.surfaceZ >= volume.surfaceZ) continue;
    best = { id: volume.id, surfaceZ: volume.surfaceZ, depth: volume.surfaceZ - z, settings: volume.settings, volume };
  }
  return best;
}

/**
 * How wet a body standing at `feet` is, as Doom's waterlevel.
 *
 * The thresholds are the ones a player feels rather than the ones a plane test gives: water
 * over the ankles is `1`, water past the middle of the body is `2`, and a head under the
 * surface is `3`. Above the waist the buoyancy takes over, which is what makes a pool something
 * to swim in rather than a puddle to wade through.
 */
export function swimLevel(volumes, { x, y, feet, height = 56 }) {
  let best = null;
  for (const volume of volumes || []) {
    if (!(feet < volume.surfaceZ)) continue;
    // The body is wet when its middle is in the volume; the surface can be anywhere above the
    // feet, so the probe is capped just under the water line rather than at the middle.
    if (!inVolume(volume, x, y, Math.min(volume.surfaceZ - .01, feet + height / 2), 1e-3)) continue;
    const under = clamp((volume.surfaceZ - feet) / Math.max(1, height), 0, 1);
    const level = under >= 1 ? 3 : under >= .5 ? 2 : 1;
    if (!best || volume.surfaceZ > best.surfaceZ) {
      best = { level, surfaceZ: volume.surfaceZ, under, id: volume.id, settings: volume.settings };
    }
  }
  return best;
}

/**
 * How much of a body at `centre` the water holds, from 0 (dry) to 1 (well under the surface).
 *
 * A body floats where the water's push balances its weight, so what matters is not "is the
 * centre under water" but "how much of it is" — this is the share that stands in for the part
 * of a crate below the water line without casting its hull against every plane.
 */
export function buoyancyFraction(volumes, centre) {
  const [x, y, z] = centre;
  let fraction = 0, settings = null;
  for (const volume of volumes || []) {
    if (!inVolume(volume, x, y, z, FLOAT_BAND)) continue;
    const share = clamp((volume.surfaceZ - z + FLOAT_BAND) / (FLOAT_BAND * 2), 0, 1);
    if (share > fraction) { fraction = share; settings = volume.settings; }
  }
  return { fraction, settings };
}

/**
 * The vertical speed a swimmer is trying to reach, in units per second.
 *
 * A swimmer under the surface goes where they look: nose down dives, nose up rises, and the
 * forward key is what commits to it. Pushing off the bottom (`jump`) is a stroke upwards
 * whatever the view is. The buoyancy decides what doing nothing means, which is what makes a
 * `buoyancy` of 0.6 feel like sinking sludge and 2 like a life jacket.
 */
export function swimTarget({ level, settings, pitch = 0, forward = 0, jump = false }) {
  // Water over the ankles is wading, not swimming: the body keeps its own weight.
  if (!(level >= 2) || !settings) return null;
  const climb = Number(settings.swimSpeed) || 0;
  // Buoyancy is the whole of "doing nothing": neutral holds the depth the swimmer stopped at,
  // thinner water lets them down and thicker water lifts them until the surface is at their chest.
  let target = ((Number(settings.buoyancy) || 0) - 1) * 120;
  if (level >= 3) target += clamp(forward, -1, 1) * Math.sin(pitch) * climb * 1.4;
  if (jump) target += climb;
  return clamp(target, -(Number(settings.sinkSpeed) || 0), climb);
}

/** The share of the walking speed that survives at a given water level. */
export function waterSpeedScale(level, settings) {
  if (!(level > 0) || !settings) return 1;
  const scale = clamp(Number(settings.speedScale) ?? 1, .05, 1);
  // Wading slows the body before it lifts it: half the loss at the ankles, all of it swimming.
  return 1 - (1 - scale) * (level / 3);
}

/** The push a current carries, per second, at a given depth. */
export function currentAt(settings) {
  const current = settings?.current || WATER_DEFAULTS.current;
  return { x: Number(current.x) || 0, y: Number(current.y) || 0, z: Number(current.z) || 0 };
}

/** The presets the editor offers when a water body is created. */
export function waterPresets() {
  return [
    { id: 'pool', name: 'Swimming pool', water: { color: '#2f9fc4', buoyancy: 1.4, opacity: .72, speedScale: .7 } },
    { id: 'lake', name: 'Lake', water: { color: '#1f6f7d', buoyancy: 1.2, opacity: .84, speedScale: .62 } },
    { id: 'sea', name: 'Sea', water: { color: '#14556b', buoyancy: 1.6, opacity: .88, speedScale: .55 } },
    { id: 'sludge', name: 'Sludge', water: { color: '#4c5b2a', buoyancy: .8, opacity: .95, speedScale: .4, sinkSpeed: 70 } },
    { id: 'lava', name: 'Lava', water: { color: '#a83a12', buoyancy: 1.1, opacity: .96, speedScale: .35, sinkSpeed: 90 } },
  ];
}

/**
 * The `water` record a preset gives, filled in against the defaults.
 *
 * Presets are a starting point, not a link: choosing one writes numbers into the brush, so a
 * level keeps the look it was authored with even if a later build tunes a preset.
 */
export function waterFromPreset(id) {
  const preset = waterPresets().find(entry => entry.id === id);
  return { ...WATER_DEFAULTS, ...(preset?.water || {}), current: { ...WATER_DEFAULTS.current } };
}
