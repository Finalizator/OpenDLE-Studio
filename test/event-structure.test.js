import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { eventBranch, eventDepth, moveEventBranch, removeEventBranch, setEventObjectContext } from '../shared/events.js';
import { applyTool } from '../server/tools.js';
import { requestMouseLock } from '../public/pointer-lock.js';

function rule(id, extra = {}) {
  return { id, enabled: true, once: false, condition: { type: 'always' },
    actions: [{ type: 'addVariable', variable: 'score', value: 1 }], ...extra };
}
function fixture() {
  const project = createProject();
  project.events = [];
  project.eventGroups = [{ id: 'controls', name: 'Controls', enabled: true }];
  return project;
}
test('AND / OR and inverted comparisons are executable, while trigger inversion is rejected', () => {
  const project = fixture();
  project.events = [rule('parent', { condition: { type: 'variableCompare', variable: 'score', operator: '>', value: 100 },
    conditions: [{ type: 'keyHeld', key: 'KeyE' }], conditionMode: 'or' }),
  rule('negative', { condition: { type: 'keyHeld', key: 'KeyF', inverted: true } })];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set(['KeyE']));
  assert.equal(state.variables.score, 2);
  project.events[0].conditionMode = 'and';
  stepRuntime(project, state, .01, new Set(['KeyE', 'KeyF']));
  assert.equal(state.variables.score, 2);
  project.events[0].condition = { type: 'onStart', inverted: true };
  assert.throws(() => validateProject(project), /Trigger/);
});

test('entry and periodic trigger inversion is rejected just like other edge triggers', () => {
  const project = fixture(), target = project.map.entities.find(entity => entity.type !== 'player');
  target.area = { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 };
  for (const condition of [
    { type: 'everySeconds', seconds: .5 },
    { type: 'playerEnteredArea', entityId: target.id },
  ]) {
    project.events = [rule('inverted', { condition: { ...condition, inverted: true } })];
    assert.throws(() => validateProject(project), /Trigger conditions cannot be inverted/);
  }
});
test('sub-events run immediately after matched parent actions, before the next sibling', () => {
  const project = fixture();
  project.events = [
    rule('parent', { actions: [{ type: 'setVariable', variable: 'score', value: 10 }] }),
    rule('child', { parentId: 'parent', condition: { type: 'variableCompare', variable: 'score', operator: '=', value: 10 },
      actions: [{ type: 'addVariable', variable: 'score', value: 20 }] }),
    rule('grandchild', { parentId: 'child' }),
    rule('sibling'),
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.variables.score, 32);
  project.events[0].enabled = false;
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.variables.score, 33);
});

test('changing event object context updates the entire branch but not its siblings', () => {
  const project = fixture(), ownerId = project.map.entities.find(entity => entity.type !== 'player').id;
  project.events = [rule('root'), rule('child', { parentId: 'root' }),
    rule('grandchild', { parentId: 'child' }), rule('sibling')];
  for (const context of [{ ownerId }, { forEachType: 'decoration' }, {}]) {
    setEventObjectContext(project, 'root', context);
    for (const event of project.events.slice(0, 3)) {
      assert.equal(event.ownerId, context.ownerId);
      assert.equal(event.forEachType, context.forEachType);
    }
    assert.equal(project.events[3].ownerId, undefined);
    assert.equal(project.events[3].forEachType, undefined);
    validateProject(project);
  }
  assert.throws(() => setEventObjectContext(project, 'child', { ownerId }), /parent event/);
  assert.throws(() => setEventObjectContext(project, 'missing', {}), /Unknown event/);
});

