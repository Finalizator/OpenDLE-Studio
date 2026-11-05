import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProject, validateProject, CAMERA_DEFAULTS } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { readInstanceProperty, compareInstanceProperty, INSTANCE_PICKABLE_TYPES } from '../shared/instance-properties.js';
import { expressionContext, validateExpression, expressionObjectReferences } from '../shared/expressions.js';
import { commandFields } from '../shared/command-fields.js';
import { entityReferences, rewriteEntityReferences, stripEntityReferences } from '../shared/references.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { toolDefinitions } from '../server/tools.js';

const rule = (id, condition = { type: 'always' }, actions = [], extra = {}) =>
  ({ id, enabled: true, once: false, condition, actions, ...extra });
const pick = (property, value, operator = '=') =>
  ({ type: 'pickByProperty', objectType: 'enemy', property, operator, value });
const write = value => ({ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value });
const expr = source => ({ expr: source });

function fixture() {
  const project = createProject();
  project.events = [];
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  for (let index = 0; index < 3; index++) project.map.entities.push({
    id: `guard${index}`, name: `Guard ${index}`, type: 'enemy', x: 100 + index * 100, y: 100,
    angle: 0, health: 20 - index * 5, variables: { score: 0, flag: false },
  });
  return project;
}
function play(project, prepare = () => {}) {
  validateProject(project);
  const state = createRuntime(project);
  prepare(state);
  stepRuntime(project, state, 1 / 60, new Set());
  return state;
}
const guards = state => state.entities.filter(entity => entity.type === 'enemy');
const scores = state => guards(state).map(entity => entity.variables.score);
const read = (project, state, entity, property) => readInstanceProperty(project, state, entity, property);

test('instance hunt 01: a child pick must not narrow its following sibling', () => {
  const project = fixture();
  project.events = [
    rule('parent', { type: 'pickAll', objectType: 'enemy' }),
    rule('first', pick('x', 100), [write(1)], { parentId: 'parent' }),
    rule('second', { type: 'always' }, [write(2)], { parentId: 'parent' }),
  ];
  assert.deepEqual(scores(play(project)), [2, 2, 2]);
});

test('instance hunt 02: NOT picks the instances failing the predicate', () => {
  const project = fixture();
  project.events = [rule('not', { ...pick('x', 100), inverted: true }, [write(1)])];
  assert.deepEqual(scores(play(project)), [0, 1, 1]);
});

test('instance hunt 03: OR unions matching instance branches', () => {
  const project = fixture();
  project.events = [rule('either', pick('x', 100), [write(1)], {
    conditions: [pick('x', 300)], conditionMode: 'or',
  })];
  assert.deepEqual(scores(play(project)), [1, 0, 1]);
});

test('instance hunt 04: an owned rule starts with only its owner picked', () => {
  const project = fixture();
  project.events = [rule('owned', { type: 'always' }, [write(1)], { ownerId: 'guard1' })];
  assert.deepEqual(scores(play(project)), [0, 1, 0]);
});

test('instance hunt 05: creation replaces the pick with the newly created object', () => {
  const project = fixture();
  project.events = [rule('create', { type: 'onStart' }, [
    { type: 'spawnEntity', templateId: 'guard0', x: 400, y: 100 }, write(42),
  ])];
  const state = play(project);
  assert.deepEqual(scores(state), [0, 0, 0, 42]);
});

test('instance hunt 06: a picked action evaluates expressions for each target instance', () => {
  const project = fixture();
  project.events = [rule('per_instance', { type: 'always' }, [
    write(expr('property("enemy", "health")')),
  ])];
  assert.deepEqual(scores(play(project)), [20, 15, 10]);
});

test('instance hunt 07: picked variable assignment cannot change its declared type', () => {
  const project = fixture();
  project.events = [rule('bad_assignment', { type: 'always' }, [write('not a number')])];
  assert.throws(() => validateProject(project), /type|numeric/i);
  project.events[0].actions = [write(expr('"not a number"'))];
  assert.throws(() => play(project), /bad_assignment.*type/i);
});

