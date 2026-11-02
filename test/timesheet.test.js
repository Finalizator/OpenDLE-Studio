import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import {
  createTrack, createTimesheet, createCue, validateTimesheet, cuesBetween, advanceTimesheets,
  removeTimesheet, timesheetReferences,
  startTimesheetRun, stopTimesheetRun, setTimesheetPaused, timesheetCueEvents, timesheetSignature,
  easingValue, startPathTween, advancePathTweens, TIMESHEET_CUE_CONDITION,
} from '../shared/timesheet.js';
import { waypointDistances } from '../shared/paths.js';
import { readFileSync } from 'node:fs';

const tick = (project, state, seconds = .05) => stepRuntime(project, state, seconds, new Set());
const cues = () => [
  { id: 'setup', name: 'Setup', trackId: 'track_1', time: 0, ownerId: null, actions: [{ type: 'setVariable', variable: 'score', value: 5 }] },
  { id: 'beat', name: 'Beat', trackId: 'track_1', time: 2, ownerId: null, actions: [{ type: 'addVariable', variable: 'score', value: 10 }] },
];
function withTimeline(overrides = {}) {
  const project = createProject();
  project.events = [];
  project.timesheets = [{ id: 'timeline', name: 'Intro', duration: 4, loop: false, tracks: [createTrack(0)],
    cues: cues(), ...overrides }];
  validateProject(project);
  return { project, state: createRuntime(project) };
}

test('a timesheet validates its clock, tracks and cues', () => {
  const project = createProject();
  const base = { id: 'ts', name: 'Intro', duration: 10, loop: false, tracks: [createTrack(0)], cues: [] };
  validateTimesheet(base, project);
  assert.throws(() => validateTimesheet({ ...base, duration: 0 }, project), /duration/);
  assert.throws(() => validateTimesheet({ ...base, duration: 5000 }, project), /duration/);
  assert.throws(() => validateTimesheet({ ...base, name: '' }, project), /name/);
  assert.throws(() => validateTimesheet({ ...base, tracks: [] }, project), /tracks/);
  assert.throws(() => validateTimesheet({ ...base, cues: [{ id: 'a', name: 'A', trackId: 'nope', time: 1, actions: [] }] }, project), /track/);
  assert.throws(() => validateTimesheet({ ...base, cues: [{ id: 'a', name: 'A', trackId: 'track_1', time: 11, actions: [] }] }, project), /between 0 and 10/);
  assert.throws(() => validateTimesheet({ ...base, cues: [{ id: 'a', name: 'A', trackId: 'track_1', time: 1, ownerId: 'ghost', actions: [] }] }, project), /does not exist/);
  assert.throws(() => validateTimesheet({ ...base, cues: [{ id: 'a', name: 'A', trackId: 'track_1', time: 1 }] }, project), /action list/);
  // A cue that targets a real object is fine.
  validateTimesheet({ ...base, cues: [{ id: 'a', name: 'A', trackId: 'track_1', time: 1, ownerId: 'pickup', actions: [] }] }, project);
});

test('each cue becomes one ordinary rule that asks the clock', () => {
  const sheet = createTimesheet({ id: 'ts', name: 'Sheet' });
  sheet.cues = cues();
  const events = timesheetCueEvents([sheet]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].condition, { type: TIMESHEET_CUE_CONDITION, timesheetId: 'ts', cueId: 'setup' });
  assert.match(events[0].id, /^[a-zA-Z0-9_-]+$/, 'the generated rule id is a legal event id');
  assert.equal(events[1].actions[0].type, 'addVariable');
  // The rule id is namespaced, so it can never collide with a hand-written one.
  assert.equal(events[0].id, 'timesheet_ts__setup');
  assert.notEqual(timesheetSignature([sheet]), timesheetSignature([{ ...sheet, cues: [{ ...sheet.cues[0], time: 1 }] }]));
});

test('cues fire once as the clock crosses them, and a cue at zero fires on start', () => {
  const { project, state } = withTimeline();
  assert.equal(state.variables.score, 0);
  startTimesheetRun(project, state, 'timeline');
  tick(project, state);
  assert.equal(state.variables.score, 5, 'the cue at 0 runs on the first frame');
  for (let i = 0; i < 38; i++) tick(project, state);
  assert.equal(state.variables.score, 5, 'nothing fires again before the next cue');
  for (let i = 0; i < 3; i++) tick(project, state);
  assert.equal(state.variables.score, 15, 'the cue at 2 s fires once');
  for (let i = 0; i < 80; i++) tick(project, state);
  assert.equal(state.variables.score, 15, 'and never again');
  assert.equal(state.timesheets.get('timeline').playing, false, 'a one-shot timeline stops at its duration');
  assert.equal(state.timesheets.get('timeline').time, 4);
});

