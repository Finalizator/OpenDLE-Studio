// Collision from a model's own faces.
//
// An imported .bbmodel is a mesh and nothing else, so a wall of one used to be something the
// player walked through. A ramp showed the same gap from the other side: the mesh was drawn and
// a shape nobody could see was collided. Reading the triangles back out of the model closes it —
// what is drawn is what is hit — and it means a ramp cut in Blockbench and one built by the ramp
// tool are collided by the same code.
import { decodeDataURI, readModel } from './gltf.js';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

function readComponent(view, at, Ctor) {
  switch (Ctor) {
    case Int8Array: return view.getInt8(at);
    case Uint8Array: return view.getUint8(at);
    case Int16Array: return view.getInt16(at, true);
    case Uint16Array: return view.getUint16(at, true);
    case Uint32Array: return view.getUint32(at, true);
    default: return view.getFloat32(at, true);
  }
}

/** One accessor as a flat array, honouring interleaved buffer views. */
function accessor(json, binary, index) {
  const definition = json.accessors[index];
  if (!definition) throw new Error(`Model accessor ${index} is missing`);
  const components = COMPONENTS[definition.type];
  const Ctor = TYPES[definition.componentType];
  if (!components || !Ctor) throw new Error(`Model accessor ${index} has an unsupported type`);
  const count = definition.count;
  if (definition.bufferView === undefined) return { values: new Ctor(count * components), components };
  const view = json.bufferViews[definition.bufferView];
  const elementSize = Ctor.BYTES_PER_ELEMENT;
  const stride = view.byteStride || components * elementSize;
  const start = (view.byteOffset || 0) + (definition.byteOffset || 0);
  const data = new DataView(binary.buffer, binary.byteOffset);
  const values = new Ctor(count * components);
  if (stride === components * elementSize) {
    for (let element = 0; element < count * components; element++) values[element] = readComponent(data, start + element * elementSize, Ctor);
    return { values, components };
  }
  for (let element = 0; element < count; element++)
    for (let component = 0; component < components; component++)
      values[element * components + component] = readComponent(data, start + element * stride + component * elementSize, Ctor);
  return { values, components };
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major 4x4 from a node's matrix or its TRS. */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let index = 0; index < 4; index++) sum += a[index * 4 + row] * b[column * 4 + index];
      out[column * 4 + row] = sum;
    }
  return out;
}

function apply(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/**
 * A model's triangles, in model units, with every node transform applied.
 *
 * The renderer puts a `.bbmodel`'s groups and pivots in the node tree, so a collider built from
 * raw accessor data would sit somewhere else entirely; applying the node matrices is what makes
 * the two agree.
 */
export function modelTriangles(json, binary) {
  const positions = [], indices = [];
  const visit = (index, parent) => {
    const node = (json.nodes || [])[index];
    if (!node) return;
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives || []) {
        // Only triangles (mode 4, the default) can be collided as faces.
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const position = primitive.attributes?.POSITION;
        if (position === undefined) continue;
        const read = accessor(json, binary, position);
        if (read.components < 3) continue;
        const base = positions.length / 3;
        for (let element = 0; element < read.values.length / read.components; element++) {
          const [x, y, z] = apply(matrix, read.values[element * read.components],
            read.values[element * read.components + 1], read.values[element * read.components + 2]);
          positions.push(x, y, z);
        }
        if (primitive.indices === undefined) {
          for (let vertex = 0; vertex < read.values.length / read.components; vertex++) indices.push(base + vertex);
        } else {
          const source = accessor(json, binary, primitive.indices).values;
          for (const value of source) indices.push(base + value);
        }
      }
    }
    for (const child of node.children || []) visit(child, matrix);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const node of scene?.nodes || (json.nodes || []).map((_, index) => index)) visit(node, identity());
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** The triangles of a model asset, cached by its source so a rebuild does not reparse it. */
export function modelAssetTriangles(asset, cache) {
  if (!asset || asset.kind !== 'model') return null;
  if (cache?.has(asset.src)) return cache.get(asset.src);
  const { json, binary } = readModel(decodeDataURI(asset.src), asset.format);
  const triangles = modelTriangles(json, binary || new Uint8Array());
  cache?.set(asset.src, triangles);
  return triangles;
}
