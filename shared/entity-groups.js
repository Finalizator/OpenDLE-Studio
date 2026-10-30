// Grouping objects in the layout.
//
// A group is a named set of objects the mapper thinks of as one thing — a door frame and its
// two leaves, a cluster of crates — so they can be selected, copied and ungrouped together. It is
// deliberately shallow: one level, no nesting. A group is a label on its members, and the members
// stay ordinary objects that the renderer, the physics world and the event sheet know nothing
// about, which is what keeps grouping from changing what the game does.
import { newId } from './project.js';

export const GROUP_NAME_LIMIT = 100;

export function entityGroups(project) {
  return project.map?.entityGroups || [];
}

export function groupById(project, id) {
  return entityGroups(project).find(group => group.id === id) || null;
}

export function membersOf(project, groupId) {
  return (project.map?.entities || []).filter(entity => entity.groupId === groupId);
}

/** The group an object belongs to, or null. */
export function groupOf(project, entity) {
  return entity?.groupId ? groupById(project, entity.groupId) : null;
}

/** Objects that are not in any group, in map order. */
export function ungrouped(project) {
  return (project.map?.entities || []).filter(entity => !entity.groupId || !groupById(project, entity.groupId));
}

function uniqueGroupName(project, base) {
  const names = new Set(entityGroups(project).map(group => group.name));
  const trimmed = (base || 'Group').slice(0, GROUP_NAME_LIMIT);
  if (!names.has(trimmed)) return trimmed;
  for (let index = 2; ; index++) {
    const candidate = `${trimmed} ${index}`.slice(0, GROUP_NAME_LIMIT);
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * Put objects into a new group.
 *
 * At least two objects are needed: grouping one is a rename, and it would put a group header in
 * the object list that opens to a single row. Objects that were in other groups leave them.
 */
export function groupEntities(project, ids, { name, id } = {}) {
  const wanted = new Set(ids || []);
  const members = (project.map?.entities || []).filter(entity => wanted.has(entity.id));
  if (members.length < 2) throw new Error('Select at least two objects to group');
  project.map.entityGroups ||= [];
  const group = { id: id || newId('group'), name: uniqueGroupName(project, name) };
  project.map.entityGroups.push(group);
  for (const entity of members) entity.groupId = group.id;
  // Objects that left their old group can leave it holding too little to be one.
  pruneGroups(project);
  return group;
}

/** Dissolve a group: the objects stay, the label goes. */
export function ungroup(project, groupId) {
  const members = membersOf(project, groupId);
  for (const entity of members) delete entity.groupId;
  project.map.entityGroups = entityGroups(project).filter(group => group.id !== groupId);
  return members.length;
}

/** Take one object out of its group, dissolving the group if too little of it is left. */
export function leaveGroup(project, entityId) {
  const entity = (project.map?.entities || []).find(item => item.id === entityId);
  if (!entity?.groupId) return null;
  const groupId = entity.groupId;
  delete entity.groupId;
  pruneGroups(project);
  return groupId;
}

/**
 * Drop groups that no longer hold enough to be a group, and forget references that point nowhere.
 *
 * A group needs two objects, so a group left with one dissolves and that object is left ungrouped
 * rather than sitting under a header that opens to a single row.
 */
export function pruneGroups(project) {
  const counts = new Map();
  for (const entity of project.map?.entities || []) {
    if (entity.groupId) counts.set(entity.groupId, (counts.get(entity.groupId) || 0) + 1);
  }
  const survivors = new Set(entityGroups(project).filter(group => (counts.get(group.id) || 0) >= 2).map(group => group.id));
  project.map.entityGroups = entityGroups(project).filter(group => survivors.has(group.id));
  for (const entity of project.map?.entities || []) {
    if (entity.groupId && !survivors.has(entity.groupId)) delete entity.groupId;
  }
}

/**
 * A copy of a set of objects, keeping the shape of the set.
 *
 * Copying several objects has to keep them where they were relative to each other, or a copied
 * door frame arrives with its leaves in the wrong place. The first object lands on `point` and
 * every other object follows by the offset it had; if the set was a group, the copy is a group of
 * the same name so it reads the same way in the object list.
 */
export function cloneEntitiesForPaste(project, entities, point) {
  const source = (entities || []).filter(Boolean);
  if (!source.length) throw new Error('There is nothing to paste');
  if (source.some(entity => entity.type === 'player')) throw new Error('The player start cannot be copied; a level has one');
  const anchor = source[0];
  const dx = point && Number.isFinite(point.x) ? point.x - (anchor.x || 0) : 32;
  const dy = point && Number.isFinite(point.y) ? point.y - (anchor.y || 0) : 32;
  const names = new Set((project.map?.entities || []).map(entity => entity.name));
  const copies = source.map(entity => {
    const copy = structuredClone(entity);
    copy.id = newId('entity');
    const base = `${entity.name} copy`;
    copy.name = base;
    for (let index = 2; names.has(copy.name); index++) copy.name = `${base} ${index}`;
    names.add(copy.name);
    copy.x = Math.round(((entity.x || 0) + dx) * 100) / 100;
    copy.y = Math.round(((entity.y || 0) + dy) * 100) / 100;
    return copy;
  });
  // A copied group is a new group, never the same one: editing the copy must not edit the original.
  // Only a set of two or more objects that all belong to the same group is a copied group; one
  // object copied out of a group is just an object.
  const sourceGroup = source.length > 1 && anchor.groupId && source.every(entity => entity.groupId === anchor.groupId)
    ? groupById(project, anchor.groupId) : null;
  let group = null;
  if (sourceGroup) {
    project.map.entityGroups ||= [];
    group = { id: newId('group'), name: uniqueGroupName(project, `${sourceGroup.name} copy`) };
    project.map.entityGroups.push(group);
    for (const copy of copies) copy.groupId = group.id;
  } else {
    for (const copy of copies) delete copy.groupId;
  }
  return { entities: copies, group };
}