test('a looper repeats, and pause holds the clock where it was', () => {
  const { project, state } = withTimeline({ loop: true, duration: 2, cues: [cues()[1]] });
  startTimesheetRun(project, state, 'timeline');
  for (let i = 0; i < 45; i++) tick(project, state);
  assert.equal(state.variables.score, 10, 'the cue fires on the first pass');
  for (let i = 0; i < 40; i++) tick(project, state);
  assert.equal(state.variables.score, 20, 'and again on the next pass');
  setTimesheetPaused(state, 'timeline', true);
  const held = state.timesheets.get('timeline').time;
  for (let i = 0; i < 20; i++) tick(project, state);
  assert.equal(state.timesheets.get('timeline').time, held, 'a paused timeline does not advance');
  setTimesheetPaused(state, 'timeline', false);
  for (let i = 0; i < 20; i++) tick(project, state);
  assert.notEqual(state.timesheets.get('timeline').time, held, 'and resumes where it stopped');
  stopTimesheetRun(state, 'timeline');
  assert.equal(state.timesheets.has('timeline'), false);
});

test('an event starts a timesheet; nothing runs until it does', () => {
  const { project, state } = withTimeline();
  project.events = [{ id: 'go', enabled: true, once: false, condition: { type: 'onStart' },
    actions: [{ type: 'startTimesheet', timesheetId: 'timeline', restart: 'yes', loop: 'same' }] }];
  validateProject(project);
  // Nothing plays before the rule that starts it.
  assert.equal(state.timesheets.size, 0);
  tick(project, state);
  assert.equal(state.timesheets.get('timeline')?.playing, true, 'the event started the timeline');
  tick(project, state);
  assert.equal(state.variables.score, 5, 'and the timeline ran its first cue');
  // A second rule can stop it again; `onStart` is a trigger, so the stopper uses `always`.
  project.events.push({ id: 'halt', enabled: true, once: true, condition: { type: 'always' },
    actions: [{ type: 'stopTimesheet', timesheetId: 'timeline', all: 'no' }] });
  validateProject(project);
  tick(project, state);
  assert.equal(state.timesheets.has('timeline'), false);
});

test('a timeline keeps its clock through a save', async () => {
  const { captureGameSave, restoreGameSave, gameSaveIdentity } = await import('../shared/save-game.js');
  const { project, state } = withTimeline({ duration: 30 });
  const identity = await gameSaveIdentity(project);
  startTimesheetRun(project, state, 'timeline');
  for (let i = 0; i < 30; i++) tick(project, state);
  const before = state.timesheets.get('timeline').time;
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, identity)));
  const restored = restoreGameSave(project, record, identity).runtime;
  assert.ok(Math.abs(restored.timesheets.get('timeline').time - before) < 1e-9);
  assert.equal(restored.timesheets.get('timeline').playing, true);
});

test('a cue moves an object along its route between two waypoints', () => {
  const project = createProject();
  project.events = [];
  project.paths = [{ id: 'route', name: 'Route', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 1000, y: 0, z: 0, curve: 0 }, { id: 'p2', x: 2000, y: 0, z: 0, curve: 0 },
  ] }];
  project.timesheets = [{ id: 'walk', name: 'Walk', duration: 10, loop: false, tracks: [createTrack(0)], cues: [
    { id: 'go', name: 'Go', trackId: 'track_1', time: 0, ownerId: 'pickup', actions: [
      { type: 'followPath', entityId: '$self', pathId: 'route', fromPoint: 0, toPoint: 2, seconds: 2, easing: 'linear', faceDirection: 'yes' },
    ] },
  ] }];
  validateProject(project);
  const state = createRuntime(project);
  const waypoints = waypointDistances(project.paths[0]);
  assert.deepEqual(waypoints.distances.map(value => Math.round(value)), [0, 1000, 2000]);
  startTimesheetRun(project, state, 'walk');
  tick(project, state);                       // the cue starts the move
  assert.equal(state.pathTweens.length, 1);
  const startX = state.entities.find(entity => entity.id === 'pickup').x;
  for (let i = 0; i < 20; i++) tick(project, state);   // one second of two
  const middle = state.entities.find(entity => entity.id === 'pickup');
  assert.ok(Math.abs(middle.x - startX) > 100, 'the object is moving');
  assert.ok(Math.abs(middle.y) < 1, 'it stays on the route');
  for (let i = 0; i < 21; i++) tick(project, state);
  assert.equal(state.pathTweens.length, 0, 'the move ends and is forgotten');
  assert.ok(Math.abs(state.entities.find(entity => entity.id === 'pickup').x - startX - 2000) < 2, 'it moved the route\'s whole 2000 units from where it stood');
});

