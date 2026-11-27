import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts } from '../shared/world-motion.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { executeSpecial } from '../shared/line-specials.js';

/** A map with two rooms, so every wall has a neighbour to measure a plane against. */
function taggedProject(specials) {
  const project = installEngineScripts(createProject());
  project.map.sectors[0].tag = 7;
  project.map.sectors.push({ id: 'room1', floorHeight: 64, ceilingHeight: 192, light: 208, sky: false, tag: 7 });
  project.map.vertices.push({ id: 'v5', x: 640, y: 0 }, { id: 'v6', x: 640, y: -640 });
  project.map.walls.push({ id: 'w5', a: 'v2', b: 'v5', height: 256, solid: true, right: { sectorId: 'room0' }, left: { sectorId: 'room1' } });
  project.map.walls.push({ id: 'w6', a: 'v5', b: 'v6', height: 256, solid: true, right: { sectorId: 'room1' } });
  project.map.walls[0].tag = 7;
  specials.forEach((special, index) => project.map.walls.push({
    id: `s${index}`, a: 'v1', b: 'v2', height: 128, solid: true, tag: 7, special, args: [7, 0, 0, 0, 0],
    specialFormat: 'doom', right: { sectorId: 'room0' } }));
  return project;
}

function worldRule(project, condition, actions) {
  const sheetId = project.eventSheets.find(sheet => sheet.name === 'World').id;
  const groupId = project.eventGroups.find(group => group.sheetId === sheetId).id;
  project.events.push({ id: `hunt_${project.events.length}`, name: 'probe', sheetId, groupId,
    enabled: true, once: false, condition, conditions: [], actions });
}

test('A missile spawned by a script rolls damage instead of dying to NaN', () => {
  const project = installEngineScripts(createProject());
  const state = createRuntime(project);
  state.scripts.host.projectile({ type: 'DoomImpBall', tid: 0, angle: 0, speed: 8 });
  const shot = state.projectiles.at(-1);
  assert.equal(shot.diceSides, 8, 'a missile rolls 1..8 times its damage, like every other spawner');
  // `randomDamage` multiplies by the die size; an undefined size made the hit NaN, which the
  // damage path rejects as "not a positive amount", so the missile passed through.
  const rolled = shot.damage * (1 + Math.floor((Math.imul(state.randomSeed, 1664525) + 1013904223 >>> 0) / 2 ** 32 * shot.diceSides));
  assert.ok(Number.isFinite(rolled) && rolled > 0, `the roll is a number: ${rolled}`);
});

test('DamageThing spends armour and is stopped by invulnerability', () => {
  const project = installEngineScripts(createProject());
  const state = createRuntime(project);
  state.playerStats.health = 100; state.playerStats.armor = 100; state.playerStats.armorDivisor = 3;
  executeSpecial(project, state, 73, [20], { format: 'zdoom', activator: 'player' });
  assert.equal(state.playerStats.health, 86, 'armour takes a third of the hit');
  assert.equal(state.playerStats.armor, 94);
  state.playerStats.health = 100; state.playerStats.invulnerable = 30;
  executeSpecial(project, state, 73, [20], { format: 'zdoom', activator: 'player' });
  assert.equal(state.playerStats.health, 100, 'an invulnerability sphere absorbs the hit');
});

test('Classic plane specials move at the speed the xlat table gives them', () => {
  const speeds = specials => {
    const project = taggedProject(specials);
    const before = project.events.length;
    installWorldScripts(project, []);
    return project.events.slice(before).flatMap(event => (event.actions || [])
      .filter(action => action.type === 'moveSector').map(action => action.speed));
  };
  // P_FAST and F_FAST are four units a tic; F_SLOW is one; D_FAST is eight (280 a second).
  for (const special of [10, 21, 62, 88, 36, 98]) assert.ok(speeds([special]).every(speed => speed === 140), `special ${special}`);
  for (const special of [5, 18, 19, 23, 119]) assert.ok(speeds([special]).every(speed => speed === 35), `special ${special}`);
  for (const special of [105, 112, 120]) assert.ok(speeds([special]).every(speed => speed === 280), `special ${special}`);
});

test('Teleport_NewMap and ChangeLevel ask for the level they name', () => {
  const project = installEngineScripts(createProject());
  project.game = { version: 1, entry: 'MAP01', active: 'MAP01', levels: [
    { id: 'MAP01', name: 'One', data: {}, assetIds: [] }, { id: 'MAP02', name: 'Two', data: {}, assetIds: [] }] };
  const state = createRuntime(project);
  state.menuRequests = [];
  state.scripts.host.changeLevel('MAP02');
  assert.deepEqual(state.menuRequests, [{ type: 'level', levelId: 'MAP02' }]);
  state.menuRequests = [];
  assert.equal(state.scripts.special(74, [2, 0, 0, 0, 0], { activator: 'player' }), 1);
  assert.deepEqual(state.menuRequests, [{ type: 'level', levelId: 'MAP02' }], 'the map number is 1-based');
});

test('The sector damage rule action damages what stands in the sector', () => {
  const project = taggedProject([]);
  worldRule(project, { type: 'always' }, [{ type: 'sectorDamage', tag: 7, amount: 20, kind: 'Normal' }]);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 60, new Set());
  assert.equal(state.playerStats.health, 80, 'flags 0 damaged nobody at all');
});

test('SetLineSpecial changes what the line does, not only what it stores', () => {
  const project = taggedProject([112]);
  const wall = project.map.walls.at(-1);
  worldRule(project, { type: 'always' }, [{ type: 'runLineSpecial', special: 112, arg1: 7, arg2: 240,
    arg3: 0, arg4: 0, arg5: 0, line: wall.id }]);
  const state = createRuntime(project);
  state.sectors[0].light = 100;
  stepRuntime(project, state, 1 / 60, new Set());
  assert.equal(state.sectors[0].light, 0, "the line's own argument is 0, so its light goes to 0");
  state.scripts.host.setLineSpecial(7, 112, [7, 96, 0, 0, 0]);
  stepRuntime(project, state, 1 / 60, new Set());
  assert.equal(state.sectors[0].light, 96, 'the new argument is the one that runs');
});

test('A string the module cannot store is refused instead of mangled', async () => {
  const { compileScriptSource } = await import('../shared/map-scripts.js');
  const project = createProject();
  assert.throws(() => compileScriptSource(project, 'map:1', 'script 1 { Print(s:"Zażółć"); }'), /Latin-1/);
});
