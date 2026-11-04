import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { assembleGameLevels, nextGameLevel } from '../shared/game-levels.js';
import { createPath } from '../shared/paths.js';
import { startPathTween, advancePathTweens } from '../shared/timesheet.js';
import { parseDehacked } from '../shared/dehacked.js';
import { runActorFunction } from '../shared/actor-functions.js';
import { morphEntity, unmorphEntity } from '../shared/morph.js';
import { executeSpecial } from '../shared/line-specials.js';
import { createMapScripts } from '../shared/map-scripts.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { readProjectArchive } from '../server/project-archive.js';
import { projectZipEntries } from '../server/project-folder.js';
import { createZipArchive } from '../server/export-build.js';
import { createPlaytestLogStore } from '../server/playtest-logs.js';
import { createLogId, logFileName, normalizeLogEntry } from '../shared/playtest-log.js';

/*
 * Hunts 42 onward: the second engine-wide bug hunt (100 bugs counted from #42).
 * Each test reproduced its failure before the fix it guards.
 */

function morphActor(id, name, health) {
  return { id, name, flags: { MONSTER: true }, health, radius: 16, height: 32,
    states: { labels: { Spawn: 0 }, frames: [
      { kind: 'frame', sprite: 'MONS', letter: 'A', duration: 4, actions: [], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
    ] } };
}

/**
 * Three sectors in a row: s0 (untagged), s1 (tag 1) and s2 (untagged). The line between s0 and
 * s1 is a Hexen-format line carrying `special`/`args`, so map-script activation can be driven.
 */
function specialRoom({ special = 0, args = [], s1 = {}, entities = [] } = {}) {
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
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -40, y: 0, angle: 0 }, ...entities];
  installEngineScripts(project);
  validateProject(project);
  return project;
}

const motion = (state, sectorId, surface) => state.sectorMotions.get(`${sectorId}:${surface}`);

function zdoomSpecial(special, args, overrides = {}, options = {}) {
  const project = specialRoom(overrides);
  const state = createRuntime(project);
  const result = executeSpecial(project, state, special, args, { format: 'zdoom', activator: 'player', ...options });
  return { project, state, result };
}

test('hunt 42: campaign assembly accepts as many levels as a project may hold', () => {
  const entries = Array.from({ length: 129 }, (_, index) => ({ id: `L${String(index).padStart(3, '0')}`, project: installEngineScripts(createProject()) }));
  const { project } = assembleGameLevels(entries, 'L000', 'Long campaign');
  assert.equal(project.game.levels.length, 129);
  validateProject(project);
});

test('hunt 43: a secret exit with no secret destination continues to the normal next level', () => {
  const game = { active: 'A', levels: [{ id: 'A', next: 'B', secretNext: null }, { id: 'B', next: null, secretNext: null }] };
  assert.equal(nextGameLevel(game, true), 'B');
  assert.equal(nextGameLevel({ ...game, active: 'B' }, true), null);
});

test('hunt 44: following a closed route to its last waypoint completes the loop', () => {
  const project = createProject();
  project.paths = [createPath({ id: 'loop', closed: true, points: [
    { x: 0, y: 0, curve: 0 }, { x: 100, y: 0, curve: 0 }, { x: 100, y: 100, curve: 0 }, { x: 0, y: 100, curve: 0 }] })];
  project.map.entities = [{ id: 'cart', name: 'Cart', type: 'decoration', x: 0, y: 0, z: 0, angle: 0 }];
  const state = { entities: [{ ...project.map.entities[0] }] };
  startPathTween(state, { entityId: 'cart', pathId: 'loop', toPoint: -1, seconds: 4 });
  advancePathTweens(project, state, 3);
  assert.deepEqual([Math.round(state.entities[0].x), Math.round(state.entities[0].y)], [0, 100], 'three quarters is the last waypoint');
  advancePathTweens(project, state, 1);
  assert.deepEqual([Math.round(state.entities[0].x), Math.round(state.entities[0].y)], [0, 0], 'the closing segment is driven');
});

