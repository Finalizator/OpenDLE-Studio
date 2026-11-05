import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createTrack, startTimesheetRun } from '../shared/timesheet.js';

const tick = (project, state, seconds = .05) => stepRuntime(project, state, seconds, new Set());

function oneShotTimeline() {
  const project = createProject();
  project.events = [];
  project.timesheets = [{
    id: 'intro', name: 'Intro', duration: 1, loop: false, tracks: [createTrack(0)],
    cues: [{ id: 'title', name: 'Title', trackId: 'track_1', time: 0, ownerId: null,
      actions: [{ type: 'addVariable', variable: 'score', value: 1 }] }],
  }];
  validateProject(project);
  const state = createRuntime(project);
  startTimesheetRun(project, state, 'intro');
  for (let i = 0; i < 25; i++) tick(project, state);
  return { project, state };
}

test('a finished one-shot timeline replays when started again without restart', () => {
  const { project, state } = oneShotTimeline();
  // The intro played to completion: the zero cue ran once and the clock stopped at the end.
  assert.equal(state.variables.score, 1, 'the cue fired on the first play');
  assert.equal(state.timesheets.get('intro').playing, false, 'the timeline finished');
  assert.equal(state.timesheets.get('intro').time, 1, 'the clock stopped at the duration');

  // "Start this timeline again, but do not restart it if it is already playing" — a finished
  // timeline is not playing, so it has to start from the top, cue at zero included.
  startTimesheetRun(project, state, 'intro', { restart: false });
  tick(project, state);
  assert.equal(state.variables.score, 2, 'the cue at zero fires again on the replay');

  // And the replay runs to the end again instead of staying parked at the old finish line.
  for (let i = 0; i < 25; i++) tick(project, state);
  assert.equal(state.variables.score, 2, 'the cue still fires only once per play');
  assert.equal(state.timesheets.get('intro').playing, false, 'the replay finishes');
});

test('restarting a finished timeline with restart still replays it', () => {
  const { project, state } = oneShotTimeline();
  startTimesheetRun(project, state, 'intro', { restart: true });
  tick(project, state);
  assert.equal(state.variables.score, 2, 'restart: yes fires the zero cue again');
});
