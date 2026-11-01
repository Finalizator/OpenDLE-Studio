/**
 * The "drive this route on a timesheet, start to end" recipe.
 *
 * Driving a model along a route takes three parts that have to agree: a timeline, a cue at zero
 * carrying a path action, and the event that starts the timeline — a timeline on its own never
 * plays. Building them together here keeps the editor button thin and lets the tests check the
 * parts against `validateProject` instead of trusting the button.
 *
 * The duration comes from the object's own path speed, so a slow truck and a fast truck driving
 * the same route both take the time they should.
 */

import { pathLength } from './paths.js';
import { createTimesheet, createCue } from './timesheet.js';
import { followPath } from './path-motion.js';
import { hasModelFacing } from './entity-visuals.js';

/** Units per second a follower walks when it has no speed of its own. */
export const DEFAULT_PATH_SPEED = 96;

const wrap360 = value => ((value % 360) + 360) % 360;

/**
 * Points a model's declared facing at its route without changing how the model looks.
 *
 * The engine draws a model at its `angle`, so the artwork's own forward is something only the
 * author knows. Once the model has been turned until it looks right next to the route, the
 * difference between the route's heading and the model's angle *is* that unknown forward — so
 * declaring it as `modelFacing` and putting the angle on the route leaves the model exactly where
 * it already looked, and makes the angle mean "where the nose points". A route then turns the
 * model exactly, instead of dragging a pose that was authored off-axis sideways.
 *
 * Returns null when the route has no direction to face (fewer than two waypoints).
 */
export function alignModelToRoute(entity, path) {
  const heading = followPath(path, 0)?.angle;
  if (!entity?.id || !Number.isFinite(heading)) return null;
  // A tenth of a degree is finer than anyone can see in the editor and keeps the numbers the
  // author is handed readable, instead of the eighteen digits a heading can carry.
  const tenth = value => Math.round(value * 10) / 10;
  const angle = wrap360(Number(entity.angle) || 0);
  const offset = wrap360(heading - angle);
  return { facing: tenth(offset > 180 ? offset - 360 : offset), angle: tenth(heading), heading: tenth(heading),
    was: tenth(Number(entity.angle) || 0) };
}

/**
 * @returns {{ sheet: object, event: object, seconds: number, alignment: object|null }} the timeline,
 *   the rule that starts it on layout start, how long the trip takes, and the facing/angle change
 *   that has to be applied to the object for the drive to match how it looks.
 */
export function driveRouteTimesheet({ entity, path, nextId, alignToRoute = false }) {
  if (!entity?.id) throw new Error('Pick an object to drive the route');
  if (!path?.id) throw new Error('Pick a path for this object first');
  if ((path.points || []).length < 2) throw new Error('That route needs at least two waypoints');
  const speed = Math.max(1, Number(entity.path?.speed) || DEFAULT_PATH_SPEED);
  const seconds = Math.min(3600, Math.max(1, Math.round(pathLength(path) / speed * 10) / 10));
  // An imported model whose forward is off-axis is turned onto the route by declaring that
  // forward, so the drive is what the editor shows. A model that already declares its facing is
  // left alone: its angle is already the nose's direction, and its pose was trusted.
  const alignment = alignToRoute && entity.modelAsset && !hasModelFacing(entity)
    ? alignModelToRoute(entity, path) : null;
  // A facing offset the author set on the object's own route following survives the hand-over: it
  // is the correction that makes an imported model's forward axis line up with its route. Once the
  // facing is declared that correction is exact, so carrying the offset as well would over-turn it.
  const yawOffset = alignment ? 0 : Number(entity.path?.yawOffset) || 0;
  const sheet = createTimesheet({ id: nextId('timesheet'), name: `${entity.name} drives ${path.name}` });
  sheet.duration = Math.min(3600, Math.max(10, Math.ceil(seconds / 5) * 5));
  sheet.cues = [{
    ...createCue({ id: nextId('cue'), name: 'Drive', trackId: sheet.tracks[0].id, time: 0, ownerId: entity.id }),
    actions: [{
      type: 'followPath', entityId: entity.id, pathId: path.id,
      fromPoint: 0, toPoint: -1, seconds, easing: 'linear', faceDirection: 'yes', yawOffset,
    }],
  }];
  const event = {
    id: nextId('start_timeline'), name: `Start "${sheet.name}"`, enabled: true, once: true,
    condition: { type: 'onStart' }, conditions: [],
    actions: [{ type: 'startTimesheet', timesheetId: sheet.id, restart: 'yes', loop: 'same' }],
  };
  return { sheet, event, seconds, yawOffset, alignment };
}