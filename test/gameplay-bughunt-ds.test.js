import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { executeSpecial, unsupportedSpecials } from '../shared/line-specials.js';
import { advanceSectors } from '../shared/world-motion.js';

/**
 * A three-sector row: s0 (untagged), s1 (tag 1) and s2 (untagged). The shared
 * boundary between s0 and s1 carries a Hexen-format special, so both the editor's
 * support report and the runtime execution can be exercised on real geometry.
 */
function room({ special = 0, args = [], sectors = {} } = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-256, -256], [0, -256], [256, -256], [512, -256], [512, 256], [256, 256], [0, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 0, ...sectors.s0 },
    { id: 's1', floorHeight: 16, ceilingHeight: 96, light: 160, sky: false, tag: 1, ...sectors.s1 },
    { id: 's2', floorHeight: -32, ceilingHeight: 256, light: 160, sky: false, tag: 0, ...sectors.s2 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('s0'), left: null, solid: true },
    { id: 'door', a: 'v1', b: 'v6', right: side('s0'), left: side('s1'), solid: false,
      special, tag: 0, specialFormat: 'zdoom', args: [0, 1, 2, 3, 4].map(index => args[index] ?? 0), activationModes: ['use'] },
    { id: 'w2', a: 'v6', b: 'v7', right: side('s0'), left: null, solid: true },
    { id: 'w3', a: 'v7', b: 'v0', right: side('s0'), left: null, solid: true },
    { id: 'w4', a: 'v1', b: 'v2', right: side('s1'), left: null, solid: true },
    { id: 'mid', a: 'v2', b: 'v5', right: side('s1'), left: side('s2'), solid: false },
    { id: 'w6', a: 'v5', b: 'v6', right: side('s1'), left: null, solid: true },
    { id: 'w7', a: 'v2', b: 'v3', right: side('s2'), left: null, solid: true },
    { id: 'w8', a: 'v3', b: 'v4', right: side('s2'), left: null, solid: true },
    { id: 'w9', a: 'v4', b: 'v5', right: side('s2'), left: null, solid: true },
  ].map(wall => ({ color: '#888888', flags: 0, height: 160, ...wall }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -40, y: 0, angle: 0 }];
  installEngineScripts(project);
  validateProject(project);
  return project;
}

function run(special, args, sectors, options = {}) {
  const project = room({ special, args, sectors });
  const state = createRuntime(project);
  const result = executeSpecial(project, state, special, args, { format: 'zdoom', activator: 'player', ...options });
  return { project, state, result };
}

const ceilingOf = (state, id) => state.sectors.find(sector => sector.id === id).ceilingHeight;

test('192 Ceiling_LowerToHighestFloor lowers the ceiling to the highest neighbouring floor', () => {
  // s1's neighbours are s0 (floor 0) and s2 (floor -32): the highest floor is 0.
  const { state, result } = run(192, [1, 16], {});
  assert.equal(result, 1, 'the special is performed, not a silent no-op');
  for (let tic = 0; tic < 35 * 4; tic++) advanceSectors(state, 1 / 35);
  assert.equal(ceilingOf(state, 's1'), 0, 'ceiling settled on the highest surrounding floor');
  assert.equal(ceilingOf(state, 's0'), 160, 'only the tagged sector moved');
  assert.equal(ceilingOf(state, 's2'), 256, 'only the tagged sector moved');
});

test('192 Ceiling_LowerToHighestFloor rises instantly when the neighbouring floor is above it', () => {
  // Give s2 a floor above s1's ceiling: the ceiling must snap up, never lower.
  const { state, result } = run(192, [1, 16], { s2: { floorHeight: 128 } });
  assert.equal(result, 1, 'the special is performed, not a silent no-op');
  assert.equal(ceilingOf(state, 's1'), 128, 'ceiling snapped up to the highest surrounding floor');
  assert.ok(!state.sectorMotions.has('s1:ceilingHeight'), 'an upward move is instant, not animated');
});

test('Ceiling_Waggle, Floor_Waggle and ChangeCamera are reported as supported', () => {
  // These specials are implemented in executeSpecial but were left out of the
  // supported set, so the editor and importer reported them as unsupported.
  assert.deepEqual(unsupportedSpecials([38, 138, 237]), []);
  // A genuinely unsupported special keeps its warning: the fix narrows the gap,
  // it does not silence every report.
  assert.deepEqual(unsupportedSpecials([2]), ['2 Polyobj_RotateLeft']);
});

/** Three tagged sectors in a row, with the activating line on the right edge. */
function stairsRoom() {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-256, -256], [0, -256], [256, -256], [512, -256], [512, 256], [256, 256], [0, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 'sa', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 1 },
    { id: 'sb', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 1 },
    { id: 'sc', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 1 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('sa'), left: null, solid: true },
    { id: 'wAB', a: 'v1', b: 'v6', right: side('sa'), left: side('sb'), solid: false },
    { id: 'w2', a: 'v6', b: 'v7', right: side('sa'), left: null, solid: true },
    { id: 'w3', a: 'v7', b: 'v0', right: side('sa'), left: null, solid: true },
    { id: 'w4', a: 'v1', b: 'v2', right: side('sb'), left: null, solid: true },
    { id: 'wBC', a: 'v2', b: 'v5', right: side('sb'), left: side('sc'), solid: false },
    { id: 'w6', a: 'v5', b: 'v6', right: side('sb'), left: null, solid: true },
    { id: 'w7', a: 'v2', b: 'v3', right: side('sc'), left: null, solid: true },
    { id: 'stairsLine', a: 'v3', b: 'v4', right: side('sc'), left: null, solid: true,
      special: 27, tag: 1, specialFormat: 'zdoom', args: [1, 16, 8, 0, 0] },
    { id: 'w9', a: 'v4', b: 'v5', right: side('sc'), left: null, solid: true },
  ].map(wall => ({ color: '#888888', flags: 0, height: 128, activationModes: ['use'], ...wall }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -100, y: 0, angle: 0 }];
  installEngineScripts(project);
  validateProject(project);
  return project;
}

test('27 Stairs_BuildUp orders steps outward from the activating line', () => {
  // The line sits on the right edge, so sc is the first step (+8), then sb (+16),
  // then sa (+24). Ordering by bounding-box minX would put sa first instead.
  const project = stairsRoom();
  const state = createRuntime(project);
  const result = executeSpecial(project, state, 27, [1, 16, 8], { format: 'zdoom', activator: 'player', line: 'stairsLine' });
  assert.equal(result, 3, 'three tagged sectors take a step');
  const height = id => state.sectorMotions.get(`${id}:floorHeight`)?.height;
  assert.equal(height('sc'), 8, 'the sector nearest the line is the first step');
  assert.equal(height('sb'), 16, 'the middle sector is the second step');
  assert.equal(height('sa'), 24, 'the farthest sector is the last step');
});
