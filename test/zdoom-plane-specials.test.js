// ZDoom/Hexen line specials: the plane numbers Doom uses, checked against GZDoom's own tables.
//
// Five separate mistakes, each with its own root cause: the plat table read the *delay* argument
// as the height (`Plat_UpByValue(tag, speed, delay, height)`), `Generic_Lift`'s target 4 is a
// perpetual raise rather than an up-by-value, the Hexen crushers stopped four units above the
// floor and paused a second at each end where GZDoom's `DCeiling` reverses at once, `192` ignored
// its gap argument, and every plane speed of four or less was raised to a whole unit per tic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { executeSpecial } from '../shared/line-specials.js';
import { sectorMovers } from '../shared/sector-movers.js';
import { advanceSectors } from '../shared/world-motion.js';

/** s0 (tag 0) beside s1 (tag 1), both 0..128, with the special on the shared line. */
function room({ special = 0, args = [], walls = [], sectors = {} } = {}) {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-256, -128], [0, -128], [256, -128], [256, 128], [0, 128], [-256, 128]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 0, ...sectors.s0 },
    { id: 's1', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 1, ...sectors.s1 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('s0'), left: null, solid: true },
    { id: 'lit', a: 'v1', b: 'v4', right: side('s0'), left: side('s1'), solid: false, special, tag: 0,
      specialFormat: 'zdoom', args: [0, 1, 2, 3, 4].map(index => args[index] ?? 0), activationModes: ['use'] },
    { id: 'w2', a: 'v4', b: 'v5', right: side('s0'), left: null, solid: true },
    { id: 'w3', a: 'v5', b: 'v0', right: side('s0'), left: null, solid: true },
    { id: 'w4', a: 'v1', b: 'v2', right: side('s1'), left: null, solid: true },
    { id: 'w5', a: 'v2', b: 'v3', right: side('s1'), left: null, solid: true },
    { id: 'w6', a: 'v3', b: 'v4', right: side('s1'), left: null, solid: true },
    ...walls,
  ].map(wall => ({ color: '#888888', height: 128, ...wall }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -80, y: 0, angle: 0 }];
  validateProject(project);
  return project;
}

function run(special, args, options = {}) {
  const project = room({ special, args, ...(options.room || {}) });
  const state = createRuntime(project);
  const result = executeSpecial(project, state, special, args, { format: 'zdoom', activator: 'player' });
  return { project, state, result, motion: surface => state.sectorMotions.get(`s1:${surface}`) };
}

test('Ceiling_CrushAndRaise stops eight above the floor, as GZDoom’s EV_DoCeiling does', () => {
  const { motion } = run(42, [1, 16]);
  assert.equal(motion('ceilingHeight').height, 8);
});

test('Ceiling_CrushAndRaise reverses at once at both ends', () => {
  const { motion } = run(42, [1, 16]);
  assert.equal(motion('ceilingHeight').wait, 0, 'no rest at the top');
  assert.equal(motion('ceilingHeight').bottomWait, 0, 'and none at the bottom');
  const { motion: silent } = run(196, [1, 16]);
  assert.equal(silent('ceilingHeight').bottomWait, 0);
});

test('Ceiling_LowerAndCrush also keeps its eight-unit gap', () => {
  const { motion } = run(43, [1, 8]);
  assert.equal(motion('ceilingHeight').height, 8);
});

test('Ceiling_LowerToHighestFloor reads its gap argument', () => {
  // (tag, speed, change, crush, gap): the ceiling settles on the highest floor around it plus gap.
  const { motion } = run(192, [1, 16, 0, 0, 24], { room: { sectors: { s0: { floorHeight: 0 } } } });
  assert.equal(motion('ceilingHeight').height, 24);
});

test('a plane speed of zero creates no motion at all', () => {
  const { motion } = run(40, [1, 0, 8]);
  assert.equal(motion('ceilingHeight'), undefined, 'GZDoom builds a ceiling with speed 0 that never moves');
});

test('a slow plane keeps its own speed instead of being rounded up to one unit a tic', () => {
  // SPEED(a) is a/8 units per tic: 35 units a second, so four tics' worth is half that.
  const { motion } = run(40, [1, 4, 8]);
  assert.equal(motion('ceilingHeight').speed, 35 * 4 / 8);
});

test('Plat_UpByValue takes its height from the fourth argument, not the delay', () => {
  // Plat_UpByValue(tag, speed, delay, height): the editor's mover table read args[2] (the delay),
  // so the inspector and the runtime disagreed about where the platform goes.
  const project = room({ special: 65, args: [1, 16, 35, 4, 0] });
  const action = sectorMovers(project).get('s1')?.actions?.[0];
  assert.ok(action, 'the platform is described');
  assert.equal(action.height, 4 * 8, 'matches the runtime, which moves it four eighths up');
});

test('Plat_DownByValue lowers by the same fourth argument', () => {
  const project = room({ special: 63, args: [1, 16, 35, 4, 0] });
  const action = sectorMovers(project).get('s1')?.actions?.[0];
  assert.equal(action.height, -4 * 8);
});

test('Generic_Lift target 4 is a perpetual raise between the surrounding floors', () => {
  // (tag, speed, delay, target, height): target 4 is DPlat::platPerpetualRaise, which ignores the
  // height and travels from the lowest surrounding floor up to its own floor, over and over.
  const { motion } = run(203, [1, 16, 0, 4, 8], { room: { sectors: { s0: { floorHeight: -32 } } } });
  const ceiling = motion('floorHeight');
  assert.equal(ceiling.height, 0, 'the high end is its own floor');
  assert.equal(ceiling.returnHeight, -32, 'and the low end is the neighbouring floor');
  assert.equal(ceiling.returnMode, 'cycle');
});

test('Generic_Lift target 3, down to the lowest ceiling, never drops below its own floor', () => {
  const { motion } = run(203, [1, 16, 0, 3, 0], { room: { sectors: { s0: { floorHeight: -64 } } } });
  assert.ok(motion('floorHeight').height >= 0, 'a platform never goes under the floor it stands on');
});

test('a door’s speed argument is units a tic, eighth by eighth', () => {
  // SPEED(a) = a/8 units a tic: an author's four is half a unit a tic, 17.5 units a second. The
  // engine raised every speed to at least one unit a tic, so anything slower ran up to eight times
  // too fast and a speed of zero moved a door that GZDoom leaves still.
  const { motion } = run(249, [1, 4, 0]);
  assert.equal(motion('ceilingHeight').speed, 17.5);
  const still = run(249, [1, 0, 0]);
  assert.equal(still.motion('ceilingHeight').speed, 0, 'zero stays zero');
});
