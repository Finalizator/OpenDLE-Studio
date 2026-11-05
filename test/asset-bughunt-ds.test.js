import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { PNG } from 'pngjs';
import { measureAssetForward, modelBounds } from '../shared/model-forward.js';
import { dataURI, decodeDataURI, encodeGLB, readModel, validateModelDocument } from '../shared/gltf.js';
import { modelTriangles } from '../shared/model-geometry.js';
import { createPixiEditorBridge } from '../server/pixieditor.js';
import { LIMITS } from '../shared/limits.js';
import { textureDefinitionsFromText } from '../shared/doom-assets.js';

// Browser modules address shared code from the server root, which Node cannot resolve.
const rootUrl = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/shared/')) return { url: new URL(`.${specifier}`, rootUrl).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { captureModelPreview } = await import('../public/model-thumbnail.js');

function glbDocument(overrides = {}) {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 3, min: [0, 0, 0], max: [1, 1, 1], bufferView: 0 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
    ...overrides,
  };
}

// One-mesh GLB whose single box runs long on X, so a correct measurement is 0 degrees.
function boxGlb({ half = [1.5, 0.5, 0.5], name = 'truck.glb' } = {}) {
  const json = glbDocument({
    accessors: [{ type: 'VEC3', componentType: 5126, count: 8, min: half.map(value => -value), max: half, bufferView: 0 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }],
    buffers: [{ byteLength: 96 }],
  });
  const bytes = encodeGLB(json, new Uint8Array(96));
  return { src: dataURI(bytes, 'model/gltf-binary'), name };
}

test('asset 01: a MODELDEF-converted OBJ model is measured from its format, not its file name', () => {
  const { src } = boxGlb();
  // `importModelDefs` stores the model as `format: 'glb'` with the OBJ name still on it.
  const objNamed = { id: 'asset_model_truck', kind: 'model', name: 'truck.obj', format: 'glb', src };
  assert.equal(measureAssetForward(objNamed), 0, 'an OBJ-named GLB still reports its forward axis');
  // The same bytes under a .glb name must keep agreeing.
  assert.equal(measureAssetForward({ ...objNamed, name: 'truck.glb' }), 0);
});

test('asset 02: model validation rejects dangling references into the document arrays', () => {
  const cases = [
    ['node.mesh', { nodes: [{ mesh: 99 }] }, /mesh/i],
    ['scene index', { scene: 5 }, /scene/i],
    ['POSITION accessor', { meshes: [{ primitives: [{ attributes: { POSITION: 99 } }] }] }, /accessor/i],
    ['indices accessor', { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 99 }] }] }, /indices/i],
    ['material index', { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 99 }] }] }, /material/i],
  ];
  for (const [label, overrides, pattern] of cases) {
    const glb = encodeGLB(glbDocument(overrides), new Uint8Array(36));
    const { json, binary } = readModel(glb, 'glb');
    assert.throws(() => validateModelDocument(json, binary?.length), pattern, `${label} must be rejected`);
  }
  // A well-formed document still validates.
  const ok = encodeGLB(glbDocument(), new Uint8Array(36));
  assert.doesNotThrow(() => validateModelDocument(readModel(ok, 'glb').json, 36));
});

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('asset 03: PixiEditor reload enforces the same image budget as open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-asset-ds-'));
  try {
    const bridge = createPixiEditorBridge({ directory, exists: () => true });
    const asset = { id: 'asset_x_1', name: 'tex', kind: 'texture', src: 'data:image/png;base64,AAAA' };
    mkdirSync(join(directory, 'project'), { recursive: true });
    const path = bridge.fileFor('project', asset);
    // A normal export comes back unchanged.
    writeFileSync(path, ONE_PIXEL_PNG);
    assert.match(bridge.reload('project', asset).src, /^data:image\/png;base64,/);
    // An export larger than the project's image budget must be refused, exactly as open refuses it.
    const oversized = Buffer.alloc(LIMITS.imageBytes + 100);
    ONE_PIXEL_PNG.copy(oversized, 0, 0, 8);
    oversized.write('IHDR', 12); oversized.writeUInt32BE(1, 16); oversized.writeUInt32BE(1, 20);
    writeFileSync(path, oversized);
    assert.throws(() => bridge.reload('project', asset), /too large|budget/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A GLB whose texture is packed into the binary via bufferView + mimeType, the way
// glTF exporters embed images instead of a data URI.
function texturedGlb() {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < 4; index++) { png.data[index * 4] = 255; png.data[index * 4 + 3] = 255; }
  const pngBytes = new Uint8Array(PNG.sync.write(png));
  const position = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const positionBytes = new Uint8Array(position.buffer), uvBytes = new Uint8Array(uv.buffer);
  const binary = new Uint8Array(positionBytes.length + uvBytes.length + pngBytes.length);
  binary.set(positionBytes, 0); binary.set(uvBytes, positionBytes.length); binary.set(pngBytes, positionBytes.length + uvBytes.length);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 2, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: uvBytes.length },
      { buffer: 0, byteOffset: positionBytes.length + uvBytes.length, byteLength: pngBytes.length },
    ],
    buffers: [{ byteLength: binary.length }],
  };
  const glb = encodeGLB(json, binary);
  return { id: 'textured', kind: 'model', name: 'textured.glb', format: 'glb', src: dataURI(glb, 'model/gltf-binary') };
}

