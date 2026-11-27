import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime } from '../shared/runtime.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { buildVanillaActors } from '../shared/actors.js';

test('A save taken after a script spawned an actor loads again', () => {
  const project = installEngineScripts(createProject());
  project.actors = buildVanillaActors();
  const state = createRuntime(project);
  state.hasGame = true;
  // A plain level saves before anything is spawned, which is what hid this: the engine's own
  // spawner for scripts names its things `acs_spawn_N`, and the validator only accepted the
  // `spawned_N` an actor action makes — so any game that had run a spawn script could not be
  // saved at all ("unknown entity acs_spawn_1 (an addon changed the runtime state)").
  assert.doesNotThrow(() => captureGameSave(project, state, 'probe'));
  state.scripts.host.spawn({ type: 'DoomImp', tid: 4, x: state.player.x + 64, y: state.player.y });
  const spawned = state.entities.find(entity => entity.type === 'enemy');
  assert.match(spawned.id, /^acs_spawn_/);
  const record = captureGameSave(project, state, 'probe');
  const restored = restoreGameSave(project, record, 'probe');
  const again = restored.runtime.entities.find(entity => entity.type === 'enemy');
  assert.equal(again?.health, 60, 'the spawned monster is in the save with its health');
  assert.equal(again?.actor, 'actor_doomimp');
});

test('Door_CloseWaitOpen shuts the door and opens it again, as GZDoom does', async () => {
  const { installWorldScripts } = await import('../shared/world-motion.js');
  const project = installEngineScripts(createProject());
  const map = project.map;
  map.sectors[0].tag = 4;
  map.sectors.push({ id: 'room1', floorHeight: 0, ceilingHeight: 128, light: 208, sky: false, tag: 4 });
  map.vertices.push({ id: 'v5', x: 640, y: 0 }, { id: 'v6', x: 640, y: -640 });
  map.walls.push({ id: 'w5', a: 'v2', b: 'v5', height: 256, solid: true, right: { sectorId: 'room0' }, left: { sectorId: 'room1' } });
  map.walls[0].tag = 4;
  map.walls[0].specialFormat = 'doom';
  map.walls[0].args = [4, 0, 0, 0, 0];
  for (const special of [16, 76]) {
    map.walls[0].special = special;
    const before = project.events.length;
    installWorldScripts(project, []);
    const moves = project.events.slice(before).flatMap(event => (event.actions || []).filter(action => action.type === 'moveSector'));
    assert.ok(moves.length, `special ${special} produces a move`);
    for (const move of moves) {
      // xlat/base.txt: `Door_CloseWaitOpen (tag, D_SLOW, 240)` — shut, wait 240 tics, open again.
      assert.equal(move.returnMode, 'return', `special ${special} comes back`);
      assert.ok(Math.abs(move.wait - 240 / 35) < .05, `special ${special} waits 240 tics, not ${move.wait}`);
      assert.equal(move.speed, 70, 'D_SLOW is two units a tic');
    }
  }
});

