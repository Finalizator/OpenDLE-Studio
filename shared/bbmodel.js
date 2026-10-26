// Reads Blockbench .bbmodel projects and converts them into glTF 2.0 so they
// travel through the same renderer path as authored glTF/GLB files. Geometry,
// per-face atlas UVs, groups, textures and animations are baked here; anything
// Blockbench supports but this converter does not (free-form meshes, particle
// and sound keyframes) is reported as a warning instead of failing the import.
const decoder = new TextDecoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// Blockbench's own glTF export divides by 16 by default: 16 model units are one
// block/metre, and the engine's default model scale of 32 map units per glTF
// unit then gives Minecraft-like proportions.
export const BBMODEL_UNITS_PER_METRE = 16;
const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];
const FACE_NORMALS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };
const CHANNELS = ['rotation', 'position', 'scale'];
const MAX_SAMPLES = 1500;
const DEGREES = Math.PI / 180;
const FLOAT = 5126, UINT16 = 5123, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function readBBModel(bytes) {
  check(bytes.length <= 16 * 1024 * 1024, 'Blockbench model exceeds 16 MiB');
  let model;
  try { model = JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error('Blockbench model is not valid JSON'); }
  check(model && typeof model === 'object' && !Array.isArray(model), 'Blockbench model must be a JSON object');
  check(Array.isArray(model.elements), 'Blockbench model has no elements; save it from Blockbench as .bbmodel');
  check(model.outliner === undefined || model.outliner === null || typeof model.outliner === 'object',
    'Blockbench model has an unsupported outliner');
  for (const element of model.elements) check(element && typeof element === 'object', 'Blockbench element is invalid');
  for (const texture of model.textures || []) check(texture && typeof texture === 'object', 'Blockbench texture is invalid');
  return model;
}

// Blockbench values are Molang strings, e.g. "math.sin(query.anim_time * 120) * 18".
// Molang trigonometry works in degrees.
const FUNCTIONS = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc, sign: Math.sign,
  sqrt: Math.sqrt, exp: Math.exp, log: Math.log, pow: Math.pow, min: Math.min, max: Math.max, hypot: Math.hypot,
  mod: (left, right) => ((left % right) + right) % right,
  clamp: (value, low, high) => Math.min(Math.max(value, low), high),
  lerp: (start, end, amount) => start + (end - start) * amount,
  sin: value => Math.sin(value * DEGREES), cos: value => Math.cos(value * DEGREES), tan: value => Math.tan(value * DEGREES),
  asin: value => Math.asin(Math.min(1, Math.max(-1, value))) / DEGREES,
  acos: value => Math.acos(Math.min(1, Math.max(-1, value))) / DEGREES,
  atan: value => Math.atan(value) / DEGREES,
  atan2: (y, x) => Math.atan2(y, x) / DEGREES,
  // Molang randomness cannot be baked reproducibly, so animations use the midpoint.
  random: (low, high) => (low + high) / 2,
  roll: () => 0,
};

