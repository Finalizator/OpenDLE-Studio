import { sectorAt } from './sectors.js';
import { damagePlayer, floorAt, canSeePlayer, canSeeTarget, randomDamage, enemyHitscan, moveEnemy, geometryDistance,
  entityDistance, projectileSource, canHearPlayer, checkMeleeRange, sightEyeHeight, SIGHT_RANGE } from './combat.js';
import { actorIndex, actorForThing, isBossBrainActor, NATIVE_EFFECT_ACTORS, dropItemNumber } from './actors.js';
import { actorProjectileClips, actorEffectClip, setSpriteState, spriteAssetNames, applyActorSpriteStates } from './sprite-animation.js';
import { morphEntity, unmorphEntity, morphTarget } from './morph.js';
import { actorFunctionSource, runActorFunction } from './actor-functions.js';
import { floorHeightAt } from './three-d-floors.js';
import { doomThings } from './doom-assets.js';

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
/**
 * Line specials import this module, so importing them back would be a cycle that
 * breaks module initialisation; line-specials.js hands its executor over instead.
 * A function declaration is hoisted, so registration works in either load order.
 */
export function registerSpecialExecutor(run) {
  registerSpecialExecutor.run = run;
}

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
  // A frame whose picture does not exist draws nothing at all. Doom's `TNT1` is exactly that —
  // a sprite that is deliberately never drawn — and a barrel's blast ends on one while it waits
  // out the respawn clock. Falling back to the last picture instead is what left a spent barrel
  // standing on the last frame of its own explosion.
  // Only frames are pictures: a `goto`/`loop`/`stop` record carries none, and it is passed
  // through on the same tic, so hiding the actor there would blink it off and forget its clip.
  if (entity.spriteStates && frame?.kind === 'frame') {
    const names = spriteAssetNames(project), sprite = String(frame.sprite || '').toUpperCase();
    const asset = sprite ? names.get(`${sprite}${frame.letter}0`) || names.get(`${sprite}${frame.letter}1`) || null : null;
    if (!asset) {
      state.spriteAnimations.delete(entity.id);
      entity.spriteAsset = null;
      return;
    }
    entity.spriteAsset = asset;
  }
  const name = SPRITE_STATE_BY_LABEL[String(frame?.label || '').toLowerCase()];
  if (!name || !entity.spriteStates?.[name]) return;
  // A pain clip is restarted when the actor *enters* Pain, not on every tic it stays there:
  // restarting it each tic held the flinch on its first frame and played it all over again
  // after the state had already handed the actor back to See.
  const entering = runtime.sprite !== name;
  runtime.sprite = name;
  // Asked every tic rather than only when the wanted name changes: `setSpriteState` declines to
  // cut a one-shot clip short, and the state machine finishes its pain frames while the machine
  // is already back in See. Remembering the name meant that refusal was never retried, so the
  // pain picture stayed on screen for ever.
  if (entering || name !== 'pain') setSpriteState(project, state, entity, name, entering && name === 'pain');
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

/**
 * The states nothing may cut short.
 *
 * Doom runs Pain to completion — six tics for a zombieman — and the death states never give way
 * to anything. A translated monster's AI is a rule that says "be in See" or "be in Missile" every
 * frame, so without this a hit's pain state was replaced on the very next frame, before one of its
 * frames could run, and an imported monster never appeared to flinch at all.
 */
const UNINTERRUPTIBLE_STATES = new Set(['pain', 'death', 'xdeath']);

/** Whether an actor is in a state a rule may not pull it out of (a flinch, a death throe). */
export function actorStateBusy(entity) {
  return UNINTERRUPTIBLE_STATES.has(String(entity?.stateLabel || '').toLowerCase());
}

/** Places an entity's state machine at a label (Spawn for new monsters). */
export function setActorState(project, entity, label, { restart = false, ifDifferent = false } = {}) {
  const actor = actorOf(project, entity);
  if (!actor) return false;
  const state = actorStateOf(entity);
  const target = labelIndex(actor, label);
  if (target === null) return false;
  // A rule that says "be in this state" every frame must not restart the animation each
  // time; the machine's own state changes keep their restart behaviour. It must not end a
  // flinch either: the rule is the translation of A_Chase/A_Look, which run *inside* a state.
  if (ifDifferent) {
    if (state.index !== null && entity.stateLabel === String(label)) return true;
    if (actorStateBusy(entity)) return true;
  }
  if (!restart && state.index === target) return true;
  state.index = target;
  state.tics = 0;
  // Entering a new state means its first frame has not run yet, even when the
  // change happened from inside the previous frame's action list.
  state.entered = false;
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
  // A skull cube does not chase anything: it flies a straight line to the spot it was aimed
  // at, which is what `P_SpawnMissile` sets up in Doom for this one actor.
  if (entity.flight) advanceFlight(entity);
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
  // The sprite follows the state the machine is in, every tic. It used to be set only when
  // the machine landed on a `goto` or a label, which meant a state entered by that `goto`
  // never showed: a monster's pain clip stayed on screen after it had gone back to See, and
  // a barrel kept its standing frame through the whole explosion.
  syncActorSprite(project, state, entity, actor, runtime);
  if (frame.kind === 'frame') {
    if (runtime.tics <= 0) runtime.tics = Math.max(0, frame.duration);
    // Actions execute once, when the frame is entered.
    if (!runtime.entered) {
      runtime.entered = true;
      const enteredIndex = runtime.index;
      runActions(project, state, entity, actor, frame.actions, { moveTarget });
      // An action may have moved the machine (A_Jump, A_Look, A_Chase, Pain, ...).
      // The new state's first frame must run from the top on the next tic, not be
      // skipped by this frame's own countdown and advance.
      if (runtime.index !== enteredIndex) return;
    }
    if (frame.duration < 0) return;
    runtime.tics--;
    if (runtime.tics > 0) return;
    runtime.entered = false;
    runtime.index++;
    return;
  }
  // Non-frame records immediately move the machine.
  runtime.entered = false;
  if (frame.kind === 'stop') { runtime.index = null; runtime.stopped = true; return; }
  // Doom's S_NULL: the state does not hold a frame, the thing leaves the level. A barrel's
  // blast ends this way, which is why a destroyed barrel is gone rather than standing on the
  // last picture of its own explosion.
  if (frame.kind === 'null') { runtime.index = null; runtime.stopped = true; runtime.gone = true; return; }
  if (frame.kind === 'goto' || frame.kind === 'loop') {
    const target = frame.kind === 'loop' ? frame.label : frame.target;
    const resolved = labelIndex(actor, target);
    runtime.index = resolved === null ? null : resolved;
    // A rule asks which state an actor is in; a `goto` back into a label counts.
    if (resolved !== null) entity.stateLabel = String(target);
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
    // The actor running the state is the script's activator, as in GZDoom.
    { always, wantResult, activator: !ctx.entity || ctx.entity.type === 'player' ? 'player' : ctx.entity.id });
  if (wantResult && ctx.named.Result !== undefined) ctx.named.Result = result;
}

function suspendAcs(ctx, named, terminate = false) {
  const scripts = ctx.state.scripts;
  if (!scripts) return;
  const selector = named ? arg(ctx, 0) : Number(arg(ctx, 0)) || 0;
  if (terminate) scripts.terminate(selector);
  else scripts.suspend(selector);
}

/**
 * The monster decisions a rule takes over once the archetype is translated.
 *
 * Everything else a state frame calls — sounds, death, item drops, the attack
 * functions themselves — keeps running, so the state stays the description of what
 * the actor is and the sheet is the description of what it decides.
 */
import { PROJECTILE_ACTIONS } from './projectile-script.js';
import { PROP_FUNCTIONS } from './enemy-script.js';

export const AI_ACTIONS = new Set(['A_Look', 'A_LookEx', 'A_Wander', 'A_Chase', 'A_FaceTarget',
  'A_AlertMonsters', 'A_CPosRefire', 'A_FastChase', 'A_SmartChase',
  // The other engines' names for the same decisions: a monster whose AI is driven by rules must
  // not also wake itself from its own state machine.
  'A_Look2', 'A_MarineLook', 'A_IceGuyLook', 'A_MinotaurLook', 'A_TurretLook', 'A_StalkerLookInit', 'A_WraithInit']);

function aiSuppressed(state, entity) {
  const name = entity?.actorName;
  return Boolean(name) && Array.isArray(state.enemyEventActors) &&
    state.enemyEventActors.includes(String(name).toLowerCase());
}

