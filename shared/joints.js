// Joints between two physical objects.
//
// Rapier is the physics engine, so the joint kinds are Rapier's: a fixed weld, a hinge
// (revolute), a slider (prismatic), a ball socket (spherical), a rope and a spring. A
// joint hangs between two objects — or between one object and the world, which is how a
// swinging door or a hanging lamp is built — and both sides must be rigid bodies.
//
// Coordinates are map units (64 units = 1 metre) in the same space as an object's
// position, so an editor can place an anchor where the user clicked.
export const JOINT_TYPES = ['fixed', 'revolute', 'prismatic', 'spherical', 'rope', 'spring'];
export const MAX_JOINTS = 256;

/** Types that swing or slide around an axis. */
export const AXIS_JOINTS = new Set(['revolute', 'prismatic']);

export const JOINT_LABELS = {
  fixed: 'Fixed (weld)', revolute: 'Hinge (revolute)', prismatic: 'Slider (prismatic)',
  spherical: 'Ball socket (spherical)', rope: 'Rope', spring: 'Spring',
};

let counter = 0;
export function newJointId() {
  counter = (counter + 1) % 100000;
  return `joint_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}${counter}`;
}

/** A joint with the defaults its type needs, anchored between two objects. */
export function newJoint({
  id = newJointId(), name, type = 'fixed', a = null, b = null, anchor = { x: 0, y: 0, z: 0 },
  axis = { x: 0, y: 0, z: 1 }, limits, motor, length = 64, stiffness = 100, damping = 10,
} = {}) {
  if (!JOINT_TYPES.includes(type)) throw new Error(`Unknown joint type ${type}`);
  const joint = { id, name: (name || JOINT_LABELS[type]).slice(0, 100), type, a, b,
    anchor: { x: round(anchor.x), y: round(anchor.y), z: round(anchor.z ?? 0) } };
  if (AXIS_JOINTS.has(type)) {
    joint.axis = normalizeAxis(axis);
    if (limits) joint.limits = { min: Number(limits.min) || 0, max: Number(limits.max) || 0 };
  }
  if (type === 'rope') joint.length = Math.max(1, Math.round(length));
  if (type === 'spring') {
    joint.length = Math.max(1, Math.round(length));
    joint.stiffness = clamp(stiffness, 0, 1e6);
    joint.damping = clamp(damping, 0, 1e6);
  }
  if (motor) joint.motor = { target: Number(motor.target) || 0, stiffness: clamp(motor.stiffness ?? 100, 0, 1e6) };
  return joint;
}

const round = value => {
  const rounded = Math.round(Number(value) || 0);
  return rounded === 0 ? 0 : rounded;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

function normalizeAxis(axis) {
  const length = Math.hypot(axis?.x || 0, axis?.y || 0, axis?.z || 0);
  if (!length) return { x: 0, y: 0, z: 1 };
  return { x: +(axis.x / length).toFixed(4), y: +(axis.y / length).toFixed(4), z: +(axis.z / length).toFixed(4) };
}

/** The middle of two objects, which is where a new joint is anchored. */
export function jointAnchorBetween(first, second) {
  const height = entity => (entity?.elevation || 0) + (entity?.physics?.height || 32) / 2;
  if (!first) return { x: Math.round(second?.x || 0), y: Math.round(second?.y || 0), z: Math.round(height(second)) };
  if (!second) return { x: Math.round(first.x || 0), y: Math.round(first.y || 0), z: Math.round(height(first)) };
  return { x: Math.round((first.x + second.x) / 2), y: Math.round((first.y + second.y) / 2),
    z: Math.round((height(first) + height(second)) / 2) };
}

/** Names a joint after the objects it connects, so a list of them reads. */
export function describeJoint(joint, nameOf = id => id || 'the world') {
  return `${joint.name} (${JOINT_LABELS[joint.type] || joint.type}): ${nameOf(joint.a)} \u2194 ${nameOf(joint.b)}`;
}

/**
 * Validates one joint against the object ids it may reference. A joint needs at least one
 * object; `null` on one side means the world, which is how a fixed pivot is built.
 */
export function validateJoint(joint, { ids = null, label = 'Joint' } = {}) {
  const fail = message => { throw new Error(`${label}: ${message}`); };
  if (!joint || typeof joint !== 'object' || Array.isArray(joint)) fail('must be an object');
  if (typeof joint.id !== 'string' || !joint.id || joint.id.length > 120) fail('needs an id');
  if (joint.name !== undefined && (typeof joint.name !== 'string' || joint.name.length > 100)) fail('has an invalid name');
  if (!JOINT_TYPES.includes(joint.type)) fail(`unknown type ${joint.type}`);
  const side = value => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !value || value.length > 120) fail('references an invalid object');
    if (ids && !ids.has(value)) fail(`references the unknown object ${value}`);
    return value;
  };
  const a = side(joint.a), b = side(joint.b);
  if (!a && !b) fail('must be attached to at least one object');
  if (a && a === b) fail('cannot attach an object to itself');
  if (!joint.anchor || typeof joint.anchor !== 'object') fail('needs an anchor');
  for (const key of ['x', 'y', 'z']) {
    if (joint.anchor[key] !== undefined && !Number.isFinite(joint.anchor[key])) fail(`anchor ${key} must be a number`);
  }
  if (AXIS_JOINTS.has(joint.type)) {
    const axis = joint.axis;
    if (!axis || !['x', 'y', 'z'].every(key => Number.isFinite(axis[key] ?? 0))) fail('needs a numeric axis');
    if (!Math.hypot(axis.x || 0, axis.y || 0, axis.z || 0)) fail('axis cannot be zero length');
  }
  if (joint.limits !== undefined) {
    const { min, max } = joint.limits || {};
    if (!Number.isFinite(min) || !Number.isFinite(max)) fail('limits must be numbers');
    if (max < min) fail('limits end before they start');
  }
  if (joint.motor !== undefined) {
    if (!Number.isFinite(joint.motor?.target)) fail('motor target must be a number');
    if (joint.motor.stiffness !== undefined && (!Number.isFinite(joint.motor.stiffness) || joint.motor.stiffness < 0)) {
      fail('motor stiffness must be a positive number');
    }
  }
  for (const key of ['length', 'stiffness', 'damping']) {
    if (joint[key] === undefined) continue;
    if (!Number.isFinite(joint[key]) || joint[key] < 0 || joint[key] > 1e6) fail(`${key} must be a positive number`);
  }
  return joint;
}

/** Rewrites the object references of a copied joint. */
export function remapJoint(joint, mapping, { id = joint.id, prefix = '' } = {}) {
  const copy = structuredClone(joint);
  copy.id = id.slice(0, 120);
  for (const side of ['a', 'b']) {
    if (copy[side] && mapping.has(copy[side])) copy[side] = mapping.get(copy[side]);
    else if (prefix && copy[side]) copy[side] = `${prefix}_${copy[side]}`.slice(0, 120);
  }
  return copy;
}

/** Joints that touch one object, in stored order. */
export function jointsOf(joints, objectId) {
  return (joints || []).filter(joint => joint.a === objectId || joint.b === objectId);
}

/** Drops joints that reference an object that no longer exists. */
export function pruneJoints(joints, ids) {
  const known = ids instanceof Set ? ids : new Set(ids);
  return (joints || []).filter(joint => (!joint.a || known.has(joint.a)) && (!joint.b || known.has(joint.b)));
}
