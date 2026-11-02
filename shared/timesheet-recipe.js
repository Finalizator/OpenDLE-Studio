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
 * Declares which way a model's artwork points, and poses it so its nose runs along its route.
 *
 * Which way the artwork's own forward points is a number only the file knows — and a guessed one
 * leaves the body skewed by the guess. When the model can be measured (`forward`, from
 * `modelForwardAngle`) that measurement is used, so the body ends up exactly along the route; a
 * truck whose body runs along Z is 90°, not the 80° someone reading it off the screen typed.
 *
 * Two numbers come out of it, and they mean different things. `facing` is a property of the file and
 * is what a route reads to turn the nose onto the path. `angle` is where the object is: the mesh is
 * drawn at `angle`, so the pose that shows the body along the route is `heading - facing`. Declaring
 * a facing on its own never moves the model; posing it is this function's second half, and the button
 * calls it so the two agree.
 *
 * The two hemispheres cannot be told apart from a bounding box, so the one nearest what the object
 * already says wins: a declared facing, or else the nose the author's pose implies (the model was
 * lined up next to its route by eye, so the route's heading minus its angle *is* the file's
 * forward). Only the residual skew is taken out, and an end chosen by eye is kept.
 *
 * Returns null when the route has no direction to face (fewer than two waypoints).
 */
export function alignModelToRoute(entity, path, { forward = null } = {}) {
  const heading = followPath(path, 0)?.angle;
  if (!entity?.id || !Number.isFinite(heading)) return null;
  // A tenth of a degree is finer than anyone can see in the editor and keeps the numbers the
  // author is handed readable, instead of the eighteen digits a heading can carry.
  const tenth = value => Math.round(value * 10) / 10;
  const angle = wrap360(Number(entity.angle) || 0);
  const measured = Number.isFinite(forward) ? wrap360(forward) : null;
  let facing;
  if (measured !== null) {
    // Which end is the nose is the one thing a bounding box cannot say, so the author's own answer
    // decides: a declared facing if there is one, and otherwise the forward their pose implies —
    // the pose that looked right next to the route *is* a statement about which end leads. Taking
    // 0 as the reference instead (there is no facing yet, which is the case this button exists for)
    // threw that away and could turn a carefully posed model 180°.
    const current = entity.modelFacing !== undefined && Number.isFinite(Number(entity.modelFacing))
      ? wrap360(Number(entity.modelFacing))
      : wrap360(heading - angle);
    const offset = value => Math.abs(((wrap360(value) - current + 540) % 360) - 180);
    facing = offset(measured) <= offset(measured + 180) ? measured : measured + 180;
    facing = tenth(facing > 180 ? facing - 360 : facing);
  } else {
    const offset = wrap360(heading - angle);
    facing = tenth(offset > 180 ? offset - 360 : offset);
  }
  // The mesh is drawn at the angle it is stored with, so the pose that puts the nose on the route is
  // the heading less what the file is turned by; the facing alone never moves it.
  return { facing, angle: tenth(wrap360(heading - facing)), heading: tenth(heading), was: tenth(Number(entity.angle) || 0),
    measured: measured !== null };
}

/**
 * @returns {{ sheet: object, event: object, seconds: number, alignment: object|null }} the timeline,
 *   the rule that starts it on layout start, how long the trip takes, and the facing/angle change
 *   that has to be applied to the object for the drive to match how it looks.
 */
export function driveRouteTimesheet({ entity, path, nextId, alignToRoute = false, forward = null }) {
  if (!entity?.id) throw new Error('Pick an object to drive the route');
  if (!path?.id) throw new Error('Pick a path for this object first');
  if ((path.points || []).length < 2) throw new Error('That route needs at least two waypoints');
  const speed = Math.max(1, Number(entity.path?.speed) || DEFAULT_PATH_SPEED);
  const seconds = Math.min(3600, Math.max(1, Math.round(pathLength(path) / speed * 10) / 10));
  // An imported model whose forward is off-axis is turned onto the route by declaring that
  // forward, so the drive is what the editor shows. A model that already declares its facing is
  // left alone: its angle is already the nose's direction, and its pose was trusted.
  const alignment = alignToRoute && entity.modelAsset && !hasModelFacing(entity)
    ? alignModelToRoute(entity, path, { forward }) : null;
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
      useModelFacing: 'yes',
    }],
  }];
  const event = {
    id: nextId('start_timeline'), name: `Start "${sheet.name}"`, enabled: true, once: true,
    condition: { type: 'onStart' }, conditions: [],
    actions: [{ type: 'startTimesheet', timesheetId: sheet.id, restart: 'yes', loop: 'same' }],
  };
  return { sheet, event, seconds, yawOffset, alignment };
}