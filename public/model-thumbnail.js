// Model thumbnails are rasterised with Canvas2D instead of a second GPU context: the
// asset library can show a picture of an imported model even before it is placed in
// the world, and it works in the editor tab that is already busy with the preview.
import { decodeDataURI, readModel } from '/shared/gltf.js';

const MAX_EDGE = 4096;

function accessor(json, binary, index) {
  const record = json.accessors?.[index];
  if (!record) return null;
  const view = json.bufferViews?.[record.bufferView];
  if (!view) return null;
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[record.type];
  const Type = record.componentType === 5126 ? Float32Array : record.componentType === 5123 ? Uint16Array
    : record.componentType === 5125 ? Uint32Array : record.componentType === 5121 ? Uint8Array : Int16Array;
  const start = (view.byteOffset || 0) + (record.byteOffset || 0);
  return { values: new Type(binary.buffer, binary.byteOffset + start, record.count * size), size, count: record.count };
}

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = sum;
  }
  return out;
};
const applyMatrix = (matrix, x, y, z) => [
  matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
  matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
  matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
];

function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

async function decodeImage(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:image/')) return null;
  const bitmap = await createImageBitmap(await (await fetch(uri)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(MAX_EDGE, bitmap.width); canvas.height = Math.min(MAX_EDGE, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Best-effort snapshot of a model asset as a small PNG data URL, or null when the
 * model cannot be read. Textured, lit and framed like the preview shows it.
 */
export async function captureModelPreview(asset, { size = 128 } = {}) {
  try {
    const bytes = decodeDataURI(asset.src);
    const { json, binary } = readModel(bytes, asset.format);
    if (!json.meshes?.length) return null;
    // Node transforms, so groups and pivots are respected.
    const matrices = new Array(json.nodes?.length || 0);
    const walk = (index, parent) => {
      const node = json.nodes[index];
      const world = multiply(parent, nodeMatrix(node));
      matrices[index] = world;
      for (const child of node.children || []) walk(child, world);
    };
    for (const root of json.scenes?.[json.scene || 0]?.nodes || []) walk(root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const images = await Promise.all((json.images || []).map(image => decodeImage(image.uri).catch(() => null)));
    const triangles = [];
    (json.nodes || []).forEach((node, nodeIndex) => {
      if (node.mesh === undefined || !matrices[nodeIndex]) return;
      for (const primitive of json.meshes[node.mesh].primitives) {
        const position = accessor(json, binary, primitive.attributes.POSITION);
        if (!position) continue;
        const uv = accessor(json, binary, primitive.attributes.TEXCOORD_0);
        const indices = primitive.indices !== undefined ? accessor(json, binary, primitive.indices) : null;
        const material = json.materials?.[primitive.material];
        const texture = material?.pbrMetallicRoughness?.baseColorTexture;
        const image = texture ? images[json.textures?.[texture.index]?.source] : null;
        const order = indices ? Array.from(indices.values) : Array.from({ length: position.count }, (_, index) => index);
        const matrix = matrices[nodeIndex];
        for (let index = 0; index + 2 < order.length; index += 3) {
          const corners = [order[index], order[index + 1], order[index + 2]].map(vertex => {
            const offset = vertex * position.size;
            return applyMatrix(matrix, position.values[offset], position.values[offset + 1], position.values[offset + 2]);
          });
          const uvs = uv ? [order[index], order[index + 1], order[index + 2]].map(vertex => [uv.values[vertex * 2], uv.values[vertex * 2 + 1]]) : null;
          triangles.push({ corners, uvs, image });
        }
      }
    });
    if (!triangles.length) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const triangle of triangles) for (const corner of triangle.corners) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], corner[axis]);
      max[axis] = Math.max(max[axis], corner[axis]);
    }
    const center = min.map((value, axis) => (value + max[axis]) / 2);
    const extent = Math.max(...max.map((value, axis) => value - min[axis])) || 1;
    const eye = [center[0] + extent * .95, center[1] + extent * .5, center[2] + extent * 1.25];
    const normalise = vector => { const length = Math.hypot(...vector) || 1; return vector.map(value => value / length); };
    const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const forward = normalise(subtract(center, eye));
    const right = normalise(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const focal = size * 1.35;
    const colour = new Float32Array(size * size * 3);
    const depth = new Float32Array(size * size).fill(Infinity);
    const light = normalise([.55, 1, .35]);
    const project = corner => {
      const local = subtract(corner, eye);
      const z = dot(local, forward);
      return z <= 1e-6 ? null : [size / 2 + dot(local, right) * focal / z, size / 2 - dot(local, up) * focal / z, z];
    };
    for (const triangle of triangles) {
      const screen = triangle.corners.map(project);
      if (screen.some(corner => !corner)) continue;
      const [a, b, c] = screen;
      const normal = normalise(cross(subtract(triangle.corners[1], triangle.corners[0]), subtract(triangle.corners[2], triangle.corners[0])));
      const shade = .55 + .55 * Math.abs(dot(normal, light));
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
        const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = a[2] * w0 + b[2] * w1 + c[2] * w2, offset = y * size + x;
        if (z >= depth[offset]) continue;
        let red = 200, green = 200, blue = 210;
        if (triangle.image && triangle.uvs) {
          const u = triangle.uvs[0][0] * w0 + triangle.uvs[1][0] * w1 + triangle.uvs[2][0] * w2;
          const v = triangle.uvs[0][1] * w0 + triangle.uvs[1][1] * w1 + triangle.uvs[2][1] * w2;
          const { width, height, data } = triangle.image;
          const tx = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
          const ty = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
          const pixel = (ty * width + tx) * 4;
          if (data[pixel + 3] < 128) continue;
          red = data[pixel]; green = data[pixel + 1]; blue = data[pixel + 2];
        }
        depth[offset] = z;
        colour[offset * 3] = red / 255 * shade;
        colour[offset * 3 + 1] = green / 255 * shade;
        colour[offset * 3 + 2] = blue / 255 * shade;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    const image = context.createImageData(size, size);
    for (let index = 0; index < size * size; index++) {
      const covered = Number.isFinite(depth[index]);
      image.data[index * 4] = Math.round((colour[index * 3] || 0) * 255);
      image.data[index * 4 + 1] = Math.round((colour[index * 3 + 1] || 0) * 255);
      image.data[index * 4 + 2] = Math.round((colour[index * 3 + 2] || 0) * 255);
      image.data[index * 4 + 3] = covered ? 255 : 0;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  } catch { return null; }
}
