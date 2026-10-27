import { installDefaultHUD, HUD_PROPERTIES } from './hud.js';
import { PLAYER_STATS, AMMO_TYPES, WEAPONS, KEYS, FACE_EXPRESSIONS } from './player-state.js';
import { installEngineSounds } from './sound.js';
import { doomWalk } from './sprite-animation.js';
import { doomThings } from './doom-assets.js';
import { GAME_SETTINGS, GAME_BINDINGS } from './game-settings.js';

export const INPUT_KEYS = ['Tab', 'Enter', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE', 'KeyF', 'KeyQ',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Mouse0', 'Mouse2'];
const numeric = (name, value, min, max) => ({ name, value, kind: 'number', min, max });
const choice = (name, value, options) => ({ name, value, kind: 'choice', options });
const stat = () => choice('stat', 'health', PLAYER_STATS);
const comparison = () => choice('operator', '>', ['<', '<=', '=', '!=', '>=', '>']);
const timer = () => ({ name: 'timer', value: 'weapon', kind: 'text' });
const projectileClips = () => ['clipId', 'impactClipId'].map(name => ({ name, kind: 'text', optional: true }));

export const ENGINE_CONDITIONS = [
  { type: 'levelTransition', label: 'Game: level entered with campaign inventory', fields: [] },
  { type: 'gameScreen', label: 'Game: active menu / gameplay screen', fields: [{ name: 'screen', kind: 'text', value: 'title' }] },
  { type: 'shaderEnabled', label: 'Shader: effect is enabled', fields: [] },
  { type: 'expressionCompare', label: 'System: compare math / text expressions', fields: [
    { name: 'left', kind: 'value', value: 0 }, comparison(), { name: 'right', kind: 'value', value: 0 }] },
  { type: 'objectVariableCompare', label: 'Object: compare local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, comparison(), { name: 'value', kind: 'value', value: 0 }] },
  { type: 'playerReachesEntity', label: 'Player: overlaps pickup reach', target: true,
    fields: [numeric('distance', 36, 0, 65536), numeric('height', 112, 0, 65536), numeric('below', 32, 0, 65536),
      choice('reachOverSteps', 'yes', ['yes', 'no'])] },
  { type: 'playerTouchingSurface', label: 'Player: touching a surface',
    fields: [choice('surface', 'wall', ['wall', 'floor', 'ceiling', 'any'])] },
  { type: 'playerAirborne', label: 'Player: is on the ground / airborne', fields: [choice('state', 'airborne', ['airborne', 'grounded'])] },
  { type: 'playerInArea', label: 'Player: inside this object interaction area', target: true, fields: [] },
  { type: 'playerEnteredArea', label: 'Player: entered this object interaction area', target: true, fields: [] },
  { type: 'entityDamaged', label: 'Object: health decreased', target: true, fields: [] },
  { type: 'entityAlive', label: 'Object: is alive (health above zero)', target: true, fields: [] },
  { type: 'distanceBetween', label: 'Objects: compare distance between two objects', target: true, fields: [
    { name: 'otherId', kind: 'string', value: '$player' }, comparison(), numeric('distance', 128, 0, 65536)] },
  { type: 'spriteState', label: 'Object: sprite animation state', target: true, fields: [choice('state', 'walk', ['stand', 'walk', 'attack', 'pain', 'death'])] },
  { type: 'enemyAlert', label: 'Enemy: remembers player', target: true, fields: [] },
  { type: 'enemyHearsPlayer', label: 'Enemy: hears player weapon through open sectors', target: true, fields: [] },
  { type: 'wallActivated', label: 'World: player uses, crosses or shoots linedef', wall: true,
    fields: [choice('mode', 'use', ['use', 'cross', 'shoot'])] },
  { type: 'sectorMoving', label: 'World: sector surface is moving', sector: true,
    fields: [choice('surface', 'ceilingHeight', ['ceilingHeight', 'floorHeight'])] },
  { type: 'enemySeesPlayer', label: 'Enemy: player visible in range', fields: [numeric('range', 1024, 1, 65536),
    { ...numeric('fov', 360, 0, 360), optional: true }], target: true },
  { type: 'enemyAttackChance', label: 'Enemy: Doom distance-based attack decision', fields: [], target: true },
  { type: 'weaponOwned', label: 'Inventory: owns weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'weaponSelected', label: 'Inventory: selected weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'keyOwned', label: 'Inventory: owns key', fields: [choice('key', 'blueCard', KEYS)] },
  { type: 'backpackOwned', label: 'Inventory: owns backpack', fields: [] },
  { type: 'ammoBelowCapacity', label: 'Inventory: ammo below capacity', fields: [choice('ammo', 'bullets', AMMO_TYPES)] },
  { type: 'everySeconds', label: 'System: every N seconds', fields: [numeric('seconds', 1, .01, 3600)] },
  { type: 'randomChance', label: 'System: random chance (0-1)', fields: [numeric('probability', .5, 0, 1)] },
  { type: 'objectCount', label: 'Objects: count of live objects', fields: [
    choice('entityType', 'enemy', ['any', 'player', 'enemy', 'pickup', 'light', 'decoration']), comparison(), numeric('value', 0, 0, 100000)] },
  { type: 'entityAngle', label: 'Object: compare facing angle', target: true, fields: [comparison(), numeric('value', 0, -3600, 3600)] },
  { type: 'playerFeedback', label: 'Player: compare feedback signal', fields: [choice('signal', 'damage', ['damage', 'damageDirection', 'attackTime', 'weaponPickup']), comparison(), numeric('value', 0, -1e6, 1e6)] },
  { type: 'playerFace', label: 'Player: face expression', fields: [choice('expression', 'idle', FACE_EXPRESSIONS)] },
  { type: 'entityDoomType', label: 'Object: Doom thing type', fields: [numeric('doomType', 2007, 0, 65535)], target: true },
  { type: 'hudAnimationPlaying', label: 'HUD: animation is playing', fields: [], hudAnimation: true },
  { type: 'hudClicked', label: 'HUD: on element clicked', fields: [], hudElement: true },
  { type: 'hudFocused', label: 'HUD: element selected / focused', fields: [], hudElement: true },
  { type: 'hudAnimationFinished', label: 'HUD: on animation finished', fields: [], hudAnimation: true },
  { type: 'hudStatChanged', label: 'HUD: player stat changed', fields: [choice('stat', 'health', PLAYER_STATS), choice('direction', 'decreased', ['decreased', 'increased', 'changed'])] },
  { type: 'groupActive', label: 'System: group is active', fields: [], group: true },
  { type: 'keyHeld', label: 'Input: key / mouse button held', fields: [choice('key', 'KeyW', INPUT_KEYS)] },
  { type: 'mouseMoved', label: 'Input: mouse moved', fields: [] },
  { type: 'playerStat', label: 'Player: compare stat', fields: [stat(), comparison(), numeric('value', 0, -1e6, 1e6)] },
  { type: 'entityHealth', label: 'Object: compare health', fields: [comparison(), numeric('value', 0, -1e6, 1e6)], target: true },
  { type: 'entityHasHealth', label: 'Object: has explicit health', fields: [], target: true },
  { type: 'timerReady', label: 'System: timer ready', fields: [timer()] },
  { type: 'timerExists', label: 'System: timer exists', fields: [timer()] },
  { type: 'variableCompare', label: 'System: compare variable', fields: [comparison(), { name: 'value', kind: 'value', value: 0 }], variable: true },
];
export const ENGINE_ACTIONS = [
  { type: 'saveGame', label: 'Game: save to slot', fields: [numeric('slot', 1, 1, 6)] },
  { type: 'loadGame', label: 'Game: load slot', fields: [numeric('slot', 1, 1, 6)] },
  { type: 'confirmSaveGame', label: 'Game: confirm overwriting save', fields: [] },
  { type: 'setGameScreen', label: 'Game: open menu / resume', fields: [{ name: 'screen', kind: 'text', value: 'title' }] },
  { type: 'startGame', label: 'Game: start a new game', fields: [] },
  { type: 'selectGameEpisode', label: 'Game: select new game episode', fields: [{ name: 'levelId', kind: 'text', value: 'MAP01' }] },
  { type: 'loadGameLevel', label: 'Game: load a level', fields: [{ name: 'levelId', kind: 'text', value: 'MAP01' }] },
  { type: 'finishLevel', label: 'Game: finish level / follow exit', fields: [choice('exit', 'normal', ['normal', 'secret'])] },
  { type: 'continueIntermission', label: 'Game: continue after level intermission', fields: [] },
  { type: 'quitGame', label: 'Game: return to editor', fields: [] },
  { type: 'requestFullscreen', label: 'Game: toggle fullscreen', fields: [] },
  { type: 'resetGameSettings', label: 'Game: reset user settings', fields: [] },
  { type: 'captureGameBinding', label: 'Game: rebind a control', fields: [choice('key', 'KeyW', Object.keys(GAME_BINDINGS))] },
  { type: 'setGameSetting', label: 'Game: set user setting', fields: [choice('setting', 'volume', Object.keys(GAME_SETTINGS)), { name: 'value', kind: 'value', value: .8 }] },
  { type: 'adjustGameSetting', label: 'Game: adjust user setting', fields: [choice('setting', 'volume', Object.keys(GAME_SETTINGS)), numeric('amount', .1, -10, 10)] },
  { type: 'toggleGameSetting', label: 'Game: toggle user setting', fields: [choice('setting', 'muted', Object.keys(GAME_SETTINGS))] },
  { type: 'setShaderEnabled', label: 'Shader: enable / disable effect', fields: [choice('enabled', 'yes', ['yes', 'no'])] },
  { type: 'setShaderUniform', label: 'Shader: set numeric uniform', fields: [
    { name: 'uniform', kind: 'text', value: 'strength' }, numeric('value', 1, -1e6, 1e6)] },
  { type: 'setObjectVariable', label: 'Object: set local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, { name: 'value', kind: 'value', value: 0 }] },
  { type: 'addObjectVariable', label: 'Object: add to local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, numeric('value', 1, -1e12, 1e12)] },
  { type: 'setSpriteState', label: 'Object: play sprite state', target: true,
    fields: [choice('state', 'walk', ['stand', 'walk', 'attack', 'pain', 'death']), choice('restart', 'no', ['yes', 'no'])] },
  { type: 'playWeaponClip', label: 'Weapon: play firing animation', spriteClip: true, fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'moveSector', label: 'World: move sector surface', sector: true, fields: [
    choice('surface', 'ceilingHeight', ['ceilingHeight', 'floorHeight']), numeric('height', 128, -32768, 32767),
    numeric('speed', 70, .1, 4096), numeric('wait', 4, 0, 3600), choice('returnMode', 'return', ['stay', 'return', 'cycle']),
    { ...numeric('returnHeight', undefined, -32768, 32767), optional: true },
    { name: 'sound', value: 'DSDOROPN', kind: 'string', optional: true },
  ] },
  { type: 'playSound', label: 'Audio: play embedded sound by name', fields: [{ name: 'sound', value: 'DSPISTOL', kind: 'string' }, numeric('volume', .7, 0, 1)] },
  { type: 'spawnEntity', label: 'Object: spawn a new object from a template', fields: [
    { name: 'templateId', kind: 'text', value: '' }, numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', 0, -65536, 65536), optional: true }, { ...numeric('angle', 0, -3600, 3600), optional: true },
    { name: 'name', value: '', kind: 'string', optional: true }] },
  { type: 'rotateEntityBy', label: 'Object: rotate by (degrees, relative)', target: true, fields: [numeric('angle', 15, -3600, 3600)] },
  { type: 'setEntityTilt', label: 'Object: set model tilt (pitch / roll)', target: true, fields: [
    numeric('pitch', 0, -3600, 3600), numeric('roll', 0, -3600, 3600)] },
  { type: 'setPlayerPitch', label: 'Player: set view pitch (degrees)', fields: [numeric('pitch', 0, -85, 85)] },
  { type: 'setEntityScale', label: 'Object: set visual scale', target: true, fields: [numeric('scale', 1, .01, 20)] },
  { type: 'setGravityScale', label: 'Physics: set gravity scale', target: true, fields: [numeric('scale', 1, 0, 10)] },
  { type: 'setDamping', label: 'Physics: set linear damping', target: true, fields: [numeric('damping', .1, 0, 100)] },
  { type: 'moveEnemy', label: 'Enemy: move toward player with collision', fields: [numeric('speed', 80, 0, 1024)], target: true },
  { type: 'facePlayer', label: 'Enemy: face player for attack', fields: [], target: true },
  { type: 'enemyHitscan', label: 'Enemy: trace shot at player', fields: [numeric('damage', 3, 0, 10000), numeric('diceSides', 5, 1, 256), numeric('range', 1024, 1, 65536),
    { ...numeric('spread', 22.5, 0, 180), optional: true }, { ...numeric('pellets', 1, 1, 64), optional: true }], target: true },
  { type: 'launchProjectile', label: 'Combat: launch projectile from player', fields: [numeric('speed', 700, 1, 4096), numeric('damage', 20, 0, 10000),
    numeric('diceSides', 8, 1, 256), numeric('radius', 128, 0, 1024), choice('color', '#ff8833', ['#ff8833', '#66bbff', '#66ff88']),
    { name: 'sound', value: 'DSBAREXP', kind: 'string', optional: true }, ...projectileClips()] },
  { type: 'enemyProjectile', label: 'Enemy: launch projectile at player', fields: [numeric('speed', 300, 1, 4096), numeric('damage', 3, 0, 10000),
    numeric('diceSides', 8, 1, 256), numeric('radius', 0, 0, 1024), choice('color', '#ff8833', ['#ff8833', '#66bbff', '#66ff88']),
    { name: 'sound', value: 'DSFIRXPL', kind: 'string', optional: true }, ...projectileClips()], target: true },
  { type: 'setWeaponOwned', label: 'Inventory: set weapon ownership', fields: [choice('weapon', 'pistol', WEAPONS), choice('owned', 'yes', ['yes', 'no'])] },
  { type: 'selectWeapon', label: 'Inventory: select owned weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'setKeyOwned', label: 'Inventory: set key ownership', fields: [choice('key', 'blueCard', KEYS), choice('owned', 'yes', ['yes', 'no'])] },
  { type: 'addAmmo', label: 'Inventory: add ammo (capacity limited)', fields: [choice('ammo', 'bullets', AMMO_TYPES), numeric('amount', 10, -1000000, 1000000)] },
  { type: 'giveBackpack', label: 'Inventory: give backpack (double capacities once)', fields: [] },
  { type: 'setPlayerFace', label: 'Player: set face expression', fields: [choice('expression', 'idle', FACE_EXPRESSIONS)] },
  { type: 'setHUDCursor', label: 'HUD: set cursor / game input mode', fields: [choice('mode', 'cursor', ['cursor', 'game', 'toggle'])] },
  { type: 'setHUDVisible', label: 'HUD: set element visible', fields: [choice('visible', 'yes', ['yes', 'no'])], hudElement: true },
  { type: 'setHUDText', label: 'HUD: set text (clears binding)', fields: [{ name: 'text', value: 'Text', kind: 'string' }], hudElement: true },
  { type: 'setHUDBinding', label: 'HUD: bind text / bar to engine value', fields: [{ name: 'binding', value: 'health', kind: 'string' }], hudElement: true },
  { type: 'setHUDProperty', label: 'HUD: set numeric property', fields: [choice('property', 'opacity', HUD_PROPERTIES), numeric('value', 1, -1e9, 1e9)], hudElement: true },
  { type: 'playHUDAnimation', label: 'HUD: play / restart animation', fields: [], hudAnimation: true },
  { type: 'stopHUDAnimation', label: 'HUD: stop animation (hold pose)', fields: [], hudAnimation: true },
  { type: 'setGroupActive', label: 'System: set group active', fields: [choice('active', 'yes', ['yes', 'no'])], group: true },
  { type: 'movePlayer', label: 'Player: add local movement', fields: [numeric('forward', 160, -4096, 4096), numeric('strafe', 0, -4096, 4096)] },
  { type: 'turnPlayer', label: 'Player: turn (degrees / second)', fields: [numeric('speed', 126, -3600, 3600)] },
  { type: 'mouseLook', label: 'Player: apply mouse movement', fields: [numeric('sensitivity', .002, .00001, .1), choice('vertical', 'enabled', ['enabled', 'disabled'])] },
  { type: 'jumpPlayer', label: 'Player: request jump', fields: [] },
  { type: 'setPlayerGravity', label: 'Player: set gravity direction (walk on that surface)',
    fields: [choice('mode', 'world', ['world', 'nearest', 'wall', 'floor', 'ceiling']), numeric('reach', 8, 0, 128)] },
  { type: 'setPlayerStat', label: 'Player: set stat', fields: [stat(), numeric('value', 100, 0, 1000000)] },
  { type: 'addPlayerStat', label: 'Player: add capped stat', fields: [stat(), numeric('value', 10, -1000000, 1000000), numeric('maximum', 100, 0, 1000000)] },
  { type: 'damagePlayer', label: 'Player: damage through armor', fields: [numeric('damage', 10, 0, 1000000),
    { ...choice('direction', 'front', ['front', 'left', 'right', 'self']), optional: true }] },
  { type: 'setEntityHealth', label: 'Object: set health', fields: [numeric('health', 20, 0, 1000000)], target: true },
  { type: 'hitscan', label: 'Combat: trace and damage enemies', fields: [numeric('damage', 5, 0, 10000), numeric('diceSides', 3, 1, 256),
    numeric('pellets', 1, 1, 64), numeric('spread', 0, 0, 180), numeric('range', 2048, 1, 65536)] },
  { type: 'startTimer', label: 'System: start timer (seconds)', fields: [timer(), numeric('seconds', .4, 0, 3600)] },
  { type: 'clearTimer', label: 'System: clear timer', fields: [timer()] },
  { type: 'showPlayerHUD', label: 'HUD: show / hide overlay (legacy stats)', fields: [choice('visible', 'yes', ['yes', 'no'])] },
];
export function engineCommand(type) {
  return [...ENGINE_CONDITIONS, ...ENGINE_ACTIONS].find(command => command.type === type);
}
export function defaultEngineCommand(type) {
  const command = engineCommand(type);
  return { type, ...Object.fromEntries(command.fields.map(field => [field.name, field.value])) };
}
export const WALL_WALK_SHEET = 'Wall walking (experiment)';

/**
 * A short, fully editable example of gravity scripting: jump at a wall or a ceiling
 * to walk on it, and touch a floor (or hold F) to drop back to normal gravity.
 * Reinstalling replaces only this sheet's rules.
 */
export function installWallWalkDemo(project) {
  const used = new Set([...(project.eventSheets || []).map(item => item.id), ...project.events.map(item => item.id)]);
  const id = name => {
    let result = name, suffix = 1;
    while (used.has(result)) result = `${name}_${suffix++}`;
    used.add(result); return result;
  };
  const existing = (project.eventSheets || []).find(sheet => sheet.name === WALL_WALK_SHEET);
  const sheet = existing || { id: id('engine_wall_walk'), name: WALL_WALK_SHEET, section: 'engine', enabled: true, phase: 'afterPhysics' };
  if (!existing) project.eventSheets = [...(project.eventSheets || []), sheet];
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  const gravity = mode => ({ type: 'setPlayerGravity', mode, reach: 8 });
  const rules = [
    { name: 'demo_hint', condition: { type: 'onStart' }, conditions: [],
      actions: [{ type: 'showMessage', message: 'Wall walking: jump at a wall or ceiling to walk on it. Hold F to drop back.' }] },
    { name: 'walk_on_walls', condition: { type: 'playerTouchingSurface', surface: 'wall' },
      conditions: [{ type: 'playerAirborne', state: 'airborne' }], actions: [gravity('wall')] },
    { name: 'walk_on_ceilings', condition: { type: 'playerTouchingSurface', surface: 'ceiling' },
      conditions: [{ type: 'playerAirborne', state: 'airborne' }], actions: [gravity('ceiling')] },
    { name: 'back_to_world_gravity', condition: { type: 'playerTouchingSurface', surface: 'floor' },
      conditions: [], actions: [gravity('world')] },
    { name: 'drop_to_world_gravity', condition: { type: 'keyHeld', key: 'KeyF' }, conditions: [], actions: [gravity('world')] },
  ];
  project.events = [...project.events, ...rules.map(rule => ({
    id: id(`engine_${rule.name}`), sheetId: sheet.id, enabled: true, once: false, conditions: [], ...rule }))];
  return sheet.id;
}

export function compareValues(a, operator, b) {
  switch (operator) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '!=': return a !== b;
    case '>=': return a >= b;
    case '>': return a > b;
    default: throw new Error(`Unknown comparison: ${operator}`);
  }
}

export function installEngineScripts(project, { organizeStarter = false, includeHUD = true } = {}) {
  if (project.playerControl === 'events' || project.eventSheets?.some(sheet => sheet.section === 'engine')) {
    throw new Error('Engine sheets already exist; edit the existing defaults instead of replacing your rules');
  }
  installEngineSounds(project);
  const used = new Set([
    ...['vertices', 'walls', 'sectors', 'entities'].flatMap(key => (project.map[key] || []).map(item => item.id)),
    ...(project.assets || []).map(item => item.id), ...project.events.map(item => item.id),
    ...(project.eventSheets || []).map(item => item.id),
    ...(project.eventGroups || []).map(item => item.id),
    ...(project.hud ? [...project.hud.elements, ...project.hud.fonts, ...project.hud.animations].map(item => item.id) : []),
  ]);
  const id = name => {
    let result = name, suffix = 1;
    while (used.has(result)) result = `${name}_${suffix++}`;
    used.add(result); return result;
  };
  const sheets = Object.fromEntries(['Input', 'Player', 'Combat', 'Weapons', 'Enemies', 'Pickups', 'World', 'HUD'].map(name => {
    const sheet = { id: id(`engine_${name.toLowerCase()}`), name, section: 'engine', enabled: true,
      phase: ['Input', 'Player'].includes(name) ? 'beforePhysics' : 'afterPhysics' };
    return [name, sheet];
  }));
  project.eventSheets = [...(project.eventSheets || []), ...Object.values(sheets)];
  const groups = Object.fromEntries(Object.entries(sheets).map(([name, sheet]) => [name, {
    id: id(`group_${name.toLowerCase()}`), sheetId: sheet.id, name, enabled: true,
    description: name === 'Input' ? 'Editable player controls. Input actions execute before physics.'
      : name === 'Enemies' ? 'Editable per-archetype visibility, chase, attacks and per-instance cooldowns.'
      : `Editable ${name.toLowerCase()} rules.`,
  }]));
  project.eventGroups = [...(project.eventGroups || []), ...Object.values(groups)];
  project.playerControl = 'events';
  const events = [];
  function rule(sheet, name, condition, actions, conditions = [], extra = {}) {
    events.push({ id: id(`engine_${name}`), name, sheetId: sheets[sheet].id, groupId: groups[sheet].id,
      enabled: true, once: false, condition, conditions, actions, ...extra });
  }
  const alive = { type: 'playerStat', stat: 'health', operator: '>', value: 0 };
  rule('Player', 'initial_stats', { type: 'onStart' }, [
    { type: 'setPlayerStat', stat: 'health', value: 100 }, { type: 'setPlayerStat', stat: 'armor', value: 0 },
    { type: 'setPlayerStat', stat: 'armorDivisor', value: 3 }, { type: 'setPlayerStat', stat: 'bullets', value: 50 },
  ], [{ type: 'levelTransition', inverted: true }]);
  for (const [key, forward, strafe] of [['KeyW', 160, 0], ['KeyS', -160, 0], ['KeyA', 0, -160], ['KeyD', 0, 160]]) {
    rule('Input', `move_${key}`, { type: 'keyHeld', key }, [{ type: 'movePlayer', forward, strafe }], [alive]);
  }
  for (const [key, speed] of [['ArrowLeft', -126], ['ArrowRight', 126]]) {
    rule('Input', `turn_${key}`, { type: 'keyHeld', key }, [{ type: 'turnPlayer', speed }], [alive]);
  }
  rule('Input', 'mouse_look', { type: 'mouseMoved' }, [{ type: 'mouseLook', sensitivity: .002, vertical: 'enabled' }], [alive]);
  rule('Input', 'jump', { type: 'keyPressed', key: 'Space' }, [{ type: 'jumpPlayer' }], [alive]);
  const trace = (damage, diceSides, pellets, spread, range) => ({ type: 'hitscan', damage, diceSides, pellets, spread, range });
  const missile = (speed, damage, diceSides, radius, color) => ({ type: 'launchProjectile', speed, damage, diceSides, radius, color, sound: radius ? 'DSBAREXP' : 'DSFIRXPL' });
  const weapons = [
    ['fist', null, 0, 22, 'DSPUNCH', trace(2, 10, 1, 0, 64)],
    ['pistol', 'bullets', 1, 14, 'DSPISTOL', trace(5, 3, 1, 0, 2048)],
    ['shotgun', 'shells', 1, 35, 'DSSHOTGN', trace(5, 3, 7, 11.25, 2048)],
    ['chaingun', 'bullets', 1, 4, 'DSPISTOL', trace(5, 3, 1, 5.625, 2048)],
    ['rocketLauncher', 'rockets', 1, 20, 'DSRLAUNC', missile(700, 20, 8, 128, '#ff8833')],
    ['plasmaRifle', 'cells', 1, 3, 'DSPLASMA', missile(875, 5, 8, 0, '#66bbff')],
    ['bfg', 'cells', 40, 60, 'DSBFG', missile(875, 100, 8, 256, '#66ff88')],
    ['chainsaw', null, 0, 4, 'DSSAWFUL', trace(2, 10, 1, 0, 64)],
    ['superShotgun', 'shells', 2, 54, 'DSSGT2F', trace(5, 3, 20, 22.5, 2048)],
  ];
  // When the project carries imported actor definitions, the actor runtime runs
  // the game's own monster and weapon state machines. Generated rules would fire
  // a second time on top of them, so only the untouched paths are scripted here.
  const scriptedWeapons = !project.actors?.some(actor => actor.flags?.WEAPON);
  const scriptedEnemies = !project.actors?.some(actor => actor.states?.frames?.length && (actor.flags?.MONSTER || actor.flags?.COUNTKILL));
  for (const [weapon, ammo, cost, tics, sound, attack] of (scriptedWeapons ? weapons : [])) {
    rule('Weapons', weapon, { type: 'keyHeld', key: 'Mouse0' }, [
      ...(ammo ? [{ type: 'addAmmo', ammo, amount: -cost }] : []), attack,
      { type: 'playSound', sound, volume: .7 },
      { type: 'startTimer', timer: 'weapon', seconds: tics / 35 },
    ], [alive, { type: 'weaponSelected', weapon }, { type: 'weaponOwned', weapon },
      ...(ammo ? [{ type: 'playerStat', stat: ammo, operator: '>=', value: cost }] : []), { type: 'timerReady', timer: 'weapon' }]);
  }
  for (const [key, weapon] of WEAPONS.map((weapon, index) => [`Digit${index + 1}`, weapon])) {
    rule('Input', `select_${weapon}`, { type: 'keyPressed', key }, [{ type: 'selectWeapon', weapon }], [{ type: 'weaponOwned', weapon }]);
  }
  const profiles = {
    3004: [20, 48, 3, 5, 'hitscan'], 9: [30, 48, 3, 5, 'hitscan'], 65: [70, 64, 3, 5, 'hitscan'],
    3001: [60, 64, 3, 8, 'projectile'], 3002: [150, 80, 4, 10, 'melee'], 58: [150, 80, 4, 10, 'melee'],
    3006: [100, 96, 3, 8, 'projectile'], 3005: [400, 48, 5, 8, 'projectile'],
    69: [500, 64, 8, 8, 'projectile'], 3003: [1000, 64, 8, 8, 'projectile'],
    68: [500, 64, 5, 8, 'projectile'], 71: [400, 48, 3, 8, 'projectile'], 66: [300, 80, 6, 8, 'projectile'],
    67: [600, 48, 8, 8, 'projectile'], 64: [700, 96, 10, 8, 'hitscan'], 16: [4000, 64, 20, 8, 'projectile'], 7: [3000, 48, 3, 5, 'hitscan'],
  };
  const present = scriptedEnemies
    ? [...new Set([0, ...project.map.entities.filter(entity => entity.type === 'enemy').map(entity => entity.doomType ?? 0)])] : [];
  for (const [name, condition] of [
    ['hear_weapon', { type: 'enemyHearsPlayer', entityId: '$self' }],
    ['remember_target', { type: 'enemyAlert', entityId: '$self' }],
  ]) rule('Enemies', name, condition, [{ type: 'startTimer', timer: 'alert', seconds: 8 }],
    [{ type: 'entityHealth', entityId: '$self', operator: '>', value: 0 }, alive], { forEachType: 'enemy' });
  for (const type of present) {
    const [health, fallbackSpeed, damage, diceSides, style] = profiles[type] || [20, 64, 3, 5, 'hitscan'];
    const speed = doomWalk[doomThings[type]?.[0]]?.[2] ?? fallbackSpeed;
    const filter = [{ type: 'entityDoomType', entityId: '$self', doomType: type }];
    const living = [{ type: 'entityHealth', entityId: '$self', operator: '>', value: 0 }, alive, ...filter];
    rule('Player', `enemy_${type}_health`, { type: 'onStart' }, [{ type: 'setEntityHealth', entityId: '$self', health }],
      [...filter, { type: 'entityHasHealth', entityId: '$self', inverted: true }], { forEachType: 'enemy' });
    rule('Player', `enemy_${type}_reaction`, { type: 'onStart' },
      [{ type: 'startTimer', timer: 'attack', seconds: 8 / 35 }], filter, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_hurt_alert`, { type: 'entityDamaged', entityId: '$self' },
      [{ type: 'startTimer', timer: 'alert', seconds: 8 }], living, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_notice`, { type: 'enemySeesPlayer', entityId: '$self', range: 2048, fov: 180 },
      [{ type: 'startTimer', timer: 'alert', seconds: 8 }], living, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_chase`, { type: 'enemyAlert', entityId: '$self' },
      [{ type: 'moveEnemy', entityId: '$self', speed }], [...living, { type: 'timerReady', timer: 'attackPose' }], { forEachType: 'enemy' });
    const windup = (type === 3001 || [3003, 69].includes(type) ? 16 : 10) / 35;
    const recovery = (type === 65 ? 8 : 25) / 35;
    rule('Enemies', `enemy_${type}_decision`, { type: 'enemySeesPlayer', entityId: '$self', range: style === 'melee' ? 64 : 768 },
      [{ type: 'startTimer', timer: 'attack', seconds: 8 / 35 }],
      [...living, { type: 'enemyAlert', entityId: '$self' }, { type: 'timerReady', timer: 'attack' },
        { type: 'timerExists', timer: 'attackWindup', inverted: true }], { forEachType: 'enemy' });
    const decision = events.at(-1).id;
    const playerId = project.map.entities.find(entity => entity.type === 'player').id;
    const distance = `distance(property("$self","x"), property("$self","y"), property("${playerId}","x"), property("${playerId}","y"))`;
    const attackDistance = `max(0, ${distance} - 64)${[3001, 3003, 69, 66].includes(type) ? '' : ' - 128'}`;
    const threshold = `clamp((${attackDistance})${[16, 7, 3006].includes(type) ? ' / 2' : ''}, 0, 200)`;
    rule('Enemies', `enemy_${type}_attack`, { type: 'expressionCompare', left: { expr: style === 'melee' ? distance : 'floor(random(0, 256))' },
      operator: style === 'melee' ? '<=' : '>=', right: style === 'melee' ? 64 : { expr: threshold } }, [
      { type: 'facePlayer', entityId: '$self' },
      { type: 'startTimer', timer: 'attackWindup', seconds: windup },
      { type: 'startTimer', timer: 'attackPose', seconds: windup + 8 / 35 },
      { type: 'startTimer', timer: 'attack', seconds: windup + recovery },
    ], [], { forEachType: 'enemy', parentId: decision });
    rule('Enemies', `enemy_${type}_fire`, { type: 'timerExists', timer: 'attackWindup' }, [
      { type: 'clearTimer', timer: 'attackWindup' },
      style === 'projectile' ? { type: 'enemyProjectile', entityId: '$self', speed: 300, damage, diceSides, radius: 0, color: '#ff8833', sound: 'DSFIRXPL' }
        : { type: 'enemyHitscan', entityId: '$self', damage, diceSides, range: style === 'melee' ? 64 : 768,
          spread: style === 'melee' ? 0 : 22.5, pellets: type === 9 || type === 7 ? 3 : 1 },
      { type: 'playSound', sound: style === 'projectile' ? 'DSRLAUNC' : type === 9 ? 'DSSHOTGN' : 'DSPISTOL', volume: .4 },
    ], [...living, { type: 'timerReady', timer: 'attackWindup' }], { forEachType: 'enemy' });
  }
  rule('Combat', 'remove_dead_enemies', { type: 'entityHealth', entityId: '$self', operator: '<=', value: 0 },
    [{ type: 'playSound', sound: 'DSPODTH1', volume: .5 }, { type: 'removeEntity', entityId: '$self' }], [], { forEachType: 'enemy' });
  rule('Combat', 'player_pain', { type: 'hudStatChanged', stat: 'health', direction: 'decreased' },
    [{ type: 'playSound', sound: 'DSPLPAIN', volume: .7 }], [alive]);
  rule('Combat', 'player_death', { type: 'playerStat', stat: 'health', operator: '<=', value: 0 },
    [{ type: 'showMessage', message: 'You died. Stop and Play to restart.' }], [], { once: true });
  rule('HUD', 'player_stats', { type: 'always' }, [{ type: 'showPlayerHUD', visible: 'yes' }]);
  if (organizeStarter) for (const event of project.events) {
    event.sheetId = event.ownerId ? sheets.Pickups.id : sheets.World.id;
    event.groupId = event.ownerId ? groups.Pickups.id : groups.World.id;
  }
  // Initialization must precede the input sheets, regardless of tree presentation.
  if (!project.hud && includeHUD) installDefaultHUD(project);
  project.events = [...events, ...project.events];
  return project;
}
