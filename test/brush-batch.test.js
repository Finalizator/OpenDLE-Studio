// The 3D view draws a level's brushes merged, and a click still names the brush and face it hit.
//
// One mesh per face is fine for a hand-drawn map and impossible for a compiled one: the Quake 3 map
// in `Projects/Maps` imports 5702 brushes and 21 772 visible faces, and a mesh — plus a wireframe
// line and a sphere per corner — per brush is a hundred thousand objects. This is the geometry that
// replaces them, checked without a GPU: every face's triangles are in a buffer, and the triangle a
// ray hits still resolves to the brush and face that made it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { batchBrushes, brushFaceRecord } from '../shared/brush-batch.js';
import { selectionAtTriangle } from '../shared/surface-batch.js';
import { brushGeometry, faceFromPlane } from '../shared/brushes.js';

/** Two brushes: a 64-unit box with a texture, and an invisible one that must not be drawn. */
function scene() {
  const box = (id, texture, visible = true) => ({
    id, name: id, visible, faces: [
      faceFromPlane([0, 0, -1], 0), faceFromPlane([0, 0, 1], 64),
      faceFromPlane([-1, 0, 0], 0), faceFromPlane([1, 0, 0], 64),
      faceFromPlane([0, -1, 0], 0), faceFromPlane([0, 1, 0], 64),
    ].map(face => ({ ...face, texture: texture ? 'asset_box' : null })),
  });
  return [box('brush_a', 'asset_box'), box('brush_b', null, false)];
}

test('a face becomes triangles that still name their brush and face', () => {
  const brush = scene()[0];
  const geometry = brushGeometry(brush);
  const entry = geometry.faces.find(face => face.points.length >= 3);
  const record = brushFaceRecord(brush, entry);
  assert.equal(record.selection.kind, 'brush');
  assert.equal(record.selection.id, 'brush_a');
  assert.equal(record.selection.face, entry.index);
  // A quad is two triangles, and the z-up map axes become y-up in the buffer.
  assert.deepEqual(record.indices, [0, 1, 2, 3, 4, 5]);
  assert.equal(record.positions.length / 3, 6);
  assert.equal(record.uvs.length / 2, 6);
});

test('the whole level is a handful of buffers, and a hit finds its brush', () => {
  const brushes = scene();
  const { batches, edges, faces } = batchBrushes(brushes);
  // One batch for the textured faces; the invisible brush contributes nothing at all.
  assert.deepEqual([...batches.keys()], ['asset_box']);
  assert.ok(faces > 0);
  const merged = batches.get('asset_box');
  assert.ok(merged.positions.length > 0);
  assert.ok(merged.index.length > 0);
  // Every triangle belongs to exactly one range, and every range names a face of a drawn brush.
  let covered = 0;
  for (const range of merged.ranges) {
    assert.equal(range.selection.kind, 'brush');
    assert.equal(range.selection.id, 'brush_a');
    assert.equal(covered, range.first, 'ranges are contiguous, so a binary search finds them');
    covered += range.count;
  }
  assert.equal(covered, merged.index.length / 3);
  for (let triangle = 0; triangle < covered; triangle++) {
    const selection = selectionAtTriangle(merged.ranges, triangle);
    assert.equal(selection?.id, 'brush_a');
    assert.ok(Number.isInteger(selection.face));
  }
  // A wireframe is one draw call too: twelve edges of a box, two points each, three numbers a point.
  assert.equal(edges.length, 12 * 2 * 3);
});

test('a floor on a brush level is the surface an object should stand on', async () => {
  const { brushSurfaceAt } = await import('../shared/brushes.js');
  const brushes = [
    // A floor slab at -1600 with its top at -1568, and a wall beside it.
    { id: 'floor', name: 'floor', visible: true, faces: [
      faceFromPlane([0, 0, -1], 1632), faceFromPlane([0, 0, 1], -1600),
      faceFromPlane([-1, 0, 0], 0), faceFromPlane([1, 0, 0], 256),
      faceFromPlane([0, -1, 0], 0), faceFromPlane([0, 1, 0], 256),
    ] },
  ];
  assert.equal(brushSurfaceAt(brushes, 100, 100), -1600, 'the top of the slab the point stands over');
  assert.equal(brushSurfaceAt(brushes, 400, 100), null, 'nothing under there');
  assert.equal(brushSurfaceAt([{ ...brushes[0], visible: false }], 100, 100), null, 'hidden geometry is not a floor');
});
