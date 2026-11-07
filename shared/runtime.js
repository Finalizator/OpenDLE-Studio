import { CAMERA_DEFAULTS, eventConditions, resolveEntityId } from './project.js';
import { compareInstanceProperty, readInstanceProperty } from './instance-properties.js';
import { floorHeightAt } from './three-d-floors.js';
import { entitySector, sectorAt, sectorGeometry } from './sectors.js';
import { pairKey } from './physics.js';
import { compareValues, engineCommand } from './engine-script.js';
import { acsVariableStore } from './acs-state.js';
import { isExpression, evaluateExpression, expressionContext, scalar } from './expressions.js';
import { createHUDState, advanceHUD, playHUDAnimation, clearFinishedHUD, validateHUDProperty } from './hud.js';
import { postFxParamDefault } from './post-fx.js';
import { TIC_RATE, stepActors, stepThingGravity, stepProjectiles, runProjectileDeath, beginWeapon, weaponTic, playWeaponState,
  initialiseActorEntities, installActorProjectileSprites, missileProjectile, saySound, hurtActor,
  setActorState, explodeAt, homeMissile, bfgSpray, projectileActor, labelIndex } from './actor-runtime.js';
import { SLOW_TURN_RATIO, SLOW_TURN_TICS, TURN_SPEED, ZERO_MOMENTUM, advanceMomentum, bamPerDegreePerSecond, bobFor,
  momentumSpeed, resetMomentum, thrustFor, thrustTowards, turnStep } from './player-motion.js';
import { HL2_MOVEMENT, clampHorizontal, horizontalStep, measuredVelocity } from './source-motion.js';

/** The mark a bullet leaves, in map units, and how many are kept before the oldest goes. */
const BULLET_MARK = { assetId: 'builtin:bullethole', width: 12, limit: 160 };

/** The most player tics a single frame may run, so a stall cannot teleport the player. */
const MAX_PLAYER_TICS = 4;

/** The shortest move, in map units, that can count as being stopped by a wall. */
const BLOCKED_STEP = 1;

/**
 * Substeps a player has to be stopped for before it counts as a wall.
 *
 * Climbing a step blocks one or two substeps before the capsule is lifted over it; treating
 * the first of those as a wall dropped the player's momentum against every step on MAP01's
 * staircase, and it never reached walking speed.
 */
const WALL_SUBSTEPS = 3;
import { initialPlayerStats, initialInventory, addAmmo, recordDamage, playerFeedback, ammoMaximum } from './player-state.js';
import { areaContains, areaEntered, areaVolume } from './areas.js';
import {
  PLAYER_CYLINDER, SURFACE_REACH, WORLD_UP, alignUp, dot as dotMap, eyePosition, playerBasis, playerCentre, viewDirection,
} from './gravity.js';
import { damagePlayer, canSeePlayer, canHearPlayer, moveEnemy, launchProjectile, advanceProjectiles, soundEvent, randomDamage, geometryDistance, entityDistance, playerReachesEntity, enemyHitscan, enemyAttackChance } from './combat.js';
import { useWall, crossedWalls, moveSector, advanceSectors } from './world-motion.js';
import { advancePlaneMotion } from './plane-motion.js';
import { advancePathMotion } from './path-motion.js';
import {
  TIMESHEET_CUE_CONDITION, advanceTimesheets, advancePathTweens, startTimesheetRun, stopTimesheetRun,
  setTimesheetPaused, cueDue, startPathTween, timesheetCueEvents, timesheetSignature,
} from './timesheet.js';
import { decalTarget, sprayTarget, clipDecalToFace } from './spray.js';
import { createMapScripts, expireHudMessages } from './map-scripts.js';
import { tickMorphs } from './morph.js';
import { projectIds } from './project-ids.js';
import { executeSpecial } from './line-specials.js';
import { weaponEventActors } from './weapon-script.js';
import { enemyEventActors } from './enemy-script.js';
import { projectileEventActors } from './projectile-script.js';
import { propEventActors } from './enemy-script.js';
import { saveFileDocument, serializeSaveFile, parseSaveFile, applyVariableSave, saveFileName, variableSnapshot } from './save-files.js';
import { BT } from './acs.js';
import { initialiseAuthoredDoors, operateSectorDoor, sectorDoorClosed, sectorDoorMoving, sectorDoorOpen,
  updateProximityDoors, useManualDoor } from './doors.js';
import { initialiseElevators, operateSectorElevator, sectorElevatorAt, sectorElevatorMoving,
  updateProximityElevators, useManualElevator } from './elevators.js';
import { clipFrame, setSpriteState } from './sprite-animation.js';
import { gameSettings, changeSetting, setGameScreen } from './game-settings.js';
import { createLevelStatistics, updateLevelStatistics, recordRemovedEntity, beginIntermission, continueIntermission } from './intermission.js';
import { emitSignal, signalBatch, hasSignalCondition, SIGNAL_LIMIT } from './signals.js';
import {
  PLAYER_VIEW, ACTIVE_VIEW, activeCamera, advanceCameras, buildCamera, requireCamera, startCameraMove, switchView, viewFov,
} from './camera-runtime.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const PICK_CONDITIONS = new Set(['pickAll', 'pickByProperty', 'pickByVariable', 'pickNearest', 'pickRandom']);
const PICK_ACTIONS = new Set(['setPickedVariable', 'addPickedVariable', 'setPickedPosition', 'movePicked',
  'setPickedAngle', 'scalePicked', 'setPickedSpriteState', 'removePicked']);

function setVisualScale(entity, scale) {
  entity.spriteScale = scale;
  if (entity.spriteScaleX !== undefined) entity.spriteScaleX = scale;
  if (entity.spriteScaleY !== undefined) entity.spriteScaleY = scale;
  if (entity.modelAsset) entity.modelScale = scale;
}

/**
 * The instances an event is currently about.
 *
 * An untouched type means every instance of it, which is why a rule that never picks behaves as
 * it always did. A narrowed type answers only what was picked — and a pick that selected nothing
 * answers nothing, rather than falling back to everything, or a rule that picked zero enemies
 * would act on all of them.
 */
export function pickedInstances(state, picks, type) {
  // A missile is not a map entity: it lives in its own list, so "for each projectile" is
  // the only way a rule can speak about one. Everything else iterates entities.
  if (type === 'projectile') {
    const chosen = picks?.get(type);
    const flying = state.projectiles || [];
    return chosen ? flying.filter(projectile => chosen.has(projectile.id)) : flying;
  }
  const chosen = picks?.get(type);
  if (chosen) return (state.entities || []).filter(entity => entity.type === type && chosen.has(entity.id));
  return entityLookup(state).byType.get(type) || [];
}

/** The pick a per-instance rule sees: the parent's, narrowed to the one instance it is about. */
function ownPick(picks, type, id) {
  // Narrowing a set to a single member is that member, so the filter this used to run is
  // only work: this is on the path of every action of every object rule of every frame.
  const own = picks.size ? new Map(picks) : new Map();
  own.set(type, ONE_MEMBER.get(id) || newSingleMember(id));
  return own;
}
// Every action of every object rule narrows to one instance, so the one-member sets are
// shared rather than rebuilt; they are never mutated, only replaced by a fresh map.
const ONE_MEMBER = new Map();
function newSingleMember(id) {
  const set = new Set([id]);
  if (ONE_MEMBER.size > 4096) ONE_MEMBER.clear();
  ONE_MEMBER.set(id, set);
  return set;
}

/** Applies a picked set back into the pick map, keeping the map immutable between events. */
function withPick(picks, type, ids) {
  picks.set(type, ids);
  return picks;
}

export function distanceToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

export function wallSegments(project) {
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  return project.map.walls.map(wall => ({ ...wall, start: vertices.get(wall.a), end: vertices.get(wall.b) }));
}

export function castRay(x, y, dx, dy, walls) {
  let nearest = null;
  for (const wall of walls) {
    if (!wall.solid) continue;
    const sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
    const cross = dx * sy - dy * sx;
    if (Math.abs(cross) < 1e-9) continue;
    const qx = wall.start.x - x, qy = wall.start.y - y;
    const distance = (qx * sy - qy * sx) / cross;
    const u = (qx * dy - qy * dx) / cross;
    if (distance > 0.001 && u >= 0 && u <= 1 && (!nearest || distance < nearest.distance)) {
      nearest = { distance, wall };
    }
  }
  return nearest;
}

export function skillBitFor(settings = {}) {
  const difficulty = gameSettings(settings).difficulty;
  return difficulty <= 2 ? 1 : difficulty === 3 ? 2 : 4;
}

/** Live object state for a project: skill-filtered copies with per-instance variables. */
export function runtimeEntities(project, settings = {}) {
  const skillBit = skillBitFor(settings);
  return structuredClone(project.map.entities).filter(entity => entity.type === 'player' || !entity.skillMask || (entity.skillMask & skillBit))
    .map(entity => ({ ...entity, variables: { ...(entity.variables || {}) } }));
}

export { acsVariableStore } from './acs-state.js';

/** Whether a Shader Engine pass is on: the project's toggle, then a script's override. */
export function postFxPassEnabled(state, kind) {
  const runtime = state.postFx, stack = state.projectPostFx;
  if (runtime?.stackEnabled === false || !stack || stack.enabled === false) return false;
  if (!(stack.passes || []).some(pass => pass.kind === kind && pass.enabled !== false)) return false;
  return runtime?.disabled?.get?.(kind) !== true;
}

/** A pass parameter's current value: what a script set, otherwise the project's saved value. */
export function postFxParamValue(state, kind, name) {
  const runtime = state.postFx?.values?.get?.(`${kind}.${name}`);
  if (Number.isFinite(runtime)) return runtime;
  const pass = (state.projectPostFx?.passes || []).find(candidate => candidate.kind === kind);
  const stored = pass?.params?.[name];
  return Number.isFinite(stored) ? stored : postFxParamDefault(kind, name);
}

export function createRuntime(project, { settings = {}, screen = 'playing', gameMode = false, progress, addons = null,
  saveFiles = null } = {}) {
  // Missile artwork has to exist before the renderer builds its sprite index.
  installActorProjectileSprites(project);
  const spawn = project.map.entities.find(entity => entity.type === 'player');
  const userSettings = gameSettings(settings);
  const skillBit = skillBitFor(settings);
  const inventory = progress ? structuredClone(progress.inventory) : initialInventory();
  if (progress) inventory.keys.clear();
  const playerStats = progress ? structuredClone(progress.playerStats) : initialPlayerStats();
  const entities = initialiseActorEntities(project, runtimeEntities(project, settings));
  const sectors = sectorGeometry(project);
  initialiseAuthoredDoors(project, sectors);
  initialiseElevators(project, sectors);
  const state = {
    settings: userSettings, settingsRevision: 0, gameScreen: screen, gameMode,
    hasGame: screen === 'playing', bindingKey: null,
    // The one field an addon owns. Everything else on the state belongs to the engine, and a save whose
    // state holds a field the loader does not know is a save that cannot be read back.
    addonState: {},
    menuRequests: [], interfaceStarted: false,
    saveSlots: Array(6).fill(''), saveStatus: '', pendingSaveSlot: null,
    // Save files: the names the host knows about, and why the last write or read failed. The text
    // itself lives with the host (the browser, the exported game's storage), not in the state, so a
    // full-state save does not carry every other save file inside it.
    saveFiles: new Set(), saveFileError: '',
    // The host's save-file store: `read`, `write`, `list` and the game identity the files belong to.
    // A function cannot travel in a save, so the loader re-attaches it (see save-game.js `omitted`).
    saveFileHost: saveFiles,
    // Imported weapons whose firing is an event rule. Those run their states for pictures and
    // sounds only, so a translated weapon is never fired by the machine as well as the rule.
    weaponEventActors: weaponEventActors(project),
    // Imported monsters whose decisions are event rules: their states keep the frames,
    // sounds and attack functions, and no longer look, chase or pick their own fights.
    enemyEventActors: enemyEventActors(project),
    // Shootable props whose blast and solidity are rules: their states stop doing it.
    propEventActors: propEventActors(project),
    // Imported missiles whose flight and death are rules: their states keep the trail and
    // the frames, and stop calling the functions a rule now takes.
    projectileEventActors: projectileEventActors(project),
    newGameLevel: project.game && project.gameMenus?.episodes?.length === 1 ? project.gameMenus.episodes[0].levelId : null,
    player: { x: spawn.x, y: spawn.y, angle: spawn.angle * Math.PI / 180, pitch: 0, up: [...WORLD_UP] },
    // Momentum is Doom's, in map units per tic; see shared/player-motion.js.
    momentum: { x: 0, y: 0, z: 0 }, playerClock: 0, turnHeld: 0, turnRequest: 0,
    // Half-Life movement is opt-in; a project that installs it runs this model instead.
    motionModel: 'doom', motionSettings: { ...HL2_MOVEMENT }, motion: { x: 0, y: 0, z: 0 },
    sourceGrounded: false,
    // Doom bobs the weapon and the view with the player's speed; see shared/player-motion.js.
    bob: 0, bobTimer: 0,
    playerStats, inventory, levelTransition: Boolean(progress),
    face: 'idle',
    feedback: { damage: null, weaponPickupTime: -Infinity, attackTime: 0, health: playerStats.health },
    scriptedInput: project.playerControl === 'events',
    input: { mouseX: 0, mouseY: 0, forward: 0, strafe: 0, jump: false },
    time: 0,
    timers: new Map(),
    groups: new Map((project.eventGroups || []).map(group => [group.id, group.enabled])),
    hud: Boolean(project.hud),
    // The baseline a stat-change rule compares against is where this level started, including a
    // campaign carry-over: entering with 50 health is not 50 damage.
    hudState: createHUDState(project, playerStats),
    randomSeed: 1,
    sounds: [],
    // Rumbles a rule asked for this frame, drained by whatever is holding the controllers.
    rumbles: [],
    soundOverflow: 0,
    projectiles: [],
    projectileSequence: 0,
    worldRevision: 0,
    shaderEnabled: true,
    // The Shader Engine's runtime state: which passes a script switched off, and the values
    // it set. The project's own stack stays the source of the enabled passes and defaults.
    postFx: { stackEnabled: true, disabled: new Map(), values: new Map() },
    // The stack as the project saved it; a script enables passes and sets values on top.
    projectPostFx: project.postFx ? structuredClone(project.postFx) : null,
    shaderUniforms: new Map(Object.entries(project.shaders?.find(shader => shader.id === project.environment.shaderId)?.uniforms || {})),
    sectorMotions: new Map(),
    // How far each path follower has travelled: progress belongs to the run, not to the map.
    pathMotions: new Map(),
    // Running timelines, and the moves a cue asked an object to make along a route.
    timesheets: new Map(),
    pathTweens: [],
    spriteAnimations: new Map(),
    weaponAnimations: new Map(),
    entitySamples: new Map(),
    enemyMoves: new Map(),
    impacts: [],
    decalCounter: 0,
    worldTriggers: { use: null, useSpecial: null, cross: new Set(), shoot: new Set() },
    // A ChangeCamera special points the view at a camera actor; null is the player's eyes. A
    // camera object marked "active at start" is where the level opens, which is how a cutscene
    // filmed by a camera begins without a rule.
    viewCamera: entities.find(entity => entity.type === 'camera' && entity.cameraActive)?.id ?? null,
    // Glides a rule started for a camera: which camera, from where, to where, and how far along
    // it is. Transient - a save keeps the camera where the glide had got to, not the glide.
    cameraMoves: new Map(),
    // A level named TITLEMAP is GZDoom's title backdrop: its scripts and geometry keep
    // running behind the menu (that is what animates the camera and the fades), while the
    // player does not act.
    ambientWorld: screen !== 'playing' && /^TITLEMAP$/i.test(String(project.game?.active || '')),
    variables: { ...project.variables },
    entities,
    levelStatistics: createLevelStatistics(entities, project.map.sectors || []),
    intermission: null,
    bunnyhop: { multiplier: 1, chain: 0, lastJump: -Infinity, lastLanding: -Infinity },
    fired: new Set(),
    started: false,
    message: '',
    messageTime: 0,
    walls: wallSegments(project),
    sectors,
    animations: new Map(entities.filter(entity => entity.animation?.autoPlay).map(entity => [entity.id, { ...entity.animation, playing: true, revision: 0 }])),
    animationFinished: new Set(),
    physics: null,
    scripts: null,
  };
  if (addons) setAddonHooks(state, addons);
  state.scripts = createMapScripts(project, state, {
    finishLevel: exit => beginIntermission(project, state, exit === 'secret'),
    changeLevel: () => {},
    onRemove: entity => {
      recordRemovedEntity(state, entity);
      state.physics?.remove(entity.id);
      forgetEntity(state, entity.id);
      state.entities = state.entities.filter(item => item.id !== entity.id);
    },
    initialiseEntities: entities => initialiseActorEntities(project, entities),
  });
  state.scripts?.restore(progress?.scriptState);
  // ACS VM state is captured on demand: snapshotting it after
  // every step allocated a copy of every map/global variable, the string pool and each
  // running script's locals per frame. The accessor keeps `state.scriptState` working
  // for callers and for old saves, which may still carry a snapshot.
  Object.defineProperty(state, 'scriptState', {
    configurable: true, enumerable: false,
    get: () => state.scripts?.capture() ?? null,
    set: saved => state.scripts?.restore(saved),
  });
  // The slowest step so far and its stage breakdown, for the frame report.
  Object.defineProperty(state, 'slowStep', {
    configurable: true, enumerable: false,
    get: () => cacheFor(state).slowStep ? { ...cacheFor(state).slowStep } : null,
  });
  Object.defineProperty(state, 'stepTotals', {
    configurable: true, enumerable: false,
    get: () => {
      const totals = cacheFor(state).stepTotals;
      if (!totals) return null;
      const rounded = {};
      for (const [name, entry] of Object.entries(totals)) {
        rounded[name] = { mean: Math.round(entry.total / Math.max(1, entry.steps) * 1000) / 1000, max: Math.round(entry.max) };
      }
      return rounded;
    },
  });
  return state;
}

