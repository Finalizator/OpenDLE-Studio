// Three verified gaps that were reproduced but never fixed.
//
// `A_BossDeath` set a flag and stopped there, so a boss level never lowered the floor its own death
// moves (tag 666). `Door_WaitRaise` read its fourth argument as a stand-open time, so the door
// opened at once and shut again instead of waiting and staying open. The ACS random drew from a
// 100 000-value slice of its 32-bit state, which dealt `Random(0, 2)` in unequal shares.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { executeSpecial } from '../shared/line-specials.js';
import { createAcsVm } from '../shared/acs.js';

test('a boss level lowers its tag-666 floor when the last boss dies', async () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-256, -128], [0, -128], [256, -128], [256, 128], [0, 128], [-256, 128]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 'arena', floorHeight: 0, ceilingHeight: 256, light: 255, sky: false, tag: 0 },
    { id: 'exit', floorHeight: 64, ceilingHeight: 256, light: 255, sky: false, tag: 666 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('arena'), height: 128, color: '#888888', solid: true },
    { id: 'w1', a: 'v1', b: 'v4', right: side('arena'), left: side('exit'), height: 128, color: '#888888', solid: false },
    { id: 'w2', a: 'v4', b: 'v5', right: side('arena'), height: 128, color: '#888888', solid: true },
    { id: 'w3', a: 'v5', b: 'v0', right: side('arena'), height: 128, color: '#888888', solid: true },
    { id: 'w4', a: 'v1', b: 'v2', right: side('exit'), height: 128, color: '#888888', solid: true },
    { id: 'w5', a: 'v2', b: 'v3', right: side('exit'), height: 128, color: '#888888', solid: true },
    { id: 'w6', a: 'v3', b: 'v4', right: side('exit'), height: 128, color: '#888888', solid: true },
  ];
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: -200, y: 0, angle: 0 },
    { id: 'cyber', type: 'enemy', name: 'Cyberdemon', actorName: 'Cyberdemon', doomType: 16, x: 128, y: 64, angle: 180, health: 1 },
  ];
  validateProject(project);
  const state = createRuntime(project);
  const exit = () => state.sectors.find(sector => sector.id === 'exit');
  assert.equal(exit().floorHeight, 64, 'the exit floor starts raised');
  const cyber = state.entities.find(entity => entity.id === 'cyber');
  cyber.health = 0;
  // `A_BossDeath` runs from the death state; ask the action table for it directly.
  const { ACTIONS } = await import('../shared/actor-runtime.js');
  ACTIONS.A_BossDeath({ project, state, entity: cyber, actor: { name: 'Cyberdemon' } });
  assert.ok(state.sectorMotions.has('exit:floorHeight') || exit().floorHeight < 64,
    'and comes down once the last boss is dead');
});

test('Door_WaitRaise waits before it opens, then stays open', () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-256, -128], [0, -128], [0, 128], [-256, 128], [256, -128], [256, 128]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 0 },
    { id: 'door', floorHeight: 0, ceilingHeight: 0, light: 160, sky: false, tag: 5 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'lit', a: 'v1', b: 'v2', right: side('a'), left: side('door'), height: 128, color: '#888888', solid: false,
      special: 105, tag: 0, specialFormat: 'zdoom', args: [5, 64, 0, 70, 0], activationModes: ['use'] },
    { id: 'w2', a: 'v2', b: 'v3', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w3', a: 'v3', b: 'v0', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w4', a: 'v1', b: 'v4', right: side('door'), height: 128, color: '#888888', solid: true },
    { id: 'w5', a: 'v4', b: 'v5', right: side('door'), height: 128, color: '#888888', solid: true },
    { id: 'w6', a: 'v5', b: 'v2', right: side('door'), height: 128, color: '#888888', solid: true },
  ];
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -120, y: 0, angle: 0 }];
  validateProject(project);
  const state = createRuntime(project);
  assert.equal(executeSpecial(project, state, 105, [5, 64, 0, 70, 0], { format: 'zdoom' }), 1);
  const motion = state.sectorMotions.get('door:ceilingHeight');
  assert.equal(motion.returnMode, 'stay', 'the door stays open');
  assert.ok(motion.starting > 1.9 && motion.starting < 2.1, `and waits 70 tics first (${motion.starting})`);
});

test('the ACS random covers its whole 32-bit state', () => {
  // A draw was `(state % 100000) / 100000`, i.e. only 100 000 of the generator's states were ever
  // used: `Random(0, 2)` dealt its three outcomes in unequal shares.
  const vm = createAcsVm();
  const rolls = Array.from({ length: 40 }, () => vm.random());
  assert.ok(rolls.every(value => value >= 0 && value < 1));
  assert.ok(rolls.some(value => !Number.isInteger(Math.round(value * 100000) / 100000 * 100000) ||
    Math.abs(value * 100000 - Math.round(value * 100000)) > 1e-9), 'not on a 1/100 000 grid');
});
