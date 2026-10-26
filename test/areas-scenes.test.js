import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import {
  AREA_SHAPES, DEFAULT_AREA, PLAYER_CYLINDER, areaBounds, areaContains, areaEntered, areaSpec, areaVolume,
  overlayVolumes, physicsVolume, suggestedArea,
} from '../shared/areas.js';
import { captureScene, instantiateScene, sceneOrigin, MAX_SCENE_ENTITIES } from '../shared/scenes.js';

const SPHERE = { shape: 'sphere', width: 64, height: 64, depth: 64, radius: 96 };
const BOX = { shape: 'box', width: 128, height: 96, depth: 64, radius: 32 };
const CAPSULE = { shape: 'capsule', width: 32, height: 160, depth: 32, radius: 32 };
const player = (x, y, z = 0) => ({ x, y, z });

test('interaction areas normalise their shape and sizes', () => {
  assert.deepEqual(AREA_SHAPES, ['box', 'sphere', 'capsule']);
  assert.equal(areaSpec(undefined), null);
  assert.deepEqual(areaSpec({ shape: 'sphere', radius: 40 }), { shape: 'sphere', width: DEFAULT_AREA.width, height: DEFAULT_AREA.height, depth: DEFAULT_AREA.depth, radius: 40 });
  assert.deepEqual(areaSpec({ shape: 'blob', width: -4 }).shape, 'box');
  assert.equal(areaSpec({ shape: 'box', width: -4 }).width, DEFAULT_AREA.width);
  assert.deepEqual(suggestedArea({}), DEFAULT_AREA);
  assert.deepEqual(suggestedArea({ physics: { body: 'dynamic', shape: 'ball', width: 8, height: 16, depth: 8, radius: 8 } }),
    { shape: 'sphere', width: 8, height: 16, depth: 8, radius: 8 });
});

test('area volumes sit on the sector floor like colliders do', () => {
  const entity = { x: 100, y: -40, angle: 0, elevation: 24, area: BOX };
  const volume = areaVolume(entity, 64);
  assert.deepEqual(volume.center, { x: 100, y: -40, z: 64 + 24 + 48 });
  assert.deepEqual(volume.half, { width: 64, depth: 32, height: 48 });
  assert.deepEqual(areaBounds(volume), { min: { x: 36, y: -72, z: 88 }, max: { x: 164, y: -8, z: 184 } });
  assert.equal(areaVolume({ x: 0, y: 0 }, 0), null);
  // A sphere is centred on its radius, a capsule on half its height.
  assert.deepEqual(areaVolume({ x: 0, y: 0, area: SPHERE }, 0).center.z, 96);
  assert.deepEqual(areaVolume({ x: 0, y: 0, area: CAPSULE }, 0).center.z, 80);
  const physics = physicsVolume({ x: 0, y: 0, physics: { body: 'dynamic', shape: 'ball', width: 24, height: 24, depth: 24, radius: 12 } }, 0);
  assert.deepEqual(physics.center.z, 12);
  assert.equal(physicsVolume({ x: 0, y: 0, physics: { body: 'none' } }, 0), null);
});

test('overlays describe the volumes the 3D view draws', () => {
  const entities = [
    { id: 'player', type: 'player', name: 'Player', x: 0, y: 0 },
    { id: 'crate', type: 'decoration', name: 'Crate', x: 64, y: 0, area: SPHERE, physics: { body: 'fixed', shape: 'box', width: 32, height: 32, depth: 32 } },
    { id: 'plain', type: 'decoration', name: 'Plain', x: 128, y: 0 },
  ];
  const floor = () => 16;
  assert.deepEqual(overlayVolumes(entities, {}, floor), []);
  const areas = overlayVolumes(entities, { areas: true }, floor);
  assert.deepEqual(areas.map(plan => [plan.kind, plan.id, plan.shape]), [['area', 'crate', 'sphere']]);
  const physics = overlayVolumes(entities, { physics: true, player: true }, floor);
  // The player capsule shows where an interaction area has to be to catch it.
  assert.deepEqual(physics.map(plan => [plan.kind, plan.id]), [['player', 'player'], ['physics', 'crate']]);
  assert.deepEqual(physics[0].center, { x: 0, y: 0, z: 16 + PLAYER_CYLINDER.halfHeight });
  assert.deepEqual(physics[0].half, { width: 12, depth: 12, height: PLAYER_CYLINDER.halfHeight });
  assert.deepEqual(overlayVolumes(entities, { areas: true, physics: true, player: true }, floor, 'crate').map(plan => plan.selected),
    [false, true, true]);
});

test('the area test reacts to the player body, not a single point', () => {
  const volume = areaVolume({ x: 0, y: 0, area: BOX }, 0);
  const centre = PLAYER_CYLINDER.halfHeight;
  assert.equal(areaContains(volume, player(0, 0, centre)), true);
  // Standing at the edge plus the player's own radius still counts.
  assert.equal(areaContains(volume, player(64 + 11, 0, centre)), true);
  assert.equal(areaContains(volume, player(64 + 13, 0, centre)), false);
  assert.equal(areaContains(volume, player(0, 0, 200)), false);
  const sphere = areaVolume({ x: 0, y: 0, area: SPHERE }, 0);
  assert.equal(areaContains(sphere, player(96 + 11, 0, 96)), true);
  assert.equal(areaContains(sphere, player(96 + 13, 0, 96)), false);
  assert.equal(areaContains(sphere, player(0, 0, 96 + 96 + 29)), false);
  // A capsule reaches high above its base but no wider than its radius.
  const capsule = areaVolume({ x: 0, y: 0, area: CAPSULE }, 0);
  assert.equal(areaContains(capsule, player(0, 0, 140)), true);
  assert.equal(areaContains(capsule, player(45, 0, 40)), false);
});

