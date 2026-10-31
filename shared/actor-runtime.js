import { sectorAt } from './sectors.js';
import { damagePlayer, floorAt, canSeePlayer, canSeeTarget, randomDamage, enemyHitscan, moveEnemy, geometryDistance,
  entityDistance, projectileSource } from './combat.js';
import { actorIndex, actorForThing, NATIVE_EFFECT_ACTORS } from './actors.js';
import { actorProjectileClips, actorEffectClip, setSpriteState } from './sprite-animation.js';
import { morphEntity, unmorphEntity, morphTarget } from './morph.js';
import { actorFunctionSource, runActorFunction } from './actor-functions.js';

/**
 * Actor runtime.
 *
 * Executes imported actor state machines (DECORATE/ZScript states) at Doom's
 * 35 Hz tic rate. This is what turns imported definitions into behaviour: an
 * enemy's See/Pain/Death blocks, a weapon's Ready/Fire/Flash blocks and their
 * action functions run from the data the game shipped instead of from scripted
 * approximations.
 */

export const TIC_RATE = 35;
const MAX_TICS_PER_STEP = 4;
const LABEL_ALIASES = { melee: 'Melee', missile: 'Missile', see: 'See', spawn: 'Spawn',
  pain: 'Pain', death: 'Death', xdeath: 'XDeath', raise: 'Raise', crash: 'Crash', burn: 'Burn',
  ready: 'Ready', select: 'Select', deselect: 'Deselect', fire: 'Fire', flash: 'Flash' };

/** Case-insensitive label lookup, because mods mix casing across files. */
export function labelIndex(actor, label) {
  if (!actor?.states) return null;
  const labels = actor.states.labels;
  if (label === undefined || label === null) return null;
  if (label in labels) return labels[label];
  const alias = LABEL_ALIASES[String(label).toLowerCase()];
  if (alias && alias in labels) return labels[alias];
  const key = Object.keys(labels).find(candidate => candidate.toLowerCase() === String(label).toLowerCase());
  return key === undefined ? null : labels[key];
}

// Actor labels that change what the sprite shows.
const SPRITE_STATE_BY_LABEL = { spawn: 'stand', see: 'walk', missile: 'attack', melee: 'attack',
  pain: 'pain', death: 'death', xdeath: 'death' };

/**
 * Keeps the entity's sprite in step with its state machine. Without this an
 * imported monster holds its spawn frame forever: the sprite rules belong to the
 * scripted enemy AI, which an actor-driven monster never runs.
 */
function syncActorSprite(project, state, entity, actor, runtime) {
  const frame = actor.states.frames[runtime.index];
  const name = SPRITE_STATE_BY_LABEL[String(frame?.label || '').toLowerCase()];
  if (!name || runtime.sprite === name || !entity.spriteStates?.[name]) return;
  runtime.sprite = name;
  setSpriteState(project, state, entity, name, name === 'pain');
}