test('instance hunt 08: picked addition refuses a text expression instead of concatenating', () => {
  const project = fixture();
  project.events = [rule('bad_add', { type: 'always' }, [
    { type: 'addPickedVariable', objectType: 'enemy', variable: 'score', value: expr('"2"') },
  ])];
  assert.throws(() => play(project), /bad_add.*(type|number|numeric)/i);
});

test('instance hunt 09: picked transforms validate literal and evaluated geometry values', () => {
  const project = fixture();
  for (const action of [
    { type: 'setPickedPosition', objectType: 'enemy', x: 'oops', y: 0 },
    { type: 'movePicked', objectType: 'enemy', dx: false, dy: 0 },
    { type: 'setPickedAngle', objectType: 'enemy', angle: '90' },
    { type: 'scalePicked', objectType: 'enemy', scale: -1 },
  ]) {
    project.events = [rule('bad_transform', { type: 'always' }, [action])];
    assert.throws(() => validateProject(project), /number|scale|numeric|between/i, action.type);
  }
  project.events = [rule('bad_transform', { type: 'always' }, [
    { type: 'setPickedPosition', objectType: 'enemy', x: expr('"oops"'), y: 0 },
  ])];
  assert.throws(() => play(project), /bad_transform.*numeric/i);
  for (const scale of [-.01, 20.01]) {
    project.events[0].actions = [{ type: 'scalePicked', objectType: 'enemy', scale: expr(String(scale)) }];
    assert.throws(() => play(project), /bad_transform.*numeric/i);
  }
});

test('instance hunt 10: picked positioning calls the actual physics teleport API', () => {
  const project = fixture(), calls = [];
  project.events = [rule('position', pick('x', 100), [
    { type: 'setPickedPosition', objectType: 'enemy', x: 400, y: 100, z: 24 },
    { type: 'movePicked', objectType: 'enemy', dx: 8, dy: 0, dz: 4 },
  ])];
  play(project, state => {
    state.physics = { grounded: true, syncWorld() {}, step() {},
      teleport(...args) { calls.push(args); } };
  });
  assert.deepEqual(calls, [['guard0', 400, 100, 24], ['guard0', 408, 100, 28]]);
});

test('instance hunt 11: picked scaling writes the fields the renderer actually uses', () => {
  const project = fixture();
  project.events = [rule('scale', pick('x', 100), [
    { type: 'scalePicked', objectType: 'enemy', scale: 2 },
  ])];
  const entity = guards(play(project))[0];
  assert.equal(entity.spriteScale, 2);
  assert.equal(entity.scale, undefined, 'do not invent an unsaved runtime field');
});

test('instance hunt 12: floorHeight follows live sector movement', () => {
  const project = fixture(), state = createRuntime(project), entity = guards(state)[0];
  state.sectors.find(sector => sector.id === 'room0').floorHeight = 48;
  assert.equal(read(project, state, entity, 'floorHeight'), 48);
});

test('instance hunt 13: the player floor lookup uses the live player position', () => {
  const project = fixture();
  project.map.sectors.find(sector => sector.id === 'room0').floorHeight = 48;
  const state = createRuntime(project);
  state.player.x = 100000; state.player.y = 100000;
  state.sectors.find(sector => sector.id === 'room0').floorHeight = 48;
  const player = state.entities.find(entity => entity.type === 'player');
  assert.equal(read(project, state, player, 'floorHeight'), 0);
});

test('instance hunt 14: elevation is the live height above the current floor', () => {
  const project = fixture(), state = createRuntime(project), entity = guards(state)[0];
  entity.z = 72; entity.elevation = 0;
  assert.equal(read(project, state, entity, 'elevation'), 72);
});

test('instance hunt 15: authoring reads the authored player angle instead of zero', () => {
  const project = fixture(), player = project.map.entities.find(entity => entity.type === 'player');
  player.angle = 135;
  assert.equal(read(project, null, player, 'angle'), 135);
});

test('instance hunt 16: the live player health comes from player stats, not the initial entity', () => {
  const project = fixture(), state = createRuntime(project);
  const player = state.entities.find(entity => entity.type === 'player');
  player.health = 100; state.playerStats.health = 0;
  assert.equal(read(project, state, player, 'health'), 0);
  assert.equal(read(project, state, player, 'alive'), 0);
});

