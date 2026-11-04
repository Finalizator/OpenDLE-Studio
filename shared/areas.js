// Interaction areas are the volumes a "player entered area" event tests. They live on
// the object, so the 3D editor can draw exactly what the event checks, and they use
// the same shapes and floor-relative placement as Rapier colliders.

import { PLAYER_CYLINDER } from './gravity.js';

export const AREA_SHAPES = ['box', 'sphere', 'capsule'];
export const DEFAULT_AREA = { shape: 'box', width: 96, height: 96, depth: 96, radius: 48 };
/**
 * A zone is a volume with no artwork, so its area is the object: it is born room-sized rather
 * than the size of a sprite, and every zone carries one (there is nothing else to carry).
 */
export const ZONE_AREA = { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 };
// The player's capsule, so an area reacts to the body and not to a single point.
export { PLAYER_CYLINDER };

export function areaSpec(area) {
  if (!area || typeof area !== 'object') return null;
  const shape = AREA_SHAPES.includes(area.shape) ? area.shape : DEFAULT_AREA.shape;
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    shape,
    width: number(area.width, DEFAULT_AREA.width),
    height: number(area.height, DEFAULT_AREA.height),
    depth: number(area.depth, DEFAULT_AREA.depth),
    radius: number(area.radius, DEFAULT_AREA.radius),
  };
}

/**
 * Volume of an object's interaction area in map space: x/y are the map plane and z
 * is height above the sector floor, matching entity coordinates.
 */
export function areaVolume(entity, floorHeight = 0) {
  const spec = areaSpec(entity?.area);
  if (!spec) return null;
  const base = Number.isFinite(entity.z) ? entity.z : (floorHeight || 0) + (entity.elevation || 0);
  const half = spec.shape === 'box'
    ? { width: spec.width / 2, depth: spec.depth / 2, height: spec.height / 2 }
    : { width: spec.radius, depth: spec.radius, height: (spec.shape === 'sphere' ? spec.radius * 2 : spec.height) / 2 };
  return {
    shape: spec.shape, radius: spec.radius,
    center: { x: entity.x, y: entity.y, z: base + half.height },
    half,
    // A zone can be turned, so the volume keeps its own yaw. Shapes that are round on the
    // ground (sphere, capsule) are unaffected by it, and a box uses it to rotate the test.
    angle: Number(entity.angle) || 0,
  };
}

/**
 * The yaw a volume is drawn with, in radians.
 *
 * Map angles turn the other way from the scene's +Y, so everything that *draws* a volume — the
 * box in the 3D view, its selection outline, the face plates Form picks — has to use this one
 * number. Closing the gap between the box and its outline is what made a turned zone look
 * selected by the wrong shape.
 */
export const areaYaw = entity => {
  const turn = (Number(entity?.angle) || 0) * Math.PI / 180;
  return turn ? -turn : 0;
};

/** Vertical span of the volume, used for the overlap test and the editor outline. */
export function areaExtent(volume) {
  return { bottom: volume.center.z - volume.half.height, top: volume.center.z + volume.half.height };
}

/**
 * True when the player's cylinder overlaps the volume. Horizontal penetration is
 * expanded by the player radius, and the vertical test compares body spans, so a
 * player stepping onto a low area still counts.
 */
export function areaContains(volume, player, cylinder = PLAYER_CYLINDER) {
  if (!volume || !player) return false;
  // A turned box is tested in its own frame: the offset from the centre is rotated back by the
  // volume's yaw, so the comparison stays a plain axis-aligned one and a rotated zone catches
  // the player where its outline is drawn rather than where its box used to be.
  const radians = (volume.angle || 0) * Math.PI / 180;
  const dx = player.x - volume.center.x, dy = player.y - volume.center.y;
  const cos = Math.cos(-radians), sin = Math.sin(-radians);
  const local = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  const horizontal = volume.shape === 'box'
    ? Math.abs(local.x) <= volume.half.width + cylinder.radius &&
      Math.abs(local.y) <= volume.half.depth + cylinder.radius
    : Math.hypot(dx, dy) <= volume.radius + cylinder.radius;
  if (!horizontal) return false;
  const playerBottom = (player.z || 0) - cylinder.halfHeight, playerTop = (player.z || 0) + cylinder.halfHeight;
  const { bottom, top } = areaExtent(volume);
  return bottom <= playerTop && playerBottom <= top;
}