/** Persistent per-entity actor state, created on first use. */
export function actorStateOf(entity) {
  return entity.actorState ||= { index: null, tics: 0, target: null, threshold: 0, reactionTime: 0,
    moveDir: -1, flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
}

/**
 * The project's actor index, cached for the lifetime of the project object.
 *
 * It lives in a WeakMap rather than as a hidden property on the project: a hidden
 * property is still an own property, so `structuredClone` copied the whole index
 * (maps of every imported actor) on every editor edit — hundreds of milliseconds per
 * click on an imported game — and `JSON.stringify` would have to walk it too. The
 * index is rebuilt from `project.actors` on the next lookup after an edit.
 */
const actorIndexes = new WeakMap();
export function projectActorIndex(project) {
  const cached = actorIndexes.get(project);
  if (cached) return cached;
  const index = actorIndex(project.actors || []);
  actorIndexes.set(project, index);
  return index;
}

export function createActorRuntime(project) {
  const index = actorIndex(project.actors || []);
  return { index, project, projectiles: new Map() };
}

/** Finds the actor record an entity runs. */
export function actorOf(project, entity) {
  if (!project.actors?.length) return null;
  const index = projectActorIndex(project);
  return (entity.actorId && index.byId.get(entity.actorId)) ||
    actorForThing(index, entity.doomType, entity.actorName) || null;
}

/** Places an entity's state machine at a label (Spawn for new monsters). */
export function setActorState(project, entity, label, { restart = false } = {}) {
  const actor = actorOf(project, entity);
  if (!actor) return false;
  const state = actorStateOf(entity);
  const target = labelIndex(actor, label);
  if (target === null) return false;
  if (!restart && state.index === target) return true;
  state.index = target;
  state.tics = 0;
  entity.stateLabel = String(label);
  return true;
}

/** Current frame record, or null when the machine has stopped. */
export function currentFrame(actor, state) {
  if (!actor || state.index === null) return null;
  return actor.states.frames[state.index] || null;
}

/**
 * Advances one actor tic: decrement the frame timer, then execute the frame the
 * machine moved onto. Frame actions run on entry, matching Doom's behaviour.
 */
export function actorTic(project, state, entity, moveTarget = true) {
  const actor = actorOf(project, entity);
  if (!actor) return;
  const runtime = actorStateOf(entity);
  if (runtime.index === null && !runtime.initialised) {
    runtime.initialised = true;
    setActorState(project, entity, entity.health > 0 ? 'Spawn' : 'Death');
  } else if (runtime.index === null) {
    // The machine finished (a corpse that reached Stop); nothing more to run.
    return;
  }
  const frames = actor.states.frames;
  const frame = frames[runtime.index];
  if (!frame) return;
  if (frame.kind === 'frame') {
    if (runtime.tics <= 0) runtime.tics = Math.max(0, frame.duration);
    // Actions execute once, when the frame is entered.
    if (!runtime.entered) {
      runtime.entered = true;
      runActions(project, state, entity, actor, frame.actions, { moveTarget });
    }
    if (frame.duration < 0) return;
    runtime.tics--;
    if (runtime.tics > 0) return;
    runtime.entered = false;
    runtime.index++;
    return;
  }
  syncActorSprite(project, state, entity, actor, runtime);
  // Non-frame records immediately move the machine.
  runtime.entered = false;
  if (frame.kind === 'stop') { runtime.index = null; runtime.stopped = true; return; }
  if (frame.kind === 'goto' || frame.kind === 'loop') {
    const target = frame.kind === 'loop' ? frame.label : frame.target;
    const resolved = labelIndex(actor, target);
    runtime.index = resolved === null ? null : resolved;
    return;
  }
  if (frame.kind === 'wait') return;
  runtime.index++;
}

/** Runs a frame's action list; unknown actions are counted for diagnostics. */
/** `ACS_Execute(script, map, arg1..arg4)` starts a map script from a state frame. */
function executeAcs(ctx, always, wantResult, named = false) {
  const scripts = ctx.state.scripts;
  if (!scripts) return;
  const selector = arg(ctx, 0, 0);
  const result = scripts.execute(named ? selector : Number(selector) || 0,
    [numArg(ctx, 2), numArg(ctx, 3), numArg(ctx, 4), numArg(ctx, 5)].slice(0, 4),
    { always, wantResult, activator: 'player' });
  if (wantResult && ctx.named.Result !== undefined) ctx.named.Result = result;
}

function suspendAcs(ctx, named, terminate = false) {
  const scripts = ctx.state.scripts;
  if (!scripts) return;
  const selector = named ? arg(ctx, 0) : Number(arg(ctx, 0)) || 0;
  if (terminate) scripts.terminate(selector);
  else scripts.suspend(selector);
}

export function runActions(project, state, entity, actor, actions, context = {}) {
  for (const action of actions || []) {
    const handler = ACTIONS[action.name];
    if (!handler) {
      // A frame may call one of the actor's own functions (`PLAY A 1 Rotate;` with
      // `void Rotate() { angle += 1; }`). Its body is executed as written.
      const source = actorFunctionSource(actor, action.name);
      if (source !== null) {
        const result = runActorFunction(entity, source);
        if (!result.ran) {
          state.actorUnsupported ||= new Set();
          if (state.actorUnsupported.size < 200) state.actorUnsupported.add(action.name);
        }
        continue;
      }
      state.actorUnsupported ||= new Set();
      if (state.actorUnsupported.size < 200) state.actorUnsupported.add(action.name);
      continue;
    }
    try { handler({ project, state, entity, actor, action, args: action.args || [], named: action.named || {}, ...context }); }
    catch { /* A malformed action must not break the frame loop. */ }
  }
}

const arg = (ctx, index, fallback = undefined) => {
  const value = ctx.args[index];
  if (value === undefined) return ctx.named[Object.keys(ctx.named)[index]] ?? fallback;
  return value;
};
const numArg = (ctx, index, fallback = 0) => {
  const value = arg(ctx, index, fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const projectilesByName = project => projectActorIndex(project);

const clampUnit = value => Math.max(-1, Math.min(1, value));
const wrapRadians = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Who a spray or explosion counts as the shooter: a missile's owner, else the player. */
function sprayOrigin(state, entity) {
  if (entity?.type === 'player') return entity;
  if (entity?.ownerId === '$player') return state.player;
  if (entity?.ownerId) {
    const owner = state.entities.find(candidate => candidate.id === entity.ownerId);
    if (owner) return owner;
  }
  return state.player;
}

/** The thing a seeking missile is locked onto. */
function tracerTarget(state, entity) {
  if (entity?.tracerId === '$player' || (!entity?.tracerId && entity?.type !== 'player')) return state.player;
  return state.entities.find(candidate => candidate.id === entity?.tracerId) || null;
}

/**
 * One homing step, ported from GZDoom's A_Tracer2: turn the missile's angle toward
 * its target by at most `turn` degrees and slew its climb by an eighth of a unit per
 * tic, so a revenant tracer curves in instead of snapping onto the target.
 */
function tracerStep(ctx, turn) {
  const { state, entity } = ctx;
  if (!entity || !(entity.speed > 0)) return;
  const target = tracerTarget(state, entity);
  if (!target) return;
  const alive = target === state.player ? state.playerStats.health > 0 : (target.health ?? 0) > 0;
  if (!alive) return;
  const perTic = entity.speed / TIC_RATE;
  const current = Math.atan2(entity.dy, entity.dx);
  const exact = Math.atan2(target.y - entity.y, target.x - entity.x);
  const off = wrapRadians(exact - current);
  const step = turn * Math.PI / 180;
  let heading = current;
  if (off < 0) {
    heading = current - step;
    if (wrapRadians(exact - heading) > 0) heading = exact;
  } else if (off > 0) {
    heading = current + step;
    if (wrapRadians(exact - heading) < 0) heading = exact;
  }
  const horizontal = Math.max(1, Math.hypot(target.x - entity.x, target.y - entity.y));
  const height = target.height ?? 56;
  const aimZ = floorAt(state, target) + (height >= 56 ? 40 : height * 2 / 3);
  const slope = (aimZ - entity.z) / Math.max(1, horizontal / Math.max(.001, perTic));
  let climb = entity.dz * perTic;
  climb += slope < climb ? -0.125 : 0.125;
  const pitch = Math.atan2(climb, perTic);
  const ring = Math.cos(pitch);
  entity.dx = Math.cos(heading) * ring;
  entity.dy = Math.sin(heading) * ring;
  entity.dz = clampUnit(Math.sin(pitch));
  entity.angle = heading * 180 / Math.PI;
}

/**
 * A missile actor as the projectile runtime needs it. Actor `speed` is map units
 * per 35 Hz tic, so it is converted to the per-second value the projectile step
 * and the level's own movement share.
 */
export function missileProjectile(project, name) {
  const index = projectilesByName(project);
  const actor = index.byName.get(String(name || '').toLowerCase()) ||
    index.byId.get(`actor_${String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_')}`);
  if (!actor) return null;
  const clips = actorProjectileClips(project, actor);
  return { name: actor.name, actorId: actor.id, speed: (actor.speed || 10) * TIC_RATE, damage: actor.damage ?? 0,
    radius: actor.radius || 0, clipId: clips.fly, impactClipId: clips.impact,
    seeker: actor.flags?.SEEKERMISSILE === true };
}

/**
 * Spawns a decorative actor a missile's own states create: a trail particle, a
 * spray puff or an explosion burst. It animates through the actor's Spawn frames
 * and is dropped when that clip ends; it never blocks, collides or takes damage.
 */
export function spawnEffect(project, state, actorName, { x, y, z, vx = 0, vy = 0, vz = 0 } = {}) {
  const actor = projectActorIndex(project).byName.get(String(actorName || '').toLowerCase());
  if (!actor) return null;
  const clipId = actorEffectClip(project, actor);
  if (!clipId) return null;
  state.impacts ||= [];
  // The save format refuses more than 256 effects, so trails never grow past it.
  if (state.impacts.length >= 256) state.impacts.shift();
  state.spawnSequence = (state.spawnSequence || 0) + 1;
  const effect = { id: `effect_${state.spawnSequence}`, clipId, x, y, z, start: state.time };
  if (vx || vy || vz) { effect.vx = vx * TIC_RATE; effect.vy = vy * TIC_RATE; effect.vz = vz * TIC_RATE; }
  state.impacts.push(effect);
  return effect;
}

/** The projectile's actor record, for the flight state machine and its actions. */
export function projectileActor(project, projectile) {
  if (!projectile.actorId) return null;
  return projectActorIndex(project).byId.get(projectile.actorId) || null;
}

/**
 * Actions that steer a monster, not a missile. A stray one in a projectile's
 * states would move or wake the wrong thing, so missile machines skip them.
 */
const PROJECTILE_UNSAFE = new Set(['A_Look', 'A_LookEx', 'A_Chase', 'A_Wander', 'A_ClearTarget',
  'A_FaceTarget', 'A_GiveInventory', 'A_GiveToTarget', 'A_JumpIfInTargetInventory']);

function runProjectileActions(project, state, projectile, actor, actions) {
  for (const action of actions || []) {
    if (PROJECTILE_UNSAFE.has(action.name)) continue;
    const handler = ACTIONS[action.name];
    if (!handler) {
      state.actorUnsupported ||= new Set();
      if (state.actorUnsupported.size < 200) state.actorUnsupported.add(action.name);
      continue;
    }
    try {
      handler({ project, state, entity: projectile, actor, action, args: action.args || [], named: action.named || {} });
    } catch { /* a malformed action must not stop the missile */ }
  }
}

/**
 * Advances a missile's own state machine: this is where a plasma rifle's trail
 * particles, a revenant tracer's homing and a BFG ball's spray come from. Doom
 * runs these states on the projectile itself, with the projectile as `self`.
 */
export function projectileTic(project, state, projectile) {
  const actor = projectileActor(project, projectile);
  const frames = actor?.states?.frames;
  if (!frames?.length) return;
  const machine = projectile.actorState ||= { index: null, tics: 0, entered: false, initialised: true,
    target: null, threshold: 0, reactionTime: 0, moveDir: -1, flags: new Map(), inventory: new Map() };
  if (machine.index === null) {
    if (machine.stopped) return;
    const start = labelIndex(actor, 'Spawn');
    if (start === null) return;
    machine.index = start;
  }
  const frame = frames[machine.index];
  if (!frame) { machine.index = null; return; }
  if (frame.kind === 'frame') {
    if (machine.tics <= 0) machine.tics = Math.max(0, frame.duration);
    if (!machine.entered) {
      machine.entered = true;
      runProjectileActions(project, state, projectile, actor, frame.actions);
    }
    if (frame.duration < 0) return;
    machine.tics--;
    if (machine.tics > 0) return;
    machine.entered = false;
    machine.index++;
    return;
  }
  machine.entered = false;
  if (frame.kind === 'stop') { machine.index = null; machine.stopped = true; return; }
  if (frame.kind === 'goto' || frame.kind === 'loop') {
    const resolved = labelIndex(actor, frame.kind === 'loop' ? frame.label : frame.target);
    machine.index = resolved === null ? null : resolved;
    return;
  }
  if (frame.kind === 'wait') return;
  machine.index++;
}

/**
 * Steps every live missile's own states, converting frame time into 35 Hz tics so
 * trail particles spawn and homing turns at Doom's pace.
 */
export function stepProjectiles(project, state, dt) {
  if (!project.actors?.length || !state.projectiles?.length) return;
  state.projectileClock = (state.projectileClock || 0) + dt * TIC_RATE;
  const whole = Math.floor(state.projectileClock + 1e-6);
  const tics = Math.min(whole, MAX_TICS_PER_STEP);
  state.projectileClock -= whole;
  for (let tic = 0; tic < tics; tic++) {
    for (const projectile of state.projectiles) if (projectile.actorId) projectileTic(project, state, projectile);
  }
}

/**
 * Runs a missile's Death states when it hits. Doom's BFG ball sprays from its
 * Death state and the rocket explodes from its own, so this is where those
 * effects happen instead of being hardcoded per weapon.
 */
export function runProjectileDeath(project, state, projectile) {
  const actor = projectileActor(project, projectile);
  if (!actor) return false;
  const label = labelIndex(actor, 'Death') ?? labelIndex(actor, 'Crash');
  if (label === null) return false;
  const frames = actor?.states?.frames || [];
  const actions = [];
  for (let index = label; index < frames.length && frames[index].kind === 'frame'; index++) {
    actions.push(...(frames[index].actions || []));
  }
  runProjectileActions(project, state, projectile, actor, actions);
  return true;
}

/**
 * Actors a missile's states spawn by name: trail particles, puffs and bursts. The
 * missile itself may never be placed in a map, so these are collected directly
 * from the actor table rather than only from the level's used actors.
 */
export function missileEffectActors(project) {
  const index = projectActorIndex(project);
  const found = new Map();
  for (const actor of project.actors || []) {
    const flags = actor.flags || {};
    if (!(flags.MISSILE || flags.PROJECTILE)) continue;
    for (const frame of actor.states?.frames || []) {
      for (const action of frame.actions || []) {
        for (const value of action?.args || []) {
          if (typeof value !== 'string') continue;
          const name = value.trim().replace(/^"+|"+$/g, '').toLowerCase();
          const named = name ? index.byName.get(name) : null;
          if (named && !found.has(named.name)) found.set(named.name, named);
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * Pre-builds the missile sprite clips. The renderer reads the project's clips
 * once, so a projectile that only appears mid-fight has to have its artwork
 * before the sprite index is built.
 */
export function installActorProjectileSprites(project) {
  if (!project.actors?.length) return;
  for (const actor of project.actors) {
    const flags = actor.flags || {};
    const missile = Array.isArray(flags) ? flags.includes('MISSILE') || flags.includes('PROJECTILE')
      : flags.MISSILE || flags.PROJECTILE;
    if (missile) actorProjectileClips(project, actor);
  }
  // Trail particles, spray puffs and explosion bursts are spawned while playing,
  // but the renderer reads the clip list once, so their clips are built now.
  const index = projectActorIndex(project);
  const candidates = [...usedActors(project), ...missileEffectActors(project)];
  for (const actor of candidates) {
    for (const frame of actor.states?.frames || []) {
      for (const action of frame.actions || []) {
        for (const value of action?.args || []) {
          if (typeof value !== 'string') continue;
          const name = value.trim().replace(/^"+|"+$/g, '').toLowerCase();
          const named = name ? index.byName.get(name) : null;
          if (named && !named.flags?.MISSILE) actorEffectClip(project, named);
        }
      }
    }
  }
  for (const actor of missileEffectActors(project)) if (!actor.flags?.MISSILE) actorEffectClip(project, actor);
  // The native actions spawn these by name (A_Tracer's smoke, A_BFGSpray's puffs),
  // so a game whose actors never name them still draws the effects.
  for (const name of NATIVE_EFFECT_ACTORS) {
    const actor = index.byName.get(name.toLowerCase());
    if (actor) actorEffectClip(project, actor);
  }
}

/** Spawns a projectile actor owned by an enemy, aimed at the player. */
export function spawnActorProjectile(project, state, owner, projectileName, { speed = 0, damage = null, angle = null } = {}) {
  const aim = actorTarget(state, owner);
  const index = projectilesByName(project);
  const actor = index.byName.get(String(projectileName).toLowerCase()) ||
    index.byId.get(`actor_${String(projectileName).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`);
  const clips = actor ? actorProjectileClips(project, actor) : { fly: null, impact: null };
  const missileSpeed = speed || actor?.speed || 10;
  const damageValue = damage ?? actor?.damage ?? 0;
  const radians = angle ?? Math.atan2(aim.y - owner.y, aim.x - owner.x);
  const originZ = floorAt(state, owner) + Math.min(32, (owner.height || 56) * .5);
  const targetZ = floorAt(state, aim) + 32;
  const horizontal = Math.hypot(aim.x - owner.x, aim.y - owner.y);
  const pitch = Math.atan2(targetZ - originZ, Math.max(1, horizontal));
  state.projectiles.push({
    id: ++state.projectileSequence, ownerId: owner.id, actorId: actor?.id || null, actorName: actor?.name || null,
    x: owner.x, y: owner.y, z: originZ,
    dx: Math.cos(radians) * Math.cos(pitch), dy: Math.sin(radians) * Math.cos(pitch), dz: Math.sin(pitch),
    // Explosions come from the missile's own Death states (A_Explode), not from a
    // radius invented here, so a mod's projectile behaves like its definition.
    speed: missileSpeed * TIC_RATE, damage: damageValue, diceSides: 8, radius: 0,
    age: 0, color: '#ff8833', clipId: clips.fly, impactClipId: clips.impact,
    tracerId: actor?.flags?.SEEKERMISSILE === true ? '$player' : null,
  });
  return actor;
}

/**
 * Doom's wake-on-sound: a gunshot or other player noise within hearing range
 * starts a monster even when it cannot see the player.
 */
function hearsPlayer(state, entity) {
  const noise = state.playerNoise;
  if (!noise) return false;
  if (!state.sectors?.length) return false;
  const distance = Math.hypot(noise.x - entity.x, noise.y - entity.y);
  if (distance > 2048) return false;
  return canSeePlayer(state, entity, 2048) || distance < 1024;
}

const meleeRange = 64;

/**
 * What a monster is hunting: the player, or the monster that hurt it. Doom calls
 * this `target`, and infighting only works because damage assigns it.
 */
export function actorTarget(state, entity) {
  if (entity?.targetId && entity.targetId !== '$player') {
    const other = state.entities.find(candidate => candidate.id === entity.targetId && (candidate.health ?? 0) > 0);
    if (other) return other;
  }
  return state.player;
}

/** Sets who a monster hunts; `null` clears it, `$player` means the player. */
export function setActorTarget(entity, target) {
  if (!target) delete entity.targetId;
  else entity.targetId = target === entity || target.type === 'player' ? '$player' : target.id;
}

const targetPosition = (state, entity) => actorTarget(state, entity) || state.player;

/**
 * Who an explosion credits: the missile's owner when the blast comes from a
 * projectile's Death state, otherwise the monster itself.
 */
function blastSource(state, entity) {
  if (entity?.type === 'projectile' && entity.ownerId) return projectileSource(state, entity) || null;
  return entity?.type === 'enemy' ? entity : null;
}
const targetDistance = (state, entity) => {
  const target = targetPosition(state, entity);
  return Math.hypot(target.x - entity.x, target.y - entity.y);
};
const meleeable = (state, entity) => targetDistance(state, entity) <= meleeRange;

function actorFlag(actor, name) {
  return Boolean(actor?.flags?.[name]) || Boolean(actor?.flags?.[name.toUpperCase()]);
}

/**
 * Applies damage the way Doom does: health, the pain roll, and — when a monster
 * hurt another monster — a target switch, which is what makes infighting happen.
 */
export function hurtActor(project, state, entity, amount, source = null) {
  if (!entity || entity.type !== 'enemy' || (entity.health ?? 0) <= 0 || !(amount > 0)) return false;
  const actor = actorOf(project, entity);
  entity.health = Math.max(0, entity.health - amount);
  if (source && source !== state.player && source !== entity && !actorFlag(actor, 'NOINFIGHTING')) {
    // A monster remembers who shot it, so it fights back against its own kind.
    entity.targetId = source.id;
  } else if (source === state.player) {
    entity.targetId = '$player';
  }
  if (entity.health <= 0) {
    // The Death state runs from stepActors; the body stops blocking immediately.
    entity.solid = false;
    state.physics?.remove(entity.id);
    return true;
  }
  const chance = Math.max(0, Math.min(256, actor?.painChance ?? 0));
  if (chance > 0 && randomDamage(state, 1, 256) <= chance) {
    // Pain interrupts whatever the monster was doing, and clears reaction time so
    // it can retaliate at once, exactly like P_DamageMobj.
    if (setActorState(project, entity, 'Pain')) {
      const runtime = actorStateOf(entity);
      runtime.reactionTime = 0;
      saySound(state, actor?.sounds?.pain, entity);
    }
  }
  return true;
}

/** A monster's hitscan attack: aim at its target, roll damage, let walls stop it. */
function monsterHitscan(ctx, damage, diceSides, spread = 0) {
  const { state, entity } = ctx;
  if (entity.health <= 0) return;
  const target = targetPosition(state, entity);
  const origin = { x: entity.x, y: entity.y, z: floorAt(state, entity) + 36 };
  const aim = Math.atan2(target.y - entity.y, target.x - entity.x);
  const reach = canSeeTarget(state, entity, target, 2048) ? 2048 : 0;
  if (!reach) return;
  const offset = spread ? (randomDamage(state, 1, 256) - randomDamage(state, 1, 256)) * spread / 256 * Math.PI / 180 : 0;
  const direction = { x: Math.cos(aim + offset), y: Math.sin(aim + offset), z: 0 };
  const limit = geometryDistance(state, origin, direction, reach);
  const hits = entityDistance(state, origin, direction, target, limit, 16);
  if (hits === null) return;
  const amount = randomDamage(state, damage, diceSides);
  if (target === state.player) damagePlayer(state, amount);
  else hurtActor(ctx.project, state, target, amount, entity);
}

/**
 * The missile a monster actually fires.
 *
 * These actions used to spawn a hardcoded class name, so a mod that renamed the
 * projectile (`Projectile "MyImpBall"`) had monsters that attacked with nothing: the
 * built-in name did not resolve to any actor. The actor's own declaration wins when it
 * resolves, and the built-in name stays as the fallback for a mod that only overrides
 * the monster's states.
 */
function actorMissile(ctx, fallback) {
  const declared = ctx.actor?.projectile;
  if (!declared) return fallback;
  const index = projectilesByName(ctx.project);
  return index.byName.has(String(declared).toLowerCase()) ? declared : fallback;
}

/**
 * The action function table. Only actions with real gameplay meaning are
 * implemented; everything else is tracked so the importer can report exactly
 * which functions a mod uses that the runtime does not emulate yet.
 */
export const ACTIONS = {
  // DECORATE and ZScript states call ACS directly; script numbers are the first
  // argument and 0 means "this map".
  ACS_Execute(ctx) { executeAcs(ctx, false, false); },
  ACS_ExecuteAlways(ctx) { executeAcs(ctx, true, false); },
  ACS_ExecuteWithResult(ctx) { executeAcs(ctx, false, true); },
  ACS_NamedExecute(ctx) { executeAcs(ctx, false, false, true); },
  ACS_NamedExecuteAlways(ctx) { executeAcs(ctx, true, false, true); },
  ACS_NamedSuspend(ctx) { suspendAcs(ctx, true); },
  ACS_NamedTerminate(ctx) { suspendAcs(ctx, true, true); },
  ACS_Suspend(ctx) { suspendAcs(ctx, false); },
  ACS_Terminate(ctx) { suspendAcs(ctx, false, true); },
  A_Look(ctx) {
    const { state, entity, actor } = ctx;
    if (entity.dormant) return;
    // Doom's A_Look only looks for a player, inside a 180 degree cone unless the
    // actor has LOOKALLAROUND, and wakes on gunfire through P_RecursiveSound. An
    // AMBUSH monster ignores the sound and only reacts to what it can see.
    const fov = actorFlag(actor, 'LOOKALLAROUND') ? 360 : 180;
    const seen = canSeePlayer(state, entity, 2048, fov);
    if (!seen && (actorFlag(actor, 'AMBUSH') || entity.ambush || !hearsPlayer(state, entity))) return;
    setActorTarget(entity, state.player);
    saySound(state, actor.sounds?.see, entity);
    setActorState(ctx.project, entity, 'See');
  },
  A_LookEx(ctx) {
    const { state, entity, actor } = ctx;
    if (!canSeePlayer(state, entity, numArg(ctx, 0, 2048))) return;
    saySound(state, actor.sounds?.see, entity);
    setActorState(ctx.project, entity, arg(ctx, 4) || 'See');
  },
  A_Chase(ctx) {
    const { state, entity, actor } = ctx;
    if (entity.health <= 0 || entity.dormant) return;
    const runtime = actorStateOf(entity);
    // Doom's chase ticks move the monster, then decide whether it may attack.
    const speed = (entity.actorSpeed || actor.speed || 8) * TIC_RATE * (state.settings?.fastMonsters ? 2 : 1);
    moveEnemy(state, entity, speed, 1 / TIC_RATE, targetPosition(state, entity));
    if (randomDamage(state, 1, 256) < 4) saySound(state, actor.sounds?.active, entity);
    if (runtime.reactionTime > 0) { runtime.reactionTime--; return; }
    const missileLabel = arg(ctx, 0) || 'Missile';
    const meleeLabel = arg(ctx, 1) || 'Melee';
    const target = targetPosition(state, entity);
    const distance = Math.hypot(target.x - entity.x, target.y - entity.y);
    // P_CheckMeleeRange: MELEERANGE - 20 + the monster's radius.
    if (distance <= 64 - 20 + (actor.radius || 20)) {
      if (setActorState(ctx.project, entity, meleeLabel)) {
        runtime.reactionTime = actor.reactionTime || 8;
        return;
      }
    }
    // P_CheckMissileRange: closer monsters are far more likely to shoot, and the
    // MISSILEMORE flags bias that roll the way Doom does.
    if (!canSeeTarget(state, entity, target, 2048)) return;
    let reach = Math.max(0, distance - 64) - 128;
    if (actorFlag(actor, 'MISSILEMORE')) reach += 100;
    if (actorFlag(actor, 'MISSILEEVENMORE')) reach += 200;
    if (reach < 200 && randomDamage(state, 1, 256) < reach) return;
    if (setActorState(ctx.project, entity, missileLabel)) runtime.reactionTime = actor.reactionTime || 8;
  },
  A_Wander(ctx) {
    const { state, entity, actor } = ctx;
    if (canSeePlayer(state, entity, 2048)) { setActorState(ctx.project, entity, 'See'); return; }
    moveEnemy(state, entity, (actor.speed || 8) * TIC_RATE * .5, 1 / TIC_RATE);
  },
  A_FaceTarget(ctx) {
    const { state, entity } = ctx;
    if (entity.health <= 0) return;
    const target = targetPosition(state, entity);
    entity.angle = Math.atan2(target.y - entity.y, target.x - entity.x) * 180 / Math.PI;
  },
  A_Pain(ctx) {
    saySound(ctx.state, ctx.actor.sounds?.pain, ctx.entity);
  },
  A_Scream(ctx) { saySound(ctx.state, ctx.actor.sounds?.death, ctx.entity); },
  A_XScream(ctx) { saySound(ctx.state, ctx.actor.sounds?.death, ctx.entity); },
  A_ActiveSound(ctx) { saySound(ctx.state, ctx.actor.sounds?.active, ctx.entity); },
  A_AlertMonsters(ctx) {
    const { state, entity } = ctx;
    // Doom floods sound through neighbouring sectors; anything that hears it wakes
    // up and turns on the player, which is how a shot in a corridor pulls a room.
    state.playerNoise = { time: state.time, x: entity.x, y: entity.y };
    for (const other of state.entities) {
      if (other.type !== 'enemy' || other === entity || (other.health ?? 0) <= 0) continue;
      if (other.actorId && !hearsPlayer(state, other)) continue;
      setActorTarget(other, state.player);
      if (!setActorState(ctx.project, other, 'See')) continue;
    }
  },
  A_NoBlocking(ctx) {
    ctx.entity.solid = false;
    ctx.entity.noBlockmap = true;
    ctx.state.physics?.remove(ctx.entity.id);
  },
  A_Noblocking(ctx) { ACTIONS.A_NoBlocking(ctx); },
  A_Fall(ctx) {
    ctx.entity.solid = false;
    ctx.state.physics?.remove(ctx.entity.id);
  },
  A_Stop(ctx) { ctx.entity.vx = 0; ctx.entity.vy = 0; },
  A_PlaySound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StartSound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StopSound() {},
  A_PosAttack(ctx) {
    monsterHitscan(ctx, 5, 3);
    saySound(ctx.state, 'DSPISTOL', ctx.entity, 90);
  },
  A_SPosAttack(ctx) {
    for (let pellet = 0; pellet < 3; pellet++) monsterHitscan(ctx, 5, 3, 11.25);
    saySound(ctx.state, 'DSSHOTGN', ctx.entity, 90);
  },
  A_CPosAttack(ctx) {
    monsterHitscan(ctx, 3, 3);
    saySound(ctx.state, 'DSPISTOL', ctx.entity, 80);
  },
  A_CPosRefire(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048) || randomDamage(state, 1, 256) < 40) setActorState(ctx.project, entity, 'See');
  },
  A_TroopAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { monsterHitscan(ctx, 3, 8); saySound(state, 'DSCLAW', entity); return; }
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'DoomImpBall'));
    saySound(state, 'DSPISTOL', entity, 70);
  },
  A_SargAttack(ctx) {
    const { state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    monsterHitscan(ctx, 4, 8);
    saySound(state, 'DSCLAW', entity);
  },
  A_HeadAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'CacodemonBall'));
    saySound(state, 'DSCACATT', entity);
  },
  A_BruisAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { monsterHitscan(ctx, 10, 8); saySound(state, 'DSCLAW', entity); return; }
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'BaronBall'));
    saySound(state, 'DSPISTOL', entity, 70);
  },
  A_BspiAttack(ctx) {
    spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'ArachnotronPlasma'));
    saySound(ctx.state, 'DSPLASMA', ctx.entity, 70);
  },
  A_SkelMissile(ctx) {
    spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'RevenantTracer'));
    saySound(ctx.state, 'DSPISTOL', ctx.entity, 60);
  },
  // Homing, from the missile's own state: GZDoom turns 16.875 degrees every fourth
  // tic and leaves a smoke puff behind the tracer.
  A_Tracer(ctx) {
    if (Math.round((ctx.state.time || 0) * TIC_RATE) & 3) return;
    const { project, state, entity } = ctx;
    spawnEffect(project, state, 'BulletPuff', { x: entity.x, y: entity.y, z: entity.z });
    spawnEffect(project, state, 'RevenantTracerSmoke', { x: entity.x, y: entity.y, z: entity.z, vz: 1 });
    tracerStep(ctx, 16.875);
  },
  A_Tracer2(ctx) { tracerStep(ctx, numArg(ctx, 0, 19.6875)); },
  // A_BFGSpray(spraytype, rays, damagecount, spread, distance, vrange, damage):
  // the BFG ball's Death state sweeps a deadly cone of rays across what it sees.
  A_BFGSpray(ctx) {
    const { project, state, entity } = ctx;
    const spray = String(arg(ctx, 0) || 'BFGExtra').replace(/^"|"$/g, '');
    const rays = Math.max(1, Math.min(256, Math.floor(numArg(ctx, 1, 40) || 40)));
    const rolls = Math.max(1, Math.floor(numArg(ctx, 2, 15) || 15));
    const spread = Math.max(1, numArg(ctx, 3, 90) || 90) * Math.PI / 180;
    const range = numArg(ctx, 4, 0) > 0 ? numArg(ctx, 4) : 1024;
    const fixedDamage = numArg(ctx, 6, 0);
    const origin = sprayOrigin(state, entity);
    const eye = { x: origin.x, y: origin.y, z: (origin.z ?? floorAt(state, origin)) + (origin === state.player ? 48 : 32) };
    const base = Math.atan2(entity?.dy ?? Math.sin((entity?.angle || 0) * Math.PI / 180),
      entity?.dx ?? Math.cos((entity?.angle || 0) * Math.PI / 180));
    for (let ray = 0; ray < rays; ray++) {
      const angle = base - spread / 2 + spread / rays * ray;
      const direction = { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
      let nearest = geometryDistance(state, eye, direction, range);
      let target = null;
      for (const candidate of state.entities) {
        if (candidate.type !== 'enemy' || (candidate.health ?? 0) <= 0) continue;
        const hit = entityDistance(state, eye, direction, candidate, nearest);
        if (hit !== null) { nearest = hit; target = candidate; }
      }
      if (!target) continue;
      let damage = fixedDamage;
      if (!damage) for (let roll = 0; roll < rolls; roll++) damage += randomDamage(state, 1, 8);
      hurtActor(project, state, target, damage, sprayOrigin(state, entity));
      spawnEffect(project, state, spray, { x: target.x, y: target.y,
        z: floorAt(state, target) + (target.height ?? 56) / 4 });
    }
  },
  A_FatAttack1(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'FatShot')); saySound(ctx.state, 'DSFIRSHT', ctx.entity); },
  A_FatAttack2(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'FatShot')); },
  A_FatAttack3(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'FatShot')); },
  A_CyberAttack(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'Rocket')); saySound(ctx.state, 'DSRLAUNC', ctx.entity); },
  A_PainAttack(ctx) {
    const { state, entity } = ctx;
    if (state.entities.filter(candidate => candidate.type === 'enemy' && candidate.health > 0).length > 40) return;
    const index = projectilesByName(ctx.project);
    const lost = index.byName.get('lostsoul');
    if (!lost) return;
    spawnProjectileEntity(ctx.project, state, entity, lost);
  },
  A_SkullAttack(ctx) {
    const { state, entity } = ctx;
    const target = targetPosition(state, entity);
    const angle = Math.atan2(target.y - entity.y, target.x - entity.x);
    entity.charge = { angle, tics: 20, speed: 20 };
    saySound(state, 'DSSKLATK', entity);
  },
  A_SpawnSound() {},
  A_SpawnFly() {},
  A_VileChase(ctx) {
    ACTIONS.A_Chase({ ...ctx, args: [], named: {} });
  },
  A_VileAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    monsterHitscan(ctx, 20, 8);
    saySound(state, 'DSVILATK', entity);
  },
  A_VileTarget() {},
  A_VileStart() {},
  A_KeenDie(ctx) {
    ctx.state.entities.filter(candidate => candidate.type === 'enemy' && candidate.health > 0)
      .forEach(candidate => { if (candidate !== ctx.entity) candidate.health = 0; });
  },
  A_BossDeath(ctx) {
    const { state, entity } = ctx;
    if (state.entities.some(candidate => candidate.type === 'enemy' && candidate.health > 0 && (candidate.actorName || '').toLowerCase() !== (entity.actorName || '').toLowerCase() &&
      candidate.actorId === entity.actorId)) return;
    state.bossDefeated = true;
  },
  // A_Explode(damage, distance, flags, alertMonsters, fulldamagedistance): Doom's
  // own defaults are 128 damage over a 128-unit radius. A missile's Death state is
  // where this now runs, so a rocket's blast comes from its definition.
  A_Explode(ctx) {
    const { project, state, entity } = ctx;
    const damage = numArg(ctx, 0, 128), radius = numArg(ctx, 1, 128);
    const falloff = distance => Math.max(0, Math.round(damage * (1 - distance / radius)));
    const playerDistance = Math.hypot(state.player.x - entity.x, state.player.y - entity.y);
    if (playerDistance < radius) damagePlayer(state, falloff(playerDistance));
    for (const other of state.entities) {
      if (other === entity || other.type !== 'enemy' || other.health <= 0) continue;
      const distance = Math.hypot(other.x - entity.x, other.y - entity.y);
      if (distance < radius) hurtActor(project, state, other, falloff(distance), blastSource(state, entity));
    }
    saySound(state, 'DSBAREXP', entity);
  },
  A_RadiusDamage(ctx) {
    const { project, state, entity } = ctx;
    const radius = numArg(ctx, 0, 128), damage = numArg(ctx, 1, 0);
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) < radius) damagePlayer(state, damage);
    for (const other of state.entities) {
      if (other === entity || other.type !== 'enemy' || other.health <= 0) continue;
      if (Math.hypot(other.x - entity.x, other.y - entity.y) >= radius) continue;
      hurtActor(project, state, other, damage, blastSource(state, entity));
    }
  },
  A_Jump(ctx) {
    const { state, entity, actor } = ctx;
    const chance = numArg(ctx, 0, 0);
    if (randomDamage(state, 1, 256) > chance && chance > 0) return;
    const offsets = ctx.args.slice(1).filter(value => value !== undefined && value !== null);
    if (!offsets.length) return;
    const runtime = actorStateOf(entity);
    const pick = offsets.length === 1 ? offsets[0] : offsets[Math.floor(randomDamage(state, 1, offsets.length)) - 1];
    const frames = actor.states.frames;
    if (typeof pick === 'number') {
      const target = runtime.index + pick;
      if (frames[target]) { runtime.index = target; runtime.tics = 0; runtime.entered = false; }
      return;
    }
    const target = labelIndex(actor, String(pick));
    if (target !== null) { runtime.index = target; runtime.tics = 0; runtime.entered = false; }
  },
  A_JumpIf(ctx) {
    const { state, entity, actor } = ctx;
    const condition = arg(ctx, 0);
    const truthful = typeof condition === 'boolean' ? condition : Number(condition) !== 0;
    if (!truthful) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(1)] });
  },
  A_JumpIfCloser(ctx) {
    const { state, entity, actor } = ctx;
    const distance = numArg(ctx, 0, 0);
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) > distance) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(1)] });
  },
  A_JumpIfHealthLower(ctx) {
    const { entity, actor } = ctx;
    if (entity.health >= numArg(ctx, 0, 0)) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(1)] });
  },
  A_JumpIfNoAmmo(ctx) {
    // Weapons resolve ammo themselves; monsters have no ammo so this never fires.
    if (ctx.actor.flags?.WEAPON) return;
  },
  A_JumpIfInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    const amount = numArg(ctx, 1, 1);
    if ((runtime.inventory.get(item) || 0) < amount) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(2)] });
  },
  A_JumpIfInTargetInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    if ((runtime.inventory.get(item) || 0) < numArg(ctx, 1, 1)) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(2)] });
  },
  A_JumpIfTargetInLOS(ctx) { ACTIONS.A_JumpIfCloser(ctx); },
  A_GiveInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    runtime.inventory.set(item, (runtime.inventory.get(item) || 0) + numArg(ctx, 1, 1));
  },
  A_TakeInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    const amount = numArg(ctx, 1, 1);
    runtime.inventory.set(item, Math.max(0, (runtime.inventory.get(item) || 0) - amount));
  },
  A_GiveToTarget(ctx) { ACTIONS.A_GiveInventory(ctx); },
  A_ClearTarget(ctx) { actorStateOf(ctx.entity).target = null; },
  A_SetScale(ctx) { ctx.entity.scale = numArg(ctx, 0, 1); },
  A_ChangeFlag(ctx) {
    const flag = String(arg(ctx, 0) || '');
    const value = arg(ctx, 1, true);
    ctx.entity.actorFlags ||= {};
    ctx.entity.actorFlags[flag] = typeof value === 'boolean' ? value : Number(value) !== 0;
  },
  A_SetAngle(ctx) { ctx.entity.angle = numArg(ctx, 0, ctx.entity.angle); },
  A_SetSpeed(ctx) { ctx.entity.actorSpeed = numArg(ctx, 0, 0); },
  A_Recoil(ctx) { ctx.entity.recoil = numArg(ctx, 0, 0); },
  A_CustomMissile(ctx) {
    const { state, entity } = ctx;
    spawnActorProjectile(ctx.project, state, entity, String(arg(ctx, 0) || ''), { speed: numArg(ctx, 1, 0), damage: null });
  },
  // A_SpawnItemEx(class, xofs, yofs, zofs, xvel, yvel, zvel, angle, flags, chance):
  // monsters that spawn reinforcements stay real things; decoration (trail
  // particles, puffs, sparks) becomes an effect that animates and disappears.
  A_SpawnItemEx(ctx) {
    const { project, state, entity } = ctx;
    const name = String(arg(ctx, 0) || '').replace(/^"|"$/g, '');
    const spawned = projectilesByName(project).byName.get(name.toLowerCase());
    if (!spawned) return;
    const chance = numArg(ctx, 9, 0);
    if (chance > 0 && randomDamage(state, 1, 256) <= chance) return;
    if (spawned.flags?.COUNTKILL === true || spawned.name.toLowerCase() === 'lostsoul') {
      spawnProjectileEntity(project, state, entity, spawned);
      return;
    }
    // Offsets and velocity are relative to the spawner's facing; the angle rotates
    // the horizontal velocity, which is how trail particles are spread out.
    const facing = (entity?.angle ?? 0) * Math.PI / 180;
    const side = facing - Math.PI / 2;
    const ox = numArg(ctx, 1, 0), oy = numArg(ctx, 2, 0);
    const vx = numArg(ctx, 4, 0), vy = numArg(ctx, 5, 0), vz = numArg(ctx, 6, 0);
    const spin = numArg(ctx, 7, 0) * Math.PI / 180;
    const speed = Math.hypot(vx, vy);
    const direction = spin || (speed ? Math.atan2(vy, vx) : facing);
    spawnEffect(project, state, spawned.name, {
      x: entity.x + Math.cos(facing) * oy + Math.cos(side) * ox,
      y: entity.y + Math.sin(facing) * oy + Math.sin(side) * ox,
      z: (entity.z ?? floorAt(state, entity)) + numArg(ctx, 3, 0),
      vx: Math.cos(direction) * speed, vy: Math.sin(direction) * speed, vz,
    });
  },
  A_SpawnItem(ctx) {
    ACTIONS.A_SpawnItemEx(ctx);
  },
  A_CustomBulletAttack(ctx) {
    const pellets = Math.max(1, Math.min(20, numArg(ctx, 2, 1))), damage = numArg(ctx, 3, 3), spread = numArg(ctx, 0, 0) / 2;
    for (let pellet = 0; pellet < pellets; pellet++) monsterHitscan(ctx, damage, 3, spread);
  },
  A_CustomPunch(ctx) {
    if (!meleeable(ctx.state, ctx.entity)) return;
    monsterHitscan(ctx, numArg(ctx, 0, 2), 10);
  },
  A_CustomMeleeAttack(ctx) {
    if (!meleeable(ctx.state, ctx.entity)) return;
    monsterHitscan(ctx, numArg(ctx, 0, 2), 8);
    saySound(ctx.state, String(arg(ctx, 1) || ''), ctx.entity);
  },
  // Morphing swaps the actor a thing runs; the entity id and physics body stay put.
  A_Morph(ctx) {
    const className = arg(ctx, 0);
    morphEntity(ctx.project, ctx.state, ctx.entity, className && typeof className === 'string'
      ? className.replace(/^"|"$/g, '') : className, { duration: numArg(ctx, 1, 0), style: numArg(ctx, 2, 0) });
  },
  A_UnMorphActor(ctx) {
    const target = morphTarget(ctx.state, numArg(ctx, 0, 0), ctx.entity.id);
    unmorphEntity(ctx.project, ctx.state, target || ctx.entity, Boolean(numArg(ctx, 1, 0)));
  },
  A_UnMorph(ctx) { unmorphEntity(ctx.project, ctx.state, ctx.entity, true); },
  A_PrintBold(ctx) { if (arg(ctx, 0)) ctx.state.message = String(arg(ctx, 0)); },
  A_Print(ctx) { if (arg(ctx, 0)) ctx.state.message = String(arg(ctx, 0)); },
  A_FadeOut() {},
  A_SetTranslucent() {},
  A_SetRenderStyle() {},
  A_Quake() {},
  A_Warp() {},
  A_SetUserVar() {},
  A_SetUserArray() {},
  A_CheckFloor() {},
  A_ZoomFactor() {},
  A_WeaponOffset() {},
  A_SetPitch() {},
  A_SetRoll() {},
  A_StopSoundEx() {},
  // Weapon-only actions are no-ops for monsters and vice versa.
  A_WeaponReady() {}, A_ReFire() {}, A_GunFlash() {}, A_Light0() {}, A_Light1() {}, A_Light2() {},
  A_Raise() {}, A_Lower() {}, A_CheckReload() {}, A_Refire() {},
};