test('hunt 45: DEHACKED Text blocks are read as replacement strings', () => {
  const patch = parseDehacked('Patch File for DeHackEd v3.0\nText 4 4\nTROOPOSS\nText 10 6\nE1M1: Han\nGreat!\nThing 1 (Player)\nHit points = 50\n');
  assert.deepEqual(patch.texts, { TROO: 'POSS', 'E1M1: Han\n': 'Great!' });
  assert.equal(patch.things[1]['hit points'], '50');
  assert.deepEqual(patch.warnings, []);
});

test('hunt 46: actor functions move the world z an actor is drawn at', () => {
  const entity = { z: 128, elevation: 0 };
  assert.equal(runActorFunction(entity, 'z += 8').ran, true);
  assert.equal(entity.z, 136);
  assert.equal(entity.elevation, 8, 'the floor offset follows the same change');
});

test('hunt 47: morphing an already-morphed player keeps the original stats to restore', () => {
  const project = createProject();
  project.events = [];
  project.actors = [morphActor('actor_chicken', 'Chicken', 30), morphActor('actor_pig', 'Pig', 20)];
  const state = createRuntime(project);
  const player = state.entities.find(entity => entity.type === 'player');
  state.playerStats.health = 100;
  assert.equal(morphEntity(project, state, player, 'Chicken'), true);
  morphEntity(project, state, player, 'Pig');
  assert.equal(unmorphEntity(project, state, player, true), true);
  assert.equal(state.playerStats.health, 100);
});

test('hunt 48: archives with harmless double dots in file names are accepted', async () => {
  const project = createProject();
  const entries = [...projectZipEntries(project), { path: 'notes..txt', data: Buffer.from('hello'), mode: 0o644 }];
  const { project: restored } = await readProjectArchive(createZipArchive(entries, new Date('2026-01-01T00:00:00Z')));
  assert.equal(restored.title, project.title);
});

test('hunt 49: playtest log files respect their byte ceiling for non-ASCII text', t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-log-bytes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createPlaytestLogStore({ directory, maxFileBytes: 2000, maxEntries: 50 });
  const session = createLogId(Date.parse('2026-10-26T13:00:00Z'), () => 0.1);
  store.append(session, [normalizeLogEntry({ severity: 'error', category: 'acs', message: 'é'.repeat(900) }, { session })]);
  const file = join(directory, logFileName(session));
  assert.ok(statSync(file).size <= 2000, `log grew to ${statSync(file).size} bytes`);
});

test('hunt 50: Ceiling_LowerToFloor lowers the ceiling onto the floor', () => {
  const { state } = zdoomSpecial(254, [1, 16]);
  assert.equal(motion(state, 's1', 'ceilingHeight')?.height, 16);
});

test('hunt 51: Floor_RaiseToLowestCeiling raises to the lowest neighbouring ceiling, capped by its own', () => {
  const { state } = zdoomSpecial(238, [1, 16], { s1: { ceilingHeight: 300 } });
  assert.equal(motion(state, 's1', 'floorHeight')?.height, 160);
});

test('hunt 52: Floor_LowerToLowestCeiling lowers to the lowest neighbouring ceiling', () => {
  const { state } = zdoomSpecial(258, [1, 16], { s1: { floorHeight: 200, ceilingHeight: 300 } });
  assert.equal(motion(state, 's1', 'floorHeight')?.height, 160);
});

test('hunt 53: Floor_RaiseToCeiling raises to its own ceiling less the gap', () => {
  const { state } = zdoomSpecial(259, [1, 16, 0, 0, 8]);
  assert.equal(motion(state, 's1', 'floorHeight')?.height, 88);
});

test('hunt 54: Floor_LowerInstant and Floor_RaiseInstant move by height × 8', () => {
  const lower = zdoomSpecial(66, [1, 0, 2]);
  assert.equal(lower.state.sectors.find(sector => sector.id === 's1').floorHeight, 0);
  const raise = zdoomSpecial(67, [1, 0, 3]);
  assert.equal(raise.state.sectors.find(sector => sector.id === 's1').floorHeight, 40);
});

