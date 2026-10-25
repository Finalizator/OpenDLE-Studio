import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu } from '../shared/game-menu.js';
import { installIntermission, beginIntermission, continueIntermission, recordRemovedEntity, updateLevelStatistics } from '../shared/intermission.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hudText, hudElement, MAX_HUD_ELEMENTS } from '../shared/hud.js';
import { assembleGameLevels } from '../shared/game-levels.js';
import { setGameScreen } from '../shared/game-settings.js';

function map() {
  return installIntermission(installGameMenu(installEngineScripts(createProject())));
}
function menuWithoutIntermission() {
  const p = installGameMenu(installEngineScripts(createProject()));
  p.events = p.events.filter(event => event.sheetId !== 'intermission_sheet');
  p.eventSheets = p.eventSheets.filter(sheet => sheet.id !== 'intermission_sheet');
  p.hud.elements = p.hud.elements.filter(element => !element.id.startsWith('intermission_'));
  const retained = new Set(p.hud.elements.map(element => element.id));
  p.gameMenus.elementIds = p.gameMenus.elementIds.filter(id => retained.has(id));
  return p;
}
function campaign() {
  return assembleGameLevels([{ id: 'MAP01', name: 'First', project: map() }, { id: 'MAP02', name: 'Second', project: map() }],
    'MAP01', 'Test campaign').project;
}
test('intermission is editable native HUD and interface events, persistent and idempotent', () => {
  const p = map(), count = p.hud.elements.length;
  installIntermission(p);
  for (const element of p.hud.elements.filter(element => element.id.startsWith('intermission_')))
    assert.ok(p.gameMenus.elementIds.includes(element.id));
  assert.equal(p.hud.elements.length, count);
  assert.ok(p.eventSheets.some(sheet => sheet.id === 'intermission_sheet' && sheet.phase === 'interface'));
  assert.ok(p.events.some(event => event.actions.some(action => action.type === 'continueIntermission')));
  validateProject(p); validateProject(JSON.parse(JSON.stringify(p)));
  const s = createRuntime(p);
  beginIntermission(p, s);
  stepRuntime(p, s, .05, new Set());
  const item = p.hud.elements.find(element => element.name === 'Intermission Kills value');
  assert.equal(hudText(item, s), '0 / 0');
  assert.equal(s.hudState.elements.get(item.id).visible, true);
  const position = { ...s.player }, time = s.time;
  stepRuntime(p, s, .05, new Set(['KeyW', 'Mouse0']));
  assert.deepEqual(s.player, position); assert.equal(s.time, time);
});
test('crowded imported HUDs retain editable intermission within six available element slots', () => {
  const p = menuWithoutIntermission();
  while (p.hud.elements.length < MAX_HUD_ELEMENTS - 6) p.hud.elements.push(hudElement(`authored_${p.hud.elements.length}`, 'text', 'Authored UI'));
  installIntermission(p);
  assert.equal(p.hud.elements.length, MAX_HUD_ELEMENTS);
  assert.ok(p.hud.elements.some(element => element.name === 'Intermission statistics' && element.text.includes('intermission_secrets')));
  validateProject(p);
});
for (const phase of ['beforePhysics', 'afterPhysics']) test(`finishing in ${phase} stops remaining actions, children, instances and simulation`, () => {
  const p = map();
  p.variables.afterExit = 0;
  p.map.entities.push(...['exit_enemy_a', 'exit_enemy_b'].map(id =>
    ({ id, type: 'enemy', x: 0, y: 0, angle: 0, health: 20 })));
  p.eventSheets.push({ id: 'exit_sheet', name: 'Exit test', enabled: true, phase });
  p.events.unshift(
    { id: 'test_exit_parent', sheetId: 'exit_sheet', forEachType: 'enemy', enabled: true, once: false,
      condition: { type: 'always' }, actions: [
        { type: 'addVariable', variable: 'afterExit', value: 1 },
        { type: 'finishLevel', exit: 'normal' },
        { type: 'teleport', x: 500, y: 500 },
        { type: 'addVariable', variable: 'afterExit', value: 100 },
      ] },
    { id: 'test_exit_child', parentId: 'test_exit_parent', sheetId: 'exit_sheet', enabled: true, once: false,
      condition: { type: 'always' }, actions: [{ type: 'addVariable', variable: 'afterExit', value: 1000 }] },
    { id: 'test_exit_sibling', sheetId: 'exit_sheet', enabled: true, once: false,
      condition: { type: 'always' }, actions: [{ type: 'addVariable', variable: 'afterExit', value: 10000 }] });
  const s = createRuntime(p), position = { ...s.player };
  let physicsSteps = 0;
  s.physics = { syncWorld() {}, step() { physicsSteps++; } };
  stepRuntime(p, s, .05, new Set(['KeyW']));
  assert.equal(s.gameScreen, 'intermission');
  assert.equal(s.variables.afterExit, 1);
  assert.deepEqual(s.player, position);
  assert.equal(physicsSteps, phase === 'beforePhysics' ? 0 : 1);
  const time = s.time;
  stepRuntime(p, s, .05, new Set(['KeyW']));
  assert.equal(s.time, time); assert.deepEqual(s.player, position);
  assert.equal(s.variables.afterExit, 1);
});
test('finish waits for fresh confirmation then requests next level with progress once', () => {
  const p = campaign();
  p.events.push({ id: 'test_exit', enabled: true, once: true, condition: { type: 'onStart' },
    actions: [{ type: 'finishLevel', exit: 'normal' }] });
  validateProject(p);
  const s = createRuntime(p);
  stepRuntime(p, s, .05, new Set(), new Set(['Enter']));
  assert.equal(s.gameScreen, 'intermission'); assert.deepEqual(s.menuRequests, []);
  for (let i = 0; i < 5; i++) stepRuntime(p, s, .05, new Set(['Enter']));
  assert.deepEqual(s.menuRequests, []);
  stepRuntime(p, s, .05, new Set(), new Set(['Enter']));
  assert.deepEqual(s.menuRequests, [{ type: 'level', levelId: 'MAP02', carryProgress: true }]);
  continueIntermission(s); assert.equal(s.menuRequests.length, 1);
});
test('secret routes and campaign completion wait for Space or native HUD click', () => {
  const p = campaign();
  p.game.levels[0].secretNext = 'MAP02';
  const s = createRuntime(p);
  beginIntermission(p, s, true);
  stepRuntime(p, s, 0, new Set(), new Set(['Space']));
  assert.equal(s.menuRequests[0].levelId, 'MAP02');
  const single = map(), end = createRuntime(single);
  beginIntermission(single, end);
  assert.equal(end.gameScreen, 'intermission'); assert.deepEqual(end.menuRequests, []);
  end.hudState.clicked.add(single.hud.elements.find(element => element.name === 'Continue intermission').id);
  stepRuntime(single, end, 0, new Set());
  assert.equal(end.gameScreen, 'title'); assert.deepEqual(end.menuRequests, ['complete']);
});
test('Escape/back, pause/resume and interface screen actions cannot bypass pending intermission', () => {
  const p = map(), s = createRuntime(p);
  beginIntermission(p, s);
  const history = [...s.menuHistory];
  for (const target of ['return', 'pause', 'playing', 'title']) {
    setGameScreen(s, target);
    assert.equal(s.gameScreen, 'intermission');
    assert.deepEqual(s.menuHistory, history);
    assert.equal(s.hudState.cursor, true);
  }
  p.events.push({ id: 'test_resume_bypass', sheetId: 'intermission_sheet', enabled: true, once: false,
    condition: { type: 'always' }, actions: [{ type: 'setGameScreen', screen: 'playing' }] });
  const position = { ...s.player }, time = s.time;
  stepRuntime(p, s, .05, new Set(['KeyW']));
  assert.equal(s.gameScreen, 'intermission'); assert.equal(s.time, time);
  assert.deepEqual(s.player, position); assert.deepEqual(s.menuRequests, []);
  p.events.pop();
  continueIntermission(s);
  assert.equal(s.gameScreen, 'title'); assert.deepEqual(s.menuRequests, ['complete']);
});
test('statistics count skill-filtered deaths, collected Doom count-items and visited secret sectors exactly once', () => {
  const p = map();
  const spawn = p.map.entities.find(entity => entity.type === 'player');
  spawn.x = 0; spawn.y = 0;
  p.map.entities = [spawn,
    { id: 'monster', type: 'enemy', x: 0, y: 0, angle: 0, health: 20 },
    { id: 'excluded', type: 'enemy', x: 0, y: 0, angle: 0, health: 20, skillMask: 1 },
    { id: 'soul', type: 'enemy', x: 0, y: 0, angle: 0, health: 20, doomType: 3006 },
    ...[2014, 2011].map(doomType => ({ id: `item${doomType}`, type: 'pickup', x: spawn.x, y: spawn.y, angle: 0, doomType })),
    { id: 'remote', type: 'pickup', x: 10000, y: 10000, angle: 0, doomType: 2014 }];
  p.map.sectors[0].special = 9;
  const s = createRuntime(p);
  s.player.x = 0; s.player.y = 0;
  s.entities.find(entity => entity.id === 'monster').health = 0;
  updateLevelStatistics(s); updateLevelStatistics(s);
  for (const entity of s.entities.filter(entity => entity.type === 'pickup')) recordRemovedEntity(s, entity);
  s.time = 125.9;
  beginIntermission(p, s);
  assert.equal(s.intermission.values.kills, '1 / 1');
  assert.equal(s.intermission.values.items, '1 / 2');
  assert.equal(s.intermission.values.secrets, '1 / 1');
  assert.equal(s.intermission.values.time, '2:05');
});
test('native death and pickup rules feed real intermission counts, with no double-counting', () => {
  const p = map(), player = p.map.entities.find(entity => entity.type === 'player');
  p.map.entities = p.map.entities.filter(entity => entity.type !== 'pickup');
  p.map.entities.push({ id: 'victim', type: 'enemy', x: player.x, y: player.y, angle: 0, health: 10 },
    { id: 'bonus', type: 'pickup', x: player.x, y: player.y, angle: 0, doomType: 2014 });
  p.events.push({ id: 'test_collect', enabled: true, once: true, condition: { type: 'onStart' }, actions: [
    { type: 'setEntityHealth', entityId: 'victim', health: 0 },
    { type: 'removeEntity', entityId: 'victim' }, { type: 'removeEntity', entityId: 'bonus' },
    { type: 'finishLevel', exit: 'normal' },
  ] });
  const s = createRuntime(p);
  stepRuntime(p, s, .05, new Set());
  assert.equal(s.intermission.values.kills, '1 / 1');
  assert.equal(s.intermission.values.items, '1 / 1');
  stepRuntime(p, s, .05, new Set());
  assert.equal(s.levelStatistics.kills.size, 1); assert.equal(s.levelStatistics.items.size, 1);
});
test('original intermission artwork is represented by native image HUD elements', () => {
  const p = menuWithoutIntermission();
  const asset = { ...p.assets.find(asset => ['sprite', 'texture'].includes(asset.kind)), id: 'interpic_art', name: 'INTERPIC', width: 320, height: 200 };
  p.assets.push(asset);
  installIntermission(p, { has: name => name === 'INTERPIC', get: () => asset.id });
  assert.equal(p.hud.elements.find(element => element.name === 'Intermission background').assetId, asset.id);
});
test('Doom episode intermissions preserve world-map, level-title and finished patches', () => {
  const p = menuWithoutIntermission();
  p.title = 'E1M1 - imported WAD';
  const template = p.assets.find(asset => ['sprite', 'texture'].includes(asset.kind));
  const images = ['WIMAP0', 'WILV00', 'WIF', 'WIOSTK'].map(name =>
    ({ ...template, id: `original_${name}`, name, width: 32, height: 12 }));
  p.assets.push(...images);
  installIntermission(p, { has: name => images.some(image => image.name === name),
    get: name => images.find(image => image.name === name).id });
  for (const image of images) assert.ok(p.hud.elements.some(element => element.assetId === image.id));
});
test('episode selection stores a new-game target without immediate loading and start preserves it', () => {
  const p = campaign(), s = createRuntime(p, { screen: 'title' });
  p.events.push({ id: 'test_episode', enabled: true, once: true, sheetId: 'intermission_sheet',
    condition: { type: 'onStart' }, actions: [{ type: 'selectGameEpisode', levelId: 'MAP02' }, { type: 'startGame' }] });
  stepRuntime(p, s, 0, new Set());
  assert.equal(s.newGameLevel, 'MAP02');
  assert.deepEqual(s.menuRequests, [{ type: 'start', levelId: 'MAP02' }]);
});
test('a sole declared episode is the new-game target even when another map is active', () => {
  const p = campaign();
  p.gameMenus.episodes = [{ levelId: 'MAP02', name: 'Episode' }];
  const s = createRuntime(p, { screen: 'title' });
  assert.equal(s.newGameLevel, 'MAP02');
  assert.deepEqual(s.menuRequests, []);
});
