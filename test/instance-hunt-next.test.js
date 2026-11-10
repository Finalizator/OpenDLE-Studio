import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { readInstanceProperty } from '../shared/instance-properties.js';
import { advanceCameras, startCameraMove, viewFov } from '../shared/camera-runtime.js';
import { setSpriteState } from '../shared/sprite-animation.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { bundleModel } from '../shared/gltf.js';
import { modelFixture } from './fixtures/model.js';
import { entityReferences, rewriteEntityReferences, stripEntityReferences } from '../shared/references.js';
import { evaluateExpression, expressionContext } from '../shared/expressions.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const expr = expr => ({ expr });
const rule = (id, actions = [], extra = {}) => ({ id, enabled: true, once: false, condition: { type: 'always' }, actions, ...extra });
function fixture() {
  const project = createProject();
  project.events = [];
  project.variables.result = 0;
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  project.map.entities.push({ id: 'enemy0', name: 'Guard', type: 'enemy', x: 100, y: 100, angle: 0, health: 20,
    variables: { score: 0, threshold: 10 } });
  return project;
}
const guard = state => state.entities.find(entity => entity.id === 'enemy0');
const tick = (project, state = createRuntime(project)) => {
  stepRuntime(project, state, 1 / 60, new Set());
  return state;
};
const spawn = extra => ({ type: 'spawnEntity', templateId: 'enemy0', x: 200, y: 100, ...extra });
const camera = extra => ({ id: 'cam', name: 'Camera', type: 'camera', x: 100, y: 100, angle: 0, ...extra });
const cameraAction = (type, extra) => ({ type, camera: 'cam', ...extra });
const read = (project, state, entity, property) => readInstanceProperty(project, state, entity, property);
const assignment = value => ({ type: 'setVariable', variable: 'result', value });
function spriteFixture(project, id = 'idle', loop = true) {
  project.assets = [{ id: 'frame', name: 'Frame', kind: 'sprite', width: 1, height: 1,
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }];
  project.spriteClips = [{ id, name: id, frames: ['frame'], seconds: 1, loop }];
}

test('next 01: ground actors resting on the floor report grounded without Rapier', () => {
  const project = fixture(), state = createRuntime(project), entity = guard(state);
  entity.z = 0;
  assert.equal(read(project, state, entity, 'grounded'), 1);
  entity.z = 12;
  assert.equal(read(project, state, entity, 'grounded'), 0);
  state.sectors[0].threeDFloors = [{ solid: true, bottom: 32, top: 64 }];
  entity.z = 64;
  assert.equal(read(project, state, entity, 'grounded'), 1);
  entity.vz = 2;
  assert.equal(read(project, state, entity, 'grounded'), 0);
});

test('next 02: spawn refuses player templates instead of creating a second player', () => {
  const project = fixture();
  project.events = [rule('bad_player', [spawn({ templateId: project.map.entities[0].id })])];
  assert.throws(() => validateProject(project), /player/i);
});

test('next 03: headless spawning initializes floor-relative world height', () => {
  const project = fixture();
  project.map.sectors[0].floorHeight = 32;
  project.map.entities[1].elevation = 8;
  project.events = [rule('spawn', [spawn(), assignment(expr('property("enemy", "z")'))])];
  const state = tick(project);
  assert.equal(state.entities.find(entity => entity.spawnedFrom).z, 40);
  assert.equal(state.variables.result, 40);
});

test('next 04: runtime spawns inherit their template object-owned rules', () => {
  const project = fixture();
  project.events = [
    rule('behavior', [{ type: 'addObjectVariable', entityId: '$self', variable: 'score', value: 1 }], { ownerId: 'enemy0' }),
    rule('create', [spawn()], { once: true }),
  ];
  validateProject(project);
  const state = tick(project);
  tick(project, state);
  assert.equal(state.entities.find(entity => entity.spawnedFrom).variables.score, 1);
});

