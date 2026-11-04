/**
 * What in the project still names an object.
 *
 * Deleting an object used to be a one-line filter over `map.entities`, and everything that
 * pointed at it was left pointing at nothing: a spawn template, a path cue, a cue's own target and
 * a scene node's rule all survived the object and turned the project invalid — or, worse, stayed
 * "valid" and quietly stopped working. The guard that did exist only looked at `action.entityId`
 * on layout events, so three of the four kinds of reference were not even noticed.
 *
 * One module answers two questions for every kind of reference, so the guard and the dialog that
 * replaces it cannot drift apart:
 *
 * - *where is this object named* (`entityReferences`), and
 * - *take those names away* (`stripEntityReferences`), or *point them at something else*
 *   (`rewriteEntityReferences`).
 *
 * A reference is any command — a condition or an action — that names an object in `entityId`,
 * `otherId`, `templateId` or `zoneId`, plus the owner fields: an event's `ownerId` and a timeline cue's
 * `ownerId`. `$self`, `$player`, `$world` and `$all` are not objects and are left alone.
 */

/** The fields a command can name an object in. */
export const REFERENCE_FIELDS = Object.freeze(['entityId', 'otherId', 'templateId', 'zoneId']);

const isObjectId = value => typeof value === 'string' && value.length > 0 && !value.startsWith('$');

/** Every object a command names, with the field each name came from. */
export function commandTargets(command) {
  const found = [];
  for (const field of REFERENCE_FIELDS) if (isObjectId(command?.[field])) found.push({ field, id: command[field] });
  return found;
}

/** The commands of one event: its conditions first, then its actions. */
function eventCommands(event) {
  return [event?.condition, ...(event?.conditions || []), ...(event?.actions || [])].filter(Boolean);
}

/** Whether one event names any of `ids`, as an owner or inside a command. */
export function eventNamesAny(event, ids) {
  if (event?.ownerId && ids.has(event.ownerId)) return true;
  return eventCommands(event).some(condition => commandTargets(condition).some(target => ids.has(target.id)));
}

/**
 * Every place these objects are named.
 *
 * `scene` reads the events of that scene object instead of the layout's, because a scene keeps its
 * own rule list and its node ids are not layout ids. Each entry says where it lives so a dialog can
 * offer to open it: `sheetId` for an event's sheet, `timesheetId`/`cueId` for a cue.
 */
export function entityReferences(project, ids, { scene = null } = {}) {
  const wanted = ids instanceof Set ? ids : new Set([].concat(ids));
  const found = [];
  const events = scene ? scene.events || [] : project?.events || [];
  for (const event of events) {
    const owned = Boolean(event.ownerId && wanted.has(event.ownerId));
    const commands = eventCommands(event);
    const named = commands.flatMap(command => commandTargets(command)).filter(target => wanted.has(target.id));
    if (!owned && !named.length) continue;
    found.push({
      source: 'event', id: event.id, name: event.name || event.id,
      sheetId: event.sheetId || null, ownerId: event.ownerId || null,
      owned, fields: [...new Set(named.map(target => target.field))],
      scene: Boolean(scene),
    });
  }
  if (scene) return found;
  for (const sheet of project?.timesheets || []) {
    for (const cue of sheet.cues || []) {
      const owned = Boolean(cue.ownerId && wanted.has(cue.ownerId));
      const named = (cue.actions || []).flatMap(action => commandTargets(action)).filter(target => wanted.has(target.id));
      if (!owned && !named.length) continue;
      found.push({
        source: 'cue', id: cue.id, name: cue.name || cue.id,
        timesheetId: sheet.id, timesheetName: sheet.name || sheet.id,
        cueTime: Number(cue.time) || 0, ownerId: cue.ownerId || null,
        owned, fields: [...new Set(named.map(target => target.field))],
      });
    }
  }
  return found;
}

/** True when anything at all names these objects. */
export function hasEntityReferences(project, ids, options = {}) {
  return entityReferences(project, ids, options).length > 0;
}

/**
 * Removes every name of these objects, in the same pass that deletes them.
 *
 * The rules themselves are what goes: an event owned by the object is its script and is dropped
 * whole, an event someone else owns keeps everything and loses only the commands that named the
 * object. An event or cue left with nothing to do — no conditions, no actions — is dropped too,
 * because an empty rule is not a rule.
 */
