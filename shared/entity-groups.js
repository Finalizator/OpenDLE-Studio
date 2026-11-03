// Grouping objects in the layout.
//
// A group is a named set of objects the mapper thinks of as one thing — a door frame and its
// two leaves, a cluster of crates — so they can be selected, copied and ungrouped together. It is
// deliberately shallow: one level, no nesting. A group is a label on its members, and the members
// stay ordinary objects that the renderer, the physics world and the event sheet know nothing
// about, which is what keeps grouping from changing what the game does.
import { newId } from './project.js';
import { remapReferences } from './scenes.js';
import { remapJoint } from './joints.js';

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

export function sceneInstanceOf(project, id) {
  const group = groupOf(project, project.map.entities.find(entity => entity.id === id));
  return group?.kind === 'scene' ? group : null;
}

/** Layout selection never exposes just one part of a scene instance. */
export function layoutEntityIds(project, ids) {
  const wanted = new Set(ids || []);
  const groups = new Set([...wanted].map(id => sceneInstanceOf(project, id)?.id).filter(Boolean));
  return project.map.entities.filter(entity => wanted.has(entity.id) || groups.has(entity.groupId)).map(entity => entity.id);
}

export function layoutSelection(project, selection) {
  if (selection?.kind !== 'entity') return selection;
  const instance = sceneInstanceOf(project, selection.id);
  const id = instance?.rootId || selection.id;
  const group = layoutEntityIds(project, [id, ...(selection.group || [])]);
  return { ...selection, id, ...(group.length > 1 ? { group } : {}) };
}

export function createSceneInstanceGroup(project, ids, { name, rootId = ids[0], sceneId, id } = {}) {
  const members = new Set(ids);
  if (!members.size || !members.has(rootId) || [...members].some(id => !project.map.entities.some(entity => entity.id === id))) {
    throw new Error('A scene instance requires its root and all of its objects');
  }
  const group = { id: id || newId('group'), name: uniqueGroupName(project, name || 'Scene'),
    kind: 'scene', rootId, ...(sceneId ? { sceneId } : {}) };
  project.map.entityGroups ||= [];
  project.map.entityGroups.push(group);
  for (const entity of project.map.entities) if (members.has(entity.id)) entity.groupId = group.id;
  pruneGroups(project);
  return group;
}

/** Older node imports kept parent links; older scene placements kept a unique instance prefix. */
export function upgradeSceneInstances(project) {
  let count = 0;
  const layouts = [project, ...(project.game?.levels || []).map(level => level.data)];
  const seenMaps = new Set();
  for (const layout of layouts) {
    const map = layout?.map;
    if (!map || seenMaps.has(map) || map.sceneInstancesVersion === 1) continue;
    seenMaps.add(map);
    const target = { map };
    const entities = new Map((map.entities || []).map(entity => [entity.id, entity]));
    const trees = new Map();
    for (const entity of entities.values()) {
      if (entity.groupId || !entity.parentId) continue;
      let root = entity, seen = new Set([root.id]);
      while (entities.has(root.parentId) && !seen.has(root.parentId)) {
        root = entities.get(root.parentId); seen.add(root.id);
      }
      if (root.parentId || root.groupId) continue;
      if (!trees.has(root.id)) trees.set(root.id, new Set([root.id]));
      trees.get(root.id).add(entity.id);
    }
    for (const [rootId, ids] of trees) {
      createSceneInstanceGroup(target, [...ids], { rootId, name: entities.get(rootId).name });
      count++;
    }
    const prefixes = new Set([...entities.keys()].map(id => /^(instance_[a-f0-9]{16})_/.exec(id)?.[1]).filter(Boolean));
    for (const prefix of prefixes) {
      const members = [...entities.values()].filter(entity => entity.id.startsWith(`${prefix}_`));
      if (members.some(entity => entity.groupId)) continue;
      const source = (layout.scenes || []).find(scene => scene.entities.length === members.length
        && scene.entities.every(entity => entities.has(`${prefix}_${entity.id}`)));
      if (!source) continue;
      createSceneInstanceGroup(target, members.map(entity => entity.id), {
        name: source.name, rootId: `${prefix}_${source.entities[0].id}`, sceneId: source.id,
      });
      count++;
    }
    map.sceneInstancesVersion = 1;
  }
  return count;
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
    const suffix = ` ${index}`;
    const candidate = `${trimmed.slice(0, GROUP_NAME_LIMIT - suffix.length)}${suffix}`;
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
  if ([...wanted].some(id => sceneInstanceOf(project, id))) throw new Error('Ungroup the scene instance explicitly before regrouping its parts');
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
  if (groupById(project, groupId)?.kind === 'scene') project.map.sceneInstancesVersion = 1;
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
  if (groupById(project, groupId)?.kind === 'scene') throw new Error('Ungroup the scene instance explicitly to edit its parts');
  delete entity.groupId;
  pruneGroups(project);
  return groupId;
}

