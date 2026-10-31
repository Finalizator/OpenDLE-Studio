import { resolveEntityId } from './project.js';
import { entitySector, sectorAt, sectorGeometry } from './sectors.js';
import { pairKey } from './physics.js';
import { compareValues, engineCommand } from './engine-script.js';
import { isExpression, evaluateExpression, expressionContext, scalar } from './expressions.js';
import { createHUDState, advanceHUD, playHUDAnimation, validateHUDProperty } from './hud.js';
import { TIC_RATE, stepActors, stepThingGravity, stepProjectiles, runProjectileDeath, beginWeapon, weaponTic,
  initialiseActorEntities, installActorProjectileSprites, missileProjectile, saySound, hurtActor } from './actor-runtime.js';
import { SLOW_TURN_RATIO, SLOW_TURN_TICS, TURN_SPEED, advanceMomentum, bamPerDegreePerSecond, bobFor,
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
import { decalTarget, sprayTarget, clipDecalToFace } from './spray.js';
import { createMapScripts, expireHudMessages } from './map-scripts.js';
import { tickMorphs } from './morph.js';
import { BT } from './acs.js';
import { clipFrame, setSpriteState } from './sprite-animation.js';
import { gameSettings, changeSetting, setGameScreen } from './game-settings.js';
import { createLevelStatistics, updateLevelStatistics, recordRemovedEntity, beginIntermission, continueIntermission } from './intermission.js';

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
  return structuredClone(project.map.entities).filter(entity => !entity.skillMask || (entity.skillMask & skillBit))
    .map(entity => ({ ...entity, variables: { ...(entity.variables || {}) } }));
}

