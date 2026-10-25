const decoder = new TextDecoder();
function check(condition, message) {
  if (!condition) throw new Error(message);
}
export function decodeDataURI(src) {
  const comma = src.indexOf(',');
  const binary = atob(src.slice(comma + 1));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
export function dataURI(bytes, type) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}
export function readModel(bytes, format) {
  check(bytes.length <= 16 * 1024 * 1024, 'Model exceeds 16 MiB');
  if (format === 'gltf') return { json: JSON.parse(decoder.decode(bytes)) };
  check(bytes.length >= 20, 'Truncated GLB header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.length, 'Invalid GLB 2.0 header');
  let offset = 12, json, binary;
  while (offset < bytes.length) {
    check(offset + 8 <= bytes.length, 'Truncated GLB chunk');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    check(length % 4 === 0 && offset + 8 + length <= bytes.length, 'Invalid GLB chunk length');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset === 12) check(type === 0x4e4f534a, 'GLB must start with a JSON chunk');
    if (type === 0x4e4f534a) { check(!json, 'Duplicate GLB JSON chunk'); json = JSON.parse(decoder.decode(chunk)); }
    if (type === 0x004e4942) { check(!binary, 'Duplicate GLB BIN chunk'); binary = chunk; }
    offset += 8 + length;
  }
  check(json, 'GLB JSON is missing');
  return { json, binary };
}

const unsupported = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu']);
const supported = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_sheen',
  'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_iridescence', 'KHR_materials_anisotropy',
  'KHR_materials_dispersion', 'KHR_mesh_quantization', 'KHR_lights_punctual', 'EXT_texture_webp', 'EXT_mesh_gpu_instancing']);
export function validateModelDocument(json, binaryLength = 0) {
  check(json?.asset?.version === '2.0', 'Only glTF 2.0 is supported');
  for (const extension of json.extensionsRequired || []) {
    check(!unsupported.has(extension), `${extension} needs an external decoder; export an uncompressed GLB/glTF`);
    check(supported.has(extension), `Required extension ${extension} is not supported`);
  }
  for (const extension of json.extensionsUsed || []) check(!unsupported.has(extension), `${extension} requires an unsupported decoder`);
  const limits = { nodes: 10000, meshes: 2000, accessors: 20000, materials: 2000, animations: 256, skins: 512, images: 256, buffers: 256, bufferViews: 20000, textures: 512, scenes: 256 };
  for (const [key, max] of Object.entries(limits)) if (json[key] !== undefined) check(Array.isArray(json[key]) && json[key].length <= max, `Model ${key} exceeds limit ${max}`);
  let budget = 0;
  for (const [index, buffer] of (json.buffers || []).entries()) {
    check(Number.isSafeInteger(buffer.byteLength) && buffer.byteLength >= 0, 'Invalid model buffer size');
    budget += buffer.byteLength;
    if (buffer.uri) {
      check(/^data:application\/(octet-stream|gltf-buffer);base64,[A-Za-z0-9+/]+={0,2}$/.test(buffer.uri), 'Model buffers must be embedded data, not network URLs');
      check(decodeDataURI(buffer.uri).length >= buffer.byteLength, 'Model buffer data is truncated');
    }
    else check(index === 0 && binaryLength >= buffer.byteLength, 'Missing GLB binary data');
  }
  check(budget <= 32 * 1024 * 1024, 'Decoded model buffer budget exceeds 32 MiB');
  for (const view of json.bufferViews || []) {
    const buffer = json.buffers?.[view.buffer];
    check(buffer && Number.isSafeInteger(view.byteLength) && view.byteLength >= 0 &&
      Number.isSafeInteger(view.byteOffset || 0) && (view.byteOffset || 0) >= 0 &&
      (view.byteOffset || 0) + view.byteLength <= buffer.byteLength, 'Model buffer view is out of bounds');
  }
  for (const image of json.images || []) {
    if (image.uri) check(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.uri), 'Model textures must be embedded PNG/JPEG/WebP');
    else check(json.bufferViews?.[image.bufferView] && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType), 'Invalid embedded model image');
  }
  let vertices = 0;
  for (const accessor of json.accessors || []) {
    check(Number.isSafeInteger(accessor.count) && accessor.count >= 0 && accessor.count <= 1000000, 'Invalid model accessor count');
    vertices += accessor.count;
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[accessor.type];
    const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
    check(components && bytes, 'Invalid model accessor type');
    if (accessor.bufferView !== undefined) {
      const view = json.bufferViews?.[accessor.bufferView], offset = accessor.byteOffset || 0;
      check(view && Number.isSafeInteger(offset) && offset >= 0, 'Invalid accessor buffer view or offset');
      const elementSize = accessor.type.startsWith('MAT') ? Number(accessor.type.at(-1)) * Math.ceil(Number(accessor.type.at(-1)) * bytes / 4) * 4 : components * bytes;
      const stride = view.byteStride ?? elementSize;
      check(Number.isInteger(stride) && stride >= elementSize && stride <= 252, 'Invalid accessor byte stride');
      check(offset + (accessor.count ? (accessor.count - 1) * stride + elementSize : 0) <= view.byteLength, 'Model accessor is out of bounds');
    }
  }
  check(vertices <= 8000000, 'Model accessor budget exceeded');
  const active = new Set(), done = new Set();
  function visit(index, depth = 0) {
    check(depth <= 256, 'Model hierarchy exceeds 256 levels');
    check(Number.isInteger(index) && json.nodes?.[index], 'Model references an invalid node');
    check(!active.has(index), 'Model node hierarchy contains a cycle');
    if (done.has(index)) return;
    active.add(index);
    for (const child of json.nodes[index].children || []) visit(child, depth + 1);
    active.delete(index); done.add(index);
  }
  (json.nodes || []).forEach((node, index) => visit(index));
  for (const animation of json.animations || []) {
    check(Array.isArray(animation.channels) && animation.channels.length <= 10000, 'Invalid animation channels');
    for (const channel of animation.channels) {
      const sampler = animation.samplers?.[channel.sampler];
      check(sampler && json.accessors?.[sampler.input] && json.accessors?.[sampler.output], 'Animation references an invalid sampler or accessor');
      if (channel.target?.node !== undefined) check(json.nodes?.[channel.target.node], 'Animation targets an invalid node');
    }
  }
  return json;
}