test('Classic platforms and ceilings use the speeds and targets the xlat table names', async () => {
  const { installWorldScripts } = await import('../shared/world-motion.js');
  const movesFor = special => {
    const project = installEngineScripts(createProject());
    const map = project.map;
    map.sectors[0].tag = 9;
    map.sectors.push({ id: 'room1', floorHeight: 64, ceilingHeight: 192, light: 208, sky: false, tag: 9 });
    map.vertices.push({ id: 'v5', x: 640, y: 0 }, { id: 'v6', x: 640, y: -640 });
    map.walls.push({ id: 'w5', a: 'v2', b: 'v5', height: 256, solid: true, right: { sectorId: 'room0' }, left: { sectorId: 'room1' } });
    map.walls[0].tag = 9;
    map.walls[0].specialFormat = 'doom';
    map.walls[0].args = [9, 0, 0, 0, 0];
    map.walls[0].special = special;
    const before = project.events.length;
    installWorldScripts(project, []);
    return project.events.slice(before).flatMap(event => (event.actions || []).filter(action => action.type === 'moveSector'));
  };
  // `Plat_RaiseAndStayTx0 (tag, P_SLOW/2)`: half of one unit a tic.
  for (const special of [20, 22, 68, 14]) assert.ok(movesFor(special).every(m => m.speed === 17.5), `special ${special}`);
  // `Ceiling_LowerAndCrush (tag, C_SLOW, 0, 2)` and the generic ceiling: one unit a tic.
  for (const special of [44, 40]) assert.ok(movesFor(special).every(m => m.speed === 35), `special ${special}`);
  // `Generic_Ceiling (tag, C_SLOW, 0, 1, 8)` is `ceilRaiseToHighest`, and it moves nothing else:
  // translating it as ceiling-and-floor raised the floor above the ceiling it had just found.
  const ceilingOnly = movesFor(40);
  assert.ok(ceilingOnly.every(m => m.surface === 'ceilingHeight'), 'special 40 moves the ceiling alone');
  assert.deepEqual(ceilingOnly.map(m => m.height).sort((a, b) => a - b), [128, 192], 'up to the highest neighbouring ceiling');
});

test('The parser and renderer defects a fourth round of hunting found', async () => {
  const { parseSurfaceAnimations } = await import('../shared/animdefs.js');
  const { parseSndInfo, soundTable, soundCandidates, VANILLA_SOUNDS } = await import('../shared/sndinfo.js');
  // ANIMDEFS: a `sound` clause between `on` and `pic` is valid, and a braceless declaration
  // continues with `pic` frames. Both were dropped, so the switches did nothing and every
  // such animation was one frozen frame.
  const animdefs = parseSurfaceAnimations([`
texture M_SLCTR1 pic M_SLCTR1 tics 16 pic M_SLCTR2 tics 16
switch HEXASWA1 on sound Switch1 pic HEXASWA2 tics 0
`]);
  assert.deepEqual(animdefs.switchPairs, [{ off: 'HEXASWA1', on: 'HEXASWA2' }]);
  assert.equal(animdefs.sequences[0].frames.length, 2, 'a braceless declaration keeps its pictures');
  // SNDINFO: a quoted path is a target, and the asset a pack keeps is the file name alone.
  const table = soundTable(VANILLA_SOUNDS, parseSndInfo('qgrunt/sight\t"sounds/grunt/grunt-sight.wav"\n'));
  const candidates = soundCandidates('qgrunt/sight', table).map(name => name.toUpperCase());
  assert.ok(candidates.includes('GRUNT-SIGHT'), `resolves to the file name: ${candidates.join(', ')}`);
});

test('Brush boolean and formation defects are gone', async () => {
  const { createBoxBrush, subtractBrush, brushContains, brushSurfaceAt, mergeBrushes } = await import('../shared/brushes.js');
  const { createProject } = await import('../shared/project.js');
  const project = createProject();
  project.map.brushes = [];
  const target = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, height: 64, depth: 64 });
  const cutterA = createBoxBrush(project, { x: 0, y: 20, z: 0, width: 64, height: 20, depth: 20 });
  const cutterB = createBoxBrush(project, { x: 20, y: 0, z: 0, width: 20, height: 20, depth: 64 });
  subtractBrush(project, target.id, [cutterA.id, cutterB.id]);
  const pieces = project.map.brushes.filter(brush => brush.id !== cutterA.id && brush.id !== cutterB.id);
  // Both cutters must be gone, not only the box where they overlap.
  for (const point of [[32, 20, 20], [20, 32, 32]]) {
    assert.ok(!pieces.some(brush => brushContains(brush, point, -1e-6)), `(${point}) is carved out`);
  }
  // Two boxes side by side merge into six faces, not ten with a doubled wall.
  project.map.brushes = [];
  const left = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, height: 64, depth: 64 });
  const right = createBoxBrush(project, { x: 64, y: 0, z: 0, width: 64, height: 64, depth: 64 });
  const merged = mergeBrushes(project, [left.id, right.id]);
  assert.equal(merged.faces.length, 6, 'a convex solid has one face per plane');
});