export function createRuntime(project, { settings = {}, screen = 'playing', gameMode = false, progress } = {}) {
  // Missile artwork has to exist before the renderer builds its sprite index.
  installActorProjectileSprites(project);
  const spawn = project.map.entities.find(entity => entity.type === 'player');
  const userSettings = gameSettings(settings);
  const skillBit = skillBitFor(settings);
  const inventory = progress ? structuredClone(progress.inventory) : initialInventory();
  if (progress) inventory.keys.clear();
  const playerStats = progress ? structuredClone(progress.playerStats) : initialPlayerStats();
  const entities = initialiseActorEntities(project, runtimeEntities(project, settings));
  const state = {
    settings: userSettings, settingsRevision: 0, gameScreen: screen, gameMode,
    hasGame: screen === 'playing', bindingKey: null,
    menuRequests: [], interfaceStarted: false,
    saveSlots: Array(6).fill(''), saveStatus: '', pendingSaveSlot: null,
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
    hudState: createHUDState(project),
    randomSeed: 1,
    sounds: [],
    soundOverflow: 0,
    projectiles: [],
    projectileSequence: 0,
    worldRevision: 0,
    shaderEnabled: true,
    shaderUniforms: new Map(Object.entries(project.shaders?.find(shader => shader.id === project.environment.shaderId)?.uniforms || {})),
    sectorMotions: new Map(),
    spriteAnimations: new Map(),
    weaponAnimations: new Map(),
    entitySamples: new Map(),
    enemyMoves: new Map(),
    impacts: [],
    decalCounter: 0,
    worldTriggers: { use: null, useSpecial: null, cross: new Set(), shoot: new Set() },
    // A ChangeCamera special points the view at a camera actor; null is the player's eyes.
    viewCamera: null,
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
    sectors: sectorGeometry(project),
    animations: new Map(project.map.entities.filter(entity => entity.animation?.autoPlay).map(entity => [entity.id, { ...entity.animation, playing: true, revision: 0 }])),
    animationFinished: new Set(),
    physics: null,
    scripts: null,
  };
  state.scripts = createMapScripts(project, state, {
    finishLevel: exit => beginIntermission(project, state, exit === 'secret'),
    changeLevel: () => {},
    onRemove: entity => {
      recordRemovedEntity(state, entity);
      state.physics?.remove(entity.id);
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
    set: () => {},
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
  const byId = new Map(), byType = new Map();
  for (const entity of entities) {
    byId.set(entity.id, entity);
    let list = byType.get(entity.type);
    if (!list) byType.set(entity.type, list = []);
    list.push(entity);
  }
  return (cache.entity = { list: entities, count: entities.length, last, byId, byType });
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
export function ruleTree(project) {
  const events = project.events || [], sheets = project.eventSheets || [];
  const cached = ruleTreeCache.get(events);
  // `count`/`last` catch a rule appended or removed in place, which tooling and tests
  // do without replacing the array; field edits need no invalidation because the tree
  // holds references to the rule objects themselves.
  if (cached && cached.count === events.length && cached.last === events[events.length - 1] &&
    cached.sheets === sheets && cached.sheetCount === sheets.length && sheetsUnchanged(cached.sheetState, sheets)) return cached;
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
  const tree = { count: events.length, last: events[events.length - 1], sheets, sheetCount: sheets.length, sheetState, children, phases };
  ruleTreeCache.set(events, tree);
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
    const field = engineCommand(command.type)?.fields.find(entry => entry.name === key);
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

export function stepRuntime(project, state, dt, keys, pressed = new Set()) {
  dt = Math.max(0, Math.min(0.05, dt));
  const stepStarted = performance.now(), stepParts = (cacheFor(state).stepParts ||= {});
  let stepMark = stepStarted;
  const stage = name => { const now = performance.now(); stepParts[name] = now - stepMark; stepMark = now; };
  const player = state.player, hud = state.hudState;
  state.sounds.length = 0;
  advanceHUD(project, state.hudState, dt, 'interface');
  runRules('interface');
  stage('interface');
  state.interfaceStarted = true;
  state.hudState.cursor = state.gameScreen !== 'playing' || state.hudState.cursor;
  if (state.gameScreen !== 'playing' && !state.ambientWorld) {
    state.hudState.clicked.clear(); return;
  }
  state.time += dt;
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
  advanceSectors(state, dt);
  // Waggling planes and the 3D floors built on them move every frame, not only on an event.
  advancePlaneMotion(state, dt);
  // Things the map left in the air fall under the map's own gravity, which is how Lullaby's
  // title map rains its stars. It runs after the planes so a star lands on the floor it sees.
  stepThingGravity(project, state, dt);
  stage('sectors');
  const usedWall = !hud.cursor && state.playerStats.health > 0 && pressed.has('KeyE') ? useWall(state) : null;
  stage('use');
  state.worldTriggers.use = usedWall?.use ?? null;
  // The nearest line that actually carries a special, so a plain wall in front of a door
  // does not swallow the press.
  state.worldTriggers.useSpecial = usedWall?.special ?? null;
  state.worldTriggers.shoot.clear();
  runRules('beforePhysics');
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
    state.momentum = advanceMomentum(state.momentum, {
      x: (basis.forward[0] * cosHeading + basis.right[0] * sinHeading) * thrust.forward
        + (basis.right[0] * cosHeading - basis.forward[0] * sinHeading) * thrust.side,
      y: (basis.forward[1] * cosHeading + basis.right[1] * sinHeading) * thrust.forward
        + (basis.right[1] * cosHeading - basis.forward[1] * sinHeading) * thrust.side,
      z: (basis.forward[2] * cosHeading + basis.right[2] * sinHeading) * thrust.forward
        + (basis.right[2] * cosHeading - basis.forward[2] * sinHeading) * thrust.side,
    }, { grounded });
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
    ? state.worldTriggers.cross : crossedWalls(state, previousPosition);
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
  stage('afterRules');
  if (state.gameScreen !== 'playing') { hud.clicked.clear(); return; }
  // Imported actor definitions (DECORATE/ZScript) drive enemy and weapon state
  // machines; they run at Doom's 35 Hz tic rate next to the frame update.
  if (project.actors?.length) {
    stepActors(project, state, dt);
    stepWeapon(project, state, dt, !hud.cursor && state.playerStats.health > 0 && keys.has('Mouse0'));
    applyWeaponAttack(project, state);
    tickMorphs(project, state);
  }
  stage('actors');
  stepProjectiles(project, state, dt);
  settleGroundActors(state);
  advanceProjectiles(state, dt, projectile => runProjectileDeath(project, state, projectile),
    (entity, amount, source) => hurtActor(project, state, entity, amount, source));
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
  function runRules(phase) {
    const tree = ruleTree(project), roots = tree.phases.get(phase);
    if (!roots?.length) return;
    const instances = cacheFor(state).instances ||= new Map();
    // `forEachType` branches used to spread a fresh copy of the rule for every
    // matching object every frame. One copy per owner is enough, because a rule never
    // mutates itself while it runs, so the copies are kept and reused.
    function instanceFor(source, ownerId) {
      let byOwner = instances.get(source.id);
      if (!byOwner) instances.set(source.id, byOwner = new Map());
      let instance = byOwner.get(ownerId);
      if (!instance) { instance = { ...source, ownerId }; byOwner.set(ownerId, instance); }
      return instance;
    }
    function visit(source, ownerId) {
      if (source.groupId && !state.groups.get(source.groupId)) return;
      if (ownerId) {
        if (!runEvent(instanceFor(source, ownerId), Boolean(source.forEachType), phase)) return;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        for (const child of tree.children.get(source.id) || []) {
          visit(child, ownerId);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
        return;
      }
      if (!source.forEachType) {
        if (!runEvent(source, false, phase)) return;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        // Sub-events inherit the owner of the rule that ran them, so "this object" in a
        // child of an object script still means that object.
        for (const child of tree.children.get(source.id) || []) {
          visit(child, source.ownerId);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
        return;
      }
      const matching = entityLookup(state).byType.get(source.forEachType);
      if (!matching?.length) return;
      for (const entity of matching) {
        const event = instanceFor(source, entity.id);
        if (!runEvent(event, true, phase)) continue;
        if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        for (const child of tree.children.get(source.id) || []) {
          visit(child, event.ownerId);
          if (phase !== 'interface' && state.gameScreen !== 'playing') return;
        }
      }
    }
    for (const source of roots) {
      visit(source, undefined);
      if (phase !== 'interface' && state.gameScreen !== 'playing') break;
    }
  }
  function runEvent(event, perInstance, phase) {
    // The key is a string per rule and per owner, so building it for every rule of
    // every frame is one of the largest garbage sources in the simulation. Only the
    // conditions that sample state and the one-shot bookkeeping need it.
    let eventKey = null;
    const keyOf = () => eventKey ??= perInstance ? `${event.id}:${event.ownerId}` : event.id;
    if (!event.enabled || (event.once && state.fired.has(keyOf()))) return;
    const lookup = entityLookup(state);
    if (event.ownerId && !lookup.byId.has(event.ownerId)) return;
    const findTarget = id => lookup.byId.get(resolveEntityId(event, id));
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
        context ||= expressionContext(project, event, state, dt);
        resolved[key] = resolveExpression(command, key, value, context, project, event);
      }
      // Commands are immutable between edits (an edit replaces the project), so a
      // command that carries no expression is remembered and never scanned again.
      if (!found) expressionFree.add(command);
      return resolved;
    };
    function assignVariable(record, name, value, add) {
      if (!Object.hasOwn(record, name)) throw new Error(`Event "${event.name || event.id}" references missing variable "${name}"`);
      if (typeof value !== typeof record[name] || add && typeof value !== 'number') throw new Error(`Event "${event.name || event.id}": variable "${name}" type mismatch`);
      record[name] = scalar(add ? record[name] + value : value);
    }
    function compare(a, operator, b) {
      if (typeof a !== typeof b || !['number', 'string', 'boolean'].includes(typeof a) || typeof a === 'boolean' && !['=', '!='].includes(operator)) throw new Error(`Event "${event.name || event.id}": incompatible comparison types`);
      return compareValues(a, operator, b);
    }
    let statChanges = null;
    const matchOne = condition => condition.inverted ? !matchCondition(condition) : Boolean(matchCondition(condition));
    function matchCondition(condition) {
      condition = resolveCommand(condition);
      if (condition.type === 'gameScreen') return state.gameScreen === condition.screen;
      if (condition.type === 'shaderEnabled') return state.shaderEnabled;
      if (condition.type === 'expressionCompare') return compare(condition.left, condition.operator, condition.right);
      if (condition.type === 'objectVariableCompare') {
        const target = findTarget(condition.entityId);
        return target && compare(target.variables[condition.variable], condition.operator, condition.value);
      }
      if (condition.type === 'everySeconds') {
        // Construct's "Every X seconds": the first tick fires immediately, then the
        // interval restarts, so a rule cannot drift or fire twice for one interval.
        const intervals = state.intervals ||= new Map();
        const due = intervals.get(event.id) || 0;
        if (state.time + 1e-9 < due) return false;
        intervals.set(event.id, state.time + condition.seconds);
        return true;
      }
      if (condition.type === 'randomChance') return nextRandom(state) < condition.probability;
      if (condition.type === 'objectCount') {
        const wanted = condition.entityType || condition.type_;
        const count = wanted === 'any' ? state.entities.length
          : state.entities.filter(entity => entity.type === wanted).length;
        return compareValues(count, condition.operator, condition.value);
      }
      if (condition.type === 'entityAngle') {
        const target = findTarget(condition.entityId);
        const angle = target?.type === 'player' ? player.angle * 180 / Math.PI : Number(target?.angle) || 0;
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
      if (condition.type === 'playerInArea' || condition.type === 'playerEnteredArea') {
        const entity = findTarget(condition.entityId);
        if (!entity) return false;
        const volume = areaVolume(entity, sectorAt(state.sectors, entity.x, entity.y)?.floorHeight ?? 0);
        if (!volume) {
          throw new Error(`Event "${event.name || event.id}" tests an interaction area on ${entity.name}, which has none`);
        }
        const floor = sectorAt(state.sectors, state.player.x, state.player.y)?.floorHeight ?? 0;
        const centre = playerCentre(state.player);
        const inside = areaContains(volume, { x: centre[0], y: centre[1], z: centre[2] });
        if (condition.type === 'playerInArea') return inside;
        return areaEntered(state.areaEntries ||= new Set(), event.id, inside);
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
      if (condition.type === 'spriteState') return state.spriteAnimations.get(resolveEntityId(event, condition.entityId))?.name === condition.state;
      if (condition.type === 'entityDamaged') {
        const entity = findTarget(condition.entityId);
        if (!entity) return false;
        const key = `${keyOf()}:${entity.id}`, old = state.entitySamples.get(key) ?? entity.health;
        state.entitySamples.set(key, entity.health);
        return entity.health < old;
      }
      if (condition.type === 'wallActivated') {
        // A use press activates both the nearest wall (for hand-written rules) and the
        // nearest wall with a special (for the generated door, lift and exit rules).
        if (condition.mode === 'use') return state.worldTriggers.use === condition.wallId || state.worldTriggers.useSpecial === condition.wallId;
        return state.worldTriggers[condition.mode].has(condition.wallId);
      }
      if (condition.type === 'sectorMoving') return state.sectorMotions.has(`${condition.sectorId}:${condition.surface}`);
      if (condition.type === 'enemySeesPlayer') {
        const entity = findTarget(condition.entityId);
        const alerted = entity && state.time < (state.timers.get(`${entity.id}:alert`) || 0);
        return entity && canSeePlayer(state, entity, condition.range, alerted ? 360 : condition.fov ?? 360);
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
        if (left && right) return compareValues(Math.hypot(left.x - right.x, left.y - right.y), condition.operator, condition.distance);
        return false;
      }
      if (condition.type === 'variableCompare') return compare(state.variables[condition.variable], condition.operator, condition.value);
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
      const entity = findTarget(condition.entityId);
      const position = entity?.type === 'player' ? player : entity;
      return position && Math.hypot(position.x - player.x, position.y - player.y) <= condition.distance;
    }
    // Evaluating the condition list without building it: `eventConditions` allocated a
    // fresh array for every rule on every frame.
    let matches;
    if (event.conditionMode === 'or') {
      matches = matchOne(event.condition);
      if (!matches) for (const condition of event.conditions || []) if (matchOne(condition)) { matches = true; break; }
    } else {
      matches = matchOne(event.condition);
      if (matches) for (const condition of event.conditions || []) if (!matchOne(condition)) { matches = false; break; }
    }
    if (!matches) return;
    if (event.once) state.fired.add(keyOf());
    for (const sourceAction of event.actions) {
      const action = resolveCommand(sourceAction);
      switch (action.type) {
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
          if (action.angle !== undefined) spawned.angle = action.angle;
          if (action.name) spawned.name = action.name.slice(0, 100);
          state.entities.push(spawned);
          state.worldRevision++;
          break;
        }
        case 'rotateEntityBy': {
          const entity = findTarget(action.entityId);
          if (entity) {
            entity.angle = (Number(entity.angle) || 0) + action.angle;
            if (entity.type === 'player') player.angle += action.angle * Math.PI / 180;
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
          if (entity) { entity.spriteScale = action.scale; if (entity.modelAsset) entity.modelScale = action.scale; }
          break;
        }
        case 'setGravityScale':
          state.physics?.gravityScale(resolveEntityId(event, action.entityId), action.scale); break;
        case 'setDamping':
          state.physics?.damping(resolveEntityId(event, action.entityId), action.damping); break;
        case 'moveSector': moveSector(state, action); break;
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
        case 'facePlayer': {
          const entity = findTarget(action.entityId);
          if (entity) entity.angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x) * 180 / Math.PI;
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
        case 'launchProjectile': launchProjectile(state, action); break;
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
        case 'hitscan': fireHitscan(project, state, action); break;
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
        case 'teleport':
          player.x = action.x; player.y = action.y;
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
          state.entities = state.entities.filter(item => item.id !== id);
          break;
        }
        case 'setEntityPosition': {
          const target = findTarget(action.entityId);
          if (target) {
            target.x = action.x; target.y = action.y;
            if (target.type === 'player') { player.x = action.x; player.y = action.y; }
            if (action.z !== undefined) target.z = action.z;
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
      }
      if (phase !== 'interface' && state.gameScreen !== 'playing') return true;
    }
    return true;
  }
}

/**
 * Drives the imported weapon state machine. Weapons keep their own tic clock so
 * a mod's fire rates stay exact even when a frame renders faster than 35 Hz.
 */
function stepWeapon(project, state, dt, trigger) {
  const slot = state.inventory.selectedWeapon;
  if (!state.weaponActor || state.weaponSlot !== slot) {
    if (!beginWeapon(project, state, slot)) { state.weaponTriggerHeld = false; return; }
  }
  state.weaponTriggerHeld = Boolean(trigger);
  state.weaponClock = (state.weaponClock || 0) + dt * 35;
  const whole = Math.floor(state.weaponClock + 1e-6);
  const tics = Math.min(4, whole);
  state.weaponClock -= whole;
  // Refiring is the states' own decision (`A_ReFire` restarts Fire while the
  // trigger is held; a weapon without it fires once per press, as in Doom). An
  // external "trigger held and ready means Fire" shortcut re-entered Fire every
  // tic or two and burned the whole clip in under a second.
  for (let tic = 0; tic < tics; tic++) weaponTic(project, state, trigger);
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
    state.worldTriggers.shoot.clear();
  }
  if (state.scripts?.errors?.length) {
    const latest = state.scripts.errors[state.scripts.errors.length - 1];
    if (latest !== state.scriptWarning) { state.scriptWarning = latest; state.message = latest; state.messageTime = 5; }
  }
}

function applyWeaponAttack(project, state) {
  const attack = state.weaponAttack;
  if (!attack) return;
  state.weaponAttack = null;
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
