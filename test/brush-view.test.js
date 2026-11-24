import test from 'node:test';
import assert from 'node:assert/strict';
import { viewAxes, viewDepthAxis, projectWorld, unprojectWorld, viewDeltaToWorld,
  brushBoundsFromView, snapViewPoint } from '../shared/brush-view.js';
import { createProject } from '../shared/project.js';
import { createBoxBrush, moveBrush, moveBrushFace, brushBounds, brushVertices, clipPlaneFromView } from '../shared/brushes.js';

test('each 2D view projects the world onto its own pair of axes', () => {
  const point = [10, 20, 30];
  assert.deepEqual(projectWorld('xy', point), { u: 10, v: 20 });
  assert.deepEqual(projectWorld('xz', point), { u: 10, v: 30 });
  assert.deepEqual(projectWorld('yz', point), { u: 20, v: 30 });
  assert.deepEqual(viewAxes('xz'), [0, 2, 1]);
  assert.equal(viewDepthAxis('yz'), 0);
});

test('projection and unprojection round-trip on the view plane', () => {
  for (const projection of ['xy', 'xz', 'yz']) {
    const world = unprojectWorld(projection, 64, 128, 0);
    const view = projectWorld(projection, world);
    assert.deepEqual(view, { u: 64, v: 128 }, projection);
    // The depth axis is the one the view looks down, so it round-trips as the third argument.
    assert.equal(world[viewDepthAxis(projection)], 0, projection);
  }
});

test('a drag in every view moves the brush in that view only', () => {
  for (const [projection, expected] of [
    ['xy', [16, 32, 0]],
    ['xz', [16, 0, 32]],
    ['yz', [0, 16, 32]],
  ]) {
    const delta = viewDeltaToWorld(projection, 16, 32);
    assert.deepEqual(delta, expected, projection);

    // And the same drag applied to a real brush lands where the view said it would.
    const project = createProject();
    const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
    moveBrush(project, box.id, { x: delta[0], y: delta[1], z: delta[2] });
    const bounds = brushBounds(box);
    assert.ok(Math.abs(bounds.x - expected[0]) < 1e-9, projection);
    assert.ok(Math.abs(bounds.y - expected[1]) < 1e-9, projection);
    assert.ok(Math.abs(bounds.z - expected[2]) < 1e-9, projection);
  }
});

test('a Front drag that only changes height still moves the brush', () => {
  // The reported bug: measuring from world x/y made this delta zero and the drag was discarded.
  const project = createProject();
  const box = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 32, depth: 32, height: 32 });
  const delta = viewDeltaToWorld('xz', 0, 48);
  assert.notDeepEqual(delta, [0, 0, 0]);
  moveBrush(project, box.id, { x: delta[0], y: delta[1], z: delta[2] });
  assert.equal(brushBounds(box).z, 48);
});

test('drawing a brush in each view produces a volume with the drag as its face', () => {
  const top = brushBoundsFromView('xy', { u: 0, v: 0 }, { u: 128, v: 64 }, 128);
  assert.deepEqual([top.width, top.depth, top.height], [128, 64, 128]);
  const front = brushBoundsFromView('xz', { u: 0, v: 0 }, { u: 128, v: 96 }, 64);
  assert.deepEqual([front.width, front.depth, front.height], [128, 64, 96]);
  const side = brushBoundsFromView('yz', { u: 0, v: 0 }, { u: 128, v: 96 }, 64);
  assert.deepEqual([side.width, side.depth, side.height], [64, 128, 96]);
});

test('view snapping follows the grid and can be bypassed', () => {
  assert.deepEqual(snapViewPoint({ u: 13, v: 29 }, 16, true), { u: 16, v: 32 });
  assert.deepEqual(snapViewPoint({ u: 13, v: 29 }, 16, false), { u: 13, v: 29 });
});

test('a clip line drawn in Front cuts across the depth axis', () => {
  const plane = clipPlaneFromView('xz', { u: 0, v: 0 }, { u: 0, v: 64 });
  assert.ok(Math.abs(plane.normal[0] - 1) < 1e-9);
  assert.ok(Math.abs(plane.normal[1]) < 1e-9);
  assert.ok(Math.abs(plane.normal[2]) < 1e-9);
  assert.ok(Math.abs(plane.distance) < 1e-9);
});

test('a brush can be drawn, moved, resized and face-pushed in one session', () => {
  const project = createProject();
  // Draw: a drag in Front from the origin to 128 x 96.
  const bounds = brushBoundsFromView('xz', { u: 0, v: 0 }, { u: 128, v: 96 }, 64);
  const brush = createBoxBrush(project, bounds);
  assert.deepEqual([brushBounds(brush).width, brushBounds(brush).height], [128, 96]);

  // Move: the same drag semantics the pointer code uses.
  const delta = viewDeltaToWorld('xz', 16, -32);
  moveBrush(project, brush.id, { x: delta[0], y: delta[1], z: delta[2] });
  let box = brushBounds(brush);
  assert.ok(Math.abs(box.x - 16) < 1e-9);
  assert.ok(Math.abs(box.z + 32) < 1e-9);

  // Resize one face only: the opposite side must not move.
  const before = brushBounds(brush);
  moveBrushFace(project, brush.id, 1, 32);
  const after = brushBounds(brush);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.width - (before.width + 32)) < 1e-9);

  // Push a different face back, and the brush stays a closed convex volume.
  moveBrushFace(project, brush.id, 5, -16);
  box = brushBounds(brush);
  assert.ok(box.height > 0);
  assert.equal(brushVertices(brush).length, 8);
});
