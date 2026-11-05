import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createPhysics } from '../shared/physics.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { advancePlaneMotion } from '../shared/plane-motion.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(
  outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/** A project with one actor standing in the player's path, ready for a real physics world. */
function actorScene(actorFlags, { health, type = 'decoration', radius = 16, height = 56 } = {}) {
  const project = createProject();
  project.events = [];
  project.map.sectors[0].ceilingHeight = 384;
  project.map.entities[0].x = -150;
  project.actors = [{ id: 'actor', name: 'Prop', doomedNum: 20200, radius, height, health: health ?? 0,
    flags: actorFlags, states: { frames: [], labels: {} } }];
  project.map.entities.push({ id: 'prop', name: 'Prop', type, x: 0, y: 0, angle: 0, actorId: 'actor',
    ...(type === 'enemy' ? { health: health ?? 0 } : {}) });
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  return { project, state };
}

test('a moving 3D floor keeps its collision on every move, not just the first', t => {
  const project = createProject();
  project.events = [];
  project.map.sectors[0].ceilingHeight = 384;
  validateProject(project);
  const state = createRuntime(project);
  // A control sector drives the 3D floor, the way Sector_Set3DFloor describes it.
  const control = { id: 'control', floorHeight: 32, ceilingHeight: 64, light: 200, sky: false,
    rings: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
  state.sectors.push(control);
  state.sectors[0].threeDFloors = [{ controlId: 'control', bottom: 32, top: 64,
    solid: true, thin: false, tag: 0, type: 1, light: 200, alpha: 255 }];
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const settle = () => { for (let frame = 0; frame < 20; frame++) stepRuntime(project, state, 1 / 60, new Set()); };
  state.physics.teleport('player', -100, 0, 64);
  settle();
  assert.ok(Math.abs(state.player.z - 64) < 1, `settles on the floor at ${state.player.z}`);
  // The control sector lifts the platform twice, as a waggle or lift moves it frame after frame.
  control.ceilingHeight = 96;
  advancePlaneMotion(state, 1 / 60); settle();
  assert.ok(Math.abs(state.player.z - 96) < 1, `follows the first move to ${state.player.z}`);
  control.ceilingHeight = 128;
  advancePlaneMotion(state, 1 / 60); settle();
  assert.ok(Math.abs(state.player.z - 128) < 1, `follows the second move to ${state.player.z}`);
  assert.equal(state.physics.grounded, true);
});

test('a monster corpse stops blocking the player after death', t => {
  const { project, state } = actorScene({ SOLID: true, MONSTER: true }, { type: 'enemy', health: 60, radius: 20 });
  t.after(() => state.physics.dispose());
  // The monster spawns solid, then dies: Doom's A_NoBlocking clears MF_SOLID.
  state.entities.find(entity => entity.id === 'prop').health = 0;
  for (let frame = 0; frame < 90; frame++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  assert.ok(state.player.x > 50, `walks through the corpse, stopped at ${state.player.x}`);
});

test('a decoration without a SOLID flag does not block the player', t => {
  const { project, state } = actorScene({});
  t.after(() => state.physics.dispose());
  assert.equal(state.physics.bodies.has('prop'), false, 'no collider for a non-solid decoration');
  for (let frame = 0; frame < 90; frame++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  assert.ok(state.player.x > 50, `walks through the non-solid decoration, stopped at ${state.player.x}`);
});

test('a decoration with a SOLID flag still blocks the player', t => {
  const { project, state } = actorScene({ SOLID: true });
  t.after(() => state.physics.dispose());
  assert.equal(state.physics.bodies.has('prop'), true);
  for (let frame = 0; frame < 90; frame++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  assert.ok(state.player.x < -10, `stopped by the solid decoration at ${state.player.x}`);
});