export function runActions(project, state, entity, actor, actions, context = {}) {
  const suppressed = aiSuppressed(state, entity);
  const propOwned = Array.isArray(state.propEventActors) && entity?.actorName &&
    state.propEventActors.includes(String(entity.actorName).toLowerCase());
  for (const action of actions || []) {
    // A translated archetype decides through its rules; the state machine keeps the
    // frames, the sounds and the attack functions.
    if (suppressed && AI_ACTIONS.has(action.name)) continue;
    // A translated prop's blast and solidity are its rules' business.
    if (propOwned && PROP_FUNCTIONS.has(action.name)) continue;
    const handler = ACTIONS[action.name];
    if (!handler) {
      // A frame may call one of the actor's own functions (`PLAY A 1 Rotate;` with
      // `void Rotate() { angle += 1; }`). Its body is executed as written.
      const source = actorFunctionSource(actor, action.name);
      if (source !== null) {
        // A function may call an engine action: it runs with the same actor context, so
        // `A_PlaySound("x")` inside a mod's own function behaves like the frame calling it.
        const call = (name, args) => {
          const inner = ACTIONS[name];
          if (!inner) throw new Error(`unknown action ${name}`);
          inner({ project, state, entity, actor, action, args, named: {} });
        };
        const result = runActorFunction(entity, source, call);
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
const truthyArg = value => value === true || (typeof value === 'string' ? /^(true|[1-9]\d*)$/i.test(value.trim()) : Number(value) !== 0 && Boolean(value));
const projectilesByName = project => projectActorIndex(project);
// `sv_corpsequeuesize`'s default: Hexen keeps 64 bodies and destroys the oldest past that.
const CORPSE_QUEUE_SIZE = 64;
// The Heresiarch's satellites (heresiarch.zs): they start at 7 degrees a tic and spin up to 25, and a
// popped ball bounces for half a second at a time for five seconds before it bursts.
const SORC_INITIAL_SPEED = 7;
const SORC_TERMINAL_SPEED = 25;
const SORC_BOUNCE_UNIT = 17;
// A_SpawnItemEx flags that change how its offsets, angle and velocity are read.
const SPAWN_FLAGS = { sxf_absoluteposition: 2, sxf_absoluteangle: 4, sxf_absolutemomentum: 8, sxf_absolutevelocity: 8 };
/** A flags argument written as a number or as `NAME|NAME|4`; unknown names count as 0. */
const flagArg = (ctx, index, names) => {
  const value = arg(ctx, index, 0);
  if (typeof value === 'number') return value | 0;
  return String(value ?? '').split('|').reduce((flags, part) => {
    const name = part.trim().replace(/^"|"$/g, '').toLowerCase();
    const number = Number(name);
    return flags | (Number.isFinite(number) ? number | 0 : names[name] || 0);
  }, 0);
};
/** The direction a thing faces in degrees; a missile faces the way it flies. */
const facingOf = entity => Number.isFinite(entity?.angle) ? entity.angle
  : Number.isFinite(entity?.dx) && Number.isFinite(entity?.dy) && (entity.dx || entity.dy) ? Math.atan2(entity.dy, entity.dx) * 180 / Math.PI : 0;
/** `Inventory.MaxAmount` of a named item class, or null when the project does not declare one. */
const inventoryMaxAmount = (project, item) => {
  const name = String(item || '').toLowerCase();
  const actor = (project?.actors || []).find(candidate => String(candidate.name || '').toLowerCase() === name);
  return Number.isFinite(actor?.inventoryMaxAmount) ? actor.inventoryMaxAmount : null;
};
/** GZDoom's CheckInventory: a positive amount needs that many, 0 needs the item at its maximum. */
const hasInventory = (project, runtime, item, amount) => {
  const held = runtime.inventory.get(item) || 0;
  if (held <= 0) return false;
  return amount > 0 ? held >= amount : held >= (inventoryMaxAmount(project, item) ?? 1);
};

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
/**
 * The actor a missile class names, without building its clips.
 *
 * Translating a weapon asks what class a state fires, not what it looks like; going
 * through `missileProjectile` would build sprites clips before the artwork is imported
 * and leave the project's sprite index remembering nothing.
 */
export function missileActor(project, name) {
  const index = projectilesByName(project);
  return index.byName.get(String(name || '').toLowerCase()) ||
    index.byId.get(`actor_${String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_')}`) || null;
}

export function missileProjectile(project, name) {
  const actor = missileActor(project, name);
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
/**
 * A roll between two numbers, ends included.
 *
 * `randomDamage(state, base, sides)` is Doom's `((P_Random() % sides) + 1) * base`, which is a
 * damage roll, not a range: `randomDamage(state, -64, 63)` multiplies by a negative base.
 */
const randomRange = (state, min, max) => min + randomDamage(state, 1, Math.max(1, max - min + 1)) - 1;

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
  const translated = Array.isArray(state.projectileEventActors) &&
    state.projectileEventActors.includes(String(actor?.name || '').toLowerCase());
  for (const action of actions || []) {
    if (PROJECTILE_UNSAFE.has(action.name)) continue;
    // A translated missile's flight and death are its rules' business.
    if (translated && PROJECTILE_ACTIONS.has(action.name)) continue;
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

/**
 * A blast at a point, for an `A_Explode` frame or a rule's `explodeArea` action.
 *
 * Like P_RadiusAttack, a blast only reaches what the explosion point can see: a wall
 * between them shelters the thing behind it.
 */
export function explodeAt(project, state, entity, damage = 128, radius = 128, damageType = null) {
  const falloff = distance => Math.max(0, Math.round(damage * (1 - distance / radius)));
  const reaches = target => canSeeTarget(state, entity, target, Infinity);
  const playerDistance = Math.hypot(state.player.x - entity.x, state.player.y - entity.y);
  if (playerDistance < radius && reaches(state.player)) damagePlayer(state, falloff(playerDistance));
  for (const other of state.entities) {
    if (other === entity || other.type !== 'enemy' || other.health <= 0) continue;
    // `+NORADIUSDMG` is the Cyberdemon's and the Spider Mastermind's armour: a rocket that lands
    // beside one does nothing at all. Without it a rocket at their feet killed them, which is the
    // one thing Doom deliberately makes impossible.
    if (actorFlag(actorOf(project, other), 'NORADIUSDMG', other)) continue;
    const distance = Math.hypot(other.x - entity.x, other.y - entity.y);
    if (!(distance < radius) || !reaches(other)) continue;
    const amount = falloff(distance);
    hurtActor(project, state, other, amount, blastSource(state, entity), damageType);
    // Doom's `P_DamageMobj` throws what it hits: a blast that damages a barrel shoves it away
    // before it goes off, which is why a row of barrels scatters as it chain-reacts. The push
    // is `damage * 12.5 / Mass` units a tic — momentum this engine keeps in units a second.
    const mass = other.mass ?? actorOf(project, other)?.mass ?? 100;
    if (amount > 0 && mass > 0) {
      const angle = Math.atan2(other.y - entity.y, other.x - entity.x);
      const thrust = amount * 12.5 / mass * TIC_RATE;
      other.vx = (other.vx || 0) + Math.cos(angle) * thrust;
      other.vy = (other.vy || 0) + Math.sin(angle) * thrust;
    }
  }
  saySound(state, 'DSBAREXP', entity);
}

/**
 * Advances the momentum a blast (or an `A_Recoil`) gave a thing, one Doom tic at a time.
 *
 * Doom's `P_XYMovement` slides a thing along its momentum and slows it by Friction every tic,
 * which is what makes a shoved barrel travel a few dozen units and stop. Enemies are otherwise
 * moved by their AI (`moveEnemy`), so this momentum lives beside it rather than inside it.
 */
export function advanceThrusts(project, state, dt) {
  state.thrustClock = (state.thrustClock || 0) + dt * TIC_RATE;
  const whole = Math.floor(state.thrustClock + 1e-6);
  state.thrustClock -= whole;
  const tics = Math.min(whole, MAX_TICS_PER_STEP);
  for (let tic = 0; tic < tics; tic++) {
    for (const entity of state.entities) {
      if (entity.type === 'player') continue;
      const vx = entity.vx || 0, vy = entity.vy || 0;
      if (!vx && !vy) continue;
      const speed = Math.hypot(vx, vy);
      if (speed < DOOM_STOP_SPEED) { entity.vx = 0; entity.vy = 0; continue; }
      slideEntity(state, entity, vx / TIC_RATE, vy / TIC_RATE);
      entity.vx = vx * DOOM_BLAST_FRICTION;
      entity.vy = vy * DOOM_BLAST_FRICTION;
    }
  }
}

// Doom's `FRICTION` is 0xe800 (0.90625); anything below the stop speed has its momentum
// dropped rather than creeping for ever.
const DOOM_BLAST_FRICTION = 0xe800 / 0x10000;
const DOOM_STOP_SPEED = 0.5;

/** Moves a shoved thing, stopping it at a wall or a ledge instead of pushing it through. */
function slideEntity(state, entity, dx, dy) {
  const distance = Math.hypot(dx, dy);
  if (!distance) return;
  const floor = floorAt(state, entity);
  const origin = { x: entity.x, y: entity.y, z: floor + 28 };
  const direction = { x: dx / distance, y: dy / distance, z: 0 };
  if (geometryDistance(state, origin, direction, distance + 16, true) < distance + 16) {
    entity.vx = 0; entity.vy = 0;
    return;
  }
  const x = entity.x + dx, y = entity.y + dy;
  const sector = state.sectors.length ? sectorAt(state.sectors, x, y) : null;
  if (state.sectors.length && (!sector || sector.ceilingHeight - sector.floorHeight < 56 ||
    Math.abs(sector.floorHeight - floor) > 24)) {
    entity.vx = 0; entity.vy = 0;
    return;
  }
  entity.x = x; entity.y = y;
  if (sector) entity.z = sector.floorHeight;
  state.physics?.teleport(entity.id, x, y, sector?.floorHeight ?? entity.z);
}

/**
 * The BFG ball's death sweep, for its own state or for a rule that sprays.
 *
 * A_BFGSpray(spraytype, rays, damagecount, spread, distance, vrange, damage): a cone of
 * rays across what the ball can see, each doing `damagecount` eight-sided dice of damage.
 */
export function bfgSpray(project, state, entity, { spray: sprayType = 'BFGExtra', rays = 40, rolls = 15,
  spread = 90, range = 0, damage = 0, damageType = null } = {}) {
  const spray = String(sprayType || 'BFGExtra').replace(/^"|"$/g, '');
  const count = Math.max(1, Math.min(256, Math.floor(rays || 40)));
  const rollCount = Math.max(1, Math.floor(rolls || 15));
  const arc = Math.max(1, spread || 90) * Math.PI / 180;
  const reach = range > 0 ? range : 1024;
  const fixed = damage || 0;
  const origin = sprayOrigin(state, entity);
  const eye = { x: origin.x, y: origin.y, z: (origin.z ?? floorAt(state, origin)) + (origin === state.player ? 48 : 32) };
  const base = Math.atan2(entity?.dy ?? Math.sin((entity?.angle || 0) * Math.PI / 180),
    entity?.dx ?? Math.cos((entity?.angle || 0) * Math.PI / 180));
  for (let ray = 0; ray < count; ray++) {
    const angle = base - arc / 2 + arc / count * ray;
    const direction = { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
    let nearest = geometryDistance(state, eye, direction, reach);
    let target = null;
    for (const candidate of state.entities) {
      if (candidate.type !== 'enemy' || (candidate.health ?? 0) <= 0) continue;
      const hit = entityDistance(state, eye, direction, candidate, nearest);
      if (hit !== null) { nearest = hit; target = candidate; }
    }
    if (!target) continue;
    let amount = fixed;
    if (!amount) for (let roll = 0; roll < rollCount; roll++) amount += randomDamage(state, 1, 8);
    hurtActor(project, state, target, amount, sprayOrigin(state, entity), damageType);
    spawnEffect(project, state, spray, { x: target.x, y: target.y,
      z: floorAt(state, target) + (target.height ?? 56) / 4 });
  }
}

/**
 * Homing, for a missile's own state or for a rule that steers something.
 *
 * GZDoom turns 16.875 degrees every fourth tic and leaves a smoke puff behind the tracer.
 */
export function homeMissile(project, state, missile, { turn = 16.875, everyTics = 4 } = {}) {
  if (everyTics > 1 && (Math.round((state.time || 0) * TIC_RATE) % everyTics)) return false;
  spawnEffect(project, state, 'BulletPuff', { x: missile.x, y: missile.y, z: missile.z });
  spawnEffect(project, state, 'RevenantTracerSmoke', { x: missile.x, y: missile.y, z: missile.z, vz: 1 });
  return tracerStep({ project, state, entity: missile }, turn);
}

/**
 * One Mancubus attack: two FatShots thrown `spread` steps off the aim.
 *
 * The angle is a rotation of the *shooter's* facing, not the aim line, exactly as GZDoom's
 * `Angle += FATSPREAD; SpawnMissile(...)` reads.
 */
function mancubusVolley(ctx, first, second) {
  const { project, state, entity } = ctx;
  const spread = 90 / 8;                       // FATSPREAD, in degrees
  for (const offset of [first, second]) {
    const angle = ((entity.angle || 0) + spread * offset) * Math.PI / 180;
    spawnActorProjectile(project, state, entity, actorMissile(ctx, 'FatShot'), { angle });
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
    damageType: actor?.damageType || null,
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
  // Doom's `P_RecursiveSound`: a noise spreads to every sector reachable through an opening,
  // however far away, and stops at a shut door. A plain radius woke monsters through any
  // number of walls and had them hunting a player they had never laid eyes on.
  return canHearPlayer(state, entity);
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
  if (!target) { delete entity.targetId; return; }
  // `state.player` is the player's position, not its map entity: it carries no `id` and no `type`,
  // so this used to store `undefined` and every monster in the game lost the target A_Look had just
  // given it. Anything without an id is the player.
  entity.targetId = target === entity ? '$player' : target.type === 'player' || target.id === undefined ? '$player' : target.id;
}

const targetPosition = (state, entity) => actorTarget(state, entity) || state.player;

/** The entity whose actor inventory stands for `target`; the player is its map entity. */
function inventoryHolder(state, target) {
  if (target && target === state.player) return state.entities.find(entity => entity.type === 'player') || null;
  return target || null;
}

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

/**
 * A DECORATE actor flag, with a per-entity override (`A_ChangeFlag`) taking precedence.
 *
 * Exported because an event rule can branch on any flag by name, which is how a custom monster the
 * engine has never heard of is still controllable: AMBUSH, FLOAT, DORMANT, BOSS, STANDSTILL,
 * QUICKTORETALIATE, LOOKALLAROUND, MISSILE, COUNTKILL and whatever else the mod declares.
 */
export function actorFlag(actor, name, entity) {
  // A_ChangeFlag writes per-entity overrides; they shadow the actor's declared flags.
  if (entity?.actorFlags) {
    const key = Object.keys(entity.actorFlags).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return Boolean(entity.actorFlags[key]);
  }
  return Boolean(actor?.flags?.[name]) || Boolean(actor?.flags?.[name.toUpperCase()]);
}

/**
 * Applies damage the way Doom does: health, the pain roll, and — when a monster
 * hurt another monster — a target switch, which is what makes infighting happen.
 */
/**
 * The item a monster leaves behind, as an object the runtime can clone.
 *
 * Drops are a table on the actor (`DropItem "Clip"`) and the import has always read it, but
 * nothing ever looked at the table again: a zombieman died without its clip, a shotgun guy
 * without his shotgun. A placed item of the same kind is the best template — it already carries
 * its artwork and its editor number — and a level that places none gets one built from the item's
 * own actor, which is what a save validates a dropped object against.
 */
export function dropTemplate(project, itemName) {
  const actor = projectActorIndex(project).byName.get(String(itemName).toLowerCase()) || null;
  // A project with an imported actor table names the item itself; one built on the classic
  // table has no actor records for its items at all, and Doom's editor numbers answer instead.
  const number = actor?.doomedNum ?? dropItemNumber(project, itemName);
  if (number === undefined || number === null) return null;
  const entities = project.map.entities || (project.map.entities = []);
  const placed = entities.find(entity => entity.type === 'pickup' && entity.doomType === number) ||
    entities.find(entity => entity.doomType === number);
  if (placed) return placed;
  const id = `drop_template_${String(actor?.name || itemName).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const existing = entities.find(entity => entity.id === id);
  if (existing) return existing;
  const template = { id, name: actor?.name || String(itemName), type: 'pickup', doomType: number, x: 0, y: 0, angle: 0 };
  if (actor) {
    template.actorName = actor.name;
    applyActorSpriteStates(project, template, actor);
  } else {
    // The classic table still knows the item's sprite prefix, so it can at least be drawn.
    const prefix = doomThings[number]?.[0];
    const stand = prefix ? spriteAssetNames(project).get(`${prefix}A0`) : null;
    if (stand) template.spriteAsset = stand;
  }
  // A template only ever exists to be cloned; the level it belongs to never shows it.
  entities.push(template);
  return template;
}

/** Doom's death drops, spawned where the monster fell. */
export function dropItems(project, state, entity, actor) {
  if (entity.itemsDropped) return 0;
  entity.itemsDropped = true;
  if (!actor?.drops?.length) return 0;
  let spawned = 0;
  for (const drop of actor.drops) {
    // `DropItem "Clip", 200` is a chance out of 256, as Doom rolls it.
    const chance = Math.max(0, Math.min(256, Number(drop.chance ?? 256)));
    if (!(chance > 0)) continue;
    if (chance < 256 && randomDamage(state, 1, 256) > chance) continue;
    const template = dropTemplate(project, drop.item);
    if (!template) continue;
    // A third number is how many of that item the whole level may drop (`DropItem "Clip", 256, 5`).
    const limit = Number(drop.amount ?? -1);
    if (limit > 0) {
      const counts = state.droppedItems ||= new Map();
      const key = template.doomType ?? template.name;
      const dropped = counts.get(key) || 0;
      if (dropped >= limit) continue;
      counts.set(key, dropped + 1);
    }
    if (state.entities.length >= 900) break;
    let id;
    do {
      state.spawnSequence = (state.spawnSequence || 0) + 1;
      id = `drop_${state.spawnSequence}`;
    } while (state.entities.some(candidate => candidate.id === id));
    // The spread keeps the template's own fields, and `variables` is what the runtime gives every
    // object it holds — a save checks each live object against that shape.
    // `droppedFrom` is the item the drop table named, not the template it was cloned from: a level
    // that placed no item of this kind gets its template made on the spot, and that template is not
    // in any save. Recording the *item* is what lets a loader build the same template again from the
    // project's actor table — without it a save taken after one monster died could not be loaded.
    const dropped = { ...structuredClone(template), id, x: entity.x, y: entity.y, z: floorAt(state, entity),
      elevation: 0, spawnedFrom: template.id, droppedFrom: String(drop.item), variables: { ...(template.variables || {}) } };
    state.entities.push(dropped);
    state.worldRevision++;
    spawned++;
  }
  return spawned;
}

export function hurtActor(project, state, entity, amount, source = null, damageType = null) {
  if (!entity || entity.type !== 'enemy' || (entity.health ?? 0) <= 0 || !(amount > 0)) return false;
  // Hexen's Centaur Lord raises a shield that takes no damage at all while it is up
  // (`A_SetReflectiveInvulnerable`), and drops it to charge in again.
  if (entity.invulnerable) return false;
  const actor = actorOf(project, entity);
  // DamageFactor "Fire", 0 makes an actor immune to fire; 2 doubles the fire it takes.
  // The compile stores each factor under both its authored case and lowercase.
  if (damageType && actor?.damageFactors) {
    const factor = actor.damageFactors[damageType] ?? actor.damageFactors[String(damageType).toLowerCase()] ?? 1;
    if (factor !== 1) amount = Math.max(0, Math.floor(amount * factor));
    if (!(amount > 0)) return false;
  }
  // Doom never clamps a corpse's health: `health < -SpawnHealth()` is exactly what makes a body
  // gib, so a shotgun that does 60 to a 20-health Zombieman has to leave it at -40.
  entity.health -= amount;
  // Doom's `MF_JUSTHIT`: a monster that has just been hurt answers with an attack the next time
  // it is allowed to make one, whatever the distance roll would have said.
  entity.justHit = true;
  if (source && source !== state.player && source !== entity && !actorFlag(actor, 'NOINFIGHTING', entity)) {
    // A monster remembers who shot it, so it fights back against its own kind.
    entity.targetId = source.id;
  } else if (source === state.player) {
    entity.targetId = '$player';
  }
  if (entity.health <= 0) {
    // The Death state runs from stepActors; the body stops blocking immediately.
    entity.solid = false;
    state.physics?.remove(entity.id);
    // Doom drops a monster's items the moment it dies, not when the corpse settles.
    dropItems(project, state, entity, actor);
    return true;
  }
  const typeChance = damageType ? (actor?.painChances?.[damageType] ?? actor?.painChances?.[String(damageType).toLowerCase()]) : undefined;
  const chance = Math.max(0, Math.min(256, typeChance ?? actor?.painChance ?? 0));
  if (chance > 0 && randomDamage(state, 1, 256) <= chance) {
    // Pain interrupts whatever the monster was doing, and clears reaction time so
    // it can retaliate at once, exactly like P_DamageMobj.
    if (setActorState(project, entity, 'Pain')) {
      // GZDoom plays the pain sound from the Pain state's own A_Pain frame, so
      // playing it here too doubles the sound every time a monster flinches.
      actorStateOf(entity).reactionTime = 0;
    }
  }
  return true;
}

/** A monster's hitscan attack: aim at its target, roll damage, let walls stop it. */
/** A melee attack that only lands inside Doom's melee range, and says so when it misses. */
function meleeAttack(ctx, damage, diceSides) {
  if (!meleeable(ctx.state, ctx.entity)) return;
  monsterHitscan(ctx, damage, diceSides);
  saySound(ctx.state, 'DSCLAW', ctx.entity);
}

function monsterHitscan(ctx, damage, diceSides, spread = 0) {
  const { state, entity } = ctx;
  if (entity.health <= 0) return;
  const target = targetPosition(state, entity);
  const origin = { x: entity.x, y: entity.y, z: sightEyeHeight(state, entity) };
  const aim = Math.atan2(target.y - entity.y, target.x - entity.x);
  // Doom's MISSILERANGE: a shot travels 2048 units, but what it may be fired at is only
  // limited by sight.
  const reach = canSeeTarget(state, entity, target, SIGHT_RANGE) ? 2048 : 0;
  if (!reach) return;
  const offset = spread ? (randomDamage(state, 1, 256) - randomDamage(state, 1, 256)) * spread / 256 * Math.PI / 180 : 0;
  const direction = { x: Math.cos(aim + offset), y: Math.sin(aim + offset), z: 0 };
  const limit = geometryDistance(state, origin, direction, reach);
  const hits = entityDistance(state, origin, direction, target, limit, 16);
  if (hits === null) return;
  const amount = randomDamage(state, damage, diceSides);
  if (target === state.player) damagePlayer(state, amount);
  else hurtActor(ctx.project, state, target, amount, entity, ctx.actor?.damageType || null);
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
    const fov = actorFlag(actor, 'LOOKALLAROUND', entity) ? 360 : 180;
    const seen = canSeePlayer(state, entity, SIGHT_RANGE, fov);
    if (!seen && (actorFlag(actor, 'AMBUSH', entity) || entity.ambush || !hearsPlayer(state, entity))) return;
    setActorTarget(entity, state.player);
    saySound(state, actor.sounds?.see, entity);
    setActorState(ctx.project, entity, 'See');
  },
  // Heretic, Strife and Hexen each spell "look for the player" their own way, and every one of
  // these names was unknown: the Acolyte family (43 actors), the twelve ScriptedMarine variants —
  // Strife's own player class — and the IceGuy, Maulotaur, ceiling turret, stalker and wraith all
  // stood in their Spawn frame for the whole level, waiting for an action the engine never ran.
  A_Look2(ctx) {
    // Heretic's acolyte: look; failing that, sweep its view 45 degrees left and right, twice.
    const { state, entity, actor } = ctx;
    if (entity.dormant) return;
    if (canSeePlayer(state, entity, SIGHT_RANGE, 180)) {
      setActorTarget(entity, state.player);
      saySound(state, actor.sounds?.see, entity);
      setActorState(ctx.project, entity, 'See');
      return;
    }
    // `entity.angle` is degrees everywhere an actor is concerned (`A_FaceTarget` writes degrees),
    // so the sweep is 45 degrees — not 0.79 of one — and the counter starts again at the next
    // `A_Look2` after the monster has had its two sweeps.
    const sweeps = (entity.lookSweeps || 0) + 1;
    if (sweeps > 2) { entity.lookSweeps = 0; return; }
    entity.lookSweeps = sweeps;
    entity.angle = (Number(entity.angle) || 0) + (sweeps === 1 ? -45 : 45);
  },
  A_MarineLook(ctx) { ACTIONS.A_Look(ctx); },
  A_MarineNoise(ctx) { ACTIONS.A_NoiseAlert?.(ctx); },
  A_IceGuyLook(ctx) { ACTIONS.A_Look(ctx); },
  A_MinotaurLook(ctx) { ACTIONS.A_Look(ctx); },
  A_TurretLook(ctx) { ACTIONS.A_Look(ctx); },
  A_StalkerLookInit(ctx) { ACTIONS.A_Look(ctx); },
  A_WraithInit(ctx) { ACTIONS.A_Look(ctx); },
  A_LookEx(ctx) {
    // GZDoom's signature is (flags, minseedist, maxseedist, maxheardist, fov, seestate):
    // argument 0 is a flag bitfield, 2 and 1 bound the sight range, 4 is the view
    // angle and 5 names the state to wake into. Reading 0 as a distance and 4 as the
    // state label — the old mapping — made every A_LookEx with default flags blind.
    const { state, entity, actor } = ctx;
    const minSeed = numArg(ctx, 1, 0);
    const maxSeed = numArg(ctx, 2, 0);
    const fov = numArg(ctx, 4, 0) || 180;
    if (!canSeePlayer(state, entity, maxSeed > 0 ? maxSeed : SIGHT_RANGE, fov)) return;
    if (minSeed > 0 && targetDistance(state, entity) <= minSeed) return;
    saySound(state, actor.sounds?.see, entity);
    setActorState(ctx.project, entity, arg(ctx, 5) || 'See');
  },
  A_Chase(ctx) {
    const { state, entity, actor } = ctx;
    if (entity.health <= 0 || entity.dormant) return;
    // A charging Lost Soul is flown by `advanceSkullfly`, not walked by its AI.
    if (entity.skullfly) return;
    const runtime = actorStateOf(entity);
    // Doom's chase ticks move the monster, then decide whether it may attack.
    const speed = (entity.actorSpeed || actor.speed || 8) * TIC_RATE * (ctx.fast || state.settings?.fastMonsters ? 2 : 1);
    moveEnemy(state, entity, speed, 1 / TIC_RATE, targetPosition(state, entity));
    if (randomDamage(state, 1, 256) < 4) saySound(state, actor.sounds?.active, entity);
    if (runtime.reactionTime > 0) { runtime.reactionTime--; return; }
    const missileLabel = arg(ctx, 0) || 'Missile';
    const meleeLabel = arg(ctx, 1) || 'Melee';
    const target = targetPosition(state, entity);
    const distance = Math.hypot(target.x - entity.x, target.y - entity.y);
    // P_CheckMeleeRange: MELEERANGE - 20 + the monster's radius, and in sight — a monster
    // cannot punch what is on the other side of a wall.
    if (checkMeleeRange(state, entity, target, actor.radius)) {
      if (setActorState(ctx.project, entity, meleeLabel)) {
        runtime.reactionTime = actor.reactionTime || 8;
        return;
      }
    }
    // P_CheckMissileRange: a target that is not in sight is not shot at, and closer monsters are
    // more likely to shoot. Doom clamps the distance to 200 *before* the roll — without the clamp
    // every monster further than 392 units fired on every single chase tic, which turned the
    // Zombiemen of a big room into a firing squad. The MISSILEMORE flags bias the same roll.
    if (!canSeeTarget(state, entity, target, SIGHT_RANGE)) return;
    let reach = Math.max(0, distance - 64) - 128;
    if (actorFlag(actor, 'MISSILEMORE', entity)) reach += 100;
    if (actorFlag(actor, 'MISSILEEVENMORE', entity)) reach += 200;
    // The Archvile, Revenant, Cyberdemon, Spider and Lost Soul adjust the same distance: the
    // Archvile refuses anything past 896 units, the Revenant halves it beyond its fist range, and
    // the three heavy shooters halve it always.
    const kind = String(entity.actorName || actor.name || '').toLowerCase();
    if (kind.includes('archvile')) { if (reach > 14 * 64) return; }
    else if (kind.includes('revenant')) { if (reach < 196) return; reach /= 2; }
    if (kind.includes('cyberdemon') || kind.includes('spider') || kind.includes('lost')) reach /= 2;
    if (reach > 200) reach = 200;
    if (kind.includes('cyberdemon') && reach > 160) reach = 160;
    if (randomDamage(state, 1, 256) < reach) return;
    if (setActorState(ctx.project, entity, missileLabel)) runtime.reactionTime = actor.reactionTime || 8;
  },
  A_Wander(ctx) {
    const { state, entity, actor } = ctx;
    if (canSeePlayer(state, entity, SIGHT_RANGE)) { setActorState(ctx.project, entity, 'See'); return; }
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
  // GZDoom's A_XScream plays the gib sound ("misc/gibbed"), not the death scream,
  // which A_Scream already plays from the ordinary Death state.
  A_XScream(ctx) { saySound(ctx.state, 'misc/gibbed', ctx.entity); },
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
  // `A_BarrelDestroy`: a barrel's blast ends by taking it out of the level. GZDoom keeps it
  // invisible instead when `sv_barrelrespawn` is on, which is off by default — the same
  // default this engine ships with.
  A_BarrelDestroy(ctx) {
    if (ctx.state.settings?.barrelRespawn) {
      ctx.entity.solid = false;
      ctx.entity.noBlockmap = true;
      ctx.state.physics?.remove(ctx.entity.id);
      return;
    }
    actorStateOf(ctx.entity).gone = true;
    actorStateOf(ctx.entity).index = null;
    actorStateOf(ctx.entity).stopped = true;
  },
  // `A_Respawn`: a dead thing stands up again, whole. Doom's own barrel reaches this only with
  // respawning barrels turned on.
  A_Respawn(ctx) {
    const { project, state, entity, actor } = ctx;
    entity.health = actor.health ?? entity.health;
    restoreBlocking(state, entity);
    const runtime = actorStateOf(entity);
    runtime.gone = false; runtime.stopped = false;
    entity.actorDeadHandled = true;
    setActorState(project, entity, 'Spawn', { restart: true });
    state.worldRevision++;
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
  // A_SetFloorClip / A_UnSetFloorClip: draw the sprite clipped at the sector floor instead of
  // letting it sink into it. Doom sets this on a floater's corpse, whose last frames hang low.
  A_SetFloorClip(ctx) { ctx.entity.floorClip = true; },
  A_UnSetFloorClip(ctx) { ctx.entity.floorClip = false; },
  // --------------------------------------------------- the Heresiarch's three satellites
  // A_SorcSpinBalls: the balls start circling the caster's head, 120 degrees apart, at the caster's
  // own height. They are the boss's whole attack, so they are things the engine moves rather than a
  // light show: the player can shoot them, and killing the caster pops them.
  A_SorcSpinBalls(ctx) {
    const { project, state, entity } = ctx;
    const alive = (entity.sorcBalls || []).filter(id => state.entities.some(ball => ball.id === id && !ball.removed));
    entity.sorcBalls = alive;
    if (alive.length) return;
    entity.sorcAngle = 0;
    entity.sorcSpeed = SORC_INITIAL_SPEED;
    entity.sorcTarget = SORC_INITIAL_SPEED;
    entity.sorcMode = 'normal';
    // A thing the level placed carries no radius of its own; the actor table is where it lives.
    const actor = actorOf(project, entity);
    const casterRadius = Number(actor?.radius ?? entity.radius ?? 20);
    const z = (entity.z ?? floorAt(state, entity)) + Number(actor?.height ?? entity.height ?? 56);
    entity.sorcBalls = ['SorcBall1', 'SorcBall2', 'SorcBall3'].map((name, index) => {
      const ball = spawnLiveActor(project, state, name, { x: entity.x, y: entity.y, z });
      if (!ball) return null;
      // `speed 10, radius 5`, and health 0 in the actor table: one hit is enough to destroy a ball.
      ball.health = 1;
      ball.solid = false;
      ball.noBlockmap = true;
      ball.orbit = { of: entity.id, offset: index * 120,
        radius: Math.max(8, casterRadius - Number(ball.radius ?? 5) * 2) };
      return ball.id;
    }).filter(Boolean);
  },
  // A_SorcBallOrbit: the ball reads the caster, not the other way round. Each ball advances the shared
  // angle, which is what makes the ring turn three times as fast as one ball could.
  A_SorcBallOrbit(ctx) {
    const { project, state, entity } = ctx;
    const orbit = entity.orbit;
    const parent = orbit ? state.entities.find(candidate => candidate.id === orbit.of && !candidate.removed) : null;
    // GZDoom sends a ball whose caster is gone to its Pain state, which pops it.
    if (!parent || (parent.health ?? 0) <= 0) { setActorState(project, entity, 'Pain'); return; }
    const speed = Number.isFinite(parent.sorcSpeed) ? parent.sorcSpeed : SORC_INITIAL_SPEED;
    if (parent.sorcMode === 'accelerate') {
      if (speed < (parent.sorcTarget ?? SORC_TERMINAL_SPEED)) parent.sorcSpeed = speed + 1;
      else parent.sorcMode = 'normal';
    } else if (parent.sorcMode === 'decelerate') {
      if (speed > (parent.sorcTarget ?? SORC_INITIAL_SPEED)) parent.sorcSpeed = Math.max(SORC_INITIAL_SPEED, speed - 1);
      else parent.sorcMode = 'normal';
    }
    parent.sorcAngle = ((parent.sorcAngle || 0) + (parent.sorcSpeed ?? SORC_INITIAL_SPEED)) % 360;
    const angle = (parent.sorcAngle + orbit.offset) * Math.PI / 180;
    entity.x = parent.x + Math.cos(angle) * orbit.radius;
    entity.y = parent.y + Math.sin(angle) * orbit.radius;
    entity.z = (parent.z ?? floorAt(state, parent)) + Number(parent.height ?? actorOf(project, parent)?.height ?? 56);
    state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
  },
  // A_SpeedBalls / A_SlowBalls / A_SorcBossAttack: what the caster's Missile and Attack states say
  // about the ring — spin up to the terminal speed, ease back down, or start again.
  A_SpeedBalls(ctx) {
    ctx.entity.sorcMode = 'accelerate';
    ctx.entity.sorcTarget = SORC_TERMINAL_SPEED;
  },
  A_SlowBalls(ctx) {
    ctx.entity.sorcMode = 'decelerate';
    ctx.entity.sorcTarget = SORC_INITIAL_SPEED;
  },
  A_SorcBossAttack(ctx) {
    ctx.entity.sorcMode = 'accelerate';
    ctx.entity.sorcTarget = SORC_INITIAL_SPEED;
  },
  // A_SorcBallPop: the ball leaves the ring and is thrown clear, then bounces until A_BounceCheck
  // runs out its five seconds.
  A_SorcBallPop(ctx) {
    const { state, entity } = ctx;
    const angle = randomRange(state, 0, 255) * Math.PI / 128;
    entity.orbit = null;
    entity.vx = Math.cos(angle) * randomRange(state, 0, 4);
    entity.vy = Math.sin(angle) * randomRange(state, 0, 4);
    entity.vz = randomRange(state, 2, 4);
    entity.sorcBounce = { unit: SORC_BOUNCE_UNIT, seconds: 5 };
    // `args[3] = 5`: five seconds of bouncing before the ball bursts.
    entity.sorcFuse = 5;
    saySound(state, 'SorcererBallPop', entity);
  },
  A_BounceCheck(ctx) {
    const { project, state, entity } = ctx;
    const bounce = entity.sorcBounce ||= { unit: SORC_BOUNCE_UNIT, seconds: 5 };
    if (bounce.unit-- > 0) return;
    if (--bounce.seconds > 0) { bounce.unit = SORC_BOUNCE_UNIT; return; }
    setActorState(project, entity, 'Death');
    saySound(state, 'SorcererBigBallExplode', entity);
  },
  // A_SorcBallExplode: a 255-damage blast in a 255-unit radius, and then the ball is gone — a
  // satellite is not a corpse, and its last frame is a flash that would otherwise stay in the level.
  A_SorcBallExplode(ctx) {
    const { project, state, entity } = ctx;
    explodeAt(project, state, entity, 255, 255, null);
    saySound(state, 'SorcererBigBallExplode', entity);
    removeLiveActor(state, entity);
  },
  // A_SpawnFizzle: the puff of sparks the Heresiarch throws before a spell lands.
  A_SpawnFizzle(ctx) {
    const { project, state, entity } = ctx;
    const facing = facingOf(entity) * Math.PI / 180;
    const half = (entity.height ?? 110) / 2;
    for (let spark = 0; spark < 5; spark++) {
      const angle = facing + randomRange(state, 0, 4) * Math.PI / 2;
      spawnEffect(project, state, 'SorcSpark1', {
        x: entity.x + Math.cos(facing) * 5, y: entity.y + Math.sin(facing) * 5,
        z: (entity.z ?? floorAt(state, entity)) + half,
        vx: Math.cos(angle) * randomRange(state, 0, 9), vy: Math.sin(angle) * randomRange(state, 0, 9), vz: 2 });
    }
  },
  // --------------------------------------------------------------- death dressing
  // A_TossGib (Strife): the death spray. `Meat` is +NOCLIP and never interacts with anything, so it
  // is decoration here too — an effect that flies out and fades, not a thing that can be shot.
  A_TossGib(ctx) {
    const { project, state, entity, actor } = ctx;
    const angle = randomRange(state, 0, 255) * 360 / 256 * Math.PI / 180;
    const speed = randomRange(state, 0, 15);
    spawnEffect(project, state, actorFlag(actor, 'NOBLOOD', entity) ? 'Junk' : 'Meat', {
      x: entity.x, y: entity.y, z: (entity.z ?? floorAt(state, entity)) + 24,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, vz: randomRange(state, 0, 15) });
  },
  // A_FreezeDeath (shared/ice.zs): a frozen corpse holds its frame far longer than a body does
  // (GZDoom adds 75 + 3*(P_Random()&7) + 4 tics) and stops blocking the level.
  A_FreezeDeath(ctx) {
    const { state, entity } = ctx;
    actorStateOf(entity).tics += 75 + randomRange(state, 0, 7) * 3 + 4;
    entity.solid = false;
    entity.noBlockmap = true;
    state.physics?.remove(entity.id);
    saySound(state, 'misc/freeze', entity);
  },
  // A_FreezeDeathChunks: the ice body shatters into chunks that fall as decoration. GZDoom waits
  // three tics when the body is still moving so the chunks do not hang in the air.
  A_FreezeDeathChunks(ctx) {
    const { project, state, entity } = ctx;
    const runtime = actorStateOf(entity);
    if ((entity.vx || entity.vy) && runtime.tics > 3) { runtime.tics = 3; return; }
    const z = entity.z ?? floorAt(state, entity);
    for (let chunk = 0; chunk < 6; chunk++) {
      spawnEffect(project, state, 'IceChunk', {
        x: entity.x + randomRange(state, -16, 16), y: entity.y + randomRange(state, -16, 16),
        z: z + randomRange(state, 0, 32), vx: randomRange(state, -4, 4), vy: randomRange(state, -4, 4),
        vz: randomRange(state, 0, 8) });
    }
    saySound(state, 'misc/freeze', entity);
    removeLiveActor(state, entity);
  },
  // A_QueueCorpse / A_DeQueueCorpse: Hexen's corpse queue. GZDoom keeps `sv_corpsequeuesize` (64 by
  // default) bodies and destroys the oldest past that, which is what stops a long level filling up
  // with corpses. The queue is the marked corpses themselves, in the order they queued, so nothing
  // extra has to travel in a save.
  A_QueueCorpse(ctx) {
    const { state, entity } = ctx;
    const corpses = state.entities.filter(candidate => candidate.queuedCorpse && !candidate.removed);
    while (corpses.length >= CORPSE_QUEUE_SIZE) removeLiveActor(state, corpses.shift());
    entity.queuedCorpse = true;
  },
  A_DeQueueCorpse(ctx) {
    const { state, entity } = ctx;
    for (const corpse of state.entities) if (corpse.queuedCorpse && corpse.id === entity.id) corpse.queuedCorpse = false;
  },
  // A_PlayerScream: the player's own death cry. A class with a DeathSound of its own uses it;
  // otherwise Doom picks by how badly the body is wrecked.
  A_PlayerScream(ctx) {
    const { state, entity, actor } = ctx;
    if (actor?.sounds?.death) { saySound(state, actor.sounds.death, entity); return; }
    // The health the body died with, which is what picks the scream; this engine clamps the player's
    // own health at zero, so an actor that carries a negative one is what says the body was mangled.
    const health = Number.isFinite(entity.health) ? entity.health : state.playerStats?.health ?? 0;
    saySound(state, health > -50 ? '*death' : health > -100 ? '*crazydeath' : '*xdeath', entity);
  },
  // A_ClassBossHealth: Hexen multiplies a boss's health by five for each extra player, once, and
  // only in co-op. A single-player game is exactly the case GZDoom leaves alone, so there is
  // nothing to do — and saying so here is better than reporting the action as missing.
  A_ClassBossHealth() {},
  // A_SentinelBob (strife/sentinel.zs): the Stalker hangs in the air 96 above the floor instead of
  // standing in front of the player, drifting a unit a tic towards that height.
  A_SentinelBob(ctx) {
    const { state, entity } = ctx;
    if (actorStateOf(entity).threshold !== 0) return;
    // The sector floor, not `floorAt`: that one answers with the thing's own `z` when it has one,
    // and a height measured against itself climbs a unit a tic until it reaches the ceiling.
    const sector = state.sectors.length ? sectorAt(state.sectors, entity.x, entity.y) : null;
    const floor = (sector?.floorHeight ?? 0) + (entity.elevation || 0);
    const ceiling = (sector?.ceilingHeight ?? floor + 128) - (entity.height ?? 56) - 16;
    const hover = Math.min(floor + 96, ceiling);
    const z = entity.z ?? floor;
    const next = z < hover ? Math.min(hover, z + 1) : z > hover ? Math.max(Math.max(floor, hover), z - 1) : z;
    if (next === z) return;
    entity.z = next;
    state.physics?.teleport(entity.id, entity.x, entity.y, next);
  },
  // ------------------------------------------------------------ Hexen Centaur Lord shield
  // A_SetReflectiveInvulnerable / A_UnsetReflectiveInvulnerable: the shield is damage immunity plus
  // a bounce for missiles (the bounce itself lives in `advanceProjectiles`).
  A_SetReflectiveInvulnerable(ctx) { ctx.entity.invulnerable = true; ctx.entity.reflective = true; },
  A_UnsetReflectiveInvulnerable(ctx) { ctx.entity.invulnerable = false; ctx.entity.reflective = false; },
  // A_CentaurDefend: with the shield up the Centaur Lord waits for the player to close, and drops
  // the shield to charge in on a one-in-eight roll inside melee range.
  A_CentaurDefend(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    const { project, state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    if (randomRange(state, 0, 255) >= 32) return;
    entity.invulnerable = false;
    entity.reflective = false;
    setActorState(project, entity, 'Melee');
  },
  A_PlaySound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StartSound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StopSound() {},
  // Doom's own damage profiles, from p_enemy.c: `((P_Random()%N)+1)*base` is `base` damage with N
  // sides. Several were written the other way round (5 with 3 sides for the Zombieman's 3 with 5),
  // so every zombie, chaingunner and spider hit for the wrong amount, and the Archvile's flat 20
  // was rolled as 20 with eight sides — up to 160 damage from one attack.
  A_PosAttack(ctx) {
    monsterHitscan(ctx, 3, 5);
    saySound(ctx.state, 'DSPISTOL', ctx.entity, 90);
  },
  A_SPosAttack(ctx) {
    for (let pellet = 0; pellet < 3; pellet++) monsterHitscan(ctx, 3, 5, 11.25);
    saySound(ctx.state, 'DSSHOTGN', ctx.entity, 90);
  },
  // GZDoom renamed the Spider Mastermind's attack and its states call the new name: the old one
  // left the biggest boss in the game standing in front of the player, firing nothing. Two
  // spellings are in the wild (`SPos` and `Spos`), so both are answered.
  A_SPosAttackUseAtkSound(ctx) { ACTIONS.A_SPosAttack(ctx); },
  A_SposAttackUseAtkSound(ctx) { ACTIONS.A_SPosAttack(ctx); },
  // Whether the Spider keeps firing: GZDoom's `A_SpidRefire` is `A_CPosRefire` with a
  // one-in-twenty-five chance of stopping instead of one-in-six.
  A_SpidRefire(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048) || randomDamage(state, 1, 256) < 10) setActorState(ctx.project, entity, 'See');
  },
  // The Revenant's punch. `A_SkelWhoosh` is the swing before it lands.
  A_SkelWhoosh(ctx) { saySound(ctx.state, 'skeleton/swing', ctx.entity); },
  A_SkelFist(ctx) {
    const { state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    monsterHitscan(ctx, 6, 10);
    saySound(state, 'skeleton/melee', entity);
  },
  // The Pain Elemental's death: it stops blocking and lets three Lost Souls out, which is the
  // reason killing one in a corridor is a mistake. Without this its death was silent in the way
  // that matters — nothing came out.
  A_PainDie(ctx) {
    ACTIONS.A_NoBlocking(ctx);
    // Three souls, 90 degrees apart, each thrown clear and charging — GZDoom's `angle + 90/180/270`.
    painShootSkull(ctx, 90);
    painShootSkull(ctx, 180);
    painShootSkull(ctx, 270);
    saySound(ctx.state, 'skeleton/swing', ctx.entity);
  },
  // The Mancubus raising its guns, and the heavy footsteps that make a Cyberdemon, an
  // Arachnotron and the Mancubus heard before they are seen.
  A_FatRaise(ctx) { saySound(ctx.state, 'fatso/raiseguns', ctx.entity); },
  A_Metal(ctx) { saySound(ctx.state, 'spider/walk', ctx.entity); },
  A_BabyMetal(ctx) { saySound(ctx.state, 'baby/walk', ctx.entity); },
  A_Hoof(ctx) { saySound(ctx.state, 'cyber/hoof', ctx.entity); },
  A_CPosAttack(ctx) {
    monsterHitscan(ctx, 3, 5);
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
    monsterHitscan(ctx, 4, 10);
    saySound(state, 'DSCLAW', entity);
  },
  A_HeadAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, SIGHT_RANGE)) return;
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'CacodemonBall'));
    saySound(state, 'DSCACATT', entity);
  },
  A_BruisAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { monsterHitscan(ctx, 10, 8); saySound(state, 'DSCLAW', entity); return; }
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'BaronBall'));
    saySound(state, 'DSPISTOL', entity, 70);
  },
  // Heretic's acolyte: face the target and launch its fireball. The action was unknown, so all
  // 43 Acolyte variants chased a player forever and never fired a shot.
  // The generic projectile attack every derived engine uses: `A_SpawnProjectile(class, ofs_xy,
  // ofs_z, angle, pitch, ...)` launches the named class, or the actor's own `Projectile` when the
  // name is left out. Unanswered, fifteen monsters — Hexen's Serpents and Centaurs among them —
  // chased the player and never fired.
  A_SpawnProjectile(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, SIGHT_RANGE)) return;
    ACTIONS.A_FaceTarget(ctx);
    const name = String(arg(ctx, 0) || ctx.actor?.projectile || '');
    if (!name) return;
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, name));
  },
  // Nightmare's fast chase: the same decision at double the speed, whatever the skill setting is.
  A_FastChase(ctx) { ACTIONS.A_Chase({ ...ctx, fast: true }); },
  // Strife's marines chase exactly as any other monster does.
  A_MarineChase(ctx) { ACTIONS.A_Chase(ctx); },
  // A refire check that is `A_CPosRefire` under another name (Strife's sentinels and beggars).
  A_SentinelRefire(ctx) { ACTIONS.A_CPosRefire(ctx); },
  // Melee attacks that all roll Doom's `((P_Random()%8)+1)*3` and only land in range: the
  // Strife marine's punch, D'Sparil's knights, Heretic's wraith and the Maulotaur's first swing.
  A_M_Punch(ctx) { meleeAttack(ctx, 3, 8); },
  // Strife's marines ask whether to keep firing: out of sight, or with no target, they stop. Left
  // unanswered the state machine never took that exit and a marine fired for ever.
  A_M_Refire(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, SIGHT_RANGE)) { entity.lookSweeps = 0; setActorState(ctx.project, entity, 'See'); return; }
    if (randomDamage(state, 1, 256) < 40) setActorState(ctx.project, entity, 'See');
  },
  // The melee-or-missile decision every derived engine spells `A_CustomComboAttack`.
  A_CustomComboAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { meleeAttack(ctx, 3, 8); return; }
    ACTIONS.A_FaceTarget(ctx);
    const name = String(arg(ctx, 0) || ctx.actor?.projectile || '');
    if (name) spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, name));
  },
  A_KnightAttack(ctx) { meleeAttack(ctx, 3, 8); },
  A_WraithMelee(ctx) { meleeAttack(ctx, 3, 8); },
  A_MinotaurAtk1(ctx) { meleeAttack(ctx, 3, 8); },
  A_ShootGun(ctx) {
    const { state, entity } = ctx;
    ACTIONS.A_FaceTarget(ctx);
    spawnActorProjectile(ctx.project, state, entity, actorMissile(ctx, 'AcolyteFX'));
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
  A_Tracer(ctx) { homeMissile(ctx.project, ctx.state, ctx.entity); },
  A_Tracer2(ctx) { tracerStep(ctx, numArg(ctx, 0, 19.6875)); },
  // The derived engines' homing, with their own turn rate and step (Heretic's mummy and the
  // wraith's rod): unanswered, their missiles flew straight while the same actors' attacks expect
  // them to follow.
  A_SeekerMissile(ctx) { homeMissile(ctx.project, ctx.state, ctx.entity, { turn: numArg(ctx, 0, 16.875), everyTics: 1 }); },
  // Strife's flame missiles burn out: `A_Countdown` counts the object down and kills it. Left
  // unanswered a flame crossed the map and stayed there.
  A_Countdown(ctx) {
    const { project, state, entity } = ctx;
    const left = Number.isFinite(entity.special1) ? entity.special1 - 1 : 3;
    entity.special1 = left;
    if (left > 0) return;
    entity.health = 0;
    runProjectileDeath(project, state, entity);
  },
  // A_BFGSpray(spraytype, rays, damagecount, spread, distance, vrange, damage):
  // the BFG ball's Death state sweeps a deadly cone of rays across what it sees.
  A_BFGSpray(ctx) {
    bfgSpray(ctx.project, ctx.state, ctx.entity, {
      spray: arg(ctx, 0, 'BFGExtra'), rays: numArg(ctx, 1, 40), rolls: numArg(ctx, 2, 15),
      spread: numArg(ctx, 3, 90), range: numArg(ctx, 4, 0), damage: numArg(ctx, 6, 0),
      damageType: ctx.actor?.damageType || null });
  },
  // The Mancubus fires **two** shots per attack, fanned by FATSPREAD (11.25 degrees): the first
  // pair swings right, the second left, the third straddles the aim. One shot per attack halved
  // every Mancubus volley in the game and cost it the fan that makes the attack readable.
  A_FatAttack1(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    mancubusVolley(ctx, 1, 2);
    saySound(ctx.state, 'DSFIRSHT', ctx.entity);
  },
  A_FatAttack2(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    mancubusVolley(ctx, -1, -2);
  },
  A_FatAttack3(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    mancubusVolley(ctx, -.5, .5);
  },
  A_CyberAttack(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, actorMissile(ctx, 'Rocket')); saySound(ctx.state, 'DSRLAUNC', ctx.entity); },
  // A_PainAttack: the Pain Elemental spits a Lost Soul **in front of itself** and that soul
  // charges at once. The soul used to appear at the Elemental's own centre — inside its own
  // hitbox — with no target and no charge, so the attack did nothing at all.
  A_PainAttack(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    painShootSkull(ctx, 0);
  },
  // A_DualPainAttack: the MBF version, two souls thrown wide to either side.
  A_DualPainAttack(ctx) {
    ACTIONS.A_FaceTarget(ctx);
    painShootSkull(ctx, 45);
    painShootSkull(ctx, -45);
  },
  // A_SkullAttack: the Lost Soul's charge. GZDoom sets `MF_SKULLFLY`, points the thing at its
  // target with `VelFromAngle(20)` and gives it the vertical speed that arrives at the target's
  // middle; the slam itself happens in `PIT_CheckThing`, which damages what the flying thing
  // hits. Writing a `charge` field that nothing read made the whole attack silent.
  A_SkullAttack(ctx) {
    const { state, entity, actor } = ctx;
    const target = targetPosition(state, entity);
    const distance = Math.hypot(target.x - entity.x, target.y - entity.y);
    // `DEFSKULLSPEED`: Doom charges at 20 units a tic whatever the actor's walking speed is, which
    // is why a Lost Soul crosses a room faster than anything else in the game.
    const speed = 20;
    const angle = Math.atan2(target.y - entity.y, target.x - entity.x);
    const tics = Math.max(1, distance / speed);
    entity.angle = angle * 180 / Math.PI;
    entity.skullfly = {
      vx: Math.cos(angle) * speed * TIC_RATE,
      vy: Math.sin(angle) * speed * TIC_RATE,
      vz: (sightEyeHeight(state, target) - (entity.z ?? floorAt(state, entity))) / tics * TIC_RATE,
      tics: 0,
    };
    saySound(state, actor?.sounds?.attack || 'DSSKLATK', entity);
  },
  // A_VileChase is A_Chase **with resurrection**: before it moves, an Archvile looks at the spot
  // it is about to step onto, and a corpse there with a Raise state stands up and fights for it.
  // Without it the Heal state was unreachable and the Archvile was just a fast, hard-hitting
  // monster — the one thing it is famous for never happened.
  A_VileChase(ctx) {
    if (raiseCorpse(ctx)) return;
    ACTIONS.A_Chase({ ...ctx, args: [], named: {} });
  },
  // The Archvile's fire. `A_VileStart` is the wind-up sound, `A_VileTarget` drops the flame on the
  // target, and the flame follows the player while the Archvile keeps sight of them (`A_Fire`).
  A_VileStart(ctx) { saySound(ctx.state, 'vile/start', ctx.entity); },
  A_VileTarget(ctx) {
    const { project, state, entity } = ctx;
    ACTIONS.A_FaceTarget(ctx);
    const target = targetPosition(state, entity);
    if (!canSeeTarget(state, entity, target, SIGHT_RANGE)) return;
    entity.vileFire = { x: target.x, y: target.y, z: floorAt(state, target) };
    spawnEffect(project, state, 'ArchvileFire', { ...entity.vileFire });
  },
  // The fire actor's own frames. Here the flame is the Archvile's `vileFire` point, drawn by the
  // actor tick, so these only own their sounds.
  A_StartFire(ctx) { saySound(ctx.state, 'vile/firestrt', ctx.entity); },
  A_Fire() {},
  A_FireCrackle() {},
  A_VileAttack(ctx) {
    const { project, state, entity } = ctx;
    const target = targetPosition(state, entity);
    if (!canSeeTarget(state, entity, target, SIGHT_RANGE)) return;
    ACTIONS.A_FaceTarget(ctx);
    saySound(state, 'vile/stop', entity);
    // 20 damage straight down the Archvile's line of sight, then the flame — moved to 24 units in
    // front of the player — bursts for 70 in a 70-unit radius. This is why standing in the fire
    // is fatal and why breaking line of sight is the only answer.
    damagePlayer(state, 20);
    const fire = entity.vileFire || { x: target.x, y: target.y, z: floorAt(state, target) };
    const angle = Math.atan2(entity.y - target.y, entity.x - target.x);
    const blast = { x: target.x + Math.cos(angle) * 24, y: target.y + Math.sin(angle) * 24,
      z: floorAt(state, target), name: 'ArchvileFire' };
    explodeAt(project, state, blast, 70, 70, 'Fire');
    entity.vileFire = null;
    saySound(state, 'DSVILATK', entity);
  },
  // A_KeenDie(doortag = 666): when no other thing of the same class is alive, open the
  // tagged doors. It never touches other monsters.
  A_KeenDie(ctx) {
    const { project, state, entity } = ctx;
    const kind = String(entity?.actorName || entity?.name || '').toLowerCase();
    if (state.entities.some(candidate => candidate !== entity && candidate.type === 'enemy' && (candidate.health ?? 0) > 0 &&
      String(candidate.actorName || candidate.name || '').toLowerCase() === kind)) return;
    registerSpecialExecutor.run?.(project, state, 11, [numArg(ctx, 0, 666) || 666, 16], { format: 'zdoom' });
  },
  A_BossDeath(ctx) {
    const { state, entity } = ctx;
    // Two monsters of one class share both their id and their name, so comparing the names as well
    // made this guard unreachable: MAP07 opened its exit when the *first* of its two Mancubi died.
    if (state.entities.some(candidate => candidate !== entity && candidate.type === 'enemy' && candidate.health > 0 &&
      candidate.actorId === entity.actorId)) return;
    state.bossDefeated = true;
    // A boss level ends through the floor its boss death moves: E1M8 lowers the sectors tagged 666
    // once the last Baron is down, and Doom 2's MAP07 lowers the same tag for its Mancubi. A map
    // without those tags keeps playing, exactly as it does in Doom — its exit lines still work.
    const run = registerSpecialExecutor.run;
    if (typeof run === 'function') run(ctx.project, state, 21, [666, 1, 0, 0, 0], { format: 'zdoom', activator: entity });
  },
  // ------------------------------------------------------------------ Icon of Sin
  // The action pointers Doom's finale is written in. The states that call them live in the
  // imported classes, so these only have to do what their names say.
  A_BrainAwake(ctx) {
    const brain = bossBrainState(ctx.state);
    brain.targets = ctx.state.entities.filter(entity => bossMarker(entity) && !entity.removed).map(entity => entity.id);
    brain.cursor = 0;
    brain.awake = true;
    saySound(ctx.state, 'DSBOSSIT');
  },
  A_BrainPain(ctx) { saySound(ctx.state, 'DSBOSPN'); },
  A_BrainSpit(ctx) {
    const { project, state, entity } = ctx;
    const brain = bossBrainState(state);
    // A class can spit without ever having woken: Doom crashes there, which is not worth
    // reproducing, so the spots are collected on the first spit instead.
    if (!brain.awake) {
      brain.targets = state.entities.filter(candidate => bossMarker(candidate) && !candidate.removed).map(candidate => candidate.id);
      brain.awake = true;
    }
    // Doom skips every other shot on the two easiest skills.
    brain.easy = !brain.easy;
    if (brain.easy && easySkill(state)) return;
    if (!brain.targets.length) return;
    const target = state.entities.find(candidate => candidate.id === brain.targets[brain.cursor % brain.targets.length]);
    brain.cursor = (brain.cursor + 1) % brain.targets.length;
    if (!target) return;
    const speed = Math.max(1, Number(projectActorIndex(project).byName.get('spawnshot')?.speed) || 10);
    const from = { x: entity.x, y: entity.y, z: (entity.z ?? floorAt(state, entity)) + Math.min(32, (entity.height || 56) * .5) };
    const to = { x: target.x, y: target.y, z: (target.z ?? floorAt(state, target)) + Math.min(32, (target.height || 56) * .5) };
    const cube = spawnLiveActor(project, state, 'SpawnShot', from);
    if (!cube) return;
    // The cube flies in a straight line, as P_SpawnMissile aims it; the distance decides how
    // many of its three-tic state cycles it takes to arrive.
    const tics = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / speed));
    cube.flight = { from, to, tics, elapsed: 0 };
    cube.bossTargetId = target.id;
    // A_SpawnSound runs A_SpawnFly on the cube's first frame, so the count starts one short.
    cube.reactionTime = Math.max(1, Math.ceil(tics / 3) - 1);
    saySound(state, 'DSBOSPIT');
  },
  A_SpawnSound(ctx) {
    saySound(ctx.state, 'DSBOSCUB', ctx.entity);
    ACTIONS.A_SpawnFly(ctx);
  },
  A_SpawnFly(ctx) {
    const { project, state, entity } = ctx;
    if ((entity.health ?? 0) <= 0 || entity.removed) return;
    if (entity.reactionTime !== undefined && --entity.reactionTime > 0) return;
    if (entity.flight && entity.flight.elapsed < entity.flight.tics) return;
    const target = state.entities.find(candidate => candidate.id === entity.bossTargetId) || entity;
    const at = { x: target.x, y: target.y, z: target.z ?? floorAt(state, target) };
    // The landing is a fire and a teleport, then the monster steps out of it.
    spawnEffect(project, state, 'SpawnFire', at);
    saySound(state, 'DSTELEPT', target);
    // `randomDamage(state, damage, sides)` multiplies by `damage`, so a damage of 0 rolled 0 every
    // time and the table below could only ever return its first entry: every skull cube in the
    // Icon of Sin fight produced an imp.
    const roll = randomDamage(state, 1, 256) - 1;
    // The class the roll names, or the first one this project actually defines: an imported game
    // that ships only some of Doom's monsters must still put something in the room rather than
    // nothing at all.
    const from = SPAWN_CUBE_MONSTERS.findIndex(([limit]) => roll < limit);
    const order = from < 0 ? SPAWN_CUBE_MONSTERS : [...SPAWN_CUBE_MONSTERS.slice(from), ...SPAWN_CUBE_MONSTERS.slice(0, from)];
    let monster = null;
    for (const [, name] of order) { monster = spawnLiveActor(project, state, name, at); if (monster) break; }
    if (monster) {
      monster.angle = Math.atan2(state.player.y - monster.y, state.player.x - monster.x) * 180 / Math.PI;
      if (canSeePlayer(state, monster, SIGHT_RANGE)) setActorState(project, monster, 'See');
      telefragAt(project, state, monster);
    }
    removeLiveActor(state, entity);
  },
  // Doom fills the screen with explosions in front of the face; this engine's fire effect is
  // what it has to draw them with.
  A_BrainScream(ctx) {
    const { project, state, entity } = ctx;
    saySound(state, 'DSBOSDTH');
    for (let offset = -196; offset < 320; offset += 8) {
      spawnEffect(project, state, 'SpawnFire', {
        x: entity.x + offset, y: entity.y - 320, z: 128 + randomDamage(state, 0, 255),
        vz: randomDamage(state, 0, 512) / 8,
      });
    }
  },
  A_BrainExplode(ctx) {
    const { project, state, entity } = ctx;
    spawnEffect(project, state, 'SpawnFire', {
      x: entity.x + randomDamage(state, -2048, 2048), y: entity.y, z: 128 + randomDamage(state, 0, 255),
      vz: randomDamage(state, 0, 512) / 8,
    });
  },
  // The head's last frame: Doom's G_ExitLevel. The hook is the runtime's own intermission
  // transition, so the level ends exactly where an exit line would have ended it.
  A_BrainDie(ctx) {
    ctx.state.bossDefeated = true;
    ctx.state.finishLevel?.('normal');
  },
  // A_Explode(damage, distance, flags, alertMonsters, fulldamagedistance): Doom's
  // own defaults are 128 damage over a 128-unit radius. A missile's Death state is
  // where this now runs, so a rocket's blast comes from its definition.
  A_Explode(ctx) {
    explodeAt(ctx.project, ctx.state, ctx.entity, numArg(ctx, 0, 128), numArg(ctx, 1, 128), ctx.actor?.damageType || null);
  },
  A_RadiusDamage(ctx) {
    const { project, state, entity } = ctx;
    const radius = numArg(ctx, 0, 128), damage = numArg(ctx, 1, 0);
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) < radius) damagePlayer(state, damage);
    for (const other of state.entities) {
      if (other === entity || other.type !== 'enemy' || other.health <= 0) continue;
      if (Math.hypot(other.x - entity.x, other.y - entity.y) >= radius) continue;
      hurtActor(project, state, other, damage, blastSource(state, entity), ctx.actor?.damageType || null);
    }
  },
  A_Jump(ctx) {
    const { state, entity, actor } = ctx;
    const chance = numArg(ctx, 0, 0);
    // GZDoom: a chance of 256 (or more) always jumps, 0 never does.
    if (chance < 256 && randomDamage(state, 1, 256) > chance) return;
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
    // GZDoom's CheckIfCloser: the actor's target, 2D distance, and unless `noz` the vertical gap.
    const { state, entity, project } = ctx;
    const target = actorTarget(state, entity);
    const distance = numArg(ctx, 0, 0);
    if (!target || Math.hypot(target.x - entity.x, target.y - entity.y) >= distance) return;
    if (!truthyArg(arg(ctx, 2, false))) {
      const z = entity.z ?? floorAt(state, entity), targetZ = target.z ?? floorAt(state, target);
      const height = thing => (thing === state.player || thing.type === 'player' ? 56 : actorOf(project, thing)?.height ?? 56);
      if (z > targetZ ? z - targetZ - height(target) >= distance : targetZ - z - height(entity) >= distance) return;
    }
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(1, 2)] });
  },
  A_JumpIfHealthLower(ctx) {
    const { entity, actor } = ctx;
    if (entity.health >= numArg(ctx, 0, 0)) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(1, 2)] });
  },
  A_JumpIfNoAmmo(ctx) {
    // Weapons resolve ammo themselves; monsters have no ammo so this never fires.
    if (ctx.actor.flags?.WEAPON) return;
  },
  A_JumpIfInventory(ctx) {
    // (item, amount, label, owner): the trailing pointer is not another label.
    const runtime = actorStateOf(ctx.entity);
    if (!hasInventory(ctx.project, runtime, String(arg(ctx, 0) || ''), numArg(ctx, 1, 0))) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(2, 3)] });
  },
  A_JumpIfInTargetInventory(ctx) {
    const holder = inventoryHolder(ctx.state, actorTarget(ctx.state, ctx.entity));
    if (!holder) return;
    if (!hasInventory(ctx.project, actorStateOf(holder), String(arg(ctx, 0) || ''), numArg(ctx, 1, 0))) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ...ctx.args.slice(2, 3)] });
  },
  A_JumpIfTargetInLOS(ctx) {
    // (label, fov, flags, dist_max, dist_close): a fov or distance of 0 means no limit.
    const { state, entity } = ctx;
    const target = actorTarget(state, entity);
    const fov = numArg(ctx, 1, 0), range = numArg(ctx, 3, 0);
    if (!target || !canSeeTarget(state, entity, target, range > 0 ? range : Infinity, fov > 0 ? fov : 360)) return;
    ACTIONS.A_Jump({ ...ctx, args: [256, ctx.args[0]] });
  },
  // An amount of 0 (the default) gives one; the item's MaxAmount caps the total.
  A_GiveInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    const amount = Math.max(1, numArg(ctx, 1, 0));
    const most = inventoryMaxAmount(ctx.project, item);
    const held = runtime.inventory.get(item) || 0;
    runtime.inventory.set(item, most === null ? held + amount : Math.max(held, Math.min(most, held + amount)));
  },
  // An amount of 0 (the default) takes every one.
  A_TakeInventory(ctx) {
    const runtime = actorStateOf(ctx.entity);
    const item = String(arg(ctx, 0) || '');
    const amount = numArg(ctx, 1, 0);
    const held = runtime.inventory.get(item) || 0;
    runtime.inventory.set(item, amount > 0 ? Math.max(0, held - amount) : 0);
  },
  A_GiveToTarget(ctx) {
    const holder = inventoryHolder(ctx.state, actorTarget(ctx.state, ctx.entity));
    if (holder) ACTIONS.A_GiveInventory({ ...ctx, entity: holder });
  },
  A_ClearTarget(ctx) { setActorTarget(ctx.entity, null); },
  A_SetScale(ctx) { ctx.entity.scale = numArg(ctx, 0, 1); },
  A_ChangeFlag(ctx) {
    const flag = String(arg(ctx, 0) || '').toUpperCase();
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
    // `chance` is the probability the item appears, out of 256 — the roll was compared the other
    // way round, so a chance of 64 spawned 75% of the time and a chance of 200 spawned 21%.
    const chance = numArg(ctx, 9, 0);
    if (chance > 0 && chance < 256 && randomDamage(state, 1, 256) > chance) return;
    // GZDoom: the angle adds to the spawner's facing, and in that frame x is forward and
    // y is to the right, for both the offset and the velocity, unless flagged absolute.
    const flags = flagArg(ctx, 8, SPAWN_FLAGS);
    const angle = (numArg(ctx, 7, 0) + (flags & 4 ? 0 : facingOf(entity))) * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle);
    const xofs = numArg(ctx, 1, 0), yofs = numArg(ctx, 2, 0);
    let vx = numArg(ctx, 4, 0), vy = numArg(ctx, 5, 0);
    const [dx, dy] = flags & 2 ? [xofs, yofs] : [xofs * c + yofs * s, xofs * s - yofs * c];
    if (!(flags & 8)) [vx, vy] = [vx * c + vy * s, vx * s - vy * c];
    const position = { x: entity.x + dx, y: entity.y + dy, z: (entity.z ?? floorAt(state, entity)) + numArg(ctx, 3, 0) };
    spawnItemAt(project, state, entity, spawned, position, { vx, vy, vz: numArg(ctx, 6, 0) });
  },
  // A_SpawnItem(class, distance, zheight): straight ahead; a distance of 0 places it just
  // clear of the spawner.
  A_SpawnItem(ctx) {
    const { project, state, entity } = ctx;
    const name = String(arg(ctx, 0) || '').replace(/^"|"$/g, '');
    const spawned = projectilesByName(project).byName.get(name.toLowerCase());
    if (!spawned) return;
    const distance = numArg(ctx, 1, 0) || (actorOf(project, entity)?.radius ?? entity.radius ?? 0) + (spawned.radius ?? 0);
    const facing = facingOf(entity) * Math.PI / 180;
    spawnItemAt(project, state, entity, spawned, { x: entity.x + Math.cos(facing) * distance,
      y: entity.y + Math.sin(facing) * distance, z: (entity.z ?? floorAt(state, entity)) + numArg(ctx, 2, 0) });
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

/**
 * The Icon of Sin.
 *
 * Doom's last boss is not one thing. `BossBrain` is the head on the wall: shootable, and its
 * death state ends the level. `BossEye` is the invisible spitter at the top of the tower, which
 * looks at the player, then aims skull cubes at marker spots. `BossTarget` is a marker spot where
 * a cube lands and a monster steps out of the fire. None of them carries `MF_MONSTER`, so the
 * import promotes the classes that call the `A_Brain*` actions to live actors (see `actorRoleOf`
 * in `wad.js`): the behaviour lives in their states, as it does for every other imported class.
 */
const BOSS_TARGET_THING = 87;

/** A marker spot a skull cube can land on: GZDoom's `BossTarget`, editor number 87. */
function bossMarker(entity) {
  return entity?.bossTarget === true || entity?.doomType === BOSS_TARGET_THING ||
    /^bosstarget$/i.test(String(entity?.actorName || ''));
}

/** The state `A_BrainAwake` builds and `A_BrainSpit` walks: spots, a cursor, the easy-skill toggle. */
function bossBrainState(state) {
  return state.bossBrain || (state.bossBrain = { targets: [], cursor: 0, easy: false, awake: false });
}

/** Doom halves the boss's fire rate on the two easiest skills. */
function easySkill(state) {
  const difficulty = Number(state.settings?.difficulty);
  return Number.isFinite(difficulty) && difficulty <= 1;
}

/**
 * Spawns an actor that has to *think* rather than fly: a skull cube, a monster out of a cube.
 *
 * `spawnProjectileEntity` deliberately keeps only kill-counting actors, because a monster's
 * projectile is an effect with a clip and nothing else. A cube walks its own states and calls
 * `A_SpawnFly` from them, so it is a full entity — as is the monster the cube becomes.
 */
function spawnLiveActor(project, state, actorName, position) {
  const actor = projectActorIndex(project).byName.get(String(actorName || '').toLowerCase());
  if (!actor || state.entities.length >= 900) return null;
  state.spawnSequence = (state.spawnSequence || 0) + 1;
  const entity = {
    id: `spawned_${state.spawnSequence}`, type: 'enemy', name: actor.name,
    actorId: actor.id, actorName: actor.name, actorResolved: true,
    x: position.x, y: position.y, z: Number.isFinite(position.z) ? position.z : floorAt(state, position),
    angle: 0, health: Math.max(1, actor.health || 20), elevation: 0,
  };
  entity.maxHealth = entity.health;
  entity.radius = actor.radius ?? entity.radius;
  entity.height = actor.height ?? entity.height;
  state.entities.push(entity);
  return entity;
}

/**
 * `P_CheckForResurrection`: the corpse an Archvile raises.
 *
 * Doom looks at the square the Archvile is stepping into, and a dead body there whose class has a
 * Raise state stands up at full health, in its Raise state, hating what the Archvile hates. The
 * Archvile then enters its Heal state, which is a long, defenceless animation — the window a
 * player uses to kill it.
 */
function raiseCorpse(ctx) {
  const { project, state, entity } = ctx;
  const reach = Math.max(40, (Number(entity.radius) || 20) * 2 + 16);
  for (const corpse of state.entities) {
    if (corpse === entity || corpse.removed || corpse.type !== 'enemy' || (corpse.health ?? 0) > 0) continue;
    if (Math.hypot(corpse.x - entity.x, corpse.y - entity.y) > reach) continue;
    const actor = actorOf(project, corpse);
    if (!actor || actor.states?.labels?.Raise === undefined) continue;
    if (!canSeeTarget(state, entity, corpse, reach + 64)) continue;
    corpse.health = Math.max(1, Number(actor.health) || 20);
    corpse.solid = true;
    corpse.noBlockmap = false;
    corpse.gibbed = false;
    corpse.actorDeadHandled = false;
    corpse.queuedCorpse = false;
    const runtime = actorStateOf(corpse);
    runtime.gone = false; runtime.stopped = false;
    setActorState(project, corpse, 'Raise', { restart: true });
    setActorTarget(corpse, state.player);
    saySound(state, 'vile/raise', corpse);
    restoreBlocking(state, corpse);
    state.worldRevision++;
    return setActorState(project, entity, 'Heal') || true;
  }
  return false;
}

/**
 * `A_PainShootSkull`: spawn a Lost Soul `prestep` units away at `offset` degrees and send it at
 * the player.
 *
 * The distance matters: Doom spawns `4 + (radius + soulradius) * 1.5` ahead so the new thing is
 * outside the Elemental's own body, and it checks the ceiling first, because a soul spawned into
 * a ceiling is a soul stuck in the floor.
 */
function painShootSkull(ctx, offset) {
  const { project, state, entity } = ctx;
  const index = projectilesByName(project);
  const soulActor = index.byName.get('lostsoul');
  if (!soulActor) return null;
  const height = Number(entity.height ?? actorOf(project, entity)?.height ?? 56);
  const z = entity.z ?? floorAt(state, entity);
  const sector = state.sectors.length ? sectorAt(state.sectors, entity.x, entity.y) : null;
  if (sector && z + height + 8 > sector.ceilingHeight) return null;
  // Doom's `COMPATF_LIMITPAIN`: twenty-one skulls is the most a level holds.
  if (state.entities.filter(candidate => !candidate.removed && candidate.actorName === soulActor.name).length >= 21) return null;
  const radius = Number(entity.radius ?? actorOf(project, entity)?.radius ?? 20);
  const prestep = 4 + (radius + Number(soulActor.radius ?? 16)) * 1.5;
  const angle = ((entity.angle || 0) + offset) * Math.PI / 180;
  const soul = spawnLiveActor(project, state, soulActor.name,
    { x: entity.x + Math.cos(angle) * prestep, y: entity.y + Math.sin(angle) * prestep, z: z + 8 });
  if (!soul) return null;
  setActorTarget(soul, state.player);
  setActorState(project, soul, 'See');
  // `other.A_SkullAttack()` — the soul is already flying at the player on the tic it appears.
  ACTIONS.A_SkullAttack({ project, state, entity: soul, actor: soulActor, args: [], named: {} });
  return soul;
}

/**
 * One tic of a `MF_SKULLFLY` charge, and what it hits.
 *
 * Doom's `P_SkullFly` moves the thing by its momentum and lets `PIT_CheckThing` damage whatever
 * it lands on with `((P_Random()&7)+1)*3`; a wall or a floor stops it, and it goes back to See.
 */
function advanceSkullfly(project, state, entity) {
  const fly = entity.skullfly;
  fly.tics++;
  const stepX = fly.vx / TIC_RATE, stepY = fly.vy / TIC_RATE, stepZ = fly.vz / TIC_RATE;
  const length = Math.hypot(stepX, stepY);
  const radius = Number(entity.radius) || 16;
  const stop = () => {
    entity.skullfly = null;
    if (entity.health > 0) setActorState(project, entity, 'See');
  };
  // A thing in the charge's path takes the slam; the charge ends on it, as `PIT_CheckThing` does.
  const victim = () => {
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) <= radius + 16) return state.player;
    for (const other of state.entities) {
      if (other === entity || other.removed || other.type !== 'enemy' || (other.health ?? 0) <= 0) continue;
      if (Math.hypot(other.x - entity.x, other.y - entity.y) <= radius + (Number(other.radius) || 20)) return other;
    }
    return null;
  };
  const slam = () => {
    const target = victim();
    if (!target) return false;
    const damage = randomDamage(state, 3, 8);
    if (target === state.player) damagePlayer(state, damage);
    else hurtActor(project, state, target, damage, entity, null);
    return true;
  };
  if (slam()) { stop(); return; }
  // A wall stops the charge where it stands: `geometryDistance` is the same trace the AI uses.
  if (length > 0 && geometryDistance(state, { x: entity.x, y: entity.y, z: (entity.z ?? 0) + 28 },
    { x: stepX / length, y: stepY / length, z: 0 }, length + .01, true) < length) { stop(); return; }
  entity.x += stepX; entity.y += stepY;
  const ground = floorAt(state, { x: entity.x, y: entity.y, elevation: 0 });
  const ceiling = state.sectors.length ? (sectorAt(state.sectors, entity.x, entity.y)?.ceilingHeight ?? ground + 128) : ground + 128;
  const next = (entity.z ?? ground) + stepZ;
  entity.z = Math.max(ground, Math.min(ceiling - (Number(entity.height) || 56), next));
  state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
  // A charge that hits nothing at all runs out, and one that ground itself stops there.
  if (fly.tics > 40 || (next < ground && stepZ < 0)) stop();
}

