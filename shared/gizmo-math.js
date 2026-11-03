// The numbers behind the 3D transform gizmo: the axis table, and how a pointer turns into an
// amount. Kept free of the renderer so a drag can be measured in a test instead of by eye.
//
// A drag is measured by where the pointer ray meets a plane that carries the axis and faces the
// camera. The cheaper way — what this used to do — is to project the pointer's screen motion onto
// the axis's screen line, which divides by the projected length: an axis pointing away from the
// camera is a few pixels long on screen, so a 20-pixel drag was multiplied by a huge factor and an
// object thousands of units away jumped thousands of units. A plane has no such blow-up. The grab
// point exists, or the axis is aimed straight at the camera and the caller falls back.

/** How long the gizmo is in its own units; the editor scales the group to keep it constant on screen. */
export const GIZMO_LENGTH = 50;

/**
 * Scene-space axes in the colours Godot uses: X red, Y green, Z blue.
 *
 * `field` is the volume side a drag along that axis changes, so Form and Scale read the size they
 * are growing from the same name the project stores.
 */
export const GIZMO_AXES = [
  { key: 'x', direction: [1, 0, 0], color: '#f55252', field: 'width', name: 'X' },
  { key: 'y', direction: [0, 1, 0], color: '#8fdc7c', field: 'height', name: 'Y' },
  { key: 'z', direction: [0, 0, 1], color: '#5a8cf0', field: 'depth', name: 'Z' },
];

export const axisByKey = key => GIZMO_AXES.find(axis => axis.key === key) || null;
export const axisDirection = key => (axisByKey(key)?.direction || [0, 1, 0]).slice();
export const axisField = key => axisByKey(key)?.field || 'width';
/** The name a waypoint or a rule shows: the side of the volume a face belongs to. */
export const faceLabel = key => `${axisByKey(key)?.name || key}`;

const EPSILON = 1e-6;
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, factor) => [a[0] * factor, a[1] * factor, a[2] * factor];
export const length = a => Math.hypot(a[0], a[1], a[2]);

/** Unit length, or null for a vector too short to have a direction. */
export function normalize(vector) {
  const magnitude = length(vector);
  return magnitude > EPSILON ? scale(vector, 1 / magnitude) : null;
}

/**
 * Normal of the plane a drag is measured on: the camera's own view direction.
 *
 * A plane that faces the camera is what makes the measurement exact. The pointer's ray always
 * meets it, and no factor of the axis's *projected* length appears anywhere — which is where this
 * went wrong before. Projecting onto the axis's screen line divides by that length, so an axis
 * pointing away from the camera (a handful of pixels long) turned a 20-pixel drag into thousands
 * of units. Measured on a facing plane instead, the same axis is simply stiff to drag, which is
 * what an axis you are looking down should be.
 */
export function dragPlaneNormal(viewDirection) {
  return normalize(viewDirection);
}

/** Where a ray meets a plane, or null when the ray runs parallel to it. */
export function rayPlaneHit(origin, normal, rayOrigin, rayDirection) {
  const denominator = dot(normal, rayDirection);
  if (Math.abs(denominator) < EPSILON) return null;
  const distance = dot(normal, subtract(origin, rayOrigin)) / denominator;
  if (!Number.isFinite(distance)) return null;
  return [rayOrigin[0] + rayDirection[0] * distance, rayOrigin[1] + rayDirection[1] * distance,
    rayOrigin[2] + rayDirection[2] * distance];
}

/** The point a pointer press grabs on the drag plane, before anything has moved. */
export function axisPressPoint({ origin, viewDirection, rayOrigin, rayDirection }) {
  const normal = dragPlaneNormal(viewDirection);
  return normal ? rayPlaneHit(origin, normal, rayOrigin, rayDirection) : null;
}

/** How far along the axis a point has travelled from the press point. */
export function axisAmount(point, pressPoint, axis) {
  if (!point || !pressPoint) return 0;
  const direction = normalize(axis);
  return direction ? dot(subtract(point, pressPoint), direction) : 0;
}

