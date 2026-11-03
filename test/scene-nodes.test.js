import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { rotationDetent } from '../shared/gizmo-math.js';
import { newScene, addSceneObject, setSceneObjectAsset, addSceneObjectFromAsset } from '../shared/scenes.js';
import { SCENE_NODE_TYPES, createSceneNode, sceneNodeDimensions, sceneNodeLabel, sceneNodeSupportsTilt, transformSceneNodes } from '../shared/scene-nodes.js';
import { createProject, validateProject } from '../shared/project.js';
import { modelOrientation, modelPoseFromOrientation, rotateQuaternion, multiplyQuaternion, axisRotation } from '../shared/entity-visuals.js';

test('node-editor pointer previews honor Alt movement precision and absolute 45-degree rotation detents', () => {
  const source = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function previewTransform('), end = source.indexOf('\n  function localPoint(', start);
  assert.ok(start >= 0 && end > start);
  const baseline = newScene('Precision'), root = createSceneNode(baseline, 'box', { x: 3, y: 5, angle: 17 });
  let delta = { x: .125, y: 0 };
  const context = {
    structuredClone, transformSceneNodes, rotationDetent, GRID: 32, previewScene: null,
    state: { snap: true, view3d: true }, view3d: { transformDelta: () => ({ ...delta }) },
    sync3d() {}, draw() {}, cancelTransform() { throw new Error('Unexpected transform cancellation'); },
    callbacks: { status(message) { throw new Error(message); } },
    drag: { id: root.id, baseline, mode: 'move', spatial: {}, startX: 0, startY: 0 },
    event: { clientX: 5, clientY: 5, altKey: true },
  };
  const preview = () => runInNewContext(`${source.slice(start, end)}\npreviewTransform(event, drag);`, context);
  preview();
  assert.equal(context.previewScene.entities[0].x, 3.125);
  context.event.altKey = false; preview();
  assert.equal(context.previewScene.entities[0].x, 0, 'releasing Alt immediately restores grid snapping');
  context.drag.mode = 'rotate'; delta = { axis: 'z', angle: 26 }; preview();
  assert.ok(Math.abs(context.previewScene.entities[0].angle - 45) < 1e-8);
  context.event.ctrlKey = true; preview();
  assert.ok(Math.abs(context.previewScene.entities[0].angle - 43) < 1e-8, 'Ctrl bypasses the rotation detent');
  context.event.ctrlKey = false; delta.angle = 10.5; preview();
  assert.ok(Math.abs(context.previewScene.entities[0].angle - 27.5) < 1e-8, 'other angles remain free with grid enabled');
});

test('node catalog creates independent, useful component presets', () => {
  const scene = newScene('Components');
  assert.ok(SCENE_NODE_TYPES.length >= 20);
  for (const kind of SCENE_NODE_TYPES) {
    const node = createSceneNode(scene, kind.id);
    assert.ok(node.name);
    assert.equal(sceneNodeLabel(node).length > 0, true);
    const project = createProject('Catalog');
    project.scenes = [{ ...scene, entities: [structuredClone(node)] }];
    validateProject(project);
  }
  const sprite = createSceneNode(scene, 'sprite');
  sprite.spritePlane.width = 100;
  assert.equal(createSceneNode(scene, 'sprite').spritePlane.width, 64);
  assert.throws(() => createSceneNode(scene, 'invented'), /Unknown scene node/);
});

test('form follows a rotated mesh face while keeping its opposite face pinned', () => {
  const scene = newScene('Rotated');
  const node = createSceneNode(scene, 'box', { angle: 90 });
  const before = structuredClone(scene);
  transformSceneNodes(scene, before, node.id, 'form', { axis: 'x', side: 1, amount: 32 });
  assert.ok(Math.abs(node.x) < 1e-8);
  assert.equal(node.y, 16);
  assert.equal(node.y - node.mesh.width / 2, -32);
});

test('tilt tools are limited to node kinds with actual runtime orientation support', () => {
  const scene = newScene('Rotation support');
  for (const kind of ['box', 'sprite', 'projector', 'terminal', 'node3d', 'body']) {
    assert.equal(sceneNodeSupportsTilt(createSceneNode(scene, kind)), true, kind);
  }
  for (const kind of ['panel', 'area', 'billboard', 'enemy']) {
    const node = createSceneNode(scene, kind);
    assert.equal(sceneNodeSupportsTilt(node), false, kind);
    assert.throws(() => transformSceneNodes(scene, structuredClone(scene), node.id, 'rotate',
      { axis: 'x', angle: 30 }), /yaw rotation only/);
  }
  assert.equal(sceneNodeSupportsTilt({ modelAsset: 'model', type: 'enemy' }), true);
  assert.equal(sceneNodeSupportsTilt({ spritePlane: { billboard: true } }), false);
});

function branch() {
  const scene = newScene('Branch');
  const root = createSceneNode(scene, 'box', { x: 17, y: 25, elevation: 16 });
  const child = createSceneNode(scene, 'sprite', { parentId: root.id, x: 81, y: 25, elevation: 48 });
  const other = addSceneObject(scene, { x: -40, y: 11 });
  return { scene, root, child, other, baseline: structuredClone(scene) };
}

test('node translation snaps changed axes only and previews never accumulate', () => {
  const { scene, root, child, other, baseline } = branch();
  transformSceneNodes(scene, baseline, root.id, 'move', { x: 40, z: 32 }, 32);
  assert.deepEqual([root.x, root.y, root.elevation], [64, 25, 64]);
  assert.deepEqual([child.x, child.y, child.elevation], [128, 25, 96]);
  transformSceneNodes(scene, baseline, root.id, 'move', { x: 40, z: 32 }, 32);
  assert.deepEqual([root.x, root.y, root.elevation], [64, 25, 64]);
  assert.deepEqual(other, baseline.entities[2]);
  assert.equal(baseline.entities[0].x, 17);
});

test('scene yaw and uniform scale carry child positions and visual dimensions', () => {
  const { scene, root, child, baseline } = branch();
  transformSceneNodes(scene, baseline, root.id, 'rotate', { angle: 90 });
  assert.ok(Math.abs(child.x - root.x) < 1e-8);
  assert.equal(child.y, 89);
  assert.equal(child.angle, 90);
  transformSceneNodes(scene, baseline, root.id, 'scale', { scale: 2 });
  assert.deepEqual([child.x, child.y, child.elevation], [145, 25, 80]);
  assert.equal(root.mesh.width, 128);
  assert.equal(child.spritePlane.height, 128);
});

test('arbitrary branch rotations preserve each child orientation instead of adding Euler angles', () => {
  const { scene, root, child, baseline } = branch();
  Object.assign(root, { angle: 35, modelTilt: { pitch: 20, roll: 15 } });
  Object.assign(child, { angle: -50, modelTilt: { pitch: 10, roll: -25 } });
  Object.assign(baseline, structuredClone(scene));
  const turn = axisRotation([1, 0, 0], 40);
  const expected = multiplyQuaternion(turn, modelOrientation(child));
  transformSceneNodes(scene, baseline, root.id, 'rotate', { axis: 'x', angle: 40 });
  const actual = modelOrientation(child);
  for (const point of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const a = rotateQuaternion(point, actual), b = rotateQuaternion(point, expected);
    for (let index = 0; index < 3; index++) assert.ok(Math.abs(a[index] - b[index]) < 1e-8);
  }
  const next = structuredClone(scene), target = root.modelTilt.pitch + 10;
  transformSceneNodes(scene, next, root.id, 'rotate', { axis: 'x', angle: 10, local: true });
  assert.ok(Math.abs(root.modelTilt.pitch - target) < 1e-7);
});

test('pose decomposition round trips yaw, pitch and roll including a vertical pose', () => {
  for (const pose of [
    { angle: 30, modelTilt: { pitch: 20, roll: 60 } },
    { angle: -120, modelTilt: { pitch: 90, roll: 25 } },
    { angle: 179, modelTilt: { pitch: -85, roll: -170 } },
  ]) {
    const q = modelOrientation(pose), recovered = modelOrientation(modelPoseFromOrientation(q));
    for (const point of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const a = rotateQuaternion(point, q), b = rotateQuaternion(point, recovered);
      for (let index = 0; index < 3; index++) assert.ok(Math.abs(a[index] - b[index]) < 1e-7);
    }
  }
});

test('forming a tilted surface pins its opposite face in actual runtime orientation', () => {
  const scene = newScene('Tilted');
  const node = createSceneNode(scene, 'box', { angle: 35, modelTilt: { pitch: 30, roll: 15 } });
  const before = structuredClone(scene);
  const q = modelOrientation(node), axis = rotateQuaternion([0, 1, 0], q);
  const pinned = [node.x - axis[0] * 32, node.elevation + 32 - axis[1] * 32, node.y - axis[2] * 32];
  transformSceneNodes(scene, before, node.id, 'form', { axis: 'z', side: 1, amount: 32 });
  const after = [node.x - axis[0] * 48, node.elevation + 48 - axis[1] * 48, node.y - axis[2] * 48];
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(pinned[index] - after[index]) < 1e-7);
});

test('axis scaling changes matching geometry and colliders, not unrelated dimensions', () => {
  const scene = newScene('Body');
  const root = createSceneNode(scene, 'body');
  transformSceneNodes(scene, structuredClone(scene), root.id, 'scale', { scale: 2, axis: 'z' });
  assert.equal(root.mesh.height, 128);
  assert.equal(root.physics.height, 128);
  assert.equal(root.mesh.width, 64);
  assert.equal(root.physics.width, 64);
});

test('scaling spatial media changes their actual radius without unused sprite-scale fields', () => {
  const scene = newScene('Media scale');
  for (const kind of ['sound', 'light']) {
    const node = createSceneNode(scene, kind);
    const radius = node[kind].radius;
    transformSceneNodes(scene, structuredClone(scene), node.id, 'scale', { scale: 2, axis: 'y' });
    assert.equal(node[kind].radius, Math.min(8192, radius * 2));
    assert.equal(node.spriteScale, undefined);
  }
});

test('forming capsule height cannot translate it when already at its minimum diameter', () => {
  const scene = newScene('Capsule');
  const node = createSceneNode(scene, 'area', { area: { shape: 'capsule', radius: 32, height: 64 } });
  const before = structuredClone(scene);
  transformSceneNodes(scene, before, node.id, 'form', { axis: 'z', side: 1, amount: -48 });
  assert.equal(node.area.height, 64);
  assert.equal(node.elevation || 0, before.entities[0].elevation || 0);
});

test('round areas resize their actual radius rather than an unused box field', () => {
  const scene = newScene('Sphere');
  const node = createSceneNode(scene, 'area');
  node.area.shape = 'sphere';
  transformSceneNodes(scene, structuredClone(scene), node.id, 'scale', { scale: 2, axis: 'x' });
  assert.equal(node.area.radius, 128);
  assert.deepEqual(sceneNodeDimensions(node), { width: 256, height: 256, depth: 256 });
});

test('moving an entire jointed branch carries its internal anchors only', () => {
  const { scene, root, child, other } = branch();
  scene.joints = [
    { id: 'inside', a: root.id, b: child.id, anchor: { x: 49, y: 25, z: 32 } },
    { id: 'outside', a: root.id, b: other.id, anchor: { x: 0, y: 0, z: 0 } },
  ];
  transformSceneNodes(scene, structuredClone(scene), root.id, 'move', { x: 16, z: 8 });
  assert.deepEqual(scene.joints[0].anchor, { x: 65, y: 25, z: 40 });
  assert.deepEqual(scene.joints[1].anchor, { x: 0, y: 0, z: 0 });
});

test('form pins the opposite face, including bottom-anchored vertical geometry', () => {
  const scene = newScene('Form');
  const node = createSceneNode(scene, 'box', { elevation: 16 });
  const baseline = structuredClone(scene);
  transformSceneNodes(scene, baseline, node.id, 'form', { axis: 'x', side: 1, amount: 32 });
  assert.equal(node.x - node.mesh.width / 2, -32);
  assert.equal(node.mesh.width, 96);
  transformSceneNodes(scene, baseline, node.id, 'form', { axis: 'z', side: 1, amount: 32 });
  assert.equal(node.elevation, 16);
  assert.equal(node.mesh.height, 96);
  transformSceneNodes(scene, baseline, node.id, 'form', { axis: 'z', side: -1, amount: -16 });
  assert.equal(node.elevation, 0);
  assert.equal(node.elevation + node.mesh.height, 80);
  assert.deepEqual(sceneNodeDimensions(node), { width: 64, height: 80, depth: 64 });
});

test('sound/video drops create real components, and images replace video projection sources', () => {
  const scene = newScene('Media');
  const sound = addSceneObjectFromAsset(scene, { id: 'snd', name: 'Loop', kind: 'sound' });
  assert.equal(sound.sound.assetId, 'snd');
  assert.equal(sound.sound.loop, true);
  const video = addSceneObjectFromAsset(scene, { id: 'vid', name: 'Screen', kind: 'video' });
  assert.equal(video.projector.assetId, 'vid');
  setSceneObjectAsset(scene, video.id, { id: 'img', kind: 'texture', name: 'Image' });
  assert.equal(video.projector.assetId, 'img');
  assert.equal(video.spriteAsset, undefined);
});

test('node tools provide toolbar shortcuts, accessible fields and cancellable local previews', () => {
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const tool of ['select', 'move', 'rotate', 'scale', 'form']) assert.ok(html.includes(`data-scene-transform="${tool}"`));
  assert.match(editor, /name\.htmlFor = control\.id/);
  assert.match(editor, /'pointercancel', \(\) => \{ cancelTransform\(\)/);
  assert.match(editor, /dialog\.showModal\(\)/);
  assert.match(editor, /previewScene = draft/);
  assert.match(editor, /Math\.hypot\(dx, dy\) < 3/);
  const picker = readFileSync(new URL('../public/asset-picker.js', import.meta.url), 'utf8');
  assert.match(picker, /if \(event\.target === window\) closeAssetPicker\(\)/);
});
