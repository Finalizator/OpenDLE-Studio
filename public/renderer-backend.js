const contextRestorations = new WeakMap();
/** How long a disposed canvas gets to report its context back before a start stops waiting. */
const RESTORE_DEADLINE_MS = 5000;

function restoreDisposedContext(renderer, canvas) {
  if (!renderer.backend.isWebGLBackend) return;
  const gl = renderer.backend.getContext();
  const extension = gl?.getExtension('WEBGL_lose_context');
  if (!extension) return;
  let finish, timeout;
  const restored = new Promise(resolve => { finish = resolve; });
  contextRestorations.set(canvas, restored);
  function complete(error = null) {
    clearTimeout(timeout);
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', ready);
    finish(error);
  }
  function lost(event) {
    event.preventDefault();
    // Restoration becomes legal after the cancelable lost event has finished.
    setTimeout(() => extension.restoreContext(), 0);
  }
  function ready() { complete(); }
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', ready);
  timeout = setTimeout(() => {
    // The restoration never reported back. Remembering the failure is what made a level
    // transition fail exactly once — "it could not load textures, back to the menu, but the
    // second attempt was fine": the entry stayed in the map and the *next*, unrelated level
    // start threw it before trying anything. Any waiter already holding the promise still gets
    // the error; a later start gets a fresh attempt.
    contextRestorations.delete(canvas);
    complete(new Error('The disposed WebGL 2 context could not be restored on this canvas. Reload the preview to retry.'));
  }, RESTORE_DEADLINE_MS);
}

export function selectRendererBackend({ secureContext = globalThis.isSecureContext, gpu = globalThis.navigator?.gpu } = {}) {
  if (secureContext === false) return { requested: 'webgpu', backend: 'webgl2', fallbackReason: 'WebGPU requires a secure context (HTTPS or localhost).' };
  if (!gpu) return { requested: 'webgpu', backend: 'webgl2', fallbackReason: 'This browser does not expose the WebGPU API.' };
  return { requested: 'webgpu', backend: 'webgpu', fallbackReason: '' };
}

// Browsers cannot pick a graphics API for WebGPU, but they can prefer a discrete
// adapter. Older builds expose requestAdapterInfo(), newer ones the info property.
export async function gpuAdapterInfo(gpu = globalThis.navigator?.gpu) {
  try {
    if (!gpu?.requestAdapter) return '';
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return '';
    const info = adapter.info || (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : null);
    if (!info) return '';
    return [info.vendor, info.architecture, info.device, info.description].filter(value => typeof value === 'string' && value).join(' / ');
  } catch {
    return '';
  }
}

export async function createBrowserRenderer(WebGPURenderer, canvas, environment) {
  const restoration = contextRestorations.get(canvas);
  if (restoration) {
    const error = await restoration;
    contextRestorations.delete(canvas);
    if (error) throw error;
  }
  let selection = selectRendererBackend(environment);
  // A browser can expose WebGPU and still hand back no adapter — no usable GPU, or every device in
  // the session is busy. Three then waits for a device that never arrives, which left the 3D view on
  // its loading state forever. One probe decides it, and WebGL 2 needs no adapter.
  const gpu = environment?.gpu ?? globalThis.navigator?.gpu;
  if (selection.backend === 'webgpu' && typeof gpu?.requestAdapter === 'function') {
    // Three still decides for itself when the browser has no `requestAdapter` at all; the probe only
    // covers the case a real browser can be in — the API is there and hands back no adapter.
    const adapter = await Promise.resolve()
      .then(() => gpu.requestAdapter({ powerPreference: 'high-performance' }))
      .catch(() => null);
    if (!adapter) {
      selection = { ...selection, backend: 'webgl2',
        fallbackReason: 'WebGPU is available but exposed no adapter, so the preview uses WebGL 2.' };
    }
  }
  const renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL: selection.backend === 'webgl2',
    powerPreference: 'high-performance' });
  try {
    await renderer.init();
  } catch (error) {
    renderer.dispose();
    throw new Error(`Neither WebGPU nor its WebGL 2 fallback could initialize: ${error.message}`);
  }
  const backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  const status = {
    requested: 'webgpu', backend,
    fallbackReason: backend === 'webgl2' ? selection.fallbackReason || 'WebGPU adapter/device initialization failed; Three.js initialized its WebGL 2 fallback.' : '',
    adapter: backend === 'webgpu' ? await gpuAdapterInfo(environment?.gpu ?? globalThis.navigator?.gpu) : '',
  };
  const dispose = renderer.dispose.bind(renderer);
  let disposed = false;
  renderer.dispose = () => {
    if (disposed) return;
    disposed = true;
    // Three r180 loses WebGL contexts on dispose. Restore only after all old
    // renderer resources are released, before a new renderer reuses this canvas.
    restoreDisposedContext(renderer, canvas);
    dispose();
  };
  canvas.dataset.rendererBackend = status.backend;
  canvas.dataset.rendererFallback = status.fallbackReason;
  canvas.dataset.rendererRequested = status.requested;
  canvas.dataset.rendererAdapter = status.adapter;
  return { renderer, status };
}
