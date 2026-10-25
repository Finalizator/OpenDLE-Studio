import * as THREE from 'three/webgpu';
import { uniform, vec2, vec3, vec4, materialColor, positionWorld, positionGeometry, output, uv, texture, sin, cos, tan, atan, cross, normalize, length, clamp, mix } from 'three/tsl';
import { createBrowserRenderer } from './renderer-backend.js';
import { compileGLSLEffect } from './shader-effects.js';
import { validateShaders } from '/shared/shaders.js';
import { sectorGeometry, sectorAt, sectorShapes } from '/shared/sectors.js';
import { wallSegments } from '/shared/runtime.js';
import { GLTFLoader } from '/vendor/three-addons/loaders/GLTFLoader.js';
import { clone as cloneModel } from '/vendor/three-addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from '/vendor/three-addons/environments/RoomEnvironment.js';
import RAPIER from '/vendor/rapier/rapier.mjs';
import { createPhysics } from '/shared/physics.js';
import { decodeDataURI, readModel, validateModelDocument } from '/shared/gltf.js';
import { hudViewport } from '/shared/hud.js';
import { clipFrame, spriteView } from '/shared/sprite-animation.js';

export const entityColors = { player: '#70ddba', enemy: '#ed8b83', pickup: '#efd17a', light: '#a9beff', decoration: '#a6a4bc' };
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
  const geometry = editor ? sectorGeometry(project) : state.sectors;
  const textures = new Map(), assetMap = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const materials = new Set(), geometries = new Set();
  const lightPositions = Array.from({ length: 16 }, () => new THREE.Vector3());
  const lightColors = Array.from({ length: 16 }, () => new THREE.Color(0));
  const lightRadii = new Float32Array(16);
  const lightNodes = lightPositions.map((position, index) => ({
    position: uniform(position), color: uniform(lightColors[index]), radius: uniform(0),
  }));
  const effectTime = uniform(0), effectEnabled = uniform(1);
  let shaderEffect = null;
  function withEffect(material) {
    if (!shaderEffect) return material;
    const result = renderer.library.fromMaterial(material);
    if (!result) throw new Error(`Shader effects do not support material ${material.type}`);
    result.outputNode = mix(output, shaderEffect.effect(output, uv(), effectTime), effectEnabled);
    return result;
  }
  const loader = new THREE.TextureLoader();
  let physics = null, environmentTarget = null;
  const models = new Map(), mixers = new Set(), pointLights = [];
  const projectileMeshes = new Map();
  const backgroundScene = new THREE.Scene(), backgroundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const overlayScene = new THREE.Scene(), overlayCamera = new THREE.OrthographicCamera(0, 320, 200, 0, -1, 1);
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const object of projectileMeshes.values()) { if (object.isMesh) object.geometry.dispose(); object.material.dispose(); }
    projectileMeshes.clear();
    physics?.dispose(); state.physics = null;
    mixers.forEach(mixer => mixer.stopAllAction());
    scene.traverse(object => { if (object.isSkinnedMesh) object.skeleton.dispose(); });
    environmentTarget?.dispose();
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
      try { shaderEffect = compileGLSLEffect(selectedShader); }
      catch (error) { canvas.dataset.shaderError = error.message; throw new Error(`Shader ${selectedShader.name}: ${error.message}`); }
    }
    canvas.dataset.shaderId = selectedShader?.id || '';
    canvas.dataset.shaderError = '';
    // Load sequential batches to bound temporary decoded-image memory.
    const assets = (project.assets || []).filter(asset => !['model', 'font', 'sound'].includes(asset.kind));
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
    const manager = new THREE.LoadingManager();
    const resourceErrors = new Set();
    manager.onError = url => resourceErrors.add(url);
    manager.setURLModifier(url => {
      if (!url.startsWith('data:') && !url.startsWith('blob:')) throw new Error('Model attempted to load a non-embedded resource');
      return url;
    });
    const modelLoader = new GLTFLoader(manager);
    const modelAssets = new Map();
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
    }
    if (usedModels.size) {
      const room = new RoomEnvironment(), generator = new THREE.PMREMGenerator(renderer);
      environmentTarget = generator.fromScene(room, .04);
      scene.environment = environmentTarget.texture;
      room.dispose(); generator.dispose();
      scene.add(new THREE.HemisphereLight('#ffffff', '#505968', 2));
      for (let i = 0; i < 16; i++) { const light = new THREE.PointLight('#ffffff', 0); scene.add(light); pointLights.push(light); }
    }
    let worldGroup = null;
    const worldParts = [];
    function worldPart(sectorIds, build) {
      const entry = { sectorIds, build, group: null };
      worldParts.push(entry);
      rebuildPart(entry);
    }
    function rebuildPart(entry) {
      if (entry.group) {
        scene.remove(entry.group);
        entry.group.traverse(object => { if (object.geometry) { geometries.delete(object.geometry); object.geometry.dispose(); } });
      }
      entry.group = new THREE.Group(); scene.add(entry.group);
      worldGroup = entry.group; entry.build(); worldGroup = null;
    }
    function mesh(buffer, material, destination = worldGroup || scene) {
      geometries.add(buffer); materials.add(material);
      const result = new THREE.Mesh(buffer, material);
      destination.add(result);
      return result;
    }
    const materialCache = new Map();
    function material(assetId, level, color = '#ffffff', masked = false, oneSided = false) {
      const key = `${assetId}/${level}/${color}/${masked}/${oneSided}`;
      if (materialCache.has(key)) return materialCache.get(key);
      const result = withEffect(new THREE.MeshBasicNodeMaterial({
        map: textures.get(assetId) || null, color: assetId ? '#ffffff' : color,
        side: oneSided ? THREE.FrontSide : THREE.DoubleSide, alphaTest: masked ? .5 : 0,
      }));
      result.userData.assetId = assetId;
      let illumination = vec3(Math.max(.03, level / 255));
      for (const light of lightNodes) {
        const falloff = positionWorld.distance(light.position).div(light.radius.max(1)).oneMinus().max(0);
        illumination = illumination.add(light.color.mul(falloff.mul(falloff)));
      }
      result.colorNode = vec4(materialColor.rgb.mul(illumination.min(vec3(2))), materialColor.a);
      materials.add(result); materialCache.set(key, result);
      return result;
    }
    function plane(sector, height, assetId, ceiling) {
      for (const shape of sectorShapes(sector.rings)) {
        const outer = shape.outer.map(vertex => new THREE.Vector2(vertex.x, vertex.y));
        const holes = shape.holes.map(ring => ring.map(vertex => new THREE.Vector2(vertex.x, vertex.y)));
        const indices = THREE.ShapeUtils.triangulateShape(outer, holes).flat();
        const points = [...outer, ...holes.flat()];
        const positions = [], uv = [];
        const asset = assetMap.get(assetId), tw = asset?.width || 64, th = asset?.height || 64;
        for (const point of points) { positions.push(point.x, height, point.y); uv.push(point.x / tw, point.y / th); }
        const buffer = new THREE.BufferGeometry();
        buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        buffer.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); buffer.setIndex(indices);
        buffer.computeBoundingSphere();
        const surface = mesh(buffer, material(assetId, sector.light, ceiling ? '#6d7680' : project.environment.floor));
        if (sector.id) surface.userData.selection = { kind: 'sector', id: sector.id, surface: ceiling ? 'ceilingHeight' : 'floorHeight' };
        if (editor && ceiling) surface.visible = false;
      }
    }
    for (const sector of geometry) worldPart([sector.id], () => {
      if (sector.ceilingHeight <= sector.floorHeight) return;
      plane(sector, sector.floorHeight, sector.floorAsset, false);
      if (!sector.sky) plane(sector, sector.ceilingHeight, sector.ceilingAsset, true);
    });
    function wallQuad(wall, a, b, bottom, top, assetId, side, light, referenceTop, masked = false) {
      if (top <= bottom) return;
      const length = Math.hypot(b.x - a.x, b.y - a.y), asset = assetMap.get(assetId);
      const tw = asset?.width || 64, th = asset?.height || 64;
      const x = side?.offsetX || 0, y = side?.offsetY || 0;
      const u0 = x / tw, u1 = (x + length) / tw;
      const v0 = 1 - (referenceTop - bottom + y) / th, v1 = 1 - (referenceTop - top + y) / th;
      const buffer = new THREE.BufferGeometry();
      buffer.setAttribute('position', new THREE.Float32BufferAttribute([a.x, bottom, a.y, b.x, bottom, b.y, b.x, top, b.y, a.x, top, a.y], 3));
      buffer.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
      buffer.setIndex([0, 1, 2, 0, 2, 3]); buffer.computeBoundingSphere();
      const surface = mesh(buffer, material(assetId, light, wall.color, masked, !editor));
      surface.userData.selection = { kind: 'wall', id: wall.id };
    }
    const sectorMap = new Map(geometry.map(sector => [sector.id, sector]));
    for (const wall of wallSegments(project)) worldPart([wall.right?.sectorId, wall.left?.sectorId], () => {
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
    if (!geometry.length) {
      const fallback = { rings: [[{ x: -20000, y: -20000 }, { x: 20000, y: -20000 }, { x: 20000, y: 20000 }, { x: -20000, y: 20000 }]], light: 255 };
      plane(fallback, 0, null, false);
    }
    const skyAsset = assetMap.get(project.environment.skyAsset);
    if (project.environment.skybox) {
      const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(face => {
        const result = new THREE.MeshBasicMaterial({ map: textures.get(project.environment.skybox[face]), side: THREE.BackSide, depthWrite: false });
        materials.add(result); return result;
      });
      const box = new THREE.BoxGeometry(20000, 20000, 20000);
      const sky = new THREE.Mesh(box, faces); geometries.add(box); backgroundScene.add(sky);
      backgroundScene.userData.skybox = sky;
    } else if (skyAsset) {
      const heading = uniform(0), pitch = uniform(0), aspect = uniform(800 / 450);
      const fieldOfView = uniform(Math.tan(35 * Math.PI / 180));
      const p = uv().mul(2).sub(1).mul(fieldOfView);
      const forward = vec3(cos(pitch).mul(cos(heading)), sin(pitch), cos(pitch).mul(sin(heading)));
      const right = vec3(sin(heading).negate(), 0, cos(heading));
      const ray = normalize(forward.add(right.mul(p.x).mul(aspect)).add(cross(right, forward).mul(p.y)));
      const doom = project.environment.skyMode === 'doom';
      const u = atan(ray.z, ray.x).div(6.2831853).mul(doom ? 4 : 1);
      const elevation = atan(ray.y, length(ray.xz));
      const v = doom ? clamp(tan(clamp(elevation, -1.4, 1.4)).mul(.65).add(.5), .001, .999) : elevation.div(Math.PI).add(.5);
      const backgroundMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      backgroundMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
      backgroundMaterial.fragmentNode = texture(textures.get(skyAsset.id), vec2(u, v));
      backgroundMaterial.userData.panoramaUniforms = { heading, pitch, aspect, fieldOfView };
      mesh(new THREE.PlaneGeometry(2, 2), backgroundMaterial, backgroundScene);
      backgroundScene.userData.panorama = backgroundMaterial;
    }
    const sprites = new Map();
    for (const entity of project.map.entities) {
      if (entity.type === 'player' && !editor) continue;
      if (entity.modelAsset) {
        const loaded = modelAssets.get(entity.modelAsset), object = cloneModel(loaded.scene);
        const root = new THREE.Group(); root.add(object); scene.add(root);
        root.userData.selection = { kind: 'entity', id: entity.id };
        object.scale.setScalar(entity.modelScale ?? 32);
        object.traverse(node => {
          if (node.geometry) geometries.add(node.geometry);
          if (node.material) {
            const copy = original => {
              const result = withEffect(original.clone()); materials.add(result);
              if (result.color) result.userData.baseColor = result.color.clone();
              for (const value of Object.values(result)) if (value?.isTexture) textures.set(value.uuid, value);
              return result;
            };
            node.material = Array.isArray(node.material) ? node.material.map(copy) : copy(node.material);
          }
        });
        const mixer = new THREE.AnimationMixer(object); mixers.add(mixer);
        const entry = { root, mixer, clips: loaded.animations, revision: -1, action: null };
        mixer.addEventListener('finished', () => state.animationFinished.add(entity.id));
        models.set(entity.id, entry);
        continue;
      }
      const asset = assetMap.get(entity.spriteAsset);
      const mat = withEffect(new THREE.SpriteNodeMaterial({ map: textures.get(entity.spriteAsset) || null,
        color: asset ? '#ffffff' : entityColors[entity.type], alphaTest: .5, transparent: false, sizeAttenuation: true }));
      const sprite = new THREE.Sprite(mat); materials.add(mat);
      sprite.userData.selection = { kind: 'entity', id: entity.id };
      const scale = entity.spriteScale || 1;
      sprite.scale.set((asset?.width || 24) * scale, (asset?.height || 40) * scale, 1);
      sprite.center.set(asset ? asset.offsetX / asset.width : .5, asset ? 1 - asset.offsetY / asset.height : 0);
      scene.add(sprite); sprites.set(entity.id, sprite);
    }
    const weaponOverlays = new Map();
    const weaponIds = new Set([project.environment.weaponAsset, ...Object.values(project.environment.weaponAssets || {}),
      ...project.events.flatMap(event => event.actions.filter(action => action.type === 'playWeaponClip')
        .flatMap(action => project.spriteClips?.find(clip => clip.id === action.clipId)?.frames || []))].filter(Boolean));
    for (const weaponId of editor ? [] : weaponIds) {
      const weapon = assetMap.get(weaponId);
      const mat = new THREE.MeshBasicMaterial({ map: textures.get(weapon.id), transparent: true, depthTest: false, depthWrite: false });
      const overlay = mesh(new THREE.PlaneGeometry(weapon.width, weapon.height), mat, overlayScene);
      const left = weapon.offsetX === undefined ? 160 - weapon.width / 2 : -weapon.offsetX;
      const top = weapon.offsetY === undefined ? 200 - weapon.height : 32 - weapon.offsetY;
      overlay.position.set(left + weapon.width / 2, 200 - top - weapon.height / 2, 0);
      weaponOverlays.set(weaponId, overlay);
    }
    const baseColors = new Map(project.map.entities.filter(entity => editor || entity.type !== 'player')
      .map(entity => [entity.id, new THREE.Color(entity.spriteAsset ? '#ffffff' : entityColors[entity.type])]));
    const triangulate = (outer, holes) => THREE.ShapeUtils.triangulateShape(outer.map(point => new THREE.Vector2(point.x, point.y)),
      holes.map(ring => ring.map(point => new THREE.Vector2(point.x, point.y))));
    if (!editor) { physics = createPhysics(project, state, RAPIER, triangulate); state.physics = physics; }
    const sectorHeights = new Map(geometry.map(sector => [sector.id, `${sector.floorHeight}/${sector.ceilingHeight}`]));
    let worldRevision = state.worldRevision;
    let appliedResolution = 1;
    function render(state, dt = 0) {
      if (!editor && state.settings) {
        if (appliedResolution !== state.settings.resolution) {
          appliedResolution = state.settings.resolution;
          renderer.setSize(Math.round(800 * appliedResolution), Math.round(450 * appliedResolution), false);
        }
        camera.fov = state.settings.fov;
        canvas.style.filter = `brightness(${state.settings.brightness})`;
      }
      effectTime.value = Number.isFinite(state.time) ? state.time : 0;
      effectEnabled.value = state.shaderEnabled === false ? 0 : 1;
      if (shaderEffect) for (const [name, uniform] of Object.entries(shaderEffect.uniforms)) {
        const value = state.shaderUniforms instanceof Map ? state.shaderUniforms.get(name) : state.shaderUniforms?.[name];
        uniform.value = Number.isFinite(value) && Math.abs(value) <= 1e20 ? value : selectedShader.uniforms[name];
      }
      canvas.dataset.shaderEnabled = String(Boolean(shaderEffect) && state.shaderEnabled !== false);
      if (!editor) for (const animation of project.materialAnimations || []) {
        const frame = clipFrame(project, animation.clipId, state.time + animation.offset);
        for (const material of materialCache.values()) if (material.userData.assetId === animation.assetId) material.map = textures.get(frame.assetId);
      }
      if (!editor && worldRevision !== state.worldRevision) {
        const changed = new Set();
        for (const sector of geometry) {
          const key = `${sector.floorHeight}/${sector.ceilingHeight}`;
          if (sectorHeights.get(sector.id) !== key) { changed.add(sector.id); sectorHeights.set(sector.id, key); }
        }
        for (const entry of worldParts) if (entry.sectorIds.some(id => changed.has(id))) rebuildPart(entry);
        worldRevision = state.worldRevision;
      }
      renderer.info.reset();
      if (!editor) {
        const inset = state.hud && project.hud?.reserveBottom
          ? Math.round(project.hud.reserveBottom * hudViewport(project.hud, canvas.width, canvas.height).sy) : 0;
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, canvas.width, canvas.height);
        renderer.setClearColor('#272a2e'); renderer.clear();
        // The shared WebGPU/WebGL renderer uses a top-left viewport origin.
        renderer.setViewport(0, 0, canvas.width, canvas.height - inset);
        renderer.setScissor(0, 0, canvas.width, canvas.height - inset);
        renderer.setScissorTest(true);
        camera.aspect = canvas.width / (canvas.height - inset); camera.updateProjectionMatrix();
        canvas.dataset.hudInset = String(inset);
        let selected = project.environment.weaponAssets
          ? project.environment.weaponAssets[state.inventory.selectedWeapon] : project.environment.weaponAsset;
        const weaponAnimation = state.weaponAnimations.get(state.inventory.selectedWeapon);
        if (weaponAnimation) {
          const frame = clipFrame(project, weaponAnimation.clipId, state.time - weaponAnimation.start);
          if (frame && !frame.finished) selected = frame.assetId;
        }
        canvas.dataset.weaponFrame = selected || '';
        for (const [id, overlay] of weaponOverlays) overlay.visible = id === selected;
        const recoil = state.lastShot && state.time - state.lastShot.time < .12 ? 6 * (1 - (state.time - state.lastShot.time) / .12) : 0;
        for (const overlay of weaponOverlays.values()) {
          overlay.userData.restY ??= overlay.position.y;
          overlay.position.y = overlay.userData.restY - recoil;
        }
        canvas.dataset.weapon = state.inventory.selectedWeapon;
      }
      const floor = state.player.z ?? sectorAt(geometry, state.player.x, state.player.y)?.floorHeight ?? 0;
      if (!editor) camera.position.set(state.player.x, floor + 48, state.player.y);
      const pitch = state.player.pitch;
      if (!editor) camera.lookAt(state.player.x + Math.cos(pitch) * Math.cos(state.player.angle),
        floor + 48 + Math.sin(pitch), state.player.y + Math.cos(pitch) * Math.sin(state.player.angle));
      lightRadii.fill(0); lightColors.forEach(color => color.setRGB(0, 0, 0));
      lightNodes.forEach(light => { light.radius.value = 0; });
      const lights = state.entities.filter(entity => entity.type === 'light' && entity.light).slice(0, 16);
      lights.forEach((entity, index) => {
        const z = entity.z ?? sectorAt(geometry, entity.x, entity.y)?.floorHeight ?? 0;
        lightPositions[index].set(entity.x, z + 48, entity.y);
        lightColors[index].set(entity.light.color).multiplyScalar(entity.light.intensity);
        lightRadii[index] = entity.light.radius;
        lightNodes[index].radius.value = entity.light.radius;
        if (pointLights[index]) {
          pointLights[index].position.copy(lightPositions[index]); pointLights[index].color.set(entity.light.color);
          pointLights[index].intensity = entity.light.intensity * 25; pointLights[index].distance = entity.light.radius;
          pointLights[index].decay = 1;
        }
      });
      pointLights.slice(lights.length).forEach(light => { light.intensity = 0; });
      const entities = new Map(state.entities.map(entity => [entity.id, entity]));
      for (const [id, entry] of models) {
        const entity = entities.get(id); entry.root.visible = Boolean(entity);
        if (!entity) continue;
        if (editor) entry.root.children[0].scale.setScalar(entity.modelScale ?? 32);
        const sector = sectorAt(geometry, entity.x, entity.y);
        entry.root.position.set(entity.x, entity.z ?? (sector?.floorHeight || 0) + (entity.elevation || 0), entity.y);
        if (entity.rotation) entry.root.quaternion.copy(entity.rotation);
        else entry.root.rotation.set(0, -entity.angle * Math.PI / 180, 0);
        entry.root.traverse(node => {
          const list = node.material ? Array.isArray(node.material) ? node.material : [node.material] : [];
          for (const mat of list) if (mat.userData.baseColor) mat.color.copy(mat.userData.baseColor).multiplyScalar(Math.max(.03, (sector?.light ?? 255) / 255));
        });
        const requested = state.animations.get(id);
        if (requested && requested.revision !== entry.revision) {
          entry.mixer.stopAllAction(); entry.revision = requested.revision;
          if (requested.playing) {
            const clip = entry.clips.find(clip => clip.name === requested.clip);
            if (!clip) throw new Error(`Model clip ${requested.clip} is missing`);
            const action = entry.mixer.clipAction(clip);
            action.setLoop(requested.loop ? THREE.LoopRepeat : THREE.LoopOnce, requested.loop ? Infinity : 1);
            action.clampWhenFinished = !requested.loop; action.timeScale = requested.speed; action.reset().play();
            entry.action = action;
          }
        }
        entry.mixer.update(Math.min(.05, dt));
      }
      for (const [id, sprite] of sprites) {
        const entity = entities.get(id);
        sprite.visible = Boolean(entity);
        if (!entity) continue;
        {
          const { assetId, flip } = editor ? { assetId: entity.spriteAsset, flip: false } : spriteView(project, state, entity);
          const asset = assetMap.get(assetId), scale = entity.spriteScale || 1;
          sprite.material.map = textures.get(assetId) || null;
          sprite.scale.set((asset?.width || 24) * scale * (flip ? -1 : 1), (asset?.height || 40) * scale, 1);
          sprite.center.set(asset ? asset.offsetX / asset.width : .5, asset ? 1 - asset.offsetY / asset.height : 0);
          sprite.userData.frame = assetId;
          sprite.userData.flip = flip;
        }
        const sector = sectorAt(geometry, entity.x, entity.y);
        sprite.position.set(entity.x, entity.z ?? (sector?.floorHeight || 0) + (entity.elevation || 0), entity.y);
        const illumination = new THREE.Color().setRGB(1, 1, 1).multiplyScalar(Math.max(.03, (sector?.light ?? 255) / 255));
        lights.forEach((light, index) => {
          const distance = sprite.position.distanceTo(lightPositions[index]);
          const amount = Math.max(0, 1 - distance / light.light.radius);
          illumination.add(lightColors[index].clone().multiplyScalar(amount * amount));
        });
        sprite.material.color.copy(baseColors.get(id)).multiply(illumination);
      }
      const effects = [...(state.projectiles || []), ...(state.impacts || [])];
      const activeProjectiles = new Set(effects.map(projectile => projectile.id));
      for (const [id, object] of projectileMeshes) if (!activeProjectiles.has(id)) {
        scene.remove(object); if (object.isMesh) object.geometry.dispose(); object.material.dispose(); projectileMeshes.delete(id);
      }
      for (const projectile of effects) {
        const frame = clipFrame(project, projectile.clipId, projectile.start === undefined ? projectile.age : state.time - projectile.start);
        if (!projectileMeshes.has(projectile.id)) {
          const object = frame ? new THREE.Sprite(withEffect(new THREE.SpriteNodeMaterial({ transparent: true, alphaTest: .1, depthWrite: false })))
            : new THREE.Mesh(new THREE.SphereGeometry(projectile.radius ? 6 : 3, 8, 6), withEffect(new THREE.MeshBasicNodeMaterial({ color: projectile.color })));
          scene.add(object); projectileMeshes.set(projectile.id, object);
        }
        const object = projectileMeshes.get(projectile.id);
        if (frame) {
          const asset = assetMap.get(frame.assetId);
          object.material.map = textures.get(frame.assetId); object.scale.set(asset.width, asset.height, 1);
          object.userData.frame = frame.assetId;
        }
        object.position.set(projectile.x, projectile.z, projectile.y);
      }
      renderer.autoClear = true;
      renderer.setClearColor(project.environment.sky);
      if (backgroundScene.userData.skybox) {
        backgroundScene.userData.skybox.position.copy(camera.position);
        renderer.render(backgroundScene, camera);
      } else {
        const panorama = backgroundScene.userData.panorama;
        if (panorama) {
          const direction = camera.getWorldDirection(new THREE.Vector3());
          panorama.userData.panoramaUniforms.heading.value = editor ? Math.atan2(direction.z, direction.x) : state.player.angle;
          panorama.userData.panoramaUniforms.pitch.value = editor ? Math.asin(direction.y) : pitch;
          panorama.userData.panoramaUniforms.aspect.value = camera.aspect;
          panorama.userData.panoramaUniforms.fieldOfView.value = Math.tan(camera.fov * Math.PI / 360);
        }
        renderer.render(backgroundScene, backgroundCamera);
      }
      renderer.autoClear = false;
      // Preserve the rendered sky; only opaque world surfaces write depth/color.
      const background = scene.background; scene.background = null;
      renderer.clearDepth(); renderer.render(scene, camera); scene.background = background;
      renderer.clearDepth(); renderer.render(overlayScene, overlayCamera);
      renderer.setScissorTest(false);
      if (shaderCompileError) throw new Error(`GPU shader compilation failed: ${shaderCompileError}`);
      canvas.dataset.rendered = 'true';
      canvas.dataset.triangles = String(renderer.info.render.triangles);
      canvas.dataset.physics = editor ? 'disabled-editor' : 'rapier';
      canvas.dataset.modelCount = String(models.size);
      canvas.dataset.animationTime = String([...models.values()][0]?.action?.time || 0);
      canvas.dataset.projectiles = String(state.projectiles?.length || 0);
      canvas.dataset.worldRevision = String(state.worldRevision || 0);
    }
    await renderer.compileAsync(scene, camera);
    if (backgroundScene.children.length) await renderer.compileAsync(backgroundScene, backgroundScene.userData.skybox ? camera : backgroundCamera);
    if (overlayScene.children.length) await renderer.compileAsync(overlayScene, overlayCamera);
    if (shaderCompileError) throw new Error(`GPU shader compilation failed: ${shaderCompileError}`);
    return { render, dispose, scene, camera, renderer, rendererStatus };
  } catch (error) {
    dispose();
    throw new Error(`Preview could not load: ${error.message}`);
  }
}
