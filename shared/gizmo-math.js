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

/**
 * The size a side reaches when a grabbed face is dragged.
 *
 * Only the grabbed face moves — the object's own position is its middle, so the opposite face
 * moves the same amount the other way, and the face under the pointer tracks it exactly.
 */
export const formSizeFromDrag = (start, amount) => start + 2 * amount;

/** A scale multiplier for a drag, where one gizmo length doubles the size. */
export const scaleFactorFromDrag = ({ amount, reference }) =>
  Math.max(.02, 1 + amount / Math.max(1, reference));
