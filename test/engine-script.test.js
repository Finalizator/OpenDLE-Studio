import test from 'node:test';
import assert from 'node:assert/strict';
import { shaderTemplate } from '../shared/shaders.js';
import { createProject, validateProject, removeEntity } from '../shared/project.js';
import { installEngineScripts, ENGINE_ACTIONS, ENGINE_CONDITIONS, defaultEngineCommand } from '../shared/engine-script.js';
import { createRuntime, lookPlayer, stepRuntime } from '../shared/runtime.js';
import { applyTool } from '../server/tools.js';
import { assembleGameLevels } from '../shared/game-levels.js';

function fixture() {
  const project = installEngineScripts(createProject());
  validateProject(project);
  return project;
}
function rule(project, condition, actions, extra = {}) {
  const event = { id: `rule_${project.events.length}`, enabled: true, once: false, condition, actions, ...extra };
  project.events.push(event);
  return event;
}
test('Engine defaults are portable editable sheets and installation never overwrites authored rules', () => {
  const legacy = createProject(), original = structuredClone(legacy.events), project = installEngineScripts(legacy);
  assert.deepEqual(project.events.slice(-2), original);
  assert.deepEqual(project.eventSheets.map(sheet => sheet.name), ['Input', 'Player', 'Combat', 'Weapons', 'Enemies', 'Pickups', 'World', 'HUD']);
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).playerControl, 'events');
  assert.throws(() => installEngineScripts(project), /already exist/);
  project.events.find(event => event.name === 'move_KeyW').actions[0].forward = 80;
  const state = createRuntime(project);
  stepRuntime(project, state, .05, new Set(['KeyW']));
  assert.equal(state.player.x, -176);
  const input = project.eventSheets.find(sheet => sheet.name === 'Input');
  input.enabled = false;
  const next = createRuntime(project);
  lookPlayer(next, 100, -100);
  stepRuntime(project, next, .05, new Set(['KeyW', 'ArrowRight', 'Space']));
  assert.equal(next.player.x, -180); assert.equal(next.player.angle, 0); assert.equal(next.player.pitch, 0);
});
test('scripted mouse sensitivity is editable and queued input is consumed once; legacy mouse is unchanged', () => {
  const project = fixture(), state = createRuntime(project);
  project.events.find(event => event.name === 'mouse_look').actions[0].sensitivity = .004;
  lookPlayer(state, 100, -50);
  assert.equal(state.player.angle, 0);
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.player.angle, .4); assert.equal(state.player.pitch, .2);
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.player.angle, .4);
  const legacy = createRuntime(createProject()); lookPlayer(legacy, 100, -50);
  assert.equal(legacy.player.angle, .2); assert.equal(legacy.player.pitch, .1);
});
test('validation rejects broken sheets, unbounded commands, invalid targets and unsafe input phases', () => {
  const mutations = [
    p => { p.eventSheets[1].id = p.eventSheets[0].id; },
    p => { p.eventSheets[0].enabled = 1; },
    p => { p.events[0].sheetId = 'missing'; },
    p => { p.eventSheets[0].phase = 'afterPhysics'; },
    p => { p.events[1].actions[0].forward = Infinity; },
    p => { p.events[0].actions[2].value = 0; },
    p => { p.events[0].forEachType = 'player'; },
    p => { p.events[0].forEachType = 'enemy'; p.events[0].ownerId = 'pickup'; },
    p => { rule(p, { type: 'timerReady', timer: 'bad name' }, [{ type: 'showMessage', message: 'x' }]); },
    p => { rule(p, { type: 'always' }, [{ type: 'hitscan', damage: 5, diceSides: 1.5, pellets: 1, spread: 0, range: 100 }]); },
    p => { rule(p, { type: 'always' }, [{ type: 'setEntityHealth', entityId: 'player', health: 10 }]); },
    p => { rule(p, { type: 'playerStat', stat: 'missing', operator: '>', value: 0 }, [{ type: 'showMessage', message: 'x' }]); },
  ];
  for (const mutate of mutations) {
    const project = fixture(); mutate(project); assert.throws(() => validateProject(project));
  }
});
test('every Engine command has shared editor defaults and validates after adding required references', () => {
  for (const command of [...ENGINE_ACTIONS, ...ENGINE_CONDITIONS]) {
    const project = fixture(), value = defaultEngineCommand(command.type);
    if (['loadGameLevel', 'selectGameEpisode'].includes(command.type))
      Object.assign(project, assembleGameLevels([{ id: 'MAP01', project: structuredClone(project) }], 'MAP01', project.title).project);
    if (['gameScreen', 'setGameScreen'].includes(command.type)) value.screen = 'playing';
    if (['setShaderUniform', 'setShaderEnabled', 'shaderEnabled'].includes(command.type)) {
      project.shaders = [{ id: 'test_shader', name: 'Test effect', language: 'glsl', source: shaderTemplate, uniforms: { strength: 1 } }];
      project.environment.shaderId = 'test_shader';
    }
    if (command.target) {
      const enemyCommand = ['moveEnemy', 'enemySeesPlayer', 'enemyHitscan', 'enemyProjectile', 'enemyAlert', 'enemyAttackChance'].includes(command.type);
      if (enemyCommand) project.map.entities.push({ id: 'test_enemy', name: 'Enemy', type: 'enemy', x: 0, y: 0, angle: 0 });
      value.entityId = enemyCommand ? 'test_enemy' : 'pickup';
      if (['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(command.type)) project.map.entities.find(e => e.id === value.entityId).variables = { value: 0 };
    }
    if (command.variable) value.variable = 'score';
    if (command.group) value.groupId = project.eventGroups[0].id;
    if (command.wall) value.wallId = project.map.walls[0].id;
    if (command.sector) value.sectorId = project.map.sectors[0].id;
    if (command.spriteClip) {
      project.assets.push({ id: 'clip_image', name: 'Frame', kind: 'sprite', width: 1, height: 1, src: 'data:image/png;base64,AAAA' });
      project.spriteClips = [{ id: 'test_clip', name: 'Test clip', frames: ['clip_image'], seconds: .1, loop: false }];
      value.clipId = 'test_clip';
    }
    if (command.hudElement) value.elementId = project.hud.elements.find(element => element.interactive).id;
    if (command.hudAnimation) value.animationId = project.hud.animations[0].id;
    const isCondition = ENGINE_CONDITIONS.includes(command);
    rule(project, isCondition ? value : { type: 'always' }, isCondition ? [{ type: 'showMessage', message: 'yes' }] : [value],
      { sheetId: project.eventSheets[0].id });
    validateProject(project);
  }
});
test('armor absorption, depletion, stat caps, death and reset are explicit visual actions', () => {
  const project = fixture();
  rule(project, { type: 'keyPressed', key: 'KeyF' }, [
    { type: 'setPlayerStat', stat: 'armor', value: 5 }, { type: 'damagePlayer', damage: 30 },
    { type: 'addPlayerStat', stat: 'health', value: 50, maximum: 100 },
  ]);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set(), new Set(['KeyF']));
  assert.equal(state.playerStats.armor, 0); assert.equal(state.playerStats.health, 100);
  rule(project, { type: 'always' }, [{ type: 'setPlayerStat', stat: 'armor', value: 100 },
    { type: 'setPlayerStat', stat: 'armorDivisor', value: 2 }, { type: 'damagePlayer', damage: 20 }], { once: true });
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.playerStats.armor, 90); assert.equal(state.playerStats.health, 90);
  assert.equal(createRuntime(project).playerStats.health, 100);
});
test('for-each rules resolve this object, once flags and timers independently for each instance', () => {
  const project = fixture();
  project.map.entities.push({ id: 'enemy1', name: 'First', type: 'enemy', x: 0, y: 100, angle: 0 },
    { id: 'enemy2', name: 'Second', type: 'enemy', x: 100, y: 100, angle: 0 });
  rule(project, { type: 'timerReady', timer: 'test' }, [
    { type: 'addVariable', variable: 'score', value: 1 }, { type: 'startTimer', timer: 'test', seconds: 1 },
  ], { forEachType: 'enemy' });
  rule(project, { type: 'always' }, [{ type: 'addVariable', variable: 'score', value: 10 }], { once: true, forEachType: 'enemy' });
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .05, new Set());
  assert.equal(state.variables.score, 22);
  stepRuntime(project, state, .05, new Set());
  assert.equal(state.variables.score, 22);
  for (let i = 0; i < 20; i++) stepRuntime(project, state, .05, new Set());
  assert.equal(state.variables.score, 24);
  removeEntity(project, 'enemy1'); validateProject(project);
});
test('pistol rules spend ammo and gate shots by simulation time; hitscan damages only the nearest living target', () => {
  const project = fixture();
  project.map.entities.push({ id: 'enemy1', name: 'Near', type: 'enemy', x: -80, y: 0, angle: 0, health: 100 },
    { id: 'enemy2', name: 'Far', type: 'enemy', x: 80, y: 0, angle: 0, health: 100 });
  const state = createRuntime(project);
  stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.playerStats.bullets, 49);
  assert.ok([85, 90, 95].includes(state.entities.find(entity => entity.id === 'enemy1').health));
  assert.equal(state.entities.find(entity => entity.id === 'enemy2').health, 100);
  for (let i = 0; i < 7; i++) stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.playerStats.bullets, 49);
  stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.playerStats.bullets, 48);
  state.playerStats.bullets = 0;
  for (let i = 0; i < 10; i++) stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.playerStats.bullets, 0);
  assert.equal(project.map.entities.find(entity => entity.id === 'enemy1').health, 100);
});
test('hitscan respects solid wall occlusion and vertical aim; defeated objects are handled by editable rules', () => {
  const project = fixture();
  project.map.entities.push({ id: 'outside', name: 'Blocked', type: 'enemy', x: 500, y: 0, angle: 0, health: 100 },
    { id: 'inside', name: 'Target', type: 'enemy', x: -80, y: 0, angle: 0, health: 1 });
  const state = createRuntime(project);
  state.player.pitch = 1;
  stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.entities.find(entity => entity.id === 'inside').health, 1);
  state.player.pitch = 0; state.timers.clear();
  stepRuntime(project, state, .05, new Set(['Mouse0']));
  stepRuntime(project, state, .05, new Set());
  assert.equal(state.entities.some(entity => entity.id === 'inside'), false);
  state.timers.clear(); stepRuntime(project, state, .05, new Set(['Mouse0']));
  assert.equal(state.entities.find(entity => entity.id === 'outside').health, 100);
});
test('MCP/DeepSeek can install, edit and organize the same executable Engine sheets', () => {
  const project = applyTool(createProject(), 'engine_install_starter', {}).project;
  const sheet = project.eventSheets[0];
  const updated = applyTool(project, 'event_sheet_update', { id: sheet.id, enabled: false }).project;
  assert.equal(updated.eventSheets[0].enabled, false); assert.equal(project.eventSheets[0].enabled, true);
  const event = project.events.find(event => event.name === 'move_KeyW');
  const edited = applyTool(project, 'events_update_rule', { id: event.id, actions: [{ type: 'movePlayer', forward: 64, strafe: 0 }] }).project;
  assert.equal(edited.events.find(item => item.id === event.id).actions[0].forward, 64);
  assert.throws(() => applyTool(project, 'event_sheet_update', { id: sheet.id, phase: 'afterPhysics' }), /beforePhysics/);
  const added = applyTool(project, 'event_sheet_add', { name: 'My world rules' }).project;
  assert.equal(added.eventSheets.at(-1).section, 'game');
});
