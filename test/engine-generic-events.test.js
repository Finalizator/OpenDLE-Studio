import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { ACTIONS, CONDITIONS, createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { installWallWalkDemo } from '../scriptlets/wall-walking.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { buildVanillaActors } from '../shared/actors.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/**
 * A project made from nothing: no WAD, no campaign, no imported assets. Every rule
 * below is authored by a creator in the editor, so it must work here exactly as it
 * does in an imported game.
 */
function bareRoom() {
  const project = createProject();
  project.events = [];
  project.variables = { ticks: 0, rolls: 0, entered: 0, inside: 0 };
  project.map.vertices = [['a', -256, -256], ['b', 256, -256], ['c', 256, 256], ['d', -256, 256]]
    .map(([id, x, y]) => ({ id, x, y }));
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 128, color: '#888888', solid: true, right: { sectorId: 'room', offsetX: 0, offsetY: 0 },
  }));
  project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false }];
  project.map.entities = [
    { ...project.map.entities.find(entity => entity.type === 'player'), x: -100, y: 0, angle: 0 },
    { id: 'crate', type: 'decoration', name: 'Crate', x: 100, y: 0, elevation: 0, angle: 0,
      area: { shape: 'box', width: 96, height: 96, depth: 96, radius: 48 } },
  ];
  return project;
}

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, conditions: [], actions, ...extra });
const tick = (project, state, frames, keys = new Set(), pressed = new Set()) => {
  for (let index = 0; index < frames; index++) stepRuntime(project, state, 1 / 60, keys, index === 0 ? pressed : new Set());
};
const withPhysics = (project, t) => {
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  return state;
};

test('area-entry conditions are independent per for-each object and per condition slot', () => {
  const project = bareRoom();
  project.map.entities[1].x = -100;
  project.map.entities.push({ ...structuredClone(project.map.entities[1]), id: 'crate2' });
  project.events = [
    rule('each_entry', { type: 'playerEnteredArea', entityId: '$self' },
      [{ type: 'addVariable', variable: 'entered', value: 1 }], { forEachType: 'decoration' }),
    rule('both_entries', { type: 'playerEnteredArea', entityId: 'crate' },
      [{ type: 'addVariable', variable: 'inside', value: 1 }],
      { conditions: [{ type: 'playerEnteredArea', entityId: 'crate2' }] }),
  ];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 2);
  assert.equal(state.variables.entered, 2);
  assert.equal(state.variables.inside, 1);
  state.player.x = 200;
  tick(project, state, 1);
  state.player.x = -100;
  tick(project, state, 1);
  assert.equal(state.variables.entered, 4, 'both instances can re-enter');
});

test('two health-decreased conditions on the same target do not consume each other', () => {
  const project = bareRoom();
  project.map.entities[1].health = 100;
  project.events = [rule('damage', { type: 'entityDamaged', entityId: 'crate' },
    [{ type: 'addVariable', variable: 'ticks', value: 1 }],
    { conditions: [{ type: 'entityDamaged', entityId: 'crate' }] })];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 1);
  state.entities.find(entity => entity.id === 'crate').health -= 10;
  tick(project, state, 1);
  assert.equal(state.variables.ticks, 1);
});

test('AND and OR short-circuits do not defer entry observations or consume stale damage', () => {
  for (const mode of ['and', 'or']) {
    const project = bareRoom();
    project.map.entities[1].health = 100;
    project.variables.gate = mode === 'or' ? 1 : 0;
    project.events = [rule('gated', { type: 'variableCompare', variable: 'gate', operator: '=', value: 1 },
      [{ type: 'addVariable', variable: 'entered', value: 1 }], {
        conditionMode: mode,
        conditions: [{ type: 'playerEnteredArea', entityId: 'crate' }, { type: 'entityDamaged', entityId: 'crate' }],
      })];
    const state = createRuntime(project);
    tick(project, state, 1);
    state.player.x = 100;
    state.entities.find(entity => entity.id === 'crate').health -= 10;
    tick(project, state, 1);
    const count = state.variables.entered;
    state.variables.gate = mode === 'or' ? 0 : 1;
    tick(project, state, 1);
    assert.equal(state.variables.entered, count, `${mode} does not replay a trigger when a gate changes`);
  }
});

