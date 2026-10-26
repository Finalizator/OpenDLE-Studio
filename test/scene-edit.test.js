import test from 'node:test';
import assert from 'node:assert/strict';
import { addRoom, createProject, validateProject } from '../shared/project.js';
import { dragSelection, transformSelection } from '../shared/scene-edit.js';

const delta = (values = {}) => ({ x: 0, y: 0, z: 0, ...values });
test('3D object movement snaps edited axes, preserves untouched axes and authored project validation', () => {
  const project = createProject();
  const entity = project.map.entities[1]; entity.x = 163; entity.elevation = 5;
  transformSelection(project, { kind: 'entity', id: entity.id }, 'move', delta({ z: 23 }), 16);
  assert.equal(entity.x, 163); assert.equal(entity.y, 0); assert.equal(entity.elevation, 32);
  transformSelection(project, { kind: 'entity', id: entity.id }, 'move', delta({ x: 35, y: -17 }), 16);
  assert.deepEqual([entity.x, entity.y, entity.elevation], [192, -16, 32]);
  validateProject(project);
});
test('3D horizontal movement preserves world height when crossing sector floors', () => {
  const project = createProject();
  addRoom(project, { x: 512, y: -128, width: 256, depth: 256 });
  project.map.sectors[1].floorHeight = 64;
  const entity = project.map.entities[1];
  entity.elevation = 80;
  transformSelection(project, { kind: 'entity', id: entity.id }, 'move', delta({ x: 480 }), 16);
  assert.deepEqual([entity.x, entity.y, entity.elevation], [640, 0, 16]);
  transformSelection(project, { kind: 'entity', id: entity.id }, 'move', delta({ x: -480 }), 16);
  assert.deepEqual([entity.x, entity.y, entity.elevation], [160, 0, 80]);
  validateProject(project);
});
test('3D rotation and visual scaling keep physics primitive sizes unchanged', () => {
  const project = createProject(), entity = project.map.entities[1];
  entity.physics = { body: 'dynamic', shape: 'box', width: 24, height: 40, depth: 24, radius: 12,
    mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true };
  const physics = structuredClone(entity.physics);
  transformSelection(project, { kind: 'entity', id: entity.id }, 'rotate', { angle: 45 }, 16);
  transformSelection(project, { kind: 'entity', id: entity.id }, 'scale', { scale: 2 }, 16);
  assert.equal(entity.angle, 45); assert.equal(entity.spriteScale, 2);
  entity.modelAsset = 'model';
  transformSelection(project, { kind: 'entity', id: entity.id }, 'scale', { scale: 2 }, 16);
  assert.equal(entity.modelScale, 64);
  assert.deepEqual(entity.physics, physics);
  assert.throws(() => transformSelection(project, { kind: 'entity', id: 'player' }, 'scale', { scale: 2 }, 16), /fixed size/);
});
test('3D geometry edits support vertex and wall endpoint translation and independent floor/ceiling handles', () => {
  const project = createProject();
  transformSelection(project, { kind: 'vertex', id: 'v1' }, 'move', delta({ x: -18 }), 16);
  assert.equal(project.map.vertices[0].x, -400);
  transformSelection(project, { kind: 'wall', id: 'w1' }, 'move', delta({ y: -32 }), 16);
  assert.equal(project.map.vertices[0].y, -288); assert.equal(project.map.vertices[1].y, -288);
  transformSelection(project, { kind: 'sector', id: 'room0', surface: 'ceilingHeight' }, 'move', delta({ z: 32 }), 16);
  transformSelection(project, { kind: 'sector', id: 'room0' }, 'move', delta({ z: 16 }), 16);
  assert.equal(project.map.sectors[0].ceilingHeight, 160); assert.equal(project.map.sectors[0].floorHeight, 16);
  validateProject(project);
  assert.throws(() => transformSelection(project, { kind: 'wall', id: 'w1' }, 'rotate', { angle: 30 }, 16), /objects only/);
  assert.throws(() => transformSelection(project, { kind: 'entity', id: 'missing' }, 'move', delta(), 16), /no longer exists/);
});

test('live drags are absolute: repeating the same pointer offset never drifts or sticks', () => {
  const project = createProject();
  const baseline = structuredClone(project);
  const wall = project.map.walls[0];
  const start = structuredClone(wall);
  // Grid snapping must not swallow repeated sub-grid increments: every frame is
  // solved against the drag baseline, exactly like a real pointer drag.
  for (const offset of [2, 4, 6, 8, 10, 12]) {
    dragSelection(project, baseline, { kind: 'vertex', id: wall.a }, 'move', { x: offset, y: 0, z: 0 }, 16);
    const vertex = project.map.vertices.find(vertex => vertex.id === wall.a);
    const original = baseline.map.vertices.find(vertex => vertex.id === wall.a);
    assert.equal(vertex.x, Math.round((original.x + offset) / 16) * 16);
  }
  const final = project.map.vertices.find(vertex => vertex.id === wall.a);
  dragSelection(project, baseline, { kind: 'vertex', id: wall.a }, 'move', { x: 0, y: 0, z: 0 }, 16);
  assert.equal(project.map.vertices.find(vertex => vertex.id === wall.a).x,
    baseline.map.vertices.find(vertex => vertex.id === wall.a).x);
  assert.notEqual(final.x, start.x + start.x);
  dragSelection(project, baseline, { kind: 'wall', id: wall.id }, 'move', { x: 48, y: 0, z: 0 }, 16);
  for (const id of [start.a, start.b]) {
    const original = baseline.map.vertices.find(vertex => vertex.id === id);
    assert.equal(project.map.vertices.find(vertex => vertex.id === id).x, original.x + 48);
  }
});

test('live drags measure sector and object changes from the drag baseline', () => {
  const project = createProject();
  const baseline = structuredClone(project);
  const sector = project.map.sectors[0], entity = project.map.entities[1];
  const floor = baseline.map.sectors[0].floorHeight, angle = baseline.map.entities[1].angle;
  for (const height of [32, 64, 96]) {
    dragSelection(project, baseline, { kind: 'sector', id: sector.id, surface: 'floorHeight' }, 'move', { x: 0, y: 0, z: height }, 16);
    assert.equal(project.map.sectors[0].floorHeight, floor + height);
  }
  dragSelection(project, baseline, { kind: 'sector', id: sector.id, surface: 'floorHeight' }, 'move', { x: 0, y: 0, z: 0 }, 16);
  assert.equal(project.map.sectors[0].floorHeight, floor);
  for (const turn of [30, 60, 90]) {
    dragSelection(project, baseline, { kind: 'entity', id: entity.id }, 'rotate', { angle: turn }, 16);
    assert.equal(project.map.entities[1].angle, angle + turn);
  }
  for (const scale of [.5, 1, 2]) {
    dragSelection(project, baseline, { kind: 'entity', id: entity.id }, 'scale', { scale }, 16);
    assert.equal(project.map.entities[1].spriteScale, scale);
  }
  validateProject(project);
});

test('live drags refuse to invent selections that the baseline never had', () => {
  const project = createProject(), baseline = structuredClone(project);
  assert.throws(() => dragSelection(project, baseline, { kind: 'vertex', id: 'v_missing' }, 'move', { x: 16, y: 0, z: 0 }, 16),
    /no longer exists/);
  const wall = project.map.walls[0];
  const broken = structuredClone(baseline);
  broken.map.walls = broken.map.walls.filter(item => item.id !== wall.id);
  assert.throws(() => dragSelection(project, broken, { kind: 'wall', id: wall.id }, 'move', { x: 16, y: 0, z: 0 }, 16),
    /drag started/);
});
