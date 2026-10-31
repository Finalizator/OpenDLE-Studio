/**
 * Paths: a chain of waypoints that a curve is fitted through.
 *
 * One data model, many uses — a patrol route a model walks, a timeline's motion, the spine a
 * ramp is generated along. The points are the truth; everything else (the line drawn in the
 * editor, the position after 3 seconds of travel) is sampled from them.
 *
 * Every point carries its own `curve`, because a route needs both: a hard corner where the
 * path turns a wall, a long sweep where it rounds a pillar. `curve = 0` makes the path pass
 * through the point as a corner (the two segments meeting there are straight), `curve = 1`
 * makes it sweep through (uniform Catmull-Rom). Intermediate values bend less. A segment is
 * only as curved as the point at each of its ends allows, so a corner never kinks.
 *
 * Curvature is applied as a Hermite tangent scale, which is why a corner is *straight* rather
 * than merely sharpened: a zero tangent is what a straight line between two points looks like.
 */

export const MAX_PATHS = 128;
export const MAX_PATH_POINTS = 512;
/** Samples per segment when nothing more specific is asked for. */
export const PATH_STEPS = 12;

export function createPath({ id, name = 'Path', closed = false, points = [] } = {}) {
  return { id, name, closed: Boolean(closed), points: points.map(point => createPathPoint(point)) };
}

export function createPathPoint({ id, x = 0, y = 0, z = 0, curve = 1 } = {}) {
  return { id, x, y, z, curve };
}

const clamp01 = value => Math.min(1, Math.max(0, value));

/**
 * The two tangent vectors of the segment between `index` and the next point.
 *
 * A tangent is half the span of the point's neighbours, scaled by that point's curvature:
 * the Catmull-Rom rule (0.5 · (next − previous)) with the curvature as the knob. An open
 * path's ends reuse the point itself as its missing neighbour, so the ends run straight out
 * rather than overshooting past the last waypoint.
 */
function tangentsAt(points, index, closed) {
  const count = points.length;
  const at = i => points[(i + count) % count];
  const current = points[index], before = closed || index > 0 ? at(index - 1) : current;
  const after = closed || index < count - 1 ? at(index + 1) : current;
  const scale = 0.5 * clamp01(current.curve ?? 1);
  return { x: (after.x - before.x) * scale, y: (after.y - before.y) * scale, z: (after.z - before.z) * scale };
}

/** How many segments a path has: one per gap, plus the closing one when it loops. */
export function segmentCount(path) {
  const count = path?.points?.length || 0;
  if (count < 2) return 0;
  return path.closed ? count : count - 1;
}

/**
 * The point `t` of the way along one segment, `t` running 0 to 1.
 *
 * Cubic Hermite: position and tangent at both ends, which is what lets `curve` be a per-point
 * number with no special cases. At `curve = 0` on both ends the tangents vanish and this is
 * exactly the straight line between the two points.
 */
export function segmentPoint(points, index, t, closed = false) {
  const count = points.length;
  const from = points[index], to = points[(index + 1) % count];
  const m1 = tangentsAt(points, index, closed);
  const m2 = tangentsAt(points, (index + 1) % count, closed);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return {
    x: h00 * from.x + h10 * m1.x + h01 * to.x + h11 * m2.x,
    y: h00 * from.y + h10 * m1.y + h01 * to.y + h11 * m2.y,
    z: h00 * (from.z || 0) + h10 * m1.z + h01 * (to.z || 0) + h11 * m2.z,
  };
}

/**
 * The path as a chain of positions.
 *
 * `steps` is per segment, so a long route keeps its detail when points are added. A path of
 * one point samples to that point, and an empty path to nothing — both are legal while the
 * user is still clicking.
 */
export function samplePath(path, { steps = PATH_STEPS } = {}) {
  const points = path?.points || [];
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0].x, y: points[0].y, z: points[0].z || 0 }];
  const segments = segmentCount(path), per = Math.max(1, Math.round(steps)), out = [];
  for (let segment = 0; segment < segments; segment++) {
    for (let step = 0; step < per; step++) out.push(segmentPoint(points, segment, step / per, path.closed));
  }
  // The last waypoint (or the first again, for a loop) closes the sampled chain.
  const last = path.closed ? points[0] : points[points.length - 1];
  out.push({ x: last.x, y: last.y, z: last.z || 0 });
  return out;
}

/** Cumulative straight-line length of a sampled chain, for travelling along it. */
export function sampleLengths(samples) {
  const lengths = [0];
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1], b = samples[index];
    lengths.push(lengths[index - 1] + Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)));
  }
  return lengths;
}

/** Total length of a path, in map units. */
export function pathLength(path, options) {
  const lengths = sampleLengths(samplePath(path, options));
  return lengths[lengths.length - 1] || 0;
}

/**
 * Where a traveller is after covering `t` of the path, `t` running 0 to 1 by distance.
 *
 * By *distance*, not by segment: a model walking a route must not sprint along a short
 * segment and crawl along a long one, which is what a per-segment parameter would do.
 */
export function pointAlong(path, t, { steps = PATH_STEPS, samples = null, lengths = null } = {}) {
  const chain = samples || samplePath(path, { steps });
  if (!chain.length) return null;
  const distances = lengths || sampleLengths(chain);
  const total = distances[distances.length - 1];
  if (!(total > 0)) return { ...chain[0], angle: 0 };
  const wanted = Math.min(1, Math.max(0, t)) * total;
  let index = 1;
  while (index < distances.length - 1 && distances[index] < wanted) index++;
  const before = chain[index - 1], after = chain[index];
  const span = distances[index] - distances[index - 1];
  const blend = span > 0 ? (wanted - distances[index - 1]) / span : 0;
  return {
    x: before.x + (after.x - before.x) * blend,
    y: before.y + (after.y - before.y) * blend,
    z: (before.z || 0) + ((after.z || 0) - (before.z || 0)) * blend,
    // The direction of travel in degrees, measured the way a Doom thing's angle is: 0 along
    // +x, counter-clockwise seen from above.
    angle: Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI,
  };
}

/** Axis-aligned bounds of a path, or null when it has no points. */
export function pathBounds(path) {
  const points = path?.points || [];
  if (!points.length) return null;
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
    bounds.minZ = Math.min(bounds.minZ, point.z || 0); bounds.maxZ = Math.max(bounds.maxZ, point.z || 0);
  }
  return bounds;
}