/** Angle of a screen point around a centre, in radians. Screen y points down. */
export const screenAngle = (center, point) => Math.atan2(point[1] - center[1], point[0] - center[0]);

/** Signed turn from one screen angle to another, in degrees, always the short way round. */
export function angleDegrees(from, to) {
  const turn = Math.PI * 2;
  const delta = ((to - from) % turn + turn * 1.5) % turn - turn / 2;
  return delta * 180 / Math.PI;
}

/**
 * Degrees about +axis for a pointer that moved around a ring.
 *
 * A ring whose axis points away from the camera turns with the pointer; one facing the camera
 * turns the other way, because the two are being watched from opposite sides.
 */
export function ringDegrees({ axis, viewDirection, from, to }) {
  const turn = angleDegrees(from, to);
  const along = normalize(axis), view = normalize(viewDirection);
  if (!along || !view) return turn;
  return dot(along, view) > 0 ? turn : -turn;
}

/**
 * A turn about a scene axis written in the object's own fields.
 *
 * The stored yaw turns the other way from the scene's +Y because the renderer rotates an object
 * by its negated angle, and a model's tilt is applied in the model's frame, on local X and Z.
 */
export function ringDelta(axisKey, degrees) {
  if (axisKey === 'y') return { angle: -degrees };
  if (axisKey === 'x') return { pitch: degrees };
  return { roll: degrees };
}

export function rotationDetent(degrees, start = 0) {
  const target = start + degrees;
  const snapped = Math.round(target / 45) * 45 || 0;
  return Math.abs(target - snapped) <= 3 ? snapped - start : degrees;
}

/**
 * What a face drag does to a volume, worked out on one axis.
 *
 * Everything here is in the axis's own coordinate: `centre` is the volume's middle on that axis,
 * `size` the length of the side being dragged, `amount` the pointer's travel along the positive
 * direction, `side` which of the two faces was grabbed.
 *
 * The **grabbed face snaps to the grid and everything else is derived from it**. That is the whole
 * point: snapping the middle and the size separately leaves the face that is supposed to stay put
 * moving in half-grid steps, which reads as a jiggle while the other face is dragged.
 *
 * `amount` is measured along the positive axis, so a drag on the negative side comes back
 * negative; `side` turns it round, because pulling a left face further left has to grow the
 * volume. By default only the grabbed face moves — the opposite one stays exactly where it was and
 * the middle travels half the drag. `symmetric` (Shift) moves both faces and leaves the middle
 * alone. Round volumes have no second face, so they use the positive side.
 */
export function formDrag({ centre, size, amount, side = 1, symmetric = false, grid = 0, min = 8, max = 16384 }) {
  const half = size / 2;
  const grabbed = centre + side * half;
  const opposite = centre - side * half;
  const travel = grabbed + amount;
  const snapped = grid > 0 ? Math.round(travel / grid) * grid : travel;
  // Measured with `side` rather than as a plain distance, so dragging a face through the volume
  // stops at the smallest it may be instead of flipping it and growing again.
  const wanted = symmetric ? Math.abs(snapped - centre) * 2 : (snapped - opposite) * side;
  // Whole units first: rounding the size *after* the middle is derived from it would move the
  // pinned face by the rounding error, which is half of the jiggle this replaced.
  const nextSize = Math.round(Math.min(max, Math.max(min, wanted)));
  // Where the middle has to be for the face that was not grabbed to stay put; symmetric growth
  // leaves it alone.
  const nextCentre = symmetric ? centre : opposite + side * nextSize / 2;
  return { size: nextSize, centre: nextCentre, shift: nextCentre - centre };
}

/** A scale multiplier for a drag, where one gizmo length doubles the size. */
export const scaleFactorFromDrag = ({ amount, reference }) =>
  Math.max(.02, 1 + amount / Math.max(1, reference));
