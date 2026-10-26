import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PNG } from 'pngjs';
import { createProject, validateProject } from '../shared/project.js';
import { bundleModel } from '../shared/gltf.js';

// Browser modules address shared code from the server root, which Node cannot resolve.
const rootUrl = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/shared/')) return { url: new URL(`.${specifier}`, rootUrl).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { captureModelPreview } = await import('../public/model-thumbnail.js');

// Minimal Canvas2D stand-in: the thumbnail renderer only needs image pixels in and
// a PNG out, so a real browser is not required to check it.
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.pixels = null; }
  getContext() {
    const canvas = this;
    return {
      drawImage(bitmap) {
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.pixels = Uint8ClampedArray.from(bitmap.data);
      },
      getImageData: (x, y, width, height) => ({ width, height, data: canvas.pixels || new Uint8ClampedArray(width * height * 4) }),
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData(image) {
        canvas.width = image.width; canvas.height = image.height;
        canvas.pixels = Uint8ClampedArray.from(image.data);
      },
    };
  }
  toDataURL() {
    if (!this.pixels) return 'data:image/png;base64,';
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.pixels);
    return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
  }
}

async function withBrowserStubs(fn) {
  const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, fetch: globalThis.fetch };
  globalThis.document = { createElement: () => new FakeCanvas() };
  globalThis.createImageBitmap = async blob => {
    const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
    return { width: png.width, height: png.height, data: png.data, close() {} };
  };
  globalThis.fetch = async uri => ({ blob: async () => ({ arrayBuffer: async () => Buffer.from(uri.split(',')[1], 'base64') }) });
  try { return await fn(); }
  finally {
    globalThis.document = previous.document;
    globalThis.createImageBitmap = previous.createImageBitmap;
    globalThis.fetch = previous.fetch;
  }
}

async function blockbenchAsset(name = 'biplane1') {
  const bytes = new TextEncoder().encode(readFileSync(new URL(`../Projects/AssetLib/${name}.bbmodel`, import.meta.url), 'utf8'));
  const file = { name: `${name}.bbmodel`, size: bytes.length, type: '', arrayBuffer: async () => bytes.buffer };
  const { asset } = await bundleModel(file, [file], 'asset_thumbnail');
  return asset;
}

test('a model asset gets a snapshot preview the library can show', async () => {
  const asset = await blockbenchAsset();
  await withBrowserStubs(async () => {
    const preview = await captureModelPreview(asset);
    assert.ok(preview, 'a preview is produced');
    assert.ok(preview.startsWith('data:image/png;base64,'));
    const png = PNG.sync.read(Buffer.from(preview.split(',')[1], 'base64'));
    assert.deepEqual([png.width, png.height], [128, 128]);
    let covered = 0, sum = 0;
    for (let index = 0; index < png.width * png.height; index++) {
      if (png.data[index * 4 + 3] < 128) continue;
      covered += 1;
      sum += (png.data[index * 4] + png.data[index * 4 + 1] + png.data[index * 4 + 2]) / 3;
    }
    assert.ok(covered > 0.05 * png.width * png.height, `the model covers the frame (${covered} pixels)`);
    assert.ok(sum / covered > 10, 'pixels carry the texture colours instead of black');
    // The preview is a normal optional asset field.
    const project = createProject();
    project.assets = [{ ...asset, preview }];
    validateProject(project);
    project.assets = [{ ...asset, preview: 'javascript:alert(1)' }];
    assert.throws(() => validateProject(project), /preview must be an embedded PNG/);
  });
});

test('a broken model source yields no preview instead of throwing', async () => {
  await withBrowserStubs(async () => {
    assert.equal(await captureModelPreview({ src: 'data:model/gltf-binary;base64,AAAA', format: 'glb' }), null);
  });
});
