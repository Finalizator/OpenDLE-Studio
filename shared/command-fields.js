/**
 * The fields a command's parameter dialog shows, built from the command itself.
 *
 * This is data, not drawing: which pickers an action needs, what they offer and in what order.
 * It lives in `shared/` because both the event sheet and the timesheet panel open the same dialog,
 * and because the two rules that matter here are worth testing without a browser:
 *
 * - the object and the route come first, since everything below them is described in terms of
 *   them — a waypoint picker cannot list the waypoints of a route that has not been chosen yet;
 * - a field offers the list that actually belongs to it. A waypoint is picked from its route by
 *   name, and a local variable from the object it belongs to, not from the project's globals.
 */

import { engineCommand, imageFieldOptions, INPUT_KEYS } from './engine-script.js';
import { pathPointOptions } from './paths.js';
import { INSTANCE_PICKABLE_TYPES, INSTANCE_PROPERTIES } from './instance-properties.js';

/** The commands whose `variable` field names an object's own variable rather than a global. */
export const OBJECT_VARIABLE_COMMANDS = ['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'];

/**
 * The object types a rule can name: the ones this level holds first, because those are the ones a
 * creator is looking at, then the rest so a rule can be written before the object is placed.
 */
function objectTypeOptions(types) {
  const present = new Map();
  // A type entry is `[id, label, variables]`; the label is what the picker shows. The player is a
  // type a level holds but not one a pick can name, so offering it would make the picker build a
  // rule that validation then refuses.
  for (const entry of types || []) if (INSTANCE_PICKABLE_TYPES.includes(entry[0])) present.set(entry[0], entry[1] ?? entry[0]);
  const ordered = [...present.entries()];
  for (const type of INSTANCE_PICKABLE_TYPES) if (!present.has(type)) ordered.push([type, `${type[0].toUpperCase()}${type.slice(1)}`]);
  return ordered;
}

/** The local variables every instance of a type carries, for a picked-variable field's suggestions. */
function instanceVariableNames(types, type) {
  const entry = (types || []).find(([id]) => id === type);
  return entry?.variables || [];
}

