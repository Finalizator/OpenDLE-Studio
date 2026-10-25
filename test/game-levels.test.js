import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu } from '../shared/game-menu.js';
import { assembleGameLevels, selectGameLevel, nextGameLevel, parseLevelRoutes, gameLevelAssetIds } from '../shared/game-levels.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { continueIntermission } from '../shared/intermission.js';
import { importWad } from '../server/import.js';
import { applyTool } from '../server/tools.js';
import { ProjectStore } from '../server/store.js';
import { encodeImage } from '../server/import.js';

function level(x = 0) {
  const project = installEngineScripts(createProject());
  project.map.entities.find(entity => entity.type === 'player').x = x;
  installGameMenu(project);
  return project;
}
function game() {
  return assembleGameLevels([{ id: 'MAP01', project: level(10) }, { id: 'MAP02', project: level(20) }],
    'MAP01', 'Two-level game').project;
}

test('all levels remain editable across switching, serialization, MCP selection and disk persistence', () => {
  const p = game(); validateProject(p);
  p.map.entities.find(entity => entity.type === 'player').x = 42;
  p.variables.score = 7;
  selectGameLevel(p, 'MAP02'); assert.equal(p.map.entities.find(entity => entity.type === 'player').x, 20);
  p.map.entities.find(entity => entity.type === 'player').x = 99;
  selectGameLevel(p, 'MAP01'); assert.equal(p.map.entities.find(entity => entity.type === 'player').x, 42);
  assert.equal(p.variables.score, 7);
  const serialized = JSON.parse(JSON.stringify(p)); validateProject(serialized);
  const result = applyTool(serialized, 'game_level_select', { levelId: 'MAP02' });
  assert.equal(result.project.map.entities.find(entity => entity.type === 'player').x, 99);
  const routed = applyTool(result.project, 'game_level_set_routes', { levelId: 'MAP02', next: 'MAP01', secretNext: null, entry: true }).project;
  assert.equal(routed.game.entry, 'MAP02');
  assert.equal(routed.game.levels[1].next, 'MAP01');
  const root = mkdtempSync(join(tmpdir(), 'opendle-levels-'));
  try {
    const path = join(root, 'project.json'), store = new ProjectStore(path);
    store.update(result.project, 0);
    const loaded = new ProjectStore(path).snapshot().project;
    selectGameLevel(loaded, 'MAP01'); assert.equal(loaded.map.entities.find(entity => entity.type === 'player').x, 42);
  } finally { rmSync(root, { recursive: true }); }
});

test('shared assets deduplicate and conflicting generated atlases retain correct per-level references', () => {
  const a = level(), b = level();
  const image = pixels => ({ id: 'same_atlas', name: 'Atlas', kind: 'sprite', width: 1, height: 1,
    src: encodeImage({ width: 1, height: 1, pixels: new Uint8Array(pixels) }) });
  a.assets.push(image([255, 0, 0, 255])); b.assets.push(image([0, 255, 0, 255]));
  a.assets.push({ ...a.assets.at(-1), id: 'same_alias' });
  for (const p of [a, b]) p.hud.elements.find(item => item.type === 'image' || item.type === 'panel').assetId = 'same_atlas';
  a.hud.elements.find(item => item.assetId === 'same_atlas').assetId = 'same_alias';
  const p = assembleGameLevels([{ id: 'MAP01', project: a }, { id: 'MAP02', project: b }], 'MAP01', 'Assets').project;
  validateProject(p);
  const first = p.hud.elements.find(item => item.assetId === 'same_atlas');
  selectGameLevel(p, 'MAP02');
  const second = p.hud.elements.find(item => item.id === first.id);
  assert.notEqual(second.assetId, first.assetId);
  assert.ok(gameLevelAssetIds(p).includes(second.assetId));
  assert.equal(gameLevelAssetIds(p).includes(first.assetId), false);
  assert.equal(p.assets.filter(asset => asset.name === 'Atlas').length, 2);
  for (const sound of p.assets.filter(asset => asset.kind === 'sound'))
    assert.equal(p.assets.filter(asset => asset.name === sound.name && asset.kind === 'sound').length, 1);
});

