// Brushes as merged, pickable geometry.
//
// A hand-drawn map has a few brushes and one mesh per face is fine. A compiled Quake map has
// thousands — `map-13hell.pk3` imports 5702 brushes and 21 772 visible faces — and one mesh per face
// plus one line per brush plus one sphere per corner is a hundred thousand objects, which no frame
// loop recovers from. The 3D view therefore draws brushes merged by material, and resolves a click
// through the triangle the ray hit, exactly as it already did for the world's walls and sectors.
//
// The merging lives here rather than in the view so it can be tested without a GPU: what matters is
// that every face's triangles are in the buffer and that each of them still names its brush and face.

import { brushGeometry } from './brushes.js';
import { brushFaceUv } from './uv.js';
import { mergePiece } from './surface-batch.js';

/**
 * One face as a merged-mesh record: triangles, UVs, and the selection a click on them means.
 *
 * A brush face is a convex polygon, so a fan is its triangulation. The frame (rotation, scale,
 * offset) is shared with the play view and the `.map` importer, so a texture projects the same
 * everywhere.
 */
export function brushFaceRecord(brush, entry) {
  const polygon = entry?.points;
  if (!polygon || polygon.length < 3) return null;
  const positions = [], uvs = [], indices = [];
  const plane = entry.plane;
  const face = brush.faces?.[entry.index] || {};
  const push = point => {
    positions.push(point[0], point[2], point[1]);
    uvs.push(...brushFaceUv(face, plane.normal, point));
  };
  for (let index = 1; index < polygon.length - 1; index++) {
    const base = positions.length / 3;
    push(polygon[0]); push(polygon[index]); push(polygon[index + 1]);
    indices.push(base, base + 1, base + 2);
  }
  if (!indices.length) return null;
  return { positions, uvs, light: 1, indices, selection: { kind: 'brush', id: brush.id, face: entry.index } };
}

/** The texture a face is drawn with, as the key its batch is merged under. */
const materialKey = (brush, entry) => brush.faces?.[entry.index]?.texture || '';

/**
 * Every visible brush as merged geometry: one batch per texture, and one edge list for all of them.
 *
 * Returns `{ batches, edges, faces }` — `batches` is a `Map` from texture asset id (empty string for
 * no texture) to `{ positions, uvs, index, ranges }`, which is what a `BufferGeometry` needs plus the
 * triangle ranges a raycast hit is resolved through. `edges` is a flat `[x, y, z, …]` line list for
 * the whole level, because a wireframe is one draw call too.
 */
export function batchBrushes(brushes, { includeHidden = false } = {}) {
  const batches = new Map();
  const edges = [];
  let faces = 0;
  for (const brush of brushes || []) {
    if (!includeHidden && brush.visible === false) continue;
    let geometry;
    try { geometry = brushGeometry(brush); } catch { continue; }
    for (const entry of geometry.faces) {
      const record = brushFaceRecord(brush, entry);
      if (!record) continue;
      faces++;
      const key = materialKey(brush, entry);
      let batch = batches.get(key);
      if (!batch) batches.set(key, batch = []);
      batch.push(record);
    }
    for (const [a, b] of geometry.edges) edges.push(a[0], a[2], a[1], b[0], b[2], b[1]);
  }
  const merged = new Map();
  for (const [key, records] of batches) merged.set(key, mergePiece({ records }));
  return { batches: merged, edges, faces };
}