/** Hitscan damage from an enemy to the player, using Doom's damage dice. */
function enemyShot(state, entity, damage, diceSides, spread = 0) {
  enemyHitscan(state, entity, { damage, diceSides, pellets: 1, spread, range: 2048 });
}

/** Plays a sound through the runtime's sound list, resolving Doom aliases. */
export function saySound(state, name, entity, volume = 127) {
  if (!name) return;
  // The name is kept verbatim: it may be a logical alias (`grunt/sight`) or a lump
  // name (`DSPOSIT1`), and the audio player resolves both case-insensitively.
  state.sounds.push({ name: String(name), volume: Math.min(1, Math.max(0, volume / 127)),
    position: entity ? { x: entity.x, y: entity.y } : undefined });
}

/** Spawns a full actor entity (a Lost Soul, a projectile with states, ...). */
function spawnProjectileEntity(project, state, owner, actor) {
  if (state.entities.length >= 900) return null;
  const angle = Math.atan2(state.player.y - owner.y, state.player.x - owner.x);
  const entity = {
    id: `spawned_${state.spawnSequence = (state.spawnSequence || 0) + 1}`, type: 'enemy', name: actor.name, actorId: actor.id, actorName: actor.name,
    x: owner.x, y: owner.y, z: floorAt(state, owner), angle: angle * 180 / Math.PI,
    health: actor.health || 20, elevation: 0, spawnedFrom: owner.id,
  };
  if ((actor.flags?.COUNTKILL) === true || actor.name.toLowerCase() === 'lostsoul') state.entities.push(entity);
  return entity;
}

