import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { enemyFloats, moveEnemy } from '../shared/combat.js';

/**
 * Two rooms at different heights, split by one two-sided line: the walker's side is level
 * with the player's, the step between them is 64 units, which no walking monster climbs.
 */
function step() {
  const p = createProject();
  p.events = [];
  p.map.vertices = [[-256, -256], [0, -256], [256, -256], [-256, 256], [0, 256], [256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  p.map.sectors = [
    { id: 'low', floorHeight: 0, ceilingHeight: 400, light: 255, sky: false, tag: 0 },
    { id: 'high', floorHeight: 64, ceilingHeight: 400, light: 255, sky: false, tag: 0 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('low'), left: null },
    { id: 'w1', a: 'v1', b: 'v2', right: side('high'), left: null },
    { id: 'w2', a: 'v1', b: 'v4', right: side('low'), left: side('high') },
    { id: 'w3', a: 'v2', b: 'v5', right: side('high'), left: null },
    { id: 'w4', a: 'v4', b: 'v3', right: side('low'), left: null },
    { id: 'w5', a: 'v3', b: 'v0', right: side('low'), left: null },
    { id: 'w6', a: 'v5', b: 'v4', right: side('high'), left: null },
  ].map(wall => ({ ...wall, solid: !wall.left, height: 400, color: '#888888', special: 0, tag: 0, flags: 0 }));
  p.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: 128, y: 0, angle: 180 }];
  return p;
}

const stepOf = (state, entity, seconds = 1 / 35) => moveEnemy(state, entity, 60, seconds);

test('a flying monster is the one whose actor carries MF_FLOAT', () => {
  assert.equal(enemyFloats({ floating: true }), true);
  assert.equal(enemyFloats({ floating: false }), false);
  assert.equal(enemyFloats({ actorFlags: { FLOAT: true } }), true, 'A_ChangeFlag turns it on');
  assert.equal(enemyFloats({ floating: true, actorFlags: { FLOAT: false } }), false, 'and off again');
  assert.equal(enemyFloats({}), false);
});

test('a flying monster crosses a step it does not touch, and rises toward the player', () => {
  const p = step(), state = createRuntime(p);
  const flyer = { id: 'flyer', type: 'enemy', health: 100, x: -128, y: 0, angle: 0, floating: true };
  state.entities.push(flyer);
  const startX = flyer.x;
  stepOf(state, flyer);
  assert.ok(flyer.x > startX, `a Cacodemon flies over the ledge: ${flyer.x}`);
  assert.ok(flyer.z > 0 && flyer.z < 64, 'and lifts toward the player rather than standing on the floor');
});

test('a flying monster keeps its height instead of being pinned to the sector floor', () => {
  const p = step(), state = createRuntime(p);
  const flyer = { id: 'flyer', type: 'enemy', health: 100, x: -128, y: 0, z: 300, angle: 0, floating: true };
  state.entities.push(flyer);
  // The player is far below its height, so the hover has nothing to rise to.
  stepOf(state, flyer);
  assert.ok(flyer.z > 200, `the height it was flying at is kept: ${flyer.z}`);
});

test('a walking monster still refuses to climb the step', () => {
  const p = step(), state = createRuntime(p);
  const walker = { id: 'walker', type: 'enemy', health: 100, x: -128, y: 0, angle: 0, floating: false };
  state.entities.push(walker);
  for (let step = 0; step < 40; step++) stepOf(state, walker);
  assert.ok(walker.x < 0, `a Zombieman stays on its own side of the 64-unit step: ${walker.x}`);
  assert.equal(walker.z, 0, 'and on the floor it walks on');
});
