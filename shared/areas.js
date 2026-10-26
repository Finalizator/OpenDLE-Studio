// Interaction areas are the volumes a "player entered area" event tests. They live on
// the object, so the 3D editor can draw exactly what the event checks, and they use
// the same shapes and floor-relative placement as Rapier colliders.

export const AREA_SHAPES = ['box', 'sphere', 'capsule'];
export const DEFAULT_AREA = { shape: 'box', width: 96, height: 96, depth: 96, radius: 48 };
// The player's capsule, so an area reacts to the body and not to a single point.
export const PLAYER_CYLINDER = { radius: 12, halfHeight: 28 };

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
  const base = (floorHeight || 0) + (entity.elevation || 0);
  const half = spec.shape === 'box'
    ? { width: spec.width / 2, depth: spec.depth / 2, height: spec.height / 2 }
    : { width: spec.radius, depth: spec.radius, height: (spec.shape === 'sphere' ? spec.radius * 2 : spec.height) / 2 };
  return {
    shape: spec.shape, radius: spec.radius,
    center: { x: entity.x, y: entity.y, z: base + half.height },
    half,
  };
}

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
  const horizontal = volume.shape === 'box'
    ? Math.abs(player.x - volume.center.x) <= volume.half.width + cylinder.radius &&
      Math.abs(player.y - volume.center.y) <= volume.half.depth + cylinder.radius
    : Math.hypot(player.x - volume.center.x, player.y - volume.center.y) <= volume.radius + cylinder.radius;
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
  const base = (floorHeight || 0) + (entity.elevation || 0);
  const shape = physics.shape === 'ball' ? 'sphere' : physics.shape === 'capsule' ? 'capsule' : 'box';
  const half = shape === 'box'
    ? { width: physics.width / 2, depth: physics.depth / 2, height: height / 2 }
    : { width: radius, depth: radius, height: (shape === 'sphere' ? radius * 2 : height) / 2 };
  return { shape, radius, body: physics.body, sensor: Boolean(physics.sensor), center: { x: entity.x, y: entity.y, z: base + half.height }, half };
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
        center: { x: entity.x, y: entity.y, z: (floorOf(entity) || 0) + PLAYER_CYLINDER.halfHeight },
        half: { width: PLAYER_CYLINDER.radius, depth: PLAYER_CYLINDER.radius, height: PLAYER_CYLINDER.halfHeight },
        radius: PLAYER_CYLINDER.radius, selected: false });
      continue;
    }
    const floor = floorOf(entity) || 0;
    if (areas) {
      const volume = areaVolume(entity, floor);
      if (volume) plans.push({ kind: 'area', id: entity.id, name: entity.name, shape: volume.shape,
        center: volume.center, half: volume.half, radius: volume.radius, selected: entity.id === selectedId });
    }
    if (physics) {
      const volume = physicsVolume(entity, floor);
      if (volume) plans.push({ kind: 'physics', id: entity.id, name: entity.name, shape: volume.shape, body: volume.body,
        sensor: volume.sensor, center: volume.center, half: volume.half, radius: volume.radius, selected: entity.id === selectedId });
    }
  }
  return plans;
}
