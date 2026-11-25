// The enemy and controller commands a hand-written monster needs.
//
// Doom's own behaviour is four generated rules per archetype. These are the rest: who a monster
// hunts, when it wakes, what it does when its step is blocked, and the pad itself — because a
// stick has travel and a button has a name, and neither is a key code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts } from '../shared/world-motion.js';
import { actorTarget } from '../shared/actor-runtime.js';
import { controllerSnapshot, readGamepads } from '../shared/gamepad.js';
import { createBoxBrush } from '../shared/brushes.js';

const tick = (project, state, keys = [], dt = .05) => stepRuntime(project, state, dt, new Set(keys), new Set());

/** One room, a player on the right and an imported monster on the left. */
function arena({ actor = {}, x = -100, extra = {} } = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-160, -96], [160, -96], [160, 96], [-160, 96]].map(([vx, vy], index) => ({ id: `v${index}`, x: vx, y: vy }));
  project.map.sectors = [{ id: 's0', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 }];
  const side = () => ({ sectorId: 's0', offsetX: 0, offsetY: 0 });
  project.map.walls = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b], index) => ({
    id: `w${index}`, a: `v${a}`, b: `v${b}`, right: side(), left: null,
    solid: true, height: 128, color: '#888888', special: 0, tag: 0,
  }));
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: 100, y: 0, angle: 180 },
    { id: 'guard', type: 'enemy', name: 'Guard', x, y: 0, angle: 0, health: 100, doomType: 3001,
      actorName: 'TestGuard', ...extra },
    ...(extra.others || []),
  ];
  // The actor shape the importer produces: frames plus the label table into them.
  const frames = [], labels = {};
  const push = (label, entries) => { labels[label] = frames.length; for (const entry of entries) frames.push({ ...entry, label }); };
  const frame = (letter, duration, actions = []) =>
    ({ kind: 'frame', sprite: 'GUAR', letter, duration, actions });
  const loop = target => ({ kind: 'loop', target });
  push('Spawn', [frame('A', 4), loop('Spawn')]);
  push('See', [frame('B', 4), frame('C', 4), loop('See')]);
  push('Missile', [frame('D', 4), { kind: 'goto', target: 'See' }]);
  push('Melee', [frame('E', 4), { kind: 'goto', target: 'See' }]);
  push('Pain', [frame('F', 2), { kind: 'goto', target: 'See' }]);
  push('Death', [frame('G', 4), { kind: 'stop' }]);
  project.actors = [{
    id: 'actor_guard', name: 'TestGuard', health: 100, radius: 20, height: 56, sprite: 'GUAR',
    flags: { MONSTER: true, ...actor },
    states: { frames, labels },
  }];
  project.variables = { watching: false };
  installEngineScripts(project, { includeHUD: false });
  // The generated rules decide for themselves; these tests are about one rule at a time.
  project.events = [];
  installWorldScripts(project, []);
  return project;
}

/** One rule about every enemy in the level, with the condition and actions under test. */
function rule(project, condition, actions, extra = {}) {
  project.events.push({
    id: 'test_rule', name: 'test rule', enabled: true, once: false,
    forEachType: 'enemy', condition, conditions: [], actions, ...extra,
  });
}

function runtimeOf(project) {
  const state = createRuntime(project);
  const guard = state.entities.find(entity => entity.id === 'guard');
  return { state, guard };
}

