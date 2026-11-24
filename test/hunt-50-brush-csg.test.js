// Regressions from the 50-bug hunt, part two: CSG subtract, collapsed edits, and atomicity.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createBoxBrush, subtractBrush, splitBrush, brushBounds, brushVertices,
  moveBrushFace, scaleBrush, setBrushFacePosition, facesOf } from '../shared/brushes.js';

/** Bounds come from plane intersections, so they carry float noise and signed zero. */
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);

const box = (bounds = { x: 0, y: 0, z: 0, width: 64, height: 64, depth: 64 }) => {
  const project = createProject();
  return { project, brush: createBoxBrush(project, bounds) };
};

test('hunt 50: subtract carves the cutter out of the brush it shaves', () => {
  // Before: the two early answers in `splitBrush` named the halves the other way round, so a cutter
  // that touched a brush face put the *whole* brush on the "outside" pile: Subtract reported success
  // and changed nothing, which is the most common use of it (cutting a doorway into a wall).
  const { project, brush } = box();
  const cutter = createBoxBrush(project, { x: -8, y: 0, z: 0, width: 16, height: 64, depth: 64 });
  const pieces = subtractBrush(project, brush.id, [cutter.id]);
  assert.equal(pieces.length, 1);
  const carved = brushBounds(pieces[0]);
  near(carved.x, 8, 'shaved x');
  near(carved.width, 56, 'shaved width');
});

test('hunt 50: subtract keeps the far half when the cutter covers half the brush', () => {
  const { project, brush } = box();
  const cutter = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 32, height: 64, depth: 64 });
  const pieces = subtractBrush(project, brush.id, [cutter.id]);
  assert.equal(pieces.length, 1);
  near(brushBounds(pieces[0]).x, 32, 'half x');
  near(brushBounds(pieces[0]).width, 32, 'half width');
});

test('hunt 50: subtract of a cutter inside the brush is still the shell', () => {
  const { project, brush } = box();
  const cutter = createBoxBrush(project, { x: 16, y: 16, z: 16, width: 32, height: 32, depth: 32 });
  const pieces = subtractBrush(project, brush.id, [cutter.id]);
  assert.equal(pieces.length, 6, 'six walls around the hole');
  for (const piece of pieces) assert.ok(brushVertices(piece).length >= 4);
});

test('hunt 50: subtract of a cutter that contains the brush removes it', () => {
  const { project, brush } = box();
  const cutter = createBoxBrush(project, { x: -32, y: -32, z: -32, width: 256, height: 256, depth: 256 });
  subtractBrush(project, brush.id, [cutter.id]);
  assert.equal(project.map.brushes.some(item => item.id === brush.id), false);
});

test('hunt 50: split names the half the normal points at as the front', () => {
  const { brush } = box();
  const { front, back } = splitBrush(brush, { normal: [1, 0, 0], distance: 32 });
  assert.ok(front && back);
  near(brushBounds(front).x, 32, 'front is the +x half');
  near(brushBounds(back).x, 0, 'back is the -x half');
  // A brush entirely on one side is that whole half, and `untouched` says no cut was made.
  const outside = splitBrush(brush, { normal: [1, 0, 0], distance: -10 });
  assert.equal(outside.front, brush);
  assert.equal(outside.back, null);
  const behind = splitBrush(brush, { normal: [1, 0, 0], distance: 100 });
  assert.equal(behind.front, null);
  assert.equal(behind.back, brush);
});

test('hunt 50: a face pushed through the far side is refused and leaves the brush intact', () => {
  const { project, brush } = box();
  // Before: the edit was written into `brush.faces` before the check, and there was no check at all
  // — a brush could be stored with no corners: invisible, unselectable, saved, unsalvageable.
  assert.throws(() => moveBrushFace(project, brush.id, 0, -200), /flatten/);
  const after = project.map.brushes[0];
  assert.equal(brushVertices(after).length, 8, 'the refused move did not touch the brush');
  const intact = brushBounds(after);
  for (const [key, value] of Object.entries({ x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 })) near(intact[key], value, key);
  near(facesOf(after)[0].points[0][0], 0, 'the face is where it was');
});

test('hunt 50: scaling a brush to zero is refused instead of storing an empty brush', () => {
  const { project, brush } = box();
  assert.throws(() => scaleBrush(project, brush.id, [32, 32, 32], [1, 1, 0]), /flatten/);
  assert.throws(() => scaleBrush(project, brush.id, [32, 32, 32], [-1, 1, 1]), /flatten/);
  assert.equal(brushVertices(project.map.brushes[0]).length, 8);
});

test('hunt 50: dragging a 2D grip past the opposite edge stops one unit short', () => {
  const { project, brush } = box();
  // The inspector already clamps a typed width to 1; the grip did not, and a brush dragged inside
  // out became a zero-vertex ghost.
  setBrushFacePosition(project, brush.id, 0, 1, -50);
  const after = brushBounds(project.map.brushes[0]);
  near(after.x, 0, 'grip x');
  near(after.width, 1, 'grip width');
  setBrushFacePosition(project, brush.id, 0, -1, 500);
  const flipped = brushBounds(project.map.brushes[0]);
  near(flipped.x, 0, 'other grip x');
  near(flipped.width, 1, 'other grip width');
});