test('removing a for-each object releases its entry samples and periodic clock', () => {
  const project = bareRoom();
  project.map.entities[1].x = -100;
  project.events = [
    rule('clock', { type: 'everySeconds', seconds: 10 }, [], { forEachType: 'decoration' }),
    rule('entry', { type: 'playerEnteredArea', entityId: '$self' }, [], { forEachType: 'decoration' }),
    rule('remove', { type: 'keyPressed', key: 'KeyE' }, [{ type: 'removeEntity', entityId: 'crate' }]),
  ];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 1);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.areaEntries.size, 1);
  stepRuntime(project, state, .016, new Set(['KeyE']), new Set(['KeyE']));
  assert.equal(state.intervals.size, 0);
  assert.equal(state.areaEntries.size, 0);
});

test('loading a game inside an area does not replay its entry trigger', () => {
  const project = bareRoom();
  project.map.entities[1].x = -100;
  project.events = [rule('entry', { type: 'playerEnteredArea', entityId: 'crate' },
    [{ type: 'addVariable', variable: 'entered', value: 1 }])];
  const state = createRuntime(project);
  tick(project, state, 1);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'area'))), 'area').runtime;
  tick(project, restored, 1);
  assert.equal(restored.variables.entered, 1);
  restored.player.x = 200; tick(project, restored, 1);
  restored.player.x = -100; tick(project, restored, 1);
  assert.equal(restored.variables.entered, 2);
});

test('distance comparisons involving the player read its live position after a teleport', () => {
  for (const swap of [false, true]) {
    const project = bareRoom(), playerId = project.map.entities[0].id;
    project.events = [
      rule('move', { type: 'onStart' }, [{ type: 'teleport', x: 100, y: 0 }]),
      rule('distance', { type: 'distanceBetween', entityId: swap ? playerId : 'crate',
        otherId: swap ? 'crate' : '$player', operator: '<=', distance: 1 },
      [{ type: 'addVariable', variable: 'ticks', value: 1 }]),
    ];
    validateProject(project);
    const state = createRuntime(project);
    tick(project, state, 1);
    assert.equal(state.variables.ticks, 1, `player is ${swap ? 'first' : 'second'} operand`);
  }
});

test('moving an interaction area vertically changes its live overlap', () => {
  const project = bareRoom();
  project.map.entities[1].x = -100;
  project.events = [
    rule('lift_area', { type: 'onStart' }, [{ type: 'setEntityPosition', entityId: 'crate', x: -100, y: 0, z: 256 }]),
    rule('inside', { type: 'playerInArea', entityId: 'crate' }, [{ type: 'addVariable', variable: 'inside', value: 1 }]),
  ];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 1);
  assert.equal(state.variables.inside, 0, 'the area moved above the player');
});

test('shoot-linedef conditions receive one pulse regardless of rule order or gameplay phase', () => {
  for (const fireFirst of [false, true]) {
    const project = bareRoom();
    project.eventSheets = [{ id: 'before', name: 'Before', enabled: true, section: 'game', phase: 'beforePhysics' }];
    const fire = rule('fire', { type: 'onStart' },
      [{ type: 'hitscan', damage: 1, diceSides: 1, pellets: 3, spread: 0, range: 1000 }]);
    const listeners = [
      rule('shot_before', { type: 'wallActivated', wallId: 'wall1', mode: 'shoot' },
        [{ type: 'addVariable', variable: 'ticks', value: 1 }], { sheetId: 'before' }),
      rule('shot_after', { type: 'wallActivated', wallId: 'wall1', mode: 'shoot' },
        [{ type: 'addVariable', variable: 'inside', value: 1 }]),
    ];
    project.events = fireFirst ? [fire, ...listeners] : [...listeners, fire];
    validateProject(project);
    const state = createRuntime(project);
    tick(project, state, 1);
    assert.equal(state.variables.ticks, 0);
    assert.equal(state.variables.inside, 0, 'shots are observed on the following gameplay tick');
    const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'shots'))), 'shots').runtime;
    tick(project, restored, 2);
    assert.equal(restored.variables.ticks, 1, 'saving before delivery does not lose a shot pulse');
    assert.equal(restored.variables.inside, 1);
    state.gameScreen = 'pause';
    tick(project, state, 2);
    assert.equal(state.variables.ticks, 0);
    state.gameScreen = 'playing';
    tick(project, state, 2);
    assert.equal(state.variables.ticks, 1);
    assert.equal(state.variables.inside, 1, 'pellets hitting one line in a frame coalesce into one pulse');
  }
});

