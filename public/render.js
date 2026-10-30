import * as THREE from 'three/webgpu';
import { uniform, vec2, vec3, vec4, attribute, varying, materialColor, positionWorld, positionGeometry, output, uv, screenUV, viewportUV, texture, sin, cos, tan, atan, cross, normalize, length, clamp, mix } from 'three/tsl';
import { createBrowserRenderer } from './renderer-backend.js';
import { compileGLSLEffect } from './shader-effects.js';
import { validateShaders } from '/shared/shaders.js';
import { sectorGeometry, createSectorIndex, entitySector, sectorShapes, surfaceMaterials } from '/shared/sectors.js';
import { wallQuadUv, flatUv } from '/shared/uv.js';
import { spriteAnchor } from '/shared/sprite-anchor.js';
import { wallSegments } from '/shared/runtime.js';
import { GLTFLoader } from '/vendor/three-addons/loaders/GLTFLoader.js';
import { clone as cloneModel } from '/vendor/three-addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from '/vendor/three-addons/environments/RoomEnvironment.js';
import RAPIER from '/vendor/rapier/rapier.mjs';
import { createPhysics } from '/shared/physics.js';
import { eyePosition, upVector, viewDirection } from '/shared/gravity.js';
import { restoreCulling, restoreVisibility, revealForWarmup, uncullDrawables } from '/shared/render-warmup.js';
import { skyView } from '/shared/sky-view.js';
import { liveProjectPlan, modelOrientation, modelWorldBox, entityOrigin } from '/shared/entity-visuals.js';
import { renderBufferSize } from '/shared/render-resolution.js';
import { decodeDataURI, readModel, validateModelDocument } from '/shared/gltf.js';
import { PANEL_DEFAULTS } from '/shared/panel.js';
import { gameView, viewNeedsScissor } from '/shared/game-view.js';
import { gameLevelAssetIds } from '/shared/game-levels.js';
import { skyAssetFor, skyRequestName } from '/shared/sky.js';
import { createSpriteIndex } from '/shared/sprite-animation.js';
import { createFrameStats, createDatasetWriter } from '/shared/perf.js';
import { createSurfaceBatcher, mergePiece } from '/shared/surface-batch.js';
import { viewBob, weaponBob } from '/shared/player-motion.js';
import { WEDGE_INDICES, wedgeCorners } from '/shared/ramp.js';

export const entityColors = { player: '#70ddba', enemy: '#ed8b83', pickup: '#efd17a', light: '#a9beff', decoration: '#a6a4bc', ramp: '#c98b4b' };
// Imported models are shaded as physical surfaces instead of Doom's flat light
// levels: the environment only adds reflections and a little fill, a hemisphere
// light lifts the shadows predictably, the key light separates faces and the rim
// picks them out of the background. Tuned against a dark Blockbench texture (mean
// sRGB 0.22) so a lit face lands near its authored tone instead of washing out to
// mid grey. Sector light still tints a model down to `ambientFloor`.
export const MODEL_LIGHTING = { environment: .18, fill: .9, key: 2.8, rim: .6, ambientFloor: .25 };
let rapierReady;