function tokenizeExpression(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === ' ' || character === '\n' || character === '\r' || character === '\t') { index += 1; continue; }
    if ((character >= '0' && character <= '9') || character === '.') {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(source.slice(index));
      if (!match) throw new Error(`Unsupported number in animation value "${source}"`);
      tokens.push({ type: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index));
      tokens.push({ type: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    if ('+-*/%(),'.includes(character)) { tokens.push({ type: character }); index += 1; continue; }
    throw new Error(`Unsupported "${character}" in animation value "${source}"`);
  }
  return tokens;
}

function variableValue(name, variables) {
  if (name === 'math.pi') return Math.PI;
  if (name === 'math.e') return Math.E;
  const key = name.replace(/^(?:q|query)\./, '');
  if (Object.hasOwn(variables, key)) return variables[key];
  throw new Error(`Unsupported animation variable "${name}"`);
}

function callFunction(name, args) {
  const short = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const fn = FUNCTIONS[short];
  if (!fn) throw new Error(`Unsupported animation function "${name}"`);
  const value = Number(fn(...args));
  check(Number.isFinite(value), `Animation function "${name}" did not return a number`);
  return value;
}

// Evaluates one Blockbench value. Throws for scripts the converter cannot bake so
// the caller can warn once and fall back to a constant.
export function evaluateMolang(source, variables = {}) {
  if (typeof source === 'number') return Number.isFinite(source) ? source : 0;
  if (source === undefined || source === null) return 0;
  const text = String(source).replace(/\n/g, ' ').trim();
  if (!text) return 0;
  const tokens = tokenizeExpression(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = type => {
    const token = tokens[position];
    if (!token || token.type !== type) throw new Error(`Animation value "${text}" is incomplete`);
    position += 1;
    return token;
  };
  function additive() {
    let value = multiplicative();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const type = tokens[position++].type;
      const right = multiplicative();
      value = type === '+' ? value + right : value - right;
    }
    return value;
  }
  function multiplicative() {
    let value = unary();
    while (peek() && ['*', '/', '%'].includes(peek().type)) {
      const type = tokens[position++].type;
      const right = unary();
      value = type === '*' ? value * right : type === '/' ? value / right : value % right;
    }
    return value;
  }
  function unary() {
    if (peek()?.type === '-') { position += 1; return -unary(); }
    if (peek()?.type === '+') { position += 1; return unary(); }
    return primary();
  }
  function primary() {
    const token = peek();
    if (!token) throw new Error(`Animation value "${text}" ended early`);
    if (token.type === 'number') { position += 1; return token.value; }
    if (token.type === '(') { position += 1; const value = additive(); take(')'); return value; }
    if (token.type === 'name') {
      position += 1;
      if (peek()?.type !== '(') return variableValue(token.value, variables);
      position += 1;
      const args = [];
      if (peek()?.type !== ')') {
        args.push(additive());
        while (peek()?.type === ',') { position += 1; args.push(additive()); }
      }
      take(')');
      return callFunction(token.value, args);
    }
    throw new Error(`Animation value "${text}" is not a number`);
  }
  const value = additive();
  check(position === tokens.length, `Animation value "${text}" is not a single expression`);
  check(Number.isFinite(value), `Animation value "${text}" is not a finite number`);
  return value;
}

function leadingNumber(source) {
  const text = String(source ?? '').replace(/\n/g, ' ').trim();
  const match = /^[-+]?\s*[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(text);
  const value = match ? Number(match[0].replace(/\s/g, '')) : 0;
  return Number.isFinite(value) ? value : 0;
}

function vector(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value) || value.length < 3) return fallback.slice();
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
}

function vector4(value) {
  if (!Array.isArray(value) || value.length < 4) return [0, 0, 0, 0];
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0, Number(value[3]) || 0];
}

function multiplyQuaternions(left, right) {
  return [
    left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
    left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
    left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
    left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
  ];
}

function axisQuaternion(axis, radians) {
  const half = radians / 2, sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

// Blockbench reads element and group rotations as three.js Euler angles in ZYX order.
export function quaternionFromEulerDegrees(degrees) {
  const [x, y, z] = degrees;
  const rotation = multiplyQuaternions(
    multiplyQuaternions(axisQuaternion([0, 0, 1], z * DEGREES), axisQuaternion([0, 1, 0], y * DEGREES)),
    axisQuaternion([1, 0, 0], x * DEGREES));
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]) || 1;
  return rotation.map(value => value / length);
}

// Blockbench keeps rotated cubes slightly oversized so the rotated box still fills
// the space the user sees; its preview applies the same rescale to the mesh.
function rescalingFactor(degrees) {
  let angle = Math.abs(degrees) % 180;
  if (angle > 90) angle = 180 - angle;
  if (angle > 45) angle = 90 - angle;
  return 1 / Math.cos(angle * DEGREES);
}

