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
export const PATH_MODES = ['smooth', 'straight', 'bezier', 'sine'];
export const PATH_SINE_DEFAULTS = { amplitude: 64, height: 0, cycles: 1, phase: 0 };

export function createPath({ id, name = 'Path', closed = false, points = [], mode, softness, steps, sine } = {}) {
  const path = { id, name, closed: Boolean(closed), points: points.map(point => createPathPoint(point)) };
  for (const [key, value] of Object.entries({ mode, softness, steps, sine })) if (value !== undefined) path[key] = structuredClone(value);
  return path;
}

export function createPathPoint({ id, name, x = 0, y = 0, z = 0, curve = 1, handleIn, handleOut, steps } = {}) {
  const point = { id, x, y, z, curve };
  // A waypoint's name is optional: a route usually reads fine as "Waypoint 3", and only a route
  // that other rules point at needs words ("Start", "Gate", "Depot").
  const label = typeof name === 'string' ? name.trim() : '';
  if (label) point.name = label;
  if (handleIn) point.handleIn = { ...handleIn };
  if (handleOut) point.handleOut = { ...handleOut };
  if (steps !== undefined) point.steps = steps;
  return point;
}

/** What a waypoint is called: its own name, or where it sits on the route. */
export function pathPointLabel(point, index) {
  const name = typeof point?.name === 'string' ? point.name.trim() : '';
  return name || `Waypoint ${index + 1}`;
}

/** The name of one waypoint of one route, for a label or a message: `-1` is the route's end. */
export function pathPointName(project, pathId, index) {
  if (index < 0) return 'Last waypoint';
  const path = (project?.paths || []).find(item => item.id === pathId);
  return pathPointLabel(path?.points?.[index], index);
}

/**
 * Options for a waypoint picker, in the order a picker should show them.
 *
 * A rule names waypoints by index — 0 is the first — but a person reads "Waypoint 1", so the
 * editor never asks anyone to type an index: `toPoint` also offers `-1`, "Last waypoint", which is
 * what keeps a route action pointing at the end when the route grows.
 */
export function pathPointOptions(path, { allowLast = false } = {}) {
  const options = (path?.points || []).map((point, index) => [index, pathPointLabel(point, index)]);
  if (allowLast) options.unshift([-1, 'Last waypoint']);
  return options;
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
  return { x: (after.x - before.x) * scale, y: (after.y - before.y) * scale, z: ((after.z || 0) - (before.z || 0)) * scale };
}