test('next 05: spawned model instances honor their template autoplay animation', async () => {
  const project = fixture();
  const { asset } = await bundleModel(new File([modelFixture().glb], 'model.glb'), [], 'model');
  project.assets = [asset];
  Object.assign(project.map.entities[1], { modelAsset: asset.id,
    animation: { clip: asset.animations[0], speed: 1, loop: true, autoPlay: true } });
  project.events = [rule('create', [spawn()], { once: true })];
  validateProject(project);
  const state = tick(project);
  const spawned = state.entities.find(entity => entity.spawnedFrom);
  assert.equal(state.animations.get(spawned.id)?.playing, true);
});

test('next 06: createCamera leaves the new camera selected for picked actions', () => {
  const project = fixture();
  project.map.entities.push(camera());
  project.events = [rule('create', [
    { type: 'createCamera', name: 'New camera', x: 200, y: 100, angle: 0, pitch: 0, fov: 90, activate: 'no' },
    { type: 'setPickedAngle', objectType: 'camera', angle: 45 },
  ])];
  validateProject(project);
  const state = tick(project);
  assert.equal(state.entities.find(entity => entity.id === 'cam').angle, 0);
  assert.equal(state.entities.find(entity => entity.name === 'New camera').angle, 45);
});

test('next 07: picking compares each candidate against its own expression values', () => {
  const project = fixture();
  project.map.entities[1].variables.threshold = 20;
  project.map.entities.push({ ...structuredClone(project.map.entities[1]), id: 'enemy1', x: 200,
    health: 10, variables: { score: 0, threshold: 10 } });
  project.events = [rule('matching', [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: 1 }], {
    condition: { type: 'pickByProperty', objectType: 'enemy', property: 'health', operator: '=', value: expr('object("enemy","threshold")') },
  })];
  validateProject(project);
  assert.deepEqual(tick(project).entities.filter(entity => entity.type === 'enemy').map(entity => entity.variables.score), [1, 1]);
});

test('next 08: counting an authored instance after destruction returns zero', () => {
  const project = fixture();
  project.events = [rule('remove', [{ type: 'removeEntity', entityId: 'enemy0' }, assignment(expr('count("enemy0")'))])];
  validateProject(project);
  assert.equal(tick(project).variables.result, 0);
});

test('next 09: model orientation properties follow the live rigid-body quaternion', () => {
  const project = fixture(), state = createRuntime(project), entity = guard(state);
  entity.rotation = { x: 0, y: Math.sin(-Math.PI / 4), z: 0, w: Math.cos(-Math.PI / 4) };
  assert.equal(read(project, state, entity, 'angle'), 90);
});

test('next 10: media-node dimensions are readable without a physics collider', () => {
  const project = fixture(), entity = { ...project.map.entities[1], type: 'decoration',
    mesh: { shape: 'box', width: 80, height: 48, depth: 24 } };
  assert.deepEqual(['width', 'height', 'depth'].map(name => read(project, null, entity, name)), [80, 48, 24]);
});

test('next 11: player dimensions describe the built-in controller capsule', () => {
  const project = fixture(), entity = project.map.entities[0];
  assert.deepEqual(['width', 'height', 'depth', 'radius'].map(name => read(project, null, entity, name)), [24, 56, 24, 12]);
});

test('next 12: facing expressions use the authored ramp-facing field', () => {
  const project = fixture(), entity = { ...project.map.entities[1], type: 'ramp', ramp: { facing: 'left' } };
  assert.equal(read(project, null, entity, 'facing'), -1);
});

test('next 13: an object without an animation does not report elapsed clip time', () => {
  const project = fixture(), state = createRuntime(project);
  state.time = 3;
  assert.equal(read(project, state, guard(state), 'animationTime'), 0);
});

test('next 14: floor/elevation expressions recognize solid 3D-floor platforms', () => {
  const project = fixture(), state = createRuntime(project), entity = guard(state);
  state.sectors[0].threeDFloors = [{ solid: true, bottom: 32, top: 64 }];
  entity.z = 72;
  assert.equal(read(project, state, entity, 'floorHeight'), 64);
  assert.equal(read(project, state, entity, 'elevation'), 8);
});

test('next 15: single-object positioning updates headless elevation consistently with picked positioning', () => {
  const project = fixture();
  project.map.sectors[0].floorHeight = 32;
  project.events = [rule('position', [{ type: 'setEntityPosition', entityId: 'enemy0', x: 200, y: 100, z: 64 }])];
  const state = tick(project);
  assert.equal(guard(state).elevation, 32);
});