test('the easing curves start slow, end slow, or neither', () => {
  assert.equal(easingValue('linear', .5), .5);
  assert.ok(easingValue('easeIn', .5) < .5);
  assert.ok(easingValue('easeOut', .5) > .5);
  assert.equal(easingValue('easeInOut', .5), .5);
  for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut'])
    for (const t of [-1, 0, .25, 1, 2]) {
      const value = easingValue(name, t);
      assert.ok(value >= 0 && value <= 1, `${name}(${t}) stays in 0..1`);
    }
});

test('a cue plays an imported sound by asset, whatever format it was', () => {
  const project = createProject();
  project.events = [];
  project.assets = [{ id: 'sound_mp3', name: 'INTRO', kind: 'sound', src: 'data:audio/mpeg;base64,AAAA' }];
  project.timesheets = [{ id: 'audio', name: 'Audio', duration: 5, loop: false, tracks: [createTrack(0)], cues: [
    { id: 'hit', name: 'Hit', trackId: 'track_1', time: 0, ownerId: null, actions: [{ type: 'playAssetSound', assetId: 'sound_mp3', volume: .5 }] },
  ] }];
  validateProject(project);
  const state = createRuntime(project);
  startTimesheetRun(project, state, 'audio');
  tick(project, state);
  assert.deepEqual(state.sounds, [{ name: 'INTRO', volume: .5 }], 'the player resolves the asset by name');
  // A cue pointing at a sound that is not in the library is rejected, not silently ignored.
  project.timesheets[0].cues[0].actions[0].assetId = 'missing';
  assert.throws(() => validateProject(project), /unknown imported sound/);
});

test('cue detection splits a step that straddles the end of the loop', () => {
  const seen = new Set();
  const due = (from, to, cues) => cuesBetween(cues, from, to).map(cue => cue.id);
  const list = [{ id: 'a', time: 0 }, { id: 'b', time: 1 }, { id: 'c', time: 2 }];
  for (const id of due(0, 1.5, list)) seen.add(id);
  for (const id of due(1.5, 2, list)) seen.add(id);
  assert.deepEqual([...seen].sort(), ['b', 'c']);
  // A cue exactly on the boundary belongs to the step that ends there, not the next one.
  assert.deepEqual(due(.9, 1, list), ['b']);
  assert.deepEqual(due(1, 2, list), ['c']);
  // `advanceTimesheets` is the same arithmetic against a real run.
  const { project, state } = withTimeline({ loop: true, duration: 2 });
  startTimesheetRun(project, state, 'timeline');
  advanceTimesheets(project, state, 5.5);
  assert.equal(state.timesheets.get('timeline').time, 1.5);
});

// The editor's "drive this route on a timesheet" button builds three parts that have to agree;
// this checks them as data, which is what the button hands to `edit()`.
test('the drive-a-route recipe writes a timeline, a cue and the event that starts it', async () => {
  const { driveRouteTimesheet } = await import('../shared/timesheet-recipe.js');
  const project = createProject();
  project.events = [];
  project.paths = [{ id: 'lap', name: 'Lap', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 600, y: 0, z: 0, curve: 0 },
    { id: 'p2', x: 600, y: 600, z: 0, curve: 0 }, { id: 'p3', x: 0, y: 600, z: 0, curve: 0 },
  ] }];
  const entity = project.map.entities.find(item => item.id === 'pickup');
  entity.name = 'Truck';
  entity.path = { id: 'lap', speed: 200 };
  let sequence = 0;
  const { sheet, event, seconds } = driveRouteTimesheet({ entity, path: project.paths[0], nextId: name => `${name}_${++sequence}` });
  assert.equal(sheet.name, 'Truck drives Lap');
  assert.equal(seconds, 9, '1800 units at 200 a second');
  assert.equal(sheet.duration, 10);
  assert.equal(sheet.cues.length, 1);
  const [cue] = sheet.cues;
  assert.equal(cue.time, 0);
  assert.equal(cue.ownerId, entity.id, 'the cue names the object it drives');
  assert.deepEqual(cue.actions, [{
    type: 'followPath', entityId: entity.id, pathId: 'lap',
    fromPoint: 0, toPoint: -1, seconds: 9, easing: 'linear', faceDirection: 'yes', yawOffset: 0,
    useModelFacing: 'yes',
  }]);
  assert.equal(event.condition.type, 'onStart');
  assert.deepEqual(event.actions, [{ type: 'startTimesheet', timesheetId: sheet.id, restart: 'yes', loop: 'same' }]);
  // Spliced into a project the recipe validates, and running it moves the object the whole route.
  // The editor clears the object's own follow at the same time: a follower and a tween would both
  // place it every frame and fight over where it is.
  delete entity.path;
  project.timesheets = [sheet];
  project.events = [event];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state);
  const start = { x: state.entities.find(item => item.id === entity.id).x, y: state.entities.find(item => item.id === entity.id).y };
  for (let i = 0; i < 190; i++) tick(project, state);
  const end = state.entities.find(item => item.id === entity.id);
  // The route is a shape: the trip starts from where the object stands and ends one route away.
  assert.ok(Math.abs(end.x - start.x) < 2, 'back to the first waypoint\'s column');
  assert.ok(Math.abs(end.y - start.y - 600) < 2, 'one lap reached the last waypoint');
  assert.throws(() => driveRouteTimesheet({ entity, path: { id: 'x', name: 'X', points: [] }, nextId: () => 'z' }),
    /two waypoints/);
});