/** One tic of a cube's flight between the spitter and its spot. */
function advanceFlight(entity) {
  const flight = entity.flight;
  flight.elapsed++;
  const done = Math.min(1, flight.elapsed / flight.tics);
  entity.x = flight.from.x + (flight.to.x - flight.from.x) * done;
  entity.y = flight.from.y + (flight.to.y - flight.from.y) * done;
  entity.z = flight.from.z + (flight.to.z - flight.from.z) * done;
  if (done >= 1) entity.flight = null;
}

/**
 * Gives a body that stopped blocking its collider back.
 *
 * `A_NoBlocking` takes the collider out of the physics world, and Rapier frees it on removal, so
 * a monster that stands up again needs a new one: the body is dropped and rebuilt from the actor
 * table, which is exactly what a spawn does.
 */
export function restoreBlocking(state, entity) {
  if (!state.physics?.add) return;
  entity.solid = true;
  entity.noBlockmap = false;
  state.physics.remove(entity.id);
  state.physics.add(entity.id);
}

/** Takes a spawned actor out of the level without leaving a hole in the array being walked. */
function removeLiveActor(state, entity) {
  entity.removed = true;
  state.actorRemovals = true;
}

/**
 * A cube that lands on something kills it, whoever it is.
 *
 * Doom calls `P_TeleportMove` when the monster appears, and a telefrag goes through god mode:
 * this is the reason a player standing on a boss spot dies with the cube that lands there.
 */