export function modelMetadata(json) {
  const names = new Set();
  return {
    animations: (json.animations || []).map((clip, index) => {
      let name = clip.name || `animation_${index}`;
      while (names.has(name)) name = `${name}_${index}`;
      check(typeof name === 'string' && name.length <= 200, 'Animation clip name exceeds 200 characters');
      names.add(name); clip.name = name;
      return name;
    }),
    nodes: json.nodes?.length || 0, meshes: json.meshes?.length || 0, skins: json.skins?.length || 0,
  };
}

export function encodeGLB(json, binary) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const binaryLength = binary ? Math.ceil(binary.length / 4) * 4 : 0;
  const result = new Uint8Array(12 + 8 + jsonLength + (binary ? 8 + binaryLength : 0));
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonLength); result.set(jsonBytes, 20);
  if (binary) {
    view.setUint32(20 + jsonLength, binaryLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
    result.set(binary, 28 + jsonLength);
  }
  return result;
}

export async function bundleModel(file, files, id) {
  const format = file.name.toLowerCase().endsWith('.glb') ? 'glb' : 'gltf';
  let bytes = new Uint8Array(await file.arrayBuffer());
  const { json, binary } = readModel(bytes, format);
  const warnings = [];
  if (format === 'gltf') {
    const lookup = new Map(files.map(item => [(item.webkitRelativePath || item.name).replaceAll('\\', '/'), item]));
    const sourcePath = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
    const directory = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
    for (const resource of [...(json.buffers || []), ...(json.images || [])]) {
      if (!resource.uri || resource.uri.startsWith('data:')) continue;
      check(!/^(https?:|file:|\/|\\)/i.test(resource.uri), 'External model network/file URLs are not allowed');
      const decoded = decodeURIComponent(resource.uri).replaceAll('\\', '/');
      check(!decoded.split('/').includes('..'), 'Parent paths are not allowed in model resources');
      const uri = decoded.split('/').filter(part => part && part !== '.').join('/');
      const exact = lookup.get(directory + uri);
      const matches = exact ? [[directory + uri, exact]] : [...lookup.entries()].filter(([path]) => path === uri || path.endsWith(`/${uri}`));
      check(matches.length === 1, `Select the exact dependency ${uri} with the .gltf (or use embedded GLB)`);
      const dependency = matches[0][1];
      check(dependency.size <= 16 * 1024 * 1024, `Model dependency ${uri} exceeds 16 MiB`);
      const type = (json.images || []).includes(resource)
        ? /\.png$/i.test(uri) ? 'image/png' : /\.jpe?g$/i.test(uri) ? 'image/jpeg' : /\.webp$/i.test(uri) ? 'image/webp' : ''
        : 'application/octet-stream';
      check(type, 'Model textures must be PNG/JPEG/WebP');
      resource.uri = dataURI(new Uint8Array(await dependency.arrayBuffer()), type);
    }
  }
  validateModelDocument(json, binary?.length);
  const metadata = modelMetadata(json);
  if ((json.extensionsUsed || []).some(extension => unsupported.has(extension))) throw new Error('Compressed model extensions are not supported; export uncompressed GLB/glTF');
  if ((json.extensionsUsed || []).some(extension => !supported.has(extension))) warnings.push('Optional glTF extensions may not be supported by the renderer.');
  if (format === 'gltf') bytes = new TextEncoder().encode(JSON.stringify(json));
  else bytes = encodeGLB(json, binary);
  check(bytes.length <= 16 * 1024 * 1024, 'Bundled model exceeds 16 MiB');
  return { asset: { id, name: file.name.slice(0, 100), kind: 'model', format, src: dataURI(bytes, format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json'), ...metadata }, warnings };
}