// A rule that starts a timeline names it, and a project that names a timeline it does not have is
// invalid — so deleting a timeline has to take those actions with it.
test('deleting a timeline releases the rules and cues that named it', () => {
  const project = createProject();
  project.timesheets = [
    { id: 'intro', name: 'Intro', duration: 5, loop: false, tracks: [createTrack(0)], cues: [
      { id: 'a', name: 'A', trackId: 'track_1', time: 0, ownerId: null,
        actions: [{ type: 'startTimesheet', timesheetId: 'outro', restart: 'yes', loop: 'same' }] }] },
    { id: 'outro', name: 'Outro', duration: 5, loop: false, tracks: [createTrack(0)], cues: [] },
  ];
  project.events = [
    { id: 'start', enabled: true, once: true, condition: { type: 'onStart' },
      actions: [{ type: 'startTimesheet', timesheetId: 'outro', restart: 'yes', loop: 'same' },
        { type: 'setVariable', variable: 'score', value: 1 }] },
    { id: 'halt', enabled: true, once: false, condition: { type: 'always' },
      actions: [{ type: 'stopTimesheet', timesheetId: 'outro', all: 'no' }, { type: 'stopTimesheet', all: 'yes' }] },
  ];
  validateProject(project);
  assert.equal(timesheetReferences(project, 'outro').actions.length, 3);
  const result = removeTimesheet(project, 'outro');
  assert.equal(result.actions, 3);
  assert.equal(result.rules, 0, 'both rules still say something else');
  assert.deepEqual(project.timesheets.map(sheet => sheet.id), ['intro']);
  assert.deepEqual(project.events[0].actions.map(action => action.type), ['setVariable'], 'the rest of the rule stays');
  assert.deepEqual(project.events[1].actions.map(action => action.all || action.timesheetId), ['yes'], 'stop all names no timeline');
  assert.deepEqual(project.timesheets[0].cues[0].actions, [], 'a cue that started it forgets it too');
  validateProject(project);
  assert.equal(removeTimesheet(project, 'outro'), null, 'deleting it twice is not an error');
});

// The accidental "start this timeline" rule used to survive its timeline, empty and unfindable:
// deleting the timeline now takes a rule whose only job was starting it.
test('deleting a timeline takes the rule that only started it', () => {
  const project = createProject();
  project.timesheets = [{ id: 'lap', name: 'Lap', duration: 5, loop: false, tracks: [createTrack(0)], cues: [] }];
  project.events = [
    { id: 'start_lap', enabled: true, once: true, condition: { type: 'onStart' },
      actions: [{ type: 'startTimesheet', timesheetId: 'lap', restart: 'yes', loop: 'same' }] },
    { id: 'parent', enabled: true, once: true, condition: { type: 'onStart' },
      actions: [{ type: 'startTimesheet', timesheetId: 'lap', restart: 'yes', loop: 'same' }] },
    { id: 'child', parentId: 'parent', enabled: true, once: false, condition: { type: 'always' }, actions: [] },
  ];
  validateProject(project);
  const result = removeTimesheet(project, 'lap');
  assert.equal(result.actions, 2);
  assert.equal(result.rules, 1, 'the rule that owns a sub-event stays, emptied');
  assert.deepEqual(project.events.map(event => event.id), ['parent', 'child']);
  assert.deepEqual(project.events[0].actions, [], 'its start action is gone');
  validateProject(project);
});