/**
 * Steps every imported actor state machine. Called from the runtime once per
 * frame; it converts real time into 35 Hz tics so states keep Doom's pacing.
 */
export function stepActors(project, state, dt) {
  if (!project.actors?.length) return;
  state.actorClock = (state.actorClock || 0) + dt * TIC_RATE;
  // Floating point drift makes 1/35 * 35 = 0.999..., so the epsilon keeps the
  // tic rate exact for frame intervals that divide evenly.
  const whole = Math.floor(state.actorClock + 1e-6);
  const tics = Math.min(whole, MAX_TICS_PER_STEP);
  state.actorClock -= whole;
  for (let tic = 0; tic < tics; tic++) {
    for (const entity of state.entities) {
      if (entity.type !== 'enemy') continue;
      // A dead monster finishes its Death state and then rests on its corpse
      // frame; it must keep ticking until the state machine ends.
      if (entity.health <= 0 && !entity.actorDeadHandled) {
        entity.actorDeadHandled = true;
        setActorState(project, entity, 'Death');
      }
      const runtime = actorStateOf(entity);
      if (runtime.index === null && runtime.initialised) continue;
      actorTic(project, state, entity);
    }
  }
}

/**
 * Gives imported entities their actor identity before the first tic: health,
 * collision size and speed come from the actor definition, so a monster behaves
 * like the game defines even when no scripted rule ever touched it.
 */
