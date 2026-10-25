import { dataURI, encodeGLB } from '../../shared/gltf.js';
import { PNG } from 'pngjs';

export function modelFixture({ texture = false, unnamed = false } = {}) {
  const arrays = [
    new Float32Array([0, 0, -.5, 0, 0, .5, 0, 1.5, 0]),
    new Float32Array([0, 0, 1, 0, .5, 1]),
    new Uint16Array(12),
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0, 0, .5, 0]),
    new Float32Array([0, 0, 0, 0, 0, 0, 0, .25, 0]),
    new Float32Array([0, 1]),
  ];
  const buffer = new Uint8Array(arrays.reduce((size, array) => size + array.byteLength, 0));
  let offset = 0;
  const bufferViews = arrays.map(array => {
    const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength };
    buffer.set(new Uint8Array(array.buffer), offset); offset += array.byteLength;
    return view;
  });
  const json = {
    asset: { version: '2.0', generator: 'OpenDLE synthetic skin/material/animation fixture' }, scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Hierarchy', children: [1, 2] }, { name: 'Mesh', mesh: 0, skin: 0 }, { name: 'Joint' }],
    skins: [{ joints: [2], skeleton: 2 }],
    buffers: [{ byteLength: buffer.length }], bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, -.5], max: [0, 1.5, .5] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 5, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 6, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, .25, 0] },
      { bufferView: 7, componentType: 5126, count: 2, type: 'SCALAR' },
    ],
    meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, material: 0, targets: [{ POSITION: 6 }] }] }],
    materials: [{ name: 'Red PBR', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, .15, .1, 1], metallicFactor: .1, roughnessFactor: .6 } }],
    animations: [{ ...(unnamed ? {} : { name: 'Move' }), samplers: [{ input: 4, output: 5, interpolation: 'LINEAR' }, { input: 4, output: 7, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }, { sampler: 1, target: { node: 1, path: 'weights' } }] }],
  };
  if (texture) {
    const image = new PNG({ width: 2, height: 2 }); image.data.fill(255);
    json.images = [{ uri: dataURI(PNG.sync.write(image), 'image/png') }];
    json.textures = [{ source: 0 }];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const glb = encodeGLB(json, buffer);
  const gltf = structuredClone(json); gltf.buffers[0].uri = dataURI(buffer, 'application/octet-stream');
  return { json, buffer, glb, gltf };
}