test('next 16: sprite-state conditions recognize the implicit stand animation', () => {
  const project = fixture();
  spriteFixture(project);
  project.map.entities[1].spriteStates = { stand: 'idle' };
  project.events = [rule('stand', [assignment(1)], { condition: { type: 'spriteState', entityId: 'enemy0', state: 'stand' } })];
  validateProject(project);
  assert.equal(tick(project).variables.result, 1);
});

test('next 17: explicitly restarting a non-looping sprite state actually restarts it', () => {
  const project = fixture();
  spriteFixture(project, 'attack', false);
  project.map.entities[1].spriteStates = { attack: 'attack' };
  validateProject(project);
  const state = createRuntime(project), entity = guard(state);
  setSpriteState(project, state, entity, 'attack', true);
  state.time = .25;
  setSpriteState(project, state, entity, 'attack', true);
  assert.equal(state.spriteAnimations.get(entity.id).start, .25);
});

test('next 18: removing instances clears their owned timers rather than retaining unbounded stale entries', () => {
  const project = fixture();
  project.events = [rule('remove', [{ type: 'removePicked', objectType: 'enemy' }])];
  const state = createRuntime(project);
  state.timers.set('enemy0:cooldown', 5);
  tick(project, state);
  assert.equal(state.timers.has('enemy0:cooldown'), false);
});

test('next 19: a gliding camera is not overwritten by follow logic', () => {
  const project = fixture(), state = createRuntime(project), cam = camera({ z: 0, cameraFollow: 'enemy0' });
  state.entities.push(cam);
  startCameraMove(state, cam, { x: 300, y: 100, z: 0 }, { seconds: 2, easing: 'linear' });
  advanceCameras(project, state, 1);
  assert.equal(cam.x, 200);
});

test('next 20: following the player reads the live player pose rather than stale authored entity coordinates', () => {
  const project = fixture(), state = createRuntime(project), cam = camera({ cameraFollow: '$player' });
  state.entities.push(cam);
  Object.assign(state.player, { x: 256, y: 64, z: 32, angle: Math.PI / 2 });
  advanceCameras(project, state, 0);
  assert.deepEqual([cam.x, cam.y, cam.z, cam.angle], [256, 64, 32, -90]);
});

test('next 21: copyAngle=no also preserves heading while following a player', () => {
  const project = fixture(), state = createRuntime(project), cam = camera({ angle: 30, cameraFollow: '$player', cameraFollowAngle: false });
  state.entities.push(cam);
  advanceCameras(project, state, 0);
  assert.equal(cam.angle, 30);
});

test('next 22: a floor-relative camera begins vertical glides at its current world height', () => {
  const project = fixture(), state = createRuntime(project), cam = camera({ elevation: 8 });
  project.map.sectors[0].floorHeight = state.sectors[0].floorHeight = 32;
  state.entities.push(cam);
  startCameraMove(state, cam, { x: 100, y: 100, z: 80 }, { seconds: 2, easing: 'linear' });
  advanceCameras(project, state, 1);
  assert.equal(cam.z, 60);
});

test('next 23: camera yaw glides take the shortest arc across zero degrees', () => {
  const project = fixture(), state = createRuntime(project), cam = camera({ angle: 350 });
  state.entities.push(cam);
  startCameraMove(state, cam, { x: 100, y: 100, angle: 10 }, { seconds: 2, easing: 'linear' });
  advanceCameras(project, state, 1);
  assert.equal(((cam.angle % 360) + 360) % 360, 0);
});

test('next 24: setCameraPosition can reposition the player view', () => {
  const project = fixture();
  project.events = [rule('camera_position', [cameraAction('setCameraPosition', { camera: '$player', x: 200, y: 100, z: 32 })])];
  validateProject(project);
  const state = tick(project);
  assert.deepEqual([state.player.x, state.player.y, state.player.z], [200, 100, 32]);
});

test('next 25: setCameraAngle updates player yaw as well as pitch', () => {
  const project = fixture();
  project.events = [rule('camera_angle', [cameraAction('setCameraAngle', { camera: '$player', angle: 90, pitch: 15 })])];
  validateProject(project);
  const state = tick(project);
  assert.ok(Math.abs(state.player.angle - Math.PI / 2) < 1e-8);
});

