import { createRuntime } from './runtime.js';
import { selectGameLevel } from './game-levels.js';
import { validatePhysicsState } from './physics.js';
import { gameSettings } from './game-settings.js';
import { KEYS, WEAPONS } from './player-state.js';
import { WORLD_UP } from './gravity.js';

export const GAME_SAVE_VERSION = 1;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
// Presentation and menu-only fields are recreated by the host and are never persisted.
// Diagnostics and derived handles stay out of saves: the unsupported-action set is
// rebuilt as problems occur, and the weapon machine is re-entered on load.
const omitted = new Set(['physics', 'scripts', 'saveSlots', 'saveStatus', 'pendingSaveSlot', 'rendererStatus',
  'actorUnsupported', 'weaponActor', 'weaponFlash', 'missileGaps', 'areaEntries', 'surfaces', 'intervals']);
const legacyDiscarded = new Set(['rendererStatus']);
// Imported actors run their own tic clocks and weapon machine, so these fields only
// exist once a game with an actor table has been played.
const optional = new Set(['lastShot', 'playerNoise', 'soundFlood', 'menuHistory', 'bunnyhop', 'spawnSequence',
  'scriptState', 'scriptWarning', 'damageAcc', 'musicRequest', 'skyRequest', 'gravity', 'airControl', 'scriptLog',
  'messageCount', 'buttons', 'prevButtons', 'actorClock', 'weaponClock', 'weaponSlot', 'weaponReady', 'playerMorph', 'cameraTextures',
  'weaponTriggerHeld', 'weaponLight', 'weaponRaised', 'weaponAttack', 'projectileClock']);
const fail = message => { throw new Error(`Invalid game save: ${message}`); };
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(child => canonical(child) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** Compute once from the unmodified preview project, including every level and embedded asset. */
export async function gameSaveIdentity(project) {
  let content = project;
  if (project.game) {
    const shared = new Set(['version', 'title', 'assets', 'game']);
    const activeData = Object.fromEntries(Object.entries(project).filter(([key]) => !shared.has(key)));
    content = { version: project.version, title: project.title, assets: project.assets,
      game: { ...project.game, active: project.game.entry, levels: project.game.levels.map(level =>
        level.id === project.game.active ? { ...level, data: activeData } : level) } };
  }
  const bytes = new TextEncoder().encode(canonical(content));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `opendle-save-v1:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

// Tagged containers avoid collisions with user variable names and preserve non-JSON values.
function encode(value, ancestors = new Set(), depth = 0) {
  if (depth > 80) fail('snapshot is too deeply nested');
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { type: 'number', value: String(value) };
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) fail('unsupported or cyclic runtime value');
  ancestors.add(value);
  const visit = child => encode(child, ancestors, depth + 1);
  let result;
  if (value instanceof Map) result = { type: 'map', value: [...value].map(([key, child]) => [visit(key), visit(child)]) };
  else if (value instanceof Set) result = { type: 'set', value: [...value].map(visit) };
  else if (Array.isArray(value)) result = { type: 'array', value: value.map(visit) };
  else if (plain(value)) result = { type: 'object', value: Object.entries(value).map(([key, child]) => {
    if (forbidden.has(key)) fail('unsafe property');
    return [key, visit(child)];
  }) };
  else fail('unsupported runtime object');
  ancestors.delete(value);
  return result;
}

function decode(value, budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 2_000_000 || depth > 80) fail('snapshot exceeds safety limits');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('unencoded number'); return value; }
  if (!plain(value) || Object.keys(value).some(key => key !== 'type' && key !== 'value')) fail('invalid encoded value');
  if (value.type === 'undefined' && Object.keys(value).length === 1) return undefined;
  if (value.type === 'number' && ['NaN', 'Infinity', '-Infinity'].includes(value.value)) return Number(value.value);
  if (!['object', 'array', 'map', 'set'].includes(value.type) || !Array.isArray(value.value)) fail('invalid container');
  const visit = child => decode(child, budget, depth + 1);
  if (value.type === 'array') return value.value.map(visit);
  if (value.type === 'set') {
    const result = new Set(value.value.map(visit));
    if (result.size !== value.value.length) fail('duplicate set entry');
    return result;
  }
  const result = value.type === 'map' ? new Map() : {};
  for (const pair of value.value) {
    if (!Array.isArray(pair) || pair.length !== 2) fail('invalid entry');
    const key = value.type === 'map' ? visit(pair[0]) : pair[0], child = visit(pair[1]);
    if (value.type === 'map') {
      if (result.has(key)) fail('duplicate map entry');
      result.set(key, child);
    } else {
      if (typeof key !== 'string' || forbidden.has(key) || Object.hasOwn(result, key)) fail('unsafe or duplicate property');
      result[key] = child;
    }
  }
  return result;
}

// An accidental-corruption check, not an authentication mechanism.
function checksum(value) {
  const text = JSON.stringify(value);
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 2246822519);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

function matchShape(value, template, path) {
  if (template === null || template === undefined) return;
  if (template instanceof Map || template instanceof Set) {
    if (!(value instanceof template.constructor)) fail(`${path} has the wrong collection type`);
  } else if (Array.isArray(template)) {
    if (!Array.isArray(value)) fail(`${path} must be an array`);
  } else if (plain(template)) {
    if (!plain(value)) fail(`${path} must be an object`);
    for (const [key, child] of Object.entries(template)) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key} is missing`);
      matchShape(value[key], child, `${path}.${key}`);
    }
  } else if (typeof value !== typeof template || typeof template === 'number' &&
    Number.isFinite(template) && !Number.isFinite(value)) fail(`${path} has the wrong value type`);
}

