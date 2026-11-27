/**
 * The terrain viewport, and the four worlds the runtime can draw.
 *
 * `createTerrainViewer` from the package draws one finite world and owns its renderer. The tab
 * needs three things that viewer cannot give: an infinite, a planet and a mini world; a click that
 * lands on the terrain (so a shape can be placed where the pointer is); and one dispose that covers
 * whichever world was being looked at. So the viewport is built here instead — renderer, scene,
 * camera, orbit controls and the frame loop — and the runtime does what only it can: generate the
 * world, stream it and answer `update(delta)`.
 *
 * Every world instance implements the same interface (`object`, `update`, `prepare`, `configure`,
 * `serialize`, `dispose`), which is what lets the mode selector be a factory lookup rather than a
 * branch in the loop.
 */
import * as THREE from '/vendor/three/three.module.js';
import { OrbitControls } from '/vendor/three-addons/controls/OrbitControls.js';

export const WORLD_MODES = [
  ['finite', 'Finite island', 'A bounded board: the world you sculpt and export into a level.'],
  ['infinite', 'Infinite', 'Streams chunks around the camera; nothing is exported to the level.'],
  ['planet', 'Planet', 'A cube-sphere planet; needs a noise stack, and is not exported to the level.'],
  ['mini', 'Mini', 'A small preset diorama (cove, mesa…) with its own relief controls.'],
];

const MINI_RECIPES = ['cove', 'mesa', 'atoll', 'ridge', 'isles'];
export { MINI_RECIPES };

/**
 * Builds the world for a mode.
 *
 * Each entry point is imported on demand: a project that only ever opens the finite world never
 * downloads the planet's shaders, which is most of the package's weight.
 */
async function createWorld(mode, renderer, configuration, signal) {
  if (mode === 'infinite') {
    const { createInfiniteTerrain } = await import('procedural-terrains/infinite');
    return createInfiniteTerrain({ renderer, signal, configuration: {
      layout: { chunkSize: configuration.layout.chunkSize, viewRadius: 8, cacheResolution: 256 },
      source: configuration.source,
      seaLevel: configuration.seaLevel,
      heightScale: configuration.heightScale,
    } });
  }
  if (mode === 'planet') {
    const { createPlanetTerrain } = await import('procedural-terrains/planet');
    return createPlanetTerrain({ renderer, signal, configuration: {
      layout: { radius: 16000, faceGrid: 8, bakeResolution: 256 },
      source: configuration.source,
      seaLevel: configuration.seaLevel,
      heightScale: configuration.heightScale,
    } });
  }
  if (mode === 'mini') {
    const { createMiniTerrain } = await import('procedural-terrains/mini');
    return createMiniTerrain({ renderer, signal, mini: {
      recipe: configuration.mini?.recipe || 'cove',
      seed: configuration.source?.seed ?? 1337,
      width: configuration.mini?.width || 1024,
      quality: configuration.mini?.quality || 'balanced',
    } });
  }
  const { createTerrain } = await import('procedural-terrains');
  return createTerrain({ renderer, signal, configuration });
}

/**
 * The viewport.
 *
 * `onPick({ x, z, y })` is called when the pointer clicks the terrain itself, in world units — the
 * coordinate a shape's position takes. A click that misses the terrain is not a pick, so a drag
 * that orbits the camera never moves a shape.
 */
