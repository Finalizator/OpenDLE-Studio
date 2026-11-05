/**
 * Object instances: picking, per-instance iteration and reading any property.
 *
 * The model both GDevelop and Construct use, tested through the real runtime: a rule's conditions
 * *pick* a set of instances, everything in the rule then applies to that set, and sub-events
 * inherit it. The point of the tests is that a rule reads like the sentence a creator wrote, so
 * each one is played rather than inspected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime, pickedInstances } from '../shared/runtime.js';
import {
  INSTANCE_PROPERTIES, INSTANCE_PROPERTY_NAMES, INSTANCE_PICKABLE_TYPES, compareInstanceProperty,
  instanceProperty, readInstanceProperty,
} from '../shared/instance-properties.js';

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, actions, ...extra });

/** A level with `count` enemies at x = 0, 100, 200 …, each carrying `variables`. */
function level({ enemies = 3, variables = { score: 0, alive: true } } = {}) {
  const project = createProject();
  project.events = [];
  for (let index = 0; index < enemies; index++) {
    project.map.entities.push({ id: `enemy_${index}`, name: `Enemy ${index}`, type: 'enemy',
      x: index * 100, y: 0, angle: 0, health: 20, elevation: 0,
      variables: structuredClone(variables) });
  }
  return project;
}

/** Install sprite states on an authored instance, with the frames a clip needs to exist legally. */
function clips(project, ...names) {
  project.assets ||= [];
  const image = id => project.assets.find(asset => asset.id === id)
    || project.assets[project.assets.push({ id, name: id, kind: 'sprite', width: 1, height: 1,
      src: 'data:image/png;base64,AAAA' }) - 1];
  project.spriteClips = names.map(name => ({ id: `clip_${name}`, name, seconds: .1, loop: true,
    frames: [image(`image_${name}`).id] }));
  return Object.fromEntries(names.map(name => [name, `clip_${name}`]));
}

function play(project, frames = 1, keys = new Set()) {
  const state = createRuntime(project);
  for (let index = 0; index < frames; index++) stepRuntime(project, state, 1 / 60, keys);
  return state;
}

const enemy = (state, index) => state.entities.find(entity => entity.id === `enemy_${index}`);
/** The authored enemy with this index. `map.entities` starts with the player and the pickup. */
const authored = (project, index) => project.map.entities.find(entity => entity.id === `enemy_${index}`);
const scores = state => state.entities.filter(entity => entity.type === 'enemy').map(entity => entity.variables.score);

test('every instance property a rule can read is declared once, for the editor and the reader', () => {
  // A property cannot exist in the picker and be unknown to the reader, or the other way round.
  for (const property of INSTANCE_PROPERTIES) {
    assert.equal(instanceProperty(property.name)?.name, property.name);
    assert.ok(['number', 'text'].includes(property.kind), `${property.name} has a kind`);
  }
  for (const needed of ['x', 'y', 'z', 'angle', 'elevation', 'animation', 'health', 'alive', 'speed', 'scale', 'name', 'type']) {
    assert.ok(INSTANCE_PROPERTY_NAMES.includes(needed), `${needed} is readable`);
  }
  assert.ok(INSTANCE_PICKABLE_TYPES.includes('enemy'));
  assert.equal(INSTANCE_PICKABLE_TYPES.includes('player'), false, 'the player is not a type a pick names');
});

test('a property reads the live instance, including its animation state', () => {
  const project = level();
  project.map.entities[0].spriteStates = clips(project, 'stand', 'walk');
  const state = createRuntime(project);
  state.spriteAnimations.set('enemy_0', { clipId: 'clip_walk', name: 'walk', start: 0 });
  state.time = .25;
  const target = enemy(state, 0);
  assert.equal(readInstanceProperty(project, state, target, 'animation'), 'walk');
  assert.equal(readInstanceProperty(project, state, target, 'animationClip'), 'clip_walk');
  assert.equal(readInstanceProperty(project, state, target, 'animationFrame'), 0, 'a one-frame clip always displays frame zero');
  assert.equal(readInstanceProperty(project, state, target, 'animationTime'), .25);
  assert.equal(readInstanceProperty(project, state, target, 'x'), 0);
  assert.equal(readInstanceProperty(project, state, enemy(state, 2), 'x'), 200);
});

