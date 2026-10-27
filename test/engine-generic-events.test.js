import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { ACTIONS, CONDITIONS, createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { installWallWalkDemo } from '../shared/engine-script.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/**
 * A project made from nothing: no WAD, no campaign, no imported assets. Every rule
 * below is authored by a creator in the editor, so it must work here exactly as it
 * does in an imported game.
 */
function bareRoom() {
  const project = createProject();
  project.events = [];
  project.variables = { ticks: 0, rolls: 0, entered: 0, inside: 0 };
  project.map.vertices = [['a', -256, -256], ['b', 256, -256], ['c', 256, 256], ['d', -256, 256]]
    .map(([id, x, y]) => ({ id, x, y }));
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 128, color: '#888888', solid: true, right: { sectorId: 'room', offsetX: 0, offsetY: 0 },
  }));
  project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false }];
  project.map.entities = [
    { ...project.map.entities.find(entity => entity.type === 'player'), x: -100, y: 0, angle: 0 },
    { id: 'crate', type: 'decoration', name: 'Crate', x: 100, y: 0, elevation: 0, angle: 0,
      area: { shape: 'box', width: 96, height: 96, depth: 96, radius: 48 } },
  ];
  return project;
}

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, conditions: [], actions, ...extra });
const tick = (project, state, frames, keys = new Set(), pressed = new Set()) => {
  for (let index = 0; index < frames; index++) stepRuntime(project, state, 1 / 60, keys, index === 0 ? pressed : new Set());
};
const withPhysics = (project, t) => {
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  return state;
};

test('the wall-walking and area rules need no imported content', t => {
  const project = bareRoom();
  assert.equal(project.importSource, undefined, 'the fixture has no WAD provenance');
  assert.equal(project.game, undefined, 'and no campaign');
  installWallWalkDemo(project);
  project.events.push(
    rule('area_in', { type: 'playerInArea', entityId: 'crate' }, [{ type: 'addVariable', variable: 'inside', value: 1 }]),
    rule('area_enter', { type: 'playerEnteredArea', entityId: 'crate' }, [{ type: 'addVariable', variable: 'entered', value: 1 }]));
  const state = withPhysics(project, t);
  tick(project, state, 30);
  // Everything the demo and the area rules need comes from the engine, not the map.
  assert.ok(Array.isArray(state.surfaces));
  assert.equal(state.player.up[2], 1);
  // Walk into the crate's interaction area: the capsule has to move, not just the state.
  const playerId = state.entities.find(entity => entity.type === 'player').id;
  state.physics.teleport(playerId, 80, 0);
  tick(project, state, 5);
  assert.equal(state.variables.inside, 5, 'inside-the-area fires every frame while standing in it');
  assert.equal(state.variables.entered, 1, 'entered fires exactly once');
});

test('every new condition and action works on a bare project and survives a round trip', t => {
  const project = bareRoom();
  project.events = [
    rule('interval', { type: 'everySeconds', seconds: .5 }, [
      { type: 'rotateEntityBy', entityId: 'crate', angle: 45 },
      { type: 'setEntityTilt', entityId: 'crate', pitch: 90, roll: 0 },
    ]),
    rule('chance', { type: 'randomChance', probability: .5 }, [{ type: 'addVariable', variable: 'rolls', value: 1 }]),
    rule('count', { type: 'objectCount', entityType: 'decoration', operator: '>=', value: 1 },
      [{ type: 'addVariable', variable: 'ticks', value: 1 }], { conditions: [{ type: 'entityAngle', entityId: 'crate', operator: '>=', value: 45 }] }),
    rule('pitch', { type: 'onStart' }, [{ type: 'setPlayerPitch', pitch: 25 }]),
  ];
  const state = withPhysics(project, t);
  tick(project, state, 70);
  const crate = state.entities.find(entity => entity.id === 'crate');
  assert.equal(crate.angle, 135, 'everySeconds fired at 0, 0.5 and 1.0 s and rotated 45 each time');
  assert.deepEqual(crate.modelTilt, { pitch: 90, roll: 0 });
  assert.ok(state.variables.rolls > 0, 'randomChance fired at p=0.5');
  assert.ok(state.variables.ticks > 0, 'objectCount and entityAngle were satisfied');
  assert.equal(Math.round(state.player.pitch * 180 / Math.PI), 25);

  // Saved projects are plain JSON: the commands must validate again after a copy.
  const copy = structuredClone(project);
  assert.doesNotThrow(() => validateProject(copy));
  assert.doesNotThrow(() => createRuntime(copy));
});

test('every command is available to any project, not just imported ones', () => {
  for (const type of ['playerTouchingSurface', 'playerAirborne', 'playerInArea', 'playerEnteredArea',
    'everySeconds', 'randomChance', 'objectCount', 'entityAngle']) {
    assert.ok(CONDITIONS.includes(type), `${type} is a condition`);
  }
  for (const type of ['setPlayerGravity', 'rotateEntityBy', 'setEntityTilt', 'setPlayerPitch']) {
    assert.ok(ACTIONS.includes(type), `${type} is an action`);
  }
});

test('tilt is validated and ignored by projects that do not use it', () => {
  const project = bareRoom();
  project.map.entities[1].modelTilt = { pitch: 180, roll: 90 };
  assert.doesNotThrow(() => validateProject(project));
  project.map.entities[1].modelTilt = { pitch: 'upside down' };
  assert.throws(() => validateProject(project), /Model tilt pitch/);
  project.map.entities[1].modelTilt = 'yes';
  assert.throws(() => validateProject(project), /Model tilt must be an object/);
});

test('a sub-event of a for-each rule runs once per instance, not once per object', async () => {
  const { createProject, validateProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const project = createProject();
  project.map.entities.push({ id: 'shelf1', name: 'Shelf 1', type: 'decoration', x: 0, y: 0, angle: 0, variables: { hits: 0 } },
    { id: 'shelf2', name: 'Shelf 2', type: 'decoration', x: 0, y: 0, angle: 0, variables: { hits: 0 } });
  project.events = [
    { id: 'each', enabled: true, once: false, forEachType: 'decoration',
      condition: { type: 'always' }, conditions: [], actions: [] },
    { id: 'count', parentId: 'each', enabled: true, once: false, forEachType: 'decoration',
      condition: { type: 'always' }, conditions: [], actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'hits', value: 1 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.entities.find(entity => entity.id === 'shelf1').variables.hits, 1);
  assert.equal(state.entities.find(entity => entity.id === 'shelf2').variables.hits, 1);
});

test('a sub-event of an object rule resolves this object', async () => {
  const { createProject, validateProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const project = createProject();
  project.map.entities.push({ id: 'crate', name: 'Crate', type: 'decoration', x: 10, y: 20, angle: 0 });
  project.events = [
    { id: 'root', ownerId: 'crate', enabled: true, once: false,
      condition: { type: 'always' }, conditions: [], actions: [] },
    { id: 'child', parentId: 'root', ownerId: 'crate', enabled: true, once: false,
      condition: { type: 'always' }, conditions: [],
      actions: [{ type: 'setEntityPosition', entityId: '$self', x: 99, y: 77, z: 1 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  const crate = state.entities.find(entity => entity.id === 'crate');
  assert.deepEqual([crate.x, crate.y], [99, 77], 'the child rule moved the owning object');
});