test('next 26: camera transform fields reject nonnumeric literal and expression results', () => {
  const project = fixture();
  project.map.entities.push(camera());
  project.events = [rule('invalid_camera', [cameraAction('setCameraPosition', { x: 'oops', y: 100 })])];
  assert.throws(() => validateProject(project), /number|between|numeric/i);
  project.events[0].actions[0].x = expr('"oops"');
  assert.throws(() => tick(project), /invalid_camera.*numeric/i);
});

test('next 27: camera creation enforces camera FOV limits instead of creating unloadable state', () => {
  const project = fixture();
  project.events = [rule('invalid_fov', [{ type: 'createCamera', name: 'Bad', x: 100, y: 100, angle: 0, pitch: 0, fov: 999, activate: 'no' }])];
  assert.throws(() => validateProject(project), /fov|between/i);
});

test('next 28: camera views with omitted FOV use canonical camera defaults', () => {
  const state = { entities: [camera()], settings: { fov: 110 }, viewCamera: 'cam' };
  assert.equal(viewFov(state), 90);
});

test('next 29: distance comparisons reject self references without an object context', () => {
  const project = fixture();
  project.events = [rule('distance', [], {
    condition: { type: 'distanceBetween', entityId: 'enemy0', otherId: '$self', operator: '<', distance: 25 },
  })];
  assert.throws(() => validateProject(project), /context|owned|self|object/i);
});

test('next 30: entity angle conditions do not match a target already removed in an earlier rule', () => {
  const project = fixture();
  project.events = [
    rule('destroy', [{ type: 'removeEntity', entityId: 'enemy0' }]),
    rule('ghost_angle', [assignment(1)], { condition: { type: 'entityAngle', entityId: 'enemy0', operator: '=', value: 0 } }),
  ];
  validateProject(project);
  assert.equal(tick(project).variables.result, 0);
});

test('next 31: camera commands participate in object deletion and reference replacement', () => {
  const project = fixture();
  project.map.entities.push(camera());
  project.events = [rule('switch', [cameraAction('switchCamera')])];
  assert.equal(entityReferences(project, 'cam').length, 1);
  rewriteEntityReferences(project, new Map([['cam', 'other_camera']]));
  assert.equal(project.events[0].actions[0].camera, 'other_camera');
  stripEntityReferences(project, 'other_camera');
  assert.deepEqual(project.events, []);
});

test('next 32: expression exponentiation binds more tightly than a leading minus', () => {
  const project = fixture();
  assert.equal(evaluateExpression(expr('-2 ^ 2'), expressionContext(project, {})), -4);
});

test('next 33: fractional text counts are truncated consistently before slicing', () => {
  const project = fixture(), context = expressionContext(project, {});
  assert.equal(evaluateExpression(expr('right("abc", 0.5)'), context), '');
  assert.equal(evaluateExpression(expr('mid("abc", 0.8, 0.8)'), context), '');
});

test('next 34: text replacement inserts replacement text literally instead of interpreting dollar tokens', () => {
  const project = fixture();
  assert.equal(evaluateExpression(expr('replace("abc", "b", "$&")'), expressionContext(project, {})), 'a$&c');
});

test('next 35: per-target expressions preserve the picked-group count', () => {
  const project = fixture();
  project.map.entities.push({ ...structuredClone(project.map.entities[1]), id: 'enemy1' });
  project.events = [rule('count', [{ type: 'setPickedVariable', objectType: 'enemy', variable: 'score', value: expr('count("enemy")') }])];
  validateProject(project);
  assert.deepEqual(tick(project).entities.filter(entity => entity.type === 'enemy').map(entity => entity.variables.score), [2, 2]);
});

test('next 36: difficulty filtering must not remove the single player start', () => {
  const project = fixture();
  project.map.entities[0].skillMask = 1;
  validateProject(project);
  const state = createRuntime(project, { settings: { difficulty: 4 } });
  assert.equal(state.entities.filter(entity => entity.type === 'player').length, 1);
});

