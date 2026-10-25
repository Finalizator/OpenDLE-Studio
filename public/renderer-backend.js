const contextRestorations = new WeakMap();

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
  timeout = setTimeout(() => complete(new Error('The disposed WebGL 2 context could not be restored on this canvas. Reload the preview to retry.')), 5000);
}

export function selectRendererBackend({ secureContext = globalThis.isSecureContext, gpu = globalThis.navigator?.gpu } = {}) {
  if (secureContext === false) return { requested: 'webgpu', backend: 'webgl2', fallbackReason: 'WebGPU requires a secure context (HTTPS or localhost).' };
  if (!gpu) return { requested: 'webgpu', backend: 'webgl2', fallbackReason: 'This browser does not expose the WebGPU API.' };
  return { requested: 'webgpu', backend: 'webgpu', fallbackReason: '' };
}

export async function createBrowserRenderer(WebGPURenderer, canvas, environment) {
  const restoration = contextRestorations.get(canvas);
  if (restoration) {
    const error = await restoration;
    contextRestorations.delete(canvas);
    if (error) throw error;
  }
  const selection = selectRendererBackend(environment);
  const renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL: selection.backend === 'webgl2' });
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
  return { renderer, status };
}
