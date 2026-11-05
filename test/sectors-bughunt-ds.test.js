import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts, advanceSectors } from '../shared/world-motion.js';

// A tagged platform (s1, floor 32) between a lower neighbour (s0, floor 0) and a
// higher neighbour (s2, floor 64). Doom's "raise to next higher floor" must pick
// 64, never the lower neighbour's 0.
function raiseFixture(special) {
  const p = createProject();
  p.events = [];
  p.map.vertices = [[-192, -96], [-32, -96], [32, -96], [192, -96], [-192, 96], [-32, 96], [32, 96], [192, 96]]
    .map(([x, y], i) => ({ id: `v${i}`, x, y }));
  p.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 1 },
    { id: 's1', floorHeight: 32, ceilingHeight: 128, light: 255, sky: false, tag: 5 },
    { id: 's2', floorHeight: 64, ceilingHeight: 128, light: 255, sky: false, tag: 2 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    [0, 1, 's0'], [1, 5, 's0', 's1', special], [5, 4, 's0'], [4, 0, 's0'],
    [1, 2, 's1'], [2, 6, 's1', 's2'], [6, 5, 's1'], [2, 3, 's2'], [3, 7, 's2'], [7, 6, 's2'],
  ].map(([a, b, right, left, special = 0], i) => ({
    id: `w${i}`, a: `v${a}`, b: `v${b}`, right: side(right), left: left ? side(left) : null,
    solid: !left, height: 128, color: '#888888', special, tag: special ? 5 : 0,
  }));
  p.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -60, y: 0, angle: 0 }];
  installEngineScripts(p);
  installWorldScripts(p, []);
  return p;
}

for (const special of [20, 22, 68]) {
  test(`classic special ${special} raises the floor to the next higher neighbour, not the lowest`, () => {
    const p = raiseFixture(special);
    const action = p.events.flatMap(event => event.actions)
      .find(item => item.type === 'moveSector' && item.surface === 'floorHeight' && item.sectorId === 's1');
    assert.ok(action, `special ${special} produces a floor move`);
    assert.equal(action.height, 64, `next higher neighbour floor is 64, got ${action.height}`);
  });
}

// A sector floor already part-way through a raise when the player steps in: the
// player no longer fits under the ceiling, so the floor must reverse rather than
// freeze at the intermediate height and never resolve.
function raisingState({ floorHeight = 60, height = 128, origin = 0, ceiling = 100, returnMode = 'stay' } = {}) {
  const ring = [{ x: 0, y: 0 }, { x: 128, y: 0 }, { x: 128, y: 128 }, { x: 0, y: 128 }];
  const sector = { id: 's0', floorHeight, ceilingHeight: ceiling, light: 255, sky: false,
    rings: [ring], bounds: { minX: 0, maxX: 128, minY: 0, maxY: 128 } };
  return {
    sectors: [sector],
    sectorMotions: new Map([['s0:floorHeight', {
      sectorId: 's0', surface: 'floorHeight', height, origin, speed: 35, wait: 0,
      returnMode, direction: 'out', waiting: 0,
    }]]),
    entities: [{ id: 'player', type: 'player', x: 64, y: 64, z: floorHeight, angle: 0 }],
    player: { id: 'player', type: 'player', x: 64, y: 64, z: floorHeight, angle: 0, elevation: 0, health: 100 },
    worldRevision: 0,
  };
}

test('a floor raise blocked by its occupant reverses instead of freezing forever', () => {
  const state = raisingState();
  for (let i = 0; i < 200; i++) advanceSectors(state, 1 / 35);
  assert.equal(state.sectorMotions.size, 0, 'the blocked motion resolves instead of stalling');
  assert.equal(state.sectors[0].floorHeight, 0, 'the blocked floor reverses back to its origin');
});
