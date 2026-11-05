import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installEngineSounds } from '../shared/sound.js';
import { gameSettings } from '../shared/game-settings.js';
import { createPath } from '../shared/paths.js';
import { installIntermission, createLevelStatistics, recordRemovedEntity } from '../shared/intermission.js';
import { playerReachesEntity } from '../shared/combat.js';
import { initialPlayerStats, initialInventory } from '../shared/player-state.js';
import { newJoint, transformJoint } from '../shared/joints.js';
import { installDefaultHUD, MAX_HUD_ELEMENTS } from '../shared/hud.js';
import { assembleGameLevels } from '../shared/game-levels.js';
import { installWorldScripts } from '../shared/world-motion.js';

const rule = (id, actions = [], extra = {}) => ({ id, enabled: true, once: false, condition: { type: 'always' }, actions, ...extra });
function fixture({ area = true } = {}) {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  installEngineSounds(project);
  project.events = [];
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  project.map.entities.push({ id: 'box0', name: 'Box', type: 'decoration', x: 120, y: 100, angle: 0,
    ...(area ? { area: { shape: 'box', width: 64, height: 64, depth: 64, radius: 32 } } : {}) });
  project.map.entities.push({ id: 'cam0', name: 'Camera', type: 'camera', x: 100, y: 100, angle: 0 });
  project.paths = [createPath({ id: 'path0', name: 'Path', points: [{ id: 'p0', x: 0, y: 0 }, { id: 'p1', x: 100, y: 0 }] })];
  project.variables.result = 0;
  return project;
}
const tick = (project, state = createRuntime(project), count = 2) => {
  for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, new Set());
  return state;
};

test('hunt100 01: an area condition refuses an object that has no interaction area', () => {
  const project = fixture({ area: false });
  project.events = [rule('probe', [], { condition: { type: 'playerInArea', entityId: 'box0' } })];
  assert.throws(() => validateProject(project), /interaction area/i);
  project.map.entities[1].area = { shape: 'box', width: 64, height: 64, depth: 64, radius: 32 };
  assert.doesNotThrow(() => validateProject(project));
});

test('hunt100 02: a fractional adjustment of an integer setting still leaves a valid setting', () => {
  const project = fixture();
  project.events = [rule('probe', [{ type: 'adjustGameSetting', setting: 'viewSize', amount: .5 }])];
  validateProject(project);
  const state = tick(project);
  assert.ok(Number.isInteger(state.settings.viewSize), 'a whole-number setting stays whole');
  assert.ok(state.settings.viewSize >= 8 && state.settings.viewSize <= 12);
});

test('hunt100 03: an ordering comparison between literal text and a number is refused while authoring', () => {
  const project = fixture();
  project.events = [rule('probe', [], { condition: { type: 'expressionCompare', left: 'text', operator: '<', right: 1 } })];
  assert.throws(() => validateProject(project), /type|number|text/i);
  project.events[0].condition.left = 2;
  assert.doesNotThrow(() => validateProject(project));
  const local = fixture();
  local.map.entities[1].variables = { value: 0 };
  local.events = [rule('probe', [], { condition: { type: 'objectVariableCompare', entityId: 'box0', variable: 'value', operator: '<', value: 'text' } })];
  assert.throws(() => validateProject(local), /matching types|comparison/i);
  local.events[0].condition.value = 1;
  assert.doesNotThrow(() => validateProject(local));
});

test('hunt100 07: adding the intermission to a project without menus keeps the project valid', () => {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  project.events = [];
  installIntermission(project, { has: () => false });
  assert.doesNotThrow(() => validateProject(project));
  // `title` is the other engine screen the runtime sets on its own (campaign complete), and the
  // catalogue's default for "open menu / resume"; it has to be authorable without a menu system.
  project.events.push(rule('resume', [{ type: 'setGameScreen', screen: 'title' }]));
  assert.doesNotThrow(() => validateProject(project));
});

test('hunt100 08: the intermission never pushes a full HUD past its element limit', () => {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  project.events = [];
  project.gameMenus = { version: 1, presentation: 2, entry: 'title', screens: ['title'], elementIds: [], sources: [] };
  installDefaultHUD(project);
  while (project.hud.elements.length < 510) project.hud.elements.push({
    ...project.hud.elements[0], id: `filler_${project.hud.elements.length}` });
  installIntermission(project, { has: () => false });
  assert.ok(project.hud.elements.length <= MAX_HUD_ELEMENTS,
    `HUD has ${project.hud.elements.length} elements, limit is ${MAX_HUD_ELEMENTS}`);
  assert.doesNotThrow(() => validateProject(project));
});

