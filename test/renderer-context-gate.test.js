import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRenderer, selectRendererBackend } from '../public/renderer-backend.js';

/**
 * A canvas and a renderer just real enough for the context-restoration gate.
 *
 * `restoreOnLose` decides whether the fake context reports `webglcontextrestored` back, which is
 * what a driver that never reports looks like.
 */
function fakeCanvas({ restoreOnLose = true } = {}) {
  const listeners = new Map();
  const extension = {
    restoreContext() {
      if (!restoreOnLose) return;
      const event = { preventDefault() {} };
      for (const fn of listeners.get('webglcontextrestored') || []) fn(event);
    },
  };
  const context = { getExtension: name => (name === 'WEBGL_lose_context' ? extension : null), lost: false };
  const canvas = {
    dataset: {},
    listeners,
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== fn)); },
    loseContext() {
      context.lost = true;
      const event = { preventDefault() {} };
      for (const fn of listeners.get('webglcontextlost') || []) fn(event);
    },
  };
  return { canvas, context };
}

class FakeRenderer {
  constructor({ restoreReports = false } = {}) {
    const extension = { restoreContext() { /* the driver never reports back */ } };
    this.backend = {
      isWebGLBackend: true,
      isWebGPUBackend: false,
      getContext: () => ({ getExtension: name => (name === 'WEBGL_lose_context' ? extension : null) }),
    };
    this.disposed = 0;
    this.restoreReports = restoreReports;
  }
  async init() { return this; }
  dispose() { this.disposed++; }
}

test('a context that never reports back does not poison the next level start', async t => {
  // The restoration deadline is five seconds of wall clock; time is faked so the test does not
  // spend it. The timer is scheduled by `dispose()`, so the fake must be in place first.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { canvas } = fakeCanvas({ restoreOnLose: false });
  // `createBrowserRenderer` installs the dispose wrapper this test is about.
  const { renderer } = await createBrowserRenderer(FakeRenderer, canvas, { secureContext: true, gpu: null });
  assert.equal(selectRendererBackend({ secureContext: true, gpu: null }).backend, 'webgl2');
  renderer.dispose();
  // No `webglcontextrestored` will ever arrive (the extension above does nothing). The gate must
  // forget the failure instead of handing it to an unrelated start: that stale throw is the
  // "could not load textures, exited to the menu, fine on the second attempt" report.
  t.mock.timers.tick(6000);
  await new Promise(done => setImmediate(done));
  const second = await createBrowserRenderer(FakeRenderer, canvas, { secureContext: true, gpu: null });
  assert.equal(second.status.backend, 'webgl2', 'the next start builds a renderer instead of throwing');
});
