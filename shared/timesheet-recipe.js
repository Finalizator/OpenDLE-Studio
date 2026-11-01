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

/** Units per second a follower walks when it has no speed of its own. */
export const DEFAULT_PATH_SPEED = 96;

/**
 * @returns {{ sheet: object, event: object, seconds: number }} the timeline, the rule that starts
 *   it on layout start, and how long the trip takes.
 */
export function driveRouteTimesheet({ entity, path, nextId }) {
  if (!entity?.id) throw new Error('Pick an object to drive the route');
  if (!path?.id) throw new Error('Pick a path for this object first');
  if ((path.points || []).length < 2) throw new Error('That route needs at least two waypoints');
  const speed = Math.max(1, Number(entity.path?.speed) || DEFAULT_PATH_SPEED);
  const seconds = Math.min(3600, Math.max(1, Math.round(pathLength(path) / speed * 10) / 10));
  const sheet = createTimesheet({ id: nextId('timesheet'), name: `${entity.name} drives ${path.name}` });
  sheet.duration = Math.min(3600, Math.max(10, Math.ceil(seconds / 5) * 5));
  sheet.cues = [{
    ...createCue({ id: nextId('cue'), name: 'Drive', trackId: sheet.tracks[0].id, time: 0, ownerId: entity.id }),
    actions: [{
      type: 'followPath', entityId: entity.id, pathId: path.id,
      fromPoint: 0, toPoint: -1, seconds, easing: 'linear', faceDirection: 'yes',
    }],
  }];
  const event = {
    id: nextId('start_timeline'), name: `Start "${sheet.name}"`, enabled: true, once: true,
    condition: { type: 'onStart' }, conditions: [],
    actions: [{ type: 'startTimesheet', timesheetId: sheet.id, restart: 'yes', loop: 'same' }],
  };
  return { sheet, event, seconds };
}
