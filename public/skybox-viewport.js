// The Skybox tab's viewport: the sky as the game draws it, with something to measure it against.
//
// A flat diagram answers "which part of the picture covers which degrees"; a viewport answers
// "what will the player see", which is the question an author actually asks while tuning a
// backdrop. It is a real renderer — the same fragment program the engine uses, built by
// `public/sky-material.js` — over a grid on the level's horizon, so a window that stops short of
// the ground is obvious at a glance.
//
// The sky is drawn first as a full-screen quad whose view is a pair of uniforms, then the grid with
// a real perspective camera set to the same angles: dragging turns both together.
import * as THREE from 'three/webgpu';
import { createBrowserRenderer } from './renderer-backend.js';
import { createSkyMaterial } from './sky-material.js';
import { skyboxSignature, animationFrameAt } from '/shared/skybox.js';
import { decodeSkyImage, skyImageFormat } from './sky-textures.js';

const DEG = Math.PI / 180;
const EYE_HEIGHT = 41;
const GROUND = { colour: '#262626', line: '#3f3f3f', ring: '#6a6758', label: '#d4c28e' };

export async function createSkyViewport(canvas, { background = '#333333' } = {}) {
  const { renderer } = await createBrowserRenderer(THREE.WebGPURenderer, canvas);
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;
  renderer.setClearColor(background);

  const skyScene = new THREE.Scene();
  const backgroundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const world = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 1, 20000);
  camera.up.set(0, 1, 0);

  // A grid on the level's floor: the horizon it meets is where a sky's window should end.
  const grid = new THREE.GridHelper(4096, 32, GROUND.line, GROUND.line);
  grid.position.y = 0;
  world.add(grid);
  const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(2048, 48),
    new THREE.MeshBasicMaterial({ color: GROUND.colour }));
  groundDisc.rotation.x = -Math.PI / 2;
  groundDisc.position.y = -1;
  world.add(groundDisc);
  // Cardinal marks, so an azimuth window can be read as "west" rather than "-90".
  const marks = [];
  for (const [label, azimuth] of [['N', 90], ['E', 0], ['S', -90], ['W', 180]]) {
    const sprite = cardinalMark(label, azimuth);
    marks.push(sprite);
    world.add(sprite);
  }

  let built = null;
  let signature = '';
  let textures = new Map();
  let clock = 0;
  let frame = 0;
  const view = { azimuth: 90, elevation: 0, fov: 70 };
  const bounds = { width: 0, height: 0 };

  function cardinalMark(label, azimuth) {
    const size = 128, face = document.createElement('canvas');
    face.width = face.height = size;
    const context = face.getContext('2d');
    context.fillStyle = GROUND.label;
    context.font = 'bold 72px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, size / 2, size / 2);
    const texture = new THREE.CanvasTexture(face);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    // Doom's north is the engine's +z (`render.js` places an entity at `(x, height, y)`), and the
    // sky's own basis turns with `heading = atan2(z, x)`, so the marks use the same mapping.
    const az = azimuth * DEG;
    sprite.position.set(Math.cos(az) * 1600, 220, Math.sin(az) * 1600);
    sprite.scale.set(120, 120, 1);
    return sprite;
  }

  /** One texture per asset, decoded in whatever format the picture is. */
  async function textureFor(asset) {
    const cached = textures.get(asset.id);
    if (cached) return cached;
    const format = skyImageFormat({ name: asset.name || '', type: '', src: asset.src });
    const decoded = await decodeSkyImage({ src: asset.src, format, name: asset.name }, { THREE });
    textures.set(asset.id, decoded.texture);
    return decoded.texture;
  }

  async function build(skybox, assets) {
    const pending = new Map();
    for (const layer of skybox?.layers || []) {
      for (const id of skyboxImages(layer)) if (!textures.has(id)) {
        const asset = assets.find(item => item.id === id);
        if (asset?.src) pending.set(id, textureFor(asset).catch(() => null));
      }
    }
    await Promise.all(pending.values());
    if (built) {
      skyScene.remove(built.mesh);
      built.material.dispose();
      built.geometry.dispose();
      for (const cube of built.cubes) cube.dispose();
    }
    built = createSkyMaterial(skybox, textures);
    built.mesh = new THREE.Mesh(built.geometry, built.material);
    skyScene.add(built.mesh);
    canvas.dataset.skyLayers = String(built.layers.length);
    return built;
  }

  function skyboxImages(layer) {
    const ids = [layer.assetId];
    if (layer.faces) ids.push(...Object.values(layer.faces));
    for (const frame of layer.animation?.frames || []) ids.push(frame.assetId);
    return ids.filter(Boolean);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    if (width === bounds.width && height === bounds.height) return;
    bounds.width = width; bounds.height = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (built) built.uniforms.aspect.value = camera.aspect;
  }

  function placeCamera() {
    const azimuth = view.azimuth * DEG, elevation = view.elevation * DEG;
    camera.position.set(0, EYE_HEIGHT, 0);
    // The engine's own axes: x east, z north, and `heading = atan2(z, x)` is what the sky draws
    // with (`shared/sky-view.js`). The camera must look down exactly that direction, or the grid
    // and the sky disagree — with the z term negated the sky was mirrored, so it slid one way while
    // the ground slid the other.
    camera.lookAt(Math.cos(azimuth) * Math.cos(elevation) * 1000, EYE_HEIGHT + Math.sin(elevation) * 1000,
      Math.sin(azimuth) * Math.cos(elevation) * 1000);
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    if (!built) return;
    built.uniforms.heading.value = azimuth;
    built.uniforms.pitch.value = view.elevation * DEG;
    built.uniforms.aspect.value = camera.aspect;
    built.uniforms.tanFov.value = Math.tan(view.fov * DEG / 2);
    built.uniforms.pixelsPerRadian.value = Math.max(1, (bounds.height || 240) / (view.fov * DEG));
  }

  function draw() {
    if (!built) return;
    resize();
    placeCamera();
    // A layer's animation is a sampler swap, the same as in the game.
    for (const entry of built.layers) {
      const index = animationFrameAt(entry.layer.animation, clock);
      if (index < 0) continue;
      const assetId = entry.layer.animation.frames[index]?.assetId;
      const source = assetId ? textures.get(assetId) : null;
      if (source && entry.sampler.value !== source) entry.sampler.value = source;
    }
    renderer.autoClear = true;
    renderer.render(skyScene, backgroundCamera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(world, camera);
    canvas.dataset.skyFrame = String(frame);
    // What the view is doing, for the automation harness and for anyone reading the DOM: one
    // azimuth drives both the camera and the sky's `heading`, which is why they cannot disagree.
    canvas.dataset.skyAzimuth = view.azimuth.toFixed(2);
    canvas.dataset.skyElevation = view.elevation.toFixed(2);
  }

  let running = false, raf = 0, last = 0;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    const delta = Math.min(.1, (now - last) / 1000 || 0);
    last = now;
    // The preview clock runs at the game's rate so an animated sky reads the same here as in play.
    if (built && speedSource?.animation?.playing !== false) clock += delta * (Number(speedSource?.animation?.speed) || 1);
    draw();
    frame++;
    raf = requestAnimationFrame(tick);
  };
  // The record's own clock settings; the panel hands them over with `setSky`.
  let speedSource = null;

  const pointer = { down: false, x: 0, y: 0 };
  canvas.addEventListener('pointerdown', event => {
    pointer.down = true; pointer.x = event.clientX; pointer.y = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer.down) return;
    view.azimuth -= (event.clientX - pointer.x) * .35;
    view.elevation = Math.max(-89, Math.min(89, view.elevation + (event.clientY - pointer.y) * .35));
    pointer.x = event.clientX; pointer.y = event.clientY;
  });
  const release = () => { pointer.down = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    view.fov = Math.max(20, Math.min(110, view.fov + Math.sign(event.deltaY) * 4));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { view.azimuth = 90; view.elevation = 0; view.fov = 70; });

  return {
    /** Rebuilds when the record's structure changed; cheap when it did not. */
    async setSky(skybox, assets) {
      if (!skybox) return false;
      const next = skyboxSignature(skybox);
      speedSource = skybox;
      if (next === signature && built) return false;
      signature = next;
      await build(skybox, assets || []);
      canvas.dataset.skySignature = String(next.length);
      delete canvas.dataset.skyError;
      return true;
    },
    start() {
      if (running) return;
      running = true; last = performance.now();
      resize();
      placeCamera();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    setBackground(colour) {
      if (/^#[0-9a-f]{6}$/i.test(String(colour))) renderer.setClearColor(colour);
    },
    look(next = {}) {
      if (Number.isFinite(next.azimuth)) view.azimuth = next.azimuth;
      if (Number.isFinite(next.elevation)) view.elevation = Math.max(-89, Math.min(89, next.elevation));
      if (Number.isFinite(next.fov)) view.fov = Math.max(20, Math.min(110, next.fov));
      draw();
    },
    state() {
      return { running, frames: frame, clock: Number(clock.toFixed(3)), ...view,
        layers: built?.layers.length ?? 0, signature: String(signature).length,
        width: bounds.width, height: bounds.height };
    },
    dispose() {
      this.stop();
      if (built) {
        skyScene.remove(built.mesh);
        built.material.dispose();
        built.geometry.dispose();
        for (const cube of built.cubes) cube.dispose();
        built = null;
      }
      for (const texture of textures.values()) texture.dispose?.();
      textures = new Map();
      for (const sprite of marks) sprite.material.map?.dispose();
      grid.geometry.dispose(); grid.material.dispose();
      groundDisc.geometry.dispose(); groundDisc.material.dispose();
      renderer.dispose();
    },
  };
}
