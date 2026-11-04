import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, removeEntity, removeEntities, standInFor } from '../shared/project.js';
import { newScene, addSceneObject, removeSceneObjects } from '../shared/scenes.js';
import { createTimesheet, createCue } from '../shared/timesheet.js';
import { entityReferences, stripEntityReferences, rewriteEntityReferences, commandTargets } from '../shared/references.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { readFileSync } from 'node:fs';
import { bundleModel } from '../shared/gltf.js';
import { modelFixture } from './fixtures/model.js';

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

test('objects named only inside expressions are guarded and cleaned in events, cues and scenes', () => {
  const { project, target } = projectNamingThePickup();
  target.variables = { amount: 5 };
  project.events = [rule('expression', undefined, { actions: [
    { type: 'addVariable', variable: 'score', value: { expr: `object("${target.id}", "amount")` } },
  ] })];
  project.timesheets[0].cues = [{ ...project.timesheets[0].cues[0], ownerId: null, actions: [
    { type: 'showMessage', message: { expr: `str(property("${target.id}", "x"))` } },
  ] }];
  validateProject(project);
  assert.equal(entityReferences(project, target.id).length, 2);
  assert.throws(() => removeEntity(project, target.id), /used by/);
  const scene = { events: structuredClone(project.events) };
  assert.equal(entityReferences(project, target.id, { scene }).length, 1);
  stripEntityReferences(project, target.id, { scene });
  assert.deepEqual(scene.events, []);
  stripEntityReferences(project, target.id);
  removeEntity(project, target.id);
  assert.deepEqual(project.events, []);
  assert.deepEqual(project.timesheets[0].cues, []);
  validateProject(project);
});

test('rewriting expression targets preserves ordinary strings, variable names and cached parses', () => {
  const project = createProject(), source = 'concat(object("pickup", "pickup"), "pickup", str(property("pick\\u0075p", "x")))';
  project.events = [rule('expression', undefined, { actions: [
    { type: 'showMessage', message: { expr: source } },
    { type: 'showMessage', message: 'pickup' },
  ] })];
  const untouched = structuredClone(project.events[0]);
  const scene = { events: [structuredClone(untouched)] };
  rewriteEntityReferences(project, new Map([['pickup', 'replacement']]));
  const expected = 'concat(object("replacement", "pickup"), "pickup", str(property("replacement", "x")))';
  assert.equal(project.events[0].actions[0].message.expr, expected);
  assert.equal(project.events[0].actions[1].message, 'pickup');
  assert.equal(untouched.actions[0].message.expr, source);
  rewriteEntityReferences(project, new Map([['pickup', 'other']]), { scene });
  assert.equal(scene.events[0].actions[0].message.expr, expected.replaceAll('replacement', 'other'));
});

test('deleting a condition target never removes a gate and leaves its actions running', () => {
  for (const conditionMode of ['and', 'or']) for (const secondary of [false, true]) {
    const project = createProject(), target = project.map.entities.find(entity => entity.type === 'pickup');
    const gate = { type: 'nearEntity', entityId: target.id, distance: 32 }, always = { type: 'always' };
    project.events = [
      rule('root', undefined, { conditionMode, condition: secondary ? always : gate,
        conditions: [secondary ? gate : always], actions: [{ type: 'addVariable', variable: 'score', value: 1 }] }),
      rule('child', undefined, { parentId: 'root', actions: [{ type: 'addVariable', variable: 'score', value: 10 }] }),
      rule('unrelated', undefined, { actions: [{ type: 'showMessage', message: 'still here' }] }),
    ];
    stripEntityReferences(project, target.id);
    removeEntity(project, target.id);
    validateProject(project);
    const state = createRuntime(project);
    stepRuntime(project, state, .016, new Set());
    assert.equal(state.variables.score, 0, 'removing a gate must not enable its old actions');
    assert.deepEqual(project.events.map(event => event.id), ['unrelated']);
  }
});

test('scene deletion drops branches gated by expression references as well as action targets', () => {
  const scene = newScene('Scene'), owner = addSceneObject(scene, { name: 'Owner', x: 0, y: 0 });
  const victim = addSceneObject(scene, { name: 'Victim', x: 32, y: 0 });
  scene.events = [
    rule('gate', owner.id, { condition: { type: 'always' }, conditions: [
      { type: 'expressionCompare', left: { expr: `property("${victim.id}", "x")` }, operator: '>', right: 0 },
    ], actions: [{ type: 'showMessage', message: 'gated' }] }),
    rule('child', owner.id, { parentId: 'gate', actions: [{ type: 'showMessage', message: 'also gated' }] }),
  ];
  removeSceneObjects(scene, victim.id);
  assert.deepEqual(scene.events, []);
});