function telefragAt(project, state, monster) {
  const span = Math.max(16, (Number(monster.radius) || 20) * 2);
  if (Math.hypot(state.player.x - monster.x, state.player.y - monster.y) < span) {
    damagePlayer(state, Math.max(1000, Number(state.playerStats?.health) || 100));
  }
  for (const other of state.entities) {
    if (other === monster || other.removed || other.type !== 'enemy' || (other.health ?? 0) <= 0) continue;
    if (Math.hypot(other.x - monster.x, other.y - monster.y) >= span + (Number(other.radius) || 20)) continue;
    hurtActor(project, state, other, (other.health ?? 0) + 1, null);
  }
}

/**
 * Doom's cube-to-monster table, decreasing likelihood and all: an imp more often than a baron.
 * The classes are looked up by name so a mod that replaces one spawns its replacement.
 */
const SPAWN_CUBE_MONSTERS = [
  [50, 'DoomImp'], [90, 'ShotgunGuy'], [120, 'Spectre'], [130, 'PainElemental'], [160, 'Cacodemon'],
  [162, 'Archvile'], [172, 'Revenant'], [192, 'Arachnotron'], [222, 'Mancubus'], [246, 'HellKnight'],
  [256, 'BaronOfHell'],
];

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

/** Monsters spawned by an actor stay real things; anything else becomes an effect. */
function spawnItemAt(project, state, owner, actor, position, velocity = {}) {
  if (actor.flags?.COUNTKILL === true || actor.name.toLowerCase() === 'lostsoul') {
    const entity = spawnProjectileEntity(project, state, owner, actor);
    if (entity && state.entities.includes(entity)) Object.assign(entity, { x: position.x, y: position.y });
    return;
  }
  spawnEffect(project, state, actor.name, { ...position, ...velocity });
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
      if (entity.type !== 'enemy' || entity.removed) continue;
      // A dead monster finishes its Death state and then rests on its corpse
      // frame; it must keep ticking until the state machine ends.
      if (entity.health <= 0 && !entity.actorDeadHandled) {
        entity.actorDeadHandled = true;
        // `health < GetGibHealth()`, and GetGibHealth is minus the spawn health: a body that took
        // more than twice its health in one hit comes apart in its XDeath ("Extreme") state, which
        // is the difference between a pistol corpse and a shotgun corpse.
        const actor = actorOf(project, entity);
        const gibHealth = -(Number(actor?.health) || 20);
        if (entity.health < gibHealth && setActorState(project, entity, 'XDeath')) {
          entity.gibbed = true;
        } else setActorState(project, entity, 'Death');
      }
      if (entity.skullfly) advanceSkullfly(project, state, entity);
      // The Archvile's flame burns where the player is while the Archvile can see them (A_Fire),
      // and is drawn by repeating its two-tic frame — there is no fire actor to tick.
      if (entity.vileFire) {
        if (canSeeTarget(state, entity, state.player, SIGHT_RANGE)) {
          entity.vileFire.x = state.player.x;
          entity.vileFire.y = state.player.y;
          entity.vileFire.z = floorAt(state, state.player);
        }
        spawnEffect(project, state, 'ArchvileFire', { ...entity.vileFire });
      }
      // A popped satellite is thrown clear and bursts on a fuse. GZDoom counts that down in the
      // ball's Pain state, but a frame runs its action only when it is entered and that state ends
      // in `Wait`, so the countdown has to live outside the state machine here.
      if (Number.isFinite(entity.sorcFuse) && entity.sorcFuse > 0) {
        entity.sorcFuse = Math.max(0, entity.sorcFuse - 1 / TIC_RATE);
        const ground = floorAt(state, { x: entity.x, y: entity.y, elevation: 0 });
        entity.x += (entity.vx || 0) / TIC_RATE;
        entity.y += (entity.vy || 0) / TIC_RATE;
        entity.vz = (entity.vz || 0) - TIC_RATE;
        entity.z = Math.max(ground, (entity.z ?? ground) + (entity.vz || 0) / TIC_RATE);
        if (entity.sorcFuse <= 0) {
          setActorState(project, entity, 'Death');
          saySound(state, 'SorcererBigBallExplode', entity);
        }
      }
      const runtime = actorStateOf(entity);
      if (runtime.index === null && runtime.initialised) continue;
      actorTic(project, state, entity);
    }
    // A cube that landed is gone; compacting here keeps the walk above from seeing a hole.
    if (state.actorRemovals) {
      state.entities = state.entities.filter(entity => !entity.removed);
      state.actorRemovals = false;
    }
  }
}

