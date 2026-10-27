import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import {
  moveAction, moveCondition, moveEventBranchBeside, setEventParent, validateEventStructure,
} from '../shared/events.js';

const ids = project => project.events.map(event => event.id);

function script() {
  const project = createProject();
  project.events = [
    { id: 'a', enabled: true, once: false, sheetId: 's1', condition: { type: 'onStart' }, conditions: [], actions: [] },
    { id: 'a1', enabled: true, once: false, sheetId: 's1', parentId: 'a', condition: { type: 'onStart' }, conditions: [], actions: [] },
    { id: 'b', enabled: true, once: false, sheetId: 's1', condition: { type: 'onStart' }, conditions: [], actions: [] },
    { id: 'c', enabled: true, once: false, sheetId: 's1', condition: { type: 'onStart' }, conditions: [], actions: [] },
    { id: 'other', enabled: true, once: false, sheetId: 's2', condition: { type: 'onStart' }, conditions: [], actions: [] },
  ];
  project.eventSheets = [{ id: 's1', name: 'One', section: 'game', enabled: true, phase: 'afterPhysics' },
    { id: 's2', name: 'Two', section: 'game', enabled: true, phase: 'afterPhysics' }];
  return project;
}
const check = project => validateEventStructure(project, (value, message) => assert.ok(value, message));

test('rules can be dragged before and after another rule, children travelling along', () => {
  const project = script();
  moveEventBranchBeside(project, 'c', 'a', 'before');
  assert.deepEqual(ids(project), ['c', 'a', 'a1', 'b', 'other'], 'the sub-event follows its parent');
  moveEventBranchBeside(project, 'c', 'b', 'after');
  assert.deepEqual(ids(project), ['a', 'a1', 'b', 'c', 'other']);
  moveEventBranchBeside(project, 'a', 'c', 'after');
  assert.deepEqual(ids(project), ['b', 'c', 'a', 'a1', 'other']);
  check(project);
});

test('dragging a rule is a no-op into itself and refused across sheets', () => {
  const project = script();
  assert.throws(() => moveEventBranchBeside(project, 'a', 'a1', 'before'), /inside itself/);
  assert.deepEqual(ids(project), ['a', 'a1', 'b', 'c', 'other'], 'the project is unchanged');
  assert.throws(() => moveEventBranchBeside(project, 'a', 'other', 'before'),
    /same sheet, group and object context/);
  assert.throws(() => moveEventBranchBeside(project, 'a', 'b', 'sideways'), /Unknown drop position/);
});

test('a rule can be indented under another and outdented again', () => {
  const project = script();
  setEventParent(project, 'b', 'a');
  assert.deepEqual(ids(project), ['a', 'a1', 'b', 'c', 'other']);
  assert.equal(project.events.find(event => event.id === 'b').parentId, 'a');
  assert.equal(project.events.find(event => event.id === 'c').parentId, undefined);
  check(project);
  setEventParent(project, 'b');
  assert.deepEqual(ids(project), ['a', 'a1', 'b', 'c', 'other'], 'an outdented rule stays where it was, without a parent');
  assert.equal(project.events.find(event => event.id === 'b').parentId, undefined);
  check(project);
});

test('conditions and actions keep the first condition and reorder the rest', () => {
  const event = { condition: { type: 'onStart' }, conditions: [{ type: 'keyHeld', key: 'KeyW' }, { type: 'playerAlive' }],
    actions: [{ type: 'a' }, { type: 'b' }, { type: 'c' }] };
  moveCondition(event, 1, 2);
  assert.deepEqual(event.conditions.map(condition => condition.type), ['playerAlive', 'keyHeld']);
  // The first slot is always the primary condition, so dragging into it promotes.
  moveCondition(event, 2, 0);
  assert.equal(event.condition.type, 'keyHeld');
  assert.deepEqual(event.conditions.map(condition => condition.type), ['onStart', 'playerAlive']);
  moveAction(event, 2, 0);
  assert.deepEqual(event.actions.map(action => action.type), ['c', 'a', 'b']);
  assert.throws(() => moveCondition(event, 9, 0), /out of range/);
  assert.throws(() => moveAction(event, 0, 5), /out of range/);
});
