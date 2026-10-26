import { sectorAt } from './sectors.js';
import { damagePlayer, floorAt, canSeePlayer, randomDamage, enemyHitscan, moveEnemy } from './combat.js';
import { actorIndex, actorForThing } from './actors.js';

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

/** Persistent per-entity actor state, created on first use. */
export function actorStateOf(entity) {
  return entity.actorState ||= { index: null, tics: 0, target: null, threshold: 0, reactionTime: 0,
    moveDir: -1, flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
}

export function createActorRuntime(project) {
  const index = actorIndex(project.actors || []);
  return { index, project, projectiles: new Map() };
}

/** Finds the actor record an entity runs. */
export function actorOf(project, entity) {
  if (!project.actors?.length) return null;
  const index = project.__actorIndex ||= actorIndex(project.actors);
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
const projectilesByName = project => project.__actorIndex ||= actorIndex(project.actors || []);

/** Spawns a projectile actor owned by an enemy, aimed at the player. */
export function spawnActorProjectile(project, state, owner, projectileName, { speed = 0, damage = null, angle = null } = {}) {
  const index = projectilesByName(project);
  const actor = index.byName.get(String(projectileName).toLowerCase()) ||
    index.byId.get(`actor_${String(projectileName).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`);
  const missileSpeed = speed || actor?.speed || 10;
  const damageValue = damage ?? actor?.damage ?? 0;
  const radians = angle ?? Math.atan2(state.player.y - owner.y, state.player.x - owner.x);
  const originZ = floorAt(state, owner) + Math.min(32, (owner.height || 56) * .5);
  const targetZ = floorAt(state, state.player) + 32;
  const horizontal = Math.hypot(state.player.x - owner.x, state.player.y - owner.y);
  const pitch = Math.atan2(targetZ - originZ, Math.max(1, horizontal));
  state.projectiles.push({
    id: ++state.projectileSequence, ownerId: owner.id, actorId: actor?.id || null,
    x: owner.x, y: owner.y, z: originZ,
    dx: Math.cos(radians) * Math.cos(pitch), dy: Math.sin(radians) * Math.cos(pitch), dz: Math.sin(pitch),
    speed: missileSpeed * 2, damage: damageValue, diceSides: 8, radius: actor?.flags?.MISSILE && damageValue ? damageValue : 0,
    age: 0, color: '#ff8833',
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
const meleeable = (state, entity) => Math.hypot(state.player.x - entity.x, state.player.y - entity.y) <= meleeRange;

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
    // Doom monsters wake on sight and on hearing gunfire, so a shot behind a
    // guard still starts the fight.
    if (!canSeePlayer(state, entity, 2048) && !hearsPlayer(state, entity)) return;
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
    moveEnemy(state, entity, speed, 1 / TIC_RATE);
    if (randomDamage(state, 1, 256) < 4) saySound(state, actor.sounds?.active, entity);
    if (runtime.reactionTime > 0) { runtime.reactionTime--; return; }
    const missileLabel = arg(ctx, 0) || 'Missile';
    const meleeLabel = arg(ctx, 1) || 'Melee';
    const distance = Math.hypot(state.player.x - entity.x, state.player.y - entity.y);
    // P_CheckMeleeRange: MELEERANGE - 20 + the monster's radius.
    if (distance <= 64 - 20 + (actor.radius || 20)) {
      if (setActorState(ctx.project, entity, meleeLabel)) {
        runtime.reactionTime = actor.reactionTime || 8;
        return;
      }
    }
    // P_CheckMissileRange: closer monsters are far more likely to shoot.
    if (!canSeePlayer(state, entity, 2048)) return;
    const reach = Math.max(0, distance - 64) - 128;
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
    entity.angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x) * 180 / Math.PI;
  },
  A_Pain(ctx) {
    saySound(ctx.state, ctx.actor.sounds?.pain, ctx.entity);
  },
  A_Scream(ctx) { saySound(ctx.state, ctx.actor.sounds?.death, ctx.entity); },
  A_XScream(ctx) { saySound(ctx.state, ctx.actor.sounds?.death, ctx.entity); },
  A_ActiveSound(ctx) { saySound(ctx.state, ctx.actor.sounds?.active, ctx.entity); },
  A_NoBlocking(ctx) {
    ctx.entity.solid = false;
    ctx.entity.noBlockmap = true;
  },
  A_Fall(ctx) { ctx.entity.solid = false; },
  A_Stop(ctx) { ctx.entity.vx = 0; ctx.entity.vy = 0; },
  A_PlaySound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StartSound(ctx) { saySound(ctx.state, String(arg(ctx, 0) || ''), ctx.entity, numArg(ctx, 1, 127)); },
  A_StopSound() {},
  A_PosAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    for (let pellet = 0; pellet < 1; pellet++) enemyShot(state, entity, 5, 3);
    saySound(state, 'DSPISTOL', entity, 90);
  },
  A_SPosAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    for (let pellet = 0; pellet < 3; pellet++) enemyShot(state, entity, 5, 3, 11.25);
    saySound(state, 'DSSHOTGN', entity, 90);
  },
  A_CPosAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    enemyShot(state, entity, 3, 3);
    saySound(state, 'DSPISTOL', entity, 80);
  },
  A_CPosRefire(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048) || randomDamage(state, 1, 256) < 40) setActorState(ctx.project, entity, 'See');
  },
  A_TroopAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { enemyShot(state, entity, 3, 8, 0); saySound(state, 'DSCLAW', entity); return; }
    spawnActorProjectile(ctx.project, state, entity, 'DoomImpBall');
    saySound(state, 'DSPISTOL', entity, 70);
  },
  A_SargAttack(ctx) {
    const { state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    enemyShot(state, entity, 4, 8, 0);
    saySound(state, 'DSCLAW', entity);
  },
  A_HeadAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    spawnActorProjectile(ctx.project, state, entity, 'CacodemonBall');
    saySound(state, 'DSCACATT', entity);
  },
  A_BruisAttack(ctx) {
    const { state, entity } = ctx;
    if (meleeable(state, entity)) { enemyShot(state, entity, 10, 8, 0); saySound(state, 'DSCLAW', entity); return; }
    spawnActorProjectile(ctx.project, state, entity, 'BaronBall');
    saySound(state, 'DSPISTOL', entity, 70);
  },
  A_BspiAttack(ctx) {
    spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'ArachnotronPlasma');
    saySound(ctx.state, 'DSPLASMA', ctx.entity, 70);
  },
  A_SkelMissile(ctx) {
    spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'RevenantTracer');
    saySound(ctx.state, 'DSPISTOL', ctx.entity, 60);
  },
  A_Tracer() { /* Tracer homing is approximated by the projectile's own flight. */ },
  A_FatAttack1(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'FatShot'); saySound(ctx.state, 'DSFIRSHT', ctx.entity); },
  A_FatAttack2(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'FatShot'); },
  A_FatAttack3(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'FatShot'); },
  A_CyberAttack(ctx) { spawnActorProjectile(ctx.project, ctx.state, ctx.entity, 'Rocket'); saySound(ctx.state, 'DSRLAUNC', ctx.entity); },
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
    const angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x);
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
    enemyShot(state, entity, 20, 8, 0);
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
  A_Explode(ctx) {
    const { state, entity } = ctx;
    const radius = numArg(ctx, 0, 128), damage = numArg(ctx, 1, 128);
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) < radius) damagePlayer(state, Math.max(0, Math.round(damage * (1 - Math.hypot(state.player.x - entity.x, state.player.y - entity.y) / radius))));
    for (const other of state.entities) {
      if (other === entity || other.type !== 'enemy' || other.health <= 0) continue;
      const distance = Math.hypot(other.x - entity.x, other.y - entity.y);
      if (distance < radius) other.health = Math.max(0, other.health - Math.round(damage * (1 - distance / radius)));
    }
    saySound(state, 'DSBAREXP', entity);
  },
  A_RadiusDamage(ctx) {
    const { state, entity } = ctx;
    const radius = numArg(ctx, 0, 128), damage = numArg(ctx, 1, 0);
    if (Math.hypot(state.player.x - entity.x, state.player.y - entity.y) < radius) damagePlayer(state, damage);
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
  A_SpawnItemEx(ctx) {
    const { state, entity } = ctx;
    const index = projectilesByName(ctx.project);
    const target = index.byName.get(String(arg(ctx, 0) || '').toLowerCase());
    if (!target) return;
    spawnProjectileEntity(ctx.project, state, entity, target);
  },
  A_SpawnItem(ctx) {
    ACTIONS.A_SpawnItemEx(ctx);
  },
  A_CustomBulletAttack(ctx) {
    const { state, entity } = ctx;
    if (!canSeePlayer(state, entity, 2048)) return;
    const pellets = Math.max(1, Math.min(20, numArg(ctx, 2, 1))), damage = numArg(ctx, 3, 3), spread = numArg(ctx, 0, 0) / 2;
    for (let pellet = 0; pellet < pellets; pellet++) enemyShot(state, entity, damage, 3, spread);
  },
  A_CustomPunch(ctx) {
    const { state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    enemyShot(state, entity, numArg(ctx, 0, 2), 10, 0);
  },
  A_CustomMeleeAttack(ctx) {
    const { state, entity } = ctx;
    if (!meleeable(state, entity)) return;
    enemyShot(state, entity, numArg(ctx, 0, 2), 8, 0);
    saySound(state, String(arg(ctx, 1) || ''), entity);
  },
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
    id: `spawned_${++state.spawnSequence}`, type: 'enemy', name: actor.name, actorId: actor.id, actorName: actor.name,
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
  const index = project.__actorIndex ||= actorIndex(project.actors);
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
  const index = project.__actorIndex ||= actorIndex(project.actors || []);
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
  if (frame.duration < 0) return;
  runtime.tics++;
  if (runtime.tics < frame.duration) return;
  runtime.tics = 0;
  runtime.entered = false;
  runtime.index++;
}

/** Weapon action handling, with Doom's refire/flash semantics. */
function runWeaponAction(ctx, action) {
  const { state, actor, runtime } = ctx;
  const args = action.args || [];
  const number = (index, fallback = 0) => Number(args[index] ?? fallback) || fallback;
  switch (action.name) {
    case 'A_WeaponReady':
      runtime.ready = true;
      state.weaponReady = true;
      return;
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
    case 'A_FireMissile':
    case 'A_FirePlasma':
    case 'A_FireBFG':
    case 'A_FireCGun':
    case 'A_FireShotgun':
    case 'A_FireShotgun2':
    case 'A_Punch':
    case 'A_Saw':
    case 'A_FirePistol':
      fireWeapon(state, actor, action.name, number);
      return;
    case 'A_PlaySound':
    case 'A_StartSound':
      saySound(state, String(args[0] || ''), null, 110);
      return;
    default:
      // Animation-only weapon actions (bobbing, offsets) need no simulation.
      return;
  }
}

function teleportWeapon(runtime, actor, label) {
  const target = labelIndex(actor, label);
  if (target === null) return;
  runtime.index = target; runtime.tics = 0; runtime.entered = false;
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
function fireWeapon(state, actor, actionName, number) {
  const { type, use } = weaponAmmo(actor);
  if (type) {
    const cost = use || 1;
    if ((state.playerStats[type] || 0) < cost) { state.weaponTriggerHeld = false; return; }
    state.playerStats[type] -= cost;
  }
  switch (actionName) {
    case 'A_FireBullets': {
      const spread = number(0, 0), pellets = Math.max(1, Math.min(40, number(2, 1)));
      const damage = Math.max(1, number(3, 5)), range = number(9, 2048) || 2048;
      state.weaponAttack = { kind: 'hitscan', damage: [damage, Math.max(1, number(1, 3))], pellets, spread, range };
      break;
    }
    case 'A_FireShotgun': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 7, spread: 11.25, range: 2048 }; break;
    case 'A_FireShotgun2': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 20, spread: 22.5, range: 2048 }; break;
    case 'A_FireCGun': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 5.625, range: 2048 }; break;
    case 'A_FirePistol': state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 }; break;
    case 'A_Punch': state.weaponAttack = { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64 }; break;
    case 'A_Saw': state.weaponAttack = { kind: 'hitscan', damage: [2, 10], pellets: 1, spread: 0, range: 64 }; break;
    case 'A_FireMissile': state.weaponAttack = { kind: 'missile', missile: 'Rocket', damage: 20, diceSides: 8, speed: 700, radius: 128 }; break;
    case 'A_FirePlasma': state.weaponAttack = { kind: 'missile', missile: 'PlasmaBall', damage: 5, diceSides: 8, speed: 875, radius: 0 }; break;
    case 'A_FireBFG': state.weaponAttack = { kind: 'missile', missile: 'BFGBall', damage: 100, diceSides: 8, speed: 875, radius: 256 }; break;
    case 'A_FireCustomMissile': state.weaponAttack = { kind: 'missile', missile: 'PlayerMissile', damage: 20, diceSides: 8, speed: 700, radius: 64 }; break;
    default: state.weaponAttack = { kind: 'hitscan', damage: [5, 3], pellets: 1, spread: 0, range: 2048 };
  }
}