// A model's forward axis is whatever its file says, and the author poses it in the editor. Snapping
// it to the route heading made a pre-rotated truck drive sideways, which is what this pins.
test('a tweened model keeps the pose it was given and turns with the route', () => {
  const project = createProject();
  project.events = [];
  // A straight route east, then a leg north: a right-angle bend the model should follow.
  project.paths = [{ id: 'bend', name: 'Bend', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 1000, y: 0, z: 0, curve: 0 },
    { id: 'p2', x: 1000, y: 1000, z: 0, curve: 0 } ] }];
  const project2 = structuredClone(project);
  project2.timesheets = [{ id: 'drive', name: 'Drive', duration: 10, loop: false, tracks: [createTrack(0)], cues: [
    { id: 'go', name: 'Go', trackId: 'track_1', time: 0, ownerId: 'pickup', actions: [
      { type: 'followPath', entityId: '$self', pathId: 'bend', fromPoint: 0, toPoint: -1, seconds: 2, easing: 'linear', faceDirection: 'yes' },
    ] },
  ] }];
  validateProject(project2);
  const state = createRuntime(project2);
  const model = state.entities.find(entity => entity.id === 'pickup');
  model.modelAsset = 'asset_truck';
  model.angle = 300;   // posed by the author, 60° away from the route's heading of 0
  startTimesheetRun(project2, state, 'drive');
  // The cue fires on the first step and the move advances on the next one.
  tick(project2, state); tick(project2, state);
  const first = state.entities.find(entity => entity.id === 'pickup').angle;
  assert.ok(Math.abs(first - 300) < 1e-6, 'the pose is kept, not snapped to the route');
  for (let i = 0; i < 8; i++) tick(project2, state);            // half a second: still on the east leg
  assert.ok(Math.abs(state.entities.find(entity => entity.id === 'pickup').angle - 300) < 1e-6, 'still the authored pose');
  for (let i = 0; i < 33; i++) tick(project2, state);           // the leg north: the model turned 90°
  const turned = state.entities.find(entity => entity.id === 'pickup').angle;
  assert.ok(Math.abs(((turned - 300) % 360 + 360) % 360 - 90) < 5, `turned with the route, was ${turned}`);
});

// A trip is the route's shape plus the object's own displacement from it, and that displacement is
// taken from where the object was authored. Reading the live position instead made a looping
// timeline carry the object past its route's end for ever (100, 200, 300 …) and doubled the
// distance of a trip restarted halfway.
test('a repeated trip ends on the route, and objects keep their own displacement', () => {
  const project = createProject();
  project.events = [];
  project.paths = [{ id: 'road', name: 'Road', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 1000, y: 0, z: 0, curve: 0 } ] }];
  const actor = project.map.entities.find(entity => entity.id === 'pickup');
  // Two objects on one road, one of them 200 units off the route: both travel the same shape.
  const driver = { ...structuredClone(actor), id: 'driver', name: 'Driver', x: 0, y: 0 };
  const passenger = { ...structuredClone(actor), id: 'passenger', name: 'Passenger', x: 0, y: 200 };
  project.map.entities = [...project.map.entities.filter(entity => entity.id !== 'pickup'), driver, passenger];
  project.timesheets = [{ id: 'lap', name: 'Lap', duration: 2, loop: true, tracks: [createTrack(0)], cues: [
    { id: 'go', name: 'Go', trackId: 'track_1', time: 0, ownerId: null, actions: [
      { type: 'followPath', entityId: 'driver', pathId: 'road', fromPoint: 0, toPoint: -1, seconds: 2, easing: 'linear', faceDirection: 'no' },
      { type: 'followPath', entityId: 'passenger', pathId: 'road', fromPoint: 0, toPoint: -1, seconds: 2, easing: 'linear', faceDirection: 'no' },
    ] },
  ] }];
  validateProject(project);

  // The move itself, run twice by hand: the second trip must land where the first did.
  const once = createRuntime(project);
  startPathTween(once, { entityId: 'driver', pathId: 'road', seconds: 2 });
  for (let i = 0; i < 45; i++) advancePathTweens(project, once, .05);
  const firstEnd = once.entities.find(entity => entity.id === 'driver').x;
  assert.ok(Math.abs(firstEnd - 1000) < 1, `the first trip ends on the route, was ${firstEnd}`);
  startPathTween(once, { entityId: 'driver', pathId: 'road', seconds: 2 });
  for (let i = 0; i < 45; i++) advancePathTweens(project, once, .05);
  assert.ok(Math.abs(once.entities.find(entity => entity.id === 'driver').x - 1000) < 1, 'the second trip ends on the route too');

  // A restarted trip does not double its distance either.
  const halfway = createRuntime(project);
  startPathTween(halfway, { entityId: 'driver', pathId: 'road', seconds: 2 });
  for (let i = 0; i < 14; i++) advancePathTweens(project, halfway, .05);
  assert.ok(Math.abs(halfway.entities.find(entity => entity.id === 'driver').x - 350) < 5, 'part of the way along');
  startPathTween(halfway, { entityId: 'driver', pathId: 'road', seconds: 2 });
  for (let i = 0; i < 45; i++) advancePathTweens(project, halfway, .05);
  assert.ok(Math.abs(halfway.entities.find(entity => entity.id === 'driver').x - 1000) < 1, 'the restart still ends on the route');

  // The looping timeline never carries either object off the road, and the displaced one stays
  // displaced by exactly its own 200 units.
  const state = createRuntime(project);
  startTimesheetRun(project, state, 'lap');
  for (let i = 0; i < 200; i++) tick(project, state);
  const ended = state.entities.filter(entity => ['driver', 'passenger'].includes(entity.id));
  assert.ok(Math.abs(ended.find(entity => entity.id === 'driver').x - 1000) < 2, `driver at ${ended.find(entity => entity.id === 'driver').x}`);
  assert.ok(Math.abs(ended.find(entity => entity.id === 'passenger').y - 200) < 2, 'the passenger keeps its own line');
  assert.ok(Math.abs(ended.find(entity => entity.id === 'passenger').x - 1000) < 2, 'and travels the same length of road');
});