/**
 * The spot a `Teleport` line under a landed thing sends it to, or null.
 *
 * Doom's `Teleport` (line special 70) names its destination by the *tag* of a
 * `TeleportDest2` thing, and fires when an actor crosses the line. A falling star never
 * crosses anything horizontally, but the mapper put the line inside its footprint, and
 * GZDoom teleports it on the tic it reaches the floor — measured on TITLEMAP, a star falls
 * for about 120 tics, reappears at its destination and starts again. The lines and their
 * destinations are collected once, because this runs for every thing on every tic.
 */
function teleportLanding(state, entity) {
  const radius = Number(entity.radius) || 16;
  const lines = (state.teleportLines ||= collectTeleportLines(state));
  if (!lines.length) return null;
  for (const line of lines) {
    if (distanceToSegment(entity.x, entity.y, line.a, line.b) > radius) continue;
    const destination = state.entities.find(candidate => candidate.tid === line.tag &&
      (candidate.doomType === 9044 || candidate.doomType === 14 || /^TeleportDest/i.test(candidate.name || '')));
    if (!destination) continue;
    const sector = sectorAt(state.sectors, destination.x, destination.y);
    return { x: destination.x, y: destination.y,
      z: (sector?.floorHeight ?? 0) + (destination.elevation || 0), angle: destination.angle };
  }
  return null;
}

