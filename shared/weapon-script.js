/**
 * Imported weapons, written as event rules.
 *
 * The engine's rule is that a project's gameplay is readable and editable in its
 * event sheets. A WAD's weapons arrive as DECORATE states, and those used to run
 * inside the actor machine, out of sight of the sheet — the Weapons sheet was empty
 * and a rule written by hand fired a second shot on top of the machine.
 *
 * This module reads a weapon actor's own states and writes the rule that fires it, in
 * the numbers the mod wrote: the ammo the shot costs, the damage, dice, pellets and
 * spread, the projectile class, the sound, and the cadence the frame durations add up
 * to. Everything a rule needs already exists as an action, so what a player sees in the
 * sheet is what the weapon does; editing the rule changes the weapon, and deleting it
 * gives the weapon back to the state machine unchanged.
 */

import { FIRE_SOUNDS, WEAPON_ACTOR_BY_SLOT, labelIndex, weaponAmmo, weaponAttackFor } from './actor-runtime.js';

/** Actions whose presence in a state means the weapon fired there. */
export const SHOT_ACTIONS = new Set([...Object.keys(FIRE_SOUNDS), 'A_FireBullets',
  'A_FireCustomMissile', 'A_FireProjectile']);

/** The slot a weapon actor stands in, or null when the project's own weapon has no slot. */
export function weaponSlotOf(actor) {
  const name = String(actor?.name ?? '').toLowerCase();
  for (const [slot, names] of Object.entries(WEAPON_ACTOR_BY_SLOT)) {
    if (names.some(candidate => candidate.toLowerCase() === name)) return slot;
  }
  return null;
}

/**
 * One pass round a state, in tics, with the shots it fires on the way.
 *
 * Mirrors `weaponTic`: a frame occupies `duration` tics and its actions run on the
 * first of them; `A_ReFire` spends its own tic and re-enters the state it fired from.
 * Returns null for a state the walk cannot follow — a `stop`, a `-1` duration, a jump
 * that leaves the cycle — because a rule cannot promise what such a state does.
 */
export function weaponCycle(actor, label = 'Fire') {
  const frames = actor?.states?.frames || [];
  const start = labelIndex(actor, label);
  if (start === null) return null;
  const shots = [];
  let index = start, entered = false, frameTics = 0, tics = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const frame = frames[index];
    if (!frame) return null;
    if (frame.kind !== 'frame') {
      if (frame.kind === 'stop' || frame.kind === null) return null;
      const target = labelIndex(actor, frame.kind === 'loop' ? frame.label : frame.target);
      if (target === null) return null;
      index = target; entered = false; frameTics = 0;
      if (index === start && tics > 0) return { tics, shots };
      continue;
    }
    if (!entered) {
      entered = true;
      const actions = frame.actions || [];
      if (actions.some(action => action.name === 'A_ReFire')) {
        // The refire tic ends one pass round the state.
        return { tics: tics + 1, shots };
      }
      for (const action of actions) if (SHOT_ACTIONS.has(action.name)) shots.push(action);
    }
    if (frame.duration < 0) return null;
    tics += 1; frameTics += 1;
    if (frameTics < frame.duration) continue;
    frameTics = 0; entered = false; index += 1;
    if (index === start) return { tics, shots };
  }
  return null;
}

/**
 * What a weapon's rules would say, or the reason they cannot be written.
 *
 * `expressible: false` is not a failure of the weapon: it means the state does
 * something a rule cannot promise — several different shots in one pass, a class the
 * project does not contain, a state the walk cannot follow — so the actor machine
 * keeps it and the sheet says so.
 */
export function analyseWeapon(project, actor) {
  const name = actor?.name || '';
  const slot = weaponSlotOf(actor);
  if (!slot) return { expressible: false, reasons: [`${name} has no weapon slot a rule could select`] };
  const plan = shotPlan(project, actor, 'Fire', slot);
  if (!plan.expressible) return plan;
  const alt = labelIndex(actor, 'AltFire') === null ? null : shotPlan(project, actor, 'AltFire', slot);
  return { ...plan, slot, alt: alt?.expressible ? alt : null,
    ...(alt && !alt.expressible ? { altReasons: alt.reasons } : {}) };
}

function shotPlan(project, actor, label, slot) {
  const cycle = weaponCycle(actor, label);
  if (!cycle) return { expressible: false, reasons: [`its ${label} state cannot be followed`] };
  if (!cycle.shots.length) return { expressible: false, reasons: [`its ${label} state never fires`] };
  const shots = cycle.shots.map(action => weaponAttackFor(project, action.name, action.args || [], action.named || {}));
  const missing = shots.find(shot => shot.missing);
  if (missing) return { expressible: false, reasons: [`it fires ${missing.missing}, which this project does not contain`] };
  // One rule fires one shot on one timer, so a pass that alternates between two kinds of
  // shot cannot be written as one. (The chaingun's two identical shots can.)
  const kinds = new Set(shots.map(shot => JSON.stringify(shot.attack)));
  if (kinds.size > 1) return { expressible: false, reasons: [`its ${label} state fires more than one kind of shot`] };
  const ammo = weaponAmmo(actor);
  return { expressible: true, label, slot, ammo: { type: ammo.type, cost: ammo.type ? ammo.use : 0 },
    attack: shots[0].attack, sound: FIRE_SOUNDS[cycle.shots[0].name] || null,
    passTics: cycle.tics, rateTics: cycle.tics / cycle.shots.length, shotsPerPass: cycle.shots.length };
}

