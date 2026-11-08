import { createRuntime } from './runtime.js';
import { initialiseActorEntities } from './actor-runtime.js';
import { buildCamera, isCamera } from './camera-runtime.js';
import { HL2_MOVEMENT } from './source-motion.js';
import { selectGameLevel, levelData } from './game-levels.js';
import { validatePhysicsState, physicsEntityIds } from './physics.js';
import { gameSettings } from './game-settings.js';
import { KEYS, WEAPONS } from './player-state.js';
import { WORLD_UP } from './gravity.js';

export const GAME_SAVE_VERSION = 1;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
// Presentation and menu-only fields are recreated by the host and are never persisted.
// Diagnostics and derived handles stay out of saves: the unsupported-action set is
// rebuilt as problems occur, and the weapon machine is re-entered on load.
const omitted = new Set(['physics', 'scripts', 'saveSlots', 'saveStatus', 'pendingSaveSlot', 'rendererStatus',
  // A frame-long trigger request: what a rule asked for this frame, not game state.
  'weaponTriggerRequest', 'weaponAltRequest',
  // The host's save-file store (read/write/list) is a capability, not state: a function cannot be
  // encoded, so it is dropped here and the preview that restores the game attaches it again.
  'saveFileHost',
  // The controller readout is written onto the live state by the host each frame; it is a session
  // fact, not game state, so it must not leak into a save (a field the loader does not know).
  'controllerStatus',
  'worldTerminalActive', 'worldTerminalId',
  'actorUnsupported', 'weaponActor', 'weaponFlash', 'weaponFlashAsset', 'weaponAsset', 'missileGaps', 'surfaces',
  // Diagnostics describe the session, not the game; they are rebuilt on load. Leaving
  // them in the payload made restoring any save written after a decal or a grounded
  // actor fail with "unknown runtime field".
  'groundCorrections', 'entityLookup',
  // Transient work the engine rebuilds rather than state the game is in. Every one of these is
  // created lazily — when a path is followed, a sky flashes, a teleport leaves fog, a camera line
  // is looked through, a surface waggles — so a save taken after any of them carried a field the
  // loader did not know and refused the whole file ("unknown runtime field pathCompleted"). A saved
  // game that cannot be loaded is the worst failure this format has, so the list is explicit here
  // and a test plays a state with all of them set.
  'pathCompleted', 'pathSampler', 'viewCameraHeight', 'teleportFog', 'lightning',
  // A camera glide is a frame-by-frame animation, and the sequence number only names the next
  // camera a rule creates; saving either would record a moment rather than the game.
  'cameraMoves', 'cameraSequence', 'rumbles',
  // The instances a rule picked are a scope that exists only while that rule runs, so a save taken
  // from inside a rule (a checkpoint action) must not record the rule's own bookkeeping.
  'picks',
  // Sight answers are kept for the length of one frame, because one frame asks each monster
  // several times; saving them would record a moment rather than the game.
  'sightMemo',
  // The speed the player is travelling at is read off the momentum every tic, so it is derived
  // rather than part of the game state.
  'speed']);