export function initialiseActorEntities(project, entities) {
  if (!project.actors?.length) return entities;
  const index = projectActorIndex(project);
  for (const entity of entities) {
    if (entity.type !== 'enemy' || entity.actorResolved) continue;
    const actor = (entity.doomType !== undefined && index.byDoomed.get(entity.doomType)) ||
      (entity.actorName && index.byName.get(String(entity.actorName).toLowerCase())) || null;
    entity.actorResolved = true;
    if (!actor) continue;
    entity.actorId = actor.id;
    entity.actorName = actor.name;
    if (entity.health === undefined) entity.health = Math.max(1, actor.health || 20);
    entity.maxHealth = entity.health;
    entity.radius ??= actor.radius;
    entity.height ??= actor.height;
  }
  return entities;
}

/**
 * Weapon runtime.
 *
 * Doom weapons are actors too: their `Ready`/`Fire`/`Flash` state blocks call
 * action functions such as `A_FireBullets` or `A_FireMissile`. Running those
 * states reproduces a mod's real fire rate, ammo use and damage instead of a
 * hardcoded table.
 */

const WEAPON_ACTOR_BY_SLOT = {
  fist: ['Fist', 'Punch'], chainsaw: ['Chainsaw'], pistol: ['Pistol'],
  shotgun: ['Shotgun'], superShotgun: ['SuperShotgun', 'Shotgun2'], chaingun: ['Chaingun'],
  rocketLauncher: ['RocketLauncher', 'MissileLauncher'], plasmaRifle: ['PlasmaRifle', 'PlasmaGun'],
  bfg: ['BFG9000', 'BFG'],
};
const AMMO_BY_NAME = { bullets: 'bullets', shells: 'shells', rockets: 'rockets', cells: 'cells',
  clip: 'bullets', clipbox: 'bullets', shell: 'shells', shellbox: 'shells', rocketammo: 'rockets',
  rocketbox: 'rockets', cell: 'cells', cellpack: 'cells', ammo: 'bullets', backpack: 'bullets' };