test('a comparison reads a property the same way a variable does, in compare and set', () => {
  const project = level({ enemies: 2 });
  authored(project, 0).health = 3;
  project.events = [
    // "If enemy_0's health is below 5, remember it" — a property inside a normal comparison.
    rule('probe', { type: 'expressionCompare', left: { expr: 'property("enemy_0", "health")' }, operator: '<', right: 5 },
      [{ type: 'setVariable', variable: 'score', value: { expr: 'property("enemy_0", "x") + property("enemy_1", "health")' } }]),
  ];
  validateProject(project);
  const state = play(project);
  assert.equal(state.variables.score, 20, 'the comparison passed and the assignment read two properties');
});

test('a pick narrows what the event acts on, and a sub-event inherits it', () => {
  const project = level({ enemies: 3 });
  authored(project, 1).health = 4;
  project.events = [
    rule('hurt', { type: 'pickByProperty', objectType: 'enemy', property: 'health', operator: '<', value: 5 }, [], {}),
  ];
  project.events.push({ id: 'hurt_child', parentId: 'hurt', enabled: true, once: false,
    condition: { type: 'always' }, actions: [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 99 }] });
  validateProject(project);
  const state = play(project);
  assert.deepEqual(scores(state), [0, 99, 0], 'only the enemy that was picked changed');
});

test('acting on a picked type reaches every picked instance without a loop', () => {
  const project = level({ enemies: 4 });
  project.events = [rule('all', { type: 'pickAll', objectType: 'enemy' },
    [{ type: 'addPickedVariable', objectType: 'enemy', variable: 'score', value: 2 }])];
  validateProject(project);
  const state = play(project, 3);
  assert.deepEqual(scores(state), [6, 6, 6, 6], 'three frames, two each, on all four');
});

test('a pick that selects nothing stops the rule instead of falling back to everything', () => {
  // The failure this guards against is the one that matters most: a rule that says "the enemies
  // below 5 health" must not act on all of them when none are below 5.
  const project = level({ enemies: 3 });
  project.events = [rule('none', { type: 'pickByProperty', objectType: 'enemy', property: 'health', operator: '<', value: 1 },
    [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 7 }])];
  validateProject(project);
  const state = play(project);
  assert.deepEqual(scores(state), [0, 0, 0]);
});

test('the nearest and the furthest instances are picked by distance from the player', () => {
  const project = level({ enemies: 3 });
  const player = project.map.entities.find(entity => entity.type === 'player');
  // Place the enemies on either side of the player so distance orders them by number, not by index.
  for (const [index, offset] of [[0, -500], [1, -50], [2, 300]]) {
    const entity = project.map.entities.find(candidate => candidate.id === `enemy_${index}`);
    entity.x = player.x + offset; entity.y = player.y;
  }
  project.events = [rule('closest', { type: 'pickNearest', objectType: 'enemy', to: '$player', order: 'nearest', count: 1 },
    [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 1 }])];
  validateProject(project);
  const state = play(project);
  assert.equal(enemy(state, 1).variables.score, 1, 'the enemy 50 units away was the nearest');
  assert.deepEqual([enemy(state, 0).variables.score, enemy(state, 2).variables.score], [0, 0]);

  const far = level({ enemies: 3 });
  const farPlayer = far.map.entities.find(entity => entity.type === 'player');
  for (const [index, offset] of [[0, -500], [1, -50], [2, 300]]) {
    const entity = far.map.entities.find(candidate => candidate.id === `enemy_${index}`);
    entity.x = farPlayer.x + offset; entity.y = farPlayer.y;
  }
  far.events = [rule('farthest', { type: 'pickNearest', objectType: 'enemy', to: '$player', order: 'furthest', count: 1 },
    [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 2 }])];
  validateProject(far);
  const farState = play(far);
  assert.equal(enemy(farState, 0).variables.score, 2, 'the far one was picked instead');
});

