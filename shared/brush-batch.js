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

import { brushGeometry, isWaterBrush } from './brushes.js';
import { WATER_DEFAULTS, waterFaceDrawn, waterSettings } from './water.js';
import { buildWaterSurface } from './water-surface.js';
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
  // The top of a water body is a grid that rides the swells; every other face is a flat fan. A
  // surface that is not displaced has no reason to carry the extra vertices.
  if (isWaterBrush(brush) && plane.normal[2] > .5) {
    const grid = buildWaterSurface(polygon.map(point => [point[0], point[2], point[1]]),
      { uvAt: point => brushFaceUv(face, plane.normal, point), water: waterSettings(brush) });
    if (grid) {
      return { positions: grid.positions, uvs: grid.uvs, light: 1, indices: grid.index,
        selection: { kind: 'brush', id: brush.id, face: entry.index } };
    }
  }
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

/**
 * What a face is drawn with, as the key its batch is merged under.
 *
 * A face with a PBR material is batched under the material, not the texture: the material brings
 * a normal map and a roughness map as well, and they are per-material state, so one batch per
 * material is the only way to draw them without splitting a merged buffer per map.
 *
 * A shader and a water body both change the *program*, not only the picture, so each becomes part
 * of the key too: a face with a shader cannot share a batch with the plain faces of the same
 * texture, and a pool of one blue cannot share one with a pool of another.
 */
export function brushSurfaceKey(brush, entry) {
  const face = brush.faces?.[entry.index];
  const shaderId = face?.shaderId || brush.shaderId || '';
  // The top of a water body moves and its sides do not, so they are two batches even though they
  // are one brush: a moving vertex and a still one cannot share a buffer without one of them
  // being wrong.
  const moving = isWaterBrush(brush) && (entry?.plane?.normal?.[2] || 0) > .5;
  const water = isWaterBrush(brush)
    ? { color: brush.water?.color || WATER_DEFAULTS.color, opacity: brush.water?.opacity ?? WATER_DEFAULTS.opacity,
      surface: moving ? waterSettings(brush) : null } : null;
  const base = face?.material ? `material:${face.material}` : face?.texture || '';
  // A plain face keeps the key it always had, so nothing that reads a batch key has to change.
  const key = !shaderId && !water ? base
    : [shaderId, base, water ? `${water.color}/${water.opacity}/${moving ? 'moving' : 'still'}` : ''].join('|');
  return { key, shaderId, material: face?.material || null, texture: face?.texture || '', water };
}

/**
 * Every visible brush as merged geometry: one batch per texture, and one edge list for all of them.
 *
 * Returns `{ batches, edges, faces, surfaces }` — `batches` is a `Map` from a surface key (see
 * `brushSurfaceKey`: the shader, the texture or material, and the water if there is any) to
 * `{ positions, uvs, index, ranges }`, which is what a `BufferGeometry` needs plus the triangle
 * ranges a raycast hit is resolved through, and `surfaces` says what each key means. `edges` is a flat `[x, y, z, …]` line list for
 * the whole level, because a wireframe is one draw call too.
 */
export function batchBrushes(brushes, { includeHidden = false } = {}) {
  const batches = new Map(), surfaces = new Map();
  const edges = [];
  let faces = 0;
  for (const brush of brushes || []) {
    if (!includeHidden && brush.visible === false) continue;
    let geometry;
    try { geometry = brushGeometry(brush); } catch { continue; }
    for (const entry of geometry.faces) {
      // A water body draws its top unless it was asked to show its whole volume.
      if (isWaterBrush(brush) && !waterFaceDrawn(brush, entry.plane.normal)) continue;
      const record = brushFaceRecord(brush, entry);
      if (!record) continue;
      faces++;
      const surface = brushSurfaceKey(brush, entry);
      const key = surface.key;
      if (!surfaces.has(key)) surfaces.set(key, surface);
      let batch = batches.get(key);
      if (!batch) batches.set(key, batch = []);
      batch.push(record);
    }
    for (const [a, b] of geometry.edges) edges.push(a[0], a[2], a[1], b[0], b[2], b[1]);
  }
  const merged = new Map();
  for (const [key, records] of batches) merged.set(key, mergePiece({ records }));
  return { batches: merged, edges, faces, surfaces };
}