function collectTeleportLines(state) {
  const walls = state.walls || [];
  const lines = [];
  for (const wall of walls) {
    if (wall.special !== 70 && wall.special !== 71) continue;
    const tag = wall.args?.[0];
    if (!tag || !wall.start || !wall.end) continue;
    lines.push({ a: wall.start, b: wall.end, tag });
  }
  return lines.length > 64 ? lines.slice(0, 64) : lines;
}

function distanceToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

/**
 * Doom's gravity, in map units per tic squared.
 *
 * GZDoom computes it as `sv_gravity * sector.gravity * actor.gravity * 0.00125`
 * (`AActor::GetGravity`), and `sv_gravity` is 800 by default, so an ordinary sector pulls
 * a thing down by one unit per tic. Lullaby's title map sets `gravity = 0.2` on the sectors
 * that hold its falling stars, which is why they drift down at a fifth of that rate.
 */
const SV_GRAVITY = 800;
const GRAVITY_SCALE = 0.00125;

/**
 * Falls for things the map placed in the air.
 *
 * A thing with neither `NOGRAVITY` nor `FLOAT` falls in Doom, and that is the whole of
 * Lullaby's meteor shower: its stars are ordinary map things dropped at an elevation, with
 * the map's own gravity deciding how fast they come down. Only entities without a rigid
 * body are moved here — Rapier already simulates the rest — and the fall stops on the
 * sector floor (or the top of a solid 3D floor) exactly as `P_ZMovement` does.
 */