test('a random pick takes distinct instances, never the same one twice', () => {
  const project = level({ enemies: 4 });
  project.events = [rule('two', { type: 'pickRandom', objectType: 'enemy', count: 2 },
    [{ type: 'addPickedVariable', objectType: 'enemy', variable: 'score', value: 1 }])];
  validateProject(project);
  const state = play(project);
  assert.equal(scores(state).filter(score => score === 1).length, 2, 'exactly two enemies were picked');
});

test('picking by a local variable, and counting what is picked', () => {
  const project = level({ enemies: 3 });
  enemy0Variables(project, 0).flag = true;
  enemy0Variables(project, 2).flag = true;
  project.events = [rule('flagged', { type: 'pickByVariable', objectType: 'enemy', variable: 'flag', operator: '=', value: true },
    [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 5 }])];
  validateProject(project);
  const state = play(project);
  assert.deepEqual(scores(state), [5, 0, 5], 'only the two flagged enemies were written to');
});
const enemy0Variables = (project, index) => authored(project, index).variables;

test('pickedCount is a condition a rule can branch on', () => {
  for (const [remaining, expected] of [[3, 1], [0, 0]]) {
    const project = level({ enemies: remaining });
    project.events = [rule('count', { type: 'pickedCount', objectType: 'enemy', operator: '>', value: 0 },
      [{ type: 'setVariable', variable: 'score', value: 1 }])];
    validateProject(project);
    assert.equal(play(project).variables.score, expected, `${remaining} enemies left`);
  }
});

test('a for-each rule iterates what was picked, not every instance of the type', () => {
  const project = level({ enemies: 4 });
  for (const index of [0, 3]) enemy0Variables(project, index).alive = false;
  project.events = [
    rule('remember', { type: 'pickByVariable', objectType: 'enemy', variable: 'alive', operator: '=', value: false }, []),
  ];
  project.events.push({ id: 'each', parentId: 'remember', enabled: true, once: false, forEachType: 'enemy',
    condition: { type: 'always' },
    actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'score', value: 1 }] });
  validateProject(project);
  const state = play(project);
  assert.deepEqual(scores(state), [1, 0, 0, 1], 'only the two dead ones were iterated');
});

test('an instance action reaches position, angle, scale, sprite state and removal', () => {
  const project = level({ enemies: 3 });
  authored(project, 0).spriteStates = clips(project, 'stand', 'walk');
  project.events = [
    rule('shape', { type: 'pickByProperty', objectType: 'enemy', property: 'x', operator: '=', value: 0 }, [
      { type: 'setPickedPosition', objectType: 'enemy', x: 640, y: 480, z: 64 },
      { type: 'setPickedAngle', objectType: 'enemy', angle: 90 },
      { type: 'scalePicked', objectType: 'enemy', scale: 2 },
      { type: 'setPickedSpriteState', objectType: 'enemy', state: 'walk', restart: 'yes' },
    ]),
    rule('move', { type: 'pickByProperty', objectType: 'enemy', property: 'x', operator: '=', value: 100 },
      [{ type: 'movePicked', objectType: 'enemy', dx: 8, dy: -8 }]),
    rule('kill', { type: 'pickByProperty', objectType: 'enemy', property: 'x', operator: '=', value: 200 },
      [{ type: 'removePicked', objectType: 'enemy' }]),
  ];
  validateProject(project);
  const state = play(project);
  const shaped = enemy(state, 0);
  assert.deepEqual([shaped.x, shaped.y, shaped.z], [640, 480, 64], 'the picked one was placed in three axes');
  assert.equal(shaped.angle, 90);
  assert.equal(shaped.spriteScale, 2);
  assert.equal(readInstanceProperty(project, state, shaped, 'animation'), 'walk', 'and its sprite state was set');
  assert.equal(enemy(state, 1).x, 108, 'the other picked one moved');
  assert.equal(enemy(state, 1).y, -8);
  assert.equal(state.entities.some(entity => entity.id === 'enemy_2'), false, 'the third one was removed');
  assert.equal(state.spriteAnimations.get('enemy_1'), undefined, 'it has no sprite states, so nothing played for it');
});

