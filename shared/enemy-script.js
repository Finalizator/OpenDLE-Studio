/**
 * Imported monsters, written as event rules.
 *
 * The same rule that governs weapons: what a game *decides* belongs in the event
 * sheets. A monster's DECORATE states stay the description of what it looks and sounds
 * like — standing, seeing, pain, dying — while the decisions (notice, chase, when an
 * attack may start) are rules a creator can read, retime and rewrite.
 *
 * Once a monster is translated its state machine stops running the AI actions
 * (`AI_ACTIONS`), so it is never twice as awake, and the state's own attack function
 * still fires with the numbers the mod wrote: `A_TroopAttack` is still the mod's choice
 * between claw and fireball, reached from the rule that starts the `Missile` state.
 */

import { labelIndex } from './actor-runtime.js';

/** How long a monster stays alerted after it has noticed the player, in seconds. */
const ALERT_SECONDS = 8;

/** The tics a state lasts, so a rule can wait out the animation it started. */
export function stateSeconds(actor, label) {
  const frames = actor?.states?.frames || [];
  const start = labelIndex(actor, label);
  if (start === null) return null;
  let tics = 0;
  for (let index = start; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.kind !== 'frame') {
      if (frame.kind === 'goto' || frame.kind === 'loop') break;
      continue;
    }
    if (frame.duration < 0) break;
    tics += frame.duration;
    if (tics > 35) break;
  }
  return tics ? tics / 35 : null;
}

/**
 * What a monster's rules would say, or why they cannot be written.
 *
 * A monster needs a `See` state to wake into and something to attack with: a `Missile`
 * state, a `Melee` state, or both. Anything else — a pure decoration with a monster
 * flag, an actor whose states stop before it can act — keeps its machine.
 */
export function analyseMonster(project, actor) {
  const name = actor?.name || '';
  const see = labelIndex(actor, 'See');
  if (see === null) return { expressible: false, reasons: [`${name} has no See state to wake into`] };
  const missile = labelIndex(actor, 'Missile') !== null;
  const melee = labelIndex(actor, 'Melee') !== null;
  if (!missile && !melee) return { expressible: false, reasons: [`${name} has no Melee or Missile state to attack with`] };
  return { expressible: true, name, missile, melee,
    health: Number(actor.health) || 20,
    // An actor's `speed` is map units a tic; the movement action takes units a second.
    speed: Math.round((Number(actor.speed) || 8) * 35),
    radius: Number(actor.radius) || 20,
    // P_CheckMeleeRange: MELEERANGE - 20 + the monster's radius.
    meleeRange: Math.round(64 - 20 + (Number(actor.radius) || 20)),
    // How long the attack animation runs, which is how long the next attack waits.
    attackSeconds: stateSeconds(actor, melee && !missile ? 'Melee' : 'Missile') ?? 0.4,
    seeFov: actor.flags?.LOOKALLAROUND === true ? 360 : 180 };
}

/** The conditions every one of a monster's rules carries: it is alive and it is itself. */
function living(plan) {
  return [{ type: 'entityHealth', entityId: '$self', operator: '>', value: 0 },
    { type: 'playerStat', stat: 'health', operator: '>', value: 0 },
    { type: 'entityActorName', entityId: '$self', actor: plan.name }];
}

/**
 * The rules that run one monster archetype: notice, chase, and the attack it may start.
 *
 * The shape is the one the engine's own starter sheets use, so a creator who has read a
 * starter sheet reads this one: see the player, stay alert, walk, then attack when the
 * distance roll allows and the last attack has finished.
 */
