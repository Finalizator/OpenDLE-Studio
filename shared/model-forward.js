/**
 * Which way a model file's own geometry points, measured instead of guessed.
 *
 * An imported model does not agree with any other about which way is "forward": one file is
 * drawn along +X, another along +Z, and a truck exported sideways reads as if it were driving
 * crabwise. Asking the author to type that number is a guess they can only check by eye, and the
 * check itself is the thing being guessed — the truck was set to 80° when its own body runs along
 * Z and the right answer was 90°, leaving it visibly skewed in play.
 *
 * A vehicle, a crate, a corridor: almost everything with a front is **longer along it than it is
 * wide**, so the model's own bounding box answers the question. The box is measured from the
 * glTF accessor bounds through the node hierarchy, the way a renderer would place the geometry,
 * so a rotated node does not report the wrong axis.
 */

import { decodeDataURI, readModel } from './gltf.js';

/** The largest box a model may be measured from, so a broken document cannot hang the editor. */
const MAX_NODES = 10000;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 product, the order glTF writes matrices in. */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function rotationMatrix([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}

/**
 * A node's own transform, composed the way glTF means it: **M = T · R · S**.
 *
 * The order matters and is easy to get wrong: rotating the scale and then adding the translation
 * (R · [S|t]) turns a node's own *position* by its own rotation, so a part that sits ten units east
 * of the model's origin and is turned a quarter turn is read as sitting ten units south of it. The
 * box is then measured in the wrong place, and for a model made of several placed parts the longest
 * side can come out on the wrong axis — which is exactly the number this module exists to get right.
 */
function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [sx = 1, sy = 1, sz = 1] = node.scale || [];
  const [tx = 0, ty = 0, tz = 0] = node.translation || [];
  const rotation = node.rotation ? rotationMatrix(node.rotation) : IDENTITY;
  const scale = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
  const translation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
  return multiply(translation, multiply(rotation, scale));
}

function transform(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/**
 * The world-space bounding box of a glTF document's geometry.
 *
 * Accessor `min`/`max` are all that is needed and they are required on `POSITION`, so this never
 * touches the vertex data: a 4 MB model is measured from a few hundred numbers.
 */
export function modelBounds(json) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const nodes = json?.nodes || [];
  let visited = 0;
  const visit = (index, parent) => {
    const node = nodes[index];
    if (!node || visited++ > MAX_NODES) return;
    const matrix = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes?.[node.mesh]?.primitives || []) {
        const accessor = json.accessors?.[primitive.attributes?.POSITION];
        if (!accessor?.min || !accessor?.max) continue;
        for (let corner = 0; corner < 8; corner++) {
          const point = transform(matrix,
            corner & 1 ? accessor.max[0] : accessor.min[0],
            corner & 2 ? accessor.max[1] : accessor.min[1],
            corner & 4 ? accessor.max[2] : accessor.min[2]);
          for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
          }
        }
      }
    }
    for (const child of node.children || []) visit(child, matrix);
  };
  const roots = json?.scenes?.[json?.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  for (const root of roots) visit(root, IDENTITY);
  if (!Number.isFinite(bounds.min[0]) || !Number.isFinite(bounds.min[2])) return null;
  return { min: bounds.min, max: bounds.max, size: bounds.max.map((value, axis) => value - bounds.min[axis]) };
}

/**
 * The angle, measured from east, that a model file's own length runs along: `0` for a body drawn
 * along X, `90` for one drawn along Z, and `null` when the footprint is too square to say.
 *
 * This is the number the facing field wants when the model is longer than it is wide — which is
 * every vehicle, and most things that get driven along a route. `square` is returned as well so
 * the editor can say *why* nothing was measured instead of leaving the author staring at an
 * unchanged field.
 */
export function modelForwardAngle(json, { tolerance = .05 } = {}) {
  const bounds = modelBounds(json);
  if (!bounds) return null;
  const [sx, , sz] = bounds.size;
  const longest = Math.max(sx, sz);
  if (!(longest > 0)) return null;
  if (Math.abs(sx - sz) <= longest * tolerance) return null;
  return sx > sz ? 0 : 90;
}

/**
 * Measurements already taken, keyed by the asset object itself.
 *
 * The inspector renders on every edit and a model's document is megabytes of JSON, so measuring it
 * again each time would make clicking an object in a game-sized project feel slow. An asset edit
 * replaces the object rather than writing through it (`updateAsset`), so the key changes with the
 * bytes and a stale measurement cannot survive a re-import.
 */
const measured = new WeakMap();

/**
 * The same measurement for one project asset: `null` when it is not a model, when its bytes are
 * gone, or when the geometry is too square to have a front.
 *
 * The document is parsed from the asset itself rather than from anything the editor cached, so an
 * asset that was imported but never previewed still measures.
 */
export function measureAssetForward(asset, { format = null } = {}) {
  if (!asset || asset.kind !== 'model') return null;
  const src = asset.src;
  // The `src` is compared as well as the object, so even a write-through edit is measured again.
  if (!format) {
    const cached = measured.get(asset);
    if (cached && cached.src === src) return cached.angle;
  }
  if (typeof src !== 'string' || !src.startsWith('data:')) return null;
  let angle = null;
  try {
    const bytes = decodeDataURI(src);
    // An asset carries its format, and a MODELDEF-converted OBJ keeps its `.obj`
    // name while storing GLB bytes; the name is only a fallback for old records.
    const kind = format || asset.format || (asset.name?.toLowerCase().endsWith('.glb') ? 'glb' : 'gltf');
    angle = modelForwardAngle(readModel(bytes, kind).json);
  } catch {
    angle = null;
  }
  if (!format) measured.set(asset, { src, angle });
  return angle;
}
