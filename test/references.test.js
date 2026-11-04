import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, removeEntity, standInFor } from '../shared/project.js';
import { newScene, addSceneObject, removeSceneObjects } from '../shared/scenes.js';
import { createTimesheet, createCue } from '../shared/timesheet.js';
import { entityReferences, stripEntityReferences, rewriteEntityReferences, commandTargets } from '../shared/references.js';

const rule = (id, ownerId, extra = {}) => ({ id, name: id, enabled: true, once: false, ownerId,
  condition: { type: 'onStart' }, conditions: [], actions: [], ...extra });

/** A layout whose pickup is named in every way an object can be named. */
function projectNamingThePickup() {
  const project = createProject();
  const target = project.map.entities.find(entity => entity.type === 'pickup');
  const player = project.map.entities.find(entity => entity.type === 'player');
  // A collision condition needs its targets to be solid; the player is exempt, having its capsule.
  target.physics = { body: 'dynamic', shape: 'box', width: 24, height: 32, depth: 24, radius: 12, mass: 1,
    friction: .7, restitution: 0, sensor: false, lockRotation: true };
  project.events = [
    // A spawn template is a reference too — the one the old guard did not know about.
    rule('spawn', player.id, { actions: [{ type: 'spawnEntity', templateId: target.id, x: 0, y: 0 }] }),
    // An action target, a condition target and a condition's "other" object.
    rule('acts', player.id, { actions: [{ type: 'showMessage', message: 'hi' }, { type: 'removeEntity', entityId: target.id }] }),
    rule('sees', player.id, { condition: { type: 'nearEntity', entityId: target.id, distance: 32 } }),
    // The same collision from both sides: only the second names the object, and only in `otherId`.
    rule('touches', player.id, { condition: { type: 'collisionStarted', entityId: target.id, otherId: player.id } }),
    rule('hit_by', player.id, { condition: { type: 'collisionStarted', entityId: player.id, otherId: target.id } }),
    rule('unrelated', player.id, { actions: [{ type: 'showMessage', message: 'nothing to do with it' }] }),
  ];
  const sheet = createTimesheet({ id: 'sheet', name: 'Timeline' });
  sheet.cues = [
    { ...createCue({ id: 'cue_drive', name: 'Drive', trackId: sheet.tracks[0].id, time: 1, ownerId: target.id }),
      actions: [{ type: 'showMessage', message: 'drive' }] },
    { ...createCue({ id: 'cue_use', name: 'Use', trackId: sheet.tracks[0].id, time: 2, ownerId: null }),
      actions: [{ type: 'removeEntity', entityId: target.id }] },
  ];
  project.timesheets = [sheet];
  return { project, target, player };
}

test('every way an object can be named is found, and nothing else is', () => {
  const { project, target } = projectNamingThePickup();
  const found = entityReferences(project, target.id);
  const byId = new Map(found.map(reference => [`${reference.source}:${reference.id}`, reference]));
  for (const id of ['event:spawn', 'event:acts', 'event:sees', 'event:touches', 'cue:cue_drive', 'cue:cue_use'])
    assert.ok(byId.has(id), `${id} is a reference`);
  assert.equal(byId.has('event:unrelated'), false, 'a rule that does not name it is not a reference');
  assert.deepEqual(byId.get('event:acts').fields, ['entityId']);
  assert.deepEqual(byId.get('event:touches').fields, ['entityId'], 'a collision target counts');
  assert.deepEqual(byId.get('event:spawn').fields, ['templateId'], 'a spawn template counts');
  assert.equal(byId.get('cue:cue_drive').owned, true, 'a cue owned by the object is its own script');
  assert.equal(byId.get('cue:cue_use').owned, false);
  // `$self` and friends are not objects.
  assert.deepEqual(commandTargets({ entityId: '$self' }), []);
  assert.deepEqual(commandTargets({ entityId: '$player', otherId: '$world' }), []);
});

test('zone conditions participate in reference guards, rewrite and branch deletion', () => {
  const project = createProject();
  const zone = { id: 'zone', name: 'Zone', type: 'zone', x: 0, y: 0, angle: 0,
    area: { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 } };
  project.map.entities.push(zone, { ...structuredClone(zone), id: 'other_zone' });
  project.events = [
    rule('zone_rule', undefined, { condition: { type: 'playerEnteredZone', zoneId: zone.id },
      actions: [{ type: 'addVariable', variable: 'score', value: 1 }] }),
    rule('child', undefined, { parentId: 'zone_rule' }),
  ];
  assert.equal(entityReferences(project, zone.id).length, 1);
  assert.throws(() => removeEntity(project, zone.id), /used by/);
  rewriteEntityReferences(project, new Map([[zone.id, 'other_zone']]));
  assert.equal(project.events[0].condition.zoneId, 'other_zone');
  const stripped = stripEntityReferences(project, 'other_zone');
  assert.equal(stripped.events, 2);
  assert.deepEqual(project.events, []);
});

// The bug: three of these references used to slip past `removeEntity`, which only knew about an
// action's `entityId`, so deleting left a project that no longer validated.
test('the delete guard refuses every kind of reference, not just an action target', () => {
  for (const id of ['spawn', 'acts', 'sees', 'touches', 'hit_by']) {
    const { project, target } = projectNamingThePickup();
    assert.throws(() => removeEntity(project, target.id), /used by/, `${id} blocks the delete`);
    assert.equal(project.map.entities.some(entity => entity.id === target.id), true, 'and nothing was removed');
  }
  const { project, target } = projectNamingThePickup();
  assert.throws(() => removeEntity(project, target.id), /used by spawn, acts/, 'the message names the rules that use it');
});