test('hunt100 09: the intermission item tally counts every Doom COUNTITEM pickup', () => {
  // Doom's item percentage counts things with MF_COUNTITEM: stimpacks, medikits, both armours,
  // the backpack and the powerups. Keys and weapons are not items and are counted by neither.
  const counted = [2011, 2012, 2013, 2014, 2015, 2018, 2019, 8, 2022, 2023, 2024, 2025, 2026, 2045, 83];
  const notItems = [5, 6, 13, 38, 2001, 2002];
  const entities = [...counted, ...notItems].map((doomType, index) => ({ id: `item_${index}`, type: 'pickup', doomType }));
  assert.equal(createLevelStatistics(entities, []).pickups.size, counted.length);
});

test('hunt100 10: an item collected from a step is counted by the intermission', () => {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  project.events = [];
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  const player = project.map.entities[0];
  // One sector, so floor height is known and the item can stand on a step 64 above the player.
  project.map.entities.push({ id: 'step_item', name: 'Soulsphere', type: 'pickup', doomType: 2013,
    x: player.x, y: player.y, angle: 0, z: 64 });
  const state = createRuntime(project);
  state.player.x = player.x; state.player.y = player.y;
  const item = state.entities.find(entity => entity.id === 'step_item');
  // The generated pickup rule reaches this item: 112 above, over steps.
  assert.equal(playerReachesEntity(state, item, 36, 112, 32, { overSteps: true }), true);
  recordRemovedEntity(state, item);
  assert.equal(state.levelStatistics.items.has('step_item'), true,
    'an item the pickup rule can take has to count towards the intermission');
});

test('hunt100 11: arriving on a level with carried-over health does not fake a damage flash', () => {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  project.events = [rule('fx', [{ type: 'addVariable', variable: 'flashes', value: 1 }],
    { condition: { type: 'hudStatChanged', stat: 'health', direction: 'decreased' } })];
  project.variables.flashes = 0;
  validateProject(project);
  const stats = { ...initialPlayerStats(), health: 50 };
  const state = createRuntime(project, { progress: { playerStats: stats, inventory: initialInventory() } });
  tick(project, state, 1);
  assert.equal(state.variables.flashes, 0, 'entering a level is not damage');
  state.playerStats.health = 40;
  tick(project, state, 1);
  assert.equal(state.variables.flashes, 1, 'real damage still fires');
});

test('hunt100 12: a joint axis that names one component normalizes instead of becoming NaN', () => {
  const joint = newJoint({ type: 'revolute', axis: { y: 1 } });
  assert.deepEqual(joint.axis, { x: 0, y: 1, z: 0 });
  // A validated descriptor may also omit components; placing it must stay finite.
  const placed = transformJoint({ id: 'j', name: 'J', type: 'revolute', a: 'a', b: null,
    anchor: { x: 0, y: 0, z: 0 }, axis: { x: 1 } }, { x: 5, y: 5, angle: 90 });
  for (const key of ['x', 'y', 'z']) assert.ok(Number.isFinite(placed.axis[key] ?? 0), `${key} is finite`);
});

test('hunt100 06: a variable that keeps growing saturates instead of stopping the game', () => {
  const project = fixture();
  project.variables.counter = 0;
  project.events = [rule('probe', [{ type: 'addVariable', variable: 'counter', value: 1e12 }])];
  validateProject(project);
  const state = createRuntime(project);
  assert.doesNotThrow(() => tick(project, state, 3));
  assert.equal(state.variables.counter, 1e12);
});

test('hunt100 04: a shader parameter comparison refuses a nonnumeric literal value', () => {
  const project = fixture();
  project.events = [rule('probe', [], { condition: { type: 'postFxParamCompare', kind: 'bloom', param: 'intensity', operator: '>', value: 'bright' } })];
  assert.throws(() => validateProject(project), /number|numeric/i);
  project.events[0].condition.value = .5;
  assert.doesNotThrow(() => validateProject(project));
});

