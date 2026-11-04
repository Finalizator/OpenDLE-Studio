/**
 * Cameras as something a rule can drive.
 *
 * The tests play hand-written rules through the real runtime: they create a camera, switch the
 * view to it, point it, glide it and hand the view back, and they check what a save does with
 * a glide that is halfway through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_DEFAULTS, createProject, validateProject } from '../shared/project.js';
import { ACTIONS, CONDITIONS } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { activeCamera, cameraEye, findCamera, viewFov } from '../shared/camera-runtime.js';
import { SCENE_NODE_TYPES, createSceneNode } from '../shared/scene-nodes.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { NODE_KINDS } from '../shared/media-nodes.js';

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, actions, ...extra });

function projectWith(events, cameras = []) {
  const project = createProject();
  project.events = [...project.events, ...events];
  for (const camera of cameras) project.map.entities.push({ id: camera.id, name: camera.name || camera.id,
    type: 'camera', x: camera.x ?? 0, y: camera.y ?? 0, angle: camera.angle ?? 0, ...camera });
  validateProject(project);
  return project;
}

function play(project, seconds = 0, dt = 1 / 60) {
  const state = createRuntime(project);
  const frames = Math.max(1, Math.round(seconds / dt));
  for (let index = 0; index < frames; index++) stepRuntime(project, state, dt, new Set());
  return state;
}

test('the camera commands are part of the catalogue the editor and validator share', () => {
  for (const type of ['createCamera', 'switchCamera', 'setCameraPosition', 'setCameraAngle', 'setCameraFov',
    'moveCamera', 'followCamera']) {
    assert.ok(ACTIONS.includes(type), `${type} is an action`);
  }
  for (const type of ['cameraActive', 'cameraFovCompare']) assert.ok(CONDITIONS.includes(type), `${type} is a condition`);
  // The node the scene editor offers is the same object type the runtime drives.
  const node = SCENE_NODE_TYPES.find(type => type.id === 'camera');
  assert.equal(node.defaults.type, 'camera');
  assert.equal(node.defaults.nodeKind, 'camera');
  assert.ok(NODE_KINDS.includes('camera'), 'the node kind is registered');
});

test('a placed camera can open the level, and its own field of view is what the view uses', () => {
  const project = projectWith([], [{ id: 'cam_intro', name: 'Intro', x: 100, y: 200, z: 300,
    angle: 90, cameraFov: 60, cameraHeight: 32, cameraActive: true }]);
  const state = createRuntime(project);
  assert.equal(state.viewCamera, 'cam_intro', 'the level opens on the camera marked active');
  assert.equal(viewFov(state), 60);
  const camera = activeCamera(state);
  assert.deepEqual(cameraEye(camera), { x: 100, y: 200, z: 332 }, 'the eye sits at the height plus its own offset');
});

test('a rule creates a camera, switches to it, and hands the view back to the player', () => {
  const project = projectWith([
    rule('make', { type: 'onStart' }, [
      { type: 'createCamera', x: 64, y: 128, z: 200, angle: 45, pitch: -10, fov: 70, name: 'Flyby', activate: 'yes' },
    ]),
  ]);
  const state = play(project, 0.05);
  const camera = findCamera(state, 'Flyby');
  assert.ok(camera, 'the camera is found by the name the rule gave it');
  assert.equal(camera.type, 'camera');
  assert.equal(state.viewCamera, camera.id, 'activate = yes hands the view over');
  assert.equal(camera.cameraFov, 70);
  assert.equal(camera.cameraPitch, -10);
  assert.equal(camera.cameraHeight, CAMERA_DEFAULTS.height);
  assert.deepEqual(cameraEye(camera), { x: 64, y: 128, z: 200 + CAMERA_DEFAULTS.height });
  validateProject(project, { fast: true });
});

test('position, angle and field of view can be set from a rule, and the player view takes fov too', () => {
  const project = projectWith([
    rule('make', { type: 'onStart' }, [
      { type: 'createCamera', x: 0, y: 0, z: 0, angle: 0, pitch: 0, fov: 90, name: 'Cam', activate: 'yes' },
    ]),
    rule('point', { type: 'everySeconds', seconds: 0.01 }, [
      { type: 'setCameraPosition', camera: 'Cam', x: 256, y: 512, z: 96 },
      { type: 'setCameraAngle', camera: 'Cam', angle: 180, pitch: 25 },
      { type: 'setCameraFov', camera: 'Cam', fov: 125 },
    ]),
  ]);
  const state = play(project, 0.1);
  const camera = findCamera(state, 'Cam');
  assert.deepEqual([camera.x, camera.y, camera.z, camera.angle, camera.cameraPitch, camera.cameraFov],
    [256, 512, 96, 180, 25, 125]);
  // Zooming the player's own view is the game's field of view, which is what the renderer reads.
  const zoom = play(projectWith([rule('zoom', { type: 'onStart' }, [
    { type: 'setCameraFov', camera: '$player', fov: 60 },
  ])]), 0.05);
  assert.equal(zoom.settings.fov, 60);
});

test('a camera glides to a point over the time it was given', () => {
  const project = projectWith([
    rule('make', { type: 'onStart' }, [
      { type: 'createCamera', x: 0, y: 0, z: 0, angle: 0, pitch: 0, fov: 90, name: 'Glide', activate: 'yes' },
    ]),
    rule('move', { type: 'everySeconds', seconds: 100 }, [
      { type: 'moveCamera', camera: 'Glide', x: 200, y: 400, angle: 90, seconds: 2, easing: 'linear' },
    ]),
  ]);
  const state = play(project, 0.1);
  const camera = findCamera(state, 'Glide');
  // On start fires on the first frame, so the glide has just begun: the camera is still at its from.
  assert.ok(camera.x >= 0 && camera.x < 40, `started at ${camera.x}`);
  for (let index = 0; index < 60; index++) stepRuntime(project, state, 1 / 60, new Set());
  const midway = camera.x;
  assert.ok(midway > 40 && midway < 200, `half way through the glide, x is ${midway}`);
  for (let index = 0; index < 90; index++) stepRuntime(project, state, 1 / 60, new Set());
  assert.ok(Math.abs(camera.x - 200) < 1e-6, 'the glide lands exactly on the point it was given');
  assert.ok(Math.abs(camera.y - 400) < 1e-6);
  assert.equal(camera.angle, 90);
  assert.equal(state.cameraMoves.size, 0, 'a finished glide is dropped instead of running forever');
});

test('switching to a camera that does not exist says so instead of silently keeping the player view', () => {
  const project = projectWith([rule('switch', { type: 'onStart' }, [{ type: 'switchCamera', camera: 'Missing' }])]);
  assert.throws(() => play(project, 0.05), /names the camera "Missing"/);
});

test('a camera follows an object and rides its height', () => {
  const project = projectWith([
    rule('make', { type: 'onStart' }, [
      { type: 'createCamera', x: 0, y: 0, z: 0, angle: 0, pitch: 0, fov: 90, name: 'Chase', activate: 'yes' },
      { type: 'followCamera', camera: 'Chase', target: '$player', copyAngle: 'yes' },
    ]),
  ]);
  const state = play(project, 0.1);
  const camera = findCamera(state, 'Chase');
  const player = state.entities.find(entity => entity.type === 'player');
  assert.ok(Math.abs(camera.x - player.x) < 1e-6, 'the camera sits over the player');
  assert.ok(Math.abs(camera.y - player.y) < 1e-6);
  assert.ok(Math.abs(camera.angle - (-(player.angle || 0) * 180 / Math.PI)) < 1e-6,
    'following the player matches the angle convention the renderer uses for a camera');
});

test('camera conditions read the view that is in use', () => {
  const project = projectWith([
    // "This object is the active view" is an object script's condition: the object is the camera.
    rule('watch', { type: 'cameraActive', entityId: '$self' }, [{ type: 'setVariable', variable: 'score', value: 7 }],
      { ownerId: 'cam_intro', once: true }),
    rule('fov', { type: 'cameraFovCompare', operator: '<', value: 90 }, [
      { type: 'addVariable', variable: 'score', value: 3 },
    ], { once: true }),
  ], [{ id: 'cam_intro', name: 'Intro', x: 0, y: 0, cameraFov: 60, cameraActive: true }]);
  const state = play(project, 0.1);
  // Both rules are one-shot: the first writes 7, the second adds 3 because 60 < 90.
  assert.equal(state.variables.score, 10, 'the placed camera is the active view and its field of view is read');
});

test('a camera made during play survives a save with the pose the glide had reached', () => {
  const project = projectWith([
    rule('make', { type: 'onStart' }, [
      { type: 'createCamera', x: 0, y: 0, z: 0, angle: 0, pitch: 0, fov: 90, name: 'Saved', activate: 'yes' },
    ]),
    rule('move', { type: 'everySeconds', seconds: 100 }, [
      { type: 'moveCamera', camera: 'Saved', x: 300, y: 0, seconds: 10, easing: 'linear' },
    ]),
  ]);
  const state = play(project, 1.1);
  const camera = findCamera(state, 'Saved');
  assert.ok(camera.x > 10 && camera.x < 300, 'mid-glide');
  // A save only exists inside a started game, which is what the game menu creates.
  state.hasGame = true;
  const saved = captureGameSave(project, state, 'test-level');
  const { runtime: restored } = restoreGameSave(project, saved, 'test-level');
  const after = findCamera(restored, 'Saved');
  assert.ok(after, 'the camera comes back');
  assert.ok(Math.abs(after.x - camera.x) < 1e-6, 'with the position it was saved at');
  assert.equal(restored.viewCamera, after.id, 'and the view is still looking through it');
});

test('an imported ChangeCamera actor is still a valid viewer, without a camera field of view', () => {
  // GZDoom's ChangeCamera nominates any actor, and an imported title map relies on it. Such a
  // viewer has no `cameraFov`, so the view keeps the game's setting rather than losing the view.
  const project = projectWith([], []);
  project.map.entities.push({ id: 'camera_actor', name: 'SecurityCamera', type: 'decoration',
    x: 0, y: 0, angle: 0, cameraHeight: 8 });
  validateProject(project);
  const state = createRuntime(project);
  state.viewCamera = 'camera_actor';
  assert.equal(activeCamera(state), null, 'it is not a camera object');
  assert.equal(viewFov(state), state.settings.fov, 'and it films at the game setting');
  assert.equal(findCamera(state, 'SecurityCamera'), null, 'a camera command does not take it for one');
});

test('a camera node is an object a scene can hold', () => {
  const node = createSceneNode({ id: 'scene_test', name: 'Test', entities: [], events: [] }, 'camera', { x: 32, y: 64 });
  assert.equal(node.type, 'camera');
  assert.equal(node.cameraFov, 90);
  assert.equal(node.cameraHeight, 48);
  assert.deepEqual([node.x, node.y], [32, 64]);
});

test('a camera object that carries nonsense numbers is rejected before it can reach the renderer', () => {
  const broken = createProject();
  broken.map.entities.push({ id: 'cam_bad', type: 'camera', name: 'Bad', x: 0, y: 0, angle: 0, cameraFov: 400 });
  assert.throws(() => validateProject(broken), /Camera field of view/);
  const pitch = createProject();
  pitch.map.entities.push({ id: 'cam_bad', type: 'camera', name: 'Bad', x: 0, y: 0, angle: 0, cameraPitch: 200 });
  assert.throws(() => validateProject(pitch), /Camera pitch/);
});