test('a tweened sprite is turned onto the route, because its forward is the engine\'s', () => {
  const project = createProject();
  project.events = [];
  project.paths = [{ id: 'straight', name: 'Straight', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 0, y: 1000, z: 0, curve: 0 } ] }];
  project.timesheets = [{ id: 'walk', name: 'Walk', duration: 10, loop: false, tracks: [createTrack(0)], cues: [
    { id: 'go', name: 'Go', trackId: 'track_1', time: 0, ownerId: 'pickup', actions: [
      { type: 'followPath', entityId: '$self', pathId: 'straight', fromPoint: 0, toPoint: 1, seconds: 2, easing: 'linear', faceDirection: 'yes' },
    ] },
  ] }];
  validateProject(project);
  const state = createRuntime(project);
  state.entities.find(entity => entity.id === 'pickup').angle = 300;   // a thing placed at any angle
  startTimesheetRun(project, state, 'walk');
  tick(project, state); tick(project, state);
  assert.ok(Math.abs(state.entities.find(entity => entity.id === 'pickup').angle - 90) < 1, 'a sprite faces the way it walks');
});

test('the facing offset corrects a model whose own forward is off', () => {
  const project = createProject();
  project.events = [];
  project.paths = [{ id: 'straight', name: 'Straight', closed: false, points: [
    { id: 'p0', x: 0, y: 0, z: 0, curve: 0 }, { id: 'p1', x: 1000, y: 0, z: 0, curve: 0 } ] }];
  project.timesheets = [{ id: 'drive', name: 'Drive', duration: 10, loop: false, tracks: [createTrack(0)], cues: [
    { id: 'go', name: 'Go', trackId: 'track_1', time: 0, ownerId: 'pickup', actions: [
      { type: 'followPath', entityId: '$self', pathId: 'straight', fromPoint: 0, toPoint: 1, seconds: 2,
        easing: 'linear', faceDirection: 'yes', yawOffset: -90 },
    ] },
  ] }];
  validateProject(project);
  const state = createRuntime(project);
  const entity = state.entities.find(item => item.id === 'pickup');
  entity.modelAsset = 'asset_truck';
  entity.angle = 0;
  startTimesheetRun(project, state, 'drive');
  tick(project, state); tick(project, state);
  assert.ok(Math.abs(state.entities.find(item => item.id === 'pickup').angle - 270) < 1e-6, '0 - 90 is 270, wrapped');
  // The field is part of the action, so a project carrying one validates and round-trips.
  validateProject(project);
});