test('automatic Doom weapon attacks are visible to shoot-linedef rules on the next tick', () => {
  const project = bareRoom();
  project.actors = buildVanillaActors();
  project.events = [rule('shot', { type: 'wallActivated', wallId: 'wall1', mode: 'shoot' },
    [{ type: 'addVariable', variable: 'ticks', value: 1 }])];
  const state = createRuntime(project);
  let shots = 0, lastShot;
  for (let frame = 0; frame < 110; frame++) {
    stepRuntime(project, state, 1 / 35, new Set(frame < 80 ? ['Mouse0'] : []));
    if (state.lastShot && state.lastShot.time !== lastShot) { lastShot = state.lastShot.time; shots++; }
  }
  assert.ok(shots > 0, 'the actor weapon state machine fired');
  assert.equal(state.variables.ticks, shots, 'every automatic shot produces one visual event');
});

test('periodic rules keep separate clocks per instance and per condition, including inherited children', () => {
  const project = bareRoom();
  project.map.entities.push({ ...structuredClone(project.map.entities[1]), id: 'crate2', x: 150 });
  const actions = [{ type: 'rotateEntityBy', entityId: '$self', angle: 10 }];
  project.events = [
    rule('periodic', { type: 'everySeconds', seconds: .5 }, actions, { forEachType: 'decoration' }),
    rule('parent', { type: 'always' }, [], { forEachType: 'decoration' }),
    rule('child', { type: 'everySeconds', seconds: .5 }, actions, { parentId: 'parent', forEachType: 'decoration' }),
    rule('multiple', { type: 'everySeconds', seconds: .5 }, [{ type: 'addVariable', variable: 'ticks', value: 1 }],
      { conditions: [{ type: 'everySeconds', seconds: .5 }] }),
  ];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 61);
  for (const entity of state.entities.filter(entity => entity.type === 'decoration')) assert.equal(entity.angle, 60, entity.id);
  assert.equal(state.variables.ticks, 3);
});

test('game saves retain a periodic rule deadline instead of firing it early on load', () => {
  const project = bareRoom();
  project.events = [rule('interval', { type: 'everySeconds', seconds: .5 },
    [{ type: 'addVariable', variable: 'ticks', value: 1 }])];
  const state = createRuntime(project);
  tick(project, state, 15);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'interval'))), 'interval').runtime;
  tick(project, state, 10); tick(project, restored, 10);
  assert.equal(restored.variables.ticks, state.variables.ticks, 'no extra firing before the deadline');
  tick(project, state, 10); tick(project, restored, 10);
  assert.equal(restored.variables.ticks, 2);
  assert.deepEqual(restored.intervals, state.intervals);
});

test('the wall-walking and area rules need no imported content', t => {
  const project = bareRoom();
  assert.equal(project.importSource, undefined, 'the fixture has no WAD provenance');
  assert.equal(project.game, undefined, 'and no campaign');
  installWallWalkDemo(project);
  project.events.push(
    rule('area_in', { type: 'playerInArea', entityId: 'crate' }, [{ type: 'addVariable', variable: 'inside', value: 1 }]),
    rule('area_enter', { type: 'playerEnteredArea', entityId: 'crate' }, [{ type: 'addVariable', variable: 'entered', value: 1 }]));
  const state = withPhysics(project, t);
  tick(project, state, 30);
  // Everything the demo and the area rules need comes from the engine, not the map.
  assert.ok(Array.isArray(state.surfaces));
  assert.equal(state.player.up[2], 1);
  // Walk into the crate's interaction area: the capsule has to move, not just the state.
  const playerId = state.entities.find(entity => entity.type === 'player').id;
  state.physics.teleport(playerId, 80, 0);
  tick(project, state, 5);
  assert.equal(state.variables.inside, 5, 'inside-the-area fires every frame while standing in it');
  assert.equal(state.variables.entered, 1, 'entered fires exactly once');
});

