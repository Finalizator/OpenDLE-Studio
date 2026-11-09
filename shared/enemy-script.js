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
 * The tics between two `A_Chase` calls in the actor's own See state.
 *
 * This is the number that makes or breaks a chase speed. `A_Chase` moves the monster `Speed`
 * map units — but it runs once per **state frame**, not once per tic. Every classic monster's
 * See state is four frames of four tics (`POSS AABBCCDD 4 A_Chase`), so a Zombieman covers 8
 * units every four tics: 2 units a tic, not 8. GZDoom's own trace in `Docs/gzdoom-parity.md`
 * says the same thing, and the state machine here already behaves that way, because it runs a
 * frame's action when it enters the frame.
 *
 * A rule that moved the monster every tic made it four times too fast. Returns 4 when the
 * states cannot be read, which is the classic value.
 */
export function chaseStepTics(actor) {
  const frames = actor?.states?.frames || [];
  const start = labelIndex(actor, 'See');
  if (start === null) return 4;
  let tics = 0, calls = 0;
  for (let index = start; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.kind !== 'frame') {
      if (frame.kind === 'goto' || frame.kind === 'loop') break;
      continue;
    }
    if (frame.duration < 0) break;
    tics += frame.duration || 1;
    if ((frame.actions || []).some(action => action.name === 'A_Chase')) calls++;
    if (tics > 64) break;
  }
  return calls ? Math.max(1, tics / calls) : 4;
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
    // `A_Chase` moves `speed` map units once per See frame, and a classic See frame lasts four
    // tics — 8 units every four tics, which is 70 a second, not 280. The rule moves the monster
    // every frame, so the speed it is given is that average, and the walk matches GZDoom's.
    speed: Math.round((Number(actor.speed) || 8) * 35 / chaseStepTics(actor)),
    seeStepTics: chaseStepTics(actor),
    radius: Number(actor.radius) || 20,
    // P_CheckMeleeRange: MELEERANGE - 20 + the monster's radius.
    meleeRange: Math.round(64 - 20 + (Number(actor.radius) || 20)),
    // How long the attack animation runs, which is how long the next attack waits.
    attackSeconds: stateSeconds(actor, melee && !missile ? 'Melee' : 'Missile') ?? 0.4,
    seeFov: actor.flags?.LOOKALLAROUND === true ? 360 : 180 };
}

/**
 * Shootable props (barrels and the like), as rules.
 *
 * A barrel has no AI: what it *is* is a Death state that explodes and stops blocking. Those
 * two functions move to rules so the blast a player causes is the same one a rule could
 * write, and `PROP_FUNCTIONS` stops the state from doing it a second time.
 */
export function propScriptRules(project, { sheetId, groupId, id = uniqueId(project) } = {}) {
  const events = [];
  for (const actor of project.actors || []) {
    if (actor?.flags?.MONSTER === true || actor?.flags?.MISSILE === true) continue;
    if (actor?.flags?.SHOOTABLE !== true) continue;
    const functions = deathFunctions(actor);
    if (!functions.includes('A_Explode')) continue;
    const suffix = String(actor.name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const base = { sheetId, groupId, enabled: true, once: false, forEachType: 'enemy',
      propActor: actor.name,
      comment: `Imported from the ${actor.name} actor's Death state. Edit the blast freely; delete the rule to hand it back to the state.` };
    // Once per barrel: the Death state lasts several frames, and a blast every frame would
    // be a bomb. The timer is per instance, so each barrel still explodes once.
    events.push({ id: id(`prop_${suffix}_blast`), name: `${actor.name}: explodes`,
      ...base, condition: { type: 'actorState', entityId: '$self', state: 'Death' },
      conditions: [{ type: 'entityActorName', entityId: '$self', actor: actor.name },
        { type: 'timerReady', timer: `prop_${suffix}_blast` }],
      actions: [{ type: 'startTimer', timer: `prop_${suffix}_blast`, seconds: 3600 },
        { type: 'explodeArea', entityId: '$self', damage: 128, radius: 128 }] });
    if (functions.some(name => name === 'A_NoBlocking' || name === 'A_Noblocking')) {
      events.push({ id: id(`prop_${suffix}_passable`), name: `${actor.name}: stops blocking`,
        ...base, condition: { type: 'actorState', entityId: '$self', state: 'Death' },
        conditions: [{ type: 'entityActorName', entityId: '$self', actor: actor.name }],
        actions: [{ type: 'setEntitySolid', entityId: '$self', solid: 'no' }] });
    }
  }
  return { events, skipped: [] };
}

/** The function names a Death state calls, up to the marker that ends it. */
function deathFunctions(actor) {
  const frames = actor?.states?.frames || [];
  const start = labelIndex(actor, 'Death');
  if (start === null) return [];
  const names = [];
  for (let index = start; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.kind !== 'frame') {
      if (frame.kind === 'goto' || frame.kind === 'loop' || frame.kind === 'stop' || frame.kind === null) break;
      continue;
    }
    for (const action of frame.actions || []) names.push(action.name);
  }
  return names;
}