test('hunt 55: Plat_DownByValue reads its delay and height × 8 from the right arguments', () => {
  const { state } = zdoomSpecial(63, [1, 16, 35, 4]);
  const plat = motion(state, 's1', 'floorHeight');
  assert.equal(plat?.height, -16);
  assert.equal(plat.wait, 1);
  assert.equal(plat.returnMode, 'return');
  const up = zdoomSpecial(65, [1, 16, 70, 2]);
  assert.equal(motion(up.state, 's1', 'floorHeight')?.height, 32);
  assert.equal(motion(up.state, 's1', 'floorHeight').wait, 2);
});

test('hunt 56: Plat_RaiseAndStayTx0 rises to the next higher floor and stays', () => {
  const { state } = zdoomSpecial(228, [1, 16], { s1: { floorHeight: -64 } });
  const plat = motion(state, 's1', 'floorHeight');
  assert.equal(plat?.height, -32);
  assert.equal(plat.returnMode, 'stay');
});

test('hunt 57: Plat_UpByValueStayTx rises by height × 8 and stays', () => {
  const { state } = zdoomSpecial(230, [1, 16, 4]);
  const plat = motion(state, 's1', 'floorHeight');
  assert.equal(plat?.height, 48);
  assert.equal(plat.returnMode, 'stay');
});

test('hunt 58: Floor_RaiseAndCrush rises to 8 below the ceiling, not by its crush damage', () => {
  const { state } = zdoomSpecial(28, [1, 16, 10]);
  assert.equal(motion(state, 's1', 'floorHeight')?.height, 88);
});

test('hunt 59: Ceiling_CrushRaiseAndStay crushes down to the floor, then returns and stays', () => {
  const { state } = zdoomSpecial(45, [1, 16, 10]);
  const crusher = motion(state, 's1', 'ceilingHeight');
  assert.equal(crusher?.height, 24);
  assert.equal(crusher.returnMode, 'return');
  assert.equal(crusher.returnHeight, 96);
});

test('hunt 60: Ceiling_MoveToValue honours its negative flag', () => {
  const { state } = zdoomSpecial(47, [1, 16, 40, 1]);
  assert.equal(motion(state, 's1', 'ceilingHeight')?.height, -40);
  const times8 = zdoomSpecial(69, [1, 16, 5, 1]);
  assert.equal(motion(times8.state, 's1', 'ceilingHeight')?.height, -40);
});

test('hunt 61: FloorAndCeiling_LowerRaise opens both planes outward at their own speeds', () => {
  const { state } = zdoomSpecial(251, [1, 16, 32]);
  assert.equal(motion(state, 's1', 'floorHeight')?.height, -32);
  assert.equal(motion(state, 's1', 'ceilingHeight')?.height, 256);
  assert.equal(motion(state, 's1', 'ceilingHeight').speed, 4 * 35);
});

test('hunt 62: Door_CloseWaitOpen closes first and reopens after its octic delay', () => {
  const { state } = zdoomSpecial(249, [1, 16, 16]);
  const door = motion(state, 's1', 'ceilingHeight');
  assert.equal(door?.height, 16);
  assert.equal(door.wait, 2);
  assert.equal(door.returnMode, 'return');
});

test('hunt 63: Door_LockedRaise checks the lock argument, not the delay', () => {
  const locked = zdoomSpecial(13, [1, 16, 150, 1]);
  assert.equal(locked.result, 0, 'a blue-locked door refuses a player without the key');
  assert.equal(motion(locked.state, 's1', 'ceilingHeight'), undefined);
  const open = zdoomSpecial(13, [1, 16, 2, 0]);
  assert.equal(open.result, 1, 'an unlocked door whose delay is 2 tics opens');
  assert.ok(motion(open.state, 's1', 'ceilingHeight'));
});

test('hunt 64: ACS_ExecuteWithResult passes all four script arguments', () => {
  const calls = [];
  const scripts = { execute: (script, args, options) => { calls.push({ script, args, options }); return 7; } };
  const { result } = zdoomSpecial(84, [5, 11, 12, 13, 14], {}, { scripts });
  assert.equal(result, 7);
  assert.deepEqual(calls[0].args, [11, 12, 13, 14]);
});

