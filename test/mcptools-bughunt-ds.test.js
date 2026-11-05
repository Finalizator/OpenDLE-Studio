import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { assembleGameLevels } from '../shared/game-levels.js';
import { applyTool } from '../server/tools.js';

/* ---------------------------------------------------------------- events */

test('events_add_rule defaults a new rule to run repeatedly, not once', () => {
  // The editor and the Engine starter both author new rules with `once: false`;
  // the MCP tool defaulted the opposite way, so a rule added without a `once`
  // flag fired a single time and then silently stopped.
  const project = createProject();
  const result = applyTool(project, 'events_add_rule', {
    condition: { type: 'always' }, actions: [{ type: 'addVariable', variable: 'score', value: 1 }],
  });
  assert.equal(result.project.events.at(-1).once, false);
});

/* ---------------------------------------------------------------- physics */

test('entity_set_physics gives a ball a height of twice its radius by default', () => {
  // The tool promises "all collider fields have defaults" and "ball height must
  // be 2*radius", but the stock defaults (height 32, radius 12) contradict each
  // other, so creating a ball with defaults failed validation.
  const project = createProject();
  const result = applyTool(project, 'entity_set_physics', { id: 'pickup', body: 'dynamic', shape: 'ball' });
  const physics = result.project.map.entities[1].physics;
  assert.equal(physics.height, physics.radius * 2);
});

test('entity_set_physics derives the missing ball dimension from the one supplied', () => {
  const project = createProject();
  const tall = applyTool(project, 'entity_set_physics', { id: 'pickup', body: 'dynamic', shape: 'ball', radius: 16 }).project;
  assert.equal(tall.map.entities[1].physics.height, 32);
  const wide = applyTool(project, 'entity_set_physics', { id: 'pickup', body: 'dynamic', shape: 'ball', height: 20 }).project;
  assert.equal(wide.map.entities[1].physics.radius, 10);
});

/* ------------------------------------------------------------------ map */

test('map_add_entity moving the player start preserves its facing angle', () => {
  // "Place an entity, or move the single player start": a move should relocate
  // the start, not silently re-point it. The shape's angle default 0 was written
  // onto the existing player, wiping its facing.
  const project = createProject();
  project.map.entities[0].angle = 135;
  const result = applyTool(project, 'map_add_entity', { type: 'player', name: 'Player start', x: 64, y: 64 });
  assert.equal(result.project.map.entities[0].angle, 135);
  assert.equal(result.project.map.entities[0].x, 64);
});

/* ----------------------------------------------------------------- game */

function gameProject() {
  const make = () => { const project = createProject(); project.assets = []; return project; };
  return assembleGameLevels([{ id: 'l1', project: make() }, { id: 'l2', project: make() }], 'l1', 'Two levels').project;
}

test('game_level_set_routes rejects a meaningless entry:false instead of ignoring it', () => {
  // A campaign must always have an entry, so `entry: false` has no meaning; the
  // tool accepted it and silently did nothing, letting the caller believe the
  // entry had moved.
  const project = gameProject();
  assert.throws(() => applyTool(project, 'game_level_set_routes', { levelId: 'l2', entry: false }), /entry/);
  assert.equal(applyTool(project, 'game_level_set_routes', { levelId: 'l2', entry: true }).project.game.entry, 'l2');
});
