import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, addRoom, validateProject } from '../shared/project.js';
import { alignWorldSelection, distributeWorldSelection, flipWorldSelection, mergeWorldSectors,
  hollowWorldRoom, lockWorldEntities, unlockWorldEntities, worldLayers,
  createWorldLayer, setWorldLayer, assignWorldLayer } from '../shared/world-tools.js';
import { createBoxBrush, createWedgeBrush, brushVertices, brushBounds, brushGeometry,
  moveBrush, moveBrushFace, moveBrushVertex, clipBrush, clipPlaneFromView, subtractBrush,
  mergeBrushes, hollowBrush, duplicateBrush } from '../shared/brushes.js';

test('world tools align, distribute and flip selections', () => {
  const project = createProject();
  const entities = [
    { id: 'tool-a', name: 'Tool A', type: 'decoration', x: 0, y: 0 },
    { id: 'tool-b', name: 'Tool B', type: 'decoration', x: 0, y: 0 },
    { id: 'tool-c', name: 'Tool C', type: 'decoration', x: 0, y: 0 },
  ];
  project.map.entities.push(...entities);
  entities[0].x = 10; entities[0].y = 30;
  entities[1].x = 100; entities[1].y = 80;
  entities[2].x = 55; entities[2].y = 55;
  const ids = entities.map(entity => entity.id);
  alignWorldSelection(project, ids, 'left');
  assert.equal(entities[0].x, 10);
  assert.equal(entities[1].x, 10);
  assert.equal(entities[2].x, 10);
  distributeWorldSelection(project, ids, 'x');
  assert.equal(entities[0].x, 10);
  assert.equal(entities[1].x, 10);
  assert.equal(entities[2].x, 10);
  flipWorldSelection(project, ids, 'y');
  assert.equal(entities[0].y, 80);
  assert.equal(entities[1].y, 30);
});

test('world tools merge sectors and hollow rooms', () => {
  const project = createProject();
  addRoom(project, { x: 0, y: 0, width: 128, depth: 128 });
  addRoom(project, { x: 128, y: 0, width: 128, depth: 128 });
  const target = mergeWorldSectors(project, project.map.sectors.map(sector => sector.id));
  assert.equal(project.map.sectors.length, 1);
  assert.equal(project.map.sectors[0].id, target);
  assert.equal(hollowWorldRoom(project, { x: 0, y: 0, width: 256, depth: 256, thickness: 32 }), 4);
  assert.equal(project.map.sectors.length, 5);
});

test('world entity locks are stored and removable', () => {
  const project = createProject();
  const id = project.map.entities[1].id;
  lockWorldEntities(project, [id]);
  assert.deepEqual(project.worldLockedEntityIds, [id]);
  unlockWorldEntities(project, [id]);
  assert.deepEqual(project.worldLockedEntityIds, []);
});

test('world layers create, configure, and assign native objects', () => {
  const project = createProject();
  assert.equal(worldLayers(project).length, 1);
  const layer = createWorldLayer(project, 'Architecture');
  setWorldLayer(project, layer.id, { visible: false, locked: true });
  const entity = project.map.entities.find(item => item.type !== 'player');
  assignWorldLayer(project, [entity.id], layer.id);
  assert.equal(entity.worldLayerId, layer.id);
  assert.equal(worldLayers(project).find(item => item.id === layer.id).visible, false);
  assert.equal(worldLayers(project).find(item => item.id === layer.id).locked, true);
});

test('box and wedge brushes are convex plane volumes', () => {
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 128 });
  assert.equal(box.faces.length, 6);
  assert.equal(brushVertices(box).length, 8);
  assert.equal(brushGeometry(box).edges.length, 12);
  moveBrush(project, box.id, { x: 16, y: 32, z: 8 });
  const bounds = brushBounds(box);
  assert.equal(bounds.x, 16);
  assert.equal(bounds.y, 32);
  assert.equal(bounds.z, 8);
  const wedge = createWedgeBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 128 });
  assert.equal(wedge.faces.length, 5);
  assert.equal(brushVertices(wedge).length, 6);
});