/** The weapon actor record for a weapon slot, when the project defines one. */
export function weaponActor(project, slot) {
  const index = projectActorIndex(project);
  for (const name of WEAPON_ACTOR_BY_SLOT[slot] || []) {
    const actor = index.byName.get(name.toLowerCase());
    if (actor?.flags?.WEAPON) return actor;
  }
  return null;
}

/** Ammo type/use declared by a weapon actor's `Weapon.AmmoType`/`AmmoUse`. */
export function weaponAmmo(actor) {
  const type = actor?.weaponAmmoType || null;
  return { type: type ? AMMO_BY_NAME[String(type).toLowerCase()] || null : null, use: actor?.weaponAmmoUse ?? 1 };
}

/** Puts the player's weapon into `Ready`, or keeps it there. */
export function beginWeapon(project, state, slot) {
  const actor = weaponActor(project, slot);
  if (!actor) { state.weaponActor = null; return false; }
  state.weaponActor = { actor, index: labelIndex(actor, 'Ready') ?? 0, tics: 0, entered: false, ready: false, flash: null };
  state.weaponSlot = slot;
  return true;
}

/** Steps the player's weapon state machine for one 35 Hz tic. */
export function weaponTic(project, state, attackHeld) {
  const runtime = state.weaponActor;
  if (!runtime?.actor) return;
  const actor = runtime.actor;
  const frames = actor.states.frames;
  const frame = frames[runtime.index];
  if (!frame) { runtime.index = labelIndex(actor, 'Ready') ?? 0; return; }
  const context = { project, state, entity: state.player, actor, weapon: true, runtime };
  if (frame.kind !== 'frame') {
    runtime.entered = false;
    if (frame.kind === 'stop' || frame.kind === null) { runtime.index = labelIndex(actor, 'Ready') ?? 0; return; }
    if (frame.kind === 'goto' || frame.kind === 'loop') {
      const target = labelIndex(actor, frame.kind === 'loop' ? frame.label : frame.target);
      runtime.index = target ?? labelIndex(actor, 'Ready') ?? 0;
      return;
    }
    runtime.index++;
    return;
  }
  runtime.ready = false;
  if (!runtime.entered) {
    runtime.entered = true;
    for (const action of frame.actions) runWeaponAction(context, action);
  }
  if (runtime.jumped) { runtime.jumped = false; return; }
  if (frame.duration < 0) return;
  runtime.tics++;
  if (runtime.tics < frame.duration) return;
  runtime.tics = 0;
  runtime.entered = false;
  runtime.index++;
}