export function stripEntityReferences(project, ids, { scene = null } = {}) {
  const wanted = ids instanceof Set ? ids : new Set([].concat(ids));
  const removed = { events: 0, commands: 0, cues: 0, actions: 0 };
  const events = (scene || project).events || [];
  const parents = new Set(events.map(event => event.parentId).filter(Boolean));
  const clean = (list, counter) => list.filter(command => {
    const named = commandTargets(command).some(target => wanted.has(target.id));
    if (named) removed[counter] += 1;
    return !named;
  });
  // Empty leaves go with their last action; parents can still gate surviving sub-events.
  const dropped = new Set();
  const keepEvent = event => {
    if (dropped.has(event.parentId)) {
      dropped.add(event.id); removed.events += 1; return false;
    }
    if (event.ownerId && wanted.has(event.ownerId)) { dropped.add(event.id); removed.events += 1; return false; }
    const conditionsBefore = [event.condition, ...(event.conditions || [])].filter(Boolean);
    const before = (event.actions || []).length + conditionsBefore.length;
    event.actions = clean(event.actions || [], 'commands');
    const keptConditions = clean(conditionsBefore, 'commands');
    event.condition = keptConditions[0] || null;
    event.conditions = keptConditions.slice(1);
    const after = event.actions.length + keptConditions.length;
    // Only a rule this delete gutted is dropped: one that can no longer act, or has lost its
    // trigger. A rule that was already idle is none of this delete's business.
    if (after < before && (!event.actions.length && !parents.has(event.id) || !keptConditions.length)) {
      dropped.add(event.id); removed.events += 1; return false;
    }
    return true;
  };
  if (scene) { scene.events = (scene.events || []).filter(keepEvent); return removed; }
  project.events = (project.events || []).filter(keepEvent);
  for (const sheet of project.timesheets || []) {
    sheet.cues = (sheet.cues || []).filter(cue => {
      if (cue.ownerId && wanted.has(cue.ownerId)) { removed.cues += 1; return false; }
      const before = (cue.actions || []).length;
      cue.actions = clean(cue.actions || [], 'actions');
      // A cue with nothing left to do at its time is noise, but one that never had an action is
      // left as the author made it.
      if (before > 0 && !cue.actions.length) { removed.cues += 1; return false; }
      return true;
    });
  }
  return removed;
}

/**
 * Points every name of these objects at a stand-in instead.
 *
 * This is the "keep the rules" answer to a delete: the object goes away and a blank placeholder
 * takes its place, so a script that was written around it survives and can be re-pointed later
 * rather than disappearing with it. `mapping` is `from → to`.
 */
export function rewriteEntityReferences(project, mapping, { scene = null } = {}) {
  const translate = command => {
    if (!command) return;
    for (const field of REFERENCE_FIELDS) {
      const value = command[field];
      if (typeof value === 'string' && mapping.has(value)) command[field] = mapping.get(value);
    }
  };
  const rewrite = (event, ownersToo) => {
    if (!event) return;
    if (ownersToo && event.ownerId && mapping.has(event.ownerId)) event.ownerId = mapping.get(event.ownerId);
    for (const command of [event.condition, ...(event.conditions || []), ...(event.actions || [])]) translate(command);
  };
  if (scene) { for (const event of scene.events || []) rewrite(event, true); return; }
  for (const event of project?.events || []) rewrite(event, true);
  for (const sheet of project?.timesheets || []) {
    for (const cue of sheet.cues || []) {
      if (cue.ownerId && mapping.has(cue.ownerId)) cue.ownerId = mapping.get(cue.ownerId);
      for (const action of cue.actions || []) translate(action);
    }
  }
}

/**
 * A readable label for a reference, the way a dialog lists it.
 *
 * The sheet is named when the event belongs to one, because "Event sheet 1 · Gate opens" is
 * something the author can find, while an event id alone is not.
 */
export function referenceLabel(reference, { sheetName = null } = {}) {
  if (reference.source === 'cue') {
    const at = Number.isFinite(reference.cueTime) ? ` at ${reference.cueTime.toFixed(2)}s` : '';
    return `${reference.timesheetName || 'Timesheet'} · ${reference.name}${at}`;
  }
  const where = sheetName || (reference.scene ? 'Scene events' : 'Event sheet');
  return `${where} · ${reference.name}`;
}