function validateRuntime(project, state, baseline) {
  if (!plain(state)) fail('snapshot must be an object');
  // Saves made before the player could stand on walls have no gravity axis.
  if (plain(state.player) && state.player.up === undefined) state.player.up = [...WORLD_UP];
  for (const key of Object.keys(state)) if (omitted.has(key) || !Object.hasOwn(baseline, key) && !optional.has(key)) fail(`unknown runtime field ${key}`);
  for (const [key, value] of Object.entries(baseline)) if (!omitted.has(key)) {
    if (!Object.hasOwn(state, key)) fail(`missing runtime field ${key}`);
    matchShape(state[key], value, key);
  }
  if (state.gameScreen !== 'playing' || !state.hasGame || state.playerStats.health <= 0 ||
    state.intermission !== null || state.hudState.cursor !== false ||
    state.menuRequests.length || state.bindingKey !== null) fail('save is not a resumable living game');
  if (state.time < 0 || !Number.isInteger(state.randomSeed) || state.randomSeed < 0 || state.randomSeed > 0xffffffff) fail('invalid clock or RNG');
  for (const key of ['x', 'y', 'angle', 'pitch']) if (!Number.isFinite(state.player[key])) fail(`invalid player ${key}`);
  if (state.player.z !== undefined && !Number.isFinite(state.player.z)) fail('invalid player z');
  const entities = new Map(baseline.entities.map(entity => [entity.id, entity])), seen = new Set();
  for (const entity of state.entities) {
    if (!plain(entity) || seen.has(entity.id)) fail('unknown or duplicate entity');
    const template = entities.get(entity.id) || (typeof entity.spawnedFrom === 'string' && entities.get(entity.spawnedFrom));
    if (!template) fail('unknown entity');
    seen.add(entity.id); matchShape(entity, template, `entity ${entity.id}`);
    for (const key of ['x', 'y']) if (!Number.isFinite(entity[key])) fail('invalid entity position');
    if (entity.z !== undefined && !Number.isFinite(entity.z)) fail('invalid entity height');
  }
  if (!seen.has(baseline.entities.find(entity => entity.type === 'player').id)) fail('missing player entity');
  for (const key of ['sectors', 'walls']) {
    const originals = new Map(baseline[key].map(item => [item.id, item])), ids = new Set();
    if (state[key].length !== originals.size) fail(`incomplete ${key}`);
    for (const item of state[key]) {
      if (!plain(item) || !originals.has(item.id) || ids.has(item.id)) fail(`invalid ${key}`);
      ids.add(item.id); matchShape(item, originals.get(item.id), key);
    }
  }
  for (const [id, value] of state.timers) if (typeof id !== 'string' || typeof value !== 'number' || Number.isNaN(value)) fail('invalid script timer');
  for (const [id, enabled] of state.groups) if (!baseline.groups.has(id) || typeof enabled !== 'boolean') fail('invalid event group');
  const events = new Set((project.events || []).flatMap(event => event.forEachType
    ? project.map.entities.filter(entity => entity.type === event.forEachType).map(entity => `${event.id}:${entity.id}`)
    : [event.id]));
  for (const id of state.fired) if (typeof id !== 'string' || !events.has(id)) fail('invalid fired event');
  for (const [key, allowed] of [['keys', KEYS], ['weapons', WEAPONS]])
    for (const id of state.inventory[key]) if (!allowed.includes(id)) fail('invalid inventory');
  if (!WEAPONS.includes(state.inventory.selectedWeapon) || !state.inventory.weapons.has(state.inventory.selectedWeapon))
    fail('invalid selected weapon');
  if (state.groups.size !== baseline.groups.size) fail('missing event groups');
  const stringSet = (set, allowed, label) => {
    for (const id of set) if (typeof id !== 'string' || allowed && !allowed.has(id)) fail(`invalid ${label}`);
  };
  const entityIds = new Set(project.map.entities.map(entity => entity.id));
  const wallIds = new Set(project.map.walls.map(wall => wall.id));
  stringSet(state.animationFinished, entityIds, 'finished animations');
  stringSet(state.worldTriggers.cross, wallIds, 'crossed walls');
  stringSet(state.worldTriggers.shoot, wallIds, 'shot walls');
  if (state.worldTriggers.use !== null && !wallIds.has(state.worldTriggers.use)) fail('invalid used wall');
  const numberMap = (map, label) => {
    for (const [key, value] of map) if (typeof key !== 'string' || typeof value !== 'number' || Number.isNaN(value)) fail(`invalid ${label}`);
  };
  for (const key of ['entitySamples', 'shaderUniforms']) numberMap(state[key], key);
  numberMap(state.hudState.statSamples, 'HUD stat samples');
  const objectMap = (map, allowed, fields, label) => {
    for (const [id, item] of map) {
      if (typeof id !== 'string' || allowed && !allowed.has(id) || !plain(item)) fail(`invalid ${label}`);
      for (const [key, type] of Object.entries(fields))
        if (typeof item[key] !== type || type === 'number' && !Number.isFinite(item[key])) fail(`invalid ${label}.${key}`);
    }
  };
  objectMap(state.spriteAnimations, entityIds, { clipId: 'string', name: 'string', start: 'number' }, 'sprite animations');
  objectMap(state.weaponAnimations, new Set(WEAPONS), { clipId: 'string', start: 'number' }, 'weapon animations');
  objectMap(state.enemyMoves, entityIds, { direction: 'number', remaining: 'number' }, 'enemy movement');
  objectMap(state.animations, entityIds, { clip: 'string', speed: 'number', loop: 'boolean', playing: 'boolean', revision: 'number' }, 'model animations');
  const sectorIds = new Set(project.map.sectors.map(sector => sector.id));
  for (const [key, motion] of state.sectorMotions) {
    if (!plain(motion) || !sectorIds.has(motion.sectorId) || !['floorHeight', 'ceilingHeight'].includes(motion.surface) ||
      key !== `${motion.sectorId}:${motion.surface}` || !['out', 'return'].includes(motion.direction) ||
      !['origin', 'waiting', 'height', 'speed'].every(field => Number.isFinite(motion[field]))) fail('invalid sector motion');
  }
  if (state.hudState.elements.size !== baseline.hudState.elements.size) fail('missing HUD elements');
  for (const [id, element] of state.hudState.elements) {
    if (!baseline.hudState.elements.has(id)) fail('unknown HUD element');
    matchShape(element, baseline.hudState.elements.get(id), `HUD ${id}`);
  }
  const hudClips = new Set((project.hud?.animations || []).map(clip => clip.id));
  objectMap(state.hudState.playing, hudClips, { time: 'number' }, 'HUD animations');
  stringSet(state.hudState.finished, hudClips, 'finished HUD animations');
  stringSet(state.hudState.clicked, new Set(baseline.hudState.elements.keys()), 'clicked HUD elements');
  if (state.projectiles.length > 256 || state.impacts.length > 256) fail('too many projectile effects');
  const projectileIds = new Set();
  for (const projectile of state.projectiles) {
    if (!plain(projectile) || !Number.isInteger(projectile.id) || projectile.id <= 0 || projectileIds.has(projectile.id) ||
      !['x', 'y', 'z', 'dx', 'dy', 'dz', 'age', 'speed', 'damage', 'diceSides', 'radius'].every(key => Number.isFinite(projectile[key])) ||
      !['$player', ...entityIds].includes(projectile.ownerId)) fail('invalid projectile');
    projectileIds.add(projectile.id);
  }
  for (const impact of state.impacts) {
    if (!plain(impact) || typeof impact.id !== 'string' || typeof impact.clipId !== 'string' ||
      !['x', 'y', 'z', 'start'].every(key => Number.isFinite(impact[key]))) fail('invalid impact');
  }
  if (state.menuHistory !== undefined && (!Array.isArray(state.menuHistory) || state.menuHistory.length)) fail('invalid menu history');
  if (state.lastShot !== undefined && state.lastShot !== null &&
    (!plain(state.lastShot) || !Number.isFinite(state.lastShot.time) || !Array.isArray(state.lastShot.hits))) fail('invalid last shot');
  if (state.playerNoise !== undefined &&
    (!plain(state.playerNoise) || !['x', 'y', 'time'].every(key => Number.isFinite(state.playerNoise[key])))) fail('invalid player noise');
  if (state.soundFlood !== undefined && (!plain(state.soundFlood) || !(state.soundFlood.reached instanceof Map))) fail('invalid sound propagation');
}