export function lookPlayer(state, movementX, movementY) {
  if (!Number.isFinite(movementX) || !Number.isFinite(movementY)) throw new Error('Mouse movement must be finite');
  if (state.hudState.cursor) return;
  movementX *= state.settings.sensitivity;
  movementY *= state.settings.sensitivity * (state.settings.invertY ? -1 : 1);
  if (state.scriptedInput) {
    state.input.mouseX += movementX; state.input.mouseY += movementY; return;
  }
  state.player.angle += movementX * .002;
  const limit = 85 * Math.PI / 180;
  state.player.pitch = Math.max(-limit, Math.min(limit, state.player.pitch - movementY * .002));
}

/**
 * Scratch caches for one runtime state.
 *
 * They live in a WeakMap instead of on the state object so they can never reach a
 * save file (which validates every field), and they are dropped with the state.
 */
const stateCaches = new WeakMap();
function cacheFor(state) {
  let cache = stateCaches.get(state);
  if (!cache) stateCaches.set(state, cache = {});
  return cache;
}

/**
 * The implementations an addon registers for the commands it declares.
 *
 * They are kept beside the runtime rather than in it: a save is data, and a function cannot be one.
 * The editor's addon host attaches them when it creates or restores a game, which is also why a
 * project played without its addons simply runs without them.
 */
const addonHooksByState = new WeakMap();

export function setAddonHooks(state, hooks) {
  addonHooksByState.set(state, hooks || null);
  return state;
}

export function addonHooks(state) {
  return addonHooksByState.get(state) || null;
}

/** What an addon's implementation is handed: the game, the rule and the object it named. */
function addonContext({ project, state, event, command, findTarget, player }) {
  const id = command.entityId === '$self' ? event.ownerId : command.entityId;
  // `$player` is a real object; every other token (`$world`, `$all`) is a keyword, not something an
  // implementation can be handed.
  const entity = !id ? null : id === '$player' ? (player ? { ...player, type: 'player' } : null)
    : !String(id).startsWith('$') ? findTarget(id) : null;
  return {
    project, state, event, command, entity,
    find: findTarget,
    player,
    /** A message over the game view, the same one a rule writes with `showMessage`. */
    say(text, seconds = 4) { state.message = String(text); state.messageTime = Number(seconds) || 4; },
    /**
     * A Doom sound by name.
     *
     * It goes through the same queue every other sound uses, so it is capped, positioned with the
     * `x`/`y` the audio player reads, and reaches the same overflow counter.
     */
    sound(name, volume = .6) {
      if (!name) return;
      soundEvent(state, String(name), Math.min(1, Math.max(0, Number(volume) || 0)), entity || undefined);
    },
  };
}

/**
 * Runs one addon implementation, containing whatever it does.
 *
 * An addon is third-party code in the game loop: a throw, or a rejected promise nobody awaits, must
 * not end the frame, skip the rest of the rule, or take the preview down with it. It is reported the
 * way every other addon failure is — to the host's error log — and the step carries on.
 */
function runAddon(handler, context, command) {
  let result;
  try { result = handler(context, command); }
  catch (error) {
    reportAddonFailure(context?.state, command?.type, error);
    return null;
  }
  if (result && typeof result.then === 'function') {
    try {
      result.then(null, error => reportAddonFailure(context?.state, command?.type, error));
    } catch { /* a thenable that throws when awaited is still the addon's problem, not the frame's */ }
  }
  return result;
}

function reportAddonFailure(state, type, error) {
  const report = addonHooks(state)?.onError;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof report === 'function') { try { report({ type, message }); return; } catch { /* the log itself failed */ } }
  // Nothing is listening (a headless run, a test): recorded instead of thrown, and bounded, because a
  // rule that throws every frame must not become a leak.
  addonFailures.push({ type, message });
  if (addonFailures.length > 50) addonFailures.splice(0, addonFailures.length - 50);
}

/** Failures nothing listened for, so a test or a headless run can still see them. */
export const addonFailures = [];

/**
 * Drops everything the runtime remembered about an object that no longer exists.
 *
 * A rule's per-object instance and the health it last saw are keyed by the object's id, so a
 * spawner that made and removed objects left one entry per object for the life of the game.
 */
function forgetEntity(state, id) {
  const instances = cacheFor(state).instances;
  if (instances) for (const byOwner of instances.values()) byOwner.delete(id);
  for (const key of [...state.entitySamples.keys()]) if (key.endsWith(`:${id}`)) state.entitySamples.delete(key);
  for (const key of [...state.fired]) if (key.endsWith(`:${id}`)) state.fired.delete(key);
  for (const key of state.timers.keys()) if (key.startsWith(`${id}:`)) state.timers.delete(key);
  state.pathMotions.delete(id);
  state.enemyMoves.delete(id);
  state.cameraMoves?.delete(id);
  state.pathTweens = state.pathTweens.filter(tween => tween.entityId !== id);
  if (state.viewCamera === id) state.viewCamera = null;
  for (const samples of [state.areaEntries, state.intervals]) {
    if (!samples) continue;
    for (const key of samples.keys()) {
      const parts = key.split(':');
      if (parts.length === 3 && parts[1] === id) samples.delete(key);
    }
  }
}

/**
 * The slowest simulation step and the stage it spent its time in.
 *
 * A frame report can only say "step", and a step that stalls for seconds has to be
 * told apart from the rules, the physics world, the actor state machines or the
 * projectile/effect updates. The breakdown lives in the per-state cache, so it is never
 * part of a save; the accessor is non-enumerable so the save writer never sees it.
 */
export const SLOW_STEP_MS = 120;
function recordStep(state, startedAt, parts) {
  const ms = performance.now() - startedAt;
  const cache = cacheFor(state), previous = cache.slowStep;
  // Totals and peaks per stage, so a long session says where the simulation spends its
  // time instead of only which single frame was the worst.
  const totals = cache.stepTotals ||= {};
  for (const name in parts) {
    const entry = totals[name] ||= { total: 0, max: 0, steps: 0 };
    entry.total += parts[name]; entry.steps++;
    if (parts[name] > entry.max) entry.max = parts[name];
  }
  // `state.stepReportMs` lowers the threshold for a diagnostic run; the default keeps
  // only the frames a player would actually notice.
  const threshold = Number.isFinite(state.stepReportMs) ? state.stepReportMs : SLOW_STEP_MS;
  if (ms >= threshold && (!previous || ms > previous.ms)) {
    cache.slowStep = { ms: Math.round(ms), time: Math.round(state.time * 100) / 100,
      ...Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Math.round(value)])) };
  }
}

/**
 * Entity lookups by id and by type for one frame.
 *
 * Rules ask for the same object dozens of times per frame (`findTarget`, the target
 * check, `forEachType` branches); a linear scan each time is the wrong shape. The
 * cache is keyed on the entities array plus its length and last element, which
 * covers push (spawn) and filter (removal) without re-scanning.
 */
export function entityLookup(state) {
  const entities = state.entities, cache = cacheFor(state);
  const last = entities[entities.length - 1];
  if (cache.entity && cache.entity.list === entities && cache.entity.count === entities.length &&
    cache.entity.last === last) return cache.entity;
  const byId = new Map(), byType = new Map(), spawned = new Map();
  for (const entity of entities) {
    byId.set(entity.id, entity);
    let list = byType.get(entity.type);
    if (!list) byType.set(entity.type, list = []);
    list.push(entity);
    // What a rule about an imported actor also owns: leftovers it spawned. An imported
    // campaign has a rule per actor in every level, so looking this up by scanning the entity
    // list once per rule was the largest single cost of a frame.
    if (entity.spawnedFrom) {
      let children = spawned.get(entity.spawnedFrom);
      if (!children) spawned.set(entity.spawnedFrom, children = []);
      children.push(entity);
    }
  }
  return (cache.entity = { list: entities, count: entities.length, last, byId, byType, spawned });
}

// Probing costs a dozen ray casts and a handful of objects per frame, so it only
// happens when the project has a rule that can read a surface.
const surfaceProjects = new WeakMap();
export function projectUsesSurfaces(project) {
  let used = surfaceProjects.get(project);
  if (used !== undefined) return used;
  used = project.events.some(event => [event.condition, ...(event.conditions || [])].some(condition =>
    condition?.type === 'playerTouchingSurface') || (event.actions || []).some(action => action.type === 'setPlayerGravity'));
  surfaceProjects.set(project, used);
  return used;
}

/** Deterministic RNG: the same seed and inputs replay identically in a save. */
function nextRandom(state) {
  state.randomSeed = (Math.imul(state.randomSeed, 1664525) + 1013904223) >>> 0;
  return state.randomSeed / 4294967296;
}

/**
 * The event tree for a project, compiled once per edit.
 *
 * Building the parent→children map (and filtering the root rules by sheet phase)
 * inside `runRules` meant walking every event four times per frame and doing a
 * `find` over the sheets for each root rule — thousands of map writes per frame for
 * a structure that only changes when the project is edited. `project.events` is
 * replaced (never mutated) by every edit, so its identity is the version marker; the
 * sheets are compared field by field because a sheet toggle can reuse the array.
 */
const ruleTreeCache = new WeakMap();
const EMPTY_RULE_LIST = Object.freeze([]);
export function ruleTree(project) {
  // Timeline cues are rules too: each one is compiled into an ordinary event whose condition
  // asks whether the clock just crossed it, so the same runner, expressions and action set
  // apply. `authored` is what the editor shows and edits; `events` is what runs.
  const authored = project.events || EMPTY_RULE_LIST, sheets = project.eventSheets || EMPTY_RULE_LIST;
  const timesheets = project.timesheets || EMPTY_RULE_LIST;
  const cached = ruleTreeCache.get(authored);
  // `count`/`last` catch a rule appended or removed in place, which tooling and tests
  // do without replacing the array; field edits need no invalidation because the tree
  // holds references to the rule objects themselves. Timeline edits replace their array;
  // the signature also catches cues appended in place by tooling.
  const signature = timesheetSignature(timesheets);
  if (cached && cached.project === project && cached.last === authored[authored.length - 1] && cached.timesheets === timesheets &&
    cached.signature === signature && cached.authoredCount === authored.length &&
    cached.sheets === sheets && cached.sheetCount === sheets.length && sheetsUnchanged(cached.sheetState, sheets)) return cached;
  const cueEvents = timesheetCueEvents(timesheets, projectIds(project));
  const events = cueEvents.length ? [...authored, ...cueEvents] : authored;
  const children = new Map();
  for (const event of events) {
    const list = children.get(event.parentId);
    if (list) list.push(event); else children.set(event.parentId, [event]);
  }
  const sheetState = sheets.map(sheet => [sheet.id, sheet.enabled !== false, sheet.phase || 'afterPhysics']);
  const phases = new Map(), sheetPhase = new Map();
  for (const [id, enabled, phase] of sheetState) {
    sheetPhase.set(id, enabled ? phase : null);
    if (enabled && !phases.has(phase)) phases.set(phase, []);
  }
  for (const event of events) {
    if (event.parentId) continue;
    // A rule whose sheet is missing or unknown runs in afterPhysics, as it always has
    // (object scripts and hand-written events need no sheet); a rule whose sheet is
    // known but disabled never runs. `??` cannot tell those apart, because a disabled
    // sheet stores null.
    const phase = sheetPhase.has(event.sheetId) ? sheetPhase.get(event.sheetId) : 'afterPhysics';
    if (!phase) continue;
    if (!phases.has(phase)) phases.set(phase, []);
    phases.get(phase).push(event);
  }
  const timelineEvents = new Map();
  for (const event of cueEvents) {
    if (!timelineEvents.has(event.timesheetId)) timelineEvents.set(event.timesheetId, new Map());
    timelineEvents.get(event.timesheetId).set(event.cueId, event);
  }
  const tree = { count: events.length, last: authored[authored.length - 1], authoredCount: authored.length,
    project, signature, timesheets, sheets, sheetCount: sheets.length, sheetState, children, phases, timelineEvents };
  ruleTreeCache.set(authored, tree);
  return tree;
}

function sheetsUnchanged(snapshot, sheets) {
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index], saved = snapshot[index];
    if (saved[0] !== sheet.id || saved[1] !== (sheet.enabled !== false) || saved[2] !== (sheet.phase || 'afterPhysics')) return false;
  }
  return true;
}

function touchingSurfaces(state) {
  return state.surfaces || (state.surfaces = state.physics?.probeSurfaces?.(state.player.up) || []);
}

/**
 * Turn the player's gravity onto a surface: `world` restores normal gravity, a
 * classification picks the nearest wall / floor / ceiling contact, and `nearest`
 * takes whatever the capsule is pressed against. Doing nothing is the right answer
 * when the surface is not there any more, so events never need a guard.
 */
function setPlayerGravity(state, mode, reach = SURFACE_REACH) {
  const player = state.player;
  if (mode === 'world') return alignUpAndApply(state, WORLD_UP, 0);
  const current = player.up || WORLD_UP;
  const surfaces = (state.physics?.probeSurfaces?.(current, reach) || [])
    .filter(surface => mode === 'nearest' ? dotMap(surface.normal, current) < .75 : surface.kind === mode);
  if (!surfaces.length) return false;
  return alignUpAndApply(state, surfaces[0].normal, surfaces[0].distance);
}

function alignUpAndApply(state, up, clearance = 0) {
  const player = state.player;
  if (!alignUp(player, up)) return false;
  // Keep the look direction and pitch; the camera rolls onto the new surface and
  // the body is placed so its feet land where the surface actually is.
  state.physics?.orientPlayer?.(player.up, clearance);
  state.surfaces = null;
  return true;
}

/**
 * Keeps ground actors out of the floor.
 *
 * GZDoom's `P_ZMovement` pushes an actor that ends up inside the floor back up to
 * it. Spawn spots, scripted teleports and lowering platforms can leave `z` below the
 * sector floor, and a sprite anchored there is drawn half-buried, so the correction
 * happens here and is recorded for the playtest log instead of passing silently.
 */
export function settleGroundActors(state) {
  for (const entity of state.entities) {
    if (entity.type === 'player' || !Number.isFinite(entity.z)) continue;
    // Rigid bodies are simulated by Rapier, which already rests them on the floor.
    if (entity.physics && entity.physics.body !== 'none') continue;
    const sector = entitySector(state.sectors, entity);
    if (!sector) continue;
    if (entity.z >= sector.floorHeight - 1) continue;
    state.groundCorrections ??= { count: 0, first: null };
    state.groundCorrections.count++;
    state.groundCorrections.first ??= { name: entity.name || entity.id, id: entity.id,
      below: Math.round((sector.floorHeight - entity.z) * 10) / 10 };
    entity.z = sector.floorHeight;
  }
}

/** Commands with no expressions in them, so the scan happens once per command. */
const expressionFree = new WeakSet();

/**
 * Evaluates one expression field of a command and validates the result against the
 * field it fills. Kept out of the per-rule closure so the hot loop stays small.
 */