function animate(project, loop = true) {
  project.spriteClips = [{ id: 'walk', name: 'Walk', frames: ['a', 'b'], seconds: .1, loop }];
  const state = createRuntime(project), entity = guards(state)[0];
  state.time = .55; state.spriteAnimations.set(entity.id, { clipId: 'walk', name: 'walk', start: 0 });
  return { state, entity };
}
test('instance hunt 17: animation frames wrap looping clips and clamp finished clips', () => {
  const project = fixture();
  for (const loop of [true, false]) {
    const { state, entity } = animate(project, loop);
    assert.equal(read(project, state, entity, 'animationFrame'), 1);
  }
});

test('instance hunt 18: the implicit stand clip reports its real elapsed time and frame', () => {
  const project = fixture(), { state, entity } = animate(project);
  state.spriteAnimations.delete(entity.id);
  entity.spriteStates = { stand: 'walk' };
  assert.equal(read(project, state, entity, 'animationTime'), .55);
  assert.equal(read(project, state, entity, 'animationFrame'), 1);
});

test('instance hunt 19: scale expressions read real sprite and model scales', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  entity.spriteScale = 3;
  assert.equal(read(project, null, entity, 'scale'), 3);
  entity.modelAsset = 'model'; entity.modelScale = 48;
  assert.equal(read(project, null, entity, 'scale'), 48);
});

test('instance hunt 20: opacity expressions read the node visual opacity', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  entity.mesh = { opacity: .25 };
  assert.equal(read(project, null, entity, 'opacity'), .25);
});

test('instance hunt 21: round volume dimensions use radius, not unused box dimensions', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  entity.area = { shape: 'sphere', radius: 12, width: 96, height: 96, depth: 96 };
  assert.deepEqual(['width', 'height', 'depth'].map(name => read(project, null, entity, name)), [24, 24, 24]);
});

test('instance hunt 22: actor velocity expressions read the actor velocity fields', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  entity.vx = 30; entity.vy = 40; entity.vz = 12;
  assert.deepEqual(['vx', 'vy', 'vz', 'speed'].map(name => read(project, null, entity, name)), [30, 40, 12, Math.hypot(30, 40, 12)]);
});

test('instance hunt 23: Doom player momentum is converted from units per tic to units per second', () => {
  const project = fixture(), state = createRuntime(project);
  state.momentum = { x: 3, y: 4, z: 0 };
  const player = state.entities.find(entity => entity.type === 'player');
  assert.deepEqual(['vx', 'vy', 'speed'].map(name => read(project, state, player, name)), [105, 140, 175]);
});

test('instance hunt 24: camera property defaults match the rendered camera', () => {
  const project = fixture(), camera = { id: 'cam', type: 'camera', x: 100, y: 100, angle: 0 };
  assert.equal(read(project, null, camera, 'cameraFov'), CAMERA_DEFAULTS.fov);
  assert.equal(read(project, null, camera, 'cameraHeight'), CAMERA_DEFAULTS.height);
});

test('instance hunt 25: picked-variable suggestions read the actual tuple from the editor', () => {
  const fields = commandFields({ type: 'setPickedVariable', objectType: 'enemy' }, {
    entities: [], variables: [], objectTypes: [['enemy', 'Enemy', ['score', 'flag']]],
  });
  assert.deepEqual(fields.find(field => field.name === 'variable').suggestions, ['score', 'flag']);
});

test('instance hunt 26: the event sheet offers every supported for-each type', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const field = source.split("field(meta, 'For each',")[1]?.split('event.forEachType')[0];
  assert.ok(field, 'find the actual for-each dropdown');
  assert.ok(field.includes('INSTANCE_PICKABLE_TYPES'), 'use the canonical options instead of three hard-coded types');
});

test('instance hunt 27: MCP accepts every runtime-supported for-each type', () => {
  const field = toolDefinitions.find(tool => tool.name === 'events_add_rule').shape.forEachType;
  for (const type of INSTANCE_PICKABLE_TYPES) assert.equal(field.safeParse(type).success, true, type);
});