export function stepThingGravity(project, state, dt, { levelGravity = SV_GRAVITY } = {}) {
  if (!project.actors?.length) return;
  state.gravityClock = (state.gravityClock || 0) + dt * TIC_RATE;
  const whole = Math.floor(state.gravityClock + 1e-6);
  const tics = Math.min(whole, MAX_TICS_PER_STEP);
  state.gravityClock -= whole;
  for (let tic = 0; tic < tics; tic++) {
    for (const entity of state.entities) {
      if (entity.type === 'player' || entity.type === 'ramp') continue;
      // A follower's height is the route's, so falling would fight the path it is walking.
      if (entity.path?.id) { entity.fallSpeed = 0; continue; }
      // Rapier already drops the objects that have a body.
      if (entity.physics && entity.physics.body !== 'none') continue;
      const actor = actorOf(project, entity);
      if (!actor || actorFlag(actor, 'NOGRAVITY', entity) || actorFlag(actor, 'FLOAT', entity)) {
        entity.fallSpeed = 0;
        continue;
      }
      const sector = sectorAt(state.sectors, entity.x, entity.y);
      const z = Number.isFinite(entity.z) ? entity.z : (sector?.floorHeight ?? 0) + (entity.elevation || 0);
      // The floor is measured from where the thing is now, so a fall onto the top of a
      // solid 3D floor lands on it instead of dropping through to the sector's own floor.
      const ground = sector ? floorHeightAt(sector, z) : 0;
      if (z <= ground) {
        // Already standing, or buried — `settleGroundActors` reports and fixes a buried thing.
        entity.fallSpeed = 0;
        // A thing that has just landed on a `Teleport` line goes back to its destination and
        // falls again: Lullaby's shower is one drop per star, repeated for as long as the map
        // is on screen, and the destination sits directly above the line it lands on.
        const landing = teleportLanding(state, entity);
        if (landing) {
          entity.x = landing.x; entity.y = landing.y; entity.z = landing.z;
          if (Number.isFinite(landing.angle)) entity.angle = landing.angle;
          entity.fallSpeed = 0;
        }
        continue;
      }
      // The map's thing may override the actor's own multiplier, as UDMF `gravity` does.
      // Zero is a real value there — MAP01 gives some things none — so it is not a fallback.
      const own = Number(entity.gravity ?? actor.gravity ?? 1);
      if (!(own > 0)) { entity.fallSpeed = 0; continue; }
      const sectorPull = sector?.gravity ?? 1;
      if (!(sectorPull > 0)) { entity.fallSpeed = 0; continue; }
      const pull = levelGravity * sectorPull * own * GRAVITY_SCALE;
      // Doom moves the thing by its speed first and only then applies gravity for the next
      // tic (`P_ZMovement` calls `AddZ(Vel.Z)` before `FallAndSink`), so the first tic of a
      // fall does not move at all. The trace compares tic by tic, so the order matters.
      const next = z + (entity.fallSpeed || 0);
      // `P_ZMovement` snaps the thing to the floor and drops its vertical speed on impact.
      entity.z = next <= ground ? ground : next;
      entity.fallSpeed = next <= ground ? 0 : (entity.fallSpeed || 0) - pull;
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
    if (entity.actorResolved) continue;
    const actor = (entity.doomType !== undefined && index.byDoomed.get(entity.doomType)) ||
      (entity.actorName && index.byName.get(String(entity.actorName).toLowerCase())) || null;
    // A level imported before the Icon of Sin's classes were promoted stores its head and its
    // spitter as decorations. Their states are the fight, so they become live actors here too —
    // otherwise an existing campaign could never reach its own ending without a re-import.
    if (actor && entity.type !== 'enemy' && isBossBrainActor(actor)) entity.type = 'enemy';
    // Anything that is not an actor keeps its shape: a pickup the level placed is data, and
    // stamping an actor field on it changes what a save compares against its template.
    if (entity.type !== 'enemy') continue;
    entity.actorResolved = true;
    if (!actor) continue;
    entity.actorId = actor.id;
    entity.actorName = actor.name;
    // `MF_FLOAT` is what makes a Cacodemon or a Lost Soul fly: the movement path reads this
    // rather than the actor table, which combat.js cannot import without a cycle.
    entity.floating = actorFlag(actor, 'FLOAT', entity);
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

export const WEAPON_ACTOR_BY_SLOT = {
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
  // Which state A_ReFire repeats; `A_WeaponReady` records AltFire when that is what started.
  state.weaponRefireLabel = null;
  return true;
}

/**
 * Steps the player's weapon state machine for one 35 Hz tic.
 *
 * `presentation` runs the states for their pictures and sounds only: a weapon whose
 * firing is an event rule still plays its own reload and charge sounds, but never
 * fires, spends ammo or leaves its ready state on its own.
 */
export function weaponTic(project, state, attackHeld, { presentation = false } = {}) {
  const runtime = state.weaponActor;
  if (!runtime?.actor) return;
  // The flash runs on its own clock, beside whatever the gun is doing.
  flashTic(project, state);
  const actor = runtime.actor;
  const frames = actor.states.frames;
  const frame = frames[runtime.index];
  if (!frame) { runtime.index = labelIndex(actor, 'Ready') ?? 0; return; }
  const context = { project, state, entity: state.player, actor, weapon: true, runtime, presentation };
  // The gun's own psprite follows the state it is in, exactly as an enemy's picture does, so the
  // gun and the muzzle flash are always drawn from the same clock. Driving the gun from a separate
  // clip instead let the flash arrive before the barrel had reached the frame it belongs to.
  state.weaponAsset = frame.kind === 'frame' ? frameAsset(project, frame) : state.weaponAsset;
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
  'A_LoadShotgun2', 'A_CloseShotgun2', 'A_FireOldBFG']);

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
      // A translated weapon is fired by its rules, so this state only presents: the
      // trigger is not its to consume, and entering a Fire state would fire twice.
      if (ctx.presentation || state.hudState?.cursor) return;
      // GZDoom's alt attack starts here as well, so a mod's secondary fire is reached
      // through the same ready state its primary fire is.
      const alt = state.weaponAltHeld === true;
      if (!alt && !state.weaponTriggerHeld) return;
      const label = alt && labelIndex(actor, 'AltFire') !== null ? 'AltFire' : 'Fire';
      // GZDoom consumes the attack button here: a held trigger starts the weapon's
      // own Fire sequence, which is why A_ReFire (not this) decides refiring.
      const fire = labelIndex(actor, label);
      if (fire === null) return;
      runtime.index = fire; runtime.tics = 0; runtime.entered = false; runtime.jumped = true;
      runtime.ready = false; state.weaponReady = false;
      state.weaponRefireLabel = label;
      return;
    }
    case 'A_ReFire': {
      // Doom re-enters the state it fired from while the trigger is held, otherwise
      // returns to Ready — an alt fire therefore repeats its own state, not Fire.
      const label = ctx.presentation ? null
        : state.weaponAltHeld ? 'AltFire' : state.weaponTriggerHeld ? (state.weaponRefireLabel || 'Fire') : null;
      if (label && labelIndex(actor, label) !== null) { teleportWeapon(runtime, actor, label); return; }
      teleportWeapon(runtime, actor, 'Ready');
      return;
    }
    case 'A_CheckReload':
      if (!weaponHasAmmo(state, actor)) teleportWeapon(runtime, actor, 'Ready');
      return;
    case 'A_GunFlash':
      // `A_GunFlash("KickSetup")` puts the flash psprite into that state instead of `Flash`.
      startWeaponFlash(ctx.project, state, typeof ctx.args?.[0] === 'string' ? ctx.args[0] : 'Flash');
      return;
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
    case 'A_FireOldBFG':
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

/**
 * The muzzle flash, as Doom draws it: a second psprite that runs the weapon's `Flash` state.
 *
 * The flash is not part of the gun's own animation — `A_FirePistol` and friends call
 * `A_GunFlash`, which puts the *flash* psprite into `Flash` while the gun keeps running its
 * `Fire` state underneath. Its frames carry `A_Light1`/`A_Light0`, so the picture and the
 * light it throws both come from the actor's own states.
 */
function startWeaponFlash(project, state, label = 'Flash') {
  const actor = state.weaponActor?.actor;
  const index = actor ? labelIndex(actor, label) : null;
  if (index === null) return false;
  state.weaponFlash = { index, tics: 0, entered: false, seen: new Set([index]) };
  state.weaponFlashAsset = null;
  // The first frame is shown on the tic the shot happens, as Doom's flash sprite is.
  enterFlashFrame(project, state, actor.states.frames[index]);
  return true;
}

/** Shows one frame of the flash: its picture, and the light its own action asks for. */
function enterFlashFrame(project, state, frame) {
  state.weaponFlash.entered = true;
  for (const action of frame.actions || []) {
    if (action.name === 'A_Light0') state.weaponLight = 0;
    else if (action.name === 'A_Light1') state.weaponLight = 1;
    else if (action.name === 'A_Light2') state.weaponLight = 2;
  }
  state.weaponFlashAsset = frameAsset(project, frame);
}

/** The picture a state frame draws, or null when the artwork does not exist (Doom's `TNT1`). */
function frameAsset(project, frame) {
  if (frame?.kind !== 'frame' || !frame.sprite) return null;
  const names = spriteAssetNames(project), sprite = String(frame.sprite).toUpperCase();
  return names.get(`${sprite}${frame.letter}0`) || names.get(`${sprite}${frame.letter}1`) || null;
}

/** Advances the muzzle flash one weapon tic; where the drawn flash frame is read at render time. */
function flashTic(project, state) {
  const flash = state.weaponFlash, actor = state.weaponActor?.actor;
  if (!flash || !actor) { state.weaponFlash = null; state.weaponFlashAsset = null; return; }
  const frames = actor.states.frames;
  for (let guard = 0; guard < 32; guard++) {
    const frame = frames[flash.index];
    if (!frame) break;
    if (frame.kind !== 'frame') {
      if (frame.kind === 'goto' || frame.kind === 'loop') {
        const target = labelIndex(actor, frame.kind === 'loop' ? frame.label : frame.target);
        if (target === null || target === flash.index) break;
        flash.index = target; flash.tics = 0; flash.entered = false;
        continue;
      }
      // `stop` — the state the flash runs into when it is done (Doom's own is `LightDone`).
      break;
    }
    if (!flash.entered) {
      // A flash that comes back to a frame it already showed has shown all it has. Ending it
      // is what the psprite's author meant: the alternative is a full-bright frame (and the
      // light it throws) held for the rest of the level, which is how a `Flash` state written
      // as `PISF A 7; Goto Flash` used to leave a muzzle glowing for ever.
      if (flash.seen?.has(flash.index)) break;
      flash.seen?.add(flash.index);
      enterFlashFrame(project, state, frame);
    }
    if (frame.duration < 0) return;
    flash.tics++;
    if (flash.tics < frame.duration) return;
    flash.tics = 0; flash.entered = false; flash.index++;
  }
  state.weaponFlash = null; state.weaponFlashAsset = null; state.weaponLight = 0;
}

/** Puts the drawn weapon into a named state, for a rule that animates the imported weapon. */
export function playWeaponState(project, state, label) {
  const runtime = state.weaponActor;
  if (!runtime?.actor) return false;
  const target = labelIndex(runtime.actor, label);
  if (target === null) return false;
  runtime.index = target; runtime.tics = 0; runtime.entered = false; runtime.jumped = true;
  runtime.ready = false; state.weaponReady = false;
  // `A_ReFire` repeats the state that fired; a rule choosing the state says which one.
  state.weaponRefireLabel = label === 'AltFire' ? 'AltFire' : 'Fire';
  return true;
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
  return (state.playerStats[type] || 0) >= use;
}

/**
 * Fires the player's weapon from its own action call. Damage, spread and pellet
 * counts come from the arguments the mod wrote, so a modded shotgun behaves
 * like the mod intends.
 */
// GZDoom's native weapon action functions start their own CHAN_WEAPON sound. A
// DECORATE/ZScript weapon only names the action, so the shot is silent unless the
// sound is played here. Names are logical SNDINFO aliases, not lump names.
export const FIRE_SOUNDS = {
  A_FirePistol: 'weapons/pistol', A_FireShotgun: 'weapons/shotgf', A_FireShotgun2: 'weapons/sshotf',
  A_FireCGun: 'weapons/chngun', A_FireMissile: 'weapons/rocklf', A_FirePlasma: 'weapons/plasmaf',
  A_FireBFG: 'weapons/bfgf', A_Saw: 'weapons/sawfull', A_Punch: '*fist',
  A_FireOldBFG: 'weapons/plasmaf',
};

/**
 * The shot a weapon action produces, from the arguments the mod wrote.
 *
 * Kept apart from `fireWeapon` because the event-sheet translation asks the same
 * question: an imported weapon's `A_FireBullets` becomes a `hitscan` action with
 * exactly these numbers, so the rule and the interpreter cannot drift apart.
 * `{ missing }` means a class the project does not define, and the weapon does not fire.
 */
export function weaponAttackFor(project, actionName, args = [], named = {}) {
  const ctx = { project, args, named };
  const missile = (name, damage, radius, fallbackSpeed = 700) => {
    const resolved = missileActor(project, name);
    const amount = Number(resolved?.damage);
    // An actor's `speed` is map units a tic; the rest of the engine works in units a second.
    const actorSpeed = Number(resolved?.speed) * TIC_RATE;
    const attack = { kind: 'missile', missile: resolved?.name || name,
      damage: Number.isFinite(amount) && amount > 0 ? amount : damage, diceSides: 8,
      speed: Number.isFinite(actorSpeed) && actorSpeed > 0 ? actorSpeed : fallbackSpeed, radius,
      actorId: resolved?.actorId || null, seeker: resolved?.flags?.SEEKERMISSILE === true };
    // The actor's own Death state carries the explosion, so its radius is not invented.
    if (attack.actorId) attack.radius = 0;
    return attack;
  };
  switch (actionName) {
    case 'A_FireBullets': {
      // `A_FireBullets(spread_xy, spread_z, numbullets, damage, puff, flags, range, missile)`.
      // The dice were read from argument 1 — the *vertical spread* — so a weapon's damage changed
      // when its pitch spread did and a plain 5-damage bullet did a fixed 5. A hitscan's dice are
      // Doom's three (5*(1..3)), and the range is the seventh argument.
      const spread = numArg(ctx, 0, 0), pellets = Math.max(1, Math.min(40, numArg(ctx, 2, 1)));
      const damage = Math.max(1, numArg(ctx, 3, 5)), range = numArg(ctx, 6, 2048) || 2048;
      return { attack: { kind: 'hitscan', damage: [damage, 3], pellets, spread, range } };
    }
    case 'A_FireShotgun': return { attack: { kind: 'hitscan', damage: [5, 3], pellets: 7, spread: 11.25, range: 2048 } };
    case 'A_FireShotgun2': return { attack: { kind: 'hitscan', damage: [5, 3], pellets: 20, spread: 22.5, range: 2048 } };
    case 'A_FireCGun': return { attack: { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 5.625, range: 2048 } };
    case 'A_FirePistol': return { attack: { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 } };
    case 'A_Punch': return { attack: { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64 } };
    case 'A_Saw': return { attack: { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64, hitSound: 'weapons/sawhit' } };
    case 'A_FireMissile': return { attack: missile('Rocket', 20, 128) };
    case 'A_FirePlasma': return { attack: missile('PlasmaBall', 5, 0) };
    // A_FireOldBFG (weaponbfg.zs): Doom's pre-release BFG, two plasma balls at once with no autoaim,
    // each thrown off by its own random angle and pitch. `volley` is what makes it two shots.
    case 'A_FireOldBFG': {
      const first = missile('PlasmaBall1', 5, 0), second = missile('PlasmaBall2', 5, 0);
      return { attack: { ...first, volley: [first, second] } };
    }
    case 'A_FireBFG': return { attack: missile('BFGBall', 100, 256) };
    case 'A_FireCustomMissile':
    case 'A_FireProjectile': {
      const className = String(arg(ctx, 0) || '').replace(/^"|"$/g, '');
      const resolved = missileActor(project, className);
      // No placeholder: a weapon that names a class the project does not contain
      // does not fire, and the shot is reported rather than faked.
      if (!resolved) return { missing: className };
      return { attack: { kind: 'missile', missile: resolved.name, actorId: resolved.id,
        damage: resolved.damage > 0 ? resolved.damage : 1, diceSides: 8,
        speed: (Number(resolved.speed) || 10) * TIC_RATE,
        radius: 0, seeker: resolved.flags?.SEEKERMISSILE === true,
        angle: numArg(ctx, 1, 0), spawnofs: numArg(ctx, 3, 0), spawnheight: numArg(ctx, 4, 0),
        pitch: numArg(ctx, 6, 0) } };
    }
    default: return { attack: { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 } };
  }
}

function fireWeapon(ctx, actionName) {
  const { state, actor } = ctx;
  // A_FireCustomMissile/A_FireProjectile take `useammo` as their third argument, so
  // a rocket-level hitbox fired with `false` must not spend a rocket.
  const custom = actionName === 'A_FireCustomMissile' || actionName === 'A_FireProjectile';
  const spendAmmo = !custom || !(arg(ctx, 2, true) === false || numArg(ctx, 2, 1) === 0);
  const { type, use } = weaponAmmo(actor);
  // A translated weapon still spends and shoots through its rule, but the shot sound
  // belongs to the state that fires it, so it plays here either way and the rule does
  // not repeat it. The alias is what the audio player resolves, mod included.
  if (!ctx.presentation && type && spendAmmo) {
    // `Weapon.AmmoUse 0` is a weapon that needs the ammo type but spends none.
    if ((state.playerStats[type] || 0) < use) { state.weaponTriggerHeld = false; return; }
    state.playerStats[type] -= use;
  }
  if (FIRE_SOUNDS[actionName]) saySound(state, FIRE_SOUNDS[actionName], null, 127);
  // GZDoom's own fire functions call `A_GunFlash` themselves, which is why a weapon whose
  // states never say `A_GunFlash` still throws a muzzle flash. A rule-driven weapon only
  // *presents* its Fire state, so the flash is started here, on the same tic and either way.
  startWeaponFlash(ctx.project, state);
  if (ctx.presentation) return;
  const shot = weaponAttackFor(ctx.project, actionName, ctx.args || [], ctx.named || {});
  if (shot.missing) {
    state.missileGaps ||= new Set();
    if (state.missileGaps.size < 40) state.missileGaps.add(shot.missing);
    return;
  }
  if (shot.attack) state.weaponAttack = shot.attack;
}
