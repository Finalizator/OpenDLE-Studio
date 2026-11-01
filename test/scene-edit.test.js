import test from 'node:test';
import assert from 'node:assert/strict';
import { addRoom, createProject, validateProject } from '../shared/project.js';
import { dragSelection, transformSelection, volumeAxis } from '../shared/scene-edit.js';
import { createPath } from '../shared/paths.js';

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

test('a waypoint drags in three axes and leaves the other axes where they were', () => {
  const project = createProject();
  project.paths = [createPath({ id: 'path_1', name: 'Route',
    points: [{ id: 'a', x: 160, y: -32, z: 0, curve: 1 }, { id: 'b', x: 320, y: 64, z: 16, curve: 1 }] })];
  validateProject(project);
  const selection = { kind: 'pathPoint', id: 'b', pathId: 'path_1' };
  const baseline = structuredClone(project);
  const point = () => project.paths[0].points[1];

  // Horizontal drags snap to the grid on both map axes.
  dragSelection(project, baseline, selection, 'move', { x: 17, y: -9, z: 0 }, 16);
  assert.deepEqual([point().x, point().y, point().z], [336, 48, 16], 'snapped x/y, untouched height');

  // The vertical handle moves only the height, and it snaps too.
  dragSelection(project, baseline, selection, 'move', { x: 0, y: 0, z: 21 }, 16);
  assert.deepEqual([point().x, point().y, point().z], [320, 64, 32], 'x/y restored from the baseline');

  // Both at once, from the same baseline: a drag re-runs each frame, so it has to be absolute.
  dragSelection(project, baseline, selection, 'move', { x: -64, y: 0, z: 16 }, 16);
  assert.deepEqual([point().x, point().y, point().z], [256, 64, 32]);

  transformSelection(project, selection, 'move', { x: 16, y: 0, z: 0 }, 16);
  assert.equal(point().x, 272, 'incremental moves stack');
  assert.throws(() => transformSelection(project, selection, 'rotate', { angle: 90 }, 16), /objects only/);
  assert.throws(() => dragSelection(project, baseline, { kind: 'pathPoint', id: 'missing', pathId: 'path_1' }, 'move', { x: 16, y: 0, z: 0 }, 16),
    /no longer exists/);
  validateProject(project);
  // A waypoint belongs to one path, so the same point id in another path is a different point.
  project.paths.push(createPath({ id: 'path_2', name: 'Other', points: [{ id: 'a', x: 0, y: 0, z: 0, curve: 1 }] }));
  const second = structuredClone(project);
  dragSelection(project, second, { kind: 'pathPoint', id: 'a', pathId: 'path_2' }, 'move', { x: 32, y: 0, z: 0 }, 16);
  assert.deepEqual([project.paths[1].points[0].x, project.paths[0].points[0].x], [32, 160], 'only the named path moved');
});

test('a zone is formed side by side, scaled as a whole, and turned', () => {
  const project = createProject();
  project.map.entities.push({ id: 'zone_a', name: 'Guard room', type: 'zone', x: 0, y: 0, angle: 0,
    area: { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 } });
  validateProject(project);
  const selection = { kind: 'entity', id: 'zone_a' };
  const zone = () => project.map.entities.find(entity => entity.id === 'zone_a');
  const baseline = structuredClone(project);

  // Form: one side at a time, from the drag baseline, snapped by the caller.
  dragSelection(project, baseline, selection, 'form', { sizes: { width: 320 } }, 16);
  assert.deepEqual([zone().area.width, zone().area.depth, zone().area.height], [320, 128, 128]);
  dragSelection(project, baseline, selection, 'form', { sizes: { width: 320, height: 64 } }, 16);
  assert.deepEqual([zone().area.width, zone().area.depth, zone().area.height], [320, 128, 64], 're-running is absolute');

  // Scale: every dimension together, again from the baseline.
  const fromForm = structuredClone(project);
  dragSelection(project, fromForm, selection, 'scale', { scale: 2 }, 16);
  assert.deepEqual([zone().area.width, zone().area.height, zone().area.depth], [640, 128, 256]);
  dragSelection(project, fromForm, selection, 'scale', { scale: 0.5 }, 16);
  assert.deepEqual([zone().area.width, zone().area.height, zone().area.depth], [160, 32, 64]);

  // A zone cannot be made too small to stand in.
  dragSelection(project, fromForm, selection, 'form', { sizes: { width: 1 } }, 16);
  assert.equal(zone().area.width, 8);
  validateProject(project);
});

test('a volume axis reads the middle of an object, and shrugs at anything else', () => {
  const project = createProject();
  project.map.entities.push({ id: 'zone_a', name: 'Guard room', type: 'zone', x: 320, y: -64, elevation: 32, angle: 0,
    area: { shape: 'box', width: 128, height: 256, depth: 96, radius: 64 } });
  // Sideways the position is the middle; upwards the elevation is the floor, so the middle is
  // half a height above it.
  assert.deepEqual(volumeAxis(project, 'zone_a', 'x'), { centre: 320, size: 128 });
  assert.deepEqual(volumeAxis(project, 'zone_a', 'z'), { centre: -64, size: 96 });
  assert.deepEqual(volumeAxis(project, 'zone_a', 'y'), { centre: 32 + 128, size: 256 });

  // A wall, a sector and an id that is not there all have no volume. They must still answer: the
  // same pointer handler starts a wall drag, and looking the wall up among the objects threw.
  const wall = project.map.walls[0];
  assert.deepEqual(volumeAxis(project, wall.id, 'x'), { centre: 0, size: 128 });
  assert.deepEqual(volumeAxis(project, project.map.sectors[0].id, 'y'), { centre: 0, size: 128 });
  assert.deepEqual(volumeAxis(project, 'nothing_here', 'z'), { centre: 0, size: 128 });
});

