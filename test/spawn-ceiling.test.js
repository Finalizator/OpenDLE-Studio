import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { importActors } from '../shared/actors.js';
import { createRuntime } from '../shared/runtime.js';
import { sectorAt } from '../shared/sectors.js';

// A room with a ceiling high above the floor, so a thing placed against the ceiling cannot be
// confused with a thing standing on it.
function room(entities) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [['a', -512, -512], ['b', 512, -512], ['c', 512, 512], ['d', -512, 512]]
    .map(([id, x, y]) => ({ id, x, y }));
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 128, color: '#888888', solid: true,
    right: { sectorId: 'room', offsetX: 0, offsetY: 0 },
  }));
  project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 512, light: 255, sky: false }];
  project.actors = importActors({ sources: [{ name: 'test.dec', text: DECORATE }], warnings: [] }).actors;
  const byName = new Map(project.actors.map(actor => [actor.name, actor]));
  project.map.entities = [
    { ...project.map.entities.find(entity => entity.type === 'player'), x: 0, y: 0, angle: 0 },
    // A thing in a map names its class; the actor record is what carries +SPAWNCEILING and the
    // height, so the fixture has to attach it the way the importer does.
    ...entities.map(entity => ({ ...entity, ...(byName.has(entity.actorName) ? { actorId: byName.get(entity.actorName).id } : {}) })),
  ];
  validateProject(project);
  return { project, state: createRuntime(project) };
}

const DECORATE = `
actor HangingCorpse
{
  Radius 16
  Height 64
  +SPAWNCEILING
  +NOGRAVITY
  States
  {
  Spawn:
    POL1 A -1
    Stop
  }
}
actor FloorLamp
{
  Radius 16
  Height 32
  States
  {
  Spawn:
    COLU A -1
    Stop
  }
}
actor CeilingGuard
{
  Health 60
  Speed 8
  Radius 20
  Height 56
  +SPAWNCEILING
  Monster
  States
  {
  Spawn:
    POSS AB 10 A_Look
    Loop
  }
}
`;

test('a hanging decoration hangs from the ceiling, not from the floor', () => {
  const corpse = { id: 'corpse', type: 'decoration', name: 'HangingCorpse', actorName: 'HangingCorpse',
    x: 64, y: 64, angle: 0 };
  const { project, state } = room([corpse]);
  const actor = project.actors.find(item => item.name === 'HangingCorpse');
  const hanging = state.entities.find(entity => entity.id === 'corpse');
  const sector = sectorAt(state.sectors, hanging.x, hanging.y);
  assert.equal(sector.ceilingHeight, 512);
  // `settleSpawnCeiling` only placed enemies, so the 65 hanging corpses, stalactites and
  // chandeliers of the imported campaign were drawn standing on the floor.
  assert.equal(hanging.z, 512 - actor.height, 'the top of the thing touches the ceiling');
});

test('+SPAWNCEILING still applies to a monster, and a plain decoration stays on the floor', () => {
  const guard = { id: 'guard', type: 'enemy', name: 'CeilingGuard', actorName: 'CeilingGuard',
    x: 200, y: 0, angle: 0, health: 60 };
  const lamp = { id: 'lamp', type: 'decoration', name: 'FloorLamp', actorName: 'FloorLamp', x: 0, y: 200, angle: 0 };
  const { project, state } = room([guard, lamp]);
  const guardActor = project.actors.find(item => item.name === 'CeilingGuard');
  assert.equal(state.entities.find(entity => entity.id === 'guard').z, 512 - guardActor.height);
  assert.equal(state.entities.find(entity => entity.id === 'lamp').z, undefined, 'a floor decoration keeps the floor');
});

test('a thing that carries its own world height is not moved to the ceiling', () => {
  const corpse = { id: 'corpse', type: 'decoration', name: 'HangingCorpse', actorName: 'HangingCorpse',
    x: 64, y: 64, angle: 0, z: 300 };
  const { state } = room([corpse]);
  assert.equal(state.entities.find(entity => entity.id === 'corpse').z, 300, 'an authored height wins');
});
