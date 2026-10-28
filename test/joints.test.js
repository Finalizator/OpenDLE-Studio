import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  JOINT_TYPES, JOINT_LABELS, MAX_JOINTS, newJoint, newJointId, validateJoint, remapJoint,
  jointsOf, pruneJoints, jointAnchorBetween, describeJoint,
} from '../shared/joints.js';
import { createProject, validateProject, removeEntity } from '../shared/project.js';
import { newScene, addSceneObject, instantiateScene, captureScene, removeSceneObjects,
  duplicateSceneObject, nestScene, reparentSceneObject } from '../shared/scenes.js';

function body(bodyType = 'dynamic') {
  return { body: bodyType, shape: 'box', width: 32, height: 32, depth: 32, radius: 16, mass: 1,
    friction: .7, restitution: 0, sensor: false, lockRotation: false };
}

function projectWithJoint() {
  const project = createProject();
  const mover = project.map.entities.find(entity => entity.type !== 'player');
  mover.physics = body('dynamic');
  const joint = newJoint({ type: 'revolute', a: mover.id, b: null, anchor: { x: 0, y: 0, z: 16 } });
  project.map.joints = [joint];
  return { project, mover, joint };
}

test('a joint carries the defaults its type needs', () => {
  for (const type of JOINT_TYPES) assert.ok(JOINT_LABELS[type], `${type} has a label`);
  const hinge = newJoint({ type: 'revolute' });
  assert.deepEqual(hinge.axis, { x: 0, y: 0, z: 1 });
  assert.equal(hinge.limits, undefined);
  const slider = newJoint({ type: 'prismatic', axis: { x: 0, y: 3, z: 0 } });
  // Axes are normalised, so the engine never sees a scaled axis.
  assert.deepEqual(slider.axis, { x: 0, y: 1, z: 0 });
  const spring = newJoint({ type: 'spring', length: 128, stiffness: 250, damping: 4 });
  assert.deepEqual([spring.length, spring.stiffness, spring.damping], [128, 250, 4]);
  const rope = newJoint({ type: 'rope' });
  assert.ok(rope.length > 0);
  assert.match(hinge.id, /^joint_[0-9a-z]+$/);
  assert.notEqual(newJointId(), newJointId());
  const named = newJoint({ type: 'fixed', name: 'Weld', limits: { min: 0, max: 1 } });
  // A fixed joint has no limits, because it has no free coordinate.
  assert.equal(named.limits, undefined);
});

test('joint validation refuses the shapes that cannot be built', () => {
  const ids = new Set(['a1', 'b1']);
  const valid = newJoint({ type: 'revolute', a: 'a1', b: 'b1' });
  assert.doesNotThrow(() => validateJoint(valid, { ids }));
  assert.throws(() => validateJoint({ ...valid, type: 'wobble' }, { ids }), /unknown type/);
  assert.throws(() => validateJoint({ ...valid, a: 'a1', b: 'a1' }, { ids }), /attach an object to itself/);
  assert.throws(() => validateJoint({ ...valid, a: null, b: null }, { ids }), /at least one object/);
  assert.throws(() => validateJoint({ ...valid, b: 'ghost' }, { ids }), /unknown object ghost/);
  assert.throws(() => validateJoint({ ...valid, axis: { x: 0, y: 0, z: 0 } }, { ids }), /axis cannot be zero/);
  assert.throws(() => validateJoint({ ...valid, limits: { min: 2, max: 1 } }, { ids }), /limits end before they start/);
  assert.throws(() => validateJoint({ ...valid, motor: { target: 'fast' } }, { ids }), /motor target/);
  assert.throws(() => validateJoint({ ...valid, anchor: { x: 'left', y: 0, z: 0 } }, { ids }), /anchor x must be a number/);
  assert.throws(() => validateJoint({ ...valid, id: '' }, { ids }), /needs an id/);
  // A joint to the world is a fixed pivot, which is legal.
  assert.doesNotThrow(() => validateJoint({ ...valid, b: null }, { ids }));
});