test('keeping zone and area rules preserves their replacement trigger volumes', () => {
  const project = createProject();
  const zone = { id: 'zone', name: 'Zone', type: 'zone', x: 0, y: 0, angle: 0,
    area: { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 } };
  project.map.entities.push(zone);
  project.events = [rule('inside', undefined, { condition: { type: 'playerInZone', zoneId: zone.id } })];
  const stand = standInFor(zone, 'replacement');
  assert.equal(stand.type, 'zone');
  assert.deepEqual(stand.area, zone.area);
  assert.notEqual(stand.area, zone.area);
  project.map.entities.push(stand);
  rewriteEntityReferences(project, new Map([[zone.id, stand.id]]));
  removeEntity(project, zone.id);
  validateProject(project);
});

test('deleting with "drop the rules" leaves a project that validates', () => {
  const { project, target } = projectNamingThePickup();
  stripEntityReferences(project, target.id);
  removeEntity(project, target.id);
  assert.doesNotThrow(() => validateProject(project), 'the project is valid again');
  // The unrelated rule survives, the gutted ones are gone, and the partly-used one kept the action
  // that had nothing to do with the object.
  assert.deepEqual(project.events.map(event => event.id), ['acts', 'unrelated']);
  assert.deepEqual(project.events[0].actions.map(action => action.type), ['showMessage']);
  assert.deepEqual(project.timesheets[0].cues.map(cue => cue.id), []);
  assert.equal(entityReferences(project, target.id).length, 0);
});

test('deleting with "keep the rules" re-points every reference at an empty object', () => {
  const { project, target } = projectNamingThePickup();
  // A stand-in keeps what its rules still need — a collision rule needs its target to be solid —
  // and nothing else.
  const stand = standInFor(target, 'empty_object');
  assert.equal(stand.physics.body, 'dynamic', 'the body comes along');
  assert.equal(stand.spriteAsset, undefined);
  project.map.entities.push(stand);
  rewriteEntityReferences(project, new Map([[target.id, stand.id]]));
  removeEntity(project, target.id);
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(entityReferences(project, target.id).length, 0, 'nothing names the old object');
  const named = entityReferences(project, stand.id).map(reference => `${reference.source}:${reference.id}`);
  assert.ok(named.includes('event:spawn') && named.includes('event:sees') && named.includes('event:hit_by'));
  assert.ok(named.includes('cue:cue_drive') && named.includes('cue:cue_use'), 'the cues follow it too');
  assert.equal(project.timesheets[0].cues.length, 2, 'and no cue was deleted');
});

test('dropping a referenced trigger also drops its descendants, but retains partially cleaned branches', () => {
  for (const inScene of [false, true]) {
    const project = createProject(), target = project.map.entities.find(entity => entity.type === 'pickup');
    const action = { type: 'showMessage', message: 'survives' };
    const events = [
      rule('root', undefined, { condition: { type: 'nearEntity', entityId: target.id, distance: 32 }, actions: [action] }),
      rule('child', undefined, { parentId: 'root', actions: [action] }),
      rule('grandchild', undefined, { parentId: 'child', actions: [action] }),
      rule('keep', undefined, { actions: [action, { type: 'removeEntity', entityId: target.id }] }),
      rule('keep_child', undefined, { parentId: 'keep', actions: [action] }),
      rule('gate', undefined, { actions: [{ type: 'removeEntity', entityId: target.id }] }),
      rule('gate_child', undefined, { parentId: 'gate', actions: [action] }),
    ];
    const holder = inScene ? { events } : project;
    holder.events = events;
    const removed = stripEntityReferences(project, target.id, inScene ? { scene: holder } : {});
    assert.deepEqual(holder.events.map(event => event.id), ['keep', 'keep_child', 'gate', 'gate_child']);
    assert.equal(removed.events, 3, 'descendants count as removed rules');
    if (!inScene) { removeEntity(project, target.id); validateProject(project); }
  }
});

// A scene keeps its own rule list, and a scene's rules are not validated against their own
// targets — so a node the rules still named simply stopped working with no complaint.
test('deleting a scene node takes the rules that named it with it', () => {
  const scene = newScene('Room');
  const keeper = addSceneObject(scene, { name: 'Keeper', x: 0, y: 0 });
  const victim = addSceneObject(scene, { name: 'Victim', x: 32, y: 0 });
  const bystander = addSceneObject(scene, { name: 'Bystander', x: 64, y: 0 });
  scene.events = [
    rule('names_victim', keeper.id, { actions: [{ type: 'setEntityPosition', entityId: victim.id, x: 1, y: 2 }] }),
    rule('both', keeper.id, { actions: [{ type: 'setEntityPosition', entityId: bystander.id, x: 1, y: 2 },
      { type: 'setEntityPosition', entityId: victim.id, x: 3, y: 4 }] }),
    rule('own_rule', victim.id, { actions: [{ type: 'setEntityPosition', entityId: victim.id, x: 5, y: 6 }] }),
  ];
  const removed = removeSceneObjects(scene, victim.id);
  assert.equal(removed.removed, 1);
  assert.deepEqual(scene.events.map(event => event.id), ['both'], 'the gutted rule and the node\'s own rule are gone');
  assert.deepEqual(scene.events[0].actions.map(action => action.entityId), [bystander.id], 'the rest of the rule is untouched');
  const project = createProject();
  project.scenes = [scene];
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(entityReferences({ events: [] }, victim.id, { scene }).length, 0, 'no name of the node is left');
});
