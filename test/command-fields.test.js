import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFields } from '../shared/command-fields.js';

const route = { id: 'route', name: 'Route', closed: false, points: [
  { id: 'p0', x: 0, y: 0 }, { id: 'p1', x: 64, y: 0, name: 'Gate' }, { id: 'p2', x: 128, y: 0 } ] };
const paths = [['route', 'Route']];
const base = { entities: [], playerId: 'player', variables: ['score'], paths, pathPoints: id => (id === 'route' ? route : null) };

// The parameter dialog reads these lists directly, so the lists are the feature: a waypoint the
// author cannot see is a waypoint they cannot choose.
test('a route action offers its waypoints by name, after the route itself', () => {
  const fields = commandFields({ type: 'followPath', pathId: 'route', fromPoint: 0, toPoint: -1 }, base);
  const names = fields.map(field => field.name);
  assert.ok(names.indexOf('pathId') < names.indexOf('fromPoint'), 'the route is chosen before its waypoints');
  assert.ok(names.indexOf('entityId') < names.indexOf('pathId'), 'the object comes first of all');
  const from = fields.find(field => field.name === 'fromPoint');
  const to = fields.find(field => field.name === 'toPoint');
  assert.deepEqual(from.options, [[0, 'Waypoint 1'], [1, 'Gate'], [2, 'Waypoint 3']]);
  assert.equal(from.numeric, true, 'the picker submits an index, not the text of the option');
  assert.deepEqual(to.options[0], [-1, 'Last waypoint'], 'the end of the route is offered by name');
  assert.equal(to.options.length, 4);
});

// A fresh action has no route stored, but the Route picker will paint its first option — so the
// waypoint lists have to describe that route rather than come out empty.
test('waypoints follow the route the picker is about to show', () => {
  const fields = commandFields({ type: 'followPath', fromPoint: 0, toPoint: -1 }, base);
  assert.deepEqual(fields.find(field => field.name === 'fromPoint').options.map(option => option[1]),
    ['Waypoint 1', 'Gate', 'Waypoint 3']);
  const empty = commandFields({ type: 'followPath' }, { ...base, paths: [] });
  assert.deepEqual(empty.find(field => field.name === 'fromPoint').options, [], 'no routes, nothing to offer');
});

// "Set / compare local variable" used to list the project's globals, so picking one produced a
// rule that failed validation. The list is the object's own, and it stays typable.
test('a local variable field offers the object it names, not the globals', () => {
  const context = { ...base, entityVariableNames: id => (id === 'crate' ? ['speed', 'hp'] : []) };
  for (const type of ['objectVariableCompare', 'setObjectVariable', 'addObjectVariable']) {
    const field = commandFields({ type, entityId: 'crate', variable: 'speed', value: 1 }, context).find(item => item.name === 'variable');
    assert.equal(field.label, 'Local variable', type);
    assert.deepEqual(field.suggestions, ['speed', 'hp'], type);
    assert.equal(field.options, undefined, `${type} must stay typable: the variable may not exist yet`);
    assert.equal(field.hint, null);
  }
  const bare = commandFields({ type: 'objectVariableCompare', entityId: 'empty', variable: 'speed' }, context)
    .find(item => item.name === 'variable');
  assert.deepEqual(bare.suggestions, []);
  assert.match(bare.hint, /no local variables yet/);
  // A global variable comparison keeps its own list.
  const global = commandFields({ type: 'variableCompare', variable: 'score' }, context).find(item => item.name === 'variable');
  assert.deepEqual(global.options, ['score']);
  assert.equal(global.suggestions, undefined);
});