test('a level joint needs objects that actually have rigid bodies', () => {
  const { project, mover } = projectWithJoint();
  assert.doesNotThrow(() => validateProject(project));
  mover.physics = { ...mover.physics, body: 'none' };
  assert.throws(() => validateProject(project), /enabled rigid body/);
});

test('deleting an object deletes the joints that held it', () => {
  const { project, mover, joint } = projectWithJoint();
  assert.equal(project.map.joints.length, 1);
  removeEntity(project, mover.id);
  assert.deepEqual(project.map.joints, []);
  assert.equal(joint.a, mover.id);
});

test('placing a scene re-points its joints at the copied objects', () => {
  const scene = newScene('Door');
  const frame = addSceneObject(scene, { name: 'Frame', physics: body('fixed') });
  const panel = addSceneObject(scene, { name: 'Panel', x: 32, physics: body('dynamic') });
  scene.joints = [newJoint({ type: 'revolute', a: frame.id, b: panel.id, anchor: { x: 16, y: 0, z: 16 } })];
  const placed = instantiateScene(scene, { x: 256, y: 128 });
  assert.equal(placed.joints.length, 1);
  const [joint] = placed.joints;
  assert.notEqual(joint.id, scene.joints[0].id);
  assert.equal(joint.a, placed.entities[0].id);
  assert.equal(joint.b, placed.entities[1].id);
  assert.deepEqual(joint.axis, { x: 0, y: 0, z: 1 });
});

test('scene joints follow their objects through capture, duplicate, nesting and removal', () => {
  const project = createProject();
  // The player cannot live in a scene, so the two objects are ordinary ones.
  const frame = { id: 'prop_frame', name: 'Frame', type: 'decoration', x: 0, y: 0, angle: 0, physics: body('fixed') };
  const panel = { id: 'prop_panel', name: 'Panel', type: 'decoration', x: 32, y: 0, angle: 0, physics: body('dynamic') };
  project.map.entities.push(frame, panel);
  project.map.joints = [newJoint({ type: 'revolute', a: frame.id, b: panel.id, anchor: { x: 0, y: 0, z: 16 } })];
  const scene = captureScene(project, [frame.id, panel.id], { name: 'Captured' });
  assert.equal(scene.joints.length, 1, 'a capture keeps the joints inside the group');

  const notCaptured = captureScene(project, [panel.id], { name: 'Partial' });
  assert.equal(notCaptured.joints.length, 0, 'a joint to an object left behind is dropped');

  // A joint is copied only when both of its ends are: duplicating just the frame leaves
  // the single existing joint alone, and duplicating a group that holds both copies it.
  const alone = scene.entities.find(entity => entity.name === 'Frame');
  duplicateSceneObject(scene, alone.id);
  assert.equal(scene.joints.length, 1, 'one end alone cannot copy the joint');
  reparentSceneObject(scene, scene.entities.find(entity => entity.name === 'Panel').id, alone.id);
  const duplicate = duplicateSceneObject(scene, alone.id);
  assert.equal(scene.joints.length, 2, 'duplicating a group copies the joint between its objects');
  const copy = scene.joints.find(joint => joint.id !== scene.joints[0].id);
  assert.ok(duplicate.ids.includes(copy.a) && duplicate.ids.includes(copy.b));

  const outer = newScene('Outer');
  const nested = nestScene(outer, scene, { x: 64, y: 64 });
  assert.equal(outer.joints.length, scene.joints.length, 'nesting carries the joints');
  assert.ok(outer.joints.every(joint => joint.a && joint.b));
  assert.equal(nested.joints.length, 2);

  const panelCopy = scene.entities.find(entity => entity.name.startsWith('Panel') && entity.id !== scene.entities[0].id);
  removeSceneObjects(scene, panelCopy.id);
  assert.ok(scene.joints.length < 2, 'removing an object removes the joints that held it');
  removeSceneObjects(scene, scene.entities.map(entity => entity.id));
  assert.deepEqual(scene.joints, [], 'no joint survives its objects');
});