test('a monster can be told who to hunt, and the conditions read that answer', () => {
  const project = arena({ extra: { others: [
    { id: 'rival', type: 'enemy', name: 'Rival', x: -40, y: 0, angle: 0, health: 80, doomType: 3001, actorName: 'TestGuard' },
  ] } });
  const { state, guard } = runtimeOf(project);
  assert.equal(actorTarget(state, guard), state.player, 'the player by default');

  // The condition the rule branches on: which of the two it is after.
  rule(project, { type: 'enemyTargetsMonster', entityId: '$self' },
    [{ type: 'setVariable', variable: 'watching', value: true }]);
  tick(project, state);
  assert.equal(state.variables.watching, false, 'nothing yet — it is hunting the player');

  rule(project, { type: 'always' },
    [{ type: 'setEnemyTarget', entityId: 'guard', target: 'rival' }]);
  tick(project, state);
  assert.equal(guard.targetId, 'rival', 'the rule set the target');
  tick(project, state);
  assert.equal(state.variables.watching, true, 'and the condition now says so');
  assert.equal(actorTarget(state, guard).id, 'rival');

  // $none is how a rule gives up a hunt.
  project.events = [{ id: 'release', name: 'release', enabled: true, condition: { type: 'onStart' },
    conditions: [], actions: [{ type: 'setEnemyTarget', entityId: 'guard', target: '$none' }] }];
  const second = createRuntime(project);
  const fresh = second.entities.find(entity => entity.id === 'guard');
  fresh.targetId = 'rival';
  tick(project, second);
  assert.equal(fresh.targetId, undefined, 'the target was cleared');
});

test('a monster told to hunt something that is gone says so instead of pretending', () => {
  const project = arena();
  project.events = [{ id: 'bad', name: 'bad rule', enabled: true, once: false,
    condition: { type: 'onStart' }, conditions: [],
    actions: [{ type: 'setEnemyTarget', entityId: 'guard', target: 'missing_object' }] }];
  // The reference is checked when the rule is written, not when a player is being shot at.
  assert.throws(() => validateProject(project), /unknown object|Object|entity/i);
  // And a name that was valid at authoring time but is gone at run time is reported by the rule.
  const live = arena();
  const { state } = runtimeOf(live);
  live.events = [{ id: 'gone', name: 'gone rule', enabled: true, once: false,
    condition: { type: 'onStart' }, conditions: [],
    actions: [{ type: 'setEnemyTarget', entityId: 'guard', target: '$player' }] }];
  live.events[0].actions[0].target = 'ghost';
  live.events[0].actions[0].entityId = 'guard';
  assert.throws(() => stepRuntime(live, state, .05, new Set(), new Set()), /no living object/);
});

test('waking, sleeping and stopping a monster', () => {
  const project = arena();
  const { state, guard } = runtimeOf(project);
  project.events = [{ id: 'wake', name: 'wake', enabled: true, once: true, condition: { type: 'onStart' },
    conditions: [], actions: [{ type: 'wakeEnemy', entityId: 'guard', seconds: 5 }] }];
  tick(project, state);
  assert.ok(state.timers.get('guard:alert') > state.time, 'the alert clock is running');

  project.events = [{ id: 'sleep', name: 'sleep', enabled: true, condition: { type: 'everySeconds', seconds: .01 },
    conditions: [], actions: [{ type: 'sleepEnemy', entityId: 'guard' }] }];
  tick(project, state);
  assert.equal(state.timers.has('guard:alert'), false, 'and it was cleared again');
  assert.equal(state.enemyMoves.has(guard.id), false);
});

test('a boxed-in monster and a blocked path are two different facts', () => {
  // A cell of four brushes: every direction is refused, which is the "stuck" answer.
  const project = arena({ x: 0 });
  // A 40-unit cell: a step plus the monster's own look-ahead reaches the walls in every direction.
  createBoxBrush(project, { x: -32, y: -32, z: 0, width: 16, depth: 64, height: 128 });
  createBoxBrush(project, { x: 16, y: -32, z: 0, width: 16, depth: 64, height: 128 });
  createBoxBrush(project, { x: -32, y: 16, z: 0, width: 64, depth: 16, height: 128 });
  createBoxBrush(project, { x: -32, y: -32, z: 0, width: 64, depth: 16, height: 128 });
  const { state, guard } = runtimeOf(project);
  project.events = [{ id: 'walk', name: 'walk', enabled: true, once: false,
    condition: { type: 'everySeconds', seconds: .01 }, conditions: [],
    actions: [{ type: 'moveEnemy', entityId: 'guard', speed: 200 }] }];
  assert.equal(state.enemyBlocked.has(guard.id), false, 'it starts free to move');
  for (let frame = 0; frame < 10; frame++) tick(project, state);
  assert.equal(state.enemyBlocked.has(guard.id), true, 'and then has nowhere to go');
  rule(project, { type: 'enemyBlocked', entityId: '$self' },
    [{ type: 'setVariable', variable: 'watching', value: true }]);
  tick(project, state);
  assert.equal(state.variables.watching, true, 'the condition reports it');
});