/**
 * Weapon-specific action functions. Kept in step with `runWeaponAction` by a test
 * that reads the switch labels, so the coverage report cannot drift from the code.
 */
export const WEAPON_ACTION_NAMES = new Set(['A_WeaponReady', 'A_ReFire', 'A_CheckReload', 'A_GunFlash',
  'A_Light0', 'A_Light1', 'A_Light2', 'A_Raise', 'A_Lower', 'A_FireBullets', 'A_FireCustomMissile',
  'A_FireProjectile', 'A_FireMissile', 'A_FirePlasma', 'A_FireBFG', 'A_FireCGun', 'A_FireShotgun', 'A_FireShotgun2',
  'A_Punch', 'A_Saw', 'A_FirePistol', 'A_PlaySound', 'A_StartSound', 'A_BFGsound', 'A_OpenShotgun2',
  'A_LoadShotgun2', 'A_CloseShotgun2']);

/**
 * Actions a weapon state may call that only change presentation. `runWeaponAction`
 * ignores them on purpose, so they are not reported as missing gameplay.
 */
export const WEAPON_COSMETIC_ACTIONS = new Set(['A_WeaponOffset', 'A_SetPitch', 'A_SetRoll', 'A_ZoomFactor',
  'A_FadeOut', 'A_SetTranslucent', 'A_SetRenderStyle', 'A_Quake', 'A_Warp', 'A_SetUserVar',
  'A_SetUserArray', 'A_CheckFloor', 'A_StopSoundEx', 'A_ClearReFire', 'A_Refire']);

/** Whether an action function has an implementation on the path that runs it. */
export function actionSupported(name, weapon = false) {
  // Weapons run their own switch, so a generic action such as A_Jump is still a real
  // gap there even though monsters execute it from the shared table.
  if (weapon) return WEAPON_ACTION_NAMES.has(name) || WEAPON_COSMETIC_ACTIONS.has(name);
  return name in ACTIONS;
}

/**
 * The actors the active level actually runs: things placed in the map, the weapon
 * slots, and any actor an action argument names (spawned projectiles rather than
 * the whole imported table, which also describes games this level never uses).
 */
export function usedActors(project) {
  const index = projectActorIndex(project);
  const used = new Map();
  const add = actor => { if (actor && !used.has(actor.name)) used.set(actor.name, actor); };
  const fromThing = thing => (thing.actorId && index.byId.get(thing.actorId)) ||
    (thing.actorName && index.byName.get(String(thing.actorName).toLowerCase())) ||
    (thing.doomType !== undefined && index.byDoomed.get(thing.doomType)) || null;
  for (const entity of project.map?.entities || []) add(fromThing(entity));
  for (const slot of Object.keys(WEAPON_ACTOR_BY_SLOT)) add(weaponActor(project, slot));
  // Two passes are enough to follow "monster spawns a projectile".
  for (let pass = 0; pass < 2; pass++) {
    for (const actor of [...used.values()]) {
      for (const frame of actor.states?.frames || []) {
        for (const action of frame.actions || []) {
          for (const value of action?.args || []) {
            if (typeof value !== 'string') continue;
            const name = value.trim().replace(/^"+|"+$/g, '').toLowerCase();
            if (name) add(index.byName.get(name));
          }
        }
      }
    }
  }
  return [...used.values()];
}

/**
 * Action functions the level's own actors and weapons call that this runtime
 * cannot execute, with the actors that use them. Anything here is skipped at the
 * frame that calls it, so it is a real gameplay gap rather than a cosmetic one.
 */