// Cube corners after `inflate`/`stretch`, with degenerate axes widened like the
// Blockbench preview does so a flat cube still produces visible faces.
function cubeBounds(element) {
  const from = vector(element.from), to = vector(element.to);
  const half = [(to[0] - from[0]) / 2, (to[1] - from[1]) / 2, (to[2] - from[2]) / 2];
  const center = [from[0] + half[0], from[1] + half[1], from[2] + half[2]];
  const inflate = Number(element.inflate) || 0;
  const stretch = vector(element.stretch, [1, 1, 1]);
  const low = [], high = [], size = [];
  for (let axis = 0; axis < 3; axis++) {
    const extent = Math.abs((half[axis] + inflate) * (stretch[axis] || 1));
    const start = center[axis] - extent;
    low.push(start);
    high.push(extent ? center[axis] + extent : start + 0.001);
    size.push(Math.abs(to[axis] - from[axis]));
  }
  return { from: low, to: high, size };
}

function faceCorners(name, from, to) {
  switch (name) {
    case 'east': return [[to[0], to[1], to[2]], [to[0], to[1], from[2]], [to[0], from[1], to[2]], [to[0], from[1], from[2]]];
    case 'west': return [[from[0], to[1], from[2]], [from[0], to[1], to[2]], [from[0], from[1], from[2]], [from[0], from[1], to[2]]];
    case 'up': return [[from[0], to[1], from[2]], [to[0], to[1], from[2]], [from[0], to[1], to[2]], [to[0], to[1], to[2]]];
    case 'down': return [[from[0], from[1], to[2]], [to[0], from[1], to[2]], [from[0], from[1], from[2]], [to[0], from[1], from[2]]];
    case 'south': return [[from[0], to[1], to[2]], [to[0], to[1], to[2]], [from[0], from[1], to[2]], [to[0], from[1], to[2]]];
    default: return [[to[0], to[1], from[2]], [from[0], to[1], from[2]], [to[0], from[1], from[2]], [from[0], from[1], from[2]]];
  }
}

// Box UV cubes derive their atlas rectangles from the cube size; the rectangles
// stored in the file are only a cache of this layout.
function boxUvRect(faceName, size, uvOffset, mirror) {
  const [width, height, depth] = size;
  const layout = {
    east: { from: [0, depth], size: [depth, height] },
    west: { from: [depth + width, depth], size: [depth, height] },
    up: { from: [depth + width, depth], size: [-width, -depth] },
    down: { from: [depth + width * 2, 0], size: [-width, depth] },
    south: { from: [depth * 2 + width, depth], size: [width, height] },
    north: { from: [depth, depth], size: [width, height] },
  };
  if (mirror) {
    for (const face of Object.values(layout)) { face.from[0] += face.size[0]; face.size[0] *= -1; }
    const east = layout.east;
    layout.east = layout.west;
    layout.west = east;
  }
  const face = layout[faceName];
  if (!face) return [0, 0, 0, 0];
  return [face.from[0] + uvOffset[0], face.from[1] + uvOffset[1],
    face.from[0] + face.size[0] + uvOffset[0], face.from[1] + face.size[1] + uvOffset[1]];
}

// glTF UVs start in the bottom-left corner, Blockbench in the top-left, and a face
// can be rotated in 90 degree steps inside the atlas.
function faceUvCorners(rect, rotation, uvWidth, uvHeight) {
  const [u1, v1, u2, v2] = rect;
  const corners = [
    [u1 / uvWidth, 1 - v1 / uvHeight],
    [u2 / uvWidth, 1 - v1 / uvHeight],
    [u1 / uvWidth, 1 - v2 / uvHeight],
    [u2 / uvWidth, 1 - v2 / uvHeight],
  ];
  let remaining = Math.round((Number(rotation) || 0) / 90) * 90;
  while (remaining >= 90) {
    const first = corners[0];
    corners[0] = corners[2]; corners[2] = corners[3]; corners[3] = corners[1]; corners[1] = first;
    remaining -= 90;
  }
  return corners;
}

function pngHasAlpha(source) {
  if (!source.startsWith('data:image/png')) return false;
  try {
    const start = source.indexOf(',') + 1;
    const base64 = source.slice(start, start + 512);
    const binary = atob(base64.slice(0, base64.length - (base64.length % 4)));
    const colorType = binary.charCodeAt(25);
    return colorType === 4 || colorType === 6 || binary.slice(0, 320).includes('tRNS');
  } catch { return false; }
}