test('a face drag moves only that plane and keeps the opposite one', () => {
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 128 });
  const before = brushBounds(box);
  moveBrushFace(project, box.id, 1, 32);
  const after = brushBounds(box);
  assert.equal(after.x, before.x);
  assert.equal(after.width, before.width + 32);
});

test('a corner drag re-fits every face through the moved corner', () => {
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 128 });
  const vertices = brushVertices(box);
  const corner = vertices.findIndex(point => point[0] === 0 && point[1] === 0 && point[2] === 0);
  assert.ok(corner >= 0);
  moveBrushVertex(project, box.id, corner, [-16, -16, 0]);
  const moved = brushVertices(box);
  assert.ok(moved.some(point => Math.abs(point[0] + 16) < .001 && Math.abs(point[1] + 16) < .001 && Math.abs(point[2]) < .001));
  // Still convex and watertight: the same number of corners and faces.
  assert.equal(moved.length, 8);
  assert.equal(box.faces.length, 6);
});

test('clipping a brush adds exactly one plane and can keep both halves', () => {
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  const plane = clipPlaneFromView('xy', { u: 32, v: 0 }, { u: 32, v: 64 });
  const replacements = clipBrush(project, box.id, plane, { keepBoth: true });
  assert.equal(replacements.length, 2);
  assert.equal(project.map.brushes.length, 2);
  for (const piece of project.map.brushes) assert.equal(brushVertices(piece).length, 8);
  const widths = project.map.brushes.map(piece => brushBounds(piece).width).sort((a, b) => a - b);
  assert.deepEqual(widths, [32, 32]);
});

test('hollow, merge and subtract produce valid convex brushes', () => {
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 128, depth: 128, height: 128 });
  const walls = hollowBrush(project, box.id, 16);
  assert.equal(walls.length, 6);
  for (const wall of walls) assert.ok(brushVertices(wall).length >= 4);

  const mergedProject = createProject();
  const a = createBoxBrush(mergedProject, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  const b = createBoxBrush(mergedProject, { x: 64, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  const merged = mergeBrushes(mergedProject, [a.id, b.id]);
  assert.equal(mergedProject.map.brushes.length, 1);
  assert.equal(brushBounds(merged).width, 128);

  const subtractProject = createProject();
  const target = createBoxBrush(subtractProject, { x: 0, y: 0, z: 0, width: 128, depth: 128, height: 128 });
  const cutter = createBoxBrush(subtractProject, { x: 32, y: 32, z: -32, width: 64, depth: 64, height: 192 });
  const pieces = subtractBrush(subtractProject, target.id, [cutter.id]);
  assert.ok(pieces.length >= 4);
  for (const piece of pieces) assert.ok(brushVertices(piece).length >= 4);

  const copyProject = createProject();
  const original = createBoxBrush(copyProject, { x: 0, y: 0, z: 0, width: 32, depth: 32, height: 32 });
  const copy = duplicateBrush(copyProject, original.id, { x: 32, y: 0, z: 0 });
  assert.equal(copyProject.map.brushes.length, 2);
  assert.equal(brushBounds(copy).x, 32);
});

test('brushes survive validation and reject unknown textures', () => {
  const project = createProject();
  createBoxBrush(project, { x: 0, y: 0, z: 0, width: 32, depth: 32, height: 32 });
  const validated = validateProject(project);
  assert.equal(validated.map.brushes.length, 1);
  assert.equal(validated.map.brushes[0].faces.length, 6);

  const broken = createProject();
  const box = createBoxBrush(broken, { x: 0, y: 0, z: 0, width: 32, depth: 32, height: 32 });
  box.faces[0].texture = 'missing-texture';
  assert.throws(() => validateProject(broken), /unknown asset/i);
});