export function unsupportedActorActions(project) {
  const gaps = new Map();
  for (const actor of usedActors(project)) {
    const weapon = Boolean(actor.flags?.WEAPON);
    for (const frame of actor.states?.frames || []) {
      for (const action of frame.actions || []) {
        const name = typeof action === 'string' ? action : action?.name;
        if (!name || actionSupported(name, weapon)) continue;
        let gap = gaps.get(name);
        if (!gap) gaps.set(name, gap = { name, calls: 0, actors: [] });
        gap.calls++;
        if (gap.actors.length < 12 && !gap.actors.includes(actor.name)) gap.actors.push(actor.name);
      }
    }
  }
  return [...gaps.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

/** Merges per-level gap reports into one game-wide list. */
export function mergeActorActionGaps(reports) {
  const merged = new Map();
  for (const report of reports) for (const gap of report || []) {
    let entry = merged.get(gap.name);
    if (!entry) merged.set(gap.name, entry = { name: gap.name, calls: 0, actors: [] });
    entry.calls += gap.calls;
    for (const actor of gap.actors) if (entry.actors.length < 12 && !entry.actors.includes(actor)) entry.actors.push(actor);
  }
  return [...merged.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

/** One import-report sentence naming the gaps and where to look them up. */
export function describeActorActionGaps(gaps, scope = "this level's actors") {
  const names = gaps.slice(0, 8).map(gap => gap.name).join(', ');
  const more = gaps.length > 8 ? `, and ${gaps.length - 8} more` : '';
  return `${gaps.length} action function(s) called by ${scope} have no engine equivalent and are skipped: `
    + `${names}${more}. The Actors tab lists them with the actors that use them, and MCP actor_unsupported reports the full set.`;
}

/** Weapon action handling, with Doom's refire/flash semantics. */
function runWeaponAction(ctx, action) {
  const { state, actor, runtime } = ctx;
  const args = action.args || [];
  switch (action.name) {
    case 'A_WeaponReady': {
      runtime.ready = true;
      state.weaponReady = true;
      // GZDoom consumes the attack button here: a held trigger starts the weapon's
      // own Fire sequence, which is why A_ReFire (not this) decides refiring.
      if (!state.weaponTriggerHeld || state.hudState?.cursor) return;
      const fire = labelIndex(actor, 'Fire');
      if (fire === null) return;
      runtime.index = fire; runtime.tics = 0; runtime.entered = false; runtime.jumped = true;
      runtime.ready = false; state.weaponReady = false;
      return;
    }
    case 'A_ReFire':
      // Doom re-enters Fire while the trigger is held, otherwise returns to Ready.
      if (state.weaponTriggerHeld) { teleportWeapon(runtime, actor, 'Fire'); return; }
      teleportWeapon(runtime, actor, 'Ready');
      return;
    case 'A_CheckReload':
      if (!weaponHasAmmo(state, actor)) teleportWeapon(runtime, actor, 'Ready');
      return;
    case 'A_GunFlash': {
      const flash = labelIndex(actor, 'Flash');
      if (flash !== null) state.weaponFlash = { index: flash, tics: 0, entered: false };
      return;
    }
    case 'A_Light0': state.weaponLight = 0; return;
    case 'A_Light1': state.weaponLight = 1; return;
    case 'A_Light2': state.weaponLight = 2; return;
    case 'A_Raise': state.weaponRaised = false; return;
    case 'A_Lower': state.weaponRaised = true; return;
    case 'A_FireBullets':
    case 'A_FireCustomMissile':
    case 'A_FireProjectile':
    case 'A_FireMissile':
    case 'A_FirePlasma':
    case 'A_FireBFG':
    case 'A_FireCGun':
    case 'A_FireShotgun':
    case 'A_FireShotgun2':
    case 'A_Punch':
    case 'A_Saw':
    case 'A_FirePistol':
      fireWeapon({ ...ctx, args, named: action.named || {} }, action.name);
      return;
    case 'A_PlaySound':
    case 'A_StartSound':
      saySound(state, String(args[0] || ''), null, 110);
      return;
    // The weapon's own mechanics sounds, which Doom's states call directly.
    case 'A_BFGsound': saySound(state, 'weapons/bfgf', null, 127); return;
    case 'A_OpenShotgun2': saySound(state, 'weapons/sshoto', null, 127); return;
    case 'A_LoadShotgun2': saySound(state, 'weapons/sshotl', null, 127); return;
    case 'A_CloseShotgun2': saySound(state, 'weapons/sshotc', null, 127); return;
    default:
      // Animation-only weapon actions (bobbing, offsets) need no simulation.
      return;
  }
}

function teleportWeapon(runtime, actor, label) {
  const target = labelIndex(actor, label);
  if (target === null) return;
  // A jump inside a frame's action replaces the rest of that state's advance, so
  // the frame loop must not also step past the state it just entered.
  runtime.index = target; runtime.tics = 0; runtime.entered = false; runtime.jumped = true;
}

function weaponHasAmmo(state, actor) {
  const { type, use } = weaponAmmo(actor);
  if (!type) return true;
  return (state.playerStats[type] || 0) >= (use || 1);
}

/**
 * Fires the player's weapon from its own action call. Damage, spread and pellet
 * counts come from the arguments the mod wrote, so a modded shotgun behaves
 * like the mod intends.
 */
// GZDoom's native weapon action functions start their own CHAN_WEAPON sound. A
// DECORATE/ZScript weapon only names the action, so the shot is silent unless the
// sound is played here. Names are logical SNDINFO aliases, not lump names.
const FIRE_SOUNDS = {
  A_FirePistol: 'weapons/pistol', A_FireShotgun: 'weapons/shotgf', A_FireShotgun2: 'weapons/sshotf',
  A_FireCGun: 'weapons/chngun', A_FireMissile: 'weapons/rocklf', A_FirePlasma: 'weapons/plasmaf',
  A_FireBFG: 'weapons/bfgf', A_Saw: 'weapons/sawfull', A_Punch: '*fist',
};

function fireWeapon(ctx, actionName) {
  const { state, actor } = ctx;
  // A_FireCustomMissile/A_FireProjectile take `useammo` as their third argument, so
  // a rocket-level hitbox fired with `false` must not spend a rocket.
  const custom = actionName === 'A_FireCustomMissile' || actionName === 'A_FireProjectile';
  const spendAmmo = !custom || !(arg(ctx, 2, true) === false || numArg(ctx, 2, 1) === 0);
  const { type, use } = weaponAmmo(actor);
  if (type && spendAmmo) {
    const cost = use || 1;
    if ((state.playerStats[type] || 0) < cost) { state.weaponTriggerHeld = false; return; }
    state.playerStats[type] -= cost;
  }
  if (FIRE_SOUNDS[actionName]) saySound(state, FIRE_SOUNDS[actionName], null, 127);
  const missile = (name, damage, radius) => {
    const resolved = missileProjectile(ctx.project, name);
    const amount = Number(resolved?.damage);
    state.weaponAttack = { kind: 'missile', missile: resolved?.name || name,
      damage: Number.isFinite(amount) && amount > 0 ? amount : damage, diceSides: 8,
      speed: resolved?.speed || 700, radius, actorId: resolved?.actorId || null,
      seeker: resolved?.seeker === true };
  };
  switch (actionName) {
    case 'A_FireBullets': {
      const spread = numArg(ctx, 0, 0), pellets = Math.max(1, Math.min(40, numArg(ctx, 2, 1)));
      const damage = Math.max(1, numArg(ctx, 3, 5)), range = numArg(ctx, 9, 2048) || 2048;
      state.weaponAttack = { kind: 'hitscan', damage: [damage, Math.max(1, numArg(ctx, 1, 3))], pellets, spread, range };
      break;
    }
    case 'A_FireShotgun': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 7, spread: 11.25, range: 2048 }; break;
    case 'A_FireShotgun2': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 20, spread: 22.5, range: 2048 }; break;
    case 'A_FireCGun': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 5.625, range: 2048 }; break;
    case 'A_FirePistol': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 }; break;
    case 'A_Punch': state.weaponAttack = { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64 }; break;
    case 'A_Saw': state.weaponAttack = { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64, hitSound: 'weapons/sawhit' }; break;
    // The actor's own Death state carries the explosion (the rocket's A_Explode, the
    // BFG ball's A_BFGSpray), so no radius is invented here. The fallbacks keep a
    // project without an actor table playable.
    case 'A_FireMissile': missile('Rocket', 20, 128); if (state.weaponAttack?.actorId) state.weaponAttack.radius = 0; break;
    case 'A_FirePlasma': missile('PlasmaBall', 5, 0); break;
    case 'A_FireBFG': missile('BFGBall', 100, 256); if (state.weaponAttack?.actorId) state.weaponAttack.radius = 0; break;
    case 'A_FireCustomMissile':
    case 'A_FireProjectile': {
      const className = String(arg(ctx, 0) || '').replace(/^"|"$/g, '');
      const resolved = missileProjectile(ctx.project, className);
      // No placeholder: a weapon that names a class the project does not contain
      // does not fire, and the shot is reported rather than faked.
      if (!resolved) { state.missileGaps ||= new Set(); if (state.missileGaps.size < 40) state.missileGaps.add(className); return; }
      state.weaponAttack = { kind: 'missile', missile: resolved.name, actorId: resolved.actorId,
        damage: resolved.damage > 0 ? resolved.damage : 1, diceSides: 8, speed: resolved.speed,
        radius: 0, seeker: resolved.seeker,
        angle: numArg(ctx, 1, 0), spawnofs: numArg(ctx, 3, 0), spawnheight: numArg(ctx, 4, 0),
        pitch: numArg(ctx, 6, 0) };
      return;
    }
    default: state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 };
  }
}