test('a scene with a joint validates, and one pointing at a body-less node does not', () => {
  const project = createProject();
  const scene = newScene('Rig');
  const frame = addSceneObject(scene, { name: 'Frame', physics: body('fixed') });
  const panel = addSceneObject(scene, { name: 'Panel', physics: body('dynamic') });
  scene.joints = [newJoint({ type: 'prismatic', a: frame.id, b: panel.id, limits: { min: -32, max: 32 } })];
  project.scenes = [scene];
  assert.doesNotThrow(() => validateProject(project));
  delete panel.physics;
  assert.throws(() => validateProject(project), /enabled rigid body/);
});

test('joint helpers list, prune and describe the links of an object', () => {
  const a = newJoint({ type: 'fixed', a: 'one', b: 'two', name: 'Weld' });
  const b = newJoint({ type: 'rope', a: 'two', b: null });
  const c = newJoint({ type: 'spring', a: 'three', b: 'four' });
  assert.deepEqual(jointsOf([a, b, c], 'two').map(joint => joint.id), [a.id, b.id]);
  assert.deepEqual(pruneJoints([a, b, c], new Set(['one', 'two', 'three'])).map(joint => joint.id), [a.id, b.id].filter(id => id !== c.id));
  assert.deepEqual(pruneJoints([a, b, c], ['one', 'two']).map(joint => joint.id), [a.id, b.id].filter(id => id !== c.id));
  assert.match(describeJoint(a, () => 'Panel'), /Weld .*Panel/);
  assert.match(describeJoint(b), /the world/);
  assert.deepEqual(jointAnchorBetween({ x: 0, y: 0, physics: { height: 32 } }, { x: 64, y: 0, physics: { height: 32 } }),
    { x: 32, y: 0, z: 16 });
  assert.deepEqual(remapJoint(a, new Map([['two', 'copy']])).b, 'copy');
});

test('the joint budget is enforced when a scene passes it on', () => {
  const scene = newScene('Many');
  const first = addSceneObject(scene, { name: 'A', physics: body('fixed') });
  const second = addSceneObject(scene, { name: 'B', physics: body('dynamic') });
  for (let index = 0; index < MAX_JOINTS; index++) scene.joints = [...scene.joints, newJoint({ type: 'fixed', a: first.id, b: second.id })];
  assert.equal(scene.joints.length, MAX_JOINTS);
  // Duplicating cannot add joints past the budget, and it must not throw either.
  duplicateSceneObject(scene, first.id);
  assert.ok(scene.joints.length <= MAX_JOINTS);
});

test('the 3D view is a real renderer, not a picture of the scene', () => {
  const view = readFileSync(new URL('../public/scene-3d-view.js', import.meta.url), 'utf8');
  assert.match(view, /createBrowserRenderer\(THREE\.WebGPURenderer, canvas\)/);
  assert.match(view, /new GLTFLoader\(\)/);
  assert.match(view, /cloneModel\(loaded\.scene\)/);
  assert.match(view, /new THREE\.PointLight\(entity\.light\.color/);
  // Sprite nodes are camera-facing quads, and picking raycasts what is drawn.
  assert.match(view, /quad\.lookAt\(camera\.position\)/);
  assert.match(view, /Raycaster\(\)/);
  assert.match(view, /function pickNode\(clientX, clientY\)/);
  // The editor keeps its own camera model and hands it to the viewport.
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /import \{ createScene3dView \} from '\.\/scene-3d-view\.js';/);
  assert.match(editor, /view3d\.aimCamera\(/);
  assert.match(editor, /view3d\?\.pickNode\(event\.clientX, event\.clientY\)/);
  assert.match(editor, /async function ensure3d\(\)/);
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /<canvas id="scene-3d-canvas" tabindex="0" aria-label="Scene objects in 3D" hidden>/);
});