test('a removed monster leaves nothing behind in the blocked set', () => {
  // The set is keyed by entity id and was never cleared, so a level that spawns and removes monsters
  // grew it by one id per monster for the whole session — and a recycled id read as boxed in.
  const project = arena({ x: 0 });
  createBoxBrush(project, { x: -32, y: -32, z: 0, width: 16, depth: 64, height: 128 });
  createBoxBrush(project, { x: 16, y: -32, z: 0, width: 16, depth: 64, height: 128 });
  createBoxBrush(project, { x: -32, y: 16, z: 0, width: 64, depth: 16, height: 128 });
  createBoxBrush(project, { x: -32, y: -32, z: 0, width: 64, depth: 16, height: 128 });
  const { state, guard } = runtimeOf(project);
  project.events = [{ id: 'walk', name: 'walk', enabled: true, once: false,
    condition: { type: 'everySeconds', seconds: .01 }, conditions: [],
    actions: [{ type: 'moveEnemy', entityId: 'guard', speed: 200 }] }];
  for (let frame = 0; frame < 10; frame++) tick(project, state);
  assert.equal(state.enemyBlocked.has(guard.id), true, 'boxed in');
  project.events = [{ id: 'gone', name: 'gone', enabled: true, once: true,
    condition: { type: 'everySeconds', seconds: .01 }, conditions: [],
    actions: [{ type: 'removeEntity', entityId: 'guard' }] }];
  tick(project, state);
  assert.equal(state.entities.some(entity => entity.id === guard.id), false, 'the monster is gone');
  assert.equal(state.enemyBlocked.has(guard.id), false, 'and so is its entry');
});

test('a wall between a monster and the player is its own condition', () => {
  const open = arena({ x: -100 });
  const free = runtimeOf(open);
  rule(open, { type: 'enemyPathBlocked', entityId: '$self' },
    [{ type: 'setVariable', variable: 'watching', value: true }]);
  tick(open, free.state);
  assert.equal(free.state.variables.watching, false, 'nothing between them');

  const walled = arena({ x: -100 });
  createBoxBrush(walled, { x: -60, y: -96, z: 0, width: 16, depth: 192, height: 128 });
  const { state } = runtimeOf(walled);
  rule(walled, { type: 'enemyPathBlocked', entityId: '$self' },
    [{ type: 'setVariable', variable: 'watching', value: true }]);
  tick(walled, state);
  assert.equal(state.variables.watching, true, 'the brush is in the way');
});

test('health percentage, actor flags and flying ask about the monster itself', () => {
  const project = arena({ actor: { AMBUSH: true, FLOAT: true } });
  project.variables = { weak: false, ambush: false, flying: false };
  const { state, guard } = runtimeOf(project);
  guard.health = 40;
  rule(project, { type: 'enemyHealthPercent', entityId: '$self', operator: '<', percent: 50 },
    [{ type: 'setVariable', variable: 'weak', value: true }]);
  rule(project, { type: 'enemyFlag', entityId: '$self', flag: 'AMBUSH' },
    [{ type: 'setVariable', variable: 'ambush', value: true }]);
  rule(project, { type: 'enemyFlying', entityId: '$self' },
    [{ type: 'setVariable', variable: 'flying', value: true }]);
  tick(project, state);
  assert.equal(state.variables.weak, true, '40 of 100 is below half');
  assert.equal(state.variables.ambush, true, 'the actor declares AMBUSH');
  assert.equal(state.variables.flying, true, 'and FLOAT, which the engine reads as flying');
});