export function commandFields(command, { entities, zones = [], cameras = [], objectTypes = [], playerId, variables, groups, clips, walls, sectors, doorSectors = sectors, elevatorSectors = sectors, spriteClips, images = [], hudElements, hudAnimations, timesheets = [], paths = [], sounds = [], pathPoints = () => null, entityVariableNames = () => [], entitySignalNames = () => [], commands = null }) {
  // `commands` is the project's whole catalogue, engine commands first and addon commands after it,
  // so an addon's fields are drawn by the same code as the engine's.
  const definition = (commands ? commands.find(entry => entry.type === command.type) : null) || engineCommand(command.type);
  if (definition) {
    return [
      // The object and the route come first: everything below them is described in terms of them —
      // a waypoint picker cannot list the waypoints of a route that has not been chosen yet.
      ...(definition.spriteClip ? [{ name: 'clipId', label: 'Sprite clip', options: spriteClips }] : []),
      ...(definition.wall ? [{ name: 'wallId', label: 'Linedef', options: walls }] : []),
      ...(definition.door ? [{ name: 'sectorId', label: 'Door sector', options: doorSectors }] : []),
      ...(definition.elevator ? [{ name: 'sectorId', label: 'Elevator sector', options: elevatorSectors }] : []),
      ...(definition.sector && !definition.door && !definition.elevator ? [{ name: 'sectorId', label: 'Sector', options: sectors }] : []),
      ...(definition.zone ? [{ name: 'zoneId', label: 'Zone', options: zones }] : []),
      ...(definition.target ? [{ name: 'entityId', label: 'Object', options: [...OBJECT_VARIABLE_COMMANDS, 'onSignal', 'emitSignal', 'distanceBetween'].includes(command.type) ? entities : entities.filter(([id]) => id !== playerId) }] : []),
      ...(definition.variable ? [{ name: 'variable', options: variables }] : []),
      ...(definition.group ? [{ name: 'groupId', label: 'Group', options: groups }] : []),
      ...(definition.hudElement ? [{ name: 'elementId', label: 'HUD element', options: hudElements }] : []),
      ...(definition.hudAnimation ? [{ name: 'animationId', label: 'HUD animation', options: hudAnimations }] : []),
      ...(definition.timesheet ? [{ name: 'timesheetId', label: 'Timesheet', options: timesheets }] : []),
      ...(definition.path ? [{ name: 'pathId', label: 'Route', options: paths }] : []),
      ...(definition.sound ? [{ name: 'assetId', label: 'Sound', options: sounds }] : []),
      ...definition.fields.map(field => ({ ...field, value: field.kind === 'value',
        ...(field.name === 'signal' ? { options: entitySignalNames(command.entityId) } : {}),
        numeric: field.kind === 'number' || field.kind === 'waypoint',
        // A waypoint field lists the waypoints of the route this action already points at, by name.
        // The route picker above paints its first option when the draft has none, so the waypoints
        // described here have to be that route's rather than an empty list.
        ...(field.kind === 'waypoint' ? { options: pathPointOptions(pathPoints(command.pathId || paths[0]?.[0]), { allowLast: Boolean(field.allowLast) }) } : {}),
        // An object variable is the object's own, so the list is that object's — not the project's
        // globals, which is what "set local variable" used to offer (and then fail validation on).
        ...(OBJECT_VARIABLE_COMMANDS.includes(command.type) && field.name === 'variable' ? {
          label: 'Local variable',
          suggestions: entityVariableNames(command.entityId),
          hint: entityVariableNames(command.entityId).length ? null : 'This object has no local variables yet — add one in its Properties.',
        } : {}),
        ...(['clipId', 'impactClipId'].includes(field.name) ? { options: [['', 'None / primitive visual'], ...spriteClips] } : {}),
        // A camera target is picked from the cameras this level has, with the two references a
        // cutscene needs first: the player's own eyes and whichever camera is filming.
        ...(field.name === 'camera' ? { options: [['$player', "The player's view"], ['$active', 'The camera in use'], ...cameras] } : {}),
        // Image fields list the asset library, so a spray's artwork is chosen by name.
        ...(field.kind === 'image' ? { options: imageFieldOptions(images) } : {}),
        // An object type is picked from the types this level actually holds, with the ones it does
        // not hold still offered: a creator writes the rule for a type before placing it.
        ...(field.kind === 'objectType' ? { options: objectTypeOptions(objectTypes) } : {}),
        // A property is picked by name and sorted the way a person thinks of them, not by the
        // order the reader happens to declare them in.
        ...(field.kind === 'instanceProperty' ? { options: INSTANCE_PROPERTIES.map(property => [property.name, property.label]) } : {}),
        // A picked-variable field names a variable the chosen type carries, so the suggestions
        // follow the type the rule already picked.
        ...(['setPickedVariable', 'addPickedVariable', 'pickByVariable'].includes(command.type) && field.name === 'variable'
          ? { suggestions: instanceVariableNames(objectTypes, command.objectType), label: 'Local variable' } : {}) })),
    ];
  }
  const fields = [];
  const field = (name, numeric = false, options, optional = false) => fields.push({ name, numeric, options, optional });
  if (command.type === 'keyPressed') field('key', false, INPUT_KEYS);
  if (['nearEntity', 'collisionStarted', 'collisionEnded', 'isTouching', 'animationFinished', 'removeEntity', 'setEntityPosition', 'rotateEntity', 'applyImpulse', 'applyForce', 'setVelocity', 'playAnimation', 'stopAnimation'].includes(command.type)) field('entityId', false,
    command.type === 'removeEntity' ? entities.filter(([id]) => id !== playerId) : entities);
  if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(command.type)) field('otherId', false, [['$world', 'Sector geometry'], ...entities]);
  if (command.type === 'nearEntity') field('distance', true);
  if (command.type === 'showMessage') field('message');
  if (['setVariable', 'addVariable'].includes(command.type)) { field('variable', false, variables); fields.push({ name: 'value', value: true }); }
  if (['teleport', 'setEntityPosition', 'applyImpulse', 'applyForce', 'setVelocity'].includes(command.type)) {
    field('x', true); field('y', true); field('z', true, undefined, ['teleport', 'setEntityPosition'].includes(command.type));
  }
  if (command.type === 'rotateEntity') field('angle', true);
  if (command.type === 'playAnimation') {
    field('clip', false, clips(command.entityId)); field('speed', true); field('loop', false, [['true', 'Yes'], ['false', 'No']]);
  }
  return fields;
}