test('instance hunt 28: nearest picks reject unknown reference objects during authoring', () => {
  const project = fixture();
  project.events = [rule('nearest', {
    type: 'pickNearest', objectType: 'enemy', to: 'missing', order: 'nearest', count: 1,
  })];
  assert.throws(() => validateProject(project), /unknown|reference/i);
});

test('instance hunt 29: deletion tracks the reference object used by a nearest pick', () => {
  const project = fixture();
  project.events = [rule('nearest', {
    type: 'pickNearest', objectType: 'enemy', to: 'guard0', order: 'nearest', count: 1,
  })];
  assert.equal(entityReferences(project, 'guard0').length, 1);
});

test('instance hunt 30: count of an instance is tracked for deletion and remapping', () => {
  assert.deepEqual(expressionObjectReferences(expr('count("guard0")')).map(ref => ref.id), ['guard0']);
});

test('instance hunt 31: an empty type cannot hide a misspelled local variable expression', () => {
  const project = fixture();
  assert.throws(() => validateExpression(expr('object("camera", "typo")'), expressionContext(project, {})), /variable/i);
});

test('instance hunt 32: property picks do not coerce text and booleans to numbers', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  assert.throws(() => compareInstanceProperty(project, null, entity, 'health', '=', '20'), /type|number/i);
  project.events = [rule('bad_pick', pick('health', '20'))];
  assert.throws(() => validateProject(project), /type|number/i);
});

test('instance hunt 33: boolean local-variable picks reject ordering comparisons', () => {
  const project = fixture();
  project.events = [rule('bad_boolean', {
    type: 'pickByVariable', objectType: 'enemy', variable: 'flag', operator: '>', value: false,
  })];
  assert.throws(() => validateProject(project), /boolean|comparison/i);
});

test('instance hunt 34: simple property reads do not rebuild all sector geometry', () => {
  const project = fixture(), entity = project.map.entities.find(entity => entity.id === 'guard0');
  let visits = 0;
  const vertices = project.map.vertices;
  Object.defineProperty(project.map, 'vertices', { get() { visits++; return vertices; } });
  for (let index = 0; index < 200; index++) read(project, null, entity, 'health');
  assert.equal(visits, 0, 'health has no dependency on map geometry');
});

test('instance hunt 35: removing picked objects invalidates targets in later actions of the same rule', () => {
  const project = fixture();
  project.events = [rule('remove_then_act', pick('x', 100), [
    { type: 'removePicked', objectType: 'enemy' },
    { type: 'setObjectVariable', entityId: 'guard0', variable: 'score', value: 99 },
  ])];
  let removed;
  play(project, state => { removed = guards(state)[0]; });
  assert.equal(removed.variables.score, 0, 'a removed object must not still receive actions');
});

test('owned descendants preserve an explicitly widened parent selection', () => {
  const project = fixture();
  project.events = [
    rule('parent', { type: 'pickAll', objectType: 'enemy' }, [], { ownerId: 'guard0' }),
    rule('child', { type: 'always' }, [write(3)], { parentId: 'parent', ownerId: 'guard0' }),
  ];
  assert.deepEqual(scores(play(project)), [3, 3, 3]);
});

test('OR global branches preserve inherited picks and failed branches contribute nothing', () => {
  const project = fixture();
  project.events = [
    rule('parent', pick('health', 15, '>=')),
    rule('child', pick('x', 300), [write(2)], {
      parentId: 'parent', conditions: [{ type: 'always' }], conditionMode: 'or',
    }),
    rule('next', pick('x', 300), [write(4)]),
  ];
  assert.deepEqual(scores(play(project)), [2, 2, 4]);
});

