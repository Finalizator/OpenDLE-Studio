// The player can stand on walls and ceilings by rotating their own "up" axis.
// Map space is x/y horizontal with z up; the rest of the engine (sectors, areas,
// Doom specials) keeps assuming world-up, so the player frame is the only place an
// arbitrary up is allowed and every helper here converts to and from it.

export const WORLD_UP = Object.freeze([0, 0, 1]);
// The player capsule, shared with interaction areas so both agree on the body size.
export const PLAYER_CYLINDER = Object.freeze({ radius: 12, halfHeight: 28 });
// Eyes sit 48 map units above the feet, measured along the player's up axis.
export const EYE_HEIGHT = 48;
export const EYE_ABOVE_CENTRE = EYE_HEIGHT - PLAYER_CYLINDER.halfHeight;
// How far past the capsule surface a "touched" surface is still in reach.
export const SURFACE_REACH = 8;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (v, factor) => [v[0] * factor, v[1] * factor, v[2] * factor];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const magnitude = v => Math.hypot(v[0], v[1], v[2]);
export function normalise(v) {
  const length = magnitude(v);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : [1, 0, 0];
}

/** A usable unit up vector, falling back to world-up for missing or broken input. */
export function upVector(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return [...WORLD_UP];
  const length = magnitude(value);
  return length > 1e-6 ? [value[0] / length, value[1] / length, value[2] / length] : [...WORLD_UP];
}

/**
 * Heading-0 basis for an up axis: `forward` is where the player looks and `right`
 * is the strafe direction. World-up keeps forward on +X, so an untouched project
 * moves exactly as before; a wall normal turns forward to world-up, which is the
 * "look up the wall" view a gravity change should give.
 */
export function playerBasis(up = WORLD_UP) {
  const axis = upVector(up);
  const anchor = Math.abs(axis[0]) < .9 ? [1, 0, 0] : [0, 0, 1];
  const forward = normalise(subtract(anchor, scale(axis, dot(axis, anchor))));
  return { up: axis, forward, right: normalise(cross(axis, forward)) };
}

/** World classification of a surface normal, which is what "wall" and "roof" mean. */
export function surfaceKind(normal) {
  const axis = upVector(normal);
  return axis[2] > .7 ? 'floor' : axis[2] < -.7 ? 'ceiling' : 'wall';
}

/** The direction the player faces, ignoring pitch. */
export function headingDirection(player) {
  const { forward, right } = playerBasis(player?.up);
  const angle = Number.isFinite(player?.angle) ? player.angle : 0;
  return normalise(add(scale(forward, Math.cos(angle)), scale(right, Math.sin(angle))));
}

/** The full look direction the camera and hitscan attacks use. */
export function viewDirection(player) {
  const { up } = playerBasis(player?.up);
  const pitch = Number.isFinite(player?.pitch) ? player.pitch : 0;
  return normalise(add(scale(headingDirection(player), Math.cos(pitch)), scale(up, Math.sin(pitch))));
}

/** Capsule centre in map space, from the feet height stored on the player. */
export function playerCentre(player) {
  const up = upVector(player?.up);
  const feet = Number.isFinite(player?.z) ? player.z : 0;
  return [player?.x || 0, player?.y || 0, feet + up[2] * PLAYER_CYLINDER.halfHeight];
}

/** Eye position in map space, `EYE_HEIGHT` above the feet along the up axis. */
export function eyePosition(player) {
  return add(playerCentre(player), scale(upVector(player?.up), EYE_ABOVE_CENTRE));
}

/**
 * Point the player's up axis at `up` while keeping the world direction they were
 * facing, so a gravity change reads as a roll instead of a turn. Returns whether
 * the axis actually changed, which keeps per-frame rules free of jitter.
 */
export function alignUp(player, up) {
  const next = upVector(up);
  const previous = upVector(player?.up);
  if (dot(previous, next) > .999999) { if (player) player.up = next; return false; }
  const facing = headingDirection(player);
  if (player) player.up = next;
  const basis = playerBasis(next);
  // Walking into a wall means facing straight into the new floor, so in that
  // degenerate case look "up" the surface the player just stepped onto.
  let target = subtract(facing, scale(next, dot(next, facing)));
  if (magnitude(target) < 1e-3) target = subtract(previous, scale(next, dot(next, previous)));
  if (magnitude(target) < 1e-3) return true;
  if (player) player.angle = Math.atan2(dot(target, basis.right), dot(target, basis.forward));
  return true;
}