export async function createPreview(canvas, project, state, { editor = false } = {}) {
  if (!editor) {
    rapierReady ||= RAPIER.init();
    await rapierReady;
  }
  const { renderer, status: rendererStatus } = await createBrowserRenderer(THREE.WebGPURenderer, canvas);
  state.rendererStatus = rendererStatus;
  let shaderCompileError = '';
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    shaderCompileError = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n') || 'GPU shader compilation failed';
    canvas.dataset.shaderError = shaderCompileError;
  };
  renderer.setSize(800, 450, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(project.environment.sky);
  const camera = new THREE.PerspectiveCamera(70, 800 / 450, 1, 40000);
  let geometry = editor ? sectorGeometry(project) : state.sectors;
  const textures = new Map();
  let assetMap = new Map((project.assets || []).map(asset => [asset.id, asset]));
  // Textures the engine draws itself, for marks no imported artwork exists for. A bullet hole
  // is the size of a thumbprint on a wall, and shipping a one-pixel idea as an asset would put
  // it in every project's library; a canvas drawn once and cached is enough.
  const builtinTextures = new Map();
  function builtinTexture(id) {
    let texture = builtinTextures.get(id);
    if (texture) return texture;
    const size = 32, canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d'), centre = size / 2;
    const ring = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
    ring.addColorStop(0, 'rgba(4, 3, 2, 0.98)');
    ring.addColorStop(.30, 'rgba(10, 8, 6, 0.92)');
    ring.addColorStop(.52, 'rgba(46, 40, 34, 0.72)');
    ring.addColorStop(.70, 'rgba(150, 142, 130, 0.34)');
    ring.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = ring;
    context.fillRect(0, 0, size, size);
    // A few cracks, so the same mark at the same rotation does not read as a printed dot.
    context.strokeStyle = 'rgba(12, 10, 8, 0.45)'; context.lineWidth = 1;
    for (const angle of [.4, 1.9, 3.6, 5.2]) {
      context.beginPath();
      context.moveTo(centre + Math.cos(angle) * 2.5, centre + Math.sin(angle) * 2.5);
      context.lineTo(centre + Math.cos(angle) * 10, centre + Math.sin(angle) * 10);
      context.stroke();
    }
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    builtinTextures.set(id, texture);
    return texture;
  }
  function imageTexture(id) {
    if (!id) return null;
    if (id.startsWith('builtin:')) return builtinTexture(id);
    const result = textures.get(id);
    if (!result) throw new Error(`Preview image ${assetMap.get(id)?.name || id} (${id}) was not loaded`);
    return result;
  }
  const materials = new Set(), geometries = new Set();
  const lightPositions = Array.from({ length: 16 }, () => new THREE.Vector3());
  const lightColors = Array.from({ length: 16 }, () => new THREE.Color(0));
  const lightRadii = new Float32Array(16);
  const lightNodes = lightPositions.map((position, index) => ({
    position: uniform(position), color: uniform(lightColors[index]), radius: uniform(0),
  }));
  const effectTime = uniform(0), effectEnabled = uniform(1);
  // Height at which ceilings are cut away: the editor raises it while the camera is
  // below a room's ceiling so the room can be looked into from above. Far away means
  // "draw every ceiling", which is what gameplay wants.
  // Everything above the cut stays: a ceiling below the camera is cut away so the room
  // it covers can be looked into from above. -1e30 draws every ceiling.
  const ceilingCut = uniform(-1e30);
  let ceilingsHidden = false;
  let shaderEffect = null;
  // Everything drawn behind an effect that samples the screen, so a plastic strip or a
  // pane of glass refracts the level instead of merely being see-through. It only costs
  // a second scene pass while such an object is on screen.
  const screenTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  const screenSize = new THREE.Vector2();
  // `iResolution` for Shadertoy effects: one uniform shared by every compiled effect.
  const effectResolution = uniform(new THREE.Vector2(1280, 720));
  const screenObjects = new Set();
  function needsScreenPass() {
    for (const object of screenObjects) if (object.visible) return true;
    return false;
  }
  // Objects can carry their own shader; compile each one once and reuse it. The key holds
  // the source too, so editing a shader rebuilds its effect instead of drawing a stale one.
  const entityEffects = new Map();
  function effectFor(id) {
    if (!id) return null;
    const shader = (project.shaders || []).find(entry => entry.id === id);
    if (!shader) return null;
    const key = [shader.id, shader.source, JSON.stringify(shader.uniforms ?? {})].join('\u0000');
    if (!entityEffects.has(key)) {
      let compiled = null;
      try { compiled = compileGLSLEffect(shader, { screen: screenTarget.texture, resolution: effectResolution }); }
      catch (error) { compiled = null; canvas.dataset.shaderError = `render.js: ${error.message}`; console.warn(`Shader ${shader.name} failed to compile:`, error); }
      entityEffects.set(key, compiled);
    }
    return entityEffects.get(key);
  }
  function effectMaterial(material, effect) {
    const result = renderer.library.fromMaterial(material);
    if (!result) throw new Error(`Shader effects do not support material ${material.type}`);
    result.outputNode = mix(output, effect.effect(output, uv(), effectTime, screenUV), effectEnabled);
    if (effect.usesScreen) screenMaterials.add(result);
    return result;
  }
  // `fromMaterial` may hand back a fresh material, so the ones that read the screen are
  // remembered here rather than by a flag on the material they came from.
  const screenMaterials = new WeakSet();
  /** Remembers an object whose material reads the screen, so the pass is only paid for then. */
  function trackScreen(object, material) {
    if (screenMaterials.has(material)) screenObjects.add(object); else screenObjects.delete(object);
    return object;
  }
  function withEffect(material) {
    if (!shaderEffect) return material;
    return effectMaterial(material, shaderEffect);
  }
  /**
   * A panel's material.
   *
   * A panel that refracts is drawn as a basic node material whose colour *is* the effect:
   * replacing a physical material's output node with a screen sample left the draw with no
   * fragment output (a blank strip), so the refraction gets a material built for it.
   */
  function panelMaterial(panel, entity) {
    const effect = effectFor(entity?.shaderId);
    const color = panel.color || PANEL_DEFAULTS.color;
    const opacity = panel.opacity ?? PANEL_DEFAULTS.opacity;
    const material = new THREE.MeshPhysicalMaterial({
      color, transparent: true, opacity,
      roughness: panel.roughness ?? PANEL_DEFAULTS.roughness, metalness: 0,
      emissive: new THREE.Color(color).multiplyScalar(.10),
      clearcoat: 1, clearcoatRoughness: .08, reflectivity: .8,
      transmission: 1, thickness: Math.max(6, (panel.thickness || 2) * 6), ior: 1.5,
      attenuationColor: new THREE.Color(color), attenuationDistance: 24,
      side: THREE.DoubleSide, depthWrite: false,
    });
    if (effect) {
      // The shader *is* the look of the strip, so it is drawn as a node material of its
      // own: folding it into a lit surface's output node left translucent panels with no
      // fragment output at all (an invisible strip), while this draws exactly what the
      // effect returned.
      const shaded = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const tint = new THREE.Color(color);
      shaded.colorNode = effect.effect(vec4(tint.r, tint.g, tint.b, opacity), uv(), effectTime, viewportUV, effectResolution);
      if (effect.usesScreen) screenMaterials.add(shaded);
      return shaded;
    }
    return material;
  }







  /** The object's own shader wins over the level-wide one. */
  function withEffectFor(material, entity) {
    const effect = effectFor(entity?.shaderId);
    return effect ? effectMaterial(material, effect) : withEffect(material);
  }
  const loader = new THREE.TextureLoader();
  let physics = null, environmentTarget = null;
  const models = new Map(), modelList = [], mixers = new Set(), pointLights = [];
  const projectileMeshes = new Map();
  // Camera-texture render targets, filled with live views each frame.
  const cameraViews = new Map();
  // Never rendered: it only exists so compileAsync can build every preview pipeline
  // while the level loads instead of the first time a surface becomes visible.
  const warmupScene = new THREE.Scene();
  const backgroundScene = new THREE.Scene(), backgroundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const overlayScene = new THREE.Scene(), overlayCamera = new THREE.OrthographicCamera(0, 320, 200, 0, -1, 1);
  let disposed = false;
  const disposers = [];
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const release of disposers.splice(0)) { try { release(); } catch { /* already gone */ } }
    // Projectile meshes share pooled geometries and materials tracked by the sets below.
    projectileMeshes.clear();
    for (const view of cameraViews.values()) for (const target of view.targets) target.dispose();
    physics?.dispose(); state.physics = null;
    mixers.forEach(mixer => mixer.stopAllAction());
    scene.traverse(object => { if (object.isSkinnedMesh) object.skeleton.dispose(); });
    environmentTarget?.dispose();
    screenTarget.dispose();
    const images = new Set();
    for (const texture of textures.values()) { images.add(texture.image); texture.dispose(); }
    for (const image of images) image?.close?.();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    renderer.dispose();
  }
  try {
    const shaderErrors = validateShaders(project);
    if (shaderErrors.length) throw new Error(shaderErrors.join('; '));
    const selectedShader = project.shaders?.find(shader => shader.id === project.environment.shaderId);
    if (selectedShader) {
      try { shaderEffect = compileGLSLEffect(selectedShader, { screen: screenTarget.texture, resolution: effectResolution }); }
      catch (error) { canvas.dataset.shaderError = error.message; throw new Error(`Shader ${selectedShader.name}: ${error.message}`); }
    }
    canvas.dataset.shaderId = selectedShader?.id || '';
    canvas.dataset.shaderError = '';
    // Load sequential batches to bound temporary decoded-image memory.
    const levelAssets = project.game ? new Set(gameLevelAssetIds(project)) : null;
    const assets = (project.assets || []).filter(asset => !['model', 'font', 'sound', 'music'].includes(asset.kind) &&
      (!levelAssets || levelAssets.has(asset.id)));
    for (let offset = 0; offset < assets.length; offset += 16) await Promise.all(assets.slice(offset, offset + 16).map(async asset => {
      const texture = await loader.loadAsync(asset.src);
      if (texture.image.width !== asset.width || texture.image.height !== asset.height) {
        texture.dispose(); throw new Error(`Asset ${asset.name} dimensions do not match its image`);
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
      texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
      textures.set(asset.id, texture);
    }));
    // Camera textures: ANIMDEFS reserves a surface no image backs. Rendering its
    // live view into a render target and pointing the asset's texture at it makes
    // every material that names it show the feed. Two targets alternate because a
    // pass may not sample the surface it is drawing into.
    for (const definition of project.cameraTextures || []) {
      if (cameraViews.size >= 8) break;
      const placeholder = [...assetMap.values()].find(asset => asset.name.toUpperCase() === definition.name.toUpperCase());
      if (!placeholder || !textures.has(placeholder.id)) continue;
      const targets = [0, 1].map(() => {
        const target = new THREE.RenderTarget(definition.width, definition.height, { depthBuffer: true });
        target.texture.colorSpace = THREE.SRGBColorSpace;
        target.texture.magFilter = THREE.NearestFilter; target.texture.minFilter = THREE.NearestFilter;
        target.texture.wrapS = THREE.RepeatWrapping; target.texture.wrapT = THREE.RepeatWrapping;
        target.texture.generateMipmaps = false;
        return target;
      });
      const view = new THREE.PerspectiveCamera(90, definition.width / definition.height, 4, 32768);
      cameraViews.set(definition.name, { definition, targets, flip: 0, camera: view, assetId: placeholder.id,
        sampled: targets[1].texture, materials: null, materialsAt: -1, error: false });
      textures.set(placeholder.id, targets[1].texture);
    }
    const manager = new THREE.LoadingManager();
    const resourceErrors = new Set();
    manager.onError = url => resourceErrors.add(url);
    manager.setURLModifier(url => {
      if (!url.startsWith('data:') && !url.startsWith('blob:')) throw new Error('Model attempted to load a non-embedded resource');
      return url;
    });
    const modelLoader = new GLTFLoader(manager);
    const modelAssets = new Map();
    // Model-space bounds per asset, used by the editor to box an object exactly
    // without waiting for a frame to place its instance.
    const modelBounds = new Map();
    const modelImages = new Set();
    let modelPixels = 0;
    const usedModels = new Set(project.map.entities.map(entity => entity.modelAsset).filter(Boolean));
    for (const id of usedModels) {
      const asset = assetMap.get(id), bytes = decodeDataURI(asset.src), { json, binary } = readModel(bytes, asset.format);
      validateModelDocument(json, binary?.length);
      const loaded = await modelLoader.parseAsync(asset.format === 'glb' ? bytes.buffer : new TextDecoder().decode(bytes), '');
      if (!loaded.scene) throw new Error(`Model ${asset.name} has no default scene`);
      loaded.scene.traverse(node => {
        if (node.geometry) geometries.add(node.geometry);
        const list = node.material ? Array.isArray(node.material) ? node.material : [node.material] : [];
        for (const material of list) {
          materials.add(material);
          for (const value of Object.values(material)) if (value?.isTexture) textures.set(value.uuid, value);
        }
      });
      if (resourceErrors.size) throw new Error(`Model ${asset.name} has ${resourceErrors.size} unreadable resources; check its exported textures/buffers`);
      for (const texture of textures.values()) {
        const image = texture.image;
        if (!image || modelImages.has(image)) continue;
        modelImages.add(image); modelPixels += image.width * image.height;
        if (image.width > 4096 || image.height > 4096 || modelPixels > 32 * 1024 * 1024) {
          throw new Error('Preview texture budget exceeded: 4096x4096 per model texture, 32 million decoded pixels total');
        }
      }
      modelAssets.set(id, loaded);
      const local = new THREE.Box3().setFromObject(loaded.scene);
      if (!local.isEmpty()) modelBounds.set(id, local);
    }
    if (usedModels.size) {
      const room = new RoomEnvironment(), generator = new THREE.PMREMGenerator(renderer);
      environmentTarget = generator.fromScene(room, .04);
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = MODEL_LIGHTING.environment;
      room.dispose(); generator.dispose();
      // Fixed studio-style lights only reach the models; the classic surface shaders
      // keep their palette-faithful sector light.
      scene.add(new THREE.HemisphereLight('#e8f0ff', '#454c58', MODEL_LIGHTING.fill));
      const key = new THREE.DirectionalLight('#fff3e2', MODEL_LIGHTING.key);
      key.position.set(.55, 1, .35).normalize().multiplyScalar(2048);
      const rim = new THREE.DirectionalLight('#93b7ff', MODEL_LIGHTING.rim);
      rim.position.set(-.5, .4, -.8).normalize().multiplyScalar(2048);
      scene.add(key, key.target, rim, rim.target);
      for (let i = 0; i < 16; i++) { const light = new THREE.PointLight('#ffffff', 0); scene.add(light); pointLights.push(light); }
    }
    // Static world surfaces are merged into a few shared buffers instead of one mesh
    // per wall face and per sector surface; see shared/surface-batch.js for why.
    const batcher = createSurfaceBatcher();
    const batchMaterials = new Map(), batchMeshes = new Map();
    let collecting = null;
    let worldParts = [], worldPartKeys = new Map();
    function releaseRecords(entry) {
      if (!entry.records?.length) return;
      for (const record of entry.records) batcher.remove(record);
      entry.records.length = 0;
    }
    function rebuildPart(entry) {
      releaseRecords(entry);
      collecting = entry.records;
      try { entry.build(); } finally { collecting = null; }
    }
    // Editing moves one wall or one sector at a time; rebuilding every wall in the
    // map for each pointer move is what made live dragging stutter. Parts carry a
    // signature of everything they are drawn from, so only parts that really
    // changed are rebuilt.
    function worldPart(key, sectorIds, signature, build) {
      const previous = worldPartKeys.get(key);
      let entry = previous;
      if (previous && previous.signature === signature) {
        previous.sectorIds = sectorIds; previous.build = build;
      } else {
        if (previous) disposePart(previous);
        entry = { key, sectorIds, signature, build, records: [] };
        worldPartKeys.set(key, entry);
        rebuildPart(entry);
        rebuiltParts++;
      }
      if (!worldParts.includes(entry)) worldParts.push(entry);
      return entry;
    }
    function disposePart(entry) {
      releaseRecords(entry);
      worldPartKeys.delete(entry.key);
    }
    /**
     * Uploads every merged buffer whose quads changed. Called once per world build and
     * once per rebuilt part, so a dragged wall costs one buffer copy, not a full rebuild.
     */
    function flushBatches() {
      for (const piece of batcher.drain()) {
        let mesh = batchMeshes.get(piece);
        if (!piece.records.size) {
          if (mesh) {
            scene.remove(mesh);
            geometries.delete(mesh.geometry); mesh.geometry.dispose();
            batchMeshes.delete(piece);
          }
          continue;
        }
        const merged = mergePiece(piece);
        if (!mesh) {
          const geometry = new THREE.BufferGeometry();
          geometries.add(geometry);
          mesh = new THREE.Mesh(geometry, batchMaterials.get(piece.key));
          materials.add(mesh.material);
          scene.add(mesh);
          batchMeshes.set(piece, mesh);
        }
        const geometry = mesh.geometry;
        geometry.setAttribute('position', new THREE.BufferAttribute(merged.positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(merged.uvs, 2));
        // Sector light is per vertex, so one material covers every light level and a
        // merged buffer can hold surfaces from sectors of different brightness.
        geometry.setAttribute('surfaceLight', new THREE.BufferAttribute(merged.lights, 1));
        geometry.setIndex(new THREE.BufferAttribute(merged.index, 1));
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        mesh.userData.selectionRanges = merged.ranges;
      }
    }
    function mesh(buffer, material, destination = scene) {
      geometries.add(buffer); materials.add(material);
      const result = new THREE.Mesh(buffer, material);
      destination.add(result);
      return result;
    }
    const materialCache = new Map();
    // Sector light is a per-vertex attribute rather than a per-material uniform: a map
    // with a couple of hundred light levels would otherwise need a material per level
    // per texture, and the renderer keeps a pipeline for every material it draws.
    function material(assetId, color = '#ffffff', { masked = false, oneSided = false, ceiling = false } = {}) {
      const key = `${assetId}/${color}/${masked}/${oneSided}/${ceiling}`;
      if (materialCache.has(key)) return materialCache.get(key);
      const result = withEffect(new THREE.MeshBasicNodeMaterial({
        map: imageTexture(assetId), color: assetId ? '#ffffff' : color,
        side: oneSided ? THREE.FrontSide : THREE.DoubleSide,
        // A ceiling always keeps an alpha test: that is what cuts it away above the camera.
        alphaTest: masked || ceiling ? .5 : 0,
      }));
      result.userData.assetId = assetId;
      result.userData.batchKey = key;
      let illumination = varying(attribute('surfaceLight', 'float')).max(.03);
      for (const light of lightNodes) {
        const falloff = positionWorld.distance(light.position).div(light.radius.max(1)).oneMinus().max(0);
        illumination = illumination.add(light.color.mul(falloff.mul(falloff)));
      }
      const aboveCamera = positionWorld.y.greaterThan(ceilingCut).select(1, 0);
      result.colorNode = vec4(materialColor.rgb.mul(illumination.min(vec3(2))),
        ceiling ? materialColor.a.mul(aboveCamera) : materialColor.a);
      materials.add(result); materialCache.set(key, result); batchMaterials.set(key, result);
      return result;
    }
    /** Records one surface for the merged buffers, keeping it owned by the part that built it. */
    function surface(positions, uvs, indices, surfaceMaterial, light, selection) {
      const record = { positions, uvs, indices, light: Math.max(.03, light / 255), selection };
      batcher.add(surfaceMaterial.userData.batchKey, record);
      if (collecting) collecting.push(record);
      return record;
    }
    function plane(sector, height, assetId, ceiling) {
      for (const shape of sectorShapes(sector.rings)) {
        const outer = shape.outer.map(vertex => new THREE.Vector2(vertex.x, vertex.y));
        const holes = shape.holes.map(ring => ring.map(vertex => new THREE.Vector2(vertex.x, vertex.y)));
        const indices = THREE.ShapeUtils.triangulateShape(outer, holes).flat();
        const points = [...outer, ...holes.flat()];
        const positions = [], uv = [];
        // Surface texture scale: one tile covers `scale` times the artwork's pixel size
        // in map units, which is how a floor can use a coarser or finer pixel density.
        const asset = assetMap.get(assetId), scale = sector.textureScale || 1;
        const textureWidth = asset?.width || 64, textureHeight = asset?.height || 64;
        for (const point of points) {
          positions.push(point.x, height, point.y);
          uv.push(...flatUv(point.x, point.y, { textureWidth, textureHeight, scale }));
        }
        surface(positions, uv, indices,
          material(assetId, ceiling ? '#6d7680' : project.environment.floor, { ceiling }),
          sector.light, sector.id ? { kind: 'sector', id: sector.id, surface: ceiling ? 'ceilingHeight' : 'floorHeight' } : null);
      }
    }
    let wallLines = [];
    function sectorSignature(sector) {
      return `${sector.floorHeight}/${sector.ceilingHeight}/${sector.floorAsset || ''}/${sector.ceilingAsset || ''}` +
        `/${sector.textureScale || 1}/${sector.light}/${sector.sky ? 1 : 0}/${JSON.stringify(sector.rings)}`;
    }
    function wallSignature(wall, sectors) {
      const side = value => value ? `${value.sectorId}/${value.upper || ''}/${value.middle || ''}/${value.lower || ''}` +
        `/${value.offsetX || 0}/${value.offsetY || 0}/${value.textureScale || 1}` : '-';
      const area = id => {
        const sector = id && sectors.get(id);
        return sector ? `${sector.floorHeight}/${sector.ceilingHeight}/${sector.light}/${sector.sky ? 1 : 0}` : '-';
      };
      return `${wall.start.x},${wall.start.y}/${wall.end.x},${wall.end.y}/${wall.height}/${wall.assetId || ''}` +
        `/${wall.color || ''}/${wall.solid ? 1 : 0}/${wall.flags || 0}/${side(wall.right)}/${side(wall.left)}` +
        `/${area(wall.right?.sectorId)}/${area(wall.left?.sectorId)}`;
    }
    let rebuiltParts = 0;
    // Materials bake the environment colours and the GLSL effect, so a change to
    // either has to rebuild every part even though the map itself did not move.
    let worldInputs = JSON.stringify([project.environment, project.shaders || []]);
    function buildStaticWorld() {
    const seen = new Set();
    rebuiltParts = 0;
    worldParts = [];
    const sectorMap = new Map(geometry.map(sector => [sector.id, sector]));
    for (const sector of geometry) {
      seen.add(`sector:${sector.id}`);
      worldPart(`sector:${sector.id}`, [sector.id], sectorSignature(sector), () => {
        if (sector.ceilingHeight <= sector.floorHeight) return;
        plane(sector, sector.floorHeight, sector.floorAsset, false);
        if (!sector.sky) plane(sector, sector.ceilingHeight, sector.ceilingAsset, true);
      });
    }
    function wallQuad(wall, a, b, bottom, top, assetId, side, light, referenceTop, masked = false) {
      if (top <= bottom) return;
      const length = Math.hypot(b.x - a.x, b.y - a.y), asset = assetMap.get(assetId);
      // Wall texture scale: one tile covers `scale` times its pixel size along the wall
      // and vertically, so the artwork's pixel density is per surface.
      const coords = wallQuadUv({ length, bottom, top, referenceTop,
        offsetX: side?.offsetX || 0, offsetY: side?.offsetY || 0,
        textureWidth: asset?.width || 64, textureHeight: asset?.height || 64, scale: side?.textureScale || 1 });
      surface([a.x, bottom, a.y, b.x, bottom, b.y, b.x, top, b.y, a.x, top, a.y], coords, [0, 1, 2, 0, 2, 3],
        material(assetId, wall.color, { masked, oneSided: !editor }), light, { kind: 'wall', id: wall.id });
    }
    wallLines = wallSegments(project);
    for (const wall of wallLines) {
    seen.add(`wall:${wall.id}`);
    worldPart(`wall:${wall.id}`, [wall.right?.sectorId, wall.left?.sectorId],
      wallSignature(wall, sectorMap), () => {
      if (!wall.right && !wall.left) {
        if (wall.solid) {
          wallQuad(wall, wall.start, wall.end, 0, wall.height, wall.assetId, null, 255, wall.height);
          wallQuad(wall, wall.end, wall.start, 0, wall.height, wall.assetId, null, 255, wall.height);
        }
        return;
      }
      for (const [side, back, a, b] of [[wall.right, wall.left, wall.start, wall.end], [wall.left, wall.right, wall.end, wall.start]]) {
        if (!side) continue;
        const frontSector = sectorMap.get(side.sectorId), backSector = sectorMap.get(back?.sectorId);
        const floor = frontSector.floorHeight, ceiling = frontSector.ceilingHeight, light = frontSector.light;
        if (!backSector) {
          const asset = assetMap.get(side.middle);
          wallQuad(wall, a, b, floor, ceiling, side.middle, side, light,
            wall.flags & 16 ? floor + (asset?.height || 128) : ceiling);
        } else {
          if (!(frontSector.sky && backSector.sky)) wallQuad(wall, a, b, Math.max(floor, backSector.ceilingHeight), ceiling,
            side.upper, side, light, wall.flags & 8 ? ceiling : backSector.ceilingHeight + (assetMap.get(side.upper)?.height || 128));
          wallQuad(wall, a, b, floor, Math.min(ceiling, backSector.floorHeight), side.lower, side, light,
            wall.flags & 16 ? ceiling : backSector.floorHeight);
          if (side.middle) {
            const bottom = Math.max(floor, backSector.floorHeight), top = Math.min(ceiling, backSector.ceilingHeight);
            const height = assetMap.get(side.middle).height;
            const anchor = wall.flags & 16 ? bottom + height : top;
            wallQuad(wall, a, b, Math.max(bottom, anchor - height - side.offsetY), Math.min(top, anchor - side.offsetY),
              side.middle, side, light, anchor, true);
          }
        }
      }
    });
    }
    if (!geometry.length) {
      const fallback = { rings: [[{ x: -20000, y: -20000 }, { x: 20000, y: -20000 }, { x: 20000, y: 20000 }, { x: -20000, y: 20000 }]], light: 255 };
      seen.add('fallback');
      worldPart('fallback', [], 'fallback', () => plane(fallback, 0, null, false));
    }
    // Parts for walls or sectors that no longer exist must not linger in the scene.
    for (const [key, entry] of worldPartKeys) {
      if (seen.has(key)) continue;
      disposePart(entry);
      worldPartKeys.delete(key);
    }
    }
    buildStaticWorld();
    flushBatches();
    // Three compiles a shader program the first time a material is drawn. Doors and
    // lifts reveal surfaces (the upper/lower/middle textures of the neighbouring
    // sector) that only exist once they move, so those materials get built and the
    // warm-up scene below compiles them during load instead of mid-game.
    const warmMaterials = new Set(), warmQuad = new THREE.PlaneGeometry(1, 1);
    // Starved of the vertex attribute the merged buffers carry, the warm-up quad would
    // shade black, so it gets one flat light value.
    warmQuad.setAttribute('surfaceLight', new THREE.Float32BufferAttribute(new Float32Array(warmQuad.attributes.position.count).fill(1), 1));
    geometries.add(warmQuad);
    function warmMaterial(assetId, color, masked) {
      if (assetId && !textures.has(assetId)) return;
      const surface = material(assetId, color, { masked, oneSided: true });
      if (warmMaterials.has(surface)) return;
      warmMaterials.add(surface);
      warmupScene.add(new THREE.Mesh(warmQuad, surface));
    }
    if (!editor) for (const surface of surfaceMaterials(geometry, wallLines, project.environment)) {
      warmMaterial(surface.assetId, surface.color, surface.masked);
    }
    // The sky is rebuilt from the environment rather than set up inline, because a
    // script can change it while the level runs (ACS ChangeSky).
    let appliedSky = null, failedSky = null;
    function clearSky() {
      for (const child of [...backgroundScene.children]) {
        backgroundScene.remove(child);
        const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
        for (const childMaterial of childMaterials) if (childMaterial) { materials.delete(childMaterial); childMaterial.dispose(); }
        if (child.geometry) { geometries.delete(child.geometry); child.geometry.dispose(); }
      }
      delete backgroundScene.userData.skybox;
      delete backgroundScene.userData.panorama;
      delete backgroundScene.userData.skyTexture;
      delete backgroundScene.userData.skyAssetId;
    }
    function buildSky(environment, assetId = environment.skyAsset) {
      clearSky();
      const skyAsset = assetMap.get(assetId);
      if (environment.skybox && assetId === environment.skyAsset) {
        const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(face => {
          const result = new THREE.MeshBasicMaterial({ map: imageTexture(environment.skybox[face]), side: THREE.BackSide, depthWrite: false });
          materials.add(result); return result;
        });
        const box = new THREE.BoxGeometry(20000, 20000, 20000);
        const sky = new THREE.Mesh(box, faces); geometries.add(box); backgroundScene.add(sky);
        backgroundScene.userData.skybox = sky;
        appliedSky = null;
      } else if (skyAsset && textures.has(skyAsset.id)) {
        const heading = uniform(0), pitch = uniform(0), aspect = uniform(800 / 450);
        const fieldOfView = uniform(Math.tan(35 * Math.PI / 180));
        const p = uv().mul(2).sub(1).mul(fieldOfView);
        const forward = vec3(cos(pitch).mul(cos(heading)), sin(pitch), cos(pitch).mul(sin(heading)));
        const right = vec3(sin(heading).negate(), 0, cos(heading));
        const ray = normalize(forward.add(right.mul(p.x).mul(aspect)).add(cross(right, forward).mul(p.y)));
        const doom = environment.skyMode === 'doom';
        const u = atan(ray.z, ray.x).div(6.2831853).mul(doom ? 4 : 1);
        const elevation = atan(ray.y, length(ray.xz));
        const v = doom ? clamp(tan(clamp(elevation, -1.4, 1.4)).mul(.65).add(.5), .001, .999) : elevation.div(Math.PI).add(.5);
        const backgroundMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
        backgroundMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
        // Keeping the sampler node lets ChangeSky swap the image without a rebuild.
        const skyTexture = texture(textures.get(skyAsset.id), vec2(u, v));
        backgroundMaterial.fragmentNode = skyTexture;
        backgroundMaterial.userData.panoramaUniforms = { heading, pitch, aspect, fieldOfView };
        mesh(new THREE.PlaneGeometry(2, 2), backgroundMaterial, backgroundScene);
        backgroundScene.userData.panorama = backgroundMaterial;
        backgroundScene.userData.skyTexture = skyTexture;
        backgroundScene.userData.skyAssetId = skyAsset.id;
        appliedSky = skyAsset.name.toUpperCase();
      } else {
        appliedSky = null;
      }
      failedSky = null;
    }
    /** Applies a ChangeSky request: an image swap normally, a rebuild when no sky is drawn. */
    function applySky(state) {
      if (editor || !state) return;
      const name = skyRequestName(state.skyRequest);
      if (!name || name.toUpperCase() === appliedSky) return;
      const asset = skyAssetFor(project, name);
      if (!asset || !textures.has(asset.id)) {
        if (failedSky !== name.toUpperCase()) {
          failedSky = name.toUpperCase();
          canvas.dataset.skyError = `ChangeSky: this project has no sky image named ${name.toUpperCase()}`;
        }
        return;
      }
      const skyTexture = backgroundScene.userData.skyTexture;
      if (skyTexture) {
        skyTexture.value = textures.get(asset.id);
        // A node graph keeps the sampler it was built with, so the material is
        // re-set up to read the new image; the pipeline itself is cached.
        backgroundScene.userData.panorama.needsUpdate = true;
        backgroundScene.userData.skyAssetId = asset.id;
        appliedSky = asset.name.toUpperCase();
        failedSky = null;
      } else buildSky(project.environment, asset.id);
      canvas.dataset.sky = appliedSky;
      delete canvas.dataset.skyError;
    }
    buildSky(project.environment);
    const sprites = new Map(), spriteList = [], colliderBoxList = [];
    let spriteTemplate = null;
    // Sprites and models are created on demand so runtime spawns appear without a
    // rebuild; removed entities are hidden instead of disposed (their objects can
    // be reused when an id comes back).
    function addSprite(entity) {
      if (sprites.has(entity.id)) return;
      if (!editor && !entity.spriteAsset) {
        // A grey billboard for an invisible marker is not a placeholder, it is a bug:
        // the MAP02 start has a teleport destination 68 units in front of the player.
        unrenderable.add(entity.id);
        if (withoutArtwork.length < 24) withoutArtwork.push({ id: entity.id, name: entity.name, type: entity.type, doomType: entity.doomType ?? null });
        return;
      }
      const asset = assetMap.get(entity.spriteAsset);
      const map = entity.spriteAsset ? imageTexture(entity.spriteAsset) : null;
      const color = asset ? '#ffffff' : entityColors[entity.type] || '#ffffff';
      // A shadered sprite cannot share the pre-wrapped template material.
      const material = entity.shaderId
        ? withEffectFor(new THREE.SpriteNodeMaterial({ map, color, alphaTest: .5, transparent: false, sizeAttenuation: true }), entity)
        : spriteTemplate ? spriteTemplate.clone()
          : withEffect(new THREE.SpriteNodeMaterial({ map, color, alphaTest: .5, transparent: false, sizeAttenuation: true }));
      if (spriteTemplate) { material.map = map; material.color.set(color); }
      materials.add(material); spriteTemplate ||= material;
      const sprite = new THREE.Sprite(material);
      sprite.userData.selection = { kind: 'entity', id: entity.id };
      trackScreen(sprite, material);
      scene.add(sprite); sprites.set(entity.id, sprite);
      spriteList.push({ id: entity.id, sprite, frame: undefined, flip: false, scale: 0, red: 0, green: 0, blue: 0 });
    }
    /**
     * The box a solid object with no artwork should be drawn as, or null.
     *
     * The same three numbers the collider uses, so what is drawn is the thing that blocks.
     */
    function solidBoxFor(entity) {
      const config = entity.physics;
      if (!config || config.body === 'none' || config.sensor) return null;
      if (config.shape === 'box') return { width: config.width, height: config.height, depth: config.depth };
      if (config.shape === 'wedge') return { width: config.width, height: config.height, depth: config.depth,
        wedge: config.wedge?.facing === 'left' ? 'left' : 'right' };
      if (config.shape === 'capsule' || config.shape === 'cylinder' || config.shape === 'cone' || config.shape === 'ball') {
        const diameter = config.radius * 2;
        return { width: diameter, height: config.height || diameter, depth: diameter };
      }
      return null;
    }
    const colliderBoxes = new Map();
    /**
     * Give a collider box the object's texture, tiled to its size.
     *
     * A ramp is drawn as its collider, so a texture on it has to go on that box, not replace the
     * object with a flat sprite — which is what assigning an image used to do: the ramp vanished
     * and a billboard appeared where it had been. The texture is cloned per object so its repeat
     * can follow this object's size without changing the tile for every other user of the asset.
     */
    function applyBoxTexture(material, entity, box) {
      const assetId = entity.spriteAsset || '';
      const signature = `${assetId}:${Math.round(box.width)}x${Math.round(box.depth)}`;
      if (material.userData.mapSignature === signature) return;
      material.userData.mapSignature = signature;
      const previous = material.map;
      const source = assetId ? imageTexture(assetId) : null;
      if (!source) {
        material.map = null;
        if (previous) { textures.delete(previous.uuid); previous.dispose(); }
        material.needsUpdate = true;
        return;
      }
      const map = source.clone();
      map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(Math.max(1, Math.round(box.width / 64)), Math.max(1, Math.round(box.depth / 64)));
      map.needsUpdate = true;
      textures.set(map.uuid, map);
      material.map = map;
      if (previous) { textures.delete(previous.uuid); previous.dispose(); }
      material.needsUpdate = true;
    }
    /** A wedge as a mesh, from the same six corners the collider is built from. */
    function wedgeGeometry(box) {
      // The corners are the collider's, from shared/ramp.js: the ramp the player is stopped by and
      // the ramp they see are one shape read twice, not two shapes kept in step by hand.
      const corners = wedgeCorners({ width: box.width, height: box.height, depth: box.depth, facing: box.wedge });
      const positions = new Float32Array(corners.flat());
      const low = corners[0][0];
      const uvs = new Float32Array(positions.length / 3 * 2);
      for (let i = 0; i < positions.length / 3; i++) {
        uvs[i * 2] = (positions[i * 3] - low) / Math.max(1, box.width);
        uvs[i * 2 + 1] = positions[i * 3 + 1] / Math.max(1, box.height);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(WEDGE_INDICES);
      geometry.computeVertexNormals();
      return geometry;
    }
    function addColliderBox(entity) {
      if (colliderBoxes.has(entity.id)) return;
      const box = solidBoxFor(entity);
      const geometry = box.wedge ? wedgeGeometry(box) : new THREE.BoxGeometry(box.width, box.height, box.depth);
      const material = withEffect(new THREE.MeshBasicNodeMaterial({ color: entityColors[entity.type] || '#a6a4bc' }));
      applyBoxTexture(material, entity, box);
      geometries.add(geometry); materials.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.selection = { kind: 'entity', id: entity.id };
      scene.add(mesh);
      colliderBoxes.set(entity.id, mesh);
      colliderBoxList.push({ id: entity.id, mesh });
    }
    /**
     * The image assigned to an object, as its model's texture.
     *
     * The ramp tool generates a plain white mesh, so the picture dropped on a ramp is what gives
     * it a surface; an imported model keeps its own materials. This runs from the frame loop and
     * not only when the model is created, because a texture assigned to a ramp that is already on
     * screen used to wait for a reload that never came — one ramp showed its texture and the next
     * one did not.
     */
    function applyModelTexture(entry, entity) {
      if (entity.type !== 'ramp') return;
      const signature = entity.spriteAsset || '';
      if (entry.textureAsset === signature) return;
      entry.textureAsset = signature;
      const image = signature ? imageTexture(signature) : null;
      for (const material of entry.tinted) {
        const previous = material.map;
        if (previous && material.userData.ownMap) { textures.delete(previous.uuid); previous.dispose(); }
        if (!image) {
          // Back to the model's own material, which carries no map.
          material.map = null; material.userData.ownMap = false; material.needsUpdate = true;
          continue;
        }
        const map = image.clone();
        map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.RepeatWrapping;
        // The generated mesh's UVs are already in map units over 64, so one repeat is one tile
        // per 64 units and a bigger ramp simply repeats more.
        map.repeat.set(1, 1);
        map.needsUpdate = true; textures.set(map.uuid, map);
        material.map = map; material.userData.ownMap = true; material.needsUpdate = true;
      }
    }
    function addModel(entity) {
      const loaded = modelAssets.get(entity.modelAsset);
      if (!loaded) throw new Error(`Model ${entity.modelAsset} was not loaded`);
      const object = cloneModel(loaded.scene), root = new THREE.Group(); root.add(object); scene.add(root);
      root.userData.selection = { kind: 'entity', id: entity.id };
      root.userData.samplesScreen = false;
      object.scale.setScalar(entity.modelScale ?? 32);
      const tinted = [];
      object.traverse(node => {
        if (node.geometry) geometries.add(node.geometry);
        if (node.material) {
          const copy = original => {
            const result = withEffectFor(original.clone(), entity); materials.add(result);
            if (screenMaterials.has(result)) root.userData.samplesScreen = true;
            if (result.color) { result.userData.baseColor = result.color.clone(); tinted.push(result); }
            for (const value of Object.values(result)) if (value?.isTexture) textures.set(value.uuid, value);
            return result;
          };
          node.material = Array.isArray(node.material) ? node.material.map(copy) : copy(node.material);
        }
      });
      const mixer = new THREE.AnimationMixer(object); mixers.add(mixer);
      mixer.addEventListener('finished', () => state.animationFinished.add(entity.id));
      if (root.userData.samplesScreen) screenObjects.add(root);
      const entry = { id: entity.id, assetId: entity.modelAsset, root, object, mixer, clips: loaded.animations, revision: -1, action: null, tinted, shade: -1 };
      models.set(entity.id, entry); modelList.push(entry);
    }
    // Panels: plastic strips, glass and screens are real translucent slabs, so they can
    // be rigid bodies that the player pushes around.
    const panels = new Map(), panelList = [];
    function addPanel(entity) {
      if (panels.has(entity.id)) return;
      const panel = entity.panel;
      const geometry = new THREE.BoxGeometry(panel.width, panel.height, Math.max(.5, panel.thickness ?? 2));
      geometries.add(geometry);
      // A translucent slab with nothing lighting it reads as a flat grey bar, so the panel
      // carries a little of its own light and a clear coat that catches what the level has.
      const material = panelMaterial(panel, entity);
      materials.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.selection = { kind: 'entity', id: entity.id };
      trackScreen(mesh, material);
      scene.add(mesh); panels.set(entity.id, mesh);
      panelList.push({ id: entity.id, mesh, shade: -1 });
    }
    // Runtime spawns reuse the loaded model, fall back to the entity sprite, and are
    // otherwise skipped instead of failing the frame.
    const unrenderable = new Set();
    // Things that carry no artwork. Doom draws nothing for them (TNT1, teleport
    // destinations, deathmatch starts), so a play preview must not either; the editor
    // still needs a placholder to select and move them.
    const withoutArtwork = [];
    function addEntity(entity) {
      if (entity.panel) { addPanel(entity); return; }
      // An object that only has a collider is a solid shape with no artwork: a surf ramp, a
      // blocking volume, a wall of a test map. Drawing nothing left it invisible in play — a
      // ramp you cannot see is a ramp you walk into and call an invisible wall — so its
      // collider is drawn, tilted exactly as the collider is.
      // A ramp is a shape, not a picture: it is always drawn as its collider, and a texture goes
      // on that shape. Letting it fall through to the sprite path turned it into a flat billboard.
      // A ramp is a model: the ramp tool generates its mesh, so it is drawn by the model path with
      // the texture on the mesh itself. Only a ramp saved before ramps were models falls through
      // to the collider box below.
      if (entity.type === 'ramp' && entity.modelAsset && modelAssets.has(entity.modelAsset)) { addModel(entity); return; }
      if (entity.type === 'ramp' && solidBoxFor(entity)) { addColliderBox(entity); return; }
      if (!entity.modelAsset && !entity.spriteAsset && solidBoxFor(entity)) { addColliderBox(entity); return; }
      if (!entity.modelAsset) { addSprite(entity); return; }
      if (modelAssets.has(entity.modelAsset)) { addModel(entity); return; }
      // In the editor an unloaded model means the project gained a model after the
      // preview started: setProject asks for a reload instead of drawing the sprite
      // again, which hid assigned models completely.
      if (editor) return;
      if (entity.spriteAsset) { addSprite(entity); return; }
      unrenderable.add(entity.id);
    }
    // A model and a sprite are separate objects, so switching between them (or
    // replacing one) has to drop the previous representation.
    function forgetPanel(id) {
      const mesh = panels.get(id);
      if (!mesh) return;
      mesh.removeFromParent();
      mesh.material.dispose();
      panels.delete(id);
      const index = panelList.findIndex(entry => entry.id === id);
      if (index >= 0) panelList.splice(index, 1);
    }
    function forgetEntity(id) {
      const sprite = sprites.get(id);
      if (sprite) {
        scene.remove(sprite);
        sprites.delete(id);
        const index = spriteList.findIndex(record => record.id === id);
        if (index >= 0) spriteList.splice(index, 1);
      }
      const model = models.get(id);
      if (model) {
        scene.remove(model.root);
        models.delete(id);
        mixers.delete(model.mixer);
        const index = modelList.indexOf(model);
        if (index >= 0) modelList.splice(index, 1);
      }
      const box = colliderBoxes.get(id);
      if (box) {
        box.removeFromParent();
        colliderBoxes.delete(id);
        const index = colliderBoxList.findIndex(entry => entry.id === id);
        if (index >= 0) colliderBoxList.splice(index, 1);
      }
      forgetPanel(id);
      unrenderable.delete(id);
    }
    // World bounds of what is actually drawn for an object, so the editor's
    // selection box matches the model instead of guessing from its sprite. The box
    // is built from the model's own bounds and the object's transform, so it is
    // right even before the next frame places the instance.
    function boundsOfEntity(id) {
      const entity = project.map.entities.find(candidate => candidate.id === id);
      if (!entity) return null;
      const local = entity.modelAsset && modelBounds.get(entity.modelAsset);
      if (local) {
        const sector = sectorIndex.at(entity.x, entity.y);
        const box = modelWorldBox({ min: local.min.toArray(), max: local.max.toArray() }, {
          scale: entity.modelScale ?? 32,
          position: entityOrigin(entity, sector?.floorHeight || 0),
          quaternion: modelOrientation(entity),
        });
        return new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
      }
      const model = models.get(id);
      if (model) return new THREE.Box3().setFromObject(model.root);
      const sprite = sprites.get(id);
      if (sprite) { sprite.updateMatrixWorld(true); return new THREE.Box3().setFromObject(sprite); }
      return null;
    }
    for (const entity of project.map.entities) if (editor || entity.type !== 'player') addEntity(entity);
    const weaponOverlays = new Map();
    const weaponIds = new Set([project.environment.weaponAsset, ...Object.values(project.environment.weaponAssets || {}),
      ...project.events.flatMap(event => event.actions.filter(action => action.type === 'playWeaponClip')
        .flatMap(action => project.spriteClips?.find(clip => clip.id === action.clipId)?.frames || []))].filter(Boolean));
    for (const weaponId of editor ? [] : weaponIds) {
      const weapon = assetMap.get(weaponId);
      const mat = new THREE.MeshBasicMaterial({ map: imageTexture(weapon.id), transparent: true, depthTest: false, depthWrite: false });
      const overlay = mesh(new THREE.PlaneGeometry(weapon.width, weapon.height), mat, overlayScene);
      const left = weapon.offsetX === undefined ? 160 - weapon.width / 2 : -weapon.offsetX;
      const top = weapon.offsetY === undefined ? 200 - weapon.height : 32 - weapon.offsetY;
      overlay.position.set(left + weapon.width / 2, 200 - top - weapon.height / 2, 0);
      weaponOverlays.set(weaponId, overlay);
    }
    const baseColors = new Map(project.map.entities.filter(entity => editor || entity.type !== 'player')
      .map(entity => [entity.id, new THREE.Color(entity.spriteAsset ? '#ffffff' : entityColors[entity.type])]));
    function baseColorFor(entity) {
      let color = baseColors.get(entity.id);
      if (!color) {
        color = new THREE.Color(entity.spriteAsset ? '#ffffff' : entityColors[entity.type] || '#ffffff');
        baseColors.set(entity.id, color);
      }
      return color;
    }
    // Projectile materials used to be built (and compiled) the moment a missile was
    // fired, which stalls the first shot while the driver compiles the shader. Warm
    // one template per kind up front and pool the instances afterwards.
    const projectileGeometry = new THREE.SphereGeometry(3, 8, 6), impactGeometry = new THREE.SphereGeometry(6, 8, 6);
    geometries.add(projectileGeometry); geometries.add(impactGeometry);
    const effectTexture = (project.assets || []).find(asset => textures.has(asset.id))?.id || null;
    const effectTemplates = {
      sprite: withEffect(new THREE.SpriteNodeMaterial({ map: effectTexture ? imageTexture(effectTexture) : null,
        transparent: true, alphaTest: .1, depthWrite: false })),
      mesh: withEffect(new THREE.MeshBasicNodeMaterial({ color: '#ffffff' })),
    };
    materials.add(effectTemplates.sprite); materials.add(effectTemplates.mesh);
    const effectPools = { sprite: [], mesh: [] };
    function takeEffectMaterial(kind, projectile) {
      const material = effectPools[kind].pop() || effectTemplates[kind].clone();
      materials.add(material);
      if (kind === 'mesh') material.color.set(projectile.color || '#ffffff');
      return material;
    }
    warmupScene.add(new THREE.Sprite(effectTemplates.sprite));
    warmupScene.add(new THREE.Mesh(projectileGeometry, effectTemplates.mesh));
    const triangulate = (outer, holes) => THREE.ShapeUtils.triangulateShape(outer.map(point => new THREE.Vector2(point.x, point.y)),
      holes.map(ring => ring.map(point => new THREE.Vector2(point.x, point.y))));
    if (!editor) { physics = createPhysics(project, state, RAPIER, triangulate); state.physics = physics; }
    let sectorIndex = createSectorIndex(geometry);
    // Thousands of objects ask for their sector every frame to pick up their floor and light
    // level. Most of them stand still, so the answer is cached per object and only re-tested
    // when it moves; on a 13,000-sector level the uncached test was the frame's whole cost.
    const sectorOf = entity => entitySector(sectorIndex.sectors, entity);
    let spriteIndex = createSpriteIndex(project);
    let sectorHeights = new Map(geometry.map(sector => [sector.id, `${sector.floorHeight}/${sector.ceilingHeight}`]));
    let worldRevision = state.worldRevision, appliedResolution = '';
    // Everything below is scratch state reused by every frame: precomputed lookups,
    // pooled objects and cached DOM/style writes keep the loop allocation-light.
    const entityIndex = new Map(), activeLights = [];
    const clearColors = new Map(), animatedMaterials = new Map();
    const cameraDirection = new THREE.Vector3();
    const viewUp = new THREE.Vector3(0, 1, 0), targetUp = new THREE.Vector3(0, 1, 0);
    const frameStats = createFrameStats({ window: 120, stallMs: 50 });
    // What the worst frame was doing, so a playtest log can name the stall instead of
    // only its length: update work, drawing, a geometry rebuild, pipeline/texture counts.
    let frameUpdateMs = 0, frameDrawMs = 0, slowFrame = null;
    const writeDataset = createDatasetWriter(canvas);
    const effectMeshes = new Map(), effectList = [];
    const shaderUniformEntries = shaderEffect ? Object.entries(shaderEffect.uniforms) : [];
    const shaderDefaults = selectedShader?.uniforms || {};
    const clock = () => (globalThis.performance?.now?.() ?? Date.now());
    let animatedMaterialCount = -1, viewportSignature = '', viewportJson = '';
    let styleFilter = null, styleRendering = null, frameRevision = 0;
    let lastRebuildMs = 0, rebuilds = 0;
    function clearColor(value) {
      let color = clearColors.get(value);
      if (!color) clearColors.set(value, color = new THREE.Color(value));
      return color;
    }
    // Animated world surfaces are only touched when their frame actually changed;
    // the old loop walked every cached material twice per frame.
    function materialsForAsset(assetId) {
      if (animatedMaterialCount !== materialCache.size) {
        animatedMaterials.clear(); animatedMaterialCount = materialCache.size;
        for (const material of materialCache.values()) {
          const list = animatedMaterials.get(material.userData.assetId);
          if (list) list.push(material); else animatedMaterials.set(material.userData.assetId, [material]);
        }
      }
      return animatedMaterials.get(assetId);
    }
    // Sprays are wall decals: a textured quad lying against the wall rather than a
    // billboard, so the artwork keeps its shape as the player walks past it.
    // Placement numbers for the first enemy sprites, reported through the playtest log.
    const report = [];
    const decalMaterials = new Map();
    function decalMaterial(assetId) {
      let material = decalMaterials.get(assetId);
      if (material) return material;
      material = withEffect(new THREE.MeshBasicNodeMaterial({
        map: imageTexture(assetId), transparent: true, alphaTest: .1, depthWrite: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      materials.add(material); decalMaterials.set(assetId, material);
      return material;
    }
    /** A spray is already clipped to its wall, so its quad is built from the corners. */
    function updateDecal(effect) {
      let entry = effectMeshes.get(effect.id);
      if (!entry) {
        const { corners, uv } = effect.decal;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.computeBoundingSphere();
        geometries.add(geometry);
        const object = new THREE.Mesh(geometry, decalMaterial(effect.decal.assetId));
        object.userData.decal = true;
        scene.add(object);
        entry = { id: effect.id, object, frame: undefined, revision: frameRevision };
        effectMeshes.set(effect.id, entry); effectList.push(entry);
      }
      entry.revision = frameRevision;
    }
    function updateEffect(effect, elapsed) {
      if (effect.decal) { updateDecal(effect); return; }
      const frame = spriteIndex.frame(effect.clipId, elapsed);
      // A clip may name artwork this level did not load; the pooled mesh keeps the
      // effect visible instead of failing the frame.
      const asset = frame.assetId ? assetMap.get(frame.assetId) : null;
      let entry = effectMeshes.get(effect.id);
      if (!entry) {
        const object = asset ? new THREE.Sprite(takeEffectMaterial('sprite', effect))
          : new THREE.Mesh(effect.radius ? impactGeometry : projectileGeometry, takeEffectMaterial('mesh', effect));
        scene.add(object);
        entry = { id: effect.id, object, frame: undefined, revision: frameRevision };
        effectMeshes.set(effect.id, entry); effectList.push(entry);
      }
      entry.revision = frameRevision;
      if (asset && entry.object.isSprite && entry.frame !== frame.assetId) {
        entry.object.material.map = imageTexture(frame.assetId);
        entry.object.scale.set(asset.width, asset.height, 1);
        if (Number.isFinite(asset.offsetX) && Number.isFinite(asset.offsetY))
          entry.object.center.set(asset.offsetX / asset.width, 1 - asset.offsetY / asset.height);
        entry.object.userData.frame = frame.assetId;
        entry.frame = frame.assetId;
      }
      entry.object.position.set(effect.x, effect.z, effect.y);
    }
    /** Draws each bound camera's view into its camera texture. */
    function renderCameraTextures(state) {
      if (!cameraViews.size || !state.cameraTextures?.size) return;
      for (const [name, binding] of state.cameraTextures) {
        const view = cameraViews.get(name);
        if (!view) continue;
        const subject = entityIndex.get(binding.cameraId) || state.entities.find(entity => entity.id === binding.cameraId);
        if (!subject) continue;
        // Materials are collected once per world build: swapping their map is a
        // uniform update, so the feed costs no recompile.
        if (view.materialsAt !== rebuilds || view.materials === null) {
          view.materials = [...materials].filter(material => material.userData.assetId === view.assetId ||
            material.map === view.sampled);
          view.materialsAt = rebuilds;
        }
        const write = view.targets[view.flip];
        const autoClear = renderer.autoClear;
        try {
          view.camera.fov = binding.fov || 90;
          view.camera.aspect = view.definition.width / view.definition.height;
          view.camera.updateProjectionMatrix();
          // A camera thing looks along its own angle; eye height matches the player.
          view.camera.position.set(subject.x, (subject.z ?? subject.elevation ?? 0) + 41, subject.y);
          view.camera.rotation.set(0, -subject.angle * Math.PI / 180, 0, 'YXZ');
          // The main pass leaves autoClear off, so the feed clears itself explicitly.
          renderer.autoClear = true;
          renderer.setClearColor(clearColor(project.environment.sky));
          renderer.setRenderTarget(write);
          renderer.render(scene, view.camera);
        } catch (error) {
          if (!view.error) { view.error = true; canvas.dataset.cameraTextureError = `${name}: ${error.message}`; }
          continue;
        } finally {
          renderer.setRenderTarget(null);
          renderer.autoClear = autoClear;
        }
        // The target just drawn is sampled from the next frame's main pass, and
        // the one it replaces is the surface the next camera pass draws into.
        view.sampled = write.texture;
        view.flip ^= 1;
        for (const material of view.materials) material.map = write.texture;
      }
    }

    function render(state, dt = 0) {
      const started = clock();
      renderFrame(state, dt);
      const elapsed = clock() - started;
      frameStats.push(elapsed);
      if (elapsed >= frameStats.stallMs) slowFrame = {
        ms: Math.round(elapsed), update: Math.round(frameUpdateMs), draw: Math.round(frameDrawMs),
        rebuild: Math.round(lastRebuildMs), rebuilds,
        programs: renderer.info.programs?.length ?? null,
        textures: renderer.info.memory?.textures ?? null, geometries: renderer.info.memory?.geometries ?? null,
        // A long pause with little update or draw work inside it is a collector pause,
        // so the heap size is part of the report (Chromium only, null elsewhere).
        heapMb: globalThis.performance?.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
      if (canvas.dataset.perfCounters === 'on') {
        writeDataset('frameMs', elapsed.toFixed(2));
        writeDataset('frameMaxMs', frameStats.max.toFixed(2));
        writeDataset('frameStalls', frameStats.stalls);
        // Splitting the frame into the scene update and the draw calls says which half
        // to optimise: thousands of tiny draw calls and a slow update look alike from
        // the total alone.
        writeDataset('frameUpdateMs', frameUpdateMs.toFixed(2));
        writeDataset('frameDrawMs', frameDrawMs.toFixed(2));
        writeDataset('worldRebuildMs', lastRebuildMs.toFixed(2));
        writeDataset('worldRebuilds', rebuilds);
        // Where the player is and how fast the movement model says they move, so a playtest can
        // be measured from outside the page instead of guessed at from a recording.
        writeDataset('playerPosition', `${state.player.x.toFixed(1)},${state.player.y.toFixed(1)},${(state.player.z ?? 0).toFixed(1)}`);
        writeDataset('playerSpeed', (state.speed ?? 0).toFixed(1));
        // Draw calls and GPU object counts: the numbers that explain a slow frame when
        // the triangle count looks small.
        writeDataset('drawCalls', renderer.info.render.calls);
        writeDataset('geometries', renderer.info.memory.geometries);
        writeDataset('textures', renderer.info.memory.textures);
        writeDataset('programs', renderer.info.programs?.length ?? 0);
      }
    }
    // The drawing buffer follows the Engine tweak instead of a fixed 800x450 frame,
    // so the game renders at the panel's real size (or a chosen preset) and only the
    // canvas element is scaled by CSS. The editor preview uses the same policy.
    // Reallocating the drawing buffer (and its depth/multisample targets) is far more
    // expensive than drawing a slightly wrong size, so a couple of pixels of wobble —
    // a scrollbar appearing, a fractional layout — must not trigger it every frame.
    const RENDER_SIZE_TOLERANCE = 8;
    let appliedWidth = 0, appliedHeight = 0;
    function resizeWorthwhile(width, height) {
      if (!appliedWidth || !appliedHeight) return true;
      return Math.abs(width - appliedWidth) > RENDER_SIZE_TOLERANCE || Math.abs(height - appliedHeight) > RENDER_SIZE_TOLERANCE;
    }
    // Reading the canvas box every frame forces a synchronous layout right after the HUD
    // and the message have written to the DOM, which is a large part of the per-frame
    // cost. A ResizeObserver reports the same numbers without the layout flush.
    let cssWidth = 0, cssHeight = 0;
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(entries => {
        const box = entries[entries.length - 1]?.contentRect;
        if (box) { cssWidth = box.width; cssHeight = box.height; }
      });
      observer.observe(canvas);
      disposers.push(() => observer.disconnect());
    }
    function canvasCssSize() {
      if (cssWidth && cssHeight) return { width: cssWidth, height: cssHeight };
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width; cssHeight = rect.height;
      return { width: cssWidth, height: cssHeight };
    }
    function applyRenderSize(settings) {
      const box = canvasCssSize();
      const size = renderBufferSize({
        resolution: settings?.renderResolution,
        scale: settings?.resolution,
        lowDetail: settings?.lowDetail,
        cssWidth: box.width || canvas.clientWidth,
        cssHeight: box.height || canvas.clientHeight,
        devicePixelRatio: globalThis.devicePixelRatio || 1,
        maxSize: Math.min(4096, renderer.backend?.device?.limits?.maxTextureDimension2D || 4096),
      });
      const key = `${size.width}x${size.height}`;
      if (appliedResolution !== key && resizeWorthwhile(size.width, size.height)) {
        appliedResolution = key;
        appliedWidth = size.width; appliedHeight = size.height;
        renderer.setSize(size.width, size.height, false);
        writeDataset('renderResolution', key);
      }
      const rendering = size.pixelated ? 'pixelated' : '';
      if (styleRendering !== rendering) { styleRendering = rendering; canvas.style.imageRendering = rendering; }
      return size;
    }
    function renderFrame(state, dt) {
      const frameStarted = clock();
      if (state.settings) {
        applyRenderSize(state.settings);
        if (!editor) {
          const filter = `brightness(${state.settings.brightness})`;
          if (styleFilter !== filter) { styleFilter = filter; canvas.style.filter = filter; }
        }
      } else applyRenderSize(null);
      effectTime.value = Number.isFinite(state.time) ? state.time : 0;
      effectEnabled.value = state.shaderEnabled === false ? 0 : 1;
      for (let index = 0; index < shaderUniformEntries.length; index++) {
        const entry = shaderUniformEntries[index];
        const value = state.shaderUniforms instanceof Map ? state.shaderUniforms.get(entry[0]) : state.shaderUniforms?.[entry[0]];
        entry[1].value = Number.isFinite(value) && Math.abs(value) <= 1e20 ? value : shaderDefaults[entry[0]];
      }
      writeDataset('shaderEnabled', Boolean(shaderEffect) && state.shaderEnabled !== false);
      if (!editor && project.materialAnimations) for (let index = 0; index < project.materialAnimations.length; index++) {
        const animation = project.materialAnimations[index];
        const frame = spriteIndex.frame(animation.clipId, state.time + animation.offset);
        if (!frame.assetId) continue;
        const list = materialsForAsset(animation.assetId);
        if (!list) continue;
        for (let entry = 0; entry < list.length; entry++) {
          const material = list[entry];
          if (material.userData.frameAsset === frame.assetId) continue;
          material.userData.frameAsset = frame.assetId;
          material.map = imageTexture(frame.assetId);
        }
      }
      if (!editor && worldRevision !== state.worldRevision) {
        const rebuildStarted = clock();
        const changed = new Set();
        for (const sector of geometry) {
          const key = `${sector.floorHeight}/${sector.ceilingHeight}`;
          if (sectorHeights.get(sector.id) !== key) { changed.add(sector.id); sectorHeights.set(sector.id, key); }
        }
        for (const entry of worldParts) if (entry.sectorIds.some(id => changed.has(id))) rebuildPart(entry);
        flushBatches();
        worldRevision = state.worldRevision;
        lastRebuildMs = clock() - rebuildStarted; rebuilds++;
      }
      ceilingCut.value = ceilingsHidden ? camera.position.y + 2 : -1e30;
      renderer.info.reset();
      if (!editor) {
        const detail = state.settings.lowDetail ? 2 : 1;
        const view = gameView(project.hud || { width: 320, height: 200 }, state.settings,
          canvas.width * detail, canvas.height, state.hud);
        const inset = view.inset;
        const viewX = view.x / detail, viewWidth = view.width / detail;
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, canvas.width, canvas.height);
        renderer.setClearColor(clearColor('#272a2e')); renderer.clear();
        // The shared WebGPU/WebGL renderer uses a top-left viewport origin.
        renderer.setViewport(viewX, view.y, viewWidth, view.height);
        // The scissor test is only turned on for a view that really is smaller than the
        // drawing buffer. Three never re-applies a scissor rectangle that covers the whole
        // buffer (it compares it with the screen and leaves the context alone), yet turning
        // the test on still enables it with whatever box the context last held — the 800x450
        // of the renderer's construction size. That clipped the world to a corner of the
        // preview and left the clear colour around it.
        if (viewNeedsScissor(view, canvas.width, canvas.height, detail)) {
          renderer.setScissor(viewX, view.y, viewWidth, view.height);
          renderer.setScissorTest(true);
        }
        const signature = `${view.x}/${view.y}/${view.width}/${view.height}/${inset}`;
        if (viewportSignature !== signature) { viewportSignature = signature; viewportJson = JSON.stringify(view); }
        writeDataset('hudInset', inset);
        writeDataset('gameViewport', viewportJson);
        const aspect = view.width / view.height;
        if (camera.aspect !== aspect || camera.fov !== state.settings.fov) {
          camera.aspect = aspect; camera.fov = state.settings.fov; camera.updateProjectionMatrix();
        }
        let selected = project.environment.weaponAssets
          ? project.environment.weaponAssets[state.inventory.selectedWeapon] : project.environment.weaponAsset;
        const weaponAnimation = state.weaponAnimations.get(state.inventory.selectedWeapon);
        if (weaponAnimation) {
          const frame = spriteIndex.frame(weaponAnimation.clipId, state.time - weaponAnimation.start);
          if (frame.assetId && !frame.finished) selected = frame.assetId;
        }
        writeDataset('weaponFrame', selected || '');
        for (const [id, overlay] of weaponOverlays) overlay.visible = id === selected;
        const recoil = state.lastShot && state.time - state.lastShot.time < .12 ? 6 * (1 - (state.time - state.lastShot.time) / .12) : 0;
        // Doom swings the weapon with the player's speed: x on a cosine and y on a sine of the
        // bob timer, in psprite pixels, so a walk rocks the gun the way GZDoom's does.
        const swing = weaponBob(state.bob || 0, state.bobTimer || 0);
        for (const overlay of weaponOverlays.values()) {
          overlay.userData.restX ??= overlay.position.x;
          overlay.userData.restY ??= overlay.position.y;
          overlay.position.x = overlay.userData.restX + swing.x;
          // The psprite's y grows downwards; the overlay scene's grows upwards.
          overlay.position.y = overlay.userData.restY - recoil - swing.y;
        }
        // Where the drawn weapon actually ended up, so a bob can be checked from outside.
        const shownWeapon = weaponOverlays.get(selected);
        if (shownWeapon) writeDataset('weaponPosition',
          `${shownWeapon.position.x.toFixed(2)} ${shownWeapon.position.y.toFixed(2)}`);
        writeDataset('weapon', state.inventory.selectedWeapon);
        // Player state for measurement: the GZDoom harness reports the same numbers, so what
        // the browser actually does can be compared with what the trace says it should do.
        writeDataset('player', `${state.player.x.toFixed(2)} ${state.player.y.toFixed(2)} `
          + `${(state.player.z ?? 0).toFixed(2)} ${state.player.angle.toFixed(4)}`);
        writeDataset('momentum', `${(state.momentum?.x ?? 0).toFixed(3)} ${(state.momentum?.y ?? 0).toFixed(3)} `
          + `${(state.momentum?.z ?? 0).toFixed(3)} ${state.physics?.grounded ? 'grounded' : 'airborne'} `
          + `bob=${(state.bob ?? 0).toFixed(2)} timer=${state.bobTimer ?? 0}`);
      }
      // The eye and the look direction come from the player's own up axis, so an
      // event that turns gravity onto a wall also turns the view onto that wall.
      if (!editor) {
        const up = upVector(state.player.up);
        const eye = eyePosition(state.player, state.player.z ??
          sectorOf(state.player)?.floorHeight ?? 0);
        // The view rises and falls as the player walks, which is half of what makes Doom's
        // movement read as movement rather than gliding.
        eye[2] += viewBob(state.bob || 0, state.bobTimer || 0);
        const direction = viewDirection(state.player);
        camera.position.set(eye[0], eye[2], eye[1]);
        // Roll eases in: a gravity change should read as the world turning, not a cut.
        viewUp.lerp(targetUp.set(up[0], up[2], up[1]), dt > 0 ? 1 - Math.exp(-12 * dt) : 1);
        if (viewUp.lengthSq() < 1e-8) viewUp.copy(targetUp); else viewUp.normalize();
        camera.up.copy(viewUp);
        camera.lookAt(eye[0] + direction[0], eye[2] + direction[2], eye[1] + direction[1]);
      }

      lightRadii.fill(0);
      for (let index = 0; index < lightColors.length; index++) lightColors[index].setRGB(0, 0, 0);
      for (let index = 0; index < lightNodes.length; index++) lightNodes[index].radius.value = 0;
      activeLights.length = 0;
      for (let index = 0; index < state.entities.length && activeLights.length < 16; index++) {
        const entity = state.entities[index];
        if (entity.type === 'light' && entity.light) activeLights.push(entity);
      }
      for (let index = 0; index < activeLights.length; index++) {
        const entity = activeLights[index];
        const z = entity.z ?? sectorOf(entity)?.floorHeight ?? 0;
        lightPositions[index].set(entity.x, z + 48, entity.y);
        lightColors[index].set(entity.light.color).multiplyScalar(entity.light.intensity);
        lightRadii[index] = entity.light.radius;
        lightNodes[index].radius.value = entity.light.radius;
        const light = pointLights[index];
        if (light) {
          light.position.copy(lightPositions[index]); light.color.set(entity.light.color);
          light.intensity = entity.light.intensity * 25; light.distance = entity.light.radius; light.decay = 1;
        }
      }
      for (let index = activeLights.length; index < pointLights.length; index++) pointLights[index].intensity = 0;
      entityIndex.clear();
      for (let index = 0; index < state.entities.length; index++) {
        const entity = state.entities[index];
        entityIndex.set(entity.id, entity);
        if (entity.type === 'player' && !editor) continue;
        if (unrenderable.has(entity.id)) continue;
        if (entity.modelAsset ? !models.has(entity.id) : !sprites.has(entity.id)) addEntity(entity);
      }
      for (let index = 0; index < modelList.length; index++) {
        const entry = modelList[index];
        const entity = entityIndex.get(entry.id);
        if (entry.root.visible !== Boolean(entity)) entry.root.visible = Boolean(entity);
        if (!entity) continue;
        if (editor) entry.object.scale.setScalar(entity.modelScale ?? 32);
        const sector = sectorOf(entity);
        entry.root.position.set(entity.x, entity.z ?? (sector?.floorHeight || 0) + (entity.elevation || 0), entity.y);
        // Yaw, model tilt and a physics rotation all compose into one quaternion, so a
        // model can be tilted or stood on its head without affecting its facing.
        if (entity.rotation || entity.modelTilt) entry.root.quaternion.fromArray(modelOrientation(entity));
        else entry.root.rotation.set(0, -entity.angle * Math.PI / 180, 0);
        applyModelTexture(entry, entity);
        // Doom light levels still tint a model, but a dark room must not erase it.
        const shade = Math.max(MODEL_LIGHTING.ambientFloor, (sector?.light ?? 255) / 255);
        if (entry.shade !== shade) {
          entry.shade = shade;
          for (let tint = 0; tint < entry.tinted.length; tint++) {
            const material = entry.tinted[tint];
            material.color.copy(material.userData.baseColor).multiplyScalar(shade);
          }
        }
        const requested = state.animations.get(entry.id);
        if (requested && requested.revision !== entry.revision) {
          entry.mixer.stopAllAction(); entry.revision = requested.revision;
          if (requested.playing) {
            const clip = entry.clips.find(clip => clip.name === requested.clip);
            if (!clip) throw new Error(`Model clip ${requested.clip} is missing`);
            const action = entry.mixer.clipAction(clip);
            action.setLoop(requested.loop ? THREE.LoopRepeat : THREE.LoopOnce, requested.loop ? Infinity : 1);
            action.clampWhenFinished = !requested.loop; action.timeScale = requested.speed; action.reset().play();
            entry.action = action;
          } else entry.action = null;
        }
        if (entry.action) entry.mixer.update(Math.min(.05, dt));
      }
      for (let index = 0; index < panelList.length; index++) {
        const entry = panelList[index];
        const entity = entityIndex.get(entry.id);
        if (entry.mesh.visible !== Boolean(entity)) entry.mesh.visible = Boolean(entity);
        if (!entity) continue;
        const sector = sectorOf(entity);
        const anchor = entity.z ?? (sector?.floorHeight || 0) + (entity.elevation || 0);
        entry.mesh.position.set(entity.x, anchor + entity.panel.height / 2, entity.y);
        if (entity.rotation) entry.mesh.quaternion.fromArray(modelOrientation(entity));
        else entry.mesh.rotation.set(0, -entity.angle * Math.PI / 180, 0);
      }
      for (let index = 0; index < colliderBoxList.length; index++) {
        const entry = colliderBoxList[index], entity = entityIndex.get(entry.id);
        entry.mesh.visible = Boolean(entity);
        if (!entity) continue;
        const box = solidBoxFor(entity);
        const floor = sectorOf(entity)?.floorHeight || 0;
        const bottom = entity.z ?? floor + (entity.elevation || 0);
        entry.mesh.position.set(entity.x, box.wedge ? bottom : bottom + box.height / 2, entity.y);
        // The collider's own orientation, tilt included, so the slope drawn is the slope
        // walked on.
        const [qx, qy, qz, qw] = modelOrientation(entity);
        entry.mesh.quaternion.set(qx, qy, qz, qw);
        const light = Math.max(.03, (sector?.light ?? 255) / 255);
        applyBoxTexture(entry.mesh.material, entity, box);
        const tint = entity.spriteAsset ? '#ffffff' : entityColors[entity.type] || '#a6a4bc';
        entry.mesh.material.color.setRGB(light, light, light).multiply(new THREE.Color(tint));
      }
      for (let index = 0; index < spriteList.length; index++) {
        const record = spriteList[index], sprite = record.sprite;
        const entity = entityIndex.get(record.id);
        if (sprite.visible !== Boolean(entity)) sprite.visible = Boolean(entity);
        if (!entity) continue;
        let assetId, flip;
        if (editor) { assetId = entity.spriteAsset; flip = false; }
        else { const view = spriteIndex.view(state, entity, state.player); assetId = view.assetId; flip = view.flip; }
        const scale = entity.spriteScale || 1;
        if (record.frame !== assetId || record.flip !== flip || record.scale !== scale) {
          const asset = assetMap.get(assetId);
          if (record.frame !== assetId) sprite.material.map = assetId ? imageTexture(assetId) : null;
          sprite.scale.set((asset?.width || 24) * scale * (flip ? -1 : 1), (asset?.height || 40) * scale, 1);
          // The artwork's own left/top offsets place it: the sprite quad is kept centred
          // on its position and the offsets are applied to that position instead of to
          // `sprite.center`. Center-based offsets are a shader feature, and a sprite that
          // silently falls back to the default centre is drawn half-sunk in the floor —
          // which is exactly how imported monsters looked.
          sprite.center.set(.5, .5);
          // An artwork without a vertical offset is bottom-anchored, which is what an
          // imported image gets: `offsetY || height` keeps that instead of centring it.
          const artworkOffsetY = asset ? asset.offsetY || asset.height || 40 : 40;
          sprite.userData.shift = spriteAnchor({ width: Math.abs((asset?.width || 24) * scale),
            height: (asset?.height || 40) * scale, offsetX: (asset?.offsetX || 0) * scale,
            offsetY: artworkOffsetY * scale });
          sprite.userData.assetHeight = asset?.height || 40;
          sprite.userData.offsetY = artworkOffsetY * scale;
          sprite.userData.frame = assetId; sprite.userData.flip = flip;
          record.frame = assetId; record.flip = flip; record.scale = scale;
        }
        const sector = sectorOf(entity);
        const anchor = entity.z ?? (sector?.floorHeight || 0) + (entity.elevation || 0);
        const height = sprite.scale.y;
        const offsetY = sprite.userData.offsetY || 0;
        const shift = sprite.userData.shift || { dx: 0, dy: 0 };
        sprite.position.set(entity.x + shift.dx, anchor + shift.dy, entity.y);
        // Report the first enemy sprites so a log can answer "why is it drawn buried"
        // with the real numbers instead of a guess.
        if (sector && !editor && report.length < 4 && entity.type === 'enemy') report.push({
          name: entity.name, id: entity.id, asset: assetMap.get(assetId)?.name || assetId || '(none)',
          assetHeight: sprite.userData.assetHeight, offsetY: Math.round(offsetY * 100) / 100,
          scaleY: height, centreY: sprite.center.y, positionY: Math.round(sprite.position.y * 100) / 100,
          anchor: Math.round(anchor * 100) / 100, z: entity.z, floor: sector.floorHeight, sector: sector.id,
          elevation: entity.elevation, drawnBottom: Math.round((sprite.position.y - height / 2) * 100) / 100,
        });
        let red = Math.max(.03, (sector?.light ?? 255) / 255), green = red, blue = red;
        for (let light = 0; light < activeLights.length; light++) {
          const dx = sprite.position.x - lightPositions[light].x;
          const dy = sprite.position.y - lightPositions[light].y;
          const dz = sprite.position.z - lightPositions[light].z;
          const amount = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / activeLights[light].light.radius);
          if (!amount) continue;
          const falloff = amount * amount;
          red += lightColors[light].r * falloff;
          green += lightColors[light].g * falloff;
          blue += lightColors[light].b * falloff;
        }
        if (record.red !== red || record.green !== green || record.blue !== blue) {
          record.red = red; record.green = green; record.blue = blue;
          const base = baseColorFor(entity);
          sprite.material.color.setRGB(base.r * red, base.g * green, base.b * blue);
        }
      }
      frameRevision++;
      if (state.projectiles) for (let index = 0; index < state.projectiles.length; index++) {
        const projectile = state.projectiles[index];
        updateEffect(projectile, projectile.start === undefined ? projectile.age : state.time - projectile.start);
      }
      if (state.impacts) for (let index = 0; index < state.impacts.length; index++) {
        const impact = state.impacts[index];
        updateEffect(impact, state.time - impact.start);
      }
      for (let index = effectList.length - 1; index >= 0; index--) {
        const entry = effectList[index];
        if (entry.revision === frameRevision) continue;
        scene.remove(entry.object);
        // Decals own a geometry clipped to their wall and reuse an asset material, so
        // neither is pooled; the geometry is released with the effect.
        if (entry.object.userData.decal) { geometries.delete(entry.object.geometry); entry.object.geometry.dispose(); }
        else effectPools[entry.object.isMesh ? 'mesh' : 'sprite'].push(entry.object.material);
        effectMeshes.delete(entry.id);
        effectList.splice(index, 1);
      }
      frameUpdateMs = clock() - frameStarted;
      const drawStarted = clock();
      renderCameraTextures(state);
      applySky(state);
      if (backgroundScene.userData.skybox) backgroundScene.userData.skybox.position.copy(camera.position);
      else {
        const panorama = backgroundScene.userData.panorama;
        if (panorama) {
          const view = skyView({ editor, direction: camera.getWorldDirection(cameraDirection), player: state.player });
          panorama.userData.panoramaUniforms.heading.value = view.heading;
          panorama.userData.panoramaUniforms.pitch.value = view.pitch;
          panorama.userData.panoramaUniforms.aspect.value = camera.aspect;
          panorama.userData.panoramaUniforms.fieldOfView.value = Math.tan(camera.fov * Math.PI / 360);
        }
      }
      // The sky and the world, drawn in one go. Effects that read the screen run it into
      // a render target first, with themselves hidden, so they refract the level behind.
      const drawWorld = () => {
        renderer.autoClear = true;
        renderer.setClearColor(clearColor(project.environment.sky));
        renderer.render(backgroundScene, backgroundScene.userData.skybox ? camera : backgroundCamera);
        renderer.autoClear = false;
        // Preserve the rendered sky; only opaque world surfaces write depth/color.
        const background = scene.background; scene.background = null;
        renderer.clearDepth(); renderer.render(scene, camera); scene.background = background;
      };
      renderer.getDrawingBufferSize(screenSize);
      effectResolution.value.set(screenSize.x, screenSize.y);
      drawWorld();
      // Captured for the next frame: sampling a target written in the same pass leaves the
      // strip with no fragment output, which is what made the curtain invisible.
      if (needsScreenPass()) {
        const size = screenSize;
        if (screenTarget.width !== size.x || screenTarget.height !== size.y) screenTarget.setSize(size.x, size.y);
        const hidden = [];
        for (const object of screenObjects) if (object.visible) { hidden.push(object); object.visible = false; }
        renderer.setRenderTarget(screenTarget);
        drawWorld();
        renderer.setRenderTarget(null);
        for (const object of hidden) object.visible = true;
      }
      renderer.clearDepth(); renderer.render(overlayScene, overlayCamera);
      renderer.setScissorTest(false);
      if (shaderCompileError) throw new Error(`GPU shader compilation failed: ${shaderCompileError}`);
      writeDataset('rendered', 'true');
      writeDataset('triangles', renderer.info.render.triangles);
      writeDataset('physics', editor ? 'disabled-editor' : 'rapier');
      writeDataset('modelCount', models.size);
      writeDataset('animationTime', modelList[0]?.action?.time || 0);
      writeDataset('projectiles', state.projectiles?.length || 0);
      writeDataset('worldRevision', state.worldRevision || 0);
      frameDrawMs = clock() - drawStarted;
    }
    /**
     * Compile every pipeline before the first frame. `compileAsync` projects the
     * scene exactly like rendering does, so on its own it only builds what the spawn
     * camera can see and skips anything hidden — which left the rest of a big map to
     * compile the first time the player looked at it, a multi-second freeze mid-game.
     * Culling and visibility are forced off for the warm-up and restored afterwards.
     */
    const warmEverything = async () => {
      const unculled = uncullDrawables([scene, warmupScene, backgroundScene, overlayScene]);
      const hidden = revealForWarmup(weaponOverlays.values());
      try {
        await renderer.compileAsync(scene, camera);
        // Compiling the projectile templates here is what keeps the first shot from
        // freezing the tab while the GPU driver links a brand new pipeline.
        await renderer.compileAsync(warmupScene, camera);
        if (backgroundScene.children.length) await renderer.compileAsync(backgroundScene, backgroundScene.userData.skybox ? camera : backgroundCamera);
        if (overlayScene.children.length) await renderer.compileAsync(overlayScene, overlayCamera);
      } finally {
        restoreCulling(unculled);
        restoreVisibility(hidden);
      }
    };
    await warmEverything();
    if (shaderCompileError) throw new Error(`GPU shader compilation failed: ${shaderCompileError}`);
    // Live editor updates: rebuild the world in place, keeping the GPU device,
    // decoded textures and compiled programs. Recreating the preview instead
    // costs seconds per edit (context + texture upload + shader compile).
    function setProject(next) {
      if (!editor) return false;
      const required = new Set();
      for (const sector of next.map.sectors || []) { required.add(sector.floorAsset); required.add(sector.ceilingAsset); }
      for (const wall of next.map.walls || []) for (const side of [wall.right, wall.left]) if (side) {
        required.add(side.upper); required.add(side.middle); required.add(side.lower);
      }
      required.add(next.environment?.skyAsset);
      for (const id of required) if (id && !textures.has(id)) return false; // new artwork needs a full reload
      // Models are parsed before the first frame, so a newly assigned one needs the
      // same full reload instead of silently staying a sprite forever.
      const plan = liveProjectPlan(next.map.entities, {
        hasModel: id => modelAssets.has(id),
        drawn: id => (models.has(id) ? 'model' : panels.has(id) ? 'panel' : sprites.has(id) ? 'sprite' : null),
        drawnModel: id => models.get(id)?.assetId,
      });
      if (plan.needsReload) return false;
      project = next;
      assetMap = new Map((project.assets || []).map(asset => [asset.id, asset]));
      geometry = sectorGeometry(project);
      const nextInputs = JSON.stringify([project.environment, project.shaders || []]);
      if (nextInputs !== worldInputs) {
        worldInputs = nextInputs;
        for (const entry of worldPartKeys.values()) entry.signature = null;
        // Environment edits (sky image, skybox, mode) show up without a reload.
        buildSky(project.environment);
      }
      // buildStaticWorld keeps every part whose signature still matches, so a
      // single edited wall or sector costs one rebuild instead of the whole map.
      buildStaticWorld();
      flushBatches();
      canvas.dataset.worldParts = `${rebuiltParts}/${worldParts.length}`;
      canvas.dataset.batches = String(batchMeshes.size);
      sectorIndex = createSectorIndex(geometry);
      spriteIndex = createSpriteIndex(project);
      sectorHeights = new Map(geometry.map(sector => [sector.id, `${sector.floorHeight}/${sector.ceilingHeight}`]));
      scene.background = new THREE.Color(project.environment.sky);
      // Objects that gained or lost their model swap representation, and new objects
      // appear without a reload. Runtime spawns are handled by the frame loop.
      const byId = new Map(project.map.entities.map(entity => [entity.id, entity]));
      for (const id of plan.swap) forgetEntity(id);
      for (const id of plan.add) addEntity(byId.get(id));
      return true;
    }
    return { render, dispose, scene, camera, renderer, rendererStatus, setProject, boundsOfEntity,
      /** Editor only: hide a ceiling once the camera is above it, so rooms open up. */
      ceilings(visible) { ceilingsHidden = !visible; },
      spriteReport: () => ({ player: { x: Math.round(state.player.x), y: Math.round(state.player.y),
        z: Math.round((state.player.z ?? 0) * 10) / 10, pitch: Math.round((state.player.pitch || 0) * 1000) / 1000 },
      sprites: report.slice(), withoutArtwork: withoutArtwork.slice(), hiddenWithoutArtwork: unrenderable.size }),
      perf: () => ({ ...frameStats.summary(), slowFrame }) };
  } catch (error) {
    dispose();
    throw new Error(`Preview could not load: ${error.message}`);
  }
}