/** The functions a translated prop's state no longer performs itself. */
export const PROP_FUNCTIONS = new Set(['A_Explode', 'A_NoBlocking', 'A_Noblocking']);

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
    // "be in See" every frame without restarting the animation under it. Walking, looking and
    // attacking all stand down while the actor is in its attack states, in Pain or in a death
    // state — everything Doom plays to completion.
    const attacking = plan.melee && !plan.missile ? ['Melee'] : ['Missile'];
    // The states this AI stands down in: its own attacks (so an attack cannot restart itself)
    // and the states Doom runs to completion. Without `Pain` the chase rule pulled a flinching
    // monster straight back into See on the frame after the hit, before one pain frame ran.
    const notAttacking = ['Melee', 'Missile', 'Pain', 'Death', 'XDeath'].map(state =>
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
    // Attack: the Doom distance roll decides, once a tic as Doom rolls it — not once a frame,
    // which on a fast machine made every monster attack more often than the game it came from.
    // `notAttacking` is what keeps an attack from restarting itself: re-entering `Missile`
    // every time the timer is ready held the monster in its firing pose for good, so it never
    // took a step again.
    events.push({ id: id(`enemy_${suffix}_attack`), name: `${plan.name}: attacks`,
      ...base, condition: { type: 'enemyAlert', entityId: '$self' },
      // `missile` and `melee` tell the rule what the actor's own states said, so the decision
      // does not have to guess from the thing number: a monster with no missile state never
      // rolls for one, and a monster that cannot melee does not get the closer-fire bonus.
      conditions: [...living(plan), ...notAttacking, { type: 'oncePerTic' },
        { type: 'enemyAttackChance', entityId: '$self', missile: Boolean(plan.missile), melee: Boolean(plan.melee) },
        { type: 'timerReady', timer }],
      actions: [{ type: 'facePlayer', entityId: '$self' },
        { type: 'playActorState', entityId: '$self', state: attacking[0] },
        { type: 'startTimer', timer, seconds: plan.attackSeconds }] });
    // A melee-only monster closes the last few units itself, so it can reach a player
    // who stands right against it without waiting for the walk to end.
    if (plan.melee) {
      events.push({ id: id(`enemy_${suffix}_melee`), name: `${plan.name}: melee when close`,
        ...base, condition: { type: 'enemyAlert', entityId: '$self' },
        conditions: [...living(plan), ...notAttacking, { type: 'oncePerTic' },
          { type: 'enemySeesPlayer', entityId: '$self', range: plan.meleeRange, fov: 360 },
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

/** The props whose Death effects are rules; their states stop performing them. */
export function propEventActors(project) {
  const names = new Set();
  for (const event of project.events || []) {
    if (!event.enabled || !event.propActor) continue;
    names.add(String(event.propActor).toLowerCase());
  }
  return [...names].sort();
}
