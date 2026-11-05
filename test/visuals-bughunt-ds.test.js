import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { executeSpecial } from '../shared/line-specials.js';
import { advanceSectors } from '../shared/world-motion.js';
import { captureGameSave, restoreGameSave, gameSaveIdentity } from '../shared/save-game.js';
import { installEngineScripts } from '../shared/engine-script.js';

/*
 * Computed world visuals: sky, lightning flashes, wall decals and surface animation
 * phases. Each test reproduced its failure before the fix it guards. The renderer
 * reads sector light levels and the decal/sky state asserted here rather than pixels,
 * so a headless run can prove the behaviour.
 */

/**
 * Three sectors in a row: s0 and s2 are indoor, s1 (tag 1) is the sector a line
 * special targets. `s1` can be turned into a sky sector, which is what a lightning
 * flash brightens.
 */
function skyRoom(s1 = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-256, -256], [0, -256], [256, -256], [512, -256], [512, 256], [256, 256], [0, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 0 },
    { id: 's1', floorHeight: 16, ceilingHeight: 96, light: 160, sky: false, tag: 1, ...s1 },
    { id: 's2', floorHeight: -32, ceilingHeight: 256, light: 160, sky: false, tag: 0 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('s0'), left: null, solid: true },
    { id: 'door', a: 'v1', b: 'v6', right: side('s0'), left: side('s1'), solid: false },
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

const light = (state, id) => state.sectors.find(sector => sector.id === id).light;

test('Light_ForceLightning brightens the sky and fades it back, leaving indoor sectors alone', () => {
  const project = skyRoom({ sky: true });
  const state = createRuntime(project);
  const result = executeSpecial(project, state, 109, [0], { format: 'zdoom', activator: 'player' });
  assert.equal(result, 1);
  assert.equal(light(state, 's1'), 231, 'the sky sector flashes to the lightning brightness at once');
  assert.equal(light(state, 's0'), 160, 'an indoor sector is not part of the flash');
  const motion = state.sectorMotions.get('s1:light');
  assert.ok(motion, 'a decay back to the original light level is scheduled');
  assert.equal(motion.surface, 'light');
  assert.equal(motion.height, 160, 'the fade target is the sector level from before the flash');
  assert.equal(motion.origin, 231);
  advanceSectors(state, 1);
  assert.equal(light(state, 's1'), 160, 'the flash has decayed to the original level');
  assert.equal(state.sectorMotions.size, 0, 'the decay motion is consumed');
});

test('Light_ForceLightning mode 2 stops the storm instead of flashing', () => {
  const project = skyRoom({ sky: true });
  const state = createRuntime(project);
  executeSpecial(project, state, 109, [2], { format: 'zdoom', activator: 'player' });
  assert.equal(light(state, 's1'), 160, 'stop-only mode does not brighten anything');
  assert.equal(state.sectorMotions.size, 0);
});

test('a sky sector brighter than the flash is not darkened by it', () => {
  const project = skyRoom({ sky: true, light: 240 });
  const state = createRuntime(project);
  executeSpecial(project, state, 109, [0], { format: 'zdoom', activator: 'player' });
  assert.equal(light(state, 's1'), 240);
  assert.equal(state.sectorMotions.size, 0);
});

test('a save taken while a light fade is running still loads', async () => {
  const project = skyRoom();
  const state = createRuntime(project);
  executeSpecial(project, state, 113, [1, 64, 35], { format: 'zdoom', activator: 'player' });
  assert.ok(state.sectorMotions.get('s1:light'), 'the fade is in progress');
  const identity = await gameSaveIdentity(project);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, identity)));
  const restored = restoreGameSave(project, record, identity);
  const motion = restored.runtime.sectorMotions.get('s1:light');
  assert.ok(motion, 'the fade survives the save');
  assert.equal(motion.surface, 'light');
});

test('a save taken during a lightning flash still loads and finishes the flash', async () => {
  const project = skyRoom({ sky: true });
  const state = createRuntime(project);
  executeSpecial(project, state, 109, [0], { format: 'zdoom', activator: 'player' });
  const identity = await gameSaveIdentity(project);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, identity)));
  const restored = restoreGameSave(project, record, identity);
  assert.equal(light(restored.runtime, 's1'), 231, 'the bright flash is part of the save');
  assert.ok(restored.runtime.sectorMotions.get('s1:light'), 'its decay also survives');
  advanceSectors(restored.runtime, 1);
  assert.equal(light(restored.runtime, 's1'), 160, 'the restored flash finishes fading');
});