test('empty replacements retain the local data, signals and object type their rules require', () => {
  const project = createProject(), target = project.map.entities.find(entity => entity.type === 'pickup');
  target.type = 'enemy';
  target.variables = { amount: 3 };
  target.signals = ['used'];
  project.events = [
    rule('local', target.id, { condition: { type: 'objectVariableCompare', entityId: '$self', variable: 'amount', operator: '=', value: 3 },
      actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'amount', value: 1 }] }),
    rule('listener', undefined, { condition: { type: 'onSignal', entityId: target.id, signal: 'used' } }),
    rule('enemy', undefined, { condition: { type: 'enemyAlert', entityId: target.id } }),
  ];
  validateProject(project);
  const stand = standInFor(target, 'replacement');
  project.map.entities.push(stand);
  rewriteEntityReferences(project, new Map([[target.id, stand.id]]));
  removeEntity(project, target.id);
  validateProject(project);
  assert.deepEqual(stand.variables, target.variables);
  assert.notEqual(stand.variables, target.variables);
  assert.deepEqual(stand.signals, target.signals);
  assert.equal(stand.type, 'enemy');
});

test('batch deletion and replacement finish as one valid edit and preserve undo input', () => {
  for (const keepReferences of [false, true]) {
    const { project, target } = projectNamingThePickup();
    target.variables = { amount: 4 };
    project.events.push(rule('expression', target.id, { actions: [
      { type: 'addVariable', variable: 'score', value: { expr: `object("${target.id}", "amount")` } },
    ] }));
    validateProject(project);
    const before = structuredClone(project), draft = structuredClone(project);
    removeEntities(draft, [target.id], { keepReferences });
    validateProject(draft);
    assert.deepEqual(project, before, 'one undo restores the input document with objects and references together');
    assert.equal(draft.map.entities.some(entity => entity.id === target.id), false);
    assert.equal(entityReferences(draft, target.id).length, 0);
    if (keepReferences) {
      const event = draft.events.find(event => event.id === 'expression');
      assert.equal(draft.map.entities.find(entity => entity.id === event.ownerId).variables.amount, 4);
      assert.equal(event.actions[0].value.expr, `object("${event.ownerId}", "amount")`);
    } else assert.equal(draft.events.some(event => event.id === 'expression'), false);
  }
  const { project, target, player } = projectNamingThePickup(), before = structuredClone(project);
  assert.throws(() => removeEntities(project, [target.id, player.id]), /non-player/);
  assert.deepEqual(project, before, 'a forbidden batch does not partially delete its first object');

  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const deletion = app.slice(app.indexOf('async function deleteObjects('), app.indexOf('function deleteLayoutObject('));
  assert.equal((deletion.match(/\bedit\(/g) || []).length, 1, 'the UI commits cleanup, replacement and deletion once');
  assert.match(app, /return deleteObjects\(\[id\]\);/);
  assert.match(app, /return deleteObjects\(targets\);/);
  assert.match(app, /void guard\(deleteSelectionObject\)\(target\);/, 'async deletion failures reach the editor error reporter');
});

test('replacement retains a model only when kept animation rules need it', async () => {
  for (const animations of [false, true]) {
    const project = createProject(), target = project.map.entities.find(entity => entity.type !== 'player');
    const { asset } = await bundleModel(new File([modelFixture().glb], 'model.glb'), [], 'model');
    project.assets = [...(project.assets || []), asset];
    target.modelAsset = asset.id;
    project.events = [rule('model_rule', target.id, { actions: animations
      ? [{ type: 'playAnimation', entityId: '$self', clip: 'Move', speed: 1, loop: false }]
      : [{ type: 'showMessage', message: 'kept' }] })];
    validateProject(project);
    removeEntities(project, [target.id], { keepReferences: true });
    validateProject(project);
    const stand = project.map.entities.find(entity => entity.id === project.events[0].ownerId);
    assert.equal(stand.modelAsset, animations ? asset.id : undefined);
  }
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
