import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createPhysics } from '../shared/physics.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { newJoint } from '../shared/joints.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const box = (bodyType, extra = {}) => ({ body: bodyType, shape: 'box', width: 32, height: 32, depth: 32, radius: 16,
  mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: false, ...extra });

function scene(t, configure = () => {}, { validate = true } = {}) {
  const project = createProject();
  project.events = [];
  configure(project);
  if (validate) validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const tick = (count = 1) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, new Set(), new Set());
  };
  const at = id => state.entities.find(entity => entity.id === id);
  return { project, state, tick, at };
}

/** Two objects: a fixed mount up in the air and a dynamic part hanging under it. */
function rig(project, joint) {
  project.map.entities.push(
    { id: 'mount', name: 'Mount', type: 'decoration', x: 0, y: 0, angle: 0, elevation: 256, physics: box('fixed') },
    { id: 'part', name: 'Part', type: 'decoration', x: 0, y: 0, angle: 0, elevation: 192, physics: box('dynamic') },
  );
  project.map.joints = [joint];
}

test('a rope holds a dynamic object up instead of letting it fall', t => {
  const { tick, at } = scene(t, project => {
    rig(project, newJoint({ type: 'rope', a: 'mount', b: 'part', anchor: { x: 0, y: 0, z: 272 }, length: 64 }));
  });
  const start = at('part').z;
  tick(180);
  const held = at('part').z;
  assert.ok(held > start - 96, `held at ${held} (started ${start}); the floor would be 0`);
});

test('a fixed joint welds an object to its mount', t => {
  const { tick, at } = scene(t, project => {
    rig(project, newJoint({ type: 'fixed', a: 'mount', b: 'part', anchor: { x: 0, y: 0, z: 272 } }));
  });
  tick(180);
  // Welded, the part hangs where the joint keeps it instead of dropping to the floor.
  assert.ok(at('part').z > 100, `welded part at ${at('part').z}`);
});

test('a joint to the world pins an object at the anchor', t => {
  const { tick, at } = scene(t, project => {
    project.map.entities.push({ id: 'swing', name: 'Swing', type: 'decoration', x: 64, y: 0, angle: 0, elevation: 192,
      physics: box('dynamic') });
    project.map.joints = [newJoint({ type: 'rope', a: 'swing', b: null, anchor: { x: 64, y: 0, z: 224 }, length: 64 })];
  });
  tick(180);
  const z = at('swing').z;
  assert.ok(z > 64, `a world-anchored rope keeps the object near the anchor (z=${z})`);
});

test('hinge, slider, ball socket and spring joints all build and step', t => {
  const types = ['revolute', 'prismatic', 'spherical', 'spring'];
  for (const type of types) {
    const { tick, at } = scene(t, project => {
      rig(project, newJoint({ type, a: 'mount', b: 'part', anchor: { x: 0, y: 0, z: 272 },
        limits: type === 'revolute' || type === 'prismatic' ? { min: -1, max: 1 } : undefined }));
    });
    tick(60);
    assert.ok(Number.isFinite(at('part').z), `${type} keeps stepping`);
  }
});

test('cylinder and cone colliders rest on the floor like boxes do', t => {
  for (const shape of ['cylinder', 'cone']) {
    const { tick, at } = scene(t, project => {
      const part = project.map.entities[1];
      part.physics = box('dynamic', { shape, width: 32, height: 40, depth: 32, radius: 16 });
      part.elevation = 96;
    });
    tick(180);
    assert.ok(Math.abs(at('pickup').z) < 2, `${shape} body rests on the floor (z=${at('pickup').z})`);
  }
});

test('a joint that references a missing object is skipped instead of breaking the level', t => {
  const { tick } = scene(t, project => {
    project.map.entities.push({ id: 'solo', name: 'Solo', type: 'decoration', x: 0, y: 0, angle: 0, elevation: 128,
      physics: box('dynamic') });
    project.map.joints = [newJoint({ type: 'fixed', a: 'solo', b: 'ghost', anchor: { x: 0, y: 0, z: 128 } })];
  }, { validate: false });
  assert.doesNotThrow(() => tick(30));
});