function resolveExpression(command, key, value, context, project, event) {
  try {
    const result = evaluateExpression(value, context);
    // The project is passed so an addon's command is described too: without it every addon field falls
    // through to the generic numeric rule, which rejects a text expression and lets a number through
    // that the field's own bounds forbid.
    const field = engineCommand(command.type, project)?.fields.find(entry => entry.name === key);
    if (field?.kind === 'number') {
      if (typeof result !== 'number' || result < field.min || result > field.max ||
        ['pellets', 'diceSides', 'doomType'].includes(key) && !Number.isInteger(result)) throw new Error(`Invalid numeric result for ${key}`);
    } else if (field?.kind === 'string' || key === 'message') {
      if (typeof result !== 'string' || result.length > (key === 'message' ? 500 : 2000)) throw new Error(`Invalid text result for ${key}`);
    } else if (!field && !['setVariable', 'addVariable'].includes(command.type)) {
      const physics = ['applyImpulse', 'applyForce', 'setVelocity'].includes(command.type);
      const min = key === 'distance' ? 1 : key === 'speed' ? .01 : key === 'angle' ? -3600 : !physics && key === 'z' ? -32768 : physics ? -100000 : -65536;
      const max = key === 'distance' ? 4096 : key === 'speed' ? 10 : key === 'angle' ? 3600 : !physics && key === 'z' ? 32767 : physics ? 100000 : 65536;
      if (typeof result !== 'number' || result < min || result > max) throw new Error(`Invalid numeric result for ${key}`);
    }
    if (command.type === 'setPlayerStat' && command.stat === 'armorDivisor' && result < 1) throw new Error('Armor divisor must be at least 1');
    if (command.type === 'setHUDProperty' && key === 'value') validateHUDProperty(command.property, result,
      project.hud.elements.find(element => element.id === command.elementId), (ok, message) => { if (!ok) throw new Error(message); });
    return result;
  } catch (error) {
    throw new Error(`Event "${event.name || event.id}", ${command.type}.${key}: ${error.message}`, { cause: error });
  }
}

/**
 * Collision test for projects with no physics world: the destination must be a sector
 * tall enough to stand in and reachable without crossing a solid or too-low wall.
 */
function fallbackMovement(state) {
  const sectors = new Map(state.sectors.map(sector => [sector.id, sector]));
  return (x, y, currentFloor) => {
    const destination = sectorAt(state.sectors, x, y);
    if (state.sectors.length && (!destination || destination.ceilingHeight - destination.floorHeight < 56 ||
      destination.floorHeight - (currentFloor ?? destination.floorHeight) > 24)) return false;
    return !state.walls.some(wall => {
      if (distanceToSegment(x, y, wall.start, wall.end) >= 12) return false;
      if (wall.solid) return true;
      const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
      if (!front || !back) return false;
      const floor = Math.max(front.floorHeight, back.floorHeight), ceiling = Math.min(front.ceilingHeight, back.ceilingHeight);
      return ceiling - floor < 56 || floor - (currentFloor ?? floor) > 24;
    });
  };
}

/**
 * Moves a script's screen fade towards the colour and strength it asked for.
 *
 * `FadeTo` names a target and a duration, so the state is a pair of colours and a clock
 * rather than one number: a fade interrupted by another starts from wherever it had got to,
 * which is what GZDoom's `screen->Fade` does when two scripts overlap.
 */
function advanceScreenFade(state, dt) {
  const target = state.screenFade;
  // No target means no fade is *in progress*; whatever the last one left on screen stays.
  if (!target) return;
  state.fadeClock = (state.fadeClock || 0) + dt;
  const from = state.screenFadeFrom || { red: target.red, green: target.green, blue: target.blue, amount: 0 };
  const progress = target.seconds > 0 ? Math.min(1, state.fadeClock / target.seconds) : 1;
  const mix = (a, b) => a + (b - a) * progress;
  const now = { red: mix(from.red, target.red), green: mix(from.green, target.green),
    blue: mix(from.blue, target.blue), amount: mix(from.amount, target.amount) };
  state.screenFadeNow = now.amount > 0.002 ? now : null;
  // A finished fade stops being a *target*, but what it left on screen stays: an instant
  // `FadeTo` to black must hold until a later one takes it away, which is exactly what the
  // title map does one second later. Clearing the picture here made the black vanish on the
  // next frame and the fade-in start from nothing.
  if (progress >= 1) { state.screenFade = null; state.screenFadeFrom = null; }
}