// The Project tree is DOM glue, so what can be pinned here is the wiring: a timeline is listed,
// creatable, renameable and openable from the tree, and every one of those goes through the panel
// that owns the project edits.
test('the Project tree lists, creates, renames and opens timelines', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderTimesheetTree\(\)/);
  // `render()` is what every edit ends in, so the tree is listed among its steps and follows the
  // timeline the panel is showing when that tab is open.
  assert.match(app, /renderTimesheetTree\(\);\n  \/\/ Undo, a rename from the tree/, 'the tree is redrawn with the project');
  assert.match(app, /if \(timesheetPanelBuilt && \$\('timesheet-panel'\)\?\.hidden === false\) timesheetPanel\.render\(\)/,
    'and the visible timeline follows an undo or a rename');
  assert.match(app, /\$\('new-timesheet'\)\.addEventListener/, 'the tree makes timelines');
  assert.match(app, /timesheetPanel\.add\(\)/, 'through the panel that owns the edit');
  assert.match(app, /timesheetPanel\.rename\(sheet\.id,/, 'and renames them the same way');
  assert.match(app, /function openTimesheet\(id\)[\s\S]{0,120}showTab\('timesheet'\)/, 'a row opens the timeline tab');
  assert.match(app, /addEventListener\('dblclick'[\s\S]{0,80}renameTimesheetInline/, 'a double click renames in place');
  // Right click anywhere in the tree does something: the rows that had no menu answered with
  // nothing, which read as broken. Layouts and timelines get their own, scene objects and objects
  // keep the ones they had.
  assert.match(app, /function projectTreeMenu\(event\)/, 'the tree has a context menu');
  assert.match(app, /project-tree'\)\?\.addEventListener\('contextmenu', projectTreeMenu\)/, 'installed on the tree');
  assert.match(app, /if \(row\.dataset\.timesheetId\)[\s\S]{0,400}Open timeline/, 'a timeline row offers its actions');
  assert.match(app, /if \(row\.dataset\.levelId\)[\s\S]{0,400}Copy layout id/, 'so does a layout row');
  // Double click to rename is generic, so layouts, scenes and timelines behave the same way.
  assert.match(app, /function beginInlineRename\(row, \{/, 'one rename helper');
  assert.match(app, /function renameLayoutInline\(row, level\)[\s\S]{0,600}editGame\(/, 'a layout rename is a campaign edit, so undo can reach it');
  assert.match(app, /renameLayoutInline\(entry, level\)/, 'level rows rename in place');
  assert.match(app, /renameSceneInline\(row, scene\)/, 'scene object rows rename in place');
  const panel = readFileSync(new URL('../public/timesheet-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /add\(name\)/, 'the panel exposes creating');
  assert.match(panel, /rename\(id, name\)/, 'the panel exposes renaming');
  assert.match(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /id="project-timesheets"/);
});

// The reported bug: a truck posed by eye so it looked right next to its route drove sideways. The
// pose that looks right already carries the file's own forward, so declaring it as the facing keeps
// the look and makes the angle mean "where the nose points" — which the route can then follow.
test('a posed model is lined up with its route without moving it', async () => {
  const { alignModelToRoute, driveRouteTimesheet } = await import('../shared/timesheet-recipe.js');
  const { modelOrientation } = await import('../shared/entity-visuals.js');
  // East, then north: the route heads 90° as it leaves the first waypoint.
  const path = { id: 'up', name: 'Up', closed: false, points: [
    { id: 'a', x: 0, y: 0, z: 0, curve: 0 }, { id: 'b', x: 0, y: 600, z: 0, curve: 0 },
  ] };
  // The author turned the model 20° short of the route and, looking at it, called that right.
  const entity = { id: 'truck', name: 'Truck', modelAsset: 'truck.glb', angle: 70, x: 0, y: 0 };
  const alignment = alignModelToRoute(entity, path);
  assert.equal(alignment.heading, 90, 'the route heads north out of its first waypoint');
  assert.equal(alignment.facing, 90 - 70, 'the gap between the route and the pose is the file\'s forward');
  // Declaring the facing never poses the model, so the angle stays where the author put it and the
  // nose (angle + facing) is what lands on the route.
  assert.equal(alignment.angle, 70, 'the pose is not moved by declaring a facing');
  assert.equal((alignment.angle + alignment.facing) % 360, 90, 'the nose is on the route');
  // What the author saw is what they now get: the model is drawn in exactly the same place.
  const looked = modelOrientation({ angle: 70 });
  const now = modelOrientation({ angle: alignment.angle, modelFacing: alignment.facing });
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(looked[i] - now[i]) < 1e-9, 'the model did not jump');
  // A route with nowhere to go has no direction to face.
  assert.equal(alignModelToRoute(entity, { id: 'dot', points: [{ id: 'a', x: 0, y: 0, z: 0 }] }), null);

  // A model whose body can be measured is set to that measurement, not to the gap between the
  // route and a pose that was only roughly right: a truck 10° off the path is what the eye reads as
  // "not aligned", and the bounding box knows the 10° the author could not see.
  const skewed = { ...entity, angle: 70, modelFacing: 80 };
  const measured = alignModelToRoute(skewed, path, { forward: 90 });
  assert.equal(measured.facing, 90, 'the body runs along Z, so its facing is 90 and not the 80 it had');
  // The 80 was wrong, so the body really is 10° off the road: the angle that fixes it is the heading
  // less the *measured* 90, and the model turns by the correction it needed.
  assert.equal(measured.angle, 0, 'the angle becomes the heading less the real forward');
  assert.equal(measured.measured, true);
  // The hemisphere is the one the author already chose: 80 was nearer 90 than 270, and 20 nearer
  // -90 than 90, so aligning again never flips a truck around behind their back.
  assert.equal(alignModelToRoute({ ...entity, modelFacing: 200 }, path, { forward: 90 }).facing, -90);
  assert.equal(alignModelToRoute({ ...entity, modelFacing: 20 }, path, { forward: 0 }).facing, 0);
  assert.equal(alignModelToRoute({ ...entity, modelFacing: 200 }, path, { forward: 0 }).facing, 180);
  // With no facing declared yet — the case this button exists for — the *pose* is the author's
  // answer about which end leads, not a made-up 0. A model whose body runs along ±X (so 0 or 180)
  // was posed with its tail toward the route: facing 180 keeps it looking exactly as it did, where
  // taking 0 as the reference turned it a half turn and drove it backwards.
  const tailFirst = { ...entity, angle: 270 };
  const kept = alignModelToRoute(tailFirst, path, { forward: 0 });
  assert.equal(kept.facing, 180, 'the pose implies the other end is the nose');
  // Quaternions q and -q are the same rotation, so the check is the direction the body is drawn in
  // rather than the four numbers: rotating the model's own +Z by each must land in the same place.
  const facingDirection = quaternion => {
    const [x, y, z, w] = quaternion;
    // `+ 0` turns -0 into 0: they are the same number but not the same in a deep compare.
    return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)].map(value => Math.round(value * 1e9) / 1e9 + 0);
  };
  assert.deepEqual(facingDirection(modelOrientation({ angle: kept.angle, modelFacing: kept.facing })),
    facingDirection(modelOrientation({ angle: 270 })), 'so the model is drawn where the author put it');
  // The same model declared facing 0 already, and then the declaration wins over the pose.
  assert.equal(alignModelToRoute({ ...tailFirst, modelFacing: 0 }, path, { forward: 0 }).facing, 0);

  // The recipe applies it, and the cue carries no yaw offset: the facing is already exact.
  let sequence = 0;
  const posed = { ...entity, path: { id: 'up', speed: 100, yawOffset: 20 } };
  const { alignment: applied, yawOffset } = driveRouteTimesheet({
    entity: posed, path, nextId: name => `${name}_${++sequence}`, alignToRoute: true,
  });
  assert.equal(yawOffset, 0, 'the old hand-set offset is not applied on top of an exact facing');
  assert.equal(applied.facing, 20);
  // Without the option nothing is re-posed, so existing projects keep behaving as they did.
  assert.equal(driveRouteTimesheet({ entity: posed, path, nextId: name => `${name}_${++sequence}` }).alignment, null);
  // A model that already declared its facing is trusted, even if its angle is not on the route.
  const declared = { ...entity, modelFacing: 12, path: { id: 'up' } };
  assert.equal(driveRouteTimesheet({ entity: declared, path, nextId: name => `${name}_${++sequence}`, alignToRoute: true }).alignment, null);

  // And the whole thing is valid project data, which is the point of building it here.
  const project = createProject();
  const truck = project.map.entities.find(item => item.id === 'pickup');
  truck.angle = alignment.was;
  truck.path = { id: 'up', speed: 100 };
  project.paths = [path];
  project.events = [];
  const built = driveRouteTimesheet({ entity: { ...truck, modelAsset: 'truck_model' }, path, nextId: name => `${name}_${++sequence}`, alignToRoute: true });
  truck.modelFacing = built.alignment.facing;
  truck.angle = built.alignment.angle;
  delete truck.path;
  project.timesheets = [built.sheet];
  project.events = [built.event];
  assert.doesNotThrow(() => validateProject(project));
});