test('NOT variable filtering and grandchild selection remain within the parent scope', () => {
  const project = fixture();
  project.map.entities.find(entity => entity.id === 'guard0').variables.flag = true;
  project.events = [
    rule('parent', pick('health', 15, '>=')),
    rule('child', { type: 'pickByVariable', objectType: 'enemy', variable: 'flag', operator: '=', value: true, inverted: true },
      [], { parentId: 'parent' }),
    rule('grandchild', { type: 'always' }, [write(1)], { parentId: 'child' }),
    rule('sibling', { type: 'always' }, [{ type: 'addPickedVariable', objectType: 'enemy', variable: 'score', value: 2 }],
      { parentId: 'parent' }),
  ];
  assert.deepEqual(scores(play(project)), [2, 3, 0]);
});

test('all picked transforms evaluate against each target and preserve visual axis overrides', () => {
  const project = fixture();
  Object.assign(project.map.entities.find(entity => entity.id === 'guard0'), { spriteScaleX: 3, spriteScaleY: 4 });
  project.events = [rule('transforms', { type: 'always' }, [
    { type: 'movePicked', objectType: 'enemy', dx: expr('property("enemy", "health")'), dy: 0 },
    { type: 'setPickedAngle', objectType: 'enemy', angle: expr('property("enemy", "health")') },
    { type: 'scalePicked', objectType: 'enemy', scale: expr('property("enemy", "health") / 10') },
  ])];
  const state = play(project);
  assert.deepEqual(guards(state).map(entity => [entity.x, entity.angle, entity.spriteScale]),
    [[120, 20, 2], [215, 15, 1.5], [310, 10, 1]]);
  assert.equal(guards(state)[0].spriteScaleX, 2);
  assert.equal(guards(state)[0].spriteScaleY, 2);
  assert.equal(state.picks, undefined, 'selection must not escape event execution');
});

test('an expression context follows entity replacement and empty variable reads retain their scalar type', () => {
  const project = fixture();
  Object.assign(project.variables, { before: 0, after: 0, emptyScore: 0, emptyFlag: false });
  project.events = [rule('mutate', { type: 'onStart' }, [
    { type: 'setVariable', variable: 'before', value: expr('count("enemy")') },
    { type: 'removePicked', objectType: 'enemy' },
    { type: 'setVariable', variable: 'after', value: expr('count("enemy")') },
    { type: 'setVariable', variable: 'emptyScore', value: expr('object("enemy", "score")') },
    { type: 'setVariable', variable: 'emptyFlag', value: expr('object("enemy", "flag")') },
  ])];
  const state = play(project);
  assert.deepEqual([state.variables.before, state.variables.after, state.variables.emptyScore, state.variables.emptyFlag], [3, 0, 0, false]);
});

test('nearest references and count expressions survive replacement and participate in branch deletion', () => {
  const project = fixture();
  project.events = [
    rule('nearest', { type: 'pickNearest', objectType: 'enemy', to: 'guard0', order: 'nearest', count: 1 }),
    rule('child', { type: 'always' }, [write(expr('count("guard0")'))], { parentId: 'nearest' }),
  ];
  rewriteEntityReferences(project, new Map([['guard0', 'guard1']]));
  assert.equal(project.events[0].condition.to, 'guard1');
  assert.equal(project.events[1].actions[0].value.expr, 'count("guard1")');
  validateProject(project);
  stripEntityReferences(project, 'guard1');
  assert.deepEqual(project.events, [], 'deleting a reference gate must not leave unconditional children');
});

test('picked transforms, variables and spawned selections survive a saved-game round trip', () => {
  const project = fixture();
  project.events = [rule('create', { type: 'onStart' }, [
    { type: 'spawnEntity', templateId: 'guard0', x: 200, y: 100 },
    { type: 'scalePicked', objectType: 'enemy', scale: 2 }, write(12),
    { type: 'movePicked', objectType: 'enemy', dx: 8, dy: 0, dz: 16 },
  ])];
  const state = play(project);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'instances'))), 'instances').runtime;
  const spawned = restored.entities.find(entity => entity.spawnedFrom === 'guard0');
  assert.equal(spawned.spriteScale, 2);
  assert.equal(spawned.variables.score, 12);
  assert.equal(spawned.x, 208);
  assert.equal(spawned.z, 16);
  assert.equal(restored.picks, undefined);
  assert.deepEqual(scores(restored), scores(state));
});
