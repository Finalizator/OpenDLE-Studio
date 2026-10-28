// How an object is drawn in the preview, kept free of three.js so the editor and
// renderer agree on the same rules and both stay testable without a GPU.

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
 * project without tilt or physics produces the same quaternion as before.
 */
export function modelOrientation(entity) {
  const yaw = -((Number(entity?.angle) || 0) * Math.PI / 360);
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

// Where an object stands: authored Z wins, otherwise the sector floor plus its
// floor-relative elevation.
export function entityOrigin(entity, floorHeight = 0) {
  return [entity.x, entity.z ?? floorHeight + (entity.elevation || 0), entity.y];
}
