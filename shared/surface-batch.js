// Static world surfaces (one quad per wall face, one triangulated surface per sector
// floor and ceiling) are merged into a handful of buffers instead of being one mesh
// each. The per-object cost of the renderer dwarfs the shading cost on a large map:
// measured in the browser, a 4,096-sector map spent ~85 ms of a frame over 12,419
// drawables that only added up to 25,000 triangles.
//
// A part of the world (one wall, one sector) still owns the quads it produced, so
// editing a wall only re-merges the piece that wall lands in. Pieces are filled in
// insertion order and capped, which keeps a big map's merge cost bounded without
// needing a spatial index.

/** Quads per merged buffer: bounded (re)merge cost, few enough buffers to stay cheap. */
export const BATCH_PIECE_QUADS = 2048;

/**
 * A record is one surface as the world build produced it:
 * `{ positions: number[], uvs: number[], indices: number[], light: number, selection?: object }`.
 */
export function createSurfaceBatcher({ pieceQuads = BATCH_PIECE_QUADS } = {}) {
  const limit = Math.max(1, Math.floor(pieceQuads));
  const buckets = new Map();
  const dirty = new Set();

  function bucket(key) {
    let entry = buckets.get(key);
    if (!entry) { entry = { key, pieces: [] }; buckets.set(key, entry); }
    return entry;
  }

  function add(key, record) {
    const entry = bucket(key);
    let piece = entry.pieces[entry.pieces.length - 1];
    if (!piece || piece.records.size >= limit) {
      piece = { key, records: new Set(), dirty: true };
      entry.pieces.push(piece);
    }
    record.piece = piece;
    piece.records.add(record);
    piece.dirty = true;
    dirty.add(piece);
    return piece;
  }

  function remove(record) {
    const piece = record?.piece;
    if (!piece) return false;
    record.piece = null;
    if (!piece.records.delete(record)) return false;
    piece.dirty = true;
    dirty.add(piece);
    if (piece.records.size) return true;
    // An empty piece is dropped from its bucket so the bucket count follows the map.
    const entry = buckets.get(piece.key);
    const at = entry ? entry.pieces.indexOf(piece) : -1;
    if (at >= 0) entry.pieces.splice(at, 1);
    if (entry && !entry.pieces.length) buckets.delete(piece.key);
    // The piece stays in the drain so the owner of its buffer hears that it is empty and
    // can drop the merged mesh instead of leaving it drawn with no quads.
    return true;
  }

  /** Pieces that changed since the last call, for whoever owns the GPU buffers. */
  function drain() {
    const result = [...dirty];
    dirty.clear();
    for (const piece of result) piece.dirty = false;
    return result;
  }

  function size() {
    let pieces = 0, quads = 0;
    for (const entry of buckets.values()) for (const piece of entry.pieces) { pieces++; quads += piece.records.size; }
    return { buckets: buckets.size, pieces, quads };
  }

  return { add, remove, drain, size };
}

/**
 * Merges a piece's records into the typed arrays a BufferGeometry wants, plus the
 * triangle range of every record so a click on the merged mesh can still name the
 * wall or sector that was hit.
 */
export function mergePiece(piece) {
  const records = [...piece.records];
  let vertices = 0, indices = 0;
  for (const record of records) {
    vertices += record.positions.length / 3;
    indices += record.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const lights = new Float32Array(vertices);
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const ranges = [];
  let vertex = 0, offset = 0, triangles = 0;
  for (const record of records) {
    const count = record.positions.length / 3;
    positions.set(record.positions, vertex * 3);
    uvs.set(record.uvs, vertex * 2);
    lights.fill(record.light, vertex, vertex + count);
    for (let at = 0; at < record.indices.length; at++) index[offset + at] = record.indices[at] + vertex;
    if (record.selection) ranges.push({ first: triangles, count: record.indices.length / 3, selection: record.selection });
    triangles += record.indices.length / 3;
    vertex += count;
    offset += record.indices.length;
  }
  return { positions, uvs, lights, index, ranges };
}

/** The selection a raycast landed on, resolved through a merged mesh's triangle ranges. */
export function selectionAtTriangle(ranges, faceIndex) {
  if (!ranges?.length || !Number.isFinite(faceIndex)) return null;
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (faceIndex < range.first) high = middle - 1;
    else if (faceIndex >= range.first + range.count) low = middle + 1;
    else return range.selection;
  }
  return null;
}