test('hunt 65: ACS_LockedExecute(Door) runs the named script behind the fifth-argument lock', () => {
  const calls = [];
  const scripts = { execute: (script, args, options) => { calls.push({ script, args, always: options.always }); return true; } };
  zdoomSpecial(83, [5, 0, 11, 12, 0], {}, { scripts });
  assert.deepEqual(calls, [{ script: 5, args: [11, 12, 0], always: false }]);
  const locked = zdoomSpecial(85, [6, 0, 1, 2, 3], {}, { scripts });
  assert.equal(locked.result, 0, 'a red-card lock refuses without the key');
  assert.equal(calls.length, 1);
});

test('hunt 66: ACS_Suspend and ACS_Terminate name the script in their first argument', () => {
  const suspended = [], terminated = [];
  const scripts = { suspend: script => suspended.push(script), terminate: script => terminated.push(script) };
  zdoomSpecial(81, [7, 0], {}, { scripts });
  zdoomSpecial(82, [8, 0], {}, { scripts });
  assert.deepEqual([suspended, terminated], [[7], [8]]);
});

test('hunt 67: Thing_Move puts the thing on the map spot named by its second argument', () => {
  const entities = [
    { id: 'imp', name: 'Imp', type: 'enemy', x: 300, y: 0, angle: 0, tid: 4 },
    { id: 'spot', name: 'Spot', type: 'decoration', x: 100, y: 50, angle: 0, tid: 9 },
  ];
  const { state } = zdoomSpecial(125, [4, 9], { entities });
  const imp = state.entities.find(entity => entity.id === 'imp');
  assert.deepEqual([imp.x, imp.y], [100, 50]);
});

test('hunt 68: Teleport goes to the destination thing named by tid, inside the optional tagged sector', () => {
  const entities = [{ id: 'dest', name: 'Teleport destination', type: 'decoration', doomType: 14, x: 400, y: 0, angle: 90, tid: 3 }];
  const { state, result } = zdoomSpecial(70, [3, 0], { entities });
  assert.equal(result, 1);
  assert.deepEqual([state.player.x, state.player.y], [400, 0]);
  const noFog = zdoomSpecial(71, [3, 1, 0], { entities });
  assert.deepEqual([noFog.state.player.x, noFog.state.player.y], [400, 0]);
});

test('hunt 69: a teleported player lands on the destination floor', () => {
  const entities = [{ id: 'dest', name: 'Teleport destination', type: 'decoration', doomType: 14, x: 400, y: 0, angle: 90, tid: 3 }];
  const { state } = zdoomSpecial(70, [3, 0], { entities });
  assert.equal(state.player.z, -32);
});

test('hunt 70: Line_SetTextureOffset reads fixed-point offsets', () => {
  const project = specialRoom();
  project.map.walls.find(wall => wall.id === 'door').tag = 5;
  const state = createRuntime(project);
  executeSpecial(project, state, 53, [5, 8 * 65536, -4 * 65536, 0, 2], { format: 'zdoom' });
  const wall = state.walls.find(item => item.id === 'door');
  assert.deepEqual([wall.right.offsetX, wall.right.offsetY], [8, -4]);
  executeSpecial(project, state, 53, [5, 32767 * 65536, 2 * 65536, 0, 2 | 8], { format: 'zdoom' });
  assert.deepEqual([wall.right.offsetX, wall.right.offsetY], [8, -2], 'NO_CHANGE keeps x; flag 8 adds to y');
  executeSpecial(project, state, 53, [5, 3 * 65536, 32767 * 65536, 1, 2], { format: 'zdoom' });
  assert.equal(wall.left.offsetX, 3, 'side 1 is the back side');
  assert.equal(wall.right.offsetX, 8);
});

test('hunt 71: specials started by ACS use Hexen argument units', () => {
  const project = specialRoom();
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  scripts.host.executeSpecial(11, [1, 64]);
  assert.equal(motion(state, 's1', 'ceilingHeight')?.speed, 8 * 35, 'Door_Open speed 64 is 8 units per tic');
});

test('hunt 72: a used Hexen door line with tag 0 opens the sector behind it', () => {
  const project = specialRoom({ special: 11, args: [0, 64] });
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  assert.equal(scripts.activate(project.map.walls.find(wall => wall.id === 'door'), 'use'), true);
  const door = motion(state, 's1', 'ceilingHeight');
  assert.ok(door, 'the back sector opens');
  assert.equal(door.speed, 8 * 35);
});
