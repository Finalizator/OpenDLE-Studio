import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readBBModel, bbmodelToGltf, evaluateMolang, quaternionFromEulerDegrees, BBMODEL_UNITS_PER_METRE } from '../shared/bbmodel.js';
import { encodeGLB, readModel, validateModelDocument, bundleModel } from '../shared/gltf.js';
import { createProject, validateProject } from '../shared/project.js';
import { groupDroppedFiles, readDroppedFiles } from '../public/asset-drop.js';

const FACES = ['east', 'west', 'up', 'down', 'south', 'north'];
const UNIT = BBMODEL_UNITS_PER_METRE;

function textureDataURI(width = 16, height = 16) {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    png.data[index * 4] = index % 256; png.data[index * 4 + 1] = 120; png.data[index * 4 + 2] = 200; png.data[index * 4 + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
const TEXTURE = { name: 'atlas.png', width: 16, height: 16, uv_width: 16, uv_height: 16, source: textureDataURI() };

function cube(uuid, from, to, extra = {}) {
  const faces = {};
  for (const face of FACES) faces[face] = { uv: [0, 0, 16, 16], texture: 0 };
  return { uuid, name: uuid, type: 'cube', from, to, origin: from, faces, box_uv: false, ...extra };
}

function bbmodel(overrides = {}) {
  return {
    meta: { format_version: '5.0', model_format: 'free', box_uv: false },
    name: 'Fixture', resolution: { width: 16, height: 16 },
    elements: [cube('cube-a', [0, 0, 0], [16, 16, 16])], groups: [], outliner: ['cube-a'],
    textures: [TEXTURE], animations: [],
    ...overrides,
  };
}

function accessorValues(json, binary, index) {
  const accessor = json.accessors[index], view = json.bufferViews[accessor.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const Type = accessor.componentType === 5126 ? Float32Array : accessor.componentType === 5123 ? Uint16Array : Uint32Array;
  const start = view.byteOffset + (accessor.byteOffset || 0);
  return Array.from(new Type(binary.buffer, binary.byteOffset + start, accessor.count * size));
}

const quaternionOf = degrees => new Quaternion()
  .setFromEuler(new Euler(degrees[0] * Math.PI / 180, degrees[1] * Math.PI / 180, degrees[2] * Math.PI / 180, 'ZYX')).toArray();
const rounded = values => values.map(value => +value.toFixed(6));
const closeTo = (actual, expected, message) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${message} [${index}] ${value} vs ${expected[index]}`));

test('Blockbench files are rejected when they are not a saved project', () => {
  assert.throws(() => readBBModel(new TextEncoder().encode('not json')), /not valid JSON/);
  assert.throws(() => readBBModel(new TextEncoder().encode('{"name":"x"}')), /no elements/);
  assert.throws(() => readBBModel(new Uint8Array(16 * 1024 * 1024 + 1)), /16 MiB/);
  assert.equal(readBBModel(new TextEncoder().encode(JSON.stringify(bbmodel()))).name, 'Fixture');
});

test('Blockbench animation values understand Molang expressions in degrees', () => {
  assert.equal(evaluateMolang('180\n\n'), 180);
  assert.equal(evaluateMolang('-14.7669'), -14.7669);
  assert.equal(evaluateMolang('50 + math.cos(query.anim_time * 120) * 2', { anim_time: 0 }), 52);
  assert.ok(Math.abs(evaluateMolang('math.sin(query.anim_time * 120) * 18', { anim_time: 0.25 }) - 9) < 1e-9);
  assert.equal(evaluateMolang('math.clamp(20, 0, 10)', {}), 10);
  assert.equal(evaluateMolang('(2 + 3) * 4 % 7', {}), 6);
  assert.equal(evaluateMolang('', {}), 0);
  assert.throws(() => evaluateMolang('variable.arm_swing', {}), /Unsupported animation variable/);
  assert.throws(() => evaluateMolang('math.nope(1)', {}), /Unsupported animation function/);
  assert.throws(() => evaluateMolang('1 +', {}), /ended early|incomplete/);
});

test('Blockbench cube geometry keeps per-face atlas UVs, outward winding and a 1/16 scale', () => {
  const { json, binary } = bbmodelToGltf(bbmodel());
  const [node] = json.nodes;
  assert.deepEqual(node.translation, [0, 0, 0]);
  assert.deepEqual(node.rotation, [0, 0, 0, 1]);
  const [primitive] = json.meshes[0].primitives;
  const positions = accessorValues(json, binary, primitive.attributes.POSITION);
  const uvs = accessorValues(json, binary, primitive.attributes.TEXCOORD_0);
  const normals = accessorValues(json, binary, primitive.attributes.NORMAL);
  const indices = accessorValues(json, binary, primitive.indices);
  assert.equal(positions.length, 24 * 3);
  assert.equal(indices.length, 36);
  // Faces follow Blockbench's east, west, up, down, south, north order.
  assert.deepEqual(positions.slice(0, 12), [1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0]);
  // The east face starts at the top of the atlas and ends at its bottom, because
  // Blockbench and glTF both measure V downwards from the top-left pixel.
  assert.deepEqual(uvs.slice(0, 8), [0, 0, 1, 0, 0, 1, 1, 1]);
  const faceNormals = FACES.map((_, face) => normals.slice(face * 12, face * 12 + 3));
  assert.deepEqual(faceNormals, [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
  const corner = index => positions.slice(index * 3, index * 3 + 3);
  for (let face = 0; face < FACES.length; face++) {
    const triangles = indices.slice(face * 6, face * 6 + 6);
    const [a, b, c] = [corner(triangles[0]), corner(triangles[1]), corner(triangles[2])];
    const edge1 = b.map((value, axis) => value - a[axis]), edge2 = c.map((value, axis) => value - a[axis]);
    const cross = [edge1[1] * edge2[2] - edge1[2] * edge2[1], edge1[2] * edge2[0] - edge1[0] * edge2[2], edge1[0] * edge2[1] - edge1[1] * edge2[0]];
    const normal = faceNormals[face];
    assert.ok(cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] > 0, `${FACES[face]} winds outwards`);
  }
});

test('Blockbench maps atlas rectangles into glTF UV space and rotates faces', () => {
  const model = bbmodel();
  model.elements[0].faces.east.uv = [4, 8, 12, 16];
  const plain = bbmodelToGltf(model);
  const plainUvs = accessorValues(plain.json, plain.binary, plain.json.meshes[0].primitives[0].attributes.TEXCOORD_0).slice(0, 8);
  assert.deepEqual(rounded(plainUvs), [0.25, 0.5, 0.75, 0.5, 0.25, 1, 0.75, 1]);
  model.elements[0].faces.east.rotation = 90;
  const rotated = bbmodelToGltf(model);
  const rotatedUvs = accessorValues(rotated.json, rotated.binary, rotated.json.meshes[0].primitives[0].attributes.TEXCOORD_0).slice(0, 8);
  assert.deepEqual(rounded(rotatedUvs), [0.25, 1, 0.25, 0.5, 0.75, 1, 0.75, 0.5]);
});

test('Blockbench box UV cubes derive their rectangles from the cube size', () => {
  const model = bbmodel({ meta: { format_version: '5.0', model_format: 'free', box_uv: true } });
  model.elements[0] = cube('cube-a', [0, 0, 0], [4, 8, 2], { box_uv: true, uv_offset: [2, 3] });
  const { json, binary } = bbmodelToGltf(model);
  const uvs = accessorValues(json, binary, json.meshes[0].primitives[0].attributes.TEXCOORD_0).slice(0, 8);
  // East covers u: offset + 0..depth, v: offset + depth..depth + height.
  assert.deepEqual(rounded(uvs), [2 / 16, 5 / 16, 4 / 16, 5 / 16, 2 / 16, 13 / 16, 4 / 16, 13 / 16]);
});

test('Blockbench atlas rows keep their place: a face samples the texture it covers', () => {
  // Top half red, bottom half blue. glTF and Blockbench both put v=0 at the top
  // row, so a face covering the top half must sample red - the exact bug that
  // mirrored artwork onto neighbouring tiles and their transparent padding.
  const atlas = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const offset = (y * 16 + x) * 4;
    atlas.data[offset] = y < 8 ? 255 : 0;
    atlas.data[offset + 1] = 0;
    atlas.data[offset + 2] = y < 8 ? 0 : 255;
    atlas.data[offset + 3] = 255;
  }
  const model = bbmodel({ textures: [{ ...TEXTURE, source: `data:image/png;base64,${PNG.sync.write(atlas).toString('base64')}` }] });
  model.elements[0].faces.east.uv = [0, 0, 16, 8];
  model.elements[0].faces.east.texture = 0;
  model.elements[0].faces.west.texture = null;
  model.elements[0].faces.up.texture = null;
  model.elements[0].faces.down.texture = null;
  model.elements[0].faces.south.texture = null;
  model.elements[0].faces.north.texture = null;
  const { json, binary } = bbmodelToGltf(model);
  const primitive = json.meshes[0].primitives[0];
  const positions = accessorValues(json, binary, primitive.attributes.POSITION);
  const uvs = accessorValues(json, binary, primitive.attributes.TEXCOORD_0);
  const sample = vertex => {
    const u = uvs[vertex * 2], v = uvs[vertex * 2 + 1];
    const x = Math.min(15, Math.floor(u * 16)), y = Math.min(15, Math.floor(v * 16));
    return [atlas.data[(y * 16 + x) * 4], atlas.data[(y * 16 + x) * 4 + 2]];
  };
  // East face vertices: 0 and 1 sit on the cube top, 2 and 3 on its bottom.
  assert.deepEqual(sample(0), [255, 0]);
  assert.deepEqual(sample(1), [255, 0]);
  assert.deepEqual(sample(2), [0, 255]);
  assert.deepEqual(sample(3), [0, 255]);
  assert.ok(positions[1 * 3 + 1] > positions[2 * 3 + 1]);
  assert.deepEqual(json.samplers[0], { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 });
  assert.equal(json.materials[0].alphaMode, 'MASK');
});

test('Blockbench groups become glTF nodes with Blockbench pivots and ZYX rotations', () => {
  const model = bbmodel({
    groups: [{ uuid: 'group-a', name: 'Arm', origin: [0, 8, 0], rotation: [0, 45, 0], children: ['cube-a'] }],
    outliner: [{ uuid: 'group-a', children: ['cube-a'] }],
    elements: [cube('cube-a', [8, 16, 0], [24, 32, 16], { origin: [8, 16, 0], rotation: [0, 0, 30] })],
  });
  const { json } = bbmodelToGltf(model);
  assert.equal(json.nodes.length, 2);
  const group = json.nodes[json.scenes[0].nodes[0]], child = json.nodes[group.children[0]];
  assert.deepEqual(group.translation, [0, 8 / UNIT, 0]);
  assert.deepEqual(child.translation, [8 / UNIT, (16 - 8) / UNIT, 0]);
  closeTo(group.rotation, quaternionOf([0, 45, 0]), 'group rotation');
  closeTo(child.rotation, quaternionOf([0, 0, 30]), 'element rotation');
  closeTo(quaternionFromEulerDegrees([0, 90, 0]), quaternionOf([0, 90, 0]), 'axis rotation');
});

test('Blockbench animations bake expressions, steps and rest offsets into glTF clips', () => {
  const spinAt = time => Math.cos(time * 360 * Math.PI / 180) * 90;
  const model = bbmodel({
    groups: [{ uuid: 'group-a', name: 'Rotor', origin: [0, 16, 0], rotation: [0, 0, 0], children: ['cube-a'] }],
    outliner: [{ uuid: 'group-a', children: ['cube-a'] }],
    elements: [cube('cube-a', [0, 16, 0], [8, 24, 8], { origin: [4, 20, 4] })],
    animations: [{
      name: 'spin', length: 1, snapping: 10, loop: 'loop',
      animators: {
        'group-a': {
          type: 'bone',
          keyframes: [{ channel: 'rotation', time: 0, interpolation: 'linear', data_points: [{ x: '0', y: '0', z: 'math.cos(query.anim_time * 360) * 90' }] }],
        },
        'cube-a': {
          type: 'bone',
          keyframes: [
            { channel: 'position', time: 0, interpolation: 'step', data_points: [{ x: '0', y: '0', z: '0' }] },
            { channel: 'position', time: 0.5, interpolation: 'step', data_points: [{ x: '16', y: '0', z: '0' }] },
          ],
        },
      },
    }],
  });
  const { json, binary } = bbmodelToGltf(model);
  const [clip] = json.animations;
  assert.equal(clip.name, 'spin');
  assert.equal(clip.channels.length, 2);
  const rotationChannel = clip.channels.find(channel => channel.target.path === 'rotation');
  const rotationSampler = clip.samplers[rotationChannel.sampler];
  const times = accessorValues(json, binary, rotationSampler.input);
  const rotations = accessorValues(json, binary, rotationSampler.output);
  assert.deepEqual(times.map(value => +value.toFixed(2)), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  times.forEach((time, index) => closeTo(rotations.slice(index * 4, index * 4 + 4), quaternionOf([0, 0, spinAt(time)]), `rotation at ${time}`));
  const translationChannel = clip.channels.find(channel => channel.target.path === 'translation');
  const rest = json.nodes[translationChannel.target.node].translation;
  const translation = accessorValues(json, binary, clip.samplers[translationChannel.sampler].output);
  [0, 1, 2, 3, 4].forEach(index => closeTo(translation.slice(index * 3, index * 3 + 3), rest, `rest position at sample ${index}`));
  [5, 6, 10].forEach(index => closeTo(translation.slice(index * 3, index * 3 + 3), [rest[0] + 1, rest[1], rest[2]], `stepped position at sample ${index}`));
});

test('Blockbench import reports what it cannot convert instead of failing', () => {
  const model = bbmodel({
    elements: [
      cube('cube-a', [0, 0, 0], [16, 16, 16]),
      { uuid: 'mesh-a', name: 'mesh', type: 'mesh', origin: [0, 0, 0], rotation: [0, 0, 0] },
      { uuid: 'locator-a', name: 'locator', type: 'locator', position: [0, 4, 0] },
    ],
    outliner: ['cube-a', 'mesh-a', 'locator-a'],
    animations: [{ name: 'empty', length: 1, animators: {} }],
  });
  const { json, warnings } = bbmodelToGltf(model);
  assert.equal(json.animations, undefined);
  assert.equal(json.nodes.length, 3);
  assert.ok(warnings.some(message => /mesh element/.test(message)));
  assert.ok(warnings.some(message => /locator/.test(message)));
  assert.ok(warnings.some(message => /animates nothing/.test(message)));
  const untextured = bbmodel({ textures: [] });
  const result = bbmodelToGltf(untextured);
  assert.deepEqual(result.json.meshes, []);
  assert.equal(result.json.materials, undefined);
  assert.throws(() => bbmodelToGltf({ ...untextured, elements: [], outliner: [] }), /no exportable elements/);
  const missingImage = bbmodel({ textures: [{ ...TEXTURE, source: 'atlas.png' }] });
  assert.ok(bbmodelToGltf(missingImage).warnings.some(message => /no embedded image/.test(message)));
  const hidden = bbmodel();
  hidden.elements[0].export = false;
  assert.throws(() => bbmodelToGltf(hidden), /no exportable elements/);
});

// The three projects saved in Projects/AssetLib are the real test: each must
// produce a glTF three.js can load, at the size Blockbench shows.
for (const name of ['biplane1', 'bb-worky-drone', 'type96-anti-aircraft']) {
  test(`Blockbench project ${name} converts into a loadable glTF model`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL(`../Projects/AssetLib/${name}.bbmodel`, import.meta.url)));
    const model = readBBModel(bytes);
    const { json, binary, warnings } = bbmodelToGltf(model);
    validateModelDocument(json, binary.length);
    assert.equal(warnings.some(message => /without geometry|were skipped/.test(message)), false);
    const stripped = structuredClone(json);
    delete stripped.images; delete stripped.textures; delete stripped.materials; delete stripped.samplers;
    for (const mesh of stripped.meshes) for (const primitive of mesh.primitives) delete primitive.material;
    const loaded = await new GLTFLoader().parseAsync(encodeGLB(stripped, binary).buffer, '');
    let meshes = 0, uvMin = Infinity, uvMax = -Infinity;
    loaded.scene.traverse(object => {
      if (object.isMesh) meshes += 1;
      const uv = object.geometry?.attributes?.uv;
      if (!uv) return;
      for (const value of uv.array) { uvMin = Math.min(uvMin, value); uvMax = Math.max(uvMax, value); }
    });
    assert.equal(meshes, json.meshes.length);
    assert.ok(uvMin >= -1e-6 && uvMax <= 1 + 1e-6, `UVs stay inside the atlas (${uvMin}..${uvMax})`);
    const animated = (model.animations || []).filter(animation => Object.values(animation.animators || {}).some(animator => (animator.keyframes || []).length));
    assert.deepEqual(loaded.animations.map(clip => clip.name).sort(), animated.map(animation => animation.name).sort());
    // Rest pose size, rebuilt from the Blockbench pivots the way the importer nests them.
    const groups = new Map((model.groups || []).map(group => [group.uuid, group]));
    const elements = new Map((model.elements || []).map(element => [element.uuid, element]));
    const parentOf = new Map();
    const register = (entries, parent) => {
      for (const entry of entries || []) {
        const uuid = typeof entry === 'string' ? entry : entry.uuid;
        parentOf.set(uuid, parent);
        if (typeof entry === 'object') register(entry.children, uuid);
      }
    };
    register(model.outliner, null);
    const worldOf = uuid => {
      const chain = [];
      for (let id = uuid; id; id = parentOf.get(id)) chain.unshift(id);
      const matrix = new Matrix4();
      let parentOrigin = [0, 0, 0];
      for (const id of chain) {
        const node = groups.get(id) || elements.get(id);
        const origin = node.origin || [0, 0, 0];
        const rotation = (node.rotation || [0, 0, 0]).map(value => value * Math.PI / 180);
        matrix.multiply(new Matrix4().compose(
          new Vector3((origin[0] - parentOrigin[0]) / UNIT, (origin[1] - parentOrigin[1]) / UNIT, (origin[2] - parentOrigin[2]) / UNIT),
          new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], 'ZYX')),
          new Vector3(1, 1, 1)));
        parentOrigin = origin;
      }
      return matrix;
    };
    const expected = new Box3(), point = new Vector3(), pivot = new Vector3();
    for (const element of model.elements) {
      if (element.type !== 'cube' || element.export === false) continue;
      const origin = element.origin || [0, 0, 0];
      const matrix = worldOf(element.uuid);
      for (let corner = 0; corner < 8; corner++) {
        point.set(
          element.from[0] + (element.to[0] - element.from[0]) * (corner & 1),
          element.from[1] + (element.to[1] - element.from[1]) * ((corner >> 1) & 1),
          element.from[2] + (element.to[2] - element.from[2]) * ((corner >> 2) & 1));
        point.divideScalar(UNIT).sub(pivot.set(origin[0] / UNIT, origin[1] / UNIT, origin[2] / UNIT));
        expected.expandByPoint(point.applyMatrix4(matrix));
      }
    }
    const actual = new Box3().setFromObject(loaded.scene);
    assert.ok(expected.min.distanceTo(actual.min) < 0.02, `min corner ${actual.min.toArray()} vs ${expected.min.toArray()}`);
    assert.ok(expected.max.distanceTo(actual.max) < 0.02, `max corner ${actual.max.toArray()} vs ${expected.max.toArray()}`);
  });
}

test('imported Blockbench models load with their textures and materials in three', async () => {
  // three picks its texture loader and decodes images through browser globals; the
  // shims stand in for those so the textured GLB is parsed exactly as in the tab.
  const previous = { self: globalThis.self, createImageBitmap: globalThis.createImageBitmap };
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 16, height: 16, close() {} });
  try {
    const bytes = new Uint8Array(readFileSync(new URL('../Projects/AssetLib/bb-worky-drone.bbmodel', import.meta.url)));
    const { json, binary } = bbmodelToGltf(readBBModel(bytes));
    const loaded = await new GLTFLoader().parseAsync(encodeGLB(json, binary).buffer, '');
    const materials = [];
    loaded.scene.traverse(object => {
      if (!object.isMesh) return;
      materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
    });
    assert.equal(materials.length, 43);
    assert.equal(materials.every(material => material.map?.image), true);
    assert.equal(materials.every(material => material.alphaTest === 0.5), true);
    assert.equal(materials.every(material => material.side === 2), true);
    assert.deepEqual(loaded.animations.map(clip => clip.name), ['animation.idle', 'animation.wave', 'animation.fly']);
    assert.ok(loaded.animations.every(clip => clip.tracks.length > 0 && clip.duration > 0));
  } finally {
    globalThis.self = previous.self;
    globalThis.createImageBitmap = previous.createImageBitmap;
  }
});

test('bundleModel imports a .bbmodel file into a self contained GLB asset', async () => {
  const source = bbmodel({
    animations: [{
      name: 'bob', length: 1, snapping: 10,
      animators: {
        'cube-a': { type: 'bone', keyframes: [{ channel: 'position', time: 0, data_points: [{ x: '0', y: 'math.sin(query.anim_time * 360) * 2', z: '0' }] }] },
      },
    }],
  });
  const file = { name: 'crate.bbmodel', size: 100, type: '', arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(source)).buffer };
  const { asset, warnings } = await bundleModel(file, [file], 'asset_1');
  assert.equal(asset.kind, 'model');
  assert.equal(asset.format, 'glb');
  assert.equal(asset.name, 'crate.bbmodel');
  assert.deepEqual(asset.animations, ['bob']);
  assert.deepEqual(warnings, []);
  assert.ok(asset.src.startsWith('data:model/gltf-binary;base64,'));
  const glb = readModel(Uint8Array.from(atob(asset.src.split(',')[1]), character => character.charCodeAt(0)), 'glb');
  assert.equal(glb.json.animations[0].name, 'bob');
  assert.equal(glb.json.meshes.length, 1);
  assert.equal(glb.binary.length, glb.json.buffers[0].byteLength);
  const project = createProject();
  project.assets = [asset];
  project.map.entities.push({ id: 'entity_crate', type: 'decoration', name: 'Crate', x: 0, y: 0, angle: 0, modelAsset: asset.id });
  validateProject(project);
});

test('dropped files are routed to models, images or sounds', () => {
  const file = name => ({ name, size: 10 });
  assert.deepEqual(groupDroppedFiles([]), { models: [], images: [], sounds: [], nodes: [], ignored: [] });
  const modelDrop = groupDroppedFiles([file('hero.gltf'), file('hero.bin'), file('atlas.png')]);
  assert.deepEqual(modelDrop.models.map(item => item.name), ['hero.gltf', 'hero.bin', 'atlas.png']);
  assert.deepEqual(modelDrop.images, []);
  const mixed = groupDroppedFiles([file('wall.png'), file('roar.ogg'), file('notes.txt')]);
  assert.deepEqual(mixed.images.map(item => item.name), ['wall.png']);
  assert.deepEqual(mixed.sounds.map(item => item.name), ['roar.ogg']);
  assert.deepEqual(mixed.ignored.map(item => item.name), ['notes.txt']);
  assert.equal(groupDroppedFiles([file('drone.BBMODEL')]).models.length, 1);
  // A saved node is its own kind of drop.
  const nodeDrop = groupDroppedFiles([file('crate.node'), file('wall.png')]);
  assert.deepEqual(nodeDrop.nodes.map(item => item.name), ['crate.node']);
  assert.deepEqual(nodeDrop.images.map(item => item.name), ['wall.png']);
});

test('dropped folders are read recursively with their relative paths', async () => {
  const entryFile = (name, size = 12) => ({
    isFile: true, isDirectory: false, name,
    file: resolve => resolve({ name, size, type: 'model/gltf-binary', lastModified: 0, arrayBuffer: async () => new ArrayBuffer(size), text: async () => '' }),
  });
  const entryDirectory = (name, children) => ({
    isFile: false, isDirectory: true, name,
    createReader() {
      let offset = 0;
      return { readEntries: resolve => { const batch = children.slice(offset, offset + 100); offset += batch.length; resolve(batch); } };
    },
  });
  const many = Array.from({ length: 130 }, (_, index) => entryFile(`part${index}.glb`));
  const tree = entryDirectory('rig', [entryFile('hero.glb'), entryDirectory('textures', [entryFile('skin.png')]), ...many]);
  const files = await readDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] });
  assert.equal(files.length, 132);
  assert.equal(files[0].webkitRelativePath, 'rig/hero.glb');
  assert.equal(files[1].webkitRelativePath, 'rig/textures/skin.png');
  assert.equal(files[2].webkitRelativePath, 'rig/part0.glb');
  assert.equal((await files[0].arrayBuffer()).byteLength, 12);
  assert.equal((await readDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => tree }], files: [] }, { maxFiles: 5 })).length, 5);
  assert.equal((await readDroppedFiles({ files: [entryFile('a.glb')] })).length, 1);
});