export function createTerrainViewport(container, { onPick = null } = {}) {
  // Rebindable: the panel arms a brush only while a sculpt or paint tool is active, and an armed
  // brush owns the drag so the camera does not orbit underneath it.
  const interaction = { pick: onPick, stroke: null };
  let stroking = false;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x10151c, 1);
  container.append(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);
  const camera = new THREE.PerspectiveCamera(55, 1, 1, 200000);
  camera.position.set(900, 700, 900);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  // The studio's worlds use their own sun and ambient terms, so a light here would only fight them.
  scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x30343a, 2.2));

  let world = null, mode = null, disposed = false, frame = 0;
  const clock = new THREE.Clock();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;

  function resize() {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function tick() {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const delta = Math.min(.1, clock.getDelta());
    controls.update();
    try { world?.update?.(delta, { camera }); } catch { /* a world between builds */ }
    renderer.render(scene, camera);
  }

  function target() {
    if (!world) return null;
    return world.object || world.terrain?.object || null;
  }

  /**
   * Where the pointer is on the terrain, or null.
   *
   * The same raycast serves two purposes: placing a shape (one click) and stroking a brush (a drag).
   * A brush tool takes the drag, so the camera must not orbit while one is armed — that is
   * `interaction.stroke` being set.
   */
  function pointUnder(event) {
    const object = target();
    if (!object) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(object, true);
    if (!hits.length) return null;
    const point = hits[0].point;
    return { x: point.x, z: point.z, y: point.y };
  }

  renderer.domElement.addEventListener('pointerdown', event => {
    downAt = { x: event.clientX, y: event.clientY };
    if (!interaction.stroke) return;
    const point = pointUnder(event);
    if (!point) return;
    stroking = true;
    controls.enabled = false;
    renderer.domElement.setPointerCapture?.(event.pointerId);
    interaction.stroke({ ...point, phase: 'start' });
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (!stroking || !interaction.stroke) return;
    const point = pointUnder(event);
    if (point) interaction.stroke({ ...point, phase: 'move' });
  });
  for (const type of ['pointerup', 'pointercancel']) {
    renderer.domElement.addEventListener(type, event => {
      if (stroking) {
        stroking = false;
        controls.enabled = true;
        const point = pointUnder(event);
        interaction.stroke?.({ ...(point || { x: 0, z: 0, y: 0 }), phase: 'end' });
      }
      if (!interaction.pick || !downAt) { downAt = null; return; }
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      // Orbiting the camera is a drag, not a placement.
      if (moved > 4) return;
      const point = pointUnder(event);
      if (point) interaction.pick(point);
    });
  }

  /** Replaces the world. The previous one is disposed first: two worlds share a GPU. */
  async function setWorld(nextMode, configuration, { signal = null } = {}) {
    disposeWorld();
    mode = nextMode;
    clock.getDelta();
    world = await createWorld(nextMode, renderer, configuration, signal);
    if (disposed) { world?.dispose?.(); world = null; return null; }
    if (world?.object) scene.add(world.object);
    else if (world?.terrain?.object) scene.add(world.terrain.object);
    try { await world.prepare?.(camera); } catch { /* a world may draw on its first update */ }
    if (nextMode === 'planet') { camera.position.set(60000, 40000, 60000); controls.target.set(0, 0, 0); }
    else if (nextMode === 'infinite') { camera.position.set(900, 700, 900); controls.target.set(0, 0, 0); }
    controls.update();
    return world;
  }

  function disposeWorld() {
    const current = world;
    world = null;
    if (!current) return;
    try { current.dispose?.(); } catch { /* already gone */ }
    const object = current.object || current.terrain?.object;
    if (object?.parent) object.parent.remove(object);
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    disposeWorld();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  frame = requestAnimationFrame(tick);
  return {
    renderer, scene, camera, controls,
    setWorld, dispose,
    /**
     * A hidden canvas still costs a frame's worth of work every time the tab is somewhere else,
     * and the terrain is the heaviest scene the studio draws. Pausing leaves the camera and the
     * world exactly as they were.
     */
    pause() {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    resume() {
      if (disposed || frame) return;
      clock.getDelta(); // the pause is not a frame: drop the elapsed time instead of lurching.
      frame = requestAnimationFrame(tick);
    },
    /** `{ pick, stroke }`, either of which may be null. */
    interact(next) { interaction.pick = next.pick || null; interaction.stroke = next.stroke || null; },
    /**
     * The terrain's own surface height at a board coordinate.
     *
     * A paint stroke only knows the height under the pointer; a tuft placed 300 units away needs
     * the height *there*, or a field painted on a slope is a flat sheet at the brush centre's
     * height. Null when the world cannot answer — a planet terrain samples in 3D, and a world that
     * is still being generated has no source yet — and the caller falls back to the pointer's.
     */
    heightAt(x, z) {
      try {
        const height = world?.sampleHeight?.(x, z);
        return Number.isFinite(height) ? height : null;
      } catch { return null; }
    },
    /** Pushes a new configuration into the live world; false when the world refuses it. */
    async reconfigure(configuration) {
      const current = world;
      if (!current?.configure) return false;
      try { await current.configure(configuration); return true; }
      catch { return false; }
    },
    world: () => world,
    mode: () => mode,
    /** Frames the whole world, which is what "Generate" should leave you looking at. */
    fit() {
      const object = target();
      if (!object) return;
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3()).length() || 1000;
      const centre = box.getCenter(new THREE.Vector3());
      controls.target.copy(centre);
      const direction = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(centre).add(direction.multiplyScalar(size * .9));
      camera.near = Math.max(.5, size / 10000);
      camera.far = size * 20;
      camera.updateProjectionMatrix();
      controls.update();
    },
  };
}