test('entering an area fires once until the player leaves', () => {
  const entries = new Set();
  assert.equal(areaEntered(entries, 'event', true), true);
  assert.equal(areaEntered(entries, 'event', true), false);
  assert.equal(areaEntered(entries, 'event', false), false);
  assert.equal(areaEntered(entries, 'event', true), true);
  assert.equal(areaEntered(entries, 'other', true), true);
});

test('playerInArea and playerEnteredArea drive events from the object area', () => {
  for (const shape of ['box', 'sphere', 'capsule']) {
    const project = createProject();
    const target = project.map.entities.find(entity => entity.type !== 'player');
    target.x = 0; target.y = 0;
    target.area = { ...DEFAULT_AREA, shape, radius: 128, height: 128 };
    project.map.entities.find(entity => entity.type === 'player').x = 0;
    project.map.entities.find(entity => entity.type === 'player').y = 0;
    project.events = [
      { id: 'event_inside', name: 'inside', enabled: true, once: false, condition: { type: 'playerInArea', entityId: target.id },
        conditions: [], actions: [{ type: 'setGameSetting', setting: 'brightness', value: 1.5 }] },
      { id: 'event_entered', name: 'entered', enabled: true, once: false, condition: { type: 'playerEnteredArea', entityId: target.id },
        conditions: [], actions: [{ type: 'setGameSetting', setting: 'brightness', value: 1.2 }] },
    ];
    validateProject(project);
    const state = createRuntime(project);
    stepRuntime(project, state, .016, new Set());
    assert.equal(state.settings.brightness, 1.2, `${shape}: entering sets the entered action`);
    // Move the player far away: the predicate stops but nothing fires again.
    const playerEntity = project.map.entities.find(entity => entity.type === 'player');
    state.player.x = 4000; state.player.y = 4000;
    stepRuntime(project, state, .016, new Set());
    state.settings.brightness = 1;
    state.player.x = 0; state.player.y = 0;
    stepRuntime(project, state, .016, new Set());
    assert.equal(state.settings.brightness, 1.2, `${shape}: re-entering fires again`);
    void playerEntity;
  }
});

test('an area condition on an object without an area is reported, not ignored', () => {
  const project = createProject();
  const target = project.map.entities.find(entity => entity.type !== 'player');
  project.events = [{ id: 'event_area', name: 'area', enabled: true, once: false, condition: { type: 'playerInArea', entityId: target.id },
    conditions: [], actions: [{ type: 'setGameSetting', setting: 'brightness', value: 1.5 }] }];
  const state = createRuntime(project);
  assert.throws(() => stepRuntime(project, state, .016, new Set()), /has none/);
});

test('scenes capture objects with their events and place copies with fresh ids', () => {
  const project = createProject();
  const first = project.map.entities.find(entity => entity.type !== 'player');
  const second = { ...first, id: 'second', name: 'Second' };
  project.map.entities.push(second);
  first.x = 100; first.y = 200; first.angle = 0;
  second.x = 300; second.y = 200; second.angle = 90;
  second.modelScale = 2;
  project.events = [
    { id: 'event_a', name: 'toggle', enabled: true, once: true, ownerId: first.id, condition: { type: 'onStart' },
      conditions: [], actions: [{ type: 'setGameSetting', setting: 'muted', value: true }] },
    { id: 'event_other', name: 'other', enabled: true, once: true, ownerId: project.map.entities.find(entity => entity.type === 'player').id,
      condition: { type: 'onStart' }, conditions: [], actions: [] },
  ];
  const scene = captureScene(project, [first.id, second.id], { name: 'Console' });
  assert.equal(scene.name, 'Console');
  assert.deepEqual(sceneOrigin(scene), { x: 200, y: 200 });
  assert.deepEqual(scene.entities.map(entity => [entity.x, entity.y]), [[-100, 0], [100, 0]]);
  assert.deepEqual(scene.events.map(event => event.id), ['event_a']);
  assert.ok(scene.id.startsWith('scene_'));

  project.scenes = [scene];
  validateProject(project);

  const placed = instantiateScene(scene, { x: 500, y: 500, angle: 0, prefix: 'instance_1' });
  assert.deepEqual(placed.entities.map(entity => [entity.id, entity.x, entity.y]), [['instance_1_' + first.id, 400, 500], ['instance_1_' + second.id, 600, 500]]);
  assert.equal(placed.entities[1].angle, 90);
  assert.equal(placed.entities[1].modelScale, 2);
  assert.equal(placed.events[0].ownerId, `instance_1_${first.id}`);
  assert.equal(placed.events[0].id, 'instance_1_event_a');

  // A quarter turn rotates the layout and the objects with it.
  const turned = instantiateScene(scene, { x: 0, y: 0, angle: 90, prefix: 'instance_2' });
  assert.deepEqual(turned.entities.map(entity => [entity.x, entity.y]), [[0, -100], [0, 100]]);
  assert.equal(turned.entities[1].angle, 180);

  project.map.entities.push(...placed.entities);
  project.events.push(...placed.events);
  validateProject(project);
});

test('scenes reject empty capture, the player and oversized captures', () => {
  const project = createProject();
  const player = project.map.entities.find(entity => entity.type === 'player');
  assert.throws(() => captureScene(project, []), /at least one object/);
  assert.throws(() => captureScene(project, [player.id]), /player/);
  assert.throws(() => captureScene(project, ['missing']), /no longer exists/);
  const many = Array.from({ length: MAX_SCENE_ENTITIES + 1 }, (_, index) => ({ ...project.map.entities[1], id: `many_${index}` }));
  project.map.entities.push(...many);
  assert.throws(() => captureScene(project, many.map(entity => entity.id)), /at most/);
});