/** Capture only portable runtime data; assets, project documents and GPU/physics handles are excluded. */
export function captureGameSave(project, state, identity) {
  if (typeof identity !== 'string' || !identity.length) fail('missing game identity');
  if (!state.hasGame || !(state.playerStats?.health > 0) || state.intermission) fail('only a living game outside intermission can be saved');
  const portable = Object.fromEntries(Object.entries(state).filter(([key]) => !omitted.has(key)));
  portable.gameScreen = 'playing';
  portable.hudState = { ...state.hudState, cursor: false };
  portable.menuRequests = [];
  portable.bindingKey = null;
  if (Object.hasOwn(portable, 'menuHistory')) portable.menuHistory = [];
  const snapshot = encode(portable);
  const physicsData = state.physics ? state.physics.saveState() : null;
  if (physicsData) validatePhysicsState(physicsData);
  const record = { version: GAME_SAVE_VERSION, identity, levelId: project.game?.active ?? null,
    createdAt: new Date().toISOString(), snapshot, physicsData };
  record.checksum = checksum(record);
  return record;
}

/**
 * Restores runtime BEFORE preview creation. After preview creates physics, call
 * runtime.physics.restoreState(physicsData) to undo initial body synchronization.
 * The supplied project selects the saved campaign level only after validation succeeds.
 */