test('a one-sided form drag takes the volume with it, so the opposite face stays', () => {
  const project = createProject();
  project.map.entities.push({ id: 'zone_a', name: 'Guard room', type: 'zone', x: 320, y: 0, elevation: 32, angle: 0,
    area: { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 } });
  validateProject(project);
  const selection = { kind: 'entity', id: 'zone_a' };
  const zone = () => project.map.entities.find(entity => entity.id === 'zone_a');
  const baseline = structuredClone(project);
  const edges = () => [zone().x - zone().area.width / 2, zone().x + zone().area.width / 2];

  // Sideways the entity's position is the middle, so pulling the +x face 64 units out grows the
  // side by 64 and moves the middle by half of it.
  const before = edges();
  dragSelection(project, baseline, selection, 'form', { sizes: { width: 192 }, offset: { x: 32 } }, 16);
  assert.deepEqual(edges(), [before[0], before[1] + 64], 'the face that was not grabbed did not move');
  assert.equal(zone().area.width, 192);

  // Symmetric growth — the same drag with Shift — keeps the middle and moves both faces.
  const both = structuredClone(project);
  dragSelection(project, both, selection, 'form', { sizes: { width: 256 } }, 16);
  assert.equal(zone().x, 352);
  assert.deepEqual([zone().x - 128, zone().x + 128], [224, 480]);

  // Vertically the elevation is the floor, not the middle: growing the height leaves it alone.
  dragSelection(project, both, selection, 'form', { sizes: { height: 256 } }, 16);
  assert.equal(zone().elevation, 32);
  validateProject(project);
});

test('form and scale refuse an object that has no volume', () => {
  const project = createProject();
  const pickup = project.map.entities.find(entity => entity.type !== 'player');
  const selection = { kind: 'entity', id: pickup.id };
  assert.throws(() => transformSelection(project, selection, 'form', { sizes: { width: 64 } }, 16), /Form applies/);
  // Scale still means the sprite for an object without one, so it is not an error.
  transformSelection(project, selection, 'scale', { scale: 2 }, 16);
  assert.equal(pickup.spriteScale, 2);
});

test('a whole route moves as one, keeping its shape', () => {
  const project = createProject();
  project.paths = [createPath({ id: 'route', points: [
    { id: 'a', x: 100, y: 200, z: 0, curve: 1 }, { id: 'b', x: 173, y: 240, z: 16, curve: 1 },
  ] })];
  const baseline = structuredClone(project);
  dragSelection(project, baseline, { kind: 'path', id: 'route' }, 'move', { x: 37, y: -21, z: 0 }, 16);
  // The shift is snapped once, so the waypoints keep their offsets from each other exactly.
  assert.deepEqual(project.paths[0].points.map(point => [point.x, point.y]), [[132, 184], [205, 224]]);
  assert.throws(() => dragSelection(project, baseline, { kind: 'path', id: 'route' }, 'rotate', { angle: 45 }, 16),
    /turned and resized through its waypoints/);
});

test('a multi-selection travels with the object that was dragged', () => {
  const project = createProject();
  const first = project.map.entities[0], second = project.map.entities[1];
  first.x = 100; first.y = 200; second.x = 260; second.y = 340; second.elevation = 24;
  const baseline = structuredClone(project);
  // The set is carried by the same shift, not by snapping each member on its own: the offset
  // between them is the whole point of selecting them together.
  dragSelection(project, baseline, { kind: 'entity', id: first.id, group: [first.id, second.id] },
    'move', { x: 48, y: 48, z: 0 }, 16);
  // The grabbed object lands on the grid (100+48 rounds down to 144, 200+48 rounds up to 256)
  // and the rest of the set follows by exactly that shift, keeping their offsets.
  assert.deepEqual([first.x, first.y], [144, 256]);
  assert.deepEqual([second.x, second.y], [304, 396]);
  assert.equal(second.elevation, 24, 'height only moves when the drag asked for it');
  // A live drag re-runs against a draft that already holds the previous frame's move, so every
  // step must solve absolute positions: adding to the current place made the rest of the set
  // accelerate away — the object in hand moved a little and its neighbours shot off.
  const live = structuredClone(project);
  const liveBaseline = structuredClone(project);
  for (const step of [16, 32, 48]) {
    dragSelection(live, liveBaseline, { kind: 'entity', id: first.id, group: [first.id, second.id] },
      'move', { x: step, y: 0, z: 0 }, 16);
  }
  const moved = live.map.entities.find(entity => entity.id === first.id);
  const follow = live.map.entities.find(entity => entity.id === second.id);
  const baseFirst = liveBaseline.map.entities.find(entity => entity.id === first.id);
  const baseSecond = liveBaseline.map.entities.find(entity => entity.id === second.id);
  assert.equal(moved.x - baseFirst.x, 48);
  assert.equal(follow.x - baseSecond.x, 48, 'the rest of the set travels exactly as far as the object in hand');
  // Dragging alone still moves one object.
  const alone = structuredClone(project);
  dragSelection(project, alone, { kind: 'entity', id: second.id }, 'move', { x: 16, y: 0, z: 0 }, 16);
  assert.equal(first.x, 144);
  assert.equal(second.x, 320);
});
