// How an object is drawn in the preview, kept free of three.js so the editor and
// renderer agree on the same rules and both stay testable without a GPU.

import { spriteAnchor } from './sprite-anchor.js';

export function entityRepresentation(entity) {
  // A panel is a translucent slab of its own; it has no artwork to load, so switching to
  // one from a sprite or a model is a swap like any other.
  if (entity?.panel) return 'panel';
  return entity?.modelAsset ? 'model' : 'sprite';
}

/**
 * What a live in-place project update has to redo for each object.
 *
 * A model is parsed before the first frame, so an object that gains one needs a
 * full preview reload. Objects that switch between a sprite and a model, swap one
 * model for another, or appear for the first time are swapped in place.
 */
export function liveProjectPlan(entities, { hasModel, drawn, drawnModel }) {
  const swap = [], add = [];
  let needsReload = false;
  for (const entity of entities || []) {
    if (entity.modelAsset && !hasModel(entity.modelAsset)) { needsReload = true; continue; }
    const wanted = entityRepresentation(entity);
    const current = drawn(entity.id);
    // Replacing one model with another keeps the representation but needs a new object.
    const replaced = wanted === 'model' && current === 'model' && drawnModel && drawnModel(entity.id) !== entity.modelAsset;
    if (current === wanted && !replaced) continue;
    if (current) swap.push(entity.id);
    add.push(entity.id);
  }
  return { needsReload, swap, add };
}

function rotateQuaternion(vector, quaternion) {
  const [x, y, z, w] = quaternion;
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [
    vector[0] + w * tx + (y * tz - z * ty),
    vector[1] + w * ty + (z * tx - x * tz),
    vector[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Quaternion [x, y, z, w] for a rotation of `degrees` about `axis`. */
function axisRotation(axis, degrees) {
  const half = (Number(degrees) || 0) * Math.PI / 360, sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

function multiplyQuaternion(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * Where a model points: the object's yaw, then the optional model tilt, then the
 * physics rotation when a rigid body owns the object. Objects face the camera's map
 * with the negated Y angle, exactly like the renderer has always rotated them, so a
 * project without tilt, facing or physics produces the same quaternion as before.
 */
export function modelOrientation(entity) {
  // `modelFacing` is how far the file's own forward is turned from the engine's +X, in degrees:
  // a glTF exported facing +Z reports 90 here. Subtracting it puts the model's nose on the
  // object's angle, which is what makes a path turn the truck instead of dragging it sideways.
  const yaw = -((Number(entity?.angle) || 0) - (Number(entity?.modelFacing) || 0)) * Math.PI / 360;
  let quaternion = entity?.rotation
    ? [entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w]
    : [0, Math.sin(yaw), 0, Math.cos(yaw)];
  const tilt = entity?.modelTilt;
  const pitch = Number(tilt?.pitch) || 0, roll = Number(tilt?.roll) || 0;
  // Tilt is applied in the model's own frame, so 180 pitch stands it on its head
  // whatever direction the object faces.
  if (pitch) quaternion = multiplyQuaternion(quaternion, axisRotation([1, 0, 0], pitch));
  if (roll) quaternion = multiplyQuaternion(quaternion, axisRotation([0, 0, 1], roll));
  return quaternion;
}

/**
 * World-space box of a model instance from the model's own bounds, its scale and
 * the object transform. Objects face the camera's map with the negated Y angle,
 * exactly like the renderer rotates them, and sit on their sector floor unless an
 * explicit Z was authored.
 */
export function modelWorldBox(local, { scale = 32, position, angle = 0, quaternion } = {}) {
  const rotation = quaternion || [0, Math.sin(-angle * Math.PI / 360), 0, Math.cos(-angle * Math.PI / 360)];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = rotateQuaternion([
      (corner & 1 ? local.max[0] : local.min[0]) * scale,
      (corner & 2 ? local.max[1] : local.min[1]) * scale,
      (corner & 4 ? local.max[2] : local.min[2]) * scale,
    ], rotation);
    for (let axis = 0; axis < 3; axis++) {
      const value = point[axis] + position[axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

/**
 * Where a sprite's card is drawn: its size, its vertical anchor and the centre it ends up at.
 *
 * One place for the maths, so the card on screen and the box the editor draws around it can never
 * disagree — a box read from the sprite object itself is the unit box until the first frame has
 * placed it.
 */
export function spritePlacement(entity, asset, floorHeight = 0, { flip = false } = {}) {
  const scaleX = entity.spriteScaleX ?? entity.spriteScale ?? 1;
  const scaleY = entity.spriteScaleY ?? entity.spriteScale ?? 1;
  const width = (asset?.width || 24) * scaleX;
  const height = (asset?.height || 40) * scaleY;
  const artworkOffsetY = (asset ? asset.offsetY || asset.height || 40 : 40) * scaleY;
  const shift = spriteAnchor({ width: Math.abs(width), height, offsetX: (asset?.offsetX || 0) * scaleX, offsetY: artworkOffsetY });
  const anchor = entity.z ?? floorHeight + (entity.elevation || 0);
  return {
    drawWidth: width * (flip ? -1 : 1), height, offsetY: artworkOffsetY, shift,
    centre: { x: entity.x + shift.dx, y: anchor + shift.dy, z: entity.y },
  };
}

/**
 * World-space box of a sprite, which is a card that always faces the camera.
 *
 * A billboard's own world box is therefore flat (no depth) and leans with the view, which is
 * what a selected monster used to get: a slanted sheet instead of a box around the monster. What
 * the object occupies is its footprint and its height, and the card's scale is exactly those
 * numbers, so the box is built from them and stands still while the camera turns.
 */
export function spriteWorldBox(centre, width, height) {
  const halfWidth = Math.abs(width) / 2, halfHeight = Math.abs(height) / 2;
  return {
    min: [centre.x - halfWidth, centre.y - halfHeight, centre.z - halfWidth],
    max: [centre.x + halfWidth, centre.y + halfHeight, centre.z + halfWidth],
  };
}

// Where an object stands: authored Z wins, otherwise the sector floor plus its
// floor-relative elevation.
export function entityOrigin(entity, floorHeight = 0) {
  return [entity.x, entity.z ?? floorHeight + (entity.elevation || 0), entity.y];
}

/**
 * Where a facing arrow goes, and which way it points — the player start's, or a faced model's.
 *
 * The arrow is a flat one at the thing's feet (`y` is up in the scene, `z` is the map's `y`), turned
 * the same way a model is (`rotation.y = -angle`, because a map angle turns anticlockwise seen from
 * above while the scene's yaw turns clockwise), lifted clear of the floor so it is not buried in it.
 */
export function facingArrowPose(entity, floorHeight = 0, { lift = 2 } = {}) {
  const angle = Number(entity?.angle) || 0;
  return {
    x: Number(entity?.x) || 0,
    y: (Number(floorHeight) || 0) + (Number(entity?.elevation) || 0) + lift,
    z: Number(entity?.y) || 0,
    // `-0` would print as a negative zero in a dataset and compare unequal to 0; a thing facing
    // east is exactly zero.
    yaw: angle ? -angle * Math.PI / 180 : 0,
    angle,
  };
}

/**
 * The player start's arrow: the same one, because a start is a point with an angle and no artwork,
 * and a level always has exactly one start, so this is the only place that decides it.
 */
export const playerStartPose = facingArrowPose;

/** True when an object has told the engine which way its model's forward points. */
export function hasModelFacing(entity) {
  return entity?.modelFacing !== undefined && Number.isFinite(Number(entity.modelFacing));
}