const legacyDiscarded = new Set(['rendererStatus']);
// Imported actors run their own tic clocks and weapon machine, so these fields only
// exist once a game with an actor table has been played.
const optional = new Set(['areaEntries', 'intervals', 'decalCounter', 'lastShot', 'playerNoise', 'soundFlood', 'menuHistory', 'bunnyhop', 'spawnSequence',
  // A boss death is a latch the game keeps, and an ACS HudMessage is a caption with a hold time, so
  // both are carried rather than dropped — unlike the transients above.
  'bossDefeated', 'acsMessages',
  'scriptState', 'scriptWarning', 'damageAcc', 'musicRequest', 'skyRequest', 'gravity', 'airControl', 'scriptLog',
  'messageCount', 'buttons', 'prevButtons', 'actorClock', 'thrustClock', 'weaponClock', 'weaponSlot', 'weaponReady', 'playerMorph', 'cameraTextures',
  // A script's screen fade and the things' fall clock outlive a single frame.
  'screenFade', 'screenFadeFrom', 'screenFadeNow', 'fadeClock',
  // Teleport lines are derived from the map, but they are cached on the state on first use.
  'teleportLines',
  // Falling things keep their own tic clock, like the actor and projectile machines.
  'weaponTriggerHeld', 'weaponAltHeld', 'weaponRefireLabel', 'weaponEventActors',
  'weaponLight', 'weaponRaised', 'weaponAttack', 'projectileClock', 'gravityClock',
  // Where an addon keeps state of its own. Rules and scripts write the engine's fields through the API;
  // this one bag is theirs, so their data travels with a save without a field per addon.
  'addonState', 'waggles',
  // Save files are names the host knows about; the documents themselves live with the host, so a
  // record only carries the index a rule's `saveFileExists` condition reads, and the last error.
  'saveFiles', 'saveFileError']);
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
    const activeData = levelData(project);
    const shared = Object.fromEntries(Object.entries(project).filter(([key]) => !Object.hasOwn(activeData, key)));
    content = { ...shared,
      game: { ...project.game, active: project.game.entry, levels: project.game.levels.map(level =>
        level.id === project.game.active ? { ...level, data: activeData } : level) } };
  }
  const text = canonical(content);
  // `crypto.subtle` only exists in a secure context. The studio is happy to be opened over the
  // network (a phone on the same wifi, another machine on `http://192.168.…`), and there the
  // engine used to fail every preview with "Cannot read properties of undefined (reading
  // 'digest')". The identity is an accidental-mismatch check, not a signature, so a plain digest
  // is enough; it is prefixed differently so the two kinds can never be mistaken for each other.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `opendle-save-v1-fnv:${checksum(text)}`;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
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
  // Saves made before the player accumulated momentum at rest survive as at rest.
  if (!plain(state.momentum)) state.momentum = { x: 0, y: 0, z: 0 };
  if (!Number.isFinite(state.playerClock)) state.playerClock = 0;
  if (!Number.isFinite(state.turnHeld)) state.turnHeld = 0;
  if (!Number.isFinite(state.turnRequest)) state.turnRequest = 0;
  if (!Number.isFinite(state.bob)) state.bob = 0;
  // Saves written before a project could run Half-Life movement are Doom-movement saves.
  if (!['doom', 'source'].includes(state.motionModel)) state.motionModel = 'doom';
  if (!plain(state.motionSettings)) state.motionSettings = { ...HL2_MOVEMENT };
  if (!plain(state.motion)) state.motion = { x: 0, y: 0, z: 0 };
  if (typeof state.sourceGrounded !== 'boolean') state.sourceGrounded = false;
  if (!Number.isFinite(state.bobTimer)) state.bobTimer = 0;
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
  // A template is what the object was made from: the runtime's own copy when the level placed it,
  // and otherwise the project's — a cue may spawn a thing this skill did not place, and the save
  // still has to load. The project copy is initialised the way the runtime would, because that is
  // the shape the saved entity has.
  const templateFor = id => {
    const raw = (project.map.entities || []).find(item => item.id === id);
    return raw ? initialiseActorEntities(project, [structuredClone(raw)])[0] : null;
  };
  // The engine makes cameras itself (Camera: create a camera), so its own loader knows the shape
  // of one that no project placed: a save written while a cutscene camera is alive has to load.
  const cameraTemplate = entity => (isCamera(entity) ? buildCamera({ id: entity.id }) : null);
  for (const entity of state.entities) {
    if (!plain(entity) || seen.has(entity.id)) fail('unknown or duplicate entity');
    const template = entities.get(entity.id) ||
      (typeof entity.spawnedFrom === 'string' && (entities.get(entity.spawnedFrom) || templateFor(entity.spawnedFrom))) ||
      cameraTemplate(entity);
    if (!template) fail(`unknown entity ${entity.id}`);
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
  if (state.intervals !== undefined) {
    if (!(state.intervals instanceof Map)) fail('invalid periodic clocks');
    for (const [key, due] of state.intervals) if (typeof key !== 'string' || !Number.isFinite(due) || due < 0) fail('invalid periodic clock');
  }
  for (const [id, enabled] of state.groups) if (!baseline.groups.has(id) || typeof enabled !== 'boolean') fail('invalid event group');
  // The save-file index a rule's condition reads: names only, so a damaged save cannot smuggle a
  // document (or a size) in through it.
  if (state.saveFiles !== undefined) {
    if (!(state.saveFiles instanceof Set)) fail('invalid save file list');
    for (const name of state.saveFiles) if (typeof name !== 'string' || !name.length || name.length > 80) fail('invalid save file name');
  }
  if (state.saveFileError !== undefined && typeof state.saveFileError !== 'string') fail('invalid save file error');
  // The objects this level has, plus the ones it made while playing: a spawned enemy is a real
  // object with its own animation, its own per-object rules and its own fired marks, and a save
  // written while it is alive has to load.
  const entityIds = new Set([...project.map.entities.map(entity => entity.id),
    ...(Array.isArray(state.entities) ? state.entities.map(entity => entity?.id).filter(id => typeof id === 'string') : [])]);
  const events = new Set((project.events || []).flatMap(event => event.forEachType
    ? project.map.entities.filter(entity => entity.type === event.forEachType).map(entity => `${event.id}:${entity.id}`)
    : [event.id]));
  for (const id of state.fired) {
    if (typeof id !== 'string') fail('invalid fired event');
    if (events.has(id)) continue;
    // A per-object rule that fired for an object the level made: the same rule, another owner.
    const cut = id.lastIndexOf(':');
    if (cut > 0 && entityIds.has(id.slice(cut + 1)) &&
      (project.events || []).some(event => event.id === id.slice(0, cut) &&
        (event.forEachType || state.entities.some(entity => entity.id === id.slice(cut + 1) &&
          entity.spawnedFrom === event.ownerId)))) continue;
    fail('invalid fired event');
  }
  for (const [key, allowed] of [['keys', KEYS], ['weapons', WEAPONS]])
    for (const id of state.inventory[key]) if (!allowed.includes(id)) fail('invalid inventory');
  if (!WEAPONS.includes(state.inventory.selectedWeapon) || !state.inventory.weapons.has(state.inventory.selectedWeapon))
    fail('invalid selected weapon');
  if (state.groups.size !== baseline.groups.size) fail('missing event groups');
  const stringSet = (set, allowed, label) => {
    for (const id of set) if (typeof id !== 'string' || allowed && !allowed.has(id)) fail(`invalid ${label}`);
  };
  if (state.areaEntries !== undefined) {
    if (!(state.areaEntries instanceof Set)) fail('invalid area entries');
    stringSet(state.areaEntries, null, 'area entries');
  }
  const wallIds = new Set(project.map.walls.map(wall => wall.id));
  stringSet(state.animationFinished, entityIds, 'finished animations');
  stringSet(state.worldTriggers.cross, wallIds, 'crossed walls');
  stringSet(state.worldTriggers.shoot, wallIds, 'shot walls');
  if (state.worldTriggers.use !== null && !wallIds.has(state.worldTriggers.use)) fail('invalid used wall');
  if (state.worldTriggers.useSpecial !== undefined && state.worldTriggers.useSpecial !== null &&
    !wallIds.has(state.worldTriggers.useSpecial)) fail('invalid used special wall');
  const numberMap = (map, label) => {
    for (const [key, value] of map) if (typeof key !== 'string' || typeof value !== 'number' || Number.isNaN(value)) fail(`invalid ${label}`);
  };
  // Saves written before damage sampling skipped things without health hold `undefined` samples.
  // A sample is only the last health seen, so dropping the unusable ones restores the game and
  // the condition simply waits for the next change.
  if (state.entitySamples instanceof Map)
    for (const [key, value] of state.entitySamples)
      if (typeof value !== 'number' || Number.isNaN(value)) state.entitySamples.delete(key);
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
  if (state.waggles !== undefined) {
    if (!Array.isArray(state.waggles)) fail('invalid plane waggles');
    for (const waggle of state.waggles) {
      if (!plain(waggle) || !Array.isArray(waggle.sectorIds) ||
        !waggle.sectorIds.every(id => sectorIds.has(id)) ||
        !(waggle.original instanceof Map) || waggle.original.size !== waggle.sectorIds.length ||
        !waggle.sectorIds.every(id => Number.isFinite(waggle.original.get(id))) ||
        !['floorHeight', 'ceilingHeight'].includes(waggle.property) ||
        typeof waggle.ceiling !== 'boolean' || waggle.ceiling !== (waggle.property === 'ceilingHeight') ||
        !['accumulator', 'accDelta', 'scale', 'targetScale', 'scaleDelta', 'timer', 'tics', 'pending']
          .every(key => Number.isFinite(waggle[key]))) fail('invalid plane waggle');
    }
  }
  for (const [key, motion] of state.sectorMotions) {
    if (!plain(motion) || !sectorIds.has(motion.sectorId) || !['floorHeight', 'ceilingHeight', 'light'].includes(motion.surface) ||
      key !== `${motion.sectorId}:${motion.surface}` || !['out', 'return'].includes(motion.direction) ||
      !['origin', 'waiting', 'height', 'speed'].every(field => Number.isFinite(motion[field])) ||
      motion.moveCeiling !== undefined && (typeof motion.moveCeiling !== 'boolean' || motion.surface !== 'floorHeight')) fail('invalid sector motion');
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
  // Decal ids must keep counting up after a load, or a new spray collides with one
  // already in the impact list.
  if (state.decalCounter !== undefined && (!Number.isInteger(state.decalCounter) || state.decalCounter < 0)) fail('invalid decal counter');
  if (state.lastShot !== undefined && state.lastShot !== null &&
    (!plain(state.lastShot) || !Number.isFinite(state.lastShot.time) || !Array.isArray(state.lastShot.hits))) fail('invalid last shot');
  if (state.playerNoise !== undefined &&
    (!plain(state.playerNoise) || !['x', 'y', 'time'].every(key => Number.isFinite(state.playerNoise[key])))) fail('invalid player noise');
  if (state.soundFlood !== undefined && (!plain(state.soundFlood) || !(state.soundFlood.reached instanceof Map))) fail('invalid sound propagation');
  if (state.addonState !== undefined) {
    const bag = state.addonState;
    if (!plain(bag) || Object.keys(bag).length > 256) fail('invalid addon state');
    // It ends up in a save file, so it is plain JSON and nothing else.
    for (const value of Object.values(bag)) {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail('invalid addon state');
      try { JSON.stringify(value); } catch { fail('invalid addon state'); }
    }
  }
  if (state.scriptState !== undefined && state.scriptState !== null) {
    try { baseline.scripts.restore(state.scriptState); }
    catch (error) { fail(error.message); }
  }
}

/** Capture only portable runtime data; assets, project documents and GPU/physics handles are excluded. */
export function captureGameSave(project, state, identity) {
  if (typeof identity !== 'string' || !identity.length) fail('missing game identity');
  if (!state.hasGame || !(state.playerStats?.health > 0) || state.intermission) fail('only a living game outside intermission can be saved');
  const portable = Object.fromEntries(Object.entries(state).filter(([key]) => !omitted.has(key)));
  const scriptState = state.scriptState;
  if (scriptState !== null && scriptState !== undefined) portable.scriptState = scriptState;
  portable.gameScreen = 'playing';
  portable.hudState = { ...state.hudState, cursor: false };
  portable.menuRequests = [];
  portable.bindingKey = null;
  if (Object.hasOwn(portable, 'menuHistory')) portable.menuHistory = [];
  const snapshot = encode(portable);
  // Whatever is written has to be readable: a save whose own loader refuses it is worse than no save at
  // all, because the player is told it worked. An addon that adds a field of its own to the state would
  // otherwise produce exactly that, so the same check the loader runs is run before the file is kept.
  const readable = decode(snapshot);
  try { validateRuntime(project, readable, createRuntime(project, { settings: gameSettings(readable.settings) })); }
  catch (error) { fail(`${error.message.replace(/^Invalid game save: /, '')} (an addon changed the runtime state)`); }
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
  if (record.physicsData !== null) validatePhysicsState(record.physicsData, physicsEntityIds(selected, restored.entities));
  Object.assign(runtime, restored);
  if (project.game && record.levelId !== project.game.active) selectGameLevel(project, record.levelId);
  return { runtime, physicsData: record.physicsData === null ? null : structuredClone(record.physicsData) };
}