test('a monster with full health is not below the line', () => {
  const project = arena();
  const { state } = runtimeOf(project);
  rule(project, { type: 'enemyHealthPercent', entityId: '$self', operator: '<', percent: 50 },
    [{ type: 'setVariable', variable: 'watching', value: true }]);
  tick(project, state);
  assert.equal(state.variables.watching, false);
});

test('an attack can be started on cue and a pain state forced', () => {
  const project = arena();
  const { state, guard } = runtimeOf(project);
  project.events = [{ id: 'attack', name: 'attack', enabled: true, once: true, condition: { type: 'onStart' },
    conditions: [], actions: [{ type: 'startEnemyAttack', entityId: 'guard', state: 'auto' }] }];
  tick(project, state);
  assert.equal(guard.stateLabel, 'Missile', 'it entered the attack state its actor has');

  project.events = [{ id: 'pain', name: 'pain', enabled: true, condition: { type: 'everySeconds', seconds: .01 },
    conditions: [], actions: [{ type: 'enemyPain', entityId: 'guard' }] }];
  // `setActorState` with ifDifferent:false restarts Pain; a busy actor keeps its own frame.
  guard.stateLabel = 'See';
  guard.actorState = undefined;
  tick(project, state);
  assert.equal(guard.stateLabel, 'Pain');
});

test('a monster can be walked to a named object and backed away from its target', () => {
  const project = arena({ x: -100, extra: { others: [
    { id: 'marker', type: 'decoration', name: 'Marker', x: 0, y: 60, angle: 0 },
  ] } });
  const { state, guard } = runtimeOf(project);
  project.events = [{ id: 'walk', name: 'walk', enabled: true, condition: { type: 'everySeconds', seconds: .01 },
    conditions: [], actions: [{ type: 'moveEnemyToward', entityId: 'guard', target: 'marker', speed: 120 }] }];
  const before = { x: guard.x, y: guard.y };
  for (let frame = 0; frame < 6; frame++) tick(project, state);
  assert.ok(Math.hypot(guard.x - 0, guard.y - 60) < Math.hypot(before.x, before.y - 60), 'it walked toward the marker');

  project.events = [{ id: 'retreat', name: 'retreat', enabled: true, condition: { type: 'everySeconds', seconds: .01 },
    conditions: [], actions: [{ type: 'moveEnemyAway', entityId: 'guard', speed: 120 }] }];
  const distanceTo = () => Math.hypot(state.player.x - guard.x, state.player.y - guard.y);
  const beforeBacking = distanceTo();
  for (let frame = 0; frame < 6; frame++) tick(project, state);
  assert.ok(distanceTo() >= beforeBacking - 1, 'it did not walk into the player while backing away');
});