test('hunt100 05: camera actions on $active follow the player view instead of ending the game', () => {
  const project = fixture();
  project.events = [rule('probe', [
    { type: 'setCameraFov', camera: '$active', fov: 110 },
    { type: 'moveCamera', camera: '$active', x: 10, y: 20, seconds: 0, easing: 'linear' },
  ])];
  validateProject(project);
  const state = tick(project);
  assert.equal(state.settings.fov, 110);
  assert.equal(state.viewCamera, null);
  // An empty camera field means "the view in use", so it resolves the same way.
  project.events = [rule('probe', [{ type: 'setCameraFov', camera: '', fov: 105 }])];
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(tick(project, state).settings.fov, 105);
});

test('hunt100 13: assembling a campaign remaps HUD bar fill images to renamed assets', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const level = src => {
    const project = installEngineScripts(createProject(), { includeHUD: false });
    project.events = [];
    project.assets.push({ id: 'shared_tex', name: 'Fill', kind: 'sprite', width: 1, height: 1, src });
    installDefaultHUD(project);
    project.hud.elements.find(element => element.type === 'bar').fillAssetId = 'shared_tex';
    return project;
  };
  // Same id, different artwork: the second level's copy is renamed on assembly.
  const project = assembleGameLevels([
    { id: 'MAP01', project: level(png) },
    { id: 'MAP02', project: level(png.replace('iVBOR', 'iVBOQ')) },
  ], 'MAP01', 'Campaign').project;
  const renamed = project.game.levels[1].assetIds.find(id => id.endsWith('shared_tex') && id !== 'shared_tex');
  assert.ok(renamed, 'the second level asset should be renamed');
  const second = project.game.levels[1].data.hud.elements.find(element => element.type === 'bar');
  assert.equal(second.fillAssetId, renamed);
  assert.doesNotThrow(() => validateProject(project));
});

test('hunt100 14: a secret exit on a Doom 1 secret level leaves it instead of looping back', () => {
  const level = () => {
    const project = installEngineScripts(createProject(), { includeHUD: false });
    project.events = [];
    return project;
  };
  const project = assembleGameLevels([
    { id: 'E1M3', project: level() },
    { id: 'E1M4', project: level() },
    { id: 'E1M9', project: level() },
  ], 'E1M3', 'Campaign').project;
  const byId = id => project.game.levels.find(entry => entry.id === id);
  // GZDoom's own doom1.txt: E1M9 exits to E1M4 by either door.
  assert.equal(byId('E1M9').next, 'E1M4');
  assert.equal(byId('E1M9').secretNext, 'E1M4');
  assert.equal(byId('E1M3').secretNext, 'E1M9');
  assert.equal(byId('E1M3').next, 'E1M4');
});

test('hunt100 15: a switch-operated lowering floor keeps working after the first use', () => {
  const project = createProject();
  project.events = [];
  const points = { v1: [-256, -32], v2: [-64, -32], v3: [-64, 32], v4: [-256, 32],
    v5: [64, -32], v6: [64, 32], v7: [256, -32], v8: [256, 32] };
  project.map.vertices = Object.entries(points).map(([id, [x, y]]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  const walls = [['v1', 'v2', 'roomA'], ['v2', 'v3', 'roomA', 'door'], ['v3', 'v4', 'roomA'], ['v4', 'v1', 'roomA'],
    ['v2', 'v5', 'door'], ['v5', 'v6', 'door', 'roomB'], ['v6', 'v3', 'door'],
    ['v5', 'v7', 'roomB'], ['v7', 'v8', 'roomB'], ['v8', 'v6', 'roomB']];
  project.map.walls = walls.map(([a, b, front, back], index) => ({
    id: `wall${index}`, a, b, height: 256, color: '#888888', solid: !back,
    ...(index === 1 ? { special: 45, tag: 2 } : {}),
    right: side(front), ...(back ? { left: side(back) } : {}),
  }));
  project.map.sectors = [
    { id: 'roomA', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
    { id: 'door', floorHeight: 64, ceilingHeight: 128, light: 255, sky: false, tag: 2 },
    { id: 'roomB', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
  ];
  project.map.entities[0] = { ...project.map.entities[0], x: -80, y: 0, angle: 0 };
  installEngineScripts(project);
  installWorldScripts(project, []);
  validateProject(project);
  // gzdoom base.txt: 45 = USE|REP Floor_LowerToHighest, so the switch is not switched off.
  const event = project.events.find(item => item.name.includes('45'));
  assert.ok(event, 'special 45 should generate a rule');
  assert.equal(event.once, false);
});
