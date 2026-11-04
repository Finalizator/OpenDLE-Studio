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
import { createProgram, createAcsVm, startScript, tickAcs, PCODE_NAMES } from '../shared/acs.js';
import { ACTIONS, actorStateOf } from '../shared/actor-runtime.js';
import { translationLookup, packColour } from '../shared/translation.js';
import { advanceSectors } from '../shared/world-motion.js';
import { moveEnemy } from '../shared/combat.js';
import { parseUDMF, udmfRecords } from '../shared/udmf.js';
import { importActors } from '../shared/actors.js';
import { weaponAmmo, beginWeapon, weaponTic } from '../shared/actor-runtime.js';

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
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -40, y: 0, angle: 0 }, ...entities.map(entity => ({ angle: 0, ...entity }))];
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

/** A one-script ACS module (script 1, closed) built from pcode names and pushed numbers. */
function acsLump(ops) {
  const code = [];
  const word = value => code.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  for (const op of ops) {
    if (typeof op === 'number') { code.push(PCODE_NAMES.indexOf('PUSHNUMBER')); word(op); continue; }
    const pcode = PCODE_NAMES.indexOf(op);
    if (pcode >= 240) code.push(0xf0, pcode - 240); else code.push(pcode);
  }
  code.push(PCODE_NAMES.indexOf('TERMINATE'));
  const bytes = [0x41, 0x43, 0x53, 0, 0, 0, 0, 0, ...code];
  const chunkStart = bytes.length;
  bytes.push(...'SPTR'.split('').map(char => char.charCodeAt(0)), 8, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0);
  while (bytes.length % 4) bytes.push(0);
  bytes.push(chunkStart & 0xff, (chunkStart >> 8) & 0xff, 0, 0, ...'ACSe'.split('').map(char => char.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 0);
  const dirofs = bytes.length - 8;
  bytes[4] = dirofs & 0xff; bytes[5] = (dirofs >> 8) & 0xff;
  return createProgram([{ name: 'BEHAVIOR', bytes: new Uint8Array(bytes) }]);
}

function runAcs(ops, host = {}) {
  const vm = createAcsVm(acsLump(ops), host);
  startScript(vm, 1);
  tickAcs(vm);
  return vm;
}

test('hunt 73: FixedDiv by zero terminates the script like integer division', () => {
  const calls = [];
  const vm = runAcs([65536, 0, 'FIXEDDIV', 'DROP', 7, 2, 'SETLINEBLOCKING'], { setLineBlocking: (...args) => calls.push(args) });
  assert.deepEqual(calls, [], 'the script stops at the division');
  assert.ok(vm.errors.some(error => /division by zero/.test(error)), vm.errors.join('\n'));
});

test('hunt 74: ThingCountSector counts things in every sector with the tag', () => {
  const project = specialRoom({ entities: [
    { id: 'a', type: 'pickup', name: 'A', x: 128, y: 0, doomType: 2011 },
    { id: 'b', type: 'pickup', name: 'B', x: 384, y: 0, doomType: 2011 }] });
  project.map.sectors.find(sector => sector.id === 's2').tag = 1;
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  assert.equal(scripts.host.thingCount({ type: 2011, tid: 0, tag: 1 }), 2);
});

test('hunt 75: SetActorPosition with tid 0 moves the activator', () => {
  const project = specialRoom({ entities: [{ id: 'imp', type: 'enemy', name: 'Imp', x: -100, y: 0, health: 60 }] });
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  assert.equal(scripts.host.setActorPosition(0, -120 * 65536, 32 * 65536, 0, 0, 'player'), 1);
  assert.deepEqual([state.player.x, state.player.y], [-120, 32]);
  const imp = state.entities.find(entity => entity.id === 'imp');
  assert.equal(scripts.host.setActorPosition(0, -90 * 65536, 10 * 65536, 0, 0, imp), 1);
  assert.deepEqual([imp.x, imp.y], [-90, 10], 'a monster activator moves itself');
  assert.equal(scripts.host.getActor(0, 'x', imp), -90 * 65536, 'GetActorX(0) reads the activator too');
});

function jumpActor() {
  return { id: 'watcher', name: 'Watcher', flags: { MONSTER: true }, health: 50, radius: 16, height: 56,
    states: { labels: { Spawn: 0, Seen: 2 }, frames: [
      { kind: 'frame', sprite: 'MONS', letter: 'A', duration: 4, actions: [], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
      { kind: 'frame', sprite: 'MONS', letter: 'B', duration: 4, actions: [], label: 'Seen' },
      { kind: 'stop' },
    ] } };
}

function actorRoom(entities) {
  const project = specialRoom({ entities });
  project.actors = [jumpActor()];
  const state = createRuntime(project);
  const ctxFor = (id, args) => ({ project, state, entity: state.entities.find(entity => entity.id === id), actor: project.actors[0], args, named: {} });
  return { project, state, ctxFor };
}

test('hunt 76: A_JumpIfTargetInLOS jumps to its label only when the target is in sight', () => {
  const { state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  state.player.x = 200; state.player.y = 0;
  const watcher = state.entities.find(entity => entity.id === 'w');
  actorStateOf(watcher).index = 0;
  ACTIONS.A_JumpIfTargetInLOS(ctxFor('w', ['Seen']));
  assert.equal(actorStateOf(watcher).index, 2, 'the open room lets it see the player');
  actorStateOf(watcher).index = 0;
  state.walls.find(wall => wall.id === 'door').left = null;
  ACTIONS.A_JumpIfTargetInLOS(ctxFor('w', ['Seen']));
  assert.equal(actorStateOf(watcher).index, 0, 'a wall between them blocks the jump');
});

test('hunt 77: A_JumpIfInTargetInventory checks the target, not the caller', () => {
  const { state, ctxFor } = actorRoom([
    { id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 },
    { id: 'friend', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -60, y: 0, health: 50 }]);
  const watcher = state.entities.find(entity => entity.id === 'w');
  const friend = state.entities.find(entity => entity.id === 'friend');
  watcher.targetId = 'friend';
  actorStateOf(friend).inventory.set('Key', 1);
  actorStateOf(watcher).index = 0;
  ACTIONS.A_JumpIfInTargetInventory(ctxFor('w', ['Key', 1, 'Seen']));
  assert.equal(actorStateOf(watcher).index, 2);
});

test('hunt 78: A_GiveToTarget gives the item to the target', () => {
  const { state, ctxFor } = actorRoom([
    { id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 },
    { id: 'friend', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -60, y: 0, health: 50 }]);
  const watcher = state.entities.find(entity => entity.id === 'w');
  const friend = state.entities.find(entity => entity.id === 'friend');
  watcher.targetId = 'friend';
  ACTIONS.A_GiveToTarget(ctxFor('w', ['Gem', 2]));
  assert.equal(actorStateOf(friend).inventory.get('Gem'), 2);
  assert.equal(actorStateOf(watcher).inventory.get('Gem') ?? 0, 0);
});

test('hunt 79: translations accept direct RGB gradients', () => {
  const palette = new Uint8Array(768);
  for (let index = 0; index < 256; index++) palette.fill(index, index * 3, index * 3 + 3);
  const { lookup, unsupported } = translationLookup(['0:2=[0,0,0]:[200,100,50]', '9=4'], palette);
  assert.deepEqual(unsupported, []);
  assert.equal(lookup.get(packColour(1, 1, 1)), packColour(100, 50, 25));
  assert.equal(lookup.get(packColour(2, 2, 2)), packColour(200, 100, 50));
  assert.equal(lookup.get(packColour(9, 9, 9)), packColour(4, 4, 4));
});

test('hunt 80: DamageThing hurts its activator, and zero damage kills', () => {
  const project = specialRoom({ entities: [{ id: 'imp', type: 'enemy', name: 'Imp', x: -100, y: 0, health: 60 }] });
  const state = createRuntime(project);
  executeSpecial(project, state, 73, [10], { format: 'zdoom', activator: 'imp' });
  assert.equal(state.entities.find(entity => entity.id === 'imp').health, 50);
  assert.equal(state.playerStats.health, 100, 'the player was not the activator');
  executeSpecial(project, state, 73, [0], { format: 'zdoom', activator: 'player' });
  assert.equal(state.playerStats.health, 0, 'zero damage is a guaranteed kill');
});

test('hunt 81: HealThing heals up to its max argument', () => {
  const { state, project } = zdoomSpecial(0, []);
  executeSpecial(project, state, 248, [50, 200], { format: 'zdoom', activator: 'player' });
  assert.equal(state.playerStats.health, 150);
  executeSpecial(project, state, 248, [100, 1], { format: 'zdoom', activator: 'player' });
  assert.equal(state.playerStats.health, 200, 'max 1 is the soulsphere limit');
});

test('hunt 82: Thing_Destroy kills things instead of deleting them', () => {
  const project = specialRoom({ entities: [
    { id: 'imp', type: 'enemy', name: 'Imp', x: -100, y: 0, health: 60, tid: 4 },
    { id: 'imp2', type: 'enemy', name: 'Imp', x: 128, y: 0, health: 60 }] });
  const state = createRuntime(project);
  executeSpecial(project, state, 133, [4, 0, 0], { format: 'zdoom' });
  const imp = state.entities.find(entity => entity.id === 'imp');
  assert.ok(imp, 'the thing is still there to play its death');
  assert.equal(imp.health, 0);
  executeSpecial(project, state, 133, [0, 0, 1], { format: 'zdoom' });
  assert.equal(state.entities.find(entity => entity.id === 'imp2').health, 0, 'tid 0 with a tag kills in the tagged sectors');
});

test('hunt 83: Thing_Remove with tid 0 removes the activator', () => {
  const project = specialRoom({ entities: [{ id: 'imp', type: 'enemy', name: 'Imp', x: -100, y: 0, health: 60 }] });
  const state = createRuntime(project);
  assert.equal(executeSpecial(project, state, 132, [0], { format: 'zdoom', activator: 'imp',
    onRemove: entity => { state.entities = state.entities.filter(other => other !== entity); } }), 1);
  assert.equal(state.entities.find(entity => entity.id === 'imp'), undefined);
});

test('hunt 84: Thing_Spawn gives the new thing its newtid', () => {
  const spawned = [];
  const project = specialRoom({ entities: [{ id: 'spot', type: 'decoration', name: 'Spot', x: -100, y: 0, tid: 3 }] });
  const state = createRuntime(project);
  executeSpecial(project, state, 135, [3, 1, 0, 9], { format: 'zdoom', spawn: payload => { spawned.push(payload); return 1; } });
  executeSpecial(project, state, 139, [3, 1, 0, 11], { format: 'zdoom', spawn: payload => { spawned.push(payload); return 1; } });
  assert.deepEqual(spawned.map(payload => payload.tid), [9, 11]);
});

test('hunt 85: Line_SetBlocking reads set and clear flag masks', () => {
  const project = specialRoom();
  project.map.walls.find(wall => wall.id === 'mid').tag = 5;
  const state = createRuntime(project);
  const mid = state.walls.find(wall => wall.id === 'mid');
  executeSpecial(project, state, 55, [5, 32, 0], { format: 'zdoom' });
  assert.equal(mid.solid, true, 'BLOCKEVERYTHING (32) blocks');
  executeSpecial(project, state, 55, [5, 0, 32], { format: 'zdoom' });
  assert.equal(mid.solid, false, 'clearing it unblocks');
  executeSpecial(project, state, 55, [5, 2, 0], { format: 'zdoom' });
  assert.equal(mid.solid, false, 'BLOCKMONSTERS leaves the line open to players');
  assert.equal(mid.flags & 2, 2);
});

test('hunt 86: SetLineBlocking and SetLineMonsterBlocking pop line id and mode in call order', () => {
  const calls = [];
  runAcs([7, 2, 'SETLINEBLOCKING', 8, 1, 'SETLINEMONSTERBLOCKING'], {
    setLineBlocking: (...args) => calls.push(['block', ...args]),
    setLineMonsterBlocking: (...args) => calls.push(['monster', ...args]) });
  assert.deepEqual(calls, [['block', 7, 2], ['monster', 8, true]]);
});

test('hunt 87: SetLineBlocking BLOCK_NOTHING keeps one-sided walls solid', () => {
  const project = specialRoom();
  project.map.walls.find(wall => wall.id === 'w0').tag = 6;
  project.map.walls.find(wall => wall.id === 'mid').tag = 6;
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  scripts.host.setLineBlocking(6, 2);
  assert.equal(state.walls.find(wall => wall.id === 'mid').solid, true);
  scripts.host.setLineBlocking(6, 0);
  assert.equal(state.walls.find(wall => wall.id === 'w0').solid, true, 'a one-sided wall cannot be opened');
  assert.equal(state.walls.find(wall => wall.id === 'mid').solid, false);
});

test('hunt 88: Light_Fade fades over its tics', () => {
  const { state } = zdoomSpecial(113, [1, 64, 35]);
  const sector = state.sectors.find(item => item.id === 's1');
  assert.equal(sector.light, 160, 'nothing changes at once');
  advanceSectors(state, .5);
  assert.equal(Math.round(sector.light), 112);
  advanceSectors(state, .6);
  assert.equal(sector.light, 64);
  assert.equal(state.sectorMotions.size, 0);
});

test('hunt 89: things spawned by ACS in one tic get distinct ids even after a removal', () => {
  const project = specialRoom({ entities: [{ id: 'crate', type: 'decoration', name: 'Crate', x: 100, y: 0 }] });
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  scripts.host.spawn({ type: 2011, x: -100, y: 0 });
  state.entities = state.entities.filter(entity => entity.id !== 'crate');
  scripts.host.spawn({ type: 2011, x: -120, y: 0 });
  const ids = state.entities.filter(entity => entity.id.startsWith('acs_spawn')).map(entity => entity.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('hunt 90: a monster killed by a special stops blocking like one shot dead', () => {
  const project = specialRoom({ entities: [{ id: 'imp', type: 'enemy', name: 'Imp', x: -100, y: 0, health: 20, tid: 2 }] });
  const state = createRuntime(project);
  executeSpecial(project, state, 119, [2, 50], { format: 'zdoom' });
  const imp = state.entities.find(entity => entity.id === 'imp');
  assert.equal(imp.health, 0);
  assert.equal(imp.solid, false);
});

test('hunt 91: A_JumpIfCloser measures the distance to the actor target', () => {
  const { state, ctxFor } = actorRoom([
    { id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 },
    { id: 'friend', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -60, y: 0, health: 50 }]);
  state.player.x = 384;
  const watcher = state.entities.find(entity => entity.id === 'w');
  watcher.targetId = 'friend';
  actorStateOf(watcher).index = 0;
  ACTIONS.A_JumpIfCloser(ctxFor('w', [100, 'Seen']));
  assert.equal(actorStateOf(watcher).index, 2, 'its target is 40 away even though the player is far');
});

test('hunt 92: monsters do not walk through monster-blocking lines', () => {
  const project = specialRoom();
  const mid = project.map.walls.find(wall => wall.id === 'mid');
  mid.flags = 2;
  const state = createRuntime(project);
  state.sectors.find(sector => sector.id === 's2').floorHeight = 16;
  const imp = { id: 'imp', type: 'enemy', x: 240, y: 0, z: 16, health: 50, angle: 0 };
  state.entities.push(imp);
  let crossed = false;
  for (let index = 0; index < 40 && !crossed; index++) {
    moveEnemy(state, imp, 64, .1, { x: 400, y: 0 });
    if (imp.x > 256) crossed = true;
  }
  assert.equal(crossed, false);
  const udmf = udmfRecords(parseUDMF('namespace = "zdoom";\nvertex { x = 0; y = 0; }\nvertex { x = 64; y = 0; }\nsidedef { sector = 0; }\nsector { heightfloor = 0; heightceiling = 128; }\nlinedef { v1 = 0; v2 = 1; sidefront = 0; blockmonsters = true; }\n'));
  assert.equal(udmf.lines[0].flags & 2, 2, 'UDMF keeps the monster-blocking flag');
});

test('hunt 93: SetLineMonsterBlocking blocks monsters without walling off the player', () => {
  const project = specialRoom();
  project.map.walls.find(wall => wall.id === 'mid').tag = 6;
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  const mid = state.walls.find(wall => wall.id === 'mid');
  scripts.host.setLineMonsterBlocking(6, true);
  assert.equal(mid.solid, false, 'players still pass');
  assert.equal(mid.flags & 2, 2);
  scripts.host.setLineMonsterBlocking(6, false);
  assert.equal(mid.flags & 2, 0);
});


test('hunt 94: ACS health gifts stop at the item\'s own maximum and never lower health', () => {
  const project = specialRoom();
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  state.playerStats.health = 95;
  scripts.host.giveInventory('Stimpack', 1);
  assert.equal(state.playerStats.health, 100, 'a stimpack heals up to 100');
  state.playerStats.health = 150;
  scripts.host.giveInventory('Medikit', 1);
  assert.equal(state.playerStats.health, 150, 'a medikit does nothing above 100');
  scripts.host.giveInventory('HealthBonus', 3);
  assert.equal(state.playerStats.health, 153, 'bonuses go on to 200');
  scripts.host.giveInventory('Soulsphere', 1);
  assert.equal(state.playerStats.health, 200);
});

test('hunt 95: Weapon.AmmoUse 0 fires without spending ammo', () => {
  const { actors } = importActors({ sources: [{ name: 'w.zs', text: `
class Pistol : Weapon
{
  Default { Weapon.AmmoType "Clip"; Weapon.AmmoUse 0; }
  States { Ready: PISG A 1 A_WeaponReady; Loop; Fire: PISG A 1 A_FirePistol; PISG A 1; Goto Ready; }
}` }], warnings: [] });
  const gun = actors.find(actor => actor.name === 'Pistol');
  assert.equal(gun.weaponAmmoUse, 0);
  assert.equal(weaponAmmo(gun).use, 0);
  const project = specialRoom();
  project.actors = actors;
  const state = createRuntime(project);
  const fire = bullets => {
    state.playerStats.bullets = bullets;
    state.weaponAttack = null;
    beginWeapon(project, state, 'pistol');
    state.weaponTriggerHeld = true;
    for (let tic = 0; tic < 6 && !state.weaponAttack; tic++) weaponTic(project, state, true);
  };
  fire(0);
  assert.ok(state.weaponAttack, 'the weapon fires with an empty clip');
  fire(5);
  assert.ok(state.weaponAttack);
  assert.equal(state.playerStats.bullets, 5, 'and spends nothing');
});

test('hunt 96: A_KeenDie opens tag 666 when the last Keen dies and kills nobody', () => {
  const project = specialRoom({ entities: [
    { id: 'k1', type: 'enemy', name: 'Keen', x: -100, y: 0, health: 0 },
    { id: 'k2', type: 'enemy', name: 'Keen', x: -50, y: 0, health: 100 },
    { id: 'imp', type: 'enemy', name: 'Imp', x: 300, y: 0, health: 60 },
  ] });
  project.map.sectors.find(sector => sector.id === 's1').tag = 666;
  const state = createRuntime(project);
  const keen = id => state.entities.find(entity => entity.id === id);
  for (const id of ['k1', 'k2']) keen(id).actorName = 'CommanderKeen';
  keen('imp').actorName = 'DoomImp';
  const actor = { name: 'CommanderKeen', states: { frames: [], labels: {} } };
  ACTIONS.A_KeenDie({ project, state, entity: keen('k1'), actor, args: [], named: {} });
  assert.equal(keen('imp').health, 60, 'other monsters live on');
  assert.equal(keen('k2').health, 100, 'other Keens live on');
  assert.equal(motion(state, 's1', 'ceilingHeight'), undefined, 'a Keen is still alive');
  keen('k2').health = 0;
  ACTIONS.A_KeenDie({ project, state, entity: keen('k2'), actor, args: [], named: {} });
  assert.ok(motion(state, 's1', 'ceilingHeight'), 'the last Keen opens the tag 666 door');
});

test('hunt 97: A_JumpIfInventory with amount 0 needs the item at its maximum', () => {
  const { project, state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  project.actors.push({ id: 'actor_token', name: 'Token', flags: { INVENTORY: true }, inventoryMaxAmount: 3, states: { frames: [], labels: {} } });
  const watcher = state.entities.find(entity => entity.id === 'w');
  const runtime = actorStateOf(watcher);
  runtime.index = 0;
  ACTIONS.A_JumpIfInventory(ctxFor('w', ['Token', 0, 'Seen']));
  assert.equal(runtime.index, 0, 'no token, no jump');
  runtime.inventory.set('Token', 2);
  ACTIONS.A_JumpIfInventory(ctxFor('w', ['Token', 0, 'Seen']));
  assert.equal(runtime.index, 0, 'two of three is not full');
  runtime.inventory.set('Token', 3);
  ACTIONS.A_JumpIfInventory(ctxFor('w', ['Token', 0, 'Seen']));
  assert.equal(runtime.index, 2, 'a full token jumps');
});

test('hunt 98: conditional jumps never treat their pointer argument as another label', () => {
  const { state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  const watcher = state.entities.find(entity => entity.id === 'w');
  const runtime = actorStateOf(watcher);
  runtime.inventory.set('Token', 1);
  for (let attempt = 0; attempt < 24; attempt++) {
    runtime.index = 0;
    ACTIONS.A_JumpIfHealthLower(ctxFor('w', [60, 'Seen', 'AAPTR_DEFAULT']));
    assert.equal(runtime.index, 2, 'A_JumpIfHealthLower always takes its label');
    runtime.index = 0;
    ACTIONS.A_JumpIfInventory(ctxFor('w', ['Token', 1, 'Seen', 'AAPTR_DEFAULT']));
    assert.equal(runtime.index, 2, 'A_JumpIfInventory always takes its label');
  }
});

test('hunt 99: A_TakeInventory without an amount takes every item', () => {
  const { state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  const runtime = actorStateOf(state.entities.find(entity => entity.id === 'w'));
  runtime.inventory.set('Token', 5);
  ACTIONS.A_TakeInventory(ctxFor('w', ['Token']));
  assert.equal(runtime.inventory.get('Token') || 0, 0);
  runtime.inventory.set('Token', 5);
  ACTIONS.A_TakeInventory(ctxFor('w', ['Token', 0]));
  assert.equal(runtime.inventory.get('Token') || 0, 0);
  runtime.inventory.set('Token', 5);
  ACTIONS.A_TakeInventory(ctxFor('w', ['Token', 2]));
  assert.equal(runtime.inventory.get('Token'), 3);
});

test('hunt 100: A_GiveInventory with amount 0 gives one item', () => {
  const { state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  const runtime = actorStateOf(state.entities.find(entity => entity.id === 'w'));
  ACTIONS.A_GiveInventory(ctxFor('w', ['Token', 0]));
  assert.equal(runtime.inventory.get('Token'), 1);
});

test('hunt 101: A_GiveInventory respects the item\'s Inventory.MaxAmount', () => {
  const { project, state, ctxFor } = actorRoom([{ id: 'w', type: 'enemy', name: 'Watcher', actor: 'watcher', x: -100, y: 0, health: 50 }]);
  project.actors.push({ id: 'actor_token', name: 'Token', flags: { INVENTORY: true }, inventoryMaxAmount: 3, states: { frames: [], labels: {} } });
  const runtime = actorStateOf(state.entities.find(entity => entity.id === 'w'));
  ACTIONS.A_GiveInventory(ctxFor('w', ['Token', 5]));
  assert.equal(runtime.inventory.get('Token'), 3);
});

function spawnFixture() {
  const { actors } = importActors({ sources: [{ name: 's.zs', text: `
class TestPuff : Actor { States { Spawn: PUFF A 3; Stop; } }` }], warnings: [] });
  const project = specialRoom({ entities: [{ id: 'm', type: 'enemy', name: 'Spawner', x: -100, y: 0, health: 50, angle: 90 }] });
  project.actors = actors;
  project.assets = ['PUFFA0'].map(name => ({ id: `asset_${name}`, name, kind: 'sprite', width: 16, height: 16,
    offsetX: 8, offsetY: 16, src: 'data:image/png;base64,iVBORw0KGgo=' }));
  const state = createRuntime(project);
  const entity = state.entities.find(item => item.id === 'm');
  entity.angle = 90; entity.z = 0;
  const run = (name, args) => { state.impacts = []; ACTIONS[name]({ project, state, entity, actor: actors[0], args, named: {} }); return state.impacts[0]; };
  return { run, entity };
}

test('hunt 102: A_SpawnItemEx offsets are forward (x) and right (y) of the spawner', () => {
  const { run, entity } = spawnFixture();
  let puff = run('A_SpawnItemEx', ['TestPuff', 32, 0, 0]);
  assert.ok(puff, 'the puff spawned');
  assert.ok(Math.abs(puff.x - entity.x) < 1e-6 && Math.abs(puff.y - (entity.y + 32)) < 1e-6, `x offset is forward (${puff.x}, ${puff.y})`);
  puff = run('A_SpawnItemEx', ['TestPuff', 0, 16, 0]);
  assert.ok(Math.abs(puff.x - (entity.x + 16)) < 1e-6 && Math.abs(puff.y - entity.y) < 1e-6, `positive y is to the right (${puff.x}, ${puff.y})`);
  puff = run('A_SpawnItemEx', ['TestPuff', 32, 0, 0, 0, 0, 0, 90]);
  assert.ok(Math.abs(puff.x - (entity.x - 32)) < 1e-6 && Math.abs(puff.y - entity.y) < 1e-6, `the angle turns the offset too (${puff.x}, ${puff.y})`);
});

test('hunt 103: A_SpawnItemEx velocity is relative to the spawner unless absolute', () => {
  const { run } = spawnFixture();
  let puff = run('A_SpawnItemEx', ['TestPuff', 0, 0, 0, 2, 0, 0]);
  assert.ok(Math.abs(puff.vx) < 1e-6 && Math.abs(puff.vy - 2 * 35) < 1e-6, `forward velocity follows the facing (${puff.vx}, ${puff.vy})`);
  puff = run('A_SpawnItemEx', ['TestPuff', 0, 0, 0, 0, 2, 0]);
  assert.ok(Math.abs(puff.vx - 2 * 35) < 1e-6 && Math.abs(puff.vy) < 1e-6, `sideways velocity goes right (${puff.vx}, ${puff.vy})`);
  puff = run('A_SpawnItemEx', ['TestPuff', 0, 0, 0, 2, 0, 0, 0, 'SXF_ABSOLUTEVELOCITY']);
  assert.ok(Math.abs(puff.vx - 2 * 35) < 1e-6 && Math.abs(puff.vy) < 1e-6, `absolute velocity stays in map axes (${puff.vx}, ${puff.vy})`);
});

test('hunt 104: A_SpawnItem spawns at its distance ahead and its height', () => {
  const { run, entity } = spawnFixture();
  const puff = run('A_SpawnItem', ['TestPuff', 40, 8]);
  assert.ok(Math.abs(puff.x - entity.x) < 1e-6 && Math.abs(puff.y - (entity.y + 40)) < 1e-6, `distance is ahead (${puff.x}, ${puff.y})`);
  assert.equal(puff.z, 8, 'zheight raises the spawn');
});

const frameTrail = actor => actor.states.frames.map(frame => frame.kind === 'frame' ? `${frame.sprite}${frame.letter}` : frame.kind);

test('hunt 105: a DECORATE state label sharing its line with frames keeps those frames', () => {
  const { actors } = importActors({ sources: [{ name: 'DECORATE', text: `
actor SameLine
{
  States
  {
  Spawn: POSS AB 10 A_Look
    Loop
  See: POSS C 4 A_Chase
    Loop
  }
}` }], warnings: [] });
  const actor = actors.find(item => item.name === 'SameLine');
  assert.deepEqual(Object.keys(actor.states.labels), ['Spawn', 'See']);
  assert.deepEqual(frameTrail(actor), ['POSSA', 'POSSB', 'loop', 'POSSC', 'loop']);
  assert.equal(actor.states.frames[0].actions?.[0]?.name, 'A_Look');
});

test('hunt 106: a ZScript flow keyword followed by a label on the same line keeps the label', () => {
  const { actors } = importActors({ sources: [{ name: 'a.zs', text: `
class Packed : Actor
{
  States
  {
  Spawn:
    PACK A 4; Loop; See: PACK B 4; Goto Spawn;
  }
}` }], warnings: [] });
  const actor = actors.find(item => item.name === 'Packed');
  assert.deepEqual(Object.keys(actor.states.labels), ['Spawn', 'See']);
  assert.deepEqual(frameTrail(actor), ['PACKA', 'loop', 'PACKB', 'goto']);
  assert.equal(actor.states.frames[3].targetIndex, 0, 'Goto Spawn resolves');
});

test('hunt 107: Goto Super::Label runs the parent class sequence', () => {
  const { actors } = importActors({ sources: [{ name: 'a.zs', text: `
class BaseThing : Actor
{
  States
  {
  Spawn:
    BASE A 1;
    Loop;
  See:
    BASE B 2;
    BASE C 2;
    Loop;
  }
}
class KidThing : BaseThing
{
  States
  {
  See:
    KIDS A 1; Goto Super::See;
  }
}` }], warnings: [] });
  const actor = actors.find(item => item.name === 'KidThing');
  const see = actor.states.labels.See;
  const jump = actor.states.frames[see + 1];
  assert.equal(jump.kind, 'goto', 'the same-line goto is parsed');
  const target = actor.states.frames[jump.targetIndex];
  assert.equal(`${target.sprite}${target.letter}`, 'BASEB', 'the goto lands on the parent See, not on its own See');
});
