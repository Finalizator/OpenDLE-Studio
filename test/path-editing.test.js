import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { createPath, createPathPoint, pathReferences, removePath, removePathPoint, routesForEntity } from '../shared/paths.js';
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
  assert.deepEqual(pathReferences(project, 'other'), { followers: [], ramps: [], actions: [] });
});

// A truck driven by a timeline used to look as if it followed nothing: the inspector only ever
// looked at the object's own `path` setting, so the "line this model up with its route" button was
// offered for objects the route had never been pointed at, and missing for the ones it had.
test('every way an object is driven along a route is reported, with where it was decided', () => {
  const { project, walker } = projectWithRoute();
  // The object's own setting is gone, so the timeline is the only thing that drives it.
  delete walker.path;
  assert.deepEqual(routesForEntity(project, walker.id).map(entry => [entry.path.id, entry.source]),
    [['route', 'event']], 'the event action that moves the object still counts once its own path is gone');
  // With the event gone the timeline is the only thing left that drives it, and the entry says so.
  project.events = [];
  assert.deepEqual(routesForEntity(project, walker.id).map(entry => [entry.path.id, entry.source]),
    [['route', 'timesheet:timeline']], 'a cue names the route it drives the object along, and which timeline it is in');
  // With its own setting back the object answers first, and the route is reported once either way.
  walker.path = { id: 'route', speed: 64 };
  assert.deepEqual(routesForEntity(project, walker.id).map(entry => [entry.path.id, entry.source]), [['route', 'object']]);
  assert.deepEqual(routesForEntity(project, 'nobody'), [], 'an object nothing drives has no route');
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
  assert.match(app, /if \(value\?\.kind === 'path'\) \{ deleteSelectedPaths\(value\.id\); return; \}/);
  assert.match(app, /if \(value\?\.kind === 'pathPoint'\) \{ deletePathPoint\(value\.pathId, value\.id\); return; \}/);
  assert.match(app, /if \(\!\['entity', 'path', 'pathPoint'\]\.includes\(selection\?\.kind\)\) return;/);
  // The 3D view hands over the whole selection, never a bare id: a handler that expected an id
  // string looked up an object called "[object Object]" and refused to delete anything.
  assert.match(memo('scene-editor.js'), /callbacks\.remove\(\{ \.\.\.selected \}\);/);
  assert.match(app, /remove: value => \{/);
  // Pressing a member of the set keeps the set: a press that collapsed it made "start dragging a
  // multi-selection" mean "drag the object under the pointer".
  assert.match(app, /if \(\!additive && keepSet && multiSelection\.length > 1 && multiSelection\.includes\(entity\.id\)\) \{/);
  assert.match(app, /if \(entity && multiSelection\.length > 1 && multiSelection\.includes\(entity\.id\)\) \{/);
  assert.match(app, /selectObject\(entity, false, \{ keepSet: true \}\);/);
  assert.match(app, /if \(pressed\?\.kind === 'entity' && multiSelection\.length > 1 && multiSelection\.includes\(pressed\.id\)\) \{/);
  // Routes are a set of their own: Ctrl+click adds one, the arrows move them all, Delete removes
  // every one of them, and a set is one kind (objects or routes) because the actions differ.
  assert.match(app, /let multiSelectionKind = null;/);
  assert.match(app, /function selectedPathIds\(\) \{/);
  assert.match(app, /function selectPath\(pathId, additive = false,/);
  assert.match(app, /at = \.5, keepSet = false \}/);
  assert.match(app, /function deleteSelectedPaths\(primaryId\) \{/);
  assert.match(app, /if \(value\?\.kind === 'path' && options\.additive\) \{/);
  assert.match(app, /if \(hit\?\.kind === 'pathPoint'\) \{/);
  assert.match(app, /const target = typeof value === 'string' \? \{ kind: 'entity', id: value \} : value;/);
  // The route inspector offers the way out of the mode and the way back into it.
  assert.match(app, /button\('Finish path — stop adding waypoints', \(\) => finishPath\(\), 'primary'\)/);
  assert.match(app, /button\('Continue adding waypoints', \(\) => \{/);
  assert.match(app, /activePathId = path\.id;\s*\$\('tool'\)\.value = 'path';/);
});

// A route action picks waypoints by name in the editor, but stores the index — so a name has to
// survive the route changing, and the stored value has to stay a number the validator accepts.
test('a named waypoint keeps its name when the route loses a point before it', () => {
  const project = createProject();
  project.paths = [createPath({ id: 'route', name: 'Route', points: [
    createPathPoint({ id: 'a', x: 0, y: 0 }), createPathPoint({ id: 'b', x: 64, y: 0 }),
    createPathPoint({ id: 'c', x: 128, y: 0, name: 'Depot' }), createPathPoint({ id: 'd', x: 192, y: 0 }),
  ] })];
  project.events = [{ id: 'go', enabled: true, once: false, condition: { type: 'always' },
    actions: [{ type: 'followPath', entityId: '$self', pathId: 'route', fromPoint: 0, toPoint: 2, seconds: 2, easing: 'linear', faceDirection: 'yes' }] }];
  project.events[0].actions[0].entityId = 'pickup';
  validateProject(project);
  removePathPoint(project, 'route', 'b');
  assert.equal(project.paths[0].points[1].name, 'Depot', 'the name travels with its waypoint');
  assert.equal(project.events[0].actions[0].toPoint, 1, 'the action follows the shortened route');
  validateProject(project);
});

test('a waypoint name is validated like any other text, and an index stays an index', () => {
  const project = createProject();
  project.paths = [createPath({ id: 'route', name: 'Route', points: [
    createPathPoint({ id: 'a', x: 0, y: 0 }), createPathPoint({ id: 'b', x: 64, y: 0 }) ] })];
  project.events = [{ id: 'go', enabled: true, once: false, condition: { type: 'always' },
    actions: [{ type: 'followPath', entityId: 'pickup', pathId: 'route', fromPoint: 0, toPoint: -1, seconds: 2, easing: 'linear', faceDirection: 'yes' }] }];
  validateProject(project);
  project.paths[0].points[1].name = 'x'.repeat(101);
  assert.throws(() => validateProject(project), /Path point name/);
  project.paths[0].points[1].name = 'Gate';
  validateProject(project);
  // A waypoint field submitted as the text of a select instead of a number would point nowhere.
  project.events[0].actions[0].fromPoint = '0';
  assert.throws(() => validateProject(project), /fromPoint must be a waypoint/);
  project.events[0].actions[0].fromPoint = 0;
  project.events[0].actions[0].toPoint = 9;
  assert.throws(() => validateProject(project), /outside the route/);
  project.events[0].actions[0].toPoint = -1;
  validateProject(project);
});