export function stepRuntime(project, state, dt, keys, pressed = new Set()) {
  if (state.worldTerminalActive) {
    keys = new Set(keys); pressed = new Set(pressed);
    for (const key of ['Mouse0', 'Mouse2']) { keys.delete(key); pressed.delete(key); }
  }
  dt = Math.max(0, Math.min(0.05, dt));
  // Sight is asked several times per object per frame; it only ever lives for one frame,
  // because the geometry it depends on (a door that opens) can change between them.
  state.sightMemo?.clear();
  const stepStarted = performance.now(), stepParts = (cacheFor(state).stepParts ||= {});
  let stepMark = stepStarted;
  const stage = name => { const now = performance.now(); stepParts[name] = now - stepMark; stepMark = now; };
  const player = state.player, hud = state.hudState;
  const shotTriggers = state.worldTriggers.shoot;
  let currentSignal = null;
  const deliveredSignals = new Set();
  state.sounds.length = 0;
  state.rumbles.length = 0;
  advanceHUD(project, state.hudState, dt, 'interface');
  runRules('interface');
  dispatchSignals('interface');
  // The interface phase is the last unconditional observer of a game-phase completion, so its
  // one-frame marker is consumed here; the game advance that would also clear it is skipped while
  // paused, which otherwise replayed the completion on every paused frame.
  clearFinishedHUD(project, state.hudState, 'game');
  // A script's `FadeTo` keeps running whatever the screen is doing: a title map fades to
  // black, hands the view to a camera, ends its script, and fades back in five seconds later.
  advanceScreenFade(state, dt);
  stage('interface');
  state.interfaceStarted = true;
  state.hudState.cursor = state.gameScreen !== 'playing' || state.hudState.cursor;
  if (state.gameScreen !== 'playing' && !state.ambientWorld) {
    state.hudState.clicked.clear(); return;
  }
  state.worldTriggers.shoot = new Set();
  state.time += dt;
  // Timelines run on the game's clock, so they pause with the game and a save keeps their place.
  // Cues are executed later in the frame by the rule runner, which is why the due set outlives
  // this call.
  advanceTimesheets(project, state, dt);
  if (state.impacts.length) state.impacts = state.impacts.filter(effect => {
    // Trail particles drift while their animation plays.
    if (effect.vx || effect.vy || effect.vz) {
      effect.x += (effect.vx || 0) * dt; effect.y += (effect.vy || 0) * dt; effect.z += (effect.vz || 0) * dt;
    }
    if (effect.until !== undefined) return state.time < effect.until;
    return !clipFrame(project, effect.clipId, state.time - effect.start)?.finished;
  });
  state.input.forward = 0; state.input.strafe = 0; state.input.jump = false;
  // A `turnPlayer` action asks for a rate in degrees per second for this frame; the tic
  // loop below is what actually turns, so a turn ramps the way Doom's does.
  state.turnRequest = 0;
  state.prevButtons = state.buttons || 0;
  state.buttons = hud.cursor ? 0 : buttonsFor(keys);
  if (state.playerStats.health < state.feedback.health) recordDamage(state, state.feedback.health - state.playerStats.health);
  state.feedback.attackTime = !hud.cursor && keys.has('Mouse0') ? state.feedback.attackTime + dt : 0;
  advanceHUD(project, hud, dt);
  stage('hud');
  updateProximityDoors(project, state);
  updateProximityElevators(project, state);
  advanceSectors(state, dt);
  // Waggling planes and the 3D floors built on them move every frame, not only on an event.
  advancePlaneMotion(state, dt);
  // Objects that follow a route move after the planes and before gravity: their height comes from
  // the curve, so nothing should then pull them back down to a floor they are not on.
  advancePathMotion(project, state, dt);
  // Moves a cue asked for: an object travelling between two waypoints of a route over a set
  // time. They run after the followers so a tween wins on an object that also follows a path.
  advancePathTweens(project, state, dt);
  // Camera glides and following cameras run on the game's clock, before the frame is drawn.
  advanceCameras(project, state, dt);
  // Things the map left in the air fall under the map's own gravity, which is how Lullaby's
  // title map rains its stars. It runs after the planes so a star lands on the floor it sees.
  stepThingGravity(project, state, dt);
  stage('sectors');
  const manualUse = !hud.cursor && state.playerStats.health > 0 && pressed.has('KeyE');
  const usedWall = manualUse ? useWall(state) : null;
  if (manualUse) { useManualDoor(project, state); useManualElevator(project, state); }
  stage('use');
  state.worldTriggers.use = usedWall?.use ?? null;
  // The nearest line that actually carries a special, so a plain wall in front of a door
  // does not swallow the press.
  state.worldTriggers.useSpecial = usedWall?.special ?? null;
  // The weapon trigger is one bit a frame: a rule may hold it (`weaponTrigger`), and
  // without such a rule the mouse holds it (see `stepWeapon`). Clearing the requests here
  // means a rule that stops running lets go.
  state.weaponTriggerRequest = false;
  state.weaponAltRequest = false;
  state.weaponTriggerHeld = false;
  state.weaponAltHeld = false;
  runRules('beforePhysics');
  dispatchSignals('beforePhysics');
  stage('rules');
  if (state.gameScreen !== 'playing' && !state.ambientWorld) { hud.clicked.clear(); return; }
  // Doom's player does not move at a speed the keys choose; it accumulates momentum one
  // tic at a time (turn, thrust, friction), which is why it takes about thirty tics to
  // reach full speed and a moment to coast to a stop. See shared/player-motion.js.
  const forwardAxis = hud.cursor ? 0 : (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const sideAxis = hud.cursor ? 0 : (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  // A scripted project turns with its own `turnPlayer` actions; the arrow keys are not
  // read there, the same way they were not before.
  const turnAxis = hud.cursor || state.scriptedInput ? 0
    : (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  // Shift toggles `alwaysRun`, the same way Doom's `always_run` does.
  const running = state.settings.alwaysRun !== keys.has('ShiftLeft');
  const runMultiplier = running ? 2 : 1;
  // Doom ramps a held turn up: the first six tics run at half rate (`SLOWTURNTICS`).
  const turnBam = state.scriptedInput ? (state.turnRequest || 0) * bamPerDegreePerSecond
    : turnAxis * (running ? TURN_SPEED.runFast : TURN_SPEED.walkFast);
  // Walking without a physics world is the fallback path; its sector map and closures
  // are only built when that path is actually taken.
  const canMove = state.physics ? null : (cacheFor(state).canMove ||= fallbackMovement(state));
  const previousPosition = { x: player.x, y: player.y };
  const grounded = state.physics ? state.physics.grounded : true;
  const jumpHeld = state.settings.jumping && !hud.cursor && state.playerStats.health > 0 &&
    (state.scriptedInput ? state.input.jump : pressed.has('Space'));
  const bunnyhop = state.bunnyhop ||= { multiplier: 1, chain: 0, airborne: false, lastJump: -Infinity, lastLanding: -Infinity };
  if (grounded && bunnyhop.airborne) bunnyhop.lastLanding = state.time;
  bunnyhop.airborne = !grounded;
  if (!state.settings.bunnyhop) { bunnyhop.multiplier = 1; bunnyhop.chain = 0; }
  else if (grounded) {
    if (jumpHeld) {
      bunnyhop.chain = state.time - bunnyhop.lastLanding <= .3 ? bunnyhop.chain + 1 : 1;
      bunnyhop.multiplier = Math.min(1 + state.settings.bunnyhopGain * 12, 1 + state.settings.bunnyhopGain * bunnyhop.chain);
      bunnyhop.lastJump = state.time;
    } else if (state.time - bunnyhop.lastJump > .1) {
      bunnyhop.chain = 0;
      bunnyhop.multiplier = Math.max(1, bunnyhop.multiplier - state.settings.bunnyhopGain * 8 * dt);
    }
  }
  const speed = runMultiplier * bunnyhop.multiplier;
  state.playerClock = (state.playerClock || 0) + dt * TIC_RATE;
  const wholeTics = Math.floor(state.playerClock + 1e-6);
  const tics = Math.min(wholeTics, MAX_PLAYER_TICS);
  state.playerClock -= wholeTics;
  // A project can run Half-Life's movement instead of Doom's; see shared/source-motion.js.
  const sourceModel = state.motionModel === 'source' ? state.motionSettings : null;
  for (let tic = 0; tic < tics; tic++) {
    if (turnBam) {
      const radians = state.scriptedInput
        ? Math.sign(turnBam) * Math.abs(turnBam) * (state.turnHeld < SLOW_TURN_TICS ? SLOW_TURN_RATIO : 1) * 2 * Math.PI / 65536
        : turnAxis * turnStep(state.turnHeld, { run: running });
      player.angle += radians;
      state.turnHeld++;
    } else state.turnHeld = 0;
    // The axis values a movement model is given: keys for a played game, the values a visual
    // script asked for when the project is scripted.
    const axisForward = state.scriptedInput ? (hud.cursor ? 0 : state.input.forward) / 160 : forwardAxis;
    const axisSide = state.scriptedInput ? (hud.cursor ? 0 : state.input.strafe) / 160 : sideAxis;
    if (sourceModel) {
      // One Source player tic of horizontal movement. The vertical axis is the collision
      // world's: it integrates gravity and slides the capsule, and `measuredVelocity` below
      // adopts whatever the slide achieved, so a surf ramp hands its speed to the model.
      state.motion ||= { x: 0, y: 0, z: 0 };
      state.motion = clampHorizontal(horizontalStep(state.motion, {
        grounded, forward: axisForward, side: axisSide, angle: player.angle, dt: 1 / TIC_RATE,
        settings: sourceModel }), sourceModel);
      state.momentum = { x: state.motion.x / TIC_RATE, y: state.motion.y / TIC_RATE, z: 0 };
      continue;
    }
    // A visual script asks for a speed in units per second; Doom reaches a speed by
    // thrusting towards it, so the request becomes the thrust that saturates at it.
    const thrust = state.scriptedInput
      ? thrustTowards({ forward: hud.cursor ? 0 : state.input.forward * speed, side: hud.cursor ? 0 : state.input.strafe * speed })
      : thrustFor({ forward: forwardAxis, side: sideAxis }, { run: running, speedMultiplier: bunnyhop.multiplier });
    // Movement is laid out in the player's own plane, so it keeps working after an
    // event turns gravity onto a wall: forward and strafe stay on that surface.
    const basis = playerBasis(player.up), cosHeading = Math.cos(player.angle), sinHeading = Math.sin(player.angle);
    state.momentum ||= { x: 0, y: 0, z: 0 };
    const advanced = advanceMomentum(state.momentum, {
      x: (basis.forward[0] * cosHeading + basis.right[0] * sinHeading) * thrust.forward
        + (basis.right[0] * cosHeading - basis.forward[0] * sinHeading) * thrust.side,
      y: (basis.forward[1] * cosHeading + basis.right[1] * sinHeading) * thrust.forward
        + (basis.right[1] * cosHeading - basis.forward[1] * sinHeading) * thrust.side,
      z: (basis.forward[2] * cosHeading + basis.right[2] * sinHeading) * thrust.forward
        + (basis.right[2] * cosHeading - basis.forward[2] * sinHeading) * thrust.side,
    }, { grounded });
    // A stopped player gets its own zero: the shared one is frozen, and the wall-stop code
    // further down zeroes axes on `state.momentum`. Storing the frozen object made a player
    // pressed against a wall throw and kill the preview.
    state.momentum = advanced === ZERO_MOMENTUM ? { x: 0, y: 0, z: 0 } : advanced;
  }
  state.sourceGrounded = grounded;
  if (tics) {
    // Doom advances the bob timer every player tic, whether the player moves or not.
    state.bobTimer = (state.bobTimer || 0) + tics;
    state.bob = bobFor(state.momentum);
    // How fast the player is actually travelling, which is what the bob and a playtest care
    // about. Not `state.motion`: under Half-Life movement that is the speed the model *wants*,
    // and it keeps asking for one while pressed into a wall. The momentum carries the speed the
    // world last confirmed, so it reads zero there and does not flicker between tics.
    const travelled = momentumSpeed(state.momentum);
    state.speed = Math.hypot(travelled.x, travelled.y);
  }
  const velocity = sourceModel ? { ...state.motion } : momentumSpeed(state.momentum);
  const dx = velocity.x * dt, dy = velocity.y * dt, dz = velocity.z * dt;
  state.physics?.syncWorld();
  if (state.physics) {
    state.physics.step(dt, { x: velocity.x, y: velocity.y, z: velocity.z, jump: jumpHeld, up: player.up,
      // A movement model can ask for its own gravity: Half-Life runs at 600 units/s² where
      // Doom's is 1225, so the fall has to be the model's, not this engine's.
      ...(sourceModel ? { gravity: sourceModel.gravity, jumpSpeed: sourceModel.jumpSpeed } : {}) });
    // Surfaces the capsule touches, for the wall-walking events and conditions.
    if (projectUsesSurfaces(project)) state.surfaces = state.physics.probeSurfaces?.(player.up) || [];
  }
  else {
    const currentFloor = sectorAt(state.sectors, player.x, player.y)?.floorHeight;
    if (canMove(player.x + dx, player.y, currentFloor)) player.x += dx;
    if (canMove(player.x, player.y + dy, currentFloor)) player.y += dy;
  }
  if (sourceModel) {
    // Adopt the speed the player really travelled at: pressed against a wall that is zero,
    // and sliding down a surf ramp it is the speed along the ramp, which is the whole point.
    // The physics world measures it, over the substeps it really ran. When it ran none — most
    // frames at a high frame rate — it has nothing to say, and the model keeps its own velocity
    // rather than being told it is standing still.
    //
    // This is deliberately not gated on a player tic having run: the world's sub-steps and the
    // tics are on different clocks, and waiting for both to land in the same frame meant the
    // movement was corrected far less often at a high frame rate — which made the player
    // accelerate measurably slower the faster the game was drawn.
    // Without a collision world the movement itself only happens on a tic, so there is nothing
    // to measure on a frame that ran none.
    const measured = state.physics ? state.physics.playerVelocity
      : (tics ? measuredVelocity({ x: previousPosition.x, y: previousPosition.y }, { x: player.x, y: player.y }, (tics / TIC_RATE)) : null);
    if (measured) {
      state.motion = clampHorizontal({ x: measured.x, y: measured.y, z: 0 }, sourceModel);
      state.momentum = { x: state.motion.x / TIC_RATE, y: state.motion.y / TIC_RATE, z: 0 };
    }
  }
  // Doom drops the momentum of an axis the player could not move along, so pushing at a
  // wall does not bank speed that is released when it opens. The physics world reports which
  // axes the character controller was stopped on; without one, the plain walking path moves
  // the player exactly as far as it asked to or not at all.
  if (state.momentum && !sourceModel) {
    // A physics world reports it, because it is the only thing that knows whether a move was
    // refused; the plain walking path moves the player exactly as far as it asked to or not
    // at all, so it can answer the same question itself.
    const stopped = state.physics?.blocked ?? {
      x: Math.abs(dx) > BLOCKED_STEP && player.x === previousPosition.x ? WALL_SUBSTEPS : 0,
      y: Math.abs(dy) > BLOCKED_STEP && player.y === previousPosition.y ? WALL_SUBSTEPS : 0,
    };
    if (stopped.x >= WALL_SUBSTEPS) state.momentum.x = 0;
    if (stopped.y >= WALL_SUBSTEPS) state.momentum.y = 0;
  }
  stage('physics');
  // Nothing can be crossed by a player who has not moved, and walking the whole wall
  // list every frame is the single most expensive per-frame check on a big map.
  state.worldTriggers.cross = previousPosition.x === player.x && previousPosition.y === player.y
    ? new Set() : crossedWalls(state, previousPosition);
  // ACS `Use`/`PlayerUse` sees the same line the visual rules see, which is the one
  // with the special when the player is not aiming straight at a plain wall.
  for (const id of new Set([usedWall?.use, usedWall?.special].filter(Boolean))) {
    state.scripts?.activate(state.walls.find(wall => wall.id === id), 'use');
  }
  for (const id of state.worldTriggers.cross) state.scripts?.activate(state.walls.find(wall => wall.id === id), 'cross');
  state.scripts?.step(dt);
  expireHudMessages(state);
  updateLevelStatistics(state);
  state.messageTime = Math.max(0, state.messageTime - dt);
  runRules('afterPhysics');
  dispatchSignals('afterPhysics');
  stage('afterRules');
  if (state.gameScreen !== 'playing') { hud.clicked.clear(); return; }
  // Imported actor definitions (DECORATE/ZScript) drive enemy and weapon state
  // machines; they run at Doom's 35 Hz tic rate next to the frame update.
  if (project.actors?.length) {
    stepActors(project, state, dt);
    const armed = !hud.cursor && state.playerStats.health > 0;
    if (!state.worldTerminalActive) stepWeapon(project, state, dt, armed && keys.has('Mouse0'), armed && keys.has('Mouse2'));
    else { state.weaponTriggerHeld = false; state.weaponAltHeld = false; state.weaponAttack = null; }
    applyWeaponAttack(project, state);
    tickMorphs(project, state);
  }
  stage('actors');
  stepProjectiles(project, state, dt);
  settleGroundActors(state);
  advanceProjectiles(state, dt, projectile => runProjectileDeath(project, state, projectile),
    (entity, amount, source, damageType) => hurtActor(project, state, entity, amount, source, damageType));
  stage('projectiles');
  applySectorDamage(state, dt);
  activateWallTriggers(state);
  updateLevelStatistics(state);
  state.input.mouseX = 0; state.input.mouseY = 0;
  state.animationFinished.clear();
  state.feedback.health = state.playerStats.health;
  hud.clicked.clear();
  state.started = true;
  stage('effects');
  recordStep(state, stepStarted, stepParts);
  function dispatchSignals(phase) {
    let batch;
    while ((batch = signalBatch(state, phase)).length) {
      for (const signal of batch) {
        deliveredSignals.add(signal);
        if (deliveredSignals.size > SIGNAL_LIMIT) throw new Error(`Signal dispatch exceeded ${SIGNAL_LIMIT} emissions in one tick; check for a signal loop`);
        currentSignal = signal;
        runRules(phase, true);
      }
    }
    currentSignal = null;
  }
  function runRules(phase, signalDispatch = false) {
    const tree = ruleTree(project), roots = tree.phases.get(phase);
    if (!roots?.length) return;
    const instances = cacheFor(state).instances ||= new Map();
    // `forEachType` branches used to spread a fresh copy of the rule for every
    // matching object every frame. One copy per owner is enough, because a rule never
    // mutates itself while it runs, so the copies are kept and reused.
    function instanceFor(source, ownerId) {
      let byOwner = instances.get(source.id);
      if (!byOwner) instances.set(source.id, byOwner = new Map());
      let cached = byOwner.get(ownerId);
      if (cached?.source !== source) {
        cached = { source, event: { ...source, ownerId } };
        byOwner.set(ownerId, cached);
      }
      return cached.event;
    }
    /**
     * One rule and its sub-events.
     *
     * `picks` is the set of instances the rule is about, which both GDevelop and Construct call
     * the picked objects: a `pick` condition narrows it, and sub-events inherit the narrowed set.
     * An empty map means "nothing narrowed yet", and every consumer then means every instance of
     * the type — so a rule that never picks still behaves exactly as it always did.
     */
    function visit(source, ownerId, picks) {
      if (source.groupId && !state.groups.get(source.groupId)) return;
      // Each branch owns its narrowing; siblings start again from the parent's selection.
      // The root of a branch has none of its own to own, so its map is made once, here.
      picks = picks ? new Map(picks) : new Map();
      const owner = entityLookup(state).byId.get(ownerId || source.ownerId);
      if (owner && !ownerId) picks = ownPick(picks, owner.type, owner.id);
      if (ownerId) {
        if (!runEvent(instanceFor(source, ownerId), Boolean(source.forEachType || ownerId !== source.ownerId), phase, picks)) return;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        for (const child of tree.children.get(source.id) || []) {
          visit(child, ownerId, picks);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
        return;
      }
      if (!source.forEachType) {
        if (!runEvent(source, false, phase, picks)) return;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        // Sub-events inherit the owner of the rule that ran them, so "this object" in a
        // child of an object script still means that object.
        for (const child of tree.children.get(source.id) || []) {
          visit(child, source.ownerId, picks);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
        return;
      }
      // A for-each rule iterates what the event picked, not every instance of the type: that is
      // what makes "pick the enemies below 5 health, then for each one" mean what it reads as.
      const matching = pickedInstances(state, picks, source.forEachType);
      if (!matching?.length) return;
      for (const entity of matching) {
        const event = instanceFor(source, entity.id);
        // Each instance gets its own view of the pick, narrowed to itself: a sub-event of a
        // per-instance rule is about that instance, which is what "$self" already meant.
        const own = ownPick(picks, source.forEachType, entity.id);
        if (!runEvent(event, true, phase, own)) continue;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        for (const child of tree.children.get(source.id) || []) {
          visit(child, event.ownerId, own);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
      }
    }
    const lookup = entityLookup(state);
    for (const source of roots) {
      if (source.timesheetId) continue;
      if (hasSignalCondition(source) !== signalDispatch) continue;
      // A rule about one imported actor has nothing to run when that actor is not in the
      // level being played, and an imported campaign has one for every actor in every level.
      // Its children are skipped with it, exactly as the rule body skipping them was.
      if (source.ownerId) {
        // A rule earlier in this phase may have spawned one of these or removed its owner, so
        // the index is asked again here: it is a few identity checks, not a rebuild.
        const owners = entityLookup(state);
        if (owners.byId.has(source.ownerId)) {
          visit(source, undefined);
          if (phase !== 'interface' && state.gameScreen !== 'playing') break;
        }
        for (const entity of owners.spawned.get(source.ownerId) || []) {
          visit(source, entity.id, ownPick(new Map(), entity.type, entity.id));
          if (phase !== 'interface' && state.gameScreen !== 'playing') break;
        }
      } else visit(source, undefined);
      if (phase !== 'interface' && state.gameScreen !== 'playing') break;
    }
    if (!signalDispatch && phase === 'afterPhysics' && state.gameScreen === 'playing') {
      for (const [id, events] of tree.timelineEvents) {
        const due = state.timesheets?.get(id)?.due;
        for (const cueId of [...(due || [])]) {
          const event = events.get(cueId);
          if (event) visit(event, undefined);
          if (state.gameScreen !== 'playing') return;
        }
      }
    }
  }
  /**
   * One rule, with the rule's pick exposed on the state while it runs.
   *
   * Expressions name an object type and mean "the instances this rule is about", so the pick has
   * to be reachable from `expressionContext`. It is restored afterwards because a value read
   * outside any rule (`stepRuntime` bookkeeping, HUD, saves) means every instance, not the last
   * rule's narrowed set.
   */
  function runEvent(event, perInstance, phase, picks = new Map()) {
    const outer = state.picks;
    state.picks = picks;
    try { return runEventBody(event, perInstance, phase, picks); } finally { state.picks = outer; }
  }
  function runEventBody(event, perInstance, phase, picks) {
    // The key is a string per rule and per owner, so building it for every rule of
    // every frame is one of the largest garbage sources in the simulation. Only the
    // conditions that sample state and the one-shot bookkeeping need it.
    let eventKey = null;
    const keyOf = () => eventKey ??= perInstance ? `${event.id}:${event.ownerId}` : event.id;
    if (!event.enabled || (event.once && state.fired.has(keyOf()))) return;
    const lookup = entityLookup(state);
    if (event.ownerId && !lookup.byId.has(event.ownerId)) return;
    // A missile id resolves too: a rule about a projectile ("for each projectile" or a
    // sub-event of one) needs `$self` to mean the missile it is about.
    const findTarget = id => {
      const resolved = resolveEntityId(event, id);
      return entityLookup(state).byId.get(resolved) ||
        (state.projectiles || []).find(projectile => String(projectile.id) === String(resolved)) || undefined;
    };
    // The expression context (which builds closures and lookups) is only needed when a
    // command actually contains an expression, so it is built on first use.
    let context = null;
    const resolveCommand = command => {
      if (expressionFree.has(command)) return command;
      let resolved = command, found = false;
      for (const key in command) {
        const value = command[key];
        if (!isExpression(value)) continue;
        found = true;
        if (resolved === command) resolved = { ...command };
        context ||= expressionContext(project, event, state, dt, { selection: picks });
        resolved[key] = resolveExpression(command, key, value, context, project, event);
      }
      // Commands are immutable between edits (an edit replaces the project), so a
      // command that carries no expression is remembered and never scanned again.
      if (!found) expressionFree.add(command);
      return resolved;
    };
    function forPicked(command, apply) {
      for (const entity of pickedInstances(state, picks, command.objectType)) {
        resolveForInstance(command, entity, apply);
      }
    }
    function resolveForInstance(command, entity, apply) {
      const outer = state.picks;
      state.picks = ownPick(picks, command.objectType, entity.id);
      try { return apply(entity, resolveCommand(command)); } finally { state.picks = outer; }
    }
    function assignVariable(record, name, value, add) {
      if (!Object.hasOwn(record, name)) throw new Error(`Event "${event.name || event.id}" references missing variable "${name}"`);
      if (typeof value !== typeof record[name] || add && typeof value !== 'number') throw new Error(`Event "${event.name || event.id}": variable "${name}" type mismatch`);
      // Repeated "add to variable" has to stay a legal value forever: a counter that reaches the
      // scalar limit saturates there rather than throwing and stopping the game on the next tick.
      const limit = 1e12;
      record[name] = scalar(add ? Math.max(-limit, Math.min(limit, record[name] + value)) : value);
    }
    function compare(a, operator, b) {
      if (typeof a !== typeof b || !['number', 'string', 'boolean'].includes(typeof a) || typeof a === 'boolean' && !['=', '!='].includes(operator)) throw new Error(`Event "${event.name || event.id}": incompatible comparison types`);
      return compareValues(a, operator, b);
    }
    function hasWallActivationParent() {
      let current = event;
      while (current) {
        if (eventConditions(current).some(condition => condition?.type === 'wallActivated')) return true;
        current = current.parentId ? project.events.find(candidate => candidate.id === current.parentId) : null;
      }
      return false;
    }
    let statChanges = null;
    const matchOne = (condition, index) => {
      const candidates = condition.inverted && PICK_CONDITIONS.has(condition.type)
        ? pickedInstances(state, picks, condition.objectType) : null;
      const matched = Boolean(matchCondition(condition, index));
      if (candidates) {
        const chosen = picks.get(condition.objectType);
        const remaining = candidates.filter(entity => !chosen?.has(entity.id));
        withPick(picks, condition.objectType, new Set(remaining.map(entity => entity.id)));
        return remaining.length > 0;
      }
      return condition.inverted ? !matched : matched;
    };
    function matchCondition(condition, index) {
      if (!['pickByProperty', 'pickByVariable'].includes(condition.type)) condition = resolveCommand(condition);
      if (condition.type === 'onSignal') return currentSignal &&
        currentSignal.entityId === resolveEntityId(event, condition.entityId) && currentSignal.signal === condition.signal;
      if (condition.type === 'signalValueCompare') return currentSignal &&
        typeof currentSignal.value === typeof condition.value && compare(currentSignal.value, condition.operator, condition.value);
      if (condition.type === 'interactingWithScreen') return Boolean(state.worldTerminalActive);
      if (condition.type === 'gameScreen') return state.gameScreen === condition.screen;
      if (condition.type === 'shaderEnabled') return state.shaderEnabled;
      if (condition.type === 'postFxPassEnabled') return postFxPassEnabled(state, condition.kind);
      if (condition.type === 'postFxParamCompare') return compare(postFxParamValue(state, condition.kind, condition.param),
        condition.operator, condition.value);
      if (condition.type === 'expressionCompare') return compare(condition.left, condition.operator, condition.right);
      if (condition.type === 'objectVariableCompare') {
        const target = findTarget(condition.entityId);
        return target && compare(target.variables[condition.variable], condition.operator, condition.value);
      }
      if (condition.type === 'everySeconds') {
        // Construct's "Every X seconds": the first tick fires immediately, then the
        // interval restarts, so a rule cannot drift or fire twice for one interval.
        const intervals = state.intervals ||= new Map();
        const key = `${keyOf()}:${index}`;
        const due = intervals.get(key) || 0;
        if (state.time + 1e-9 < due) return false;
        intervals.set(key, state.time + condition.seconds);
        return true;
      }
      if (condition.type === 'randomChance') return nextRandom(state) < condition.probability;
      // Doom's AI makes its decisions once a tic, not once a frame: a rule carrying this runs
      // at most once per 35 Hz tic, so an attack roll cannot fire faster on a faster machine.
      if (condition.type === 'oncePerTic') {
        const seen = state.ticSeen ||= new Map();
        const key = `${keyOf()}:${index}`;
        const tic = Math.floor(state.time * 35 + 1e-6);
        if (seen.get(key) === tic) return false;
        seen.set(key, tic);
        return true;
      }
      if (condition.type === 'objectCount') {
        // A missing type means any object, which is what the `'any'` branch below counts: the
        // runtime does not lean on the editor having filled the field in. (This read a field no
        // command defines, so a count with no type came out as zero and never fired.)
        const wanted = condition.entityType || 'any';
        const count = wanted === 'any' ? state.entities.length
          : state.entities.filter(entity => entity.type === wanted).length;
        return compareValues(count, condition.operator, condition.value);
      }
      // ---- Instances: picking ------------------------------------------------------------
      // A pick narrows the event's own instance set. It answers true when it selected something:
      // false would stop the rule, which is what "there are no enemies left to act on" means.
      if (condition.type === 'pickAll') {
        withPick(picks, condition.objectType, new Set(pickedInstances(state, null, condition.objectType).map(entity => entity.id)));
        return true;
      }
      if (condition.type === 'pickByProperty') {
        const chosen = pickedInstances(state, picks, condition.objectType)
          .filter(entity => resolveForInstance(condition, entity, (target, resolved) =>
            compareInstanceProperty(project, state, target, resolved.property, resolved.operator, resolved.value)));
        withPick(picks, condition.objectType, new Set(chosen.map(entity => entity.id)));
        return chosen.length > 0;
      }
      if (condition.type === 'pickByVariable') {
        // An instance without the variable simply does not match, the way an undeclared object
        // variable reads as absent in GDevelop. Authoring still refuses a pick where no instance
        // of the type carries the variable at all, so a typo is caught while it is still cheap.
        const chosen = pickedInstances(state, picks, condition.objectType)
          .filter(entity => Object.hasOwn(entity.variables || {}, condition.variable)
            && resolveForInstance(condition, entity, (target, resolved) =>
              compare(target.variables[resolved.variable], resolved.operator, resolved.value)));
        withPick(picks, condition.objectType, new Set(chosen.map(entity => entity.id)));
        return chosen.length > 0;
      }
      if (condition.type === 'pickNearest') {
        // Measured from the player unless another object is named, which is the reference a
        // creator means nine times in ten ("the nearest health pickup to me").
        const from = !condition.to || condition.to === '$player'
          ? player
          : findTarget(condition.to)?.type === 'player' ? player : findTarget(condition.to);
        if (!from) throw new Error(`Event "${event.name || event.id}" picks the nearest ${condition.objectType} to "${condition.to}", which is not in this level`);
        const chosen = pickedInstances(state, picks, condition.objectType)
          .map(entity => ({ entity, distance: Math.hypot((entity.x ?? 0) - from.x, (entity.y ?? 0) - from.y) }))
          .sort((a, b) => (condition.order === 'furthest' ? b.distance - a.distance : a.distance - b.distance))
          .slice(0, Math.max(1, Math.round(condition.count) || 1))
          .map(entry => entry.entity);
        withPick(picks, condition.objectType, new Set(chosen.map(entity => entity.id)));
        return chosen.length > 0;
      }
      if (condition.type === 'pickRandom') {
        const candidates = [...pickedInstances(state, picks, condition.objectType)];
        const wanted = Math.min(candidates.length, Math.max(1, Math.round(condition.count) || 1));
        const chosen = [];
        // Without replacement: picking the same instance twice would silently shrink the set.
        while (chosen.length < wanted && candidates.length) {
          chosen.push(candidates.splice(Math.floor(nextRandom(state) * candidates.length), 1)[0]);
        }
        withPick(picks, condition.objectType, new Set(chosen.map(entity => entity.id)));
        return chosen.length > 0;
      }
      if (condition.type === 'pickedCount') {
        return compareValues(pickedInstances(state, picks, condition.objectType).length, condition.operator, condition.value);
      }
      if (condition.type === 'cameraActive') {
        const camera = findTarget(condition.entityId);
        return Boolean(camera) && state.viewCamera === camera.id;
      }
      if (condition.type === 'cameraFovCompare') {
        return compareValues(Math.round(viewFov(state) * 1000) / 1000, condition.operator, condition.value);
      }
      if (condition.type === 'entityAngle') {
        const target = findTarget(condition.entityId);
        if (!target) return false;
        const angle = readInstanceProperty(project, state, target, 'angle');
        const normalised = ((angle % 360) + 360) % 360;
        return compareValues(Math.round(normalised * 1000) / 1000, condition.operator, condition.value);
      }
      if (condition.type === 'playerTouchingSurface') {
        return touchingSurfaces(state).some(surface => condition.surface === 'any' || surface.kind === condition.surface);
      }
      if (condition.type === 'playerAirborne') {
        if (!state.physics) return condition.state !== 'airborne';
        return condition.state === 'airborne' ? !state.physics.grounded : state.physics.grounded;
      }
      if (['playerInArea', 'playerEnteredArea', 'playerInZone', 'playerEnteredZone'].includes(condition.type)) {
        // A zone is found by its own id field; the older area conditions name any object. Both
        // end in the same volume test, because a zone is only an object whose whole purpose is
        // its volume — the difference is the picker and the message when it is misconfigured.
        const zone = condition.type.endsWith('Zone');
        if (zone && !condition.zoneId) {
          throw new Error(`Event "${event.name || event.id}" watches a zone but names none; reopen the condition and pick one`);
        }
        const entity = findTarget(zone ? condition.zoneId : condition.entityId);
        const label = zone ? 'zone' : 'interaction area on';
        if (!entity) {
          if (zone) throw new Error(`Event "${event.name || event.id}" is about a zone that no longer exists`);
          return false;
        }
        if (zone && entity.type !== 'zone') {
          throw new Error(`Event "${event.name || event.id}" watches ${entity.name} as a zone, but that object is a ${entity.type}`);
        }
        const volume = areaVolume(entity, sectorAt(state.sectors, entity.x, entity.y)?.floorHeight ?? 0);
        if (!volume) throw new Error(`Event "${event.name || event.id}" tests ${label} ${entity.name}, which has none`);
        const centre = playerCentre(state.player);
        const inside = areaContains(volume, { x: centre[0], y: centre[1], z: centre[2] });
        if (condition.type === 'playerInArea' || condition.type === 'playerInZone') return inside;
        return areaEntered(state.areaEntries ||= new Set(), `${keyOf()}:${index}`, inside);
      }
      if (condition.type === 'playerReachesEntity') {
        const entity = findTarget(condition.entityId);
        return entity && playerReachesEntity(state, entity, condition.distance, condition.height, condition.below,
          // The rule editor stores a yes/no choice, hand-written rules may use a boolean.
          { overSteps: condition.reachOverSteps === true || condition.reachOverSteps === 'yes' });
      }
      if (condition.type === 'enemyAlert') return state.time < (state.timers.get(`${resolveEntityId(event, condition.entityId)}:alert`) || 0);
      if (condition.type === 'enemyHearsPlayer') {
        const entity = findTarget(condition.entityId);
        return entity && canHearPlayer(state, entity);
      }
      if (condition.type === 'spriteState') {
        const target = findTarget(condition.entityId);
        return Boolean(target) && readInstanceProperty(project, state, target, 'animation') === condition.state;
      }
      // A timesheet cue: true only on the frame the timeline's clock crossed it. The cue's
      // own rule carries no other condition, so this is the whole test.
      if (condition.type === TIMESHEET_CUE_CONDITION) return cueDue(state, condition.timesheetId, condition.cueId);
      if (condition.type === 'entityDamaged') {
        const entity = findTarget(condition.entityId);
        // A thing without health can never lose any. Sampling it anyway would store
        // `undefined`, which the save format has to reject as a non-numeric sample.
        if (!entity || !Number.isFinite(entity.health)) return false;
        const key = `${keyOf()}:${index}:${entity.id}`;
        const old = state.entitySamples.get(key) ?? state.entitySamples.get(`${keyOf()}:${entity.id}`) ?? entity.health;
        state.entitySamples.set(key, entity.health);
        return entity.health < old;
      }
      if (condition.type === 'wallActivated') {
        // A use press activates both the nearest wall (for hand-written rules) and the
        // nearest wall with a special (for the generated door, lift and exit rules).
        if (condition.mode === 'use') return state.worldTriggers.use === condition.wallId || state.worldTriggers.useSpecial === condition.wallId;
        if (condition.mode === 'shoot') return (state.gameScreen === 'playing' || state.ambientWorld) && shotTriggers.has(condition.wallId);
        return state.worldTriggers[condition.mode].has(condition.wallId);
      }
      if (condition.type === 'sectorMoving') return state.sectorMotions.has(`${condition.sectorId}:${condition.surface}`);
      if (condition.type === 'sectorDoorOpen') return sectorDoorOpen(project, state, condition.sectorId);
      if (condition.type === 'sectorDoorClosed') return sectorDoorClosed(project, state, condition.sectorId);
      if (condition.type === 'sectorDoorMoving') return sectorDoorMoving(state, condition.sectorId);
      if (condition.type === 'sectorElevatorLowered') return sectorElevatorAt(project, state, condition.sectorId, 'lower');
      if (condition.type === 'sectorElevatorRaised') return sectorElevatorAt(project, state, condition.sectorId, 'upper');
      if (condition.type === 'sectorElevatorMoving') return sectorElevatorMoving(state, condition.sectorId);
      if (condition.type === 'enemySeesPlayer') {
        const entity = findTarget(condition.entityId);
        const alerted = entity && state.time < (state.timers.get(`${entity.id}:alert`) || 0);
        return entity && canSeePlayer(state, entity, condition.range, alerted ? 360 : condition.fov ?? 360);
      }
      if (condition.type === 'projectileState') {
        const projectile = findTarget(condition.entityId);
        const actor = projectile ? projectileActor(project, projectile) : null;
        const index = projectile?.actorState?.index ?? null;
        const label = actor && index !== null ? labelIndex(actor, condition.state) : null;
        return index !== null && label !== null && index === label;
      }
      if (condition.type === 'acsInventory') {
        const count = state.scripts?.host?.checkInventory(String(condition.item ?? ''), 'player') ?? 0;
        return compareValues(count, condition.operator || '=', Number(condition.value) || 0);
      }
      if (condition.type === 'acsVariable') {
        const store = acsVariableStore(state, condition.scope, condition.module);
        return Boolean(store) && compareValues(store[condition.index] | 0, condition.operator || '=', Number(condition.value) || 0);
      }
      if (condition.type === 'sectorTagMoving') {
        return state.sectors.some(sector => sector.tag === condition.tag &&
          (state.sectorMotions.has(`${sector.id}:floorHeight`) || state.sectorMotions.has(`${sector.id}:ceilingHeight`)));
      }
      if (condition.type === 'actorState') {
        const entity = findTarget(condition.entityId);
        return Boolean(entity?.stateLabel) && String(entity.stateLabel).toLowerCase() === String(condition.state).toLowerCase();
      }
      if (condition.type === 'entityActorName') {
        const entity = findTarget(condition.entityId);
        return Boolean(entity?.actorName) && String(entity.actorName).toLowerCase() === String(condition.actor).toLowerCase();
      }
      if (condition.type === 'enemyAttackChance') {
        const entity = findTarget(condition.entityId);
        return entity && enemyAttackChance(state, entity);
      }
      if (condition.type === 'weaponOwned') return state.inventory.weapons.has(condition.weapon);
      if (condition.type === 'weaponSelected') return state.inventory.selectedWeapon === condition.weapon;
      if (condition.type === 'keyOwned') return state.inventory.keys.has(condition.key);
      if (condition.type === 'backpackOwned') return state.inventory.backpack;
      if (condition.type === 'ammoBelowCapacity') return state.playerStats[condition.ammo] < state.playerStats[ammoMaximum(condition.ammo)];
      if (condition.type === 'playerFeedback') return compareValues(playerFeedback(state, condition.signal), condition.operator, condition.value);
      if (condition.type === 'playerFace') return state.face === condition.expression;
      if (condition.type === 'entityDoomType') {
        const entity = findTarget(condition.entityId);
        return entity && (entity.doomType ?? 0) === condition.doomType;
      }
      if (condition.type === 'hudAnimationPlaying') return hud.playing.has(condition.animationId);
      if (condition.type === 'hudClicked') return hud.clicked.has(condition.elementId);
      if (condition.type === 'hudFocused') return hud.focused === condition.elementId;
      if (condition.type === 'levelTransition') return state.levelTransition;
      if (condition.type === 'hudAnimationFinished') return hud.finished.has(condition.animationId);
      if (condition.type === 'hudStatChanged') {
        const key = `${keyOf()}:${condition.stat}:${condition.direction}`;
        statChanges ||= new Map();
        if (!statChanges.has(key)) {
          statChanges.set(key, state.playerStats[condition.stat] - (hud.statSamples.get(key) ?? hud.initialStats[condition.stat]));
          hud.statSamples.set(key, state.playerStats[condition.stat]);
        }
        const delta = statChanges.get(key);
        return condition.direction === 'decreased' ? delta < 0 : condition.direction === 'increased' ? delta > 0 : delta !== 0;
      }
      if (condition.type === 'onStart') return phase === 'interface' ? !state.interfaceStarted : !state.started;
      if (condition.type === 'always') return true;
      if (condition.type === 'keyPressed') return (phase === 'interface' || condition.key === 'Tab' || !hud.cursor) && pressed.has(condition.key);
      if (condition.type === 'keyHeld') return !hud.cursor && keys.has(condition.key);
      if (condition.type === 'mouseMoved') return !hud.cursor && (state.input.mouseX !== 0 || state.input.mouseY !== 0);
      if (condition.type === 'playerStat') return compareValues(state.playerStats[condition.stat], condition.operator, condition.value);
      if (condition.type === 'entityHealth') {
        const target = findTarget(condition.entityId);
        return target && compareValues(target.health ?? 20, condition.operator, condition.value);
      }
      if (condition.type === 'entityHasHealth') return findTarget(condition.entityId)?.health !== undefined;
      if (condition.type === 'entityAlive') {
        const target = findTarget(condition.entityId);
        return Boolean(target) && (target.health ?? 20) > 0;
      }
      if (condition.type === 'distanceBetween') {
        const left = findTarget(condition.entityId);
        const reference = condition.otherId === '$player'
          ? state.entities.find(entity => entity.type === 'player')?.id
          : condition.otherId === '$self' ? event.ownerId : condition.otherId;
        const right = reference ? findTarget(reference) : null;
        const a = left?.type === 'player' ? player : left, b = right?.type === 'player' ? player : right;
        if (a && b) return compareValues(Math.hypot(a.x - b.x, a.y - b.y), condition.operator, condition.distance);
        return false;
      }
      if (condition.type === 'variableCompare') return compare(state.variables[condition.variable], condition.operator, condition.value);
      if (condition.type === 'saveFileExists') return Boolean(state.saveFiles?.has(String(condition.file ?? '').trim()));
      if (condition.type === 'saveFileFailed') return Boolean(state.saveFileError);
      if (condition.type === 'timerReady') return state.time + 1e-9 >= (state.timers.get(`${event.ownerId || '$scene'}:${condition.timer}`) || 0);
      if (condition.type === 'timerExists') return state.timers.has(`${event.ownerId || '$scene'}:${condition.timer}`);
      if (condition.type === 'groupActive') return state.groups.get(condition.groupId);
      if (condition.type === 'playerGrounded') {
        if (!state.physics) throw new Error('Grounded conditions require an initialized Rapier world');
        return state.physics.grounded;
      }
      if (condition.type === 'animationFinished') return state.animationFinished.has(resolveEntityId(event, condition.entityId));
      if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(condition.type)) {
        if (!state.physics) throw new Error('Collision conditions require an initialized Rapier world');
        const set = condition.type === 'collisionStarted' ? state.physics.started : condition.type === 'collisionEnded' ? state.physics.ended : state.physics.contacts;
        return set.has(pairKey(resolveEntityId(event, condition.entityId), resolveEntityId(event, condition.otherId)));
      }
      // A condition an addon declared: its implementation decides. An addon that is installed but
      // not running leaves the rule false rather than throwing, so a project still plays without it.
      const custom = addonHooks(state)?.conditions?.get(condition.type);
      if (custom) return Boolean(runAddon(custom, addonContext({ project, state, event, command: condition, findTarget, player }), condition));
      const entity = findTarget(condition.entityId);
      const position = entity?.type === 'player' ? player : entity;
      return position && Math.hypot(position.x - player.x, position.y - player.y) <= condition.distance;
    }
    // Evaluating the condition list without building it: `eventConditions` allocated a
    // fresh array for every rule on every frame.
    const or = event.conditionMode === 'or';
    let matches = !or;
    const incoming = or ? new Map(picks) : null, branches = [];
    for (let index = 0; index <= (event.conditions?.length || 0); index++) {
      const condition = index === 0 ? event.condition : event.conditions[index - 1];
      // Edge samplers must observe the frame even when another predicate decides the result.
      if (!or && !matches && !['everySeconds', 'playerEnteredArea', 'playerEnteredZone', 'entityDamaged', 'hudStatChanged'].includes(condition.type)) continue;
      if (or) { picks.clear(); for (const [type, ids] of incoming) picks.set(type, ids); }
      const matched = matchOne(condition, index);
      if (or && matched) branches.push(new Map(picks));
      matches = or ? matches || matched : matches && matched;
    }
    if (or && matches) {
      const types = new Set(branches.flatMap(branch => [...branch.keys()]));
      picks.clear();
      for (const type of types) {
        const ids = new Set();
        for (const branch of branches) for (const entity of pickedInstances(state, branch, type)) ids.add(entity.id);
        picks.set(type, ids);
      }
    }
    if (!matches) return;
    if (event.once) state.fired.add(keyOf());
    // A rule that performs one of a decompiled script's own builtins uses the interpreter's
    // host function, so the level changes exactly as it did when the script ran as bytecode.
    const hostFor = action => {
      const host = state.scripts?.host;
      if (!host) throw new Error(`Event "${event.name || event.id}": ${action.type} needs a level with compiled scripts`);
      return host;
    };
    for (const sourceAction of event.actions) {
      const action = PICK_ACTIONS.has(sourceAction.type) ? sourceAction : resolveCommand(sourceAction);
      switch (action.type) {
        case 'emitSignal': emitSignal(state, resolveEntityId(event, action.entityId), action.signal, action.value); break;
        case 'saveGame':
          if (!state.hasGame || state.intermission || state.playerStats.health <= 0) {
            state.saveStatus = 'Start or resume a living game before saving.'; break;
          }
          if (state.saveSlots[action.slot - 1]) {
            state.pendingSaveSlot = action.slot; setGameScreen(state, 'save_confirm');
          } else state.menuRequests.push({ type: 'save', slot: action.slot });
          break;
        case 'confirmSaveGame':
          if (state.pendingSaveSlot && state.hasGame && !state.intermission && state.playerStats.health > 0) {
            state.menuRequests.push({ type: 'save', slot: state.pendingSaveSlot });
            state.pendingSaveSlot = null;
          }
          break;
        case 'loadGame':
          if (!state.saveSlots[action.slot - 1]) { state.saveStatus = 'This save slot is empty.'; break; }
          state.menuRequests.push({ type: 'load', slot: action.slot }); break;
        // Save files. The host owns the storage, and every one of them reports through
        // `saveStatus`/`saveFileError`; a rule can then branch on `saveFileFailed`.
        // Variables travel through the host's store *now*, not as a request handled after the
        // frame: a rule that loads and then reads (or saves) in the same event must see the loaded
        // values, and a save after a load must not store the state the load replaced.
        case 'saveVariables':
          try {
            const values = variableSnapshot(project, state, action.variables);
            const host = state.saveFileHost;
            if (!host?.write) throw new Error('save files are not available in this context');
            const document = saveFileDocument({ kind: 'variables', name: action.file, identity: host.identity || null,
              levelId: project.game?.active ?? null, variables: values });
            host.write(action.file, serializeSaveFile(document));
            state.saveFiles.add(saveFileName(action.file));
            state.saveFileError = '';
            state.saveStatus = `Saved ${Object.keys(values).length} variable(s) to the save file ${action.file}.`;
          } catch (error) { state.saveFileError = error.message; state.saveStatus = `Save failed: ${error.message}`; }
          break;
        case 'loadVariables':
          try {
            const host = state.saveFileHost;
            if (!host?.read) throw new Error('save files are not available in this context');
            const text = host.read(action.file);
            if (text === null || text === undefined) throw new Error(`there is no save file named ${action.file}`);
            const document = parseSaveFile(text);
            if (document.kind !== 'variables') throw new Error(`${action.file} holds a whole game, not variables`);
            if (document.identity && host.identity && document.identity !== host.identity) {
              throw new Error(`${action.file} was saved by a different game`);
            }
            const { applied, skipped } = applyVariableSave(project, state, document);
            state.saveFileError = '';
            state.saveStatus = `Loaded ${applied.length} variable(s) from the save file ${action.file}.` +
              (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '');
          } catch (error) { state.saveFileError = error.message; state.saveStatus = `Load failed: ${error.message}`; }
          break;
        case 'saveGameState':
          if (!state.hasGame || state.intermission || state.playerStats.health <= 0) {
            state.saveStatus = 'Start or resume a living game before saving.'; break;
          }
          // No menu and no confirmation: a checkpoint written by a rule overwrites itself.
          state.menuRequests.push({ type: 'save-file', kind: 'game', file: action.file }); break;
        case 'loadGameState':
          if (!state.saveFiles?.has(String(action.file ?? '').trim())) {
            state.saveStatus = `There is no save file named ${action.file}.`; state.saveFileError = 'missing'; break;
          }
          state.menuRequests.push({ type: 'load-file', kind: 'game', file: action.file }); break;
        case 'setGameScreen': setGameScreen(state, action.screen); break;
        case 'selectGameEpisode':
          if (!project.game?.levels.some(level => level.id === action.levelId)) throw new Error(`Unknown game level ${action.levelId}`);
          state.newGameLevel = action.levelId; break;
        case 'startGame': state.menuRequests.push(state.newGameLevel ? { type: 'start', levelId: state.newGameLevel } : 'start'); break;
        case 'loadGameLevel':
          if (!project.game?.levels.some(level => level.id === action.levelId)) throw new Error(`Unknown game level ${action.levelId}`);
          state.menuRequests.push({ type: 'level', levelId: action.levelId, carryProgress: false }); break;
        case 'finishLevel': beginIntermission(project, state, action.exit === 'secret'); break;
        case 'continueIntermission': continueIntermission(state); break;
        case 'quitGame': state.menuRequests.push('quit'); break;
        case 'requestFullscreen': state.menuRequests.push('fullscreen'); break;
        case 'captureGameBinding': state.bindingKey = action.key; break;
        case 'setGameSetting': changeSetting(state, action.setting, action.value); break;
        case 'adjustGameSetting': changeSetting(state, action.setting, action.amount, true); break;
        case 'toggleGameSetting': changeSetting(state, action.setting, !state.settings[action.setting]); break;
        case 'resetGameSettings': state.settings = gameSettings({ jumping: state.settings.jumping }); state.settingsRevision++; break;
        case 'setShaderEnabled': state.shaderEnabled = action.enabled === 'yes'; break;
        case 'setShaderUniform': state.shaderUniforms.set(action.uniform, action.value); break;
        case 'setPostFxStack': state.postFx.stackEnabled = action.enabled === 'yes'; break;
        case 'setPostFxPass': state.postFx.disabled.set(action.kind, action.enabled !== 'yes'); break;
        case 'setPostFxParam': state.postFx.values.set(`${action.kind}.${action.param}`, action.value); break;
        // ---- Instances: acting on the picked set ------------------------------------------
        // One action, every instance the event picked. This is GDevelop's and Construct's central
        // idea — "Add 1 to Enemy.score" with no loop written — and it is why the picking
        // conditions above exist: they are how you say *which* enemies.
        case 'setPickedVariable':
        case 'addPickedVariable': {
          // Like `pickByVariable`, an instance that does not carry the variable is skipped rather
          // than stopping the game: the editor allows a type-level variable action as long as one
          // instance carries it, so the rest of the picked set must be left alone.
          forPicked(action, (entity, resolved) => {
            if (!Object.hasOwn(entity.variables || {}, resolved.variable)) return;
            assignVariable(entity.variables, resolved.variable, resolved.value, resolved.type === 'addPickedVariable');
          });
          break;
        }
        case 'setPickedPosition': {
          forPicked(action, (entity, resolved) => {
            entity.x = resolved.x;
            entity.y = resolved.y;
            const floor = sectorAt(state.sectors, entity.x, entity.y)?.floorHeight ?? 0;
            entity.z = resolved.z ?? floor + (entity.elevation || 0);
            entity.elevation = entity.z - floor;
            state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
          });
          state.worldRevision++;
          break;
        }
        case 'movePicked': {
          forPicked(action, (entity, resolved) => {
            const floor = sectorAt(state.sectors, entity.x, entity.y)?.floorHeight ?? 0;
            const z = entity.z ?? floor + (entity.elevation || 0);
            entity.x += resolved.dx;
            entity.y += resolved.dy;
            entity.z = z + (resolved.dz ?? 0);
            entity.elevation = entity.z - (sectorAt(state.sectors, entity.x, entity.y)?.floorHeight ?? 0);
            state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
          });
          state.worldRevision++;
          break;
        }
        case 'setPickedAngle': {
          forPicked(action, (entity, resolved) => {
            entity.angle = resolved.angle;
            state.physics?.rotate(entity.id, entity.angle);
          });
          state.worldRevision++;
          break;
        }
        case 'scalePicked': {
          forPicked(action, (entity, resolved) => setVisualScale(entity, resolved.scale));
          state.worldRevision++;
          break;
        }
        case 'setPickedSpriteState': {
          forPicked(action, (entity, resolved) =>
            setSpriteState(project, state, entity, resolved.state, resolved.restart === 'yes'));
          break;
        }
        case 'removePicked': {
          // The picked set is already the answer to "which ones", so it is walked directly; each
          // removal does everything removing one object does, or the renderer and the statistics
          // would keep drawing something that is no longer in the level.
          const doomed = pickedInstances(state, picks, action.objectType);
          if (!doomed.length) break;
          const doomedIds = new Set(doomed.map(entity => entity.id));
          for (const entity of doomed) {
            recordRemovedEntity(state, entity);
            state.physics?.remove(entity.id);
            state.animations.delete(entity.id);
            state.spriteAnimations.delete(entity.id);
            forgetEntity(state, entity.id);
          }
          state.entities = state.entities.filter(entity => !doomedIds.has(entity.id));
          state.worldRevision++;
          break;
        }
        case 'setObjectVariable': case 'addObjectVariable': {
          const entity = findTarget(action.entityId);
          if (entity) assignVariable(entity.variables, action.variable, action.value, action.type === 'addObjectVariable');
          break;
        }
        case 'setSpriteState': {
          const entity = findTarget(action.entityId);
          if (entity) setSpriteState(project, state, entity, action.state, action.restart === 'yes');
          break;
        }
        case 'playWeaponClip': state.weaponAnimations.set(action.weapon, { clipId: action.clipId, start: state.time }); break;
        case 'spawnEntity': {
          const template = project.map.entities.find(entity => entity.id === action.templateId);
          if (!template) throw new Error(`Unknown spawn template ${action.templateId}`);
          state.spawnSequence = (state.spawnSequence || 0) + 1;
          let id = `spawn_${action.templateId}_${state.spawnSequence}`;
          while (state.entities.some(entity => entity.id === id)) id += '_';
          const spawned = structuredClone(template);
          Object.assign(spawned, { id, x: action.x, y: action.y, spawnedFrom: action.templateId,
            variables: { ...(template.variables || {}) } });
          if (action.z !== undefined) spawned.z = action.z;
          spawned.z ??= floorHeightAt(sectorAt(state.sectors, spawned.x, spawned.y), spawned.z) + (spawned.elevation || 0);
          spawned.elevation = spawned.z - floorHeightAt(sectorAt(state.sectors, spawned.x, spawned.y), spawned.z);
          if (action.angle !== undefined) spawned.angle = action.angle;
          if (action.name) spawned.name = action.name.slice(0, 100);
          // A spawned enemy gets the same actor fields its authored copy has, or the save written
          // while it is alive would not load: the runtime shape is checked against the template.
          initialiseActorEntities(project, [spawned]);
          state.entities.push(spawned);
          if (spawned.animation?.autoPlay) state.animations.set(spawned.id,
            { ...spawned.animation, playing: true, revision: 0 });
          // The body the authored copy would have had: a spawned crate is solid, a spawned monster
          // blocks the player. Without this one the player walks through everything it makes.
          state.physics?.add?.(spawned.id);
          // What was just made replaces the pick, so a sub-event can act on it the way GDevelop's
          // "Create object" leaves the new instance picked.
          withPick(picks, spawned.type, new Set([spawned.id]));
          state.worldRevision++;
          break;
        }
        case 'rotateEntityBy': {
          const entity = findTarget(action.entityId);
          if (entity) {
            entity.angle = (Number(entity.angle) || 0) + action.angle;
            if (entity.type === 'player') player.angle += action.angle * Math.PI / 180;
            state.physics?.rotate(entity.id, entity.angle);
          }
          break;
        }
        case 'setEntityTilt': {
          const entity = findTarget(action.entityId);
          if (entity) {
            if (!action.pitch && !action.roll) delete entity.modelTilt;
            else entity.modelTilt = { pitch: action.pitch, roll: action.roll };
          }
          break;
        }
        case 'setPlayerPitch':
          player.pitch = action.pitch * Math.PI / 180;
          break;
        case 'rumbleController':
          // Kept as a request for the frame rather than played here: the runtime has no access to
          // a controller, and the page that does drains this after the step.
          if (state.settings.gamepadEnabled !== false && state.settings.gamepadRumble !== false) {
            state.rumbles.push({ strength: action.strength, seconds: action.seconds });
          }
          break;
        // ---- Cameras ---------------------------------------------------------------------
        case 'createCamera': {
          // A camera made during play is a real object, like a spawned one: it can be found by
          // name in the next rule, follows, glides and is saved with the level.
          const seq = (state.cameraSequence = (state.cameraSequence || 0) + 1);
          let id = `camera_${seq}`;
          while (state.entities.some(entity => entity.id === id)) id += '_';
          const name = String(action.name || `Camera ${seq}`).slice(0, 100);
          const camera = buildCamera({ id, name, x: action.x, y: action.y, z: action.z,
            angle: action.angle, pitch: action.pitch, fov: action.fov });
          state.entities.push(camera);
          withPick(picks, 'camera', new Set([camera.id]));
          state.worldRevision++;
          if (action.activate === 'yes') switchView(state, camera);
          break;
        }
        case 'switchCamera': {
          if (action.camera === PLAYER_VIEW || !action.camera ||
            action.camera === ACTIVE_VIEW && !activeCamera(state)) { switchView(state, null); break; }
          switchView(state, requireCamera(state, action.camera, event));
          break;
        }
        case 'setCameraPosition':
        case 'setCameraAngle':
        case 'setCameraFov': {
          // `$active` names the view actually in use. When that is the player's own eyes there
          // is no camera object to move, so the command addresses the player view instead of
          // naming a camera that is not in the level and stopping the game.
          const view = (action.camera === ACTIVE_VIEW || !action.camera) && !activeCamera(state)
            ? PLAYER_VIEW : action.camera;
          // `$player` is the player's own view: its field of view is the game's setting, which is
          // what a zoom rule means when no camera is filming.
          if (view === PLAYER_VIEW) {
            // The player's view is the game setting, whose own bounds are 50..130; clamping to
            // the camera range here wrote 170 into a setting the loader then refused.
            if (action.type === 'setCameraFov') state.settings.fov = clamp(action.fov, 50, 130);
            else if (action.type === 'setCameraAngle') {
              player.angle = action.angle * Math.PI / 180;
              player.pitch = clamp(action.pitch, -89, 89) * Math.PI / 180;
            } else {
              const target = state.entities.find(entity => entity.type === 'player');
              const floor = floorHeightAt(sectorAt(state.sectors, action.x, action.y), action.z);
              const z = action.z ?? floor + (target.elevation || 0);
              Object.assign(target, { x: action.x, y: action.y, z, elevation: z - floor });
              Object.assign(player, { x: action.x, y: action.y, z });
              resetMomentum(state);
              state.physics?.teleport(target.id, action.x, action.y, z);
            }
            break;
          }
          const camera = requireCamera(state, view, event);
          if (action.type === 'setCameraPosition') {
            camera.x = action.x;
            camera.y = action.y;
            if (action.z !== undefined && action.z !== null) camera.z = action.z;
          } else if (action.type === 'setCameraAngle') {
            camera.angle = action.angle;
            camera.cameraPitch = clamp(action.pitch, -89, 89);
          } else {
            camera.cameraFov = clamp(action.fov, 10, 170);
          }
          state.worldRevision++;
          break;
        }
        case 'moveCamera': {
          if (action.camera === PLAYER_VIEW ||
            (action.camera === ACTIVE_VIEW || !action.camera) && !activeCamera(state)) {
            // The player cannot be scripted to fly; move the view means moving the player.
            break;
          }
          const camera = requireCamera(state, action.camera, event);
          const to = { x: action.x, y: action.y, z: action.z, angle: action.angle, pitch: action.pitch };
          startCameraMove(state, camera, to, { seconds: action.seconds, easing: action.easing });
          state.worldRevision++;
          break;
        }
        case 'followCamera': {
          // There is no camera object to make follow anything while the player view is active.
          if ((action.camera === ACTIVE_VIEW || !action.camera) && !activeCamera(state)) break;
          const camera = requireCamera(state, action.camera, event);
          const target = action.target === PLAYER_VIEW ? PLAYER_VIEW : String(action.target || PLAYER_VIEW);
          if (target !== PLAYER_VIEW && !state.entities.some(entity => entity.id === target || entity.name === target)) {
            throw new Error(`Event "${event.name || event.id}" makes a camera follow "${target}", which is not in this level`);
          }
          camera.cameraFollow = target;
          camera.cameraFollowAngle = action.copyAngle !== 'no';
          break;
        }
        case 'sprayImage': {
          // A spray is a wall decal: it lives in the impact list so saves keep it and
          // the renderer draws it flat on the wall instead of as a billboard. An
          // unconfigured spray must never stop the game: it explains itself once and
          // does nothing until the event names an image asset.
          const asset = project.assets.find(item => item.id === action.assetId);
          if (!asset) {
            state.message = action.assetId
              ? `Spray image ${action.assetId} is not in this project's asset library.`
              : 'Choose an image asset in the spray event.';
            state.messageTime = 3;
            break;
          }
          const target = sprayTarget(state, action.distance);
          if (!target) break;
          const size = action.size > 0 ? action.size : 40;
          const height = size * (asset.height || 1) / (asset.width || 1);
          // Clip to the wall face so the artwork cannot spill past the wall into the
          // room: only the part of the decal that is on the wall is kept, cropped.
          const face = clipDecalToFace(target, { width: size, height });
          if (!face) break;
          const decal = { id: `decal_${state.decalCounter++}`, x: target.x, y: target.y, z: target.z,
            clipId: '', start: state.time,
            decal: { assetId: asset.id, corners: face.corners, uv: face.uv } };
          if (action.duration > 0) decal.until = state.time + action.duration;
          state.impacts.push(decal);
          // Oldest sprays fade out first so a long session cannot grow without bound.
          const decals = state.impacts.filter(effect => effect.decal);
          if (decals.length > 64) state.impacts.splice(state.impacts.indexOf(decals[0]), 1);
          break;
        }
        case 'setEntityScale': {
          const entity = findTarget(action.entityId);
          if (entity) setVisualScale(entity, action.scale);
          break;
        }
        case 'setGravityScale':
          state.physics?.gravityScale(resolveEntityId(event, action.entityId), action.scale); break;
        case 'setDamping':
          state.physics?.damping(resolveEntityId(event, action.entityId), action.damping); break;
        case 'moveSector': {
          const sector = state.sectors.find(sector => sector.id === action.sectorId), door = sector?.door;
          const authoredDoor = door?.activation === 'event-only' && !hasWallActivationParent();
          const authoredElevator = sector?.elevator?.activation === 'event-only' && !hasWallActivationParent();
          moveSector(state, action, { authoredDoor, authoredElevator });
          break;
        }
        case 'raiseSectorElevator': operateSectorElevator(project, state, action.sectorId, 'raise'); break;
        case 'lowerSectorElevator': operateSectorElevator(project, state, action.sectorId, 'lower'); break;
        case 'toggleSectorElevator': operateSectorElevator(project, state, action.sectorId, 'toggle'); break;
        case 'openSectorDoor': operateSectorDoor(project, state, action.sectorId, 'open'); break;
        case 'closeSectorDoor': operateSectorDoor(project, state, action.sectorId, 'close'); break;
        case 'toggleSectorDoor': operateSectorDoor(project, state, action.sectorId, 'toggle'); break;
        case 'setWeaponOwned': {
          if (action.owned === 'yes') {
            if (!state.inventory.weapons.has(action.weapon)) state.feedback.weaponPickupTime = state.time;
            state.inventory.weapons.add(action.weapon);
          } else {
            if (action.weapon === state.inventory.selectedWeapon) throw new Error('Select another owned weapon before removing the current weapon');
            state.inventory.weapons.delete(action.weapon);
          }
          break;
        }
        case 'selectWeapon':
          if (!state.inventory.weapons.has(action.weapon)) throw new Error(`Cannot select unowned weapon: ${action.weapon}`);
          state.inventory.selectedWeapon = action.weapon; break;
        // Runs the imported weapon's own state, for its sounds and its flash. The damage,
        // ammo and rate a translated rule writes live in the rule itself.
        case 'weaponAnimation':
          if (action.weapon === state.inventory.selectedWeapon) playWeaponState(project, state, action.state);
          break;
        // Holds the imported weapon's trigger for this frame. The weapon's own states still
        // decide the rate and everything else; a rule decides *when* the trigger is down, and
        // a weapon with such a rule stops reading the mouse (see `stepWeapon`).
        case 'weaponTrigger':
          if (action.weapon === state.inventory.selectedWeapon) {
            if (action.trigger === 'alt') state.weaponAltRequest = true; else state.weaponTriggerRequest = true;
          }
          break;
        case 'setKeyOwned':
          if (action.owned === 'yes') state.inventory.keys.add(action.key); else state.inventory.keys.delete(action.key);
          break;
        case 'addAmmo': addAmmo(state, action.ammo, action.amount > 0 && [1, 5].includes(state.settings.difficulty) ? action.amount * 2 : action.amount); break;
        case 'giveBackpack':
          if (!state.inventory.backpack) {
            for (const ammo of ['bullets', 'shells', 'rockets', 'cells']) state.playerStats[ammoMaximum(ammo)] *= 2;
            state.inventory.backpack = true;
          }
          break;
        case 'setPlayerFace': state.face = action.expression; break;
        case 'setGroupActive': state.groups.set(action.groupId, action.active === 'yes'); break;
        case 'movePlayer': state.input.forward += action.forward; state.input.strafe += action.strafe; break;
        // Recorded rather than applied: the player turns on the tic clock, where a held
        // turn can ramp the way Doom's does (`shared/player-motion.js`).
        case 'turnPlayer': state.turnRequest = (state.turnRequest || 0) + action.speed; break;
        case 'mouseLook':
          player.angle += state.input.mouseX * action.sensitivity;
          if (action.vertical === 'enabled') player.pitch = Math.max(-85 * Math.PI / 180, Math.min(85 * Math.PI / 180, player.pitch - state.input.mouseY * action.sensitivity));
          break;
        case 'jumpPlayer':
          state.input.jump = true; break;
        case 'setMotionModel':
          // Switching a project's movement model. Doom's momentum is kept as it is, so a
          // switch back mid-game does not teleport the player, and the Source velocity starts
          // from however fast the player was already going.
          if (action.model === 'source') {
            state.motionModel = 'source';
            state.motionSettings = { ...state.motionSettings, ...Object.fromEntries(Object.entries(action)
              .filter(([key]) => ['gravity', 'jumpSpeed', 'maxSpeed', 'accelerate', 'airAccelerate', 'friction',
                'stopSpeed', 'airSpeedCap'].includes(key))) };
            state.motion = { x: (state.momentum?.x || 0) * 35, y: (state.momentum?.y || 0) * 35, z: 0 };
          } else {
            state.motionModel = 'doom';
            state.momentum = { x: (state.motion?.x || 0) / 35, y: (state.motion?.y || 0) / 35, z: 0 };
          }
          break;
        case 'setPlayerGravity':
          setPlayerGravity(state, action.mode, action.reach); break;
        case 'setPlayerStat':
          if (action.stat === 'health') recordDamage(state, state.playerStats.health - action.value);
          state.playerStats[action.stat] = action.value; break;
        case 'addPlayerStat': {
          const value = Math.max(0, Math.min(action.maximum, state.playerStats[action.stat] + action.value));
          if (action.stat === 'health') recordDamage(state, state.playerStats.health - value);
          state.playerStats[action.stat] = value; break;
        }
        case 'damagePlayer': damagePlayer(state, action.damage, action.direction); break;
        case 'playSound': soundEvent(state, action.sound, action.volume, event.ownerId ? findTarget(event.ownerId) : undefined); break;
        case 'playAssetSound': {
          // The audio player looks sounds up by name, and decodes whatever the browser can —
          // MP3, Ogg Vorbis, Opus, FLAC and WAV all arrive here as one asset kind.
          const asset = (project.assets || []).find(item => item.id === action.assetId);
          if (asset?.src) soundEvent(state, asset.name, action.volume);
          break;
        }
        case 'startTimesheet': {
          const loop = action.loop === 'yes' ? true : action.loop === 'no' ? false : null;
          startTimesheetRun(project, state, action.timesheetId, { restart: action.restart !== 'no', loop });
          break;
        }
        case 'stopTimesheet':
          stopTimesheetRun(state, action.all === 'yes' ? 'all' : action.timesheetId);
          break;
        case 'setTimesheetPaused':
          setTimesheetPaused(state, action.timesheetId, action.paused === 'yes');
          break;
        case 'followPath': {
          const path = (project.paths || []).find(item => item.id === action.pathId);
          const target = findTarget(action.entityId);
          // A cue that names a route which has been deleted leaves the object alone rather than
          // moving it to the origin, the same rule the path followers follow.
          if (path && target && target.type !== 'player')
            startPathTween(state, { entityId: target.id, pathId: path.id, fromPoint: action.fromPoint,
              toPoint: action.toPoint, seconds: action.seconds, easing: action.easing,
              faceDirection: action.faceDirection !== 'no', yawOffset: action.yawOffset,
              useModelFacing: action.useModelFacing !== 'no' });
          break;
        }
        case 'facePlayer': {
          const entity = findTarget(action.entityId);
          if (entity) entity.angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x) * 180 / Math.PI;
          break;
        }
        // A line's special, executed from a rule: the same table the engine uses when a
        // UDMF line activates natively, so the two cannot drift.
        case 'runLineSpecial':
          if (!state.worldTerminalActive) {
            executeSpecial(project, state, action.special,
              [action.arg1, action.arg2, action.arg3, action.arg4, action.arg5], { scripts: state.scripts, format: 'zdoom' });
          }
          break;
        // A decompiled script's own builtins — `ChangeFloor(tag, "HEX01")`, `SetLineSpecial`,
        // `SetLineBlocking` — run through the interpreter's host functions, so the rule and a
        // script that was not decompiled change the level the same way.
        case 'showHudMessage':
          hostFor(action).hudMessage({ text: String(action.text ?? ''), type: Number(action.messageType) || 0,
            id: Number.isFinite(action.id) ? action.id : -1, color: Number(action.color) || 0,
            x: Number(action.x) || 0, y: Number(action.y) || 0, holdTime: Number(action.holdTime) || 0,
            fade: Number(action.fade) || 0, width: Number(action.hudWidth) || 0,
            height: Number(action.hudHeight) || 0, font: action.font || null });
          break;
        case 'fadeRange':
          hostFor(action).fadeRange({
            from: { red: Number(action.redFrom) || 0, green: Number(action.greenFrom) || 0,
              blue: Number(action.blueFrom) || 0, amount: Number(action.amountFrom) || 0 },
            to: { red: Number(action.red) || 0, green: Number(action.green) || 0,
              blue: Number(action.blue) || 0, amount: Number(action.amount) || 0 },
            seconds: Number(action.seconds) || 0 });
          break;
        case 'fadeTo':
          hostFor(action).fadeTo({ red: Number(action.red) || 0, green: Number(action.green) || 0,
            blue: Number(action.blue) || 0, amount: Number(action.amount) || 0,
            seconds: Number(action.seconds) || 0 });
          break;
        case 'setActorPosition':
          hostFor(action).setActorPosition(Number(action.tid) || 0, Number(action.x) || 0,
            Number(action.y) || 0, Number(action.z) || 0, Number(action.fog) || 0, 'player');
          break;
        case 'giveInventory':
          hostFor(action).giveInventory(String(action.item ?? ''), Number(action.amount) || 0, 'player');
          break;
        case 'takeInventory':
          hostFor(action).takeInventory(String(action.item ?? ''), Number(action.amount) || 0, 'player');
          break;
        case 'damageThing':
          hostFor(action).damageThing(Number(action.tid) || 0, Number(action.amount) || 0,
            String(action.kind ?? ''), 'player');
          break;
        case 'sectorDamage':
          hostFor(action).sectorDamage(Number(action.tag) || 0, Number(action.amount) || 0,
            String(action.kind ?? ''), String(action.protection ?? ''), 0);
          break;
        case 'setSectorFlat': {
          hostFor(action).changeFlat(Number(action.tag) || 0, String(action.flat ?? ''), action.surface === 'ceiling');
          break;
        }
        case 'setLineTexture': {
          hostFor(action).setLineTexture(Number(action.line) || 0, Number(action.side) || 0,
            Number(action.part) || 0, String(action.texture ?? ''));
          break;
        }
        case 'setLineBlocking': {
          hostFor(action).setLineBlocking(Number(action.tag) || 0, action.blocking === 'no' ? 0 : 1);
          break;
        }
        case 'setLineMonsterBlocking': {
          hostFor(action).setLineMonsterBlocking(Number(action.tag) || 0, action.monsters === 'yes');
          break;
        }
        case 'setLineSpecial': {
          hostFor(action).setLineSpecial(Number(action.tag) || 0, Number(action.special) || 0,
            [action.arg1 ?? 0, action.arg2 ?? 0, action.arg3 ?? 0, action.arg4 ?? 0, action.arg5 ?? 0]);
          break;
        }
        // Starts a compiled ACS script from a rule — the trigger is in the sheet, the body
        // is the module the WAD shipped, shown disassembled in the Scripts tab.
        case 'runScript': {
          const selector = /^-?\d+$/.test(String(action.script)) ? Number(action.script) : String(action.script);
          state.scripts?.execute(selector, [action.arg1 ?? 0, action.arg2 ?? 0, action.arg3 ?? 0, action.arg4 ?? 0]);
          break;
        }
        case 'setEntitySolid': {
          const entity = findTarget(action.entityId);
          if (entity) { entity.solid = action.solid === 'yes'; if (!entity.solid) state.physics?.remove(entity.id); }
          break;
        }
        case 'homeMissile': {
          const missile = findTarget(action.entityId);
          if (missile) homeMissile(project, state, missile, { turn: action.turn });
          break;
        }
        case 'bfgSpray': {
          const source = findTarget(action.entityId);
          if (source) bfgSpray(project, state, source, action);
          break;
        }
        // The blast a missile's Death state would perform, as an action a rule can take.
        case 'explodeArea': {
          const entity = findTarget(action.entityId);
          if (entity) explodeAt(project, state, entity, action.damage, action.radius);
          break;
        }
        // Runs an imported actor's own state, which is where its frames, sounds and its
        // attack function live — a translated monster's rule says *when*, the state says how.
        case 'playActorState': {
          const entity = findTarget(action.entityId);
          if (entity && entity.health > 0) setActorState(project, entity, action.state, { ifDifferent: true });
          break;
        }
        case 'moveEnemy': {
          const entity = findTarget(action.entityId);
          if (entity) moveEnemy(state, entity, action.speed, dt);
          break;
        }
        case 'enemyHitscan': {
          const entity = findTarget(action.entityId);
          if (entity) enemyHitscan(state, entity, action);
          break;
        }
        case 'launchProjectile':
          // An `missile` names an imported actor class, so a translated weapon fires the
          // mod's own projectile — flight clip, explosion and all — instead of a lookalike.
          if (!state.worldTerminalActive) launchProjectile(state, missileShot(project, action));
          break;
        case 'enemyProjectile': {
          const entity = findTarget(action.entityId);
          if (entity && entity.health > 0 && canSeePlayer(state, entity, 65536)) launchProjectile(state, action, entity);
          break;
        }
        case 'setEntityHealth': {
          const target = findTarget(action.entityId);
          if (target) target.health = action.health;
          break;
        }
        case 'hitscan':
          if (!state.worldTerminalActive) {
            fireHitscan(project, state, action);
            // A weapon whose own states play a hit sound (the chainsaw) keeps it.
            if (action.hitSound && state.lastShot?.hits.length) saySound(state, action.hitSound, null, 127);
          }
          break;
        case 'startTimer': state.timers.set(`${event.ownerId || '$scene'}:${action.timer}`, state.time + action.seconds); break;
        case 'clearTimer': state.timers.delete(`${event.ownerId || '$scene'}:${action.timer}`); break;
        case 'showPlayerHUD': state.hud = action.visible === 'yes'; break;
        case 'setHUDCursor': hud.cursor = action.mode === 'toggle' ? !hud.cursor : action.mode === 'cursor'; break;
        case 'setHUDVisible': hud.elements.get(action.elementId).visible = action.visible === 'yes'; break;
        case 'setHUDText': Object.assign(hud.elements.get(action.elementId), { text: action.text, binding: '' }); break;
        case 'setHUDBinding': hud.elements.get(action.elementId).binding = action.binding; break;
        case 'setHUDProperty': hud.elements.get(action.elementId)[action.property] = action.value; break;
        case 'playHUDAnimation': playHUDAnimation(project, hud, action.animationId); break;
        case 'stopHUDAnimation': hud.playing.delete(action.animationId); break;
        case 'showMessage': state.message = action.message; state.messageTime = 6; break;
        case 'setVariable': assignVariable(state.variables, action.variable, action.value, false); break;
        case 'addVariable': assignVariable(state.variables, action.variable, action.value, true); break;
        case 'setAcsVariable': {
          // The store a decompiled script writes is the interpreter's own, so the rest of the
          // level sees the change exactly as it did when the script ran as bytecode.
          const store = acsVariableStore(state, action.scope, action.module);
          if (!store) throw new Error(`Event "${event.name || event.id}": the level has no ACS variables`);
          const index = Number(action.index) || 0;
          const value = Number(action.value) || 0;
          store[index] = (action.mode === 'add' ? (store[index] | 0) + value : value) | 0;
          break;
        }
        case 'teleport':
          player.x = action.x; player.y = action.y;
          if (!state.physics) {
            const entity = state.entities.find(item => item.type === 'player');
            const floor = sectorAt(state.sectors, action.x, action.y)?.floorHeight ?? 0;
            const z = action.z ?? floor + (entity.elevation || 0);
            Object.assign(entity, { x: action.x, y: action.y, z, elevation: z - floor });
            player.z = z;
          }
          // Doom drops the player's momentum when it teleports them.
          resetMomentum(state);
          if (action.angle !== undefined) player.angle = action.angle * Math.PI / 180;
          state.physics?.teleport(state.entities.find(entity => entity.type === 'player').id, action.x, action.y, action.z);
          break;
        case 'removeEntity': {
          const id = resolveEntityId(event, action.entityId);
          recordRemovedEntity(state, state.entities.find(item => item.id === id));
          state.physics?.remove(id); state.animations.delete(id);
          state.spriteAnimations.delete(id);
          forgetEntity(state, id);
          state.entities = state.entities.filter(item => item.id !== id);
          break;
        }
        case 'setEntityPosition': {
          const target = findTarget(action.entityId);
          if (target) {
            target.x = action.x; target.y = action.y;
            if (target.type === 'player') {
              player.x = action.x; player.y = action.y;
              if (!state.physics) {
                const floor = sectorAt(state.sectors, action.x, action.y)?.floorHeight ?? 0;
                player.z = target.z = action.z ?? floor + (target.elevation || 0);
                target.elevation = target.z - floor;
              }
            }
            if (action.z !== undefined) target.z = action.z;
            const floor = floorHeightAt(sectorAt(state.sectors, target.x, target.y), target.z);
            if (!state.physics) {
              target.z = action.z ?? floor + (target.elevation || 0);
              if (target.type === 'player') player.z = target.z;
            }
            target.elevation = (target.z ?? floor) - floor;
            state.physics?.teleport(target.id, action.x, action.y, action.z);
          }
          break;
        }
        case 'rotateEntity': {
          const target = findTarget(action.entityId);
          if (target) {
            target.angle = action.angle;
            if (target.type === 'player') player.angle = action.angle * Math.PI / 180;
            state.physics?.rotate(target.id, action.angle);
          }
          break;
        }
        case 'applyImpulse': case 'applyForce': case 'setVelocity': {
          const target = findTarget(action.entityId);
          if (!target) break;
          if (!state.physics) throw new Error('Physics actions require an initialized Rapier world');
          const method = action.type === 'applyImpulse' ? 'impulse' : action.type === 'applyForce' ? 'force' : 'velocity';
          state.physics[method](target.id, action);
          break;
        }
        case 'playAnimation':
          if (findTarget(action.entityId)) {
            const id = resolveEntityId(event, action.entityId);
            state.animations.set(id, { clip: action.clip, speed: action.speed, loop: action.loop, playing: true, revision: (state.animations.get(id)?.revision || 0) + 1 });
          }
          break;
        case 'stopAnimation': {
          const animation = state.animations.get(resolveEntityId(event, action.entityId));
          if (animation) { animation.playing = false; animation.revision++; }
          break;
        }
        default: {
          // An action an addon declared: its implementation does whatever it does, with the game
          // state in hand. Anything else unknown stays the no-op it always was.
          const custom = addonHooks(state)?.actions?.get(action.type);
          if (custom) runAddon(custom, addonContext({ project, state, event, command: action, findTarget, player }), action);
          break;
        }
      }
      if (phase !== 'interface' && state.gameScreen !== 'playing') return true;
    }
    return true;
  }
}

/**
 * Drives the imported weapon state machine. Weapons keep their own tic clock so
 * a mod's fire rates stay exact even when a frame renders faster than 35 Hz.
 *
 * The trigger is one bit the frame owns. A rule that holds it (`weaponTrigger`) takes
 * the weapon over: the mouse stops reaching this machine, so a translated weapon is
 * fired by its event rules and by nothing else. A weapon with no such rule still reads
 * the mouse, which keeps every project that has never been translated behaving as before.
 */
function stepWeapon(project, state, dt, held, altHeld) {
  const slot = state.inventory.selectedWeapon;
  if (!state.weaponActor || state.weaponSlot !== slot) {
    if (!beginWeapon(project, state, slot)) { state.weaponTriggerHeld = false; state.weaponAltHeld = false; return; }
  }
  const driven = weaponDrivenByEvents(state, state.weaponActor?.actor);
  // A weapon whose firing is an event rule stops reading both the mouse and the trigger
  // actions: its pictures and sounds still run, but the shot itself belongs to the rule.
  // Otherwise either the mouse or a `weaponTrigger` action holds it for the frame.
  state.weaponTriggerHeld = driven ? false : held || state.weaponTriggerRequest === true;
  state.weaponAltHeld = driven ? false : altHeld || state.weaponAltRequest === true;
  state.weaponClock = (state.weaponClock || 0) + dt * 35;
  const whole = Math.floor(state.weaponClock + 1e-6);
  const tics = Math.min(4, whole);
  state.weaponClock -= whole;
  // Refiring is the states' own decision (`A_ReFire` restarts Fire while the
  // trigger is held; a weapon without it fires once per press, as in Doom). An
  // external "trigger held and ready means Fire" shortcut re-entered Fire every
  // tic or two and burned the whole clip in under a second.
  for (let tic = 0; tic < tics; tic++) {
    weaponTic(project, state, held || altHeld, { presentation: driven });
  }
}

/** Whether event rules hold this weapon's trigger; anything else is the mouse's job. */
function weaponDrivenByEvents(state, actor) {
  const name = actor?.name;
  return Boolean(name) && Array.isArray(state.weaponEventActors) &&
    state.weaponEventActors.includes(String(name).toLowerCase());
}

/** Converts a weapon state's action into the existing hit-scan/projectile path. */
/** Maps the runtime's key set onto Doom's button bits, which ACS can query. */
export function buttonsFor(keys) {
  const held = name => keys.has(name);
  let mask = 0;
  if (held('Mouse0')) mask |= BT.ATTACK;
  if (held('Mouse2')) mask |= BT.ALTATTACK;
  if (held('KeyE')) mask |= BT.USE;
  if (held('Space')) mask |= BT.JUMP;
  if (held('ControlLeft') || held('KeyC')) mask |= BT.CROUCH;
  if (held('KeyR')) mask |= BT.RELOAD;
  if (held('ShiftLeft') || held('ShiftRight')) mask |= BT.SPEED;
  if (held('KeyW')) mask |= BT.FORWARD;
  if (held('KeyS')) mask |= BT.BACK;
  if (held('KeyA')) mask |= BT.MOVELEFT;
  if (held('KeyD')) mask |= BT.MOVERIGHT;
  if (held('ArrowLeft')) mask |= BT.TURNLEFT === undefined ? BT.LEFT : BT.TURNLEFT;
  if (held('ArrowRight')) mask |= BT.TURNRIGHT === undefined ? BT.RIGHT : BT.TURNRIGHT;
  if (held('ArrowUp')) mask |= BT.LOOKUP;
  if (held('ArrowDown')) mask |= BT.LOOKDOWN;
  return mask;
}

/** A sector's `damage` (Sector_SetDamage) hurts whatever stands in it, once a second. */
function applySectorDamage(state, dt) {
  if (!state.sectors.some(sector => sector.damage)) { state.damageAcc = 0; return; }
  state.damageAcc = (state.damageAcc || 0) + dt;
  if (state.damageAcc < 1) return;
  state.damageAcc -= 1;
  const sector = sectorAt(state.sectors, state.player.x, state.player.y);
  if (!sector?.damage) return;
  state.playerStats.health = Math.max(0, state.playerStats.health - sector.damage);
  state.feedback.health = state.playerStats.health;
  state.feedback.damage = { amount: sector.damage, time: state.time };
}

function activateWallTriggers(state) {
  if (state.worldTriggers.shoot.size) {
    for (const id of state.worldTriggers.shoot) state.scripts?.activate(state.walls.find(wall => wall.id === id), 'shoot');
  }
  if (state.scripts?.errors?.length) {
    const latest = state.scripts.errors[state.scripts.errors.length - 1];
    if (latest !== state.scriptWarning) { state.scriptWarning = latest; state.message = latest; state.messageTime = 5; }
  }
}

/**
 * A `launchProjectile` action, with an imported actor class when the rule names one.
 *
 * The class is what a mod's weapon already fired through its `A_FireCustomMissile`; a
 * translated rule names the same class, so the projectile keeps its flight clip, its
 * Death state and its explosion instead of becoming a plain ball with the same numbers.
 */
function missileShot(project, action) {
  if (!action.missile) return action;
  const missile = missileProjectile(project, action.missile);
  if (!missile) return action;
  return { ...action,
    speed: action.speed || missile.speed, damage: Number.isFinite(action.damage) ? action.damage : missile.damage,
    actorId: missile.actorId, actorName: missile.name, damageType: missile.damageType || null,
    // A clip the rule already carries (the sheet fills projectile clips when the art is
    // imported) wins over nothing: the actor's own clip is only a fallback.
    clipId: action.clipId || missile.clipId || null,
    impactClipId: action.impactClipId || missile.impactClipId || null,
    angleOffset: action.angleOffset ?? action.angle ?? 0, spawnOffset: action.spawnOffset ?? action.spawnofs ?? 0,
    spawnHeight: action.spawnHeight ?? action.spawnheight ?? 0, pitchOffset: action.pitchOffset ?? action.pitch ?? 0,
    seeker: action.seeker === undefined ? missile.seeker === true : action.seeker };
}

function applyWeaponAttack(project, state) {
  const attack = state.weaponAttack;
  if (!attack) return;
  state.weaponAttack = null;
  if (state.worldTerminalActive) return;
  if (attack.kind === 'hitscan') {
    fireHitscan(project, state, { damage: attack.damage[0], diceSides: attack.damage[1], pellets: attack.pellets,
      spread: attack.spread, range: attack.range });
    if (attack.hitSound && state.lastShot?.hits.length)
      saySound(state, attack.hitSound, null, 127);
    return;
  }
  // A missile's flight, explosion and trail all come from the actor definition, so
  // a mod's custom projectile behaves and looks like the mod wrote it.
  const missile = attack.missile ? missileProjectile(project, attack.missile) : null;
  if (!missile && attack.missile) {
    // A_FireCustomMissile named a class this project does not contain: report it
    // rather than launching a placeholder the mod never asked for.
    state.missileGaps ||= new Set();
    if (state.missileGaps.size < 40) state.missileGaps.add(attack.missile);
    return;
  }
  launchProjectile(state, { speed: attack.speed, damage: attack.damage, diceSides: attack.diceSides,
    radius: attack.radius, color: '#66bbff', sound: null,
    clipId: missile?.clipId || null, impactClipId: missile?.impactClipId || null,
    actorId: missile?.actorId || attack.actorId || null, actorName: missile?.name || attack.missile || null,
    damageType: missile?.damageType || null,
    angleOffset: attack.angle || 0, spawnOffset: attack.spawnofs || 0, spawnHeight: attack.spawnheight || 0,
    pitchOffset: attack.pitch || 0, seeker: attack.seeker === true });
}

/**
 * Leaves the mark a bullet makes on the wall it hits.
 *
 * Doom's bullet puff is a sprite that flashes and vanishes; GZDoom keeps a chip on the wall
 * afterwards. This reuses the spray decal — the same clipped quad against the wall face — with
 * a built-in texture, so it needs no artwork from the project.
 */
function addBulletMark(state, eye, direction, distance) {
  const target = decalTarget(state, eye, direction, distance + 1);
  if (!target) return;
  const face = clipDecalToFace(target, { width: BULLET_MARK.width, height: BULLET_MARK.width });
  if (!face) return;
  state.impacts.push({ id: `bullet_${state.decalCounter++}`, x: target.x, y: target.y, z: target.z,
    clipId: '', start: state.time,
    decal: { assetId: BULLET_MARK.assetId, corners: face.corners, uv: face.uv } });
  const marks = state.impacts.filter(effect => effect.decal && effect.decal.assetId === BULLET_MARK.assetId);
  if (marks.length > BULLET_MARK.limit) state.impacts.splice(state.impacts.indexOf(marks[0]), 1);
}

function fireHitscan(project, state, action) {
  const player = state.player;
  // The shot leaves the eye along the view direction, so it still lines up with the
  // crosshair after gravity has been turned onto a wall.
  const eye = eyePosition(player, player.z ?? sectorAt(state.sectors, player.x, player.y)?.floorHeight ?? 0);
  const random = () => nextRandom(state);
  state.lastShot = { time: state.time, hits: [] };
  for (let pellet = 0; pellet < action.pellets; pellet++) {
    const angle = player.angle + (action.spread ? (random() - .5) * action.spread * Math.PI / 180 : 0);
    const spread = viewDirection(player, angle);
    const dx = spread[0], dy = spread[1], dz = spread[2];
    let nearest = geometryDistance(state, { x: eye[0], y: eye[1], z: eye[2] }, { x: dx, y: dy, z: dz }, action.range);
    const wallHit = { x: eye[0] + dx * (nearest + .01), y: eye[1] + dy * (nearest + .01) };
    const shotWalls = crossedWalls({ ...state, player: wallHit }, player);
    let target = null;
    for (const entity of state.entities) {
      if (entity.type !== 'enemy' || (entity.health ?? 20) <= 0) continue;
      const distance = entityDistance(state, { x: eye[0], y: eye[1], z: eye[2] }, { x: dx, y: dy, z: dz }, entity, nearest);
      if (distance !== null) { nearest = distance; target = entity; }
    }
    const damage = action.damage * (1 + Math.floor(random() * action.diceSides));
    if (!target) {
      for (const id of shotWalls) state.worldTriggers.shoot.add(id);
      // A shot that hits nothing has hit the wall behind it, and GZDoom leaves a mark there.
      addBulletMark(state, eye, [dx, dy, dz], nearest);
    }
    if (target) {
      hurtActor(project, state, target, damage, state.player);
      state.lastShot.hits.push({ id: target.id, damage });
    }
  }
  if (action.range > 64 || state.lastShot.hits.length) state.playerNoise = { time: state.time, x: player.x, y: player.y };
}