test('the controller conditions read the pad the host stored', () => {
  const project = arena();
  const { state } = runtimeOf(project);
  // What the page writes each frame: `readGamepads` → `controllerSnapshot`.
  const pad = { index: 0, id: 'Xbox Wireless Controller', mapping: 'standard', connected: true,
    buttons: Array.from({ length: 17 }, (unused, index) => ({ pressed: index === 0 || index === 5, value: index === 0 || index === 5 ? 1 : 0 })),
    axes: [.1, -.9, .8, .2] };
  const result = readGamepads([pad], { gamepadDeadzone: .2 }, {});
  state.pad = controllerSnapshot(result);
  assert.equal(state.pad.connected, 1);
  assert.equal(state.pad.kind, 'xbox');
  assert.ok(state.pad.buttons.has('cross'), 'Cross is held');
  assert.ok(state.pad.pressed.has('cross'), 'and this frame it was pressed');
  assert.ok(state.pad.buttons.has('r1'));
  assert.equal(state.pad.axes.leftY, -.9);

  project.variables.watching = false;
  project.events = [
    { id: 'connected', name: 'connected', enabled: true, condition: { type: 'padConnected', kind: 'xbox' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
  ];
  tick(project, state);
  assert.equal(state.variables.watching, true, 'a pad of that family is connected');

  project.events = [
    { id: 'held', name: 'held', enabled: true, condition: { type: 'padButtonHeld', button: 'cross' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
    { id: 'notheld', name: 'not held', enabled: true, condition: { type: 'padButtonHeld', button: 'l1' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: false }] },
  ];
  tick(project, state);
  assert.equal(state.variables.watching, true, 'Cross is held, L1 is not');

  project.events = [
    { id: 'axis', name: 'axis', enabled: true, condition: { type: 'padAxis', axis: 'rightX', operator: '>', value: .5 },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: false }] },
  ];
  tick(project, state);
  assert.equal(state.variables.watching, false, 'the right stick is pushed right');

  project.events = [
    { id: 'stick', name: 'stick', enabled: true, condition: { type: 'padStick', stick: 'left', direction: 'up' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
  ];
  tick(project, state);
  assert.equal(state.variables.watching, true, 'and the left stick is pushed up');
});

test('distance to its target, sight of its target, and facing it', () => {
  const project = arena({ x: -100 });
  project.variables = { far: false, seen: false };
  const { state, guard } = runtimeOf(project);
  rule(project, { type: 'enemyTargetDistance', entityId: '$self', operator: '<', distance: 300 },
    [{ type: 'setVariable', variable: 'far', value: true }]);
  rule(project, { type: 'enemySeesTarget', entityId: '$self' },
    [{ type: 'setVariable', variable: 'seen', value: true }]);
  tick(project, state);
  assert.equal(state.variables.far, true, '200 units away is inside 300');
  assert.equal(state.variables.seen, true, 'and nothing is in the way');

  // A brush between them hides the target from the trace, but not from the distance.
  createBoxBrush(project, { x: -60, y: -96, z: 0, width: 16, depth: 192, height: 128 });
  const walled = createRuntime(project);
  tick(project, walled);
  assert.equal(walled.variables.far, true);
  assert.equal(walled.variables.seen, false, 'the brush is in the way');

  // Facing: the monster turns to whatever it hunts, not only to the player.
  Object.assign(project.map.entities.find(entity => entity.id === 'player'), { x: 100, y: 100 });
  project.events = [{ id: 'face', name: 'face', enabled: true, once: true, condition: { type: 'onStart' },
    conditions: [], actions: [{ type: 'faceEnemyTarget', entityId: 'guard' }] }];
  const facing = createRuntime(project);
  tick(project, facing);
  const turned = facing.entities.find(entity => entity.id === 'guard');
  assert.ok(Math.abs(turned.angle - 26.5) < 1 || Math.abs(((turned.angle % 360) + 360) % 360 - 26.5) < 1,
    `it turned toward the player (${turned.angle})`);
});

test('a controller that is not there answers none of its conditions', () => {
  const project = arena();
  const { state } = runtimeOf(project);
  assert.equal(state.pad.connected, 0, 'nothing is plugged in until the host says so');
  project.events = [
    { id: 'connected', name: 'connected', enabled: true, condition: { type: 'padConnected', kind: 'any' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
    { id: 'held', name: 'held', enabled: true, condition: { type: 'padButtonHeld', button: 'cross' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
    { id: 'stick', name: 'stick', enabled: true, condition: { type: 'padStick', stick: 'right', direction: 'any' },
      conditions: [], actions: [{ type: 'setVariable', variable: 'watching', value: true }] },
  ];
  tick(project, state);
  assert.equal(state.variables.watching, false);
});

test('stopping a rumble is a request the host plays, like the rumble itself', () => {
  const project = arena();
  const { state } = runtimeOf(project);
  project.events = [{ id: 'stop', name: 'stop', enabled: true, once: true, condition: { type: 'onStart' },
    conditions: [], actions: [{ type: 'stopControllerRumble' }] }];
  tick(project, state);
  assert.deepEqual(state.rumbles, [{ stop: true }]);
});
