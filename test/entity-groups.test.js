import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import {
  cloneEntitiesForPaste, entityGroups, groupById, groupEntities, groupOf, leaveGroup, membersOf, pruneGroups,
  ungroup, ungrouped,
} from '../shared/entity-groups.js';

function withObjects() {
  const project = createProject();
  project.map.entities.push(
    { id: 'frame', name: 'Door frame', type: 'decoration', x: 100, y: 0, angle: 0 },
    { id: 'leaf', name: 'Door leaf', type: 'decoration', x: 132, y: 0, angle: 0 },
    { id: 'crate', name: 'Crate', type: 'decoration', x: 0, y: 200, angle: 0 },
  );
  return project;
}

test('grouping needs at least two objects and labels them without changing them', () => {
  const project = withObjects();
  assert.throws(() => groupEntities(project, ['crate']), /at least two/);
  const group = groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  assert.equal(group.name, 'Door');
  assert.equal(entityGroups(project).length, 1);
  assert.deepEqual(membersOf(project, group.id).map(entity => entity.id), ['frame', 'leaf']);
  // The members are still ordinary objects: grouping adds a label and nothing else.
  const frame = project.map.entities.find(entity => entity.id === 'frame');
  assert.equal(frame.type, 'decoration');
  assert.equal(frame.x, 100);
  assert.equal(groupOf(project, frame).name, 'Door');
  assert.deepEqual(ungrouped(project).map(entity => entity.id),
    project.map.entities.filter(entity => entity.id !== 'frame' && entity.id !== 'leaf').map(entity => entity.id));
  assert.doesNotThrow(() => validateProject(project));
});

test('a group name never collides with another group', () => {
  const project = withObjects();
  groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  const second = groupEntities(project, ['crate', project.map.entities[0].id], { name: 'Door' });
  assert.equal(second.name, 'Door 2');
});

test('ungrouping keeps the objects; removing one member can dissolve the group', () => {
  const project = withObjects();
  const group = groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  assert.equal(ungroup(project, group.id), 2);
  assert.equal(entityGroups(project).length, 0);
  assert.equal(ungrouped(project).length, project.map.entities.length);
  // Two members, one leaves: a group of one is not a group, so it dissolves and the last
  // member is left ungrouped rather than pointing at a group that no longer exists.
  const again = groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  assert.equal(typeof leaveGroup(project, 'frame'), 'string', 'it left a group');
  assert.equal(entityGroups(project).length, 0);
  assert.equal(project.map.entities.find(entity => entity.id === 'leaf').groupId, undefined);
  assert.equal(groupById(project, again.id), null);
});

test('a group reference that points at nothing is cleaned up, not drawn', () => {
  const project = withObjects();
  const group = groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  delete project.map.entityGroups;
  project.map.entities.find(entity => entity.id === 'frame').groupId = group.id;
  pruneGroups(project);
  assert.equal(project.map.entities.find(entity => entity.id === 'frame').groupId, undefined);
});

test('validation rejects a member of a group that does not exist', () => {
  const project = withObjects();
  project.map.entities.find(entity => entity.id === 'crate').groupId = 'group_missing';
  assert.throws(() => validateProject(project), /unknown group/);
});

test('copying a group copies the group, keeping how its objects sit together', () => {
  const project = withObjects();
  const group = groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  const copy = cloneEntitiesForPaste(project, membersOf(project, group.id), { x: 400, y: 400 });
  assert.equal(copy.group.name, 'Door copy');
  assert.notEqual(copy.group.id, group.id, 'the copy is its own group');
  assert.deepEqual(copy.entities.map(entity => entity.name), ['Door frame copy', 'Door leaf copy']);
  // The frame lands on the point and the leaf keeps its 32 units to the right of it.
  assert.deepEqual(copy.entities.map(entity => [entity.x, entity.y]), [[400, 400], [432, 400]]);
  assert.ok(copy.entities.every(entity => entity.groupId === copy.group.id));
  // The original is untouched.
  assert.deepEqual(membersOf(project, group.id).map(entity => entity.id), ['frame', 'leaf']);
  // And a copy of loose objects is loose.
  const loose = cloneEntitiesForPaste(project, [project.map.entities.find(entity => entity.id === 'crate')], { x: 0, y: 0 });
  assert.equal(loose.group, null);
  assert.equal(loose.entities[0].groupId, undefined);
  assert.doesNotThrow(() => validateProject(project));
});

test('a copy of part of a group is not a group', () => {
  const project = withObjects();
  groupEntities(project, ['frame', 'leaf'], { name: 'Door' });
  const copy = cloneEntitiesForPaste(project, [project.map.entities.find(entity => entity.id === 'leaf')], null);
  assert.equal(copy.group, null, 'one member copied out of a group is just an object');
  assert.equal(copy.entities[0].groupId, undefined);
});