/**
 * Drop groups that no longer hold enough to be a group, and forget references that point nowhere.
 *
 * Ordinary groups need two objects; a scene instance can intentionally contain just one node.
 */
export function pruneGroups(project) {
  const counts = new Map();
  for (const entity of project.map?.entities || []) {
    if (entity.groupId) counts.set(entity.groupId, (counts.get(entity.groupId) || 0) + 1);
  }
  const survivors = new Set(entityGroups(project).filter(group => (counts.get(group.id) || 0) >= (group.kind === 'scene' ? 1 : 2)).map(group => group.id));
  project.map.entityGroups = entityGroups(project).filter(group => survivors.has(group.id));
  for (const group of project.map.entityGroups) {
    if (group.kind === 'scene' && !project.map.entities.some(entity => entity.id === group.rootId && entity.groupId === group.id)) {
      group.rootId = project.map.entities.find(entity => entity.groupId === group.id).id;
    }
  }
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
export function cloneEntitiesForPaste(project, entities, point, {
  groups = entityGroups(project), events = project.events || [], joints = project.map.joints || [],
} = {}) {
  const source = (entities || []).filter(Boolean);
  if (!source.length) throw new Error('There is nothing to paste');
  if (source.some(entity => entity.type === 'player')) throw new Error('The player start cannot be copied; a level has one');
  const sourceIds = new Set(source.map(entity => entity.id));
  for (const original of groups.filter(group => group.kind === 'scene' && source.some(entity => entity.groupId === group.id))) {
    if (!sourceIds.has(original.rootId) || membersOf(project, original.id).some(entity => !sourceIds.has(entity.id))) {
      throw new Error('Copy the whole scene instance, not an individual part');
    }
  }
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
  const mapping = new Map(source.map((entity, index) => [entity.id, copies[index].id]));
  for (const copy of copies) {
    if (copy.parentId && mapping.has(copy.parentId)) copy.parentId = mapping.get(copy.parentId);
    else delete copy.parentId;
  }
  // A copied group is a new group, never the same one: editing the copy must not edit the original.
  // Only a set of two or more objects that all belong to the same group is a copied group; one
  // object copied out of a group is just an object.
  const sourceGroup = source.length > 1 && anchor.groupId && source.every(entity => entity.groupId === anchor.groupId)
    ? groups.find(group => group.id === anchor.groupId) : null;
  let group = null;
  if (sourceGroup) {
    project.map.entityGroups ||= [];
    group = { ...sourceGroup, id: newId('group'), name: uniqueGroupName(project, `${sourceGroup.name} copy`) };
    if (sourceGroup.kind === 'scene') group.rootId = mapping.get(sourceGroup.rootId);
    project.map.entityGroups.push(group);
    for (const copy of copies) copy.groupId = group.id;
  } else {
    for (const copy of copies) delete copy.groupId;
  }
  // Mixed selections retain each complete scene instance, not a bag of loose parts.
  const instanceIds = new Set();
  for (const original of groups.filter(group => group.kind === 'scene')) {
    const members = source.filter(entity => entity.groupId === original.id);
    if (!members.length) continue;
    if (!mapping.has(original.rootId)) throw new Error('Copy the whole scene instance, not an individual part');
    let copied = group?.id && original.id === sourceGroup?.id ? group : null;
    if (!copied) {
      copied = { ...original, id: newId('group'), name: uniqueGroupName(project, `${original.name} copy`),
        rootId: mapping.get(original.rootId) };
      (project.map.entityGroups ||= []).push(copied);
      for (const member of members) copies[source.indexOf(member)].groupId = copied.id;
    }
    for (const member of members) instanceIds.add(member.id);
  }
  const copiedEvents = events.filter(event => instanceIds.has(event.ownerId));
  const eventMapping = new Map(copiedEvents.map(event => [event.id, newId('event')]));
  const copiedJoints = joints.filter(joint => instanceIds.has(joint.a) && instanceIds.has(joint.b));
  return { entities: copies, group,
    events: copiedEvents.map(event => remapReferences(event, new Map([...mapping, ...eventMapping]))),
    joints: copiedJoints.map(joint => {
      const copy = remapJoint(joint, mapping, { id: newId('joint') });
      if (copy.anchor) { copy.anchor.x += dx; copy.anchor.y += dy; }
      return copy;
    }) };
}