test('campaign routing follows conventional normal/secret exits and declarative MAPINFO overrides', () => {
  const routes = parseLevelRoutes(['map MAP01 "Arrival" { next = "MAP03"\n secretnext = "MAP02" }\nmap MAP03 { next = EndGameC }']);
  const p = assembleGameLevels(['MAP01', 'MAP02', 'MAP03', 'MAP15', 'MAP16', 'MAP30', 'MAP31', 'MAP32']
    .map(id => ({ id, project: level() })), 'MAP01', 'Routing', routes).project;
  validateProject(p);
  assert.equal(p.game.levels[0].name, 'Arrival');
  assert.equal(nextGameLevel(p.game), 'MAP03'); assert.equal(nextGameLevel(p.game, true), 'MAP02');
  selectGameLevel(p, 'MAP03'); assert.equal(nextGameLevel(p.game), null);
  selectGameLevel(p, 'MAP15'); assert.equal(nextGameLevel(p.game, true), 'MAP31');
  selectGameLevel(p, 'MAP31'); assert.equal(nextGameLevel(p.game), 'MAP16'); assert.equal(nextGameLevel(p.game, true), 'MAP32');
  selectGameLevel(p, 'MAP30'); assert.equal(nextGameLevel(p.game), null);
});

test('active-level images include indirect rotation views across switching and saved snapshots', () => {
  const a = level(), b = level();
  const frame = id => ({ id, name: id, kind: 'sprite', width: 1, height: 1, offsetX: 0, offsetY: 1,
    src: encodeImage({ width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]) }) });
  const front = frame('enemy_front'), side = frame('enemy_side'), back = frame('enemy_back');
  front.rotations = Array.from({ length: 8 }, (_, i) => ({ assetId: i ? side.id : front.id, flip: i > 4 }));
  side.rotations = Array.from({ length: 8 }, (_, i) => ({ assetId: i ? back.id : front.id, flip: false }));
  a.assets.push(front, side, back, frame('unrelated_image'));
  a.map.entities.find(entity => entity.type === 'player').spriteAsset = front.id;
  const p = assembleGameLevels([{ id: 'MAP01', project: a }, { id: 'MAP02', project: b }],
    'MAP01', 'Directional sprites').project;
  const expected = [front.id, side.id, back.id];
  for (const id of expected) assert.ok(gameLevelAssetIds(p).includes(id), id);
  assert.equal(gameLevelAssetIds(p).includes('unrelated_image'), false);
  selectGameLevel(p, 'MAP02');
  for (const id of expected) assert.ok(p.game.levels[0].assetIds.includes(id), id);
  assert.equal(gameLevelAssetIds(p).includes(front.id), false);
  validateProject(p);
  const loaded = JSON.parse(JSON.stringify(p));
  selectGameLevel(loaded, 'MAP01');
  for (const id of expected) assert.ok(gameLevelAssetIds(loaded).includes(id), id);
  validateProject(loaded);
});

test('level transitions preserve health/ammo/weapons, clear keys, and reset runtime world state', () => {
  const p = game(), s = createRuntime(p);
  stepRuntime(p, s, 0, new Set());
  s.playerStats.health = 63; s.playerStats.armor = 25; s.playerStats.bullets = 17;
  s.inventory.weapons.add('shotgun'); s.inventory.keys.add('blueCard');
  selectGameLevel(p, 'MAP02');
  const next = createRuntime(p, { progress: { playerStats: s.playerStats, inventory: s.inventory } });
  stepRuntime(p, next, 0, new Set());
  assert.deepEqual([next.playerStats.health, next.playerStats.armor, next.playerStats.bullets], [63, 25, 17]);
  assert.ok(next.inventory.weapons.has('shotgun')); assert.equal(next.inventory.keys.size, 0);
  assert.equal(s.inventory.keys.size, 1);
  assert.equal(next.player.x, 20); assert.equal(next.time, 0);
  const fresh = createRuntime(p); stepRuntime(p, fresh, 0, new Set()); assert.equal(fresh.playerStats.health, 100);
});