test('reusable scene events reject broken hierarchy and inverted triggers before placement', () => {
  const project = fixture();
  const scene = { id: 'scene', name: 'Scene', entities: [], events: [
    rule('root'), rule('child', { parentId: 'root' }),
  ] };
  project.scenes = [scene];
  validateProject(project);
  scene.events[1].parentId = 'missing';
  assert.throws(() => validateProject(project), /parent must precede/);
  scene.events[1].parentId = 'root';
  scene.events[0].condition = { type: 'everySeconds', seconds: 1, inverted: true };
  assert.throws(() => validateProject(project), /Trigger conditions cannot be inverted/);
});
test('for-each children inherit only the matching parent instance and once flags stay instance-scoped', () => {
  const project = fixture();
  project.map.entities.push({ id: 'a', type: 'enemy', name: 'A', x: 0, y: 0, angle: 0, health: 5 },
    { id: 'b', type: 'enemy', name: 'B', x: 100, y: 0, angle: 0, health: 20 });
  project.events = [
    rule('parent', { forEachType: 'enemy', actions: [], condition: { type: 'entityHealth', entityId: '$self', operator: '<', value: 10 } }),
    rule('child', { parentId: 'parent', forEachType: 'enemy', once: true,
      actions: [{ type: 'setEntityHealth', entityId: '$self', health: 8 }, { type: 'addVariable', variable: 'score', value: 1 }] }),
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set()); stepRuntime(project, state, .01, new Set());
  assert.equal(state.variables.score, 1);
  assert.equal(state.entities.find(entity => entity.id === 'a').health, 8);
  assert.equal(state.entities.find(entity => entity.id === 'b').health, 20);
});
test('groups can be toggled by scripts and reset to authored defaults per session', () => {
  const project = fixture();
  project.eventGroups[0].enabled = false;
  project.events = [
    rule('enable', { condition: { type: 'keyPressed', key: 'KeyE' }, actions: [{ type: 'setGroupActive', groupId: 'controls', active: 'yes' }] }),
    rule('grouped', { groupId: 'controls' }),
    rule('probe', { condition: { type: 'groupActive', groupId: 'controls' } }),
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set()); assert.equal(state.variables.score, 0);
  stepRuntime(project, state, .01, new Set(), new Set(['KeyE'])); assert.equal(state.variables.score, 2);
  assert.equal(createRuntime(project).groups.get('controls'), false);
});
test('hierarchy validation rejects missing, reordered, non-contiguous and incompatible parent contexts', () => {
  const mutations = [
    p => { p.events[1].parentId = 'missing'; },
    p => { p.events[0].parentId = 'child'; },
    p => { p.events.splice(1, 0, rule('unrelated')); },
    p => { p.events[1].ownerId = 'pickup'; },
    p => { p.events[1].groupId = 'controls'; },
    p => { p.events[1].conditionMode = 'xor'; },
    p => { p.events[1].comment = 'x'.repeat(2001); },
  ];
  for (const mutation of mutations) {
    const project = fixture(); project.events = [rule('parent'), rule('child', { parentId: 'parent' })];
    mutation(project); assert.throws(() => validateProject(project));
  }
  const deep = fixture(); deep.events.push(rule('root'));
  for (let i = 0; i < 17; i++) deep.events.push(rule(`nested${i}`, { parentId: deep.events.at(-1).id }));
  assert.throws(() => validateProject(deep), /nest/);
});
test('branch move and delete preserve hierarchy and complete descendants', () => {
  const project = fixture();
  project.events = [rule('a'), rule('child', { parentId: 'a' }), rule('grandchild', { parentId: 'child' }), rule('b')];
  assert.equal(eventDepth(project.events, project.events[2]), 2);
  assert.deepEqual([...eventBranch(project.events, 'a')], ['a', 'child', 'grandchild']);
  moveEventBranch(project, 'a', 1);
  assert.deepEqual(project.events.map(event => event.id), ['b', 'a', 'child', 'grandchild']); validateProject(project);
  moveEventBranch(project, 'a', -1); validateProject(project);
  removeEventBranch(project, 'a'); assert.deepEqual(project.events.map(event => event.id), ['b']);
});
test('MCP shares group, comment, sub-event and logical-operator validation', () => {
  let project = fixture();
  project = applyTool(project, 'event_group_add', { name: 'Logic' }).project;
  const groupId = project.eventGroups.at(-1).id;
  project.events = [rule('parent', { groupId })];
  project = applyTool(project, 'events_add_rule', { parentId: 'parent', groupId, comment: 'Nested rule',
    conditionMode: 'or', condition: { type: 'always' }, actions: [], once: false }).project;
  assert.equal(project.events[1].parentId, 'parent'); validateProject(project);
  project = applyTool(project, 'event_group_update', { id: groupId, enabled: false }).project;
  assert.equal(project.eventGroups.at(-1).enabled, false);
});
test('mouse lock requests the real API even without pointerLockEnabled and never assumes success', async () => {
  let requested = 0; const messages = [];
  const report = (...args) => messages.push(args);
  const canvas = { requestPointerLock() { requested++; return Promise.resolve(); } };
  requestMouseLock({}, canvas, report);
  assert.equal(requested, 1); assert.match(messages[0][0], /Requesting/);
  requestMouseLock({ pointerLockElement: canvas }, canvas, report); assert.equal(requested, 1);
  requestMouseLock({}, {}, report); assert.match(messages.at(-1)[0], /not supported/);
  requestMouseLock({}, { requestPointerLock() { throw new Error('policy blocked'); } }, report);
  assert.match(messages.at(-1)[0], /policy blocked/); assert.equal(messages.at(-1)[1], true);
  requestMouseLock({}, { requestPointerLock() { return Promise.reject(new Error('permission denied')); } }, report);
  await Promise.resolve();
  assert.match(messages.at(-1)[0], /permission denied/);
  requestMouseLock({}, { requestPointerLock() { requested++; } }, report);
  assert.equal(requested, 2);
});