export function pathHandle(path, index, key) {
  const explicit = path.points[index][key];
  if (explicit) return explicit;
  const tangent = tangentsAt(path.points, index, path.closed), sign = key === 'handleIn' ? -1 : 1;
  return { x: tangent.x * sign / 3, y: tangent.y * sign / 3, z: tangent.z * sign / 3 };
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
export function segmentPoint(points, index, t, closed = false, options = {}) {
  const count = points.length;
  const from = points[index], to = points[(index + 1) % count];
  if (t <= 0) return { x: from.x, y: from.y, z: from.z || 0 };
  if (t >= 1) return { x: to.x, y: to.y, z: to.z || 0 };
  const mode = options.mode || 'smooth', softness = options.softness ?? 1;
  const lerp = {
    x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
    z: (from.z || 0) + ((to.z || 0) - (from.z || 0)) * t,
  };
  if (mode === 'straight') return lerp;
  if (mode === 'bezier') {
    const u = 1 - t, result = {};
    const shape = { points, closed };
    const handleOut = pathHandle(shape, index, 'handleOut');
    const handleIn = pathHandle(shape, (index + 1) % count, 'handleIn');
    for (const axis of ['x', 'y', 'z']) {
      const a = from[axis] || 0, b = to[axis] || 0;
      const out = handleOut[axis], incoming = handleIn[axis];
      result[axis] = u * u * u * a + 3 * u * u * t * (a + out) +
        3 * u * t * t * (b + incoming) + t * t * t * b;
      result[axis] = lerp[axis] + (result[axis] - lerp[axis]) * softness;
    }
    return result;
  }
  if (mode === 'sine') {
    const wave = { ...PATH_SINE_DEFAULTS, ...options.sine };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    // The squared envelope keeps waypoint positions and endpoint tangents continuous.
    const envelope = (1 - softness) + softness * Math.sin(Math.PI * t) ** 2;
    const phase = wave.phase * Math.PI / 180;
    const oscillation = Math.sin(2 * Math.PI * wave.cycles * t + phase) -
      ((1 - t) * Math.sin(phase) + t * Math.sin(2 * Math.PI * wave.cycles + phase));
    const amount = envelope * oscillation;
    return {
      x: lerp.x - (length ? (to.y - from.y) / length : 0) * wave.amplitude * amount,
      y: lerp.y + (length ? (to.x - from.x) / length : 0) * wave.amplitude * amount,
      z: lerp.z + wave.height * amount,
    };
  }
  const m1 = tangentsAt(points, index, closed);
  const m2 = tangentsAt(points, (index + 1) % count, closed);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const smooth = {
    x: h00 * from.x + h10 * m1.x + h01 * to.x + h11 * m2.x,
    y: h00 * from.y + h10 * m1.y + h01 * to.y + h11 * m2.y,
    z: h00 * (from.z || 0) + h10 * m1.z + h01 * (to.z || 0) + h11 * m2.z,
  };
  if (softness === 1) return smooth;
  return {
    x: lerp.x + (smooth.x - lerp.x) * softness,
    y: lerp.y + (smooth.y - lerp.y) * softness,
    z: lerp.z + (smooth.z - lerp.z) * softness,
  };
}

/** A waypoint override controls the span leaving it; explicit caller density wins over both. */
export function pathSteps(path, requested, segment) {
  const override = segment === undefined ? undefined : path?.points?.[segment]?.steps;
  const base = Math.max(1, Math.min(256, Math.round(requested ?? override ?? path?.steps ?? PATH_STEPS)));
  return path?.mode === 'sine' ? Math.max(base, Math.ceil((path.sine?.cycles ?? 1) * 16)) : base;
}

/** Everything that can change the sampled curve, including handles and wave settings. */
export function pathSignature(path) {
  return JSON.stringify([path.closed, path.mode, path.softness, path.steps, path.sine,
    path.points.map(point => [point.x, point.y, point.z || 0, point.curve ?? 1, point.handleIn, point.handleOut, point.steps])]);
}

/**
 * The path as a chain of positions.
 *
 * `steps` is per segment, so a long route keeps its detail when points are added. A path of
 * one point samples to that point, and an empty path to nothing — both are legal while the
 * user is still clicking.
 */
export function samplePath(path, { steps, withTangents = false } = {}) {
  const points = path?.points || [];
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0].x, y: points[0].y, z: points[0].z || 0 }];
  const segments = segmentCount(path), out = [];
  const derivative = (segment, t) => {
    const before = segmentPoint(points, segment, Math.max(0, t - .0001), path.closed, path);
    const after = segmentPoint(points, segment, Math.min(1, t + .0001), path.closed, path);
    return { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
  };
  const sample = (segment, t) => {
    const point = segmentPoint(points, segment, t, path.closed, path);
    if (withTangents) {
      const outgoing = derivative(segment, t);
      const incoming = t === 0 && (segment > 0 || path.closed)
        ? derivative((segment - 1 + segments) % segments, 1) : outgoing;
      point.tangents = { incoming, outgoing };
    }
    return point;
  };
  for (let segment = 0; segment < segments; segment++) {
    const per = pathSteps(path, steps, segment);
    for (let step = 0; step < per; step++) out.push(sample(segment, step / per));
  }
  // The last waypoint (or the first again, for a loop) closes the sampled chain.
  out.push(path.closed ? { ...out[0] } : sample(segments - 1, 1));
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
 * The distance along the route at each **waypoint**.
 *
 * A tween between two waypoints needs the arc length where those waypoints sit, and
 * Each span can have its own density, so waypoint indexes accumulate the actual span counts.
 * On a closed path the last waypoint precedes the closing segment; total includes it.
 */
export function waypointDistances(path, { steps } = {}) {
  const points = path?.points || [];
  const lengths = sampleLengths(samplePath(path, { steps }));
  const total = lengths[lengths.length - 1] || 0;
  const distances = [];
  let sampleIndex = 0;
  for (let index = 0; index < Math.max(1, points.length); index++) {
    distances.push(lengths[Math.min(lengths.length - 1, sampleIndex)] || 0);
    sampleIndex += pathSteps(path, steps, index);
  }
  if (distances.length && !path.closed) distances[distances.length - 1] = total;
  return { distances, total };
}

/**
 * Where a traveller is after covering `t` of the path, `t` running 0 to 1 by distance.
 *
 * By *distance*, not by segment: a model walking a route must not sprint along a short
 * segment and crawl along a long one, which is what a per-segment parameter would do.
 */
export function pointAlong(path, t, { steps, samples = null, lengths = null } = {}) {
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

/**
 * What still points at a route: the objects that walk it, and every action that moves something
 * along it — an event action or a timeline cue action.
 *
 * A project that references a path it does not have is invalid, which is why deleting a route
 * has to know about its references before removing it rather than after.
 */
export function pathReferences(project, pathId) {
  const followers = (project.map?.entities || []).filter(entity => entity.path?.id === pathId);
  const ramps = (project.map?.entities || []).filter(entity => entity.ramp?.pathId === pathId);
  const actions = [];
  for (const event of project.events || []) for (const action of event.actions || []) actions.push(action);
  for (const sheet of project.timesheets || []) for (const cue of sheet.cues || []) for (const action of cue.actions || []) actions.push(action);
  return { followers, ramps, actions: actions.filter(action => action?.type === 'followPath' && action.pathId === pathId) };
}

/** Keep the generated mesh and collision while dropping its layout-only shape dependency. */
export function bakePathRamp(entity) {
  if (!entity.ramp?.pathId) return false;
  entity.type = 'decoration';
  delete entity.ramp;
  return true;
}

/**
 * The routes one object is driven along, and where that was decided.
 *
 * An object follows a route in three different ways — its own `path` setting, an event action,
 * or a timeline cue — and only the first was ever visible in the inspector. A truck driven by a
 * timesheet therefore looked as if it followed nothing at all, which is why aligning a model to
 * "its route" was offered for objects the route had never been pointed at. Each entry says where
 * it came from so the editor can name it rather than just offering a path id.
 */
export function routesForEntity(project, entityId) {
  if (!entityId) return [];
  const routes = [];
  const add = (pathId, source) => {
    const path = (project.paths || []).find(item => item.id === pathId);
    if (!path || routes.some(entry => entry.path.id === path.id)) return;
    routes.push({ path, source });
  };
  // `$self` is the action's own object — the cue's owner, or the event's — and it is how a usual
  // timeline driving its own object is written, so matching the id literally would miss it.
  const targets = (action, ownerId) => action?.type === 'followPath'
    && (action.entityId === entityId || (action.entityId === '$self' && ownerId === entityId));
  const entity = (project.map?.entities || []).find(item => item.id === entityId);
  if (entity?.path?.id) add(entity.path.id, 'object');
  for (const event of project.events || []) {
    for (const action of event.actions || []) if (targets(action, event.ownerId)) add(action.pathId, 'event');
  }
  for (const sheet of project.timesheets || []) {
    for (const cue of sheet.cues || []) {
      for (const action of cue.actions || []) if (targets(action, cue.ownerId)) add(action.pathId, `timesheet:${sheet.id}`);
    }
  }
  return routes;
}

/**
 * Deletes a route from a draft project, releasing what referenced it.
 *
 * Followers simply stop following; an action that moved something along the route is dropped,
 * because a route action without a route has nothing to say. Both counts come back so the editor
 * can say what the delete took with it. Returns null when the path is already gone.
 */
export function removePath(project, pathId) {
  const path = (project.paths || []).find(item => item.id === pathId);
  if (!path) return null;
  const { followers, actions, ramps } = pathReferences(project, pathId);
  // The mesh is already an ordinary model: deleting its source bakes it rather than losing it.
  for (const entity of ramps) bakePathRamp(entity);
  for (const entity of project.map?.entities || []) if (entity.path?.id === pathId) delete entity.path;
  const drop = list => (list || []).filter(action => !(action?.type === 'followPath' && action.pathId === pathId));
  for (const event of project.events || []) event.actions = drop(event.actions);
  for (const sheet of project.timesheets || []) for (const cue of sheet.cues || []) cue.actions = drop(cue.actions);
  project.paths = (project.paths || []).filter(item => item.id !== pathId);
  return { path, followers: followers.length, actions: actions.length, ramps: ramps.length };
}

/**
 * Deletes one waypoint from a draft project. A route keeps at least two: one point is not a route,
 * and a walker has nowhere to go, so the last two are refused instead of quietly leaving rubble.
 */
export function removePathPoint(project, pathId, pointId) {
  const path = (project.paths || []).find(item => item.id === pathId);
  if (!path) throw new Error('That path no longer exists');
  if (!path.points.some(point => point.id === pointId)) throw new Error('That waypoint no longer exists');
  const remaining = path.points.length - 1;
  if (remaining < 2) throw new Error('A path needs at least two waypoints; delete the path instead');
  const removedIndex = path.points.findIndex(point => point.id === pointId);
  path.points = path.points.filter(point => point.id !== pointId);
  // Actions name waypoints by index, and that index is a reference to *that* waypoint, so losing
  // one has to move every later number down with it — an action pointing at the waypoint called
  // "Depot" must still point at Depot, not at whatever slid into its place. `-1` means "the last
  // one" and stays right by itself, and an index that is now past the end is clamped, or the
  // project stops validating.
  const last = remaining - 1;
  const fix = value => {
    if (typeof value !== 'number' || value < 0) return value;
    const shifted = value > removedIndex ? value - 1 : value;
    return shifted > last ? last : shifted;
  };
  forEachPathAction(project, pathId, action => {
    action.fromPoint = fix(action.fromPoint);
    action.toPoint = fix(action.toPoint);
  });
  return { path, remaining };
}

/** Every action, in events and in timeline cues, that points at one route. */
function forEachPathAction(project, pathId, visit) {
  const seen = (list) => (list || []).filter(action => action?.type === 'followPath' && action.pathId === pathId).forEach(visit);
  for (const event of project.events || []) seen(event.actions);
  for (const sheet of project.timesheets || []) for (const cue of sheet.cues || []) seen(cue.actions);
}