test('finish/load level actions request an actual campaign transition and validate targets', () => {
  const p = game(), event = { id: 'exit_test', name: 'Exit', enabled: true, once: true, condition: { type: 'onStart' },
    actions: [{ type: 'finishLevel', exit: 'normal' }] };
  p.events.push(event); validateProject(p);
  const s = createRuntime(p); stepRuntime(p, s, 0, new Set());
  assert.equal(s.gameScreen, 'intermission'); assert.deepEqual(s.menuRequests, []);
  continueIntermission(s);
  assert.deepEqual(s.menuRequests, [{ type: 'level', levelId: 'MAP02', carryProgress: true }]);
  event.actions = [{ type: 'loadGameLevel', levelId: 'MAP02' }]; validateProject(p);
  const load = createRuntime(p); stepRuntime(p, load, 0, new Set());
  assert.deepEqual(load.menuRequests, [{ type: 'level', levelId: 'MAP02', carryProgress: false }]);
  event.actions[0].levelId = 'MISSING'; assert.throws(() => validateProject(p), /unknown game level/);
});

test('malformed inactive maps, missing routes/assets, duplicate IDs and recursive data fail validation', () => {
  for (const mutate of [
    p => { p.game.levels[1].data.map.walls[0].a = 'unknown'; },
    p => { p.game.levels[1].next = 'unknown'; },
    p => { p.game.entry = 'unknown'; },
    p => { p.game.levels[1].assetIds.push('unknown'); },
    p => { p.game.levels[1].id = 'MAP01'; },
    p => { p.game.levels[1].data.game = p.game; },
  ]) { const p = game(); mutate(p); assert.throws(() => validateProject(p)); }
  assert.throws(() => selectGameLevel(game(), 'unknown'), /Unknown/);
  assert.throws(() => selectGameLevel(level(), 'MAP02'), /only one level/);
});

function wadBytes() {
  const vertices = Buffer.alloc(16), lines = Buffer.alloc(56), things = Buffer.alloc(10), side = Buffer.alloc(30), sector = Buffer.alloc(26);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
    lines.writeUInt16LE(i, i * 14); lines.writeUInt16LE((i + 1) % 4, i * 14 + 2); lines.writeUInt16LE(65535, i * 14 + 12);
  });
  lines.writeUInt16LE(11, 6); things.writeUInt16LE(1, 6); things.writeUInt16LE(7, 8); sector.writeInt16LE(128, 2);
  side.write('-', 4); side.write('-', 12); side.write('-', 20); sector.write('-', 4); sector.write('-', 12);
  const maps = ['MAP01', 'MAP02'].flatMap(id => [[id, Buffer.alloc(0)], ['THINGS', things], ['LINEDEFS', lines],
    ['SIDEDEFS', side], ['VERTEXES', vertices], ['SECTORS', sector]]);
  const lumps = [['PLAYPAL', Buffer.alloc(768)], ...maps], directory = 12 + lumps.reduce((sum, [, b]) => sum + b.length, 0);
  const bytes = Buffer.alloc(directory + lumps.length * 16); bytes.write('PWAD'); bytes.writeUInt32LE(lumps.length, 4); bytes.writeUInt32LE(directory, 8);
  let offset = 12;
  for (const [i, [name, data]] of lumps.entries()) {
    data.copy(bytes, offset); const entry = directory + i * 16; bytes.writeUInt32LE(offset, entry);
    bytes.writeUInt32LE(data.length, entry + 4); bytes.write(name, entry + 8, 8); offset += data.length;
  }
  return bytes;
}

test('full WAD imports retain every native map, share assets and compile original exit specials', () => {
  const bytes = wadBytes(), { project: p } = importWad(bytes);
  validateProject(p); assert.deepEqual(p.game.levels.map(level => level.id), ['MAP01', 'MAP02']);
  assert.equal(p.game.entry, 'MAP01'); assert.equal(p.game.levels[0].next, 'MAP02');
  assert.ok(p.events.some(event => event.condition.type === 'wallActivated' && event.actions[0].type === 'finishLevel'));
  const state = createRuntime(p);
  state.player.y = 100; state.player.angle = Math.PI / 2;
  stepRuntime(p, state, 0, new Set(), new Set(['KeyE']));
  assert.equal(state.gameScreen, 'intermission'); assert.deepEqual(state.menuRequests, []);
  continueIntermission(state);
  assert.deepEqual(state.menuRequests, [{ type: 'level', levelId: 'MAP02', carryProgress: true }]);
  selectGameLevel(p, 'MAP02'); assert.equal(p.game.active, 'MAP02'); assert.equal(p.game.levels[1].next, null);
  assert.equal(importWad(bytes, 'MAP02', { fullGame: false }).project.game, undefined);
});
