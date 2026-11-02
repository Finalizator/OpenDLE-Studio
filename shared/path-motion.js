/**
 * A thing that walks a path: an imported model driving round a route at its own speed.
 *
 * The route is the authoring unit (`project.paths`); this is the follower. An object points at a
 * path by id and says how fast it travels and what it does at the end, so the same route can carry
 * a model that loops forever and another that trundles along once and stops.
 *
 * Travel is measured in map units along the curve, not per segment: `samplePath` is sampled by arc
 * length, so a follower keeps an even speed past waypoints that are spaced unevenly — the thing a
 * per-segment parameter gets wrong in a way you can see.
 */

import { samplePath, sampleLengths, pointAlong } from './paths.js';

/** What happens when a follower reaches the end of its path. */
export const PATH_MODES = ['loop', 'pingpong', 'once'];
export const DEFAULT_PATH_SPEED = 64;

const wrap360 = value => ((value % 360) + 360) % 360;

/**
 * Which way a follower faces after a step.
 *
 * The same rule the timeline uses (`tweenAngle` in `shared/timesheet.js`). A sprite is turned onto
 * the route, because Doom's 0° is east and its frames are drawn for that. A model with a declared
 * facing is turned onto the route too, but by the angle that puts its **nose** there: the mesh is
 * drawn at `angle`, the file's own forward is `facing` degrees from east, so `heading - facing` is
 * the angle whose nose lands on the path. Without a facing an imported model keeps the pose its
 * author gave it and is only turned by however much the route bends, and `yawOffset` is added on top
 * of either.
 */
export function facingAngle(entity, motion, heading, yawOffset, useModelFacing = true) {
  const declared = useModelFacing !== false
    && entity?.modelFacing !== undefined && Number.isFinite(Number(entity.modelFacing));
  const route = declared ? heading - Number(entity.modelFacing)
    : entity?.modelAsset
      ? (Number(motion.authoredAngle) || 0) + (heading - (motion.startHeading ?? heading))
      : heading;
  return wrap360(route + (Number(yawOffset) || 0));
}

/** The settings an object needs to follow a route, with the defaults filled in. */
export function pathFollowSettings(path = {}) {
  return {
    id: path.id,
    speed: Number.isFinite(Number(path.speed)) ? Number(path.speed) : DEFAULT_PATH_SPEED,
    mode: PATH_MODES.includes(path.mode) ? path.mode : 'loop',
    // The whole point of following a path is usually that the model faces the way it is going.
    faceDirection: path.faceDirection !== false,
    // Imported models do not agree on which way is "forward": a GLB authored facing +z reads as
    // sideways next to one authored facing +x. The offset turns the model on top of the route's
    // direction so either can be used without re-exporting it.
    yawOffset: Number.isFinite(Number(path.yawOffset)) ? Number(path.yawOffset) : 0,
    // A declared facing can be honoured (the nose is the object's angle, exact) or ignored so the
    // model keeps the pose it was given and only turns by how much the route bends.
    useModelFacing: path.useModelFacing !== false,
    startAt: Math.min(1, Math.max(0, Number(path.startAt) || 0)),
  };
}

/**
 * How far along the route a follower is for a given travelled distance.
 *
 * One function for the three modes, because they are all the same arithmetic on the distance:
 * a loop wraps (`d mod L`), a ping-pong reflects over a doubled length (so it runs back without
 * the follower having to remember a direction), and `once` clamps.
 */
export function pathDistance(distance, length, mode = 'loop') {
  if (!(length > 0)) return 0;
  if (mode === 'once') return Math.min(length, Math.max(0, distance));
  if (mode === 'pingpong') {
    const period = length * 2;
    const wrapped = ((distance % period) + period) % period;
    return wrapped <= length ? wrapped : period - wrapped;
  }
  return ((distance % length) + length) % length;
}

/**
 * A cache of sampled paths, so a level with several followers samples each route once per frame.
 *
 * Sampling is 12 points per segment; doing that per follower per frame is wasted work on a long
 * route, and worse, it would let two followers of the same path disagree about its length.
 */
export function pathSampler() {
  const cache = new Map();
  return function forPath(path) {
    const key = `${path.id}:` + path.points.map(point => `${point.x},${point.y},${point.z || 0},${point.curve ?? 1}`).join(';') +
      (path.closed ? ':closed' : '');
    let entry = cache.get(key);
    if (!entry) {
      const samples = samplePath(path);
      entry = { samples, lengths: sampleLengths(samples) };
      cache.set(key, entry);
    }
    return entry;
  };
}

/**
 * Where a follower stands and which way it faces after `distance` units of travel.
 *
 * Returns null for a path with fewer than two points: a route with one waypoint is a place, and
 * there is no direction to face.
 */
export function followPath(path, distance, { mode = 'loop', lengths = null, samples = null } = {}) {
  if (!path || (path.points?.length || 0) < 2) return null;
  const chain = samples || samplePath(path);
  const distances = lengths || sampleLengths(chain);
  const length = distances[distances.length - 1] || 0;
  if (!(length > 0)) return null;
  const travelled = pathDistance(distance, length, mode);
  const where = pointAlong(path, travelled / length, { samples: chain, lengths: distances });
  if (!where) return null;
  return { ...where, distance: travelled, length };
}

/**
 * Advances every follower in the level by `dt` seconds.
 *
 * The objects themselves hold the settings (`entity.path`); the travelled distance lives in the
 * runtime, because it is progress, not a property of the map. An object with no route, or with a
 * route that was deleted, is left exactly where it is rather than being teleported to the origin.
 */
export function advancePathMotion(project, state, dt) {
  const followers = (state.entities || []).filter(entity => entity.path?.id && entity.type !== 'player');
  if (!followers.length) return 0;
  const forPath = state.pathSampler || (state.pathSampler = pathSampler());
  const motions = state.pathMotions || (state.pathMotions = new Map());
  let moved = 0;
  for (const entity of followers) {
    const settings = pathFollowSettings(entity.path);
    const path = (project.paths || []).find(item => item.id === settings.id);
    const { samples, lengths } = path ? forPath(path) : { samples: null, lengths: null };
    const length = lengths ? lengths[lengths.length - 1] || 0 : 0;
    if (!path || !(length > 0)) continue;
    let motion = motions.get(entity.id);
    // Where a follower starts is authored as a fraction of the route, so a second model can be
    // told to set off from the far side of a loop instead of on top of the first.
    if (!motion) {
      motion = { distance: settings.startAt * length, authoredAngle: Number(entity.angle) || 0, startHeading: null };
      motions.set(entity.id, motion);
    }
    motion.distance += Math.max(0, settings.speed) * dt;
    const where = followPath(path, motion.distance, { mode: settings.mode, samples, lengths });
    if (!where) continue;
    entity.x = where.x;
    entity.y = where.y;
    // The curve's own height is the model's height: a route that climbs a staircase carries the
    // model up it, and keeping a separate elevation would let the two drift apart.
    entity.z = where.z || 0;
    if (motion.startHeading === null || motion.startHeading === undefined) motion.startHeading = where.angle;
    if (settings.faceDirection) entity.angle = facingAngle(entity, motion, where.angle, settings.yawOffset, settings.useModelFacing);
    moved++;
  }
  return moved;
}