test('every new condition and action works on a bare project and survives a round trip', t => {
  const project = bareRoom();
  project.events = [
    rule('interval', { type: 'everySeconds', seconds: .5 }, [
      { type: 'rotateEntityBy', entityId: 'crate', angle: 45 },
      { type: 'setEntityTilt', entityId: 'crate', pitch: 90, roll: 0 },
    ]),
    rule('chance', { type: 'randomChance', probability: .5 }, [{ type: 'addVariable', variable: 'rolls', value: 1 }]),
    rule('count', { type: 'objectCount', entityType: 'decoration', operator: '>=', value: 1 },
      [{ type: 'addVariable', variable: 'ticks', value: 1 }], { conditions: [{ type: 'entityAngle', entityId: 'crate', operator: '>=', value: 45 }] }),
    rule('pitch', { type: 'onStart' }, [{ type: 'setPlayerPitch', pitch: 25 }]),
  ];
  const state = withPhysics(project, t);
  tick(project, state, 70);
  const crate = state.entities.find(entity => entity.id === 'crate');
  assert.equal(crate.angle, 135, 'everySeconds fired at 0, 0.5 and 1.0 s and rotated 45 each time');
  assert.deepEqual(crate.modelTilt, { pitch: 90, roll: 0 });
  assert.ok(state.variables.rolls > 0, 'randomChance fired at p=0.5');
  assert.ok(state.variables.ticks > 0, 'objectCount and entityAngle were satisfied');
  assert.equal(Math.round(state.player.pitch * 180 / Math.PI), 25);

  // Saved projects are plain JSON: the commands must validate again after a copy.
  const copy = structuredClone(project);
  assert.doesNotThrow(() => validateProject(copy));
  assert.doesNotThrow(() => createRuntime(copy));
});

// The count condition reads `condition.entityType || 'any'` so the runtime does not depend on the
// editor having filled the field in. That fallback used to name a field no rule has, so a count with
// no type came out as zero — a rule that silently never fires. A saved project cannot reach that
// state (validation rejects a missing choice), so it is checked where it can happen: a project
// built by hand, which is how tools and tests drive the runtime.
test('a count with no entity type counts any object instead of nothing', t => {
  const project = bareRoom();
  project.variables.seen = 0;
  project.events = [rule('any', { type: 'objectCount', operator: '>=', value: 1 },
    [{ type: 'addVariable', variable: 'seen', value: 1 }])];
  // No validateProject: the point is that the runtime does not rely on the editor's defaults.
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  tick(project, state, 10);
  assert.ok(state.variables.seen > 0, 'a count of any objects is satisfied by a level with objects');
  // The explicit choices still count only what they name, and validation still requires one.
  project.events[0].condition.entityType = 'enemy';
  project.variables.seen = 0;
  const enemies = createRuntime(project);
  enemies.physics = createPhysics(project, enemies, R, triangulate);
  t.after(() => enemies.physics.dispose());
  tick(project, enemies, 10);
  assert.equal(enemies.variables.seen, 0, 'this room has no enemies, so that rule never fires');
  const strict = bareRoom();
  strict.variables.seen = 0;
  strict.events = [rule('any', { type: 'objectCount', operator: '>=', value: 1 }, [{ type: 'addVariable', variable: 'seen', value: 1 }])];
  assert.throws(() => validateProject(strict), /Unsupported entityType/, 'the editor always writes the type');
});

test('every command is available to any project, not just imported ones', () => {
  for (const type of ['playerTouchingSurface', 'playerAirborne', 'playerInArea', 'playerEnteredArea',
    'everySeconds', 'randomChance', 'objectCount', 'entityAngle']) {
    assert.ok(CONDITIONS.includes(type), `${type} is a condition`);
  }
  for (const type of ['setPlayerGravity', 'rotateEntityBy', 'setEntityTilt', 'setPlayerPitch']) {
    assert.ok(ACTIONS.includes(type), `${type} is an action`);
  }
});

test('tilt is validated and ignored by projects that do not use it', () => {
  const project = bareRoom();
  project.map.entities[1].modelTilt = { pitch: 180, roll: 90 };
  assert.doesNotThrow(() => validateProject(project));
  project.map.entities[1].modelTilt = { pitch: 'upside down' };
  assert.throws(() => validateProject(project), /Model tilt pitch/);
  project.map.entities[1].modelTilt = 'yes';
  assert.throws(() => validateProject(project), /Model tilt must be an object/);
});