export function enemyScriptRules(project, { sheetId, groupId, id = uniqueId(project) } = {}) {
  const events = [], skipped = [];
  for (const actor of project.actors || []) {
    if (actor?.flags?.MONSTER !== true && actor?.flags?.COUNTKILL !== true) continue;
    // `PainElemental` and friends carry COUNTKILL; a bare monster flag is enough too.
    if (actor.flags?.MISSILE === true) continue;
    const plan = analyseMonster(project, actor);
    if (!plan.expressible) { skipped.push({ name: actor.name, reasons: plan.reasons }); continue; }
    const suffix = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const timer = `enemy_${suffix}_attack`;
    const base = { sheetId, groupId, enabled: true, once: false, forEachType: 'enemy',
      enemyActor: plan.name, comment: `Imported from the ${plan.name} actor's DECORATE states. `
        + 'This decides when it notices, walks and attacks; the states still animate it and fire the attack.' };
    // `playActorState` only enters a state the actor is not already in, so a rule may say
    // "be in See" every frame without restarting the animation under it. Walking and
    // looking aside while an attack state plays would cut the attack short, so those two
    // rules stand down until the states are back in See.
    const attacking = plan.melee && !plan.missile ? ['Melee'] : ['Missile'];
    const notAttacking = ['Melee', 'Missile'].map(state =>
      ({ type: 'actorState', entityId: '$self', state, inverted: true }));
    // Notice: the player in sight wakes it into See, where its own look sound plays.
    events.push({ id: id(`enemy_${suffix}_notice`), name: `${plan.name}: notices the player`,
      ...base, condition: { type: 'enemySeesPlayer', entityId: '$self', range: 2048, fov: plan.seeFov },
      conditions: [...living(plan), ...notAttacking],
      actions: [{ type: 'playActorState', entityId: '$self', state: 'See' },
        { type: 'startTimer', timer: 'alert', seconds: ALERT_SECONDS }] });
    // Chase: walk toward the player for as long as it remembers him.
    events.push({ id: id(`enemy_${suffix}_chase`), name: `${plan.name}: chases`,
      ...base, condition: { type: 'enemyAlert', entityId: '$self' },
      conditions: [...living(plan), ...notAttacking],
      actions: [{ type: 'moveEnemy', entityId: '$self', speed: plan.speed },
        { type: 'playActorState', entityId: '$self', state: 'See' }] });
    // Attack: the Doom distance roll decides, and the last attack has to finish first.
    events.push({ id: id(`enemy_${suffix}_attack`), name: `${plan.name}: attacks`,
      ...base, condition: { type: 'enemyAlert', entityId: '$self' },
      conditions: [...living(plan), { type: 'enemyAttackChance', entityId: '$self' },
        { type: 'timerReady', timer }],
      actions: [{ type: 'facePlayer', entityId: '$self' },
        { type: 'playActorState', entityId: '$self', state: attacking[0] },
        { type: 'startTimer', timer, seconds: plan.attackSeconds }] });
    // A melee-only monster closes the last few units itself, so it can reach a player
    // who stands right against it without waiting for the walk to end.
    if (plan.melee) {
      events.push({ id: id(`enemy_${suffix}_melee`), name: `${plan.name}: melee when close`,
        ...base, condition: { type: 'enemyAlert', entityId: '$self' },
        conditions: [...living(plan), { type: 'enemySeesPlayer', entityId: '$self', range: plan.meleeRange, fov: 360 },
          { type: 'timerReady', timer }],
        actions: [{ type: 'facePlayer', entityId: '$self' }, { type: 'playActorState', entityId: '$self', state: 'Melee' },
          { type: 'startTimer', timer, seconds: plan.attackSeconds }] });
    }
  }
  return { events, skipped };
}

/** Ids that do not collide with the project's own. */
function uniqueId(project) {
  const used = new Set([...(project.events || []).map(event => event.id),
    ...(project.eventSheets || []).map(sheet => sheet.id), ...(project.eventGroups || []).map(group => group.id)]);
  return name => {
    let id = `engine_${name}`, suffix = 1;
    while (used.has(id)) id = `engine_${name}_${suffix++}`;
    used.add(id);
    return id;
  };
}

/** The monsters whose decisions are enabled rules; their machine stops deciding. */
export function enemyEventActors(project) {
  const names = new Set();
  for (const event of project.events || []) {
    if (!event.enabled || !event.enemyActor) continue;
    names.add(String(event.enemyActor).toLowerCase());
  }
  return [...names].sort();
}