function thumbnailStubs() {
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; this.pixels = null; }
    getContext() {
      const canvas = this;
      return {
        drawImage(bitmap) { canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.pixels = Uint8ClampedArray.from(bitmap.data); },
        getImageData: (x, y, width, height) => ({ width, height, data: canvas.pixels || new Uint8ClampedArray(width * height * 4) }),
        createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData(image) { canvas.width = image.width; canvas.height = image.height; canvas.pixels = Uint8ClampedArray.from(image.data); },
      };
    }
    toDataURL() {
      const png = new PNG({ width: this.width, height: this.height });
      png.data = Buffer.from(this.pixels);
      return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
    }
  }
  const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, fetch: globalThis.fetch };
  globalThis.document = { createElement: () => new FakeCanvas() };
  globalThis.createImageBitmap = async blob => {
    const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
    return { width: png.width, height: png.height, data: png.data, close() {} };
  };
  globalThis.fetch = async uri => ({ blob: async () => ({ arrayBuffer: async () => Buffer.from(uri.split(',')[1], 'base64') }) });
  return () => {
    globalThis.document = previous.document;
    globalThis.createImageBitmap = previous.createImageBitmap;
    globalThis.fetch = previous.fetch;
  };
}

test('asset 04: model thumbnails read textures packed in the GLB binary, not only data URIs', async () => {
  const restore = thumbnailStubs();
  try {
    const preview = await captureModelPreview(texturedGlb());
    assert.ok(preview, 'a preview is produced');
    const png = PNG.sync.read(Buffer.from(preview.split(',')[1], 'base64'));
    let red = 0, green = 0, covered = 0;
    for (let index = 0; index < png.width * png.height; index++) {
      if (png.data[index * 4 + 3] < 128) continue;
      covered += 1;
      red += png.data[index * 4]; green += png.data[index * 4 + 1];
    }
    assert.ok(covered > 0, 'the textured triangle covers the frame');
    assert.ok(red / covered > green / covered + 20, 'the red texture colours the preview instead of the grey fallback');
  } finally {
    restore();
  }
});

test('asset 05: model thumbnails honour interleaved buffer views instead of reading garbage positions', async () => {
  const restore = thumbnailStubs();
  try {
    // One buffer view interleaves POSITION and TEXCOORD_0 at a 20-byte stride, the
    // layout glTF optimisers produce; the collider already reads it correctly.
    const png = new PNG({ width: 2, height: 2 });
    for (let index = 0; index < 4; index++) { png.data[index * 4] = 255; png.data[index * 4 + 3] = 255; }
    const texture = `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
    const vertices = new Float32Array([0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 1]);
    const binary = new Uint8Array(vertices.buffer);
    const json = {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
      textures: [{ source: 0 }], images: [{ uri: texture }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC2', byteOffset: 12 },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, byteStride: 20 }],
      buffers: [{ byteLength: binary.length }],
    };
    const glb = encodeGLB(json, binary);
    const asset = { id: 'interleaved', kind: 'model', name: 'interleaved.glb', format: 'glb', src: dataURI(glb, 'model/gltf-binary') };
    const preview = await captureModelPreview(asset);
    assert.ok(preview, 'a preview is produced');
    const out = PNG.sync.read(Buffer.from(preview.split(',')[1], 'base64'));
    let covered = 0;
    for (let index = 0; index < out.width * out.height; index++) if (out.data[index * 4 + 3] >= 128) covered += 1;
    assert.ok(covered > 0, 'the interleaved triangle covers the frame');
  } finally {
    restore();
  }
});

test('asset 06: TEXTURES keeps every patch when a patch option block adds its own braces', () => {
  const text = [
    'Texture "WOOD1", 128, 128',
    '{',
    '  Patch "PLANK1", 0, 0',
    '  {',
    '    FlipX',
    '  }',
    '  Patch "PLANK2", 64, 0',
    '}',
  ].join('\n');
  const [definition] = textureDefinitionsFromText(text);
  assert.deepEqual(definition.patches.map(patch => patch.name), ['PLANK1', 'PLANK2'],
    'the patch after a braced option block must not be dropped');
  assert.equal(definition.patches[1].x, 64);
});