test('next 37: filtered-out instances do not leave orphan autoplay animation state', async () => {
  const project = fixture();
  const { asset } = await bundleModel(new File([modelFixture().glb], 'model.glb'), [], 'model');
  project.assets = [asset];
  Object.assign(project.map.entities[1], { modelAsset: asset.id, skillMask: 1,
    animation: { clip: asset.animations[0], speed: 1, loop: true, autoPlay: true } });
  validateProject(project);
  const state = createRuntime(project, { settings: { difficulty: 4 } });
  assert.equal(state.entities.some(entity => entity.id === 'enemy0'), false);
  assert.equal(state.animations.has('enemy0'), false);
});

test('owned-spawn companion: nested once rules survive template removal and save/load', () => {
  const project = fixture();
  project.events = [
    rule('create', [spawn(), { type: 'removeEntity', entityId: 'enemy0' }], { once: true }),
    rule('behavior', [{ type: 'addObjectVariable', entityId: '$self', variable: 'score', value: 1 }], { ownerId: 'enemy0' }),
    rule('nested', [{ type: 'addObjectVariable', entityId: '$self', variable: 'score', value: 10 }], { parentId: 'behavior', ownerId: 'enemy0', once: true }),
  ];
  validateProject(project);
  const state = tick(project), spawned = state.entities.find(entity => entity.spawnedFrom);
  assert.equal(spawned.variables.score, 11);
  assert.equal(state.fired.has(`nested:${spawned.id}`), true);
  const saved = JSON.parse(JSON.stringify(captureGameSave(project, state, 'instances')));
  const loaded = restoreGameSave(project, saved, 'instances').runtime;
  tick(project, loaded);
  assert.equal(loaded.entities.find(entity => entity.spawnedFrom).variables.score, 12);
});

test('owned-spawn companion: hidden templates still supply scripts to explicitly spawned copies', () => {
  const project = fixture();
  project.map.entities[1].skillMask = 1;
  project.events = [
    rule('create', [spawn()], { once: true }),
    rule('behavior', [{ type: 'addObjectVariable', entityId: '$self', variable: 'score', value: 1 }], { ownerId: 'enemy0', once: true }),
  ];
  validateProject(project);
  const state = createRuntime(project, { settings: { difficulty: 4 } });
  tick(project, state);
  tick(project, state);
  assert.equal(guard(state), undefined);
  assert.equal(state.entities.find(entity => entity.spawnedFrom).variables.score, 1);
});

test('owned-spawn companion: opening a menu stops subsequent copies just like for-each rules', () => {
  const project = fixture();
  project.events = [
    rule('create', [spawn()], { once: true }),
    rule('behavior', [{ type: 'addVariable', variable: 'result', value: 1 }, { type: 'setGameScreen', screen: 'pause' }],
      { ownerId: 'enemy0' }),
  ];
  validateProject(project);
  assert.equal(tick(project).variables.result, 1);
});

test('next 38: for-each self targets offer common local variables, signals and model clips', () => {
  const project = fixture();
  Object.assign(project.map.entities[1], { signals: ['hit', 'guard_only'], modelAsset: 'guard_model' });
  project.map.entities.push({ ...structuredClone(project.map.entities[1]), id: 'enemy1',
    signals: ['hit'], modelAsset: 'other_model', variables: { score: 0 } });
  project.assets = [{ id: 'guard_model', animations: ['Idle', 'Attack'] }, { id: 'other_model', animations: ['Idle'] }];
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const lists = source.match(/^function commandLists\(ownerId\) \{[\s\S]*?^\}/m)[0];
  const context = runInNewContext(`(${lists})('$type:enemy')`, {
    project, entityOptions: () => [], imageAssetOptions: () => [], sectorMover: () => null,
    nodeSignals: entity => entity.signals || [],
    // The HUD catalogue is listed for the "show a HUD screen" action, so the harness needs it.
    hudScreens: () => [{ id: 'main', name: 'Main HUD' }],
  });
  assert.deepEqual([...context.entityVariableNames('$self')], ['score']);
  assert.deepEqual([...context.entitySignalNames('$self')], ['hit']);
  assert.deepEqual([...context.clips('$self')], ['Idle']);
  assert.deepEqual([...context.entityVariableNames('enemy0')], ['score', 'threshold']);
});
