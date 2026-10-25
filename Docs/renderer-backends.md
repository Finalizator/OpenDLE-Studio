# Renderer backends

How OpenDLE picks a GPU API in the browser, what it can and cannot control, and
how to check what is actually running.

## Facts

- OpenDLE renders with Three.js r180 (`three/webgpu`) through
  `public/render.js`. `createPreview()` calls
  `createBrowserRenderer(THREE.WebGPURenderer, canvas)` from
  `public/renderer-backend.js` and stores the result in
  `state.rendererStatus`.
- `selectRendererBackend({ secureContext, gpu })` in
  `public/renderer-backend.js` always returns `requested: 'webgpu'`. It returns
  `backend: 'webgl2'` only when the page is not a secure context or
  `navigator.gpu` is missing, and reports the reason in `fallbackReason`.
- `createBrowserRenderer()` constructs the renderer with
  `forceWebGL: selection.backend === 'webgl2'`, awaits `renderer.init()`, then
  records the **actual** backend by reading
  `renderer.backend.isWebGPUBackend`. A WebGPU adapter/device failure is
  therefore reported as `webgl2`, never as a WebGPU success.
- If both paths fail, init throws
  `Neither WebGPU nor its WebGL 2 fallback could initialize: ...`.
- There is no WebGL1 path, no backend selector in the UI, no adapter or
  power-preference chooser, and no native GPU API path.
- GLSL effects (`project.shaders`, `environment.shaderId`) are compiled through
  Three's node pipeline for whichever backend is active, so a fallback does not
  disable effects. See DEVELOPMENT.md, "Renderer selection and GLSL effects".
- When disposing a WebGL2 renderer, `restoreDisposedContext()` restores the
  context (`WEBGL_lose_context`) so the same canvas can be reused by the next
  preview.

## What the browser allows

A page cannot select Vulkan, D3D12 or Metal. It can only ask for WebGPU or
WebGL2; the browser and driver decide which native API sits underneath.

| Page API | Typical native mapping | Chosen by |
| --- | --- | --- |
| WebGPU | Vulkan (Linux, Windows), D3D12 (Windows), Metal (macOS) | Browser implementation + driver |
| WebGL2 | ANGLE/D3D11 or GL/GLES passthrough | Browser implementation + driver |

So "Vulkan by default" is only achievable as "WebGPU, which uses Vulkan where the
browser does". It is not a renderer OpenDLE can select, name in project data, or
guarantee. WebGPU is the preferred and closest path; WebGL2 is the fallback.

WebGPU also requires a secure context. `http://localhost` and
`http://127.0.0.1` count as secure; a LAN IP over plain HTTP does not.

## Reading the active backend

In the editor:

1. Start Play. The status bar (footer, `#status`) ends with
   `<backend> preview ready`, followed by the fallback reason (after a dash) when
   one was reported. This text is written by `beginPreview()` in `public/app.js`
   from `preview.rendererStatus`.
2. Environment tab, "Renderer and GLSL effects" (`renderEnvironment()` in
   `public/app.js`) repeats the same policy text.
3. DevTools, on the preview canvas (`#preview`):

```js
const canvas = document.getElementById('preview');
canvas.dataset.rendererRequested; // always "webgpu"
canvas.dataset.rendererBackend;   // "webgpu" or "webgl2"
canvas.dataset.rendererFallback;  // "" or the fallback reason
```

Adapter details are **not** recorded by OpenDLE today. To inspect them manually:

```js
const adapter = await navigator.gpu?.requestAdapter();
adapter?.info; // vendor, architecture, device, description (Chromium; support varies)
```

Proposal: surface `adapter.info` in the same status line. That would require
reading it in `createBrowserRenderer()` and adding a field to `rendererStatus`.

## Forcing and verifying WebGPU

Chrome / Edge:

- `chrome://gpu` (or `edge://gpu`) lists `WebGPU` under Graphics Feature Status.
  Anything other than "Hardware accelerated" explains the fallback.
- `chrome://flags/#enable-unsafe-webgpu` re-enables WebGPU on blocklisted setups.
  Some Linux builds additionally need the browser started with
  `--enable-features=Vulkan` (or `--enable-unsafe-webgpu`).
- A browser launched with `--disable-gpu` or software rendering will not produce
  a WebGPU device.

Firefox:

- `about:support` shows graphics/compositor details.
- WebGPU on Firefox is gated per platform and release, and is not enabled
  everywhere by default. Where it is not, `dom.webgpu.enabled` in `about:config`
  exposes it; expect breakage on configurations Mozilla does not test.

Verification is the same everywhere: the status text and
`dataset.rendererBackend` must both read `webgpu`.

## When WebGPU is unavailable

1. Read the reported reason. "This browser does not expose the WebGPU API" and
   "WebGPU requires a secure context" are page/browser facts, not driver bugs.
2. Update the browser, then the GPU driver, then re-check `chrome://gpu`. WebGPU
   on Linux stays unavailable on blocklisted or very old drivers even when WebGL2
   works.
3. Try another Chromium-based browser. Firefox and Safari expose WebGPU on fewer
   configurations.
4. Continue on WebGL2. The preview is fully functional there; only the API label
   changes.
5. Running `./launch.sh` opens the same local site in the system browser.
   **Export playable app** (`/api/export/build`) packages the engine files, the
   exported project and platform launch scripts into a ZIP; the bundled
   `server/export-launcher.js` serves it locally and opens an installed
   Chromium-based browser in `--app` window mode, falling back to the default
   browser. It still renders through the same browser GPU stack, so WebGPU
   availability is unchanged.

## Limits worth knowing

- Backend choice is per preview creation, not switchable at runtime; a failed
  device forces the next preview through the same selection again.
- GPU feature limits (texture size, storage buffers) are whatever the adapter
  reports. Model textures are separately capped at 4096x4096 and 32 million
  decoded pixels per preview (`public/render.js`).
- Nothing in project data records the backend, so projects stay portable between
  machines with different GPU support.