/**
 * The actions that fire a weapon, in the order the engine's own table uses.
 *
 * A pass that fires twice — the chaingun, the chainsaw — spends and shoots twice in the
 * rule and waits a whole pass before the next one. The totals are exact (ammo, damage,
 * shots a second); the two shots of a pass land in the same frame instead of four tics
 * apart, which the states' own animation still spaces correctly for the ear.
 */
function fireActions(plan, alt) {
  const actions = [];
  if (plan.ammo.type && plan.ammo.cost) {
    actions.push({ type: 'addAmmo', ammo: plan.ammo.type, amount: -plan.ammo.cost * plan.shotsPerPass });
  }
  // The states still run, for the shot sound and the flash they carry (a shotgun's
  // reload, the BFG's charge) — the sound belongs to the state that fires, so the rule
  // does not repeat it — while firing, spending and leaving Ready become the rule's.
  actions.push({ type: 'weaponAnimation', weapon: plan.slot, state: alt ? 'AltFire' : 'Fire' });
  for (let shot = 0; shot < plan.shotsPerPass; shot++) actions.push(attackAction(plan.attack));
  actions.push({ type: 'startTimer', timer: timerName(plan.slot, alt), seconds: plan.passTics / 35 });
  return actions;
}

function attackAction(attack) {
  if (attack.kind === 'hitscan') {
    return { type: 'hitscan', damage: attack.damage[0], diceSides: attack.damage[1], pellets: attack.pellets,
      spread: attack.spread, range: attack.range, ...(attack.hitSound ? { hitSound: attack.hitSound } : {}) };
  }
  return { type: 'launchProjectile', missile: attack.missile, speed: attack.speed, damage: attack.damage,
    diceSides: attack.diceSides, radius: attack.radius, color: '#66bbff',
    ...(attack.seeker ? { seeker: true } : {}) };
}

const timerName = (slot, alt) => `weapon_${slot}${alt ? '_alt' : ''}`;

/** The conditions that make a weapon rule fire: alive, owned, selected, loaded, not cooling. */
function fireConditions(plan, alt) {
  const slot = plan.slot;
  return [
    { type: 'playerStat', stat: 'health', operator: '>', value: 0 },
    { type: 'weaponSelected', weapon: slot },
    { type: 'weaponOwned', weapon: slot },
    ...(plan.ammo.type && plan.ammo.cost
      ? [{ type: 'playerStat', stat: plan.ammo.type, operator: '>=', value: plan.ammo.cost * plan.shotsPerPass }] : []),
    { type: 'timerReady', timer: timerName(slot, alt) },
  ];
}

/**
 * The rules that fire every imported weapon, ready to add to a project's Weapons sheet.
 *
 * `sheetId`/`groupId` are the sheet and group they belong to. A weapon the translation
 * cannot promise is reported in `skipped` and keeps its state machine, so nothing is
 * silently dropped.
 */
export function weaponScriptRules(project, { sheetId, groupId, id = uniqueId(project) } = {}) {
  const events = [], skipped = [];
  for (const actor of project.actors || []) {
    if (actor?.flags?.WEAPON !== true) continue;
    const plan = analyseWeapon(project, actor);
    if (!plan.expressible) { skipped.push({ name: actor.name, reasons: plan.reasons }); continue; }
    const base = { sheetId, groupId, enabled: true, once: false, condition: { type: 'keyHeld', key: 'Mouse0' },
      weaponActor: actor.name,
      comment: `Imported from the ${actor.name} actor's DECORATE states. Edit freely; delete this rule to hand the weapon back to its states.` };
    events.push({ id: id(plan.slot), name: plan.slot, ...base,
      conditions: fireConditions(plan, false), actions: fireActions(plan, false) });
    if (plan.alt) {
      events.push({ id: id(`${plan.slot}_alt`), name: `${plan.slot} alt fire`, ...base,
        condition: { type: 'keyHeld', key: 'Mouse2' },
        conditions: fireConditions(plan.alt, true), actions: fireActions(plan.alt, true) });
    } else if (plan.altReasons) {
      skipped.push({ name: `${actor.name} (alt fire)`, reasons: plan.altReasons });
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

/**
 * The weapons whose firing is an enabled rule.
 *
 * The runtime asks this once, when a preview starts: those weapons run their states for
 * pictures and sounds only, so a translated weapon is never fired twice.
 */
export function weaponEventActors(project) {
  const names = new Set();
  for (const event of project.events || []) {
    if (!event.enabled || !event.weaponActor) continue;
    names.add(String(event.weaponActor).toLowerCase());
  }
  return [...names].sort();
}
