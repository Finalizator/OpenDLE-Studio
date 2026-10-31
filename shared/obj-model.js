/**
 * Wavefront OBJ to binary glTF 2.0.
 *
 * GZDoom models are declared in MODELDEF and are usually `.obj` files authored in map units
 * with Z up. The renderer loads glTF, so the importer converts the mesh once and stores it as
 * an ordinary `model` asset: no format is special-cased at draw time, and a converted model
 * behaves exactly like one a user imported themselves.
 *
 * GZDoom skins a model through its `usemtl` names: each one is looked up as a texture of the
 * game, so `usemtl FLOOR72D` draws that flat. Those names are kept as separate primitives here
 * and bound to the image the caller supplies for them, which is what makes a converted model
 * look like the map rather than like a white blob.
 *
 * The vertex axes are written in the engine's own world order — `(x, z, y)`, the same swap the
 * camera and sprites use — and the triangles are re-wound, because swapping two axes mirrors
 * the mesh and would otherwise turn every face inside out.
 */

const FLOAT = 5126, UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

/** Resolves an OBJ index: positive is 1-based, negative counts back from the end. */
function resolveIndex(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return null;
  return number > 0 ? number - 1 : length + number;
}

/**
 * Reads a `.obj`: vertices, per-material face groups, and the material names it uses.
 * Polygons with more than three corners are fanned, which is what GZDoom does for them.
 */
export function parseObj(text) {
  const positions = [], uvs = [], normals = [], groups = [];
  let group = null, badFaces = 0;
  const cornersOf = () => {
    if (!group) groups.push(group = { material: null, corners: [] });
    return group.corners;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0].toLowerCase();
    if (keyword === 'v') positions.push([Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0]);
    else if (keyword === 'vt') uvs.push([Number(parts[1]) || 0, Number(parts[2]) || 0]);
    else if (keyword === 'vn') normals.push([Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0]);
    else if (keyword === 'usemtl') { group = { material: parts.slice(1).join(' ') || null, corners: [] }; groups.push(group); }
    else if (keyword === 'f') {
      const corners = cornersOf();
      const face = [];
      for (const corner of parts.slice(1)) {
        const [v, vt, vn] = corner.split('/');
        const position = resolveIndex(v, positions.length);
        if (position === null || position < 0) { badFaces++; face.length = 0; break; }
        face.push({ position, uv: vt === undefined ? null : resolveIndex(vt, uvs.length),
          normal: vn === undefined ? null : resolveIndex(vn, normals.length) });
      }
      for (let corner = 2; corner < face.length; corner++) corners.push(face[0], face[corner - 1], face[corner]);
    }
  }
  return { positions, uvs, normals, groups: groups.filter(entry => entry.corners.length), badFaces };
}

/** Splits corners into unique vertices so a mesh can carry per-corner normals and UVs. */
function uniqueVertices({ positions, uvs, normals }, corners) {
  const lookup = new Map(), vertices = [], indices = [];
  for (const corner of corners) {
    const position = positions[corner.position];
    if (!position) continue;
    const key = `${corner.position}/${corner.normal ?? ''}/${corner.uv ?? ''}`;
    let at = lookup.get(key);
    if (at === undefined) {
      at = vertices.length;
      lookup.set(key, at);
      vertices.push({ position, normal: corner.normal === null ? null : normals[corner.normal],
        uv: corner.uv === null ? null : uvs[corner.uv] });
    }
    indices.push(at);
  }
  // Swapping the two horizontal axes mirrors the mesh, so the winding is reversed to keep
  // the faces pointing outwards.
  const triangles = [];
  for (let index = 0; index + 2 < indices.length; index += 3) triangles.push(indices[index], indices[index + 2], indices[index + 1]);
  return { vertices, indices: triangles };
}

const pad4 = length => (4 - (length % 4)) % 4;

/**
 * Builds the GLB container. `textures` maps a `usemtl` name to `{ src }`, where `src` is a
 * data URI of the image the game uses for that material.
 */
