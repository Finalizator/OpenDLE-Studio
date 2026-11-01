import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { createPath, createPathPoint, pathReferences, removePath, removePathPoint } from '../shared/paths.js';
import { createTrack, createTimesheet, createCue } from '../shared/timesheet.js';

// A route is layout data, so deleting one cannot simply splice it out: whatever walked it and any
// action that moved something along it still names it, and a project that names a missing path
// does not validate. These are the rules the editor's Delete path and Delete waypoint rely on.
const memo = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

const route = () => createPath({ id: 'route', name: 'Patrol', points: [
  createPathPoint({ id: 'a', x: 0, y: 0 }), createPathPoint({ id: 'b', x: 128, y: 0 }), createPathPoint({ id: 'c', x: 256, y: 0 }),
] });

/** A project with one route, one object walking it, an event action and a cue action using it. */
function projectWithRoute() {
  const project = createProject();
  const walker = project.map.entities.find(entity => entity.type !== 'player');
  project.events = [{
    id: 'go', enabled: true, once: false, ownerId: walker.id, condition: { type: 'onStart' },
    actions: [{ type: 'followPath', entityId: '$self', pathId: 'route', fromPoint: 0, toPoint: 2, seconds: 2, easing: 'linear', faceDirection: 'yes' }],
  }];
  project.paths = [route()];
  walker.path = { id: 'route', speed: 64, mode: 'loop', start: 0 };
  const sheet = createTimesheet({ id: 'timeline', name: 'Timeline' });
  // A cue action targets the cue's own object, which is what `ownerId` on a cue is for.
  sheet.cues = [{ ...createCue({ id: 'cue', name: 'Walk', trackId: sheet.tracks[0].id, time: 1, ownerId: walker.id }),
    actions: [{ type: 'followPath', entityId: '$self', pathId: 'route', fromPoint: 0, toPoint: 1, seconds: 1, easing: 'linear', faceDirection: 'no' }] }];
  project.timesheets = [sheet];
  validateProject(project);
  return { project, walker };
}

test('a route reports every object and action that names it', () => {
  const { project, walker } = projectWithRoute();
  const { followers, actions } = pathReferences(project, 'route');
  assert.deepEqual(followers.map(entity => entity.id), [walker.id]);
  assert.equal(actions.length, 2, 'the event action and the timeline cue both count');
  assert.deepEqual(pathReferences(project, 'other'), { followers: [], actions: [] });
});

test('deleting a route releases its followers and drops the actions that used it', () => {
  const { project, walker } = projectWithRoute();
  const result = removePath(project, 'route');
  assert.equal(project.paths.length, 0);
  assert.equal(walker.path, undefined, 'the walker stopped following a route that is gone');
  assert.deepEqual(project.events[0].actions, [], 'the event action is gone with the route');
  assert.deepEqual(project.timesheets[0].cues[0].actions, [], 'and so is the cue action');
  assert.deepEqual({ followers: result.followers, actions: result.actions }, { followers: 1, actions: 2 }, 'the editor can say what the delete took with it');
  // The point of clearing them: the project still validates, so the delete is not rolled back.
  validateProject(project);
});

test('deleting a route leaves other actions and other routes alone', () => {
  const { project } = projectWithRoute();
  project.paths.push(createPath({ id: 'second', name: 'Second', points: [createPathPoint({ id: 'd' }), createPathPoint({ id: 'e', x: 64 })] }));
  project.events.push({
    id: 'say', enabled: true, once: false, ownerId: project.map.entities.find(entity => entity.type !== 'player').id, condition: { type: 'onStart' },
    actions: [{ type: 'showMessage', message: 'still here' },
      { type: 'followPath', entityId: '$self', pathId: 'second', fromPoint: 0, toPoint: 1, seconds: 1, easing: 'linear', faceDirection: 'yes' }],
  });
  removePath(project, 'route');
  assert.equal(project.paths.length, 1);
  assert.equal(project.paths[0].id, 'second');
  assert.equal(project.events[0].actions.length, 0);
  assert.equal(project.events[1].actions.length, 2, 'unrelated rules keep every action');
  validateProject(project);
});

test('a route that is already gone is not an error, it is nothing to do', () => {
  const { project } = projectWithRoute();
  assert.equal(removePath(project, 'ghost'), null);
  assert.equal(project.paths.length, 1, 'and the real route is untouched');
});

test('a waypoint can be deleted while the route keeps two of them', () => {
  const { project } = projectWithRoute();
  // Both actions name waypoint 2, which stops existing when the route drops to two points.
  project.timesheets[0].cues[0].actions[0].toPoint = -1;
  const result = removePathPoint(project, 'route', 'b');
  assert.deepEqual(project.paths[0].points.map(point => point.id), ['a', 'c']);
  assert.equal(result.remaining, 2);
  assert.equal(project.events[0].actions[0].toPoint, 1, 'an index past the new end is brought back inside the route');
  assert.equal(project.timesheets[0].cues[0].actions[0].toPoint, -1, '-1 still means the last waypoint, whatever the route is');
  validateProject(project);
});

test('the last two waypoints cannot be deleted, because one point is not a route', () => {
  const { project } = projectWithRoute();
  removePathPoint(project, 'route', 'b');
  assert.throws(() => removePathPoint(project, 'route', 'a'), /at least two waypoints/);
  assert.throws(() => removePathPoint(project, 'route', 'nope'), /no longer exists/);
  assert.throws(() => removePathPoint(project, 'ghost', 'a'), /no longer exists/);
  assert.deepEqual(project.paths[0].points.map(point => point.id), ['a', 'c'], 'a refused delete changes nothing');
});

test('the editor deletes whatever is selected, and says how to leave Draw path', () => {
  const app = memo('app.js');
  // Delete means the selected thing, wherever the selection came from: the map or the 3D view.
  assert.match(app, /function deleteSelectionObject\(value\) \{/);
  assert.match(app, /if \(value\?\.kind === 'path'\) \{ deletePath\(value\.id\); return; \}/);
  assert.match(app, /if \(value\?\.kind === 'pathPoint'\) \{ deletePathPoint\(value\.pathId, value\.id\); return; \}/);
  assert.match(app, /if \(\!\['entity', 'path', 'pathPoint'\]\.includes\(selection\?\.kind\)\) return;/);
  // The route inspector offers the way out of the mode and the way back into it.
  assert.match(app, /button\('Finish path — stop adding waypoints', \(\) => finishPath\(\), 'primary'\)/);
  assert.match(app, /button\('Continue adding waypoints', \(\) => \{/);
  assert.match(app, /activePathId = path\.id;\s*\$\('tool'\)\.value = 'path';/);
});
