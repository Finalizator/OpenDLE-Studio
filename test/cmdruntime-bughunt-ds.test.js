import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

// Runtime implementations of the visual-script catalogue commands. The editor validates a
// picked-variable action when at least one instance of the type carries the variable (a typo
// with zero carriers is refused), exactly like `pickByVariable`, whose comment reads "an
// instance without the variable simply does not match". `setPickedVariable` and
// `addPickedVariable` must follow the same rule instead of stopping the game.

const rule = (id, actions = [], extra = {}) => ({ id, enabled: true, once: false, condition: { type: 'always' }, actions, ...extra });

function mixedFixture() {
  const project = createProject();
  project.events = [];
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  project.map.entities.push(
    { id: 'enemy0', name: 'Scored', type: 'enemy', x: 100, y: 0, angle: 0, health: 20, variables: { score: 0 } },
    { id: 'enemy1', name: 'Plain', type: 'enemy', x: 200, y: 0, angle: 0, health: 30, variables: {} },
  );
  return project;
}

test('setPickedVariable skips instances that do not carry the variable instead of stopping the game', () => {
  const project = mixedFixture();
  project.events = [rule('score_all', [
    { type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 7 },
  ], { condition: { type: 'pickAll', objectType: 'enemy' } })];
  assert.doesNotThrow(() => validateProject(project), 'a mixed picked set is a valid project');
  const state = createRuntime(project);
  assert.doesNotThrow(() => stepRuntime(project, state, 1 / 60, new Set()), 'setPickedVariable must not crash on a valid project');
  assert.equal(state.entities.find(entity => entity.id === 'enemy0').variables.score, 7);
  assert.equal(Object.hasOwn(state.entities.find(entity => entity.id === 'enemy1').variables, 'score'), false,
    'an instance without the variable stays without it');
});

test('addPickedVariable skips instances that do not carry the variable instead of stopping the game', () => {
  const project = mixedFixture();
  project.events = [rule('add_all', [
    { type: 'addPickedVariable', objectType: 'enemy', variable: 'score', value: 3 },
  ], { condition: { type: 'pickAll', objectType: 'enemy' } })];
  assert.doesNotThrow(() => validateProject(project));
  const state = createRuntime(project);
  assert.doesNotThrow(() => stepRuntime(project, state, 1 / 60, new Set()), 'addPickedVariable must not crash on a valid project');
  assert.equal(state.entities.find(entity => entity.id === 'enemy0').variables.score, 3);
  assert.equal(Object.hasOwn(state.entities.find(entity => entity.id === 'enemy1').variables, 'score'), false);
});

// A camera can film as wide as 170 degrees, but the player's own view is the *game setting*
// `fov`, whose bounds are 50..130. `setCameraFov` on `$player` must clamp to the setting's
// bounds, not the camera's, or it writes an out-of-bounds setting that the loader then refuses
// (silently resetting every persisted user setting).
test('setCameraFov on the player view clamps to the game setting range', () => {
  const project = createProject();
  project.events = [rule('zoom', [{ type: 'setCameraFov', camera: '$player', fov: 170 }])];
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 60, new Set());
  assert.ok(state.settings.fov <= 130, `player-view fov must stay within the game setting maximum, got ${state.settings.fov}`);
  assert.ok(state.settings.fov >= 50, `player-view fov must stay within the game setting minimum, got ${state.settings.fov}`);
});
