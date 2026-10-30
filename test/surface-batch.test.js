import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_PIECE_QUADS, createSurfaceBatcher, mergePiece, selectionAtTriangle } from '../shared/surface-batch.js';

function quad(x, light = 1, selection = null) {
  return {
    positions: [x, 0, 0, x + 64, 0, 0, x + 64, 0, 64, x, 0, 64],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
    light,
    selection,
  };
}

test('merged pieces carry the light level of every surface, not one per material', () => {
  const batcher = createSurfaceBatcher();
  batcher.add('wall/textureA', quad(0, .25));
  batcher.add('wall/textureA', quad(64, 1));
  const [piece] = batcher.drain();
  const merged = mergePiece(piece);
  assert.equal(piece.key, 'wall/textureA');
  // Eight vertices: four at the dark level, four at the bright one.
  assert.deepEqual([...merged.lights], [.25, .25, .25, .25, 1, 1, 1, 1]);
  assert.equal(merged.positions.length, 24);
  assert.equal(merged.index.length, 12);
});

test('a removed surface leaves its piece and an empty piece disappears', () => {
  const batcher = createSurfaceBatcher();
  const first = quad(0, 1, { kind: 'wall', id: 'w1' });
  batcher.add('wall/A', first);
  batcher.drain();
  assert.deepEqual(batcher.size(), { buckets: 1, pieces: 1, quads: 1 });
  batcher.remove(first);
  const drained = batcher.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].records.size, 0);
  assert.deepEqual(batcher.size(), { buckets: 0, pieces: 0, quads: 0 });
  // Removing twice must not throw or resurrect anything.
  assert.equal(batcher.remove(first), false);
});

test('pieces are capped so editing one wall never re-merges a whole map', () => {
  const batcher = createSurfaceBatcher({ pieceQuads: 2 });
  for (let index = 0; index < 5; index++) batcher.add('floor/A', quad(index * 64));
  assert.equal(batcher.size().pieces, 3);
  assert.equal(batcher.size().quads, 5);
  // Only the piece that changed is drained again.
  const pieces = batcher.drain();
  assert.equal(pieces.length, 3);
  assert.equal(batcher.drain().length, 0);
});

test('a click on a merged mesh resolves to the wall or sector under the triangle', () => {
  const batcher = createSurfaceBatcher();
  batcher.add('wall/A', quad(0, 1, { kind: 'wall', id: 'w1' }));
  batcher.add('wall/A', quad(64, 1, null));
  batcher.add('wall/A', quad(128, 1, { kind: 'wall', id: 'w2' }));
  const merged = mergePiece(batcher.drain()[0]);
  // Two triangles per quad: 0-1 for w1, 2-3 without a selection, 4-5 for w2.
  assert.deepEqual(selectionAtTriangle(merged.ranges, 0), { kind: 'wall', id: 'w1' });
  assert.deepEqual(selectionAtTriangle(merged.ranges, 1), { kind: 'wall', id: 'w1' });
  assert.equal(selectionAtTriangle(merged.ranges, 2), null);
  assert.deepEqual(selectionAtTriangle(merged.ranges, 5), { kind: 'wall', id: 'w2' });
  assert.equal(selectionAtTriangle(merged.ranges, 6), null);
  assert.equal(selectionAtTriangle(undefined, 0), null);
});

test('a large merged piece switches to 32-bit indices', () => {
  const batcher = createSurfaceBatcher({ pieceQuads: 20000 });
  for (let index = 0; index < 17000; index++) batcher.add('floor/A', quad(index));
  const merged = mergePiece(batcher.drain()[0]);
  assert.equal(merged.index instanceof Uint32Array, true);
  assert.equal(BATCH_PIECE_QUADS, 2048);
});
