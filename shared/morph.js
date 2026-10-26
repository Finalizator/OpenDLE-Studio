/**
 * Morphs: an actor that turns into a different actor for a while.
 *
 * Doom's morph items (the Porkalator, the Heretic chicken) are implemented as a
 * class swap plus a timer. The engine keeps the entity object so ids, physics
 * bodies and event references stay valid, and stores what it replaced so the
 * unmorph restores the original actor, its health and its frames.
 */

import { projectActorIndex, setActorState } from './actor-runtime.js';
import { applyActorSpriteStates } from './sprite-animation.js';

const TIC_RATE = 35;

function findActor(project, name) {
  if (!name) return null;
  const index = projectActorIndex(project);
  return index.byName.get(String(name).toLowerCase()) ||
    index.byId.get(`actor_${String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`) || null;
}

/** The entity a script or action means by `tid`, defaulting to the activator. */
export function morphTarget(state, tid, activator = 'player') {
  if (tid) return state.entities.find(entity => entity.tid === tid) || null;
  if (activator === 'player' || activator === undefined) return state.entities.find(entity => entity.type === 'player') || null;
  return state.entities.find(entity => entity.id === activator) || null;
}

/**
 * Turns an entity into `className`. `duration` counts Doom tics (0 = until unmorphed),
 * matching `A_Morph` and ACS `MorphActor`. Returns true when the morph happened.
 */
export function morphEntity(project, state, entity, className, { duration = 0, style = 0 } = {}) {
  if (!entity) return false;
  const actor = findActor(project, className);
  if (!actor) return false;
  const current = entity.actorId || entity.actorName;
  if (entity.morph) unmorphEntity(project, state, entity, true);
  if (current && String(current).toLowerCase() === (entity.type === 'player' ? String(current).toLowerCase() : actor.id.toLowerCase())) return false;

  if (entity.type === 'player') {
    // Players have no class state machine here, so a player morph changes what the
    // engine models: health and the weapon the class carries.
    state.playerMorph = { name: actor.name, actorId: actor.id,
      until: duration > 0 ? state.time + duration / TIC_RATE : null,
      saved: { health: state.playerStats.health, weapon: state.inventory.selectedWeapon } };
    state.playerStats.health = Math.max(1, actor.health || state.playerStats.health);
    state.feedback.health = state.playerStats.health;
    return true;
  }

  const originalHealth = Math.max(1, entity.maxHealth || entity.health || 1);
  const ratio = Math.max(0, entity.health ?? originalHealth) / originalHealth;
  entity.morph = { actorId: entity.actorId ?? null, actorName: entity.actorName ?? null, health: entity.health,
    maxHealth: entity.maxHealth ?? null, radius: entity.radius ?? null, height: entity.height ?? null,
    spriteStates: entity.spriteStates ? { ...entity.spriteStates } : null, spriteAsset: entity.spriteAsset ?? null,
    ...(duration > 0 ? { until: state.time + duration / TIC_RATE } : {}), style };
  entity.actorId = actor.id;
  entity.actorName = actor.name;
  entity.maxHealth = Math.max(1, actor.health || 1);
  entity.health = Math.max(1, Math.round(entity.maxHealth * ratio));
  entity.radius = actor.radius ?? entity.radius;
  entity.height = actor.height ?? entity.height;
  entity.actorResolved = true;
  entity.actorState = undefined;
  setActorState(project, entity, 'Spawn', { restart: true });
  applyActorSpriteStates(project, entity, actor);
  state.worldRevision = (state.worldRevision || 0) + 1;
  return true;
}

/** Restores whatever a morph replaced. */
export function unmorphEntity(project, state, entity, force = false) {
  if (!entity) return false;
  if (entity.type === 'player') {
    if (!state.playerMorph) return false;
    state.playerStats.health = Math.max(1, state.playerMorph.saved.health);
    state.feedback.health = state.playerStats.health;
    if (state.playerMorph.saved.weapon && state.inventory.weapons.has(state.playerMorph.saved.weapon))
      state.inventory.selectedWeapon = state.playerMorph.saved.weapon;
    state.playerMorph = null;
    return true;
  }
  const saved = entity.morph;
  if (!saved) return false;
  // A dead morph stays dead: Doom only reverts a living actor unless forced.
  if (!force && (entity.health ?? 0) <= 0) return false;
  entity.actorId = saved.actorId;
  entity.actorName = saved.actorName;
  entity.health = saved.health ?? entity.maxHealth;
  entity.maxHealth = saved.maxHealth ?? entity.maxHealth;
  entity.radius = saved.radius ?? entity.radius;
  entity.height = saved.height ?? entity.height;
  if (saved.spriteStates) entity.spriteStates = saved.spriteStates;
  if (saved.spriteAsset) entity.spriteAsset = saved.spriteAsset;
  entity.morph = null;
  entity.actorResolved = true;
  entity.actorState = undefined;
  setActorState(project, entity, entity.health > 0 ? 'Spawn' : 'Death', { restart: true });
  state.worldRevision = (state.worldRevision || 0) + 1;
  return true;
}

/** Expires timed morphs; called once per frame by the runtime. */
export function tickMorphs(project, state) {
  if (state.playerMorph?.until !== null && state.playerMorph?.until !== undefined && state.time >= state.playerMorph.until) {
    unmorphEntity(project, state, state.entities.find(entity => entity.type === 'player'));
  }
  for (const entity of state.entities) {
    if (!entity.morph?.until) continue;
    if (state.time < entity.morph.until) continue;
    unmorphEntity(project, state, entity);
  }
}