function createAccessorWriter() {
  const parts = [], bufferViews = [], accessors = [];
  let length = 0;
  function pushView(array, target) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    parts.push(bytes);
    length += bytes.length;
    const padding = (4 - (length % 4)) % 4;
    if (padding) { parts.push(new Uint8Array(padding)); length += padding; }
    return bufferViews.length - 1;
  }
  function bounds(values, size) {
    const min = Array.from({ length: size }, () => Infinity), max = Array.from({ length: size }, () => -Infinity);
    for (let offset = 0; offset < values.length; offset += size) {
      for (let axis = 0; axis < size; axis++) {
        min[axis] = Math.min(min[axis], values[offset + axis]);
        max[axis] = Math.max(max[axis], values[offset + axis]);
      }
    }
    return { min, max };
  }
  function float(array, type, withBounds) {
    const size = COMPONENTS[type];
    const accessor = { bufferView: pushView(array, ARRAY_BUFFER), componentType: FLOAT, count: array.length / size, type };
    if (withBounds) Object.assign(accessor, bounds(array, size));
    accessors.push(accessor);
    return accessors.length - 1;
  }
  return {
    position: values => float(new Float32Array(values), 'VEC3', true),
    attribute: (values, type) => float(new Float32Array(values), type, false),
    time: values => float(new Float32Array(values), 'SCALAR', true),
    indices(values) {
      let highest = 0;
      for (const value of values) highest = Math.max(highest, value);
      const array = highest > 65535 ? new Uint32Array(values) : new Uint16Array(values);
      const accessor = {
        bufferView: pushView(array, ELEMENT_ARRAY_BUFFER), componentType: array instanceof Uint32Array ? UINT32 : UINT16,
        count: array.length, type: 'SCALAR', ...bounds(array, 1),
      };
      accessors.push(accessor);
      return accessors.length - 1;
    },
    finish() {
      const binary = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { binary.set(part, offset); offset += part.length; }
      return { binary, bufferViews, accessors };
    },
  };
}

