import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import {
  createTrack, createTimesheet, createCue, validateTimesheet, cuesBetween, advanceTimesheets,
  startTimesheetRun, stopTimesheetRun, setTimesheetPaused, timesheetCueEvents, timesheetSignature,
  easingValue, startPathTween, advancePathTweens, TIMESHEET_CUE_CONDITION,
} from '../shared/timesheet.js';
import { waypointDistances } from '../shared/paths.js';

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