/** Axis-aligned bounds of the volume in map space, for the editor outline. */
export function areaBounds(volume) {
  const { bottom, top } = areaExtent(volume);
  return {
    min: { x: volume.center.x - volume.half.width, y: volume.center.y - volume.half.depth, z: bottom },
    max: { x: volume.center.x + volume.half.width, y: volume.center.y + volume.half.depth, z: top },
  };
}

/**
 * Edge detector for "player entered": true on the first frame inside a volume and
 * again only after leaving it. Keys are per event so two events on one object stay
 * independent.
 */
export function areaEntered(entries, key, inside) {
  if (inside) {
    if (entries.has(key)) return false;
    entries.add(key);
    return true;
  }
  entries.delete(key);
  return false;
}

/** Default area for a new object, sized from its sprite or collider when possible. */
export function suggestedArea(entity) {
  // A zone's whole purpose is its volume, so it starts at one instead of at nothing.
  if (entity?.type === 'zone') return { ...ZONE_AREA, ...entity.area };
  const physics = entity?.physics;
  if (physics && physics.body && physics.body !== 'none') {
    return { shape: physics.shape === 'ball' ? 'sphere' : physics.shape === 'capsule' ? 'capsule' : 'box',
      width: physics.width, height: physics.height, depth: physics.depth, radius: physics.radius };
  }
  return { ...DEFAULT_AREA };
}

/** Collider volumes for the physics overlay, using the same placement as Rapier. */
export function physicsVolume(entity, floorHeight = 0) {
  const physics = entity?.physics;
  if (!physics || physics.body === 'none') return null;
  const height = Number(physics.height) || 0, radius = Number(physics.radius) || 0;
  const base = Number.isFinite(entity.z) ? entity.z : (floorHeight || 0) + (entity.elevation || 0);
  const shape = physics.shape === 'ball' ? 'sphere' : physics.shape === 'capsule' ? 'capsule' : 'box';
  const half = shape === 'box'
    ? { width: physics.width / 2, depth: physics.depth / 2, height: height / 2 }
    : { width: radius, depth: radius, height: (shape === 'sphere' ? radius * 2 : height) / 2 };
  return { shape, radius, body: physics.body, sensor: Boolean(physics.sensor),
    center: { x: entity.x, y: entity.y, z: base + half.height }, half, angle: Number(entity.angle) || 0 };
}

/**
 * Wireframe plans for the 3D editor overlays: interaction areas and rigid-body
 * colliders, in map space. The editor only turns these into line geometry, so the
 * placement rules stay testable without a GPU.
 */
export function overlayVolumes(entities, { areas = false, physics = false, player = false } = {}, floorOf = () => 0, selectedId = null) {
  const plans = [];
  for (const entity of entities || []) {
    if (entity.type === 'player') {
      // The player capsule shows where an interaction area has to be to catch it.
      if (player) plans.push({ kind: 'player', id: entity.id, name: entity.name, shape: 'capsule', body: 'kinematic',
        center: { x: entity.x, y: entity.y, z: (entity.z ?? (floorOf(entity) || 0) + (entity.elevation || 0)) + PLAYER_CYLINDER.halfHeight },
        half: { width: PLAYER_CYLINDER.radius, depth: PLAYER_CYLINDER.radius, height: PLAYER_CYLINDER.halfHeight },
        radius: PLAYER_CYLINDER.radius, selected: false });
      continue;
    }
    const floor = floorOf(entity) || 0;
    if (areas) {
      const volume = areaVolume(entity, floor);
      if (volume) plans.push({ kind: 'area', id: entity.id, name: entity.name, shape: volume.shape,
        center: volume.center, half: volume.half, radius: volume.radius, angle: volume.angle, selected: entity.id === selectedId });
    }
    if (physics) {
      const volume = physicsVolume(entity, floor);
      if (volume) plans.push({ kind: 'physics', id: entity.id, name: entity.name, shape: volume.shape, body: volume.body,
        sensor: volume.sensor, center: volume.center, half: volume.half, radius: volume.radius, angle: volume.angle, selected: entity.id === selectedId });
    }
  }
  return plans;
}