export function objToGlb(text, { name = 'model', textures = new Map() } = {}) {
  const parsed = parseObj(text);
  if (!parsed.groups.length) throw new Error(`${name} has no triangles`);

  const chunks = [];
  const views = [], accessors = [], materials = [], images = [], textureList = [];
  const textureIndex = new Map();
  let offset = 0;
  const addView = (data, target) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    const padding = pad4(offset);
    if (padding) { chunks.push(new Uint8Array(padding)); offset += padding; }
    return views.length - 1;
  };
  const materialFor = materialName => {
    const key = String(materialName || '').toUpperCase();
    if (!key) return undefined;
    if (textureIndex.has(key)) return textureIndex.get(key);
    const texture = textures.get(key) || textures.get(materialName);
    if (!texture?.src) return undefined;
    const at = materials.length;
    images.push({ uri: texture.src });
    textureList.push({ source: images.length - 1 });
    materials.push({ name: key, doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: at }, metallicFactor: 0, roughnessFactor: 1 } });
    textureIndex.set(key, at);
    return at;
  };

  const primitives = [];
  for (const group of parsed.groups) {
    const { vertices, indices } = uniqueVertices(parsed, group.corners);
    if (!vertices.length || !indices.length) continue;
    const positionData = new Float32Array(vertices.length * 3);
    const normalData = new Float32Array(vertices.length * 3);
    const uvData = new Float32Array(vertices.length * 2);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let hasNormals = false, hasUvs = false;
    vertices.forEach((vertex, at) => {
      // The engine's world order is (x, z, y); the same swap applies to every vector.
      const [x, y, z] = vertex.position;
      const world = [x, z, y];
      for (let axis = 0; axis < 3; axis++) {
        positionData[at * 3 + axis] = world[axis];
        min[axis] = Math.min(min[axis], world[axis]);
        max[axis] = Math.max(max[axis], world[axis]);
      }
      if (vertex.normal) {
        hasNormals = true;
        const [nx, ny, nz] = vertex.normal;
        normalData[at * 3] = nx; normalData[at * 3 + 1] = nz; normalData[at * 3 + 2] = ny;
      }
      if (vertex.uv) {
        hasUvs = true;
        uvData[at * 2] = vertex.uv[0]; uvData[at * 2 + 1] = 1 - vertex.uv[1];
      }
    });
    const indexData = new Uint32Array(indices);
    const attributes = { POSITION: accessors.length };
    accessors.push({ bufferView: addView(positionData, ARRAY_BUFFER), componentType: FLOAT, count: vertices.length, type: 'VEC3', min, max });
    if (hasNormals) {
      attributes.NORMAL = accessors.length;
      accessors.push({ bufferView: addView(normalData, ARRAY_BUFFER), componentType: FLOAT, count: vertices.length, type: 'VEC3' });
    }
    if (hasUvs) {
      attributes.TEXCOORD_0 = accessors.length;
      accessors.push({ bufferView: addView(uvData, ARRAY_BUFFER), componentType: FLOAT, count: vertices.length, type: 'VEC2' });
    }
    const indicesAccessor = accessors.length;
    accessors.push({ bufferView: addView(indexData, ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: indexData.length, type: 'SCALAR' });
    const material = materialFor(group.material);
    primitives.push({ attributes, indices: indicesAccessor, mode: 4, ...(material === undefined ? {} : { material }) });
  }
  if (!primitives.length) throw new Error(`${name} has no usable triangles`);

  const json = {
    asset: { version: '2.0', generator: 'OpenDLE OBJ import' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ primitives }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    ...(materials.length ? { materials, textures: textureList, images } : {}),
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = pad4(jsonBytes.length);
  const jsonLength = jsonBytes.length + jsonPadding;
  const binLength = offset;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);           // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);          // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);   // JSON pads with spaces
  let cursor = 20 + jsonLength;
  view.setUint32(cursor, binLength, true);
  view.setUint32(cursor + 4, 0x004e4942, true);  // 'BIN\0'
  cursor += 8;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
  return out;
}