test('a declared model facing is validated and stays optional', () => {
  const project = bareRoom();
  assert.doesNotThrow(() => validateProject(project), 'projects that never set a facing still load');
  for (const facing of [0, 90, -270, 360]) {
    project.map.entities[1].modelFacing = facing;
    assert.doesNotThrow(() => validateProject(project), `${facing} is a facing`);
  }
  project.map.entities[1].modelFacing = 'north';
  assert.throws(() => validateProject(project), /Model facing/);
  project.map.entities[1].modelFacing = 400;
  assert.throws(() => validateProject(project), /Model facing/);
  delete project.map.entities[1].modelFacing;
  assert.doesNotThrow(() => validateProject(project));
});

test('a sub-event of a for-each rule runs once per instance, not once per object', async () => {
  const { createProject, validateProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const project = createProject();
  project.map.entities.push({ id: 'shelf1', name: 'Shelf 1', type: 'decoration', x: 0, y: 0, angle: 0, variables: { hits: 0 } },
    { id: 'shelf2', name: 'Shelf 2', type: 'decoration', x: 0, y: 0, angle: 0, variables: { hits: 0 } });
  project.events = [
    { id: 'each', enabled: true, once: false, forEachType: 'decoration',
      condition: { type: 'always' }, conditions: [], actions: [] },
    { id: 'count', parentId: 'each', enabled: true, once: false, forEachType: 'decoration',
      condition: { type: 'always' }, conditions: [], actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'hits', value: 1 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.entities.find(entity => entity.id === 'shelf1').variables.hits, 1);
  assert.equal(state.entities.find(entity => entity.id === 'shelf2').variables.hits, 1);
});

test('a sub-event of an object rule resolves this object', async () => {
  const { createProject, validateProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const project = createProject();
  project.map.entities.push({ id: 'crate', name: 'Crate', type: 'decoration', x: 10, y: 20, angle: 0 });
  project.events = [
    { id: 'root', ownerId: 'crate', enabled: true, once: false,
      condition: { type: 'always' }, conditions: [], actions: [] },
    { id: 'child', parentId: 'root', ownerId: 'crate', enabled: true, once: false,
      condition: { type: 'always' }, conditions: [],
      actions: [{ type: 'setEntityPosition', entityId: '$self', x: 99, y: 77, z: 1 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  const crate = state.entities.find(entity => entity.id === 'crate');
  assert.deepEqual([crate.x, crate.y], [99, 77], 'the child rule moved the owning object');
});

// A cue that puts an object in the level during play has to give it the body its authored copy
// would have had: a spawned crate was walked through, and a spawned monster could not block.
test('an object spawned during play gets a body, a per-object rule, and is forgotten when removed', t => {
  const project = bareRoom();
  project.map.entities = project.map.entities.map(entity => entity.type === 'player' ? entity
    : { ...entity, variables: { seen: 0 } });
  project.map.entities.push({ id: 'block', type: 'decoration', name: 'Block', x: 64, y: 64, angle: 0, elevation: 0,
    variables: { seen: 0 },
    physics: { body: 'fixed', shape: 'box', width: 64, height: 64, depth: 64, radius: 32, mass: 1,
      friction: .7, restitution: 0, sensor: false, lockRotation: false } });
  project.events = [
    rule('spawn', { type: 'onStart' }, [{ type: 'spawnEntity', templateId: 'block', x: -64, y: 64 }], { once: true }),
    { id: 'mark', enabled: true, once: true, forEachType: 'decoration',
      condition: { type: 'always' }, conditions: [], actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'seen', value: 1 }] },
  ];
  const state = withPhysics(project, t);
  tick(project, state, 3);
  const spawned = state.entities.find(entity => entity.spawnedFrom);
  assert.ok(spawned, 'the cue made an object');
  assert.equal(state.physics.bodies.has(spawned.id), true, 'and it is solid');
  assert.equal(spawned.variables?.seen, 1, 'a per-object rule ran for it');
  assert.ok([...state.fired].some(key => key.endsWith(`:${spawned.id}`)), 'and left a per-object mark');

  // Removing it releases what the runtime remembered, so a spawner does not grow for ever. The
  // rule is added after validation because it names an object that only exists during play.
  project.events.push(rule('cleanup', { type: 'always' }, [{ type: 'removeEntity', entityId: spawned.id }], { once: true }));
  tick(project, state, 1);
  assert.equal(state.entities.some(entity => entity.id === spawned.id), false, 'the rule removed it');
  assert.equal([...state.fired].some(key => key.endsWith(`:${spawned.id}`)), false, 'its per-object marks went with it');
});
