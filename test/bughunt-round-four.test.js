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
