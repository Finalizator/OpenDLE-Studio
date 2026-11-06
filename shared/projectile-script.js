import { labelIndex } from './actor-runtime.js';

/** The missile state functions a translated missile no longer runs itself. */
export const PROJECTILE_ACTIONS = new Set(['A_Tracer', 'A_Tracer2', 'A_Explode', 'A_BFGSpray']);

const frameActions = (actor, label) => {
  const frames = actor?.states?.frames || [];
  const start = labelIndex(actor, label);
  if (start === null) return [];
  const actions = [];
  for (let index = start; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.kind !== 'frame') { if (frame.kind === 'goto' || frame.kind === 'loop') break; continue; }
    actions.push(...(frame.actions || []));
  }
  return actions;
};
const numArg = (action, index, fallback) => {
  const value = Number(action.args?.[index]);
  return Number.isFinite(value) ? value : fallback;
};

/** What a missile's rules would say: how it flies and what it does when it dies. */
export function analyseProjectile(project, actor) {
  const name = actor?.name || '';
  const spawn = frameActions(actor, 'Spawn');
  const death = frameActions(actor, 'Death');
  const tracer = spawn.find(action => action.name === 'A_Tracer' || action.name === 'A_Tracer2');
  const blast = death.find(action => action.name === 'A_Explode');
  const spray = death.find(action => action.name === 'A_BFGSpray');
  if (!tracer && !blast && !spray) return { expressible: false, reasons: [`${name} has no flight or death function to translate`] };
  return { expressible: true, name,
    homing: tracer ? { turn: tracer.name === 'A_Tracer' ? 16.875 : numArg(tracer, 0, 19.6875) } : null,
    blast: blast ? { damage: numArg(blast, 0, 128), radius: numArg(blast, 1, 128) } : null,
    spray: spray ? { type: String(spray.args?.[0] ?? 'BFGExtra').replace(/^"|"$/g, ''),
      rays: numArg(spray, 1, 40), rolls: numArg(spray, 2, 15), spread: numArg(spray, 3, 90),
      range: numArg(spray, 4, 0), damage: numArg(spray, 6, 0) } : null };
}

/** The rules that fly and detonate every missile, for the sheet's Projectiles group. */
export function projectileScriptRules(project, { sheetId, groupId, id = uniqueId(project) } = {}) {
  const events = [], skipped = [];
  for (const actor of project.actors || []) {
    const missile = actor?.flags?.MISSILE === true || actor?.flags?.PROJECTILE === true;
    if (!missile) continue;
    const plan = analyseProjectile(project, actor);
    if (!plan.expressible) { skipped.push({ name: actor.name, reasons: plan.reasons }); continue; }
    const suffix = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const base = { sheetId, groupId, enabled: true, once: false, forEachType: 'projectile',
      projectileActor: plan.name,
      comment: `Imported from the ${plan.name} actor's DECORATE states. Edit freely; delete a rule to hand that part back to the states.` };
    const about = { type: 'entityActorName', entityId: '$self', actor: plan.name };
    if (plan.homing) {
      events.push({ id: id(`missile_${suffix}_flies`), name: `${plan.name}: homing flight`, ...base,
        condition: { type: 'projectileState', entityId: '$self', state: 'Spawn' }, conditions: [about],
        actions: [{ type: 'homeMissile', entityId: '$self', turn: plan.homing.turn }] });
    }
    if (plan.blast) {
      events.push({ id: id(`missile_${suffix}_blast`), name: `${plan.name}: explodes`, ...base,
        condition: { type: 'projectileState', entityId: '$self', state: 'Death' }, conditions: [about],
        actions: [{ type: 'explodeArea', entityId: '$self', damage: plan.blast.damage, radius: plan.blast.radius }] });
    }
    if (plan.spray) {
      events.push({ id: id(`missile_${suffix}_spray`), name: `${plan.name}: sprays`, ...base,
        condition: { type: 'projectileState', entityId: '$self', state: 'Death' }, conditions: [about],
        actions: [{ type: 'bfgSpray', entityId: '$self', spray: plan.spray.type, rays: plan.spray.rays,
          rolls: plan.spray.rolls, spread: plan.spray.spread, range: plan.spray.range, damage: plan.spray.damage }] });
    }
  }
  return { events, skipped };
}

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

/** The missiles whose flight and death are rules; their machine stops calling those functions. */
export function projectileEventActors(project) {
  const names = new Set();
  for (const event of project.events || []) {
    if (!event.enabled || !event.projectileActor) continue;
    names.add(String(event.projectileActor).toLowerCase());
  }
  return [...names].sort();
}