// Converts a parsed .bbmodel document into glTF 2.0 plus the binary buffer it
// references. Warnings list everything that was approximated or skipped.
export function bbmodelToGltf(model, { scale = 1 / BBMODEL_UNITS_PER_METRE, samplesPerSecond } = {}) {
  const unit = Number(scale);
  check(Number.isFinite(unit) && unit > 0, 'Blockbench import scale must be a positive number');
  const warnings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const resolution = model.resolution || {};
  const textureEntries = Array.isArray(model.textures) ? model.textures : [];
  const accessors = createAccessorWriter();
  const images = [], textures = [], materials = [], meshes = [], nodes = [];
  const restRotations = [], rootNodes = [];
  const materialByTexture = new Map();
  const nodeIndexByUuid = new Map();
  let skippedMeshes = 0, skippedEmpties = 0;

  function textureAt(reference) {
    if (typeof reference === 'number') return textureEntries[reference] || null;
    if (typeof reference === 'string') return textureEntries.find(texture => texture.uuid === reference) || null;
    return null;
  }

  function materialFor(reference) {
    const texture = textureAt(reference);
    if (!texture) return null;
    const key = textureEntries.indexOf(texture);
    if (materialByTexture.has(key)) return materialByTexture.get(key);
    const source = typeof texture.source === 'string' ? texture.source : '';
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source)) {
      warn(`Texture "${texture.name || key}" has no embedded image, so its faces were skipped. Save the model with embedded textures in Blockbench.`);
      materialByTexture.set(key, null);
      return null;
    }
    // glTF allows mimeType only for bufferView images, so a data URI carries its own type.
    images.push({ uri: source });
    textures.push({ source: images.length - 1, sampler: 0 });
    const alpha = pngHasAlpha(source);
    materials.push({
      name: String(texture.name || `texture_${key}`).slice(0, 200),
      pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: alpha ? 'MASK' : 'OPAQUE',
      ...(alpha ? { alphaCutoff: 0.5 } : {}),
      doubleSided: true,
    });
    const index = materials.length - 1;
    materialByTexture.set(key, index);
    return index;
  }

  function uvSize(texture) {
    const width = Number(texture?.uv_width) || Number(texture?.width) || Number(resolution.width) || 16;
    const height = Number(texture?.uv_height) || Number(texture?.height) || Number(resolution.height) || 16;
    return [width > 0 ? width : 16, height > 0 ? height : 16];
  }

  function nameOf(entry, index) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    return (name || `node_${index}`).slice(0, 200);
  }

  function cubeMesh(element) {
    const bounds = cubeBounds(element);
    const origin = vector(element.origin);
    const uvOffset = Array.isArray(element.uv_offset)
      ? [Number(element.uv_offset[0]) || 0, Number(element.uv_offset[1]) || 0]
      : [0, 0];
    const buckets = new Map();
    for (const faceName of FACE_ORDER) {
      const face = element.faces?.[faceName];
      if (!face || face.texture === null || face.texture === undefined) continue;
      const material = materialFor(face.texture);
      if (material === null) continue;
      const [uvWidth, uvHeight] = uvSize(textureAt(face.texture));
      const rect = element.box_uv ? boxUvRect(faceName, bounds.size, uvOffset, element.mirror_uv) : vector4(face.uv);
      const uvs = faceUvCorners(rect, face.rotation, uvWidth, uvHeight);
      const corners = faceCorners(faceName, bounds.from, bounds.to);
      const normal = FACE_NORMALS[faceName];
      if (!buckets.has(material)) buckets.set(material, { positions: [], normals: [], uvs: [], indices: [], count: 0 });
      const bucket = buckets.get(material);
      const base = bucket.count;
      for (const [index, corner] of corners.entries()) {
        bucket.positions.push((corner[0] - origin[0]) * unit, (corner[1] - origin[1]) * unit, (corner[2] - origin[2]) * unit);
        bucket.normals.push(...normal);
        bucket.uvs.push(...uvs[index]);
        bucket.count += 1;
      }
      bucket.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
    if (!buckets.size) return null;
    const primitives = [];
    for (const [material, bucket] of buckets) {
      primitives.push({
        attributes: {
          POSITION: accessors.position(bucket.positions),
          NORMAL: accessors.attribute(bucket.normals, 'VEC3'),
          TEXCOORD_0: accessors.attribute(bucket.uvs, 'VEC2'),
        },
        indices: accessors.indices(bucket.indices), material, mode: 4,
      });
    }
    meshes.push({ name: nameOf(element, meshes.length), primitives });
    return meshes.length - 1;
  }

  function addNode(entry, parentOrigin, rotation) {
    const index = nodes.length;
    const origin = vector(entry.origin, vector(entry.position));
    nodes.push({
      name: nameOf(entry, index),
      translation: [(origin[0] - parentOrigin[0]) * unit, (origin[1] - parentOrigin[1]) * unit, (origin[2] - parentOrigin[2]) * unit],
      rotation: quaternionFromEulerDegrees(rotation),
    });
    restRotations[index] = rotation;
    if (entry.uuid) nodeIndexByUuid.set(entry.uuid, index);
    return index;
  }

  const elements = new Map((model.elements || []).filter(element => element.uuid).map(element => [element.uuid, element]));
  const groups = new Map((model.groups || []).filter(group => group.uuid).map(group => [group.uuid, group]));
  const outlinerChildren = new Map(), visited = new Set();

  // Nested outliner entries carry the real hierarchy; group records only mirror it
  // for some formats, so every level has to be registered here.
  function registerOutliner(entries) {
    const roots = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const uuid = typeof entry === 'string' ? entry : entry?.uuid;
      if (!uuid) continue;
      roots.push(uuid);
      if (typeof entry === 'object' && Array.isArray(entry.children)) {
        outlinerChildren.set(uuid, entry.children);
        registerOutliner(entry.children);
      }
    }
    return roots;
  }
  let outlinerRoots = registerOutliner(model.outliner);
  if (!outlinerRoots.length) outlinerRoots = registerOutliner(model.outliner?.children);
  const childrenOf = uuid => outlinerChildren.get(uuid) ?? (Array.isArray(groups.get(uuid)?.children) ? groups.get(uuid).children : []);

  function buildNode(uuid, parentOrigin) {
    if (!uuid || visited.has(uuid)) return null;
    visited.add(uuid);
    const group = groups.get(uuid), element = elements.get(uuid);
    if (group) {
      const origin = vector(group.origin);
      const index = addNode(group, parentOrigin, vector(group.rotation));
      const children = [];
      for (const child of childrenOf(uuid)) {
        const childIndex = buildNode(typeof child === 'string' ? child : child?.uuid, origin);
        if (childIndex !== null) children.push(childIndex);
      }
      if (children.length) nodes[index].children = children;
      return index;
    }
    if (!element) {
      warn('The Blockbench outliner points at an object that is missing from the file; it was skipped.');
      return null;
    }
    if (element.export === false) return null;
    const origin = vector(element.origin, vector(element.position));
    const rotation = vector(element.rotation);
    const index = addNode(element, parentOrigin, rotation);
    if (element.type !== 'cube') {
      if (element.type === 'mesh' || element.type === 'spline') skippedMeshes += 1;
      else skippedEmpties += 1;
      return index;
    }
    if (element.rescale === true) {
      const factor = rotation.map(rescalingFactor);
      nodes[index].scale = [factor[1] * factor[2], factor[0] * factor[2], factor[0] * factor[1]];
    }
    const mesh = cubeMesh(element);
    if (mesh !== null) nodes[index].mesh = mesh;
    return index;
  }

  if (!outlinerRoots.length) {
    for (const uuid of groups.keys()) outlinerRoots.push(uuid);
    if (!outlinerRoots.length) warn('The Blockbench outliner is empty, so elements were imported without their groups.');
  }
  for (const uuid of outlinerRoots) {
    const index = buildNode(uuid, [0, 0, 0]);
    if (index !== null) rootNodes.push(index);
  }
  // Elements missing from the outliner are still part of the model.
  for (const uuid of elements.keys()) {
    if (visited.has(uuid)) continue;
    const index = buildNode(uuid, [0, 0, 0]);
    if (index !== null) rootNodes.push(index);
  }
  if (skippedMeshes) warn(`${skippedMeshes} Blockbench mesh element(s) were imported without geometry; convert them to cubes for a full import.`);
  if (skippedEmpties) warn(`${skippedEmpties} locator/empty element(s) were imported as empty nodes.`);
  if (!rootNodes.length) throw new Error('Blockbench model has no exportable elements');

  const animations = buildAnimations();
  const { binary, bufferViews, accessors: accessorList } = accessors.finish();
  const json = {
    asset: { version: '2.0', generator: 'OpenDLE Blockbench importer' },
    scene: 0,
    scenes: [{ name: typeof model.name === 'string' && model.name ? model.name.slice(0, 200) : 'Blockbench model', nodes: rootNodes }],
    nodes, meshes, accessors: accessorList, bufferViews, buffers: [{ byteLength: binary.length }],
  };
  if (materials.length) Object.assign(json, { materials, textures, images, samplers: [{ magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 }] });
  if (animations.length) json.animations = animations;
  return { json, binary, warnings };

  function buildAnimations() {
    const clips = [], names = new Set();
    for (const animation of Array.isArray(model.animations) ? model.animations : []) {
      if (!animation || typeof animation !== 'object') continue;
      const animators = animation.animators && typeof animation.animators === 'object' ? animation.animators : {};
      const channels = [], samplers = [];
      let unsupported = false;
      for (const [uuid, animator] of Object.entries(animators)) {
        const node = nodeIndexByUuid.get(uuid);
        if (node === undefined) continue;
        const keyframes = collectKeyframes(animator);
        for (const channel of CHANNELS) {
          if (!keyframes[channel].length) continue;
          const track = bakeChannel(animation, node, channel, keyframes[channel], () => { unsupported = true; });
          samplers.push(track.sampler);
          channels.push({ sampler: samplers.length - 1, target: { node, path: track.path } });
        }
      }
      if (unsupported) warn(`Animation "${animation.name || 'unnamed'}" uses Blockbench scripts that cannot be evaluated; those values were baked as constants.`);
      if (!channels.length) {
        warn(`Animation "${animation.name || 'unnamed'}" animates nothing that was imported, so it was skipped.`);
        continue;
      }
      let name = typeof animation.name === 'string' && animation.name.trim() ? animation.name.trim().slice(0, 200) : `animation_${clips.length}`;
      while (names.has(name)) name = `${name}_${clips.length}`;
      names.add(name);
      clips.push({ name, channels, samplers });
    }
    return clips;
  }

  // Blockbench saves keyframes per channel; older files use plain arrays instead.
  function collectKeyframes(animator) {
    const keyframes = { rotation: [], position: [], scale: [] };
    const add = (channel, keyframe) => {
      if (!keyframes[channel]) return;
      const points = Array.isArray(keyframe?.data_points) ? keyframe.data_points : [];
      if (!points.length) return;
      keyframes[channel].push({ time: Number(keyframe.time) || 0, interpolation: keyframe.interpolation || 'linear', point: points[0] });
    };
    if (Array.isArray(animator.keyframes)) for (const keyframe of animator.keyframes) add(keyframe?.channel, keyframe);
    for (const channel of CHANNELS) {
      if (keyframes[channel].length || !Array.isArray(animator[channel])) continue;
      for (const keyframe of animator[channel]) add(channel, keyframe);
    }
    for (const channel of CHANNELS) keyframes[channel].sort((left, right) => left.time - right.time);
    return keyframes;
  }

  // Every channel is sampled on one shared timeline so expressions, Bezier and
  // Catmull-Rom keyframes all become plain glTF LINEAR samples.
  function bakeChannel(animation, node, channel, frames, markUnsupported) {
    const length = Math.max(Number(animation.length) || 0, frames[frames.length - 1].time, 0);
    let fps = Math.min(Math.max(Number(animation.snapping) || Number(samplesPerSecond) || 24, 1), 120);
    let count = Math.max(1, Math.floor(length * fps) + 1);
    if (count > MAX_SAMPLES) {
      fps = Math.max(1, (MAX_SAMPLES - 1) / Math.max(length, 1 / MAX_SAMPLES));
      count = Math.max(1, Math.floor(length * fps) + 1);
    }
    const times = Array.from({ length: count }, (_, index) => Math.min(index / fps, length));
    const values = [];
    for (const time of times) values.push(...sample(channel, node, frames, time, markUnsupported));
    return {
      path: channel === 'rotation' ? 'rotation' : channel === 'position' ? 'translation' : 'scale',
      sampler: {
        input: accessors.time(times),
        output: accessors.attribute(values, channel === 'rotation' ? 'VEC4' : 'VEC3'),
        interpolation: 'LINEAR',
      },
    };
  }

  function sample(channel, node, frames, time, markUnsupported) {
    let index = 0;
    while (index + 1 < frames.length && frames[index + 1].time <= time) index += 1;
    const current = frames[index], next = frames[index + 1];
    const read = point => ['x', 'y', 'z'].map(axis => {
      const raw = point?.[axis];
      try { return evaluateMolang(raw, { anim_time: time, life_time: time, time }); }
      catch { markUnsupported(); return leadingNumber(raw); }
    });
    const start = read(current.point);
    let values = start;
    if (next && current.interpolation !== 'step') {
      const end = read(next.point);
      const span = next.time - current.time;
      const amount = span > 0 ? Math.min(Math.max((time - current.time) / span, 0), 1) : 1;
      values = start.map((value, axis) => value + (end[axis] - value) * amount);
    }
    // Keyframes are offsets from the rest pose, exactly like Blockbench adds them.
    if (channel === 'rotation') {
      const rest = restRotations[node] || [0, 0, 0];
      return quaternionFromEulerDegrees([rest[0] + values[0], rest[1] + values[1], rest[2] + values[2]]);
    }
    if (channel === 'position') {
      const rest = nodes[node].translation || [0, 0, 0];
      return values.map((value, axis) => rest[axis] + value * unit);
    }
    const rest = nodes[node].scale || [1, 1, 1];
    return values.map((value, axis) => rest[axis] * value);
  }
}
