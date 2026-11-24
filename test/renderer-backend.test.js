import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRenderer, selectRendererBackend } from '../public/renderer-backend.js';

class FakeRenderer {
  constructor(options) {
    this.options = options;
    this.backend = { isWebGLBackend: Boolean(options.forceWebGL), isWebGPUBackend: !options.forceWebGL };
    this.disposed = 0;
  }
  async init() {}
  dispose() { this.disposed++; }
}

const canvas = () => ({ dataset: {} });
const gpuWith = adapter => ({ requestAdapter: async () => adapter });

test('WebGPU is requested when the browser exposes it', () => {
  assert.deepEqual(selectRendererBackend({ secureContext: true, gpu: gpuWith({}) }).backend, 'webgpu');
  assert.deepEqual(selectRendererBackend({ secureContext: true, gpu: undefined }).backend, 'webgl2');
});

test('no adapter falls back to WebGL 2 instead of waiting for a device', async () => {
  // Three waits for a device that never arrives when no adapter is available, which left the 3D
  // view on its loading state forever. The probe turns that into a WebGL 2 renderer instead.
  const { renderer, status } = await createBrowserRenderer(FakeRenderer, canvas(),
    { secureContext: true, gpu: gpuWith(null) });
  assert.equal(renderer.options.forceWebGL, true);
  assert.equal(status.backend, 'webgl2');
  assert.match(status.fallbackReason, /no adapter/);
});

test('an adapter keeps the WebGPU renderer', async () => {
  const { renderer, status } = await createBrowserRenderer(FakeRenderer, canvas(),
    { secureContext: true, gpu: gpuWith({ info: { vendor: 'test' } }) });
  assert.equal(renderer.options.forceWebGL, false);
  assert.equal(status.backend, 'webgpu');
});

test('a failing adapter request is treated as no adapter, not as an error', async () => {
  const gpu = { requestAdapter: async () => { throw new Error('device lost'); } };
  const { renderer } = await createBrowserRenderer(FakeRenderer, canvas(), { secureContext: true, gpu });
  assert.equal(renderer.options.forceWebGL, true);
});
