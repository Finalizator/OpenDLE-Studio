// A tag of 0 means "the sector behind this line", and every special that moves a plane says so.
//
// GZDoom's `GetSectorTagIterator(tag, line)` resolves tag 0 to the activating line's back sector.
// The engine applied that only to doors, and the rules it generated never carried the line at all,
// so a tag-0 lift, floor or ceiling special did nothing — on real UDMF maps, which use tag 0 for a
// line that acts on what is behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { executeSpecial } from '../shared/line-specials.js';
import { installWorldScripts } from '../shared/world-motion.js';

/** Room `a` (tag 0), the line, room `b` (tag 0, floor 64). */
function rooms(special, args, activation = ['use']) {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-256, -128], [0, -128], [0, 128], [-256, 128], [256, -128], [256, 128]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.sectors = [
    { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 160, sky: false, tag: 0 },
    { id: 'b', floorHeight: 64, ceilingHeight: 128, light: 160, sky: false, tag: 0 },
  ];
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'lit', a: 'v1', b: 'v2', right: side('a'), left: side('b'), height: 128, color: '#888888', solid: false,
      special, tag: 0, specialFormat: 'zdoom', args: [0, 1, 2, 3, 4].map(index => args[index] ?? 0), activationModes: activation },
    { id: 'w2', a: 'v2', b: 'v3', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w3', a: 'v3', b: 'v0', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w4', a: 'v1', b: 'v4', right: side('b'), height: 128, color: '#888888', solid: true },
    { id: 'w5', a: 'v4', b: 'v5', right: side('b'), height: 128, color: '#888888', solid: true },
    { id: 'w6', a: 'v5', b: 'v2', right: side('b'), height: 128, color: '#888888', solid: true },
  ];
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -200, y: 0, angle: 0 }];
  installWorldScripts(project, []);
  validateProject(project);
  return project;
}

const floorOf = (state, id = 'b') => state.sectors.find(sector => sector.id === id).floorHeight;

test('a tag-0 floor special lowers the sector behind the line', () => {
  const project = rooms(20, [0, 64, 16]); // Floor_LowerByValue (tag, speed, height)
  const state = createRuntime(project);
  assert.equal(executeSpecial(project, state, 20, [0, 64, 16, 0, 0], { format: 'zdoom', line: 'lit' }), 1);
  for (let frame = 0; frame < 70; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(floorOf(state), 48, '64 came down by the 16 the special asked for');
});

test('the generated rule names its line, so pressing it works at all', () => {
  const project = rooms(20, [0, 64, 16]);
  const action = project.events.find(event => event.id.startsWith('world_special'))?.actions?.[0];
  assert.equal(action.type, 'runLineSpecial');
  assert.equal(action.line, 'lit', 'the rule keeps the line it came from');
});

test('and walking up to it and using it moves the floor in the running game', () => {
  const project = rooms(20, [0, 64, 16]);
  const state = createRuntime(project);
  state.player.x = -60; state.player.y = 0; state.player.angle = 0;
  stepRuntime(project, state, 1 / 35, new Set(['KeyE']), new Set(['KeyE']));
  for (let frame = 0; frame < 70; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(floorOf(state), 48);
});

test('a lighting special keeps GZDoom’s other reading of tag 0', () => {
  // `Light_ChangeToValue` asks for its sectors by tag alone, where 0 means every *untagged*
  // sector. It must not start moving the sector behind the line.
  const project = rooms(10, [0, 200], ['use']); // Light_ChangeToValue (tag, value)
  const state = createRuntime(project);
  executeSpecial(project, state, 10, [0, 200, 0, 0, 0], { format: 'zdoom', line: 'lit' });
  assert.equal(state.sectorMotions.has('b:floorHeight'), false);
});