export function restoreGameSave(project, record, identity) {
  if (!plain(record) || record.version !== GAME_SAVE_VERSION || typeof identity !== 'string' ||
    !identity.length || record.identity !== identity) fail('save belongs to a different game or version');
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.checksum !== 'string' || !Object.hasOwn(record, 'physicsData')) fail('invalid record metadata');
  const { checksum: savedChecksum, ...content } = record;
  if (checksum(content) !== savedChecksum) fail('snapshot checksum mismatch');
  let selected = project;
  if (project.game) {
    const level = project.game.levels.find(level => level.id === record.levelId);
    if (!level) fail('unknown campaign level');
    if (record.levelId !== project.game.active) selected = { ...project, ...level.data };
  } else if (record.levelId !== null) fail('unexpected campaign level');
  const restored = decode(record.snapshot);
  if (plain(restored)) for (const key of legacyDiscarded) delete restored[key];
  if (!plain(restored) || !plain(restored.settings)) fail('missing game settings');
  const settings = gameSettings(restored.settings);
  const runtime = createRuntime(selected, { settings });
  validateRuntime(selected, restored, runtime);
  if (record.physicsData !== null) {
    const bodyIds = new Set(restored.entities.filter(entity => entity.type === 'player' ||
      entity.physics && entity.physics.body !== 'none').map(entity => entity.id));
    validatePhysicsState(record.physicsData, bodyIds);
  }
  Object.assign(runtime, restored);
  if (project.game && record.levelId !== project.game.active) selectGameLevel(project, record.levelId);
  return { runtime, physicsData: record.physicsData === null ? null : structuredClone(record.physicsData) };
}