test('an expression names the object type and reads what the rule picked', () => {
  const project = level({ enemies: 3 });
  authored(project, 1).health = 7;
  project.variables.health = 0; project.variables.howMany = 0;
  project.events = [rule('weakest', { type: 'pickByProperty', objectType: 'enemy', property: 'health', operator: '=', value: 7 }, [
    { type: 'setVariable', variable: 'health', value: { expr: 'property("enemy","health")' } },
    { type: 'setVariable', variable: 'howMany', value: { expr: 'count("enemy")' } },
  ])];
  validateProject(project);
  const state = play(project);
  assert.equal(state.variables.health, 7, 'the property came from the picked instance');
  assert.equal(state.variables.howMany, 1, 'and the count followed the pick');
});

test('an expression outside a rule means every instance, so a type name is still an answer', () => {
  const project = level({ enemies: 2 });
  project.variables.howMany = 0;
  project.events = [rule('count', { type: 'always' },
    [{ type: 'setVariable', variable: 'howMany', value: { expr: 'count("enemy")' } }])];
  validateProject(project);
  assert.equal(play(project).variables.howMany, 2);
  assert.throws(() => validateProject({
    ...project,
    events: [rule('bad', { type: 'always' }, [{ type: 'setVariable', variable: 'howMany', value: { expr: 'count("owlbear")' } }])],
  }), /unknown object\/context/);
});

test('a spawned instance is the one the next action picks, as in GDevelop', () => {
  const project = level({ enemies: 1 });
  project.events = [rule('birth', { type: 'onStart' }, [
    { type: 'spawnEntity', templateId: 'enemy_0', x: 500, y: 500 },
    { type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 42 },
  ])];
  validateProject(project);
  const state = play(project);
  const spawned = state.entities.filter(entity => entity.type === 'enemy').find(entity => entity.id !== 'enemy_0');
  assert.ok(spawned, 'the enemy was spawned');
  assert.equal(spawned.variables.score, 42, 'and it is what the action wrote to');
});

test('a property of a missing variable or an unknown name is refused, not answered as zero', () => {
  const project = level({ enemies: 1 });
  const state = createRuntime(project);
  const target = enemy(state, 0);
  assert.throws(() => readInstanceProperty(project, state, target, 'hight'), /Unknown object property/);
  assert.throws(() => compareInstanceProperty(project, state, target, 'health', '>', 'lots'), /must be a number/);
  // An event that picks by a variable the type does not carry says so at run time, with the rule.
  project.events = [rule('bad', { type: 'pickByVariable', objectType: 'enemy', variable: 'nope', operator: '=', value: 1 },
    [{ type: 'showMessage', message: 'x' }])];
  project.events[0].id = 'bad';
  // Validation catches it before play when the type carries nothing at all.
  assert.throws(() => validateProject(project), /enemy has no local variable named nope/);
});

test('a for-each type can be any object a level holds, not a fixed list', () => {
  const project = level({ enemies: 1 });
  project.map.entities.push({ id: 'lamp', name: 'Lamp', type: 'light', x: 10, y: 10, angle: 0,
    light: { color: '#ffffff', intensity: 1, radius: 64 }, variables: {} });
  project.events = [{ id: 'lamps', enabled: true, once: false, forEachType: 'light',
    condition: { type: 'always' }, actions: [{ type: 'setObjectVariable', entityId: '$self', variable: 'value', value: 1 }] }];
  project.map.entities.find(entity => entity.id === 'lamp').variables = { value: 0 };
  validateProject(project);
  const state = play(project);
  assert.equal(state.entities.find(entity => entity.id === 'lamp').variables.value, 1);
});

test('pickedInstances answers every instance when nothing narrowed, and nothing when it emptied', () => {
  const project = level({ enemies: 2 });
  const state = createRuntime(project);
  assert.equal(pickedInstances(state, new Map(), 'enemy').length, 2);
  assert.equal(pickedInstances(state, new Map([['enemy', new Set()]]), 'enemy').length, 0,
    'an empty pick is empty, not "all of them"');
  assert.equal(pickedInstances(state, new Map([['enemy', new Set(['enemy_1'])]]), 'enemy').length, 1);
});
