// The scene object editor's 3D viewport: a real renderer, not a picture.
//
// Godot's 3D view draws the scene itself, and so does this: imported models are the
// actual meshes with their materials, sprites are camera-facing billboards, lights are
// point lights that light the models, and the node under the pointer is picked with a
// ray against what is drawn. The 2D blueprint view keeps its 2D canvas; this module only
// owns the 3D canvas, so the two never fight over a rendering context.
//
// Coordinates: a scene object lives in Doom map space (x, y on the floor, z up) while
// Three is y-up. Node groups are Z-up children of a rotated world group, so their
// transforms stay readable; only raycast results and the camera are converted, by
// `toMap` and `toThree`.
import * as THREE from 'three/webgpu';
import { createBrowserRenderer } from './renderer-backend.js';
import { GLTFLoader } from '/vendor/three-addons/loaders/GLTFLoader.js';
import { clone as cloneModel } from '/vendor/three-addons/utils/SkeletonUtils.js';
import { decodeDataURI, readModel, validateModelDocument } from '/shared/gltf.js';
import { PANEL_DEFAULTS } from '/shared/panel.js';
import { compileGLSLEffect } from './shader-effects.js';
import { mix, output, screenUV, uniform, uv } from 'three/tsl';

const MODEL_LIGHTING = { fill: .9, key: 2.8, rim: .6 };
/** Doom sprites are one pixel to the unit, so artwork with no size still draws. */
const DEFAULT_SPRITE = { width: 32, height: 40 };

/** Map space -> Three space. */
export function toThree(point) {
  return { x: point.x, y: point.z || 0, z: -point.y };
}

/** Three space -> map space. */
export function toMap(point) {
  return { x: point.x, y: -point.z, z: point.y };
}

export async function createScene3dView(canvas) {
  const { renderer } = await createBrowserRenderer(THREE.WebGPURenderer, canvas);
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1f2024');
  const camera = new THREE.PerspectiveCamera(70, 1, .5, 60000);
  camera.up.set(0, 1, 0);

  // Studio lighting for imported models; the sprite billboards keep their own colour.
  scene.add(new THREE.HemisphereLight('#e8f0ff', '#454c58', MODEL_LIGHTING.fill));
  const key = new THREE.DirectionalLight('#fff3e2', MODEL_LIGHTING.key);
  key.position.set(.55, 1, .35).normalize().multiplyScalar(2048);
  const rim = new THREE.DirectionalLight('#93b7ff', MODEL_LIGHTING.rim);
  rim.position.set(-.5, .4, -.8).normalize().multiplyScalar(2048);
  scene.add(key, key.target, rim, rim.target);

  // The floor grid and the invisible ground plane the drop ray and ground drags use.
  const grid = new THREE.GridHelper(4096, 64, '#3b3f48', '#2b2d33');
  grid.material.transparent = true;
  grid.material.opacity = .55;
  scene.add(grid);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), new THREE.MeshBasicMaterial({ visible: false }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Nodes live in map space inside this group, so their transforms read like the data.
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  const loader = new GLTFLoader();
  const modelCache = new Map(), textureCache = new Map();
  const groups = new Map();
  // Sprite nodes are billboards: quads that are turned towards the camera every frame,
  // which a mesh does reliably with either renderer backend.
  const billboards = new Set();
  // Per-object shaders, compiled once per shader id and shared by every object using it.
  const effectTime = uniform(0);
  const shaderEffects = new Map();
  let shadersById = new Map();
  // What is drawn behind an effect that samples the screen: a plastic strip or a pane of
  // glass refracts what is behind it instead of only being see-through.
  const screenTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  const screenSize = new THREE.Vector2();
  // `iResolution` for Shadertoy effects: one uniform shared by every compiled effect.
  const effectResolution = uniform(new THREE.Vector2(1280, 720));
  // Groups whose material samples the screen; they sit out the background pass.
  const screenGroups = new Set();
  // `fromMaterial` may hand back a fresh material, so the samplers are tracked here.
  const screenMaterials = new WeakSet();

  // The key includes the source, so editing a shader recompiles instead of drawing the old one.
  function shaderSignature(shader) {
    return [shader.id, shader.source, JSON.stringify(shader.uniforms ?? {})].join('\u0000');
  }
  function effectFor(id) {
    const shader = id ? shadersById.get(id) : null;
    if (!shader) return null;
    const key = shaderSignature(shader);
    if (!shaderEffects.has(key)) {
      let compiled = null;
      try { compiled = compileGLSLEffect(shader, { screen: screenTarget.texture, resolution: effectResolution }); } catch { compiled = null; }
      shaderEffects.set(key, compiled);
    }
    return shaderEffects.get(key);
  }

  /** Wraps a material with the object's own shader, when it has one. */
  function withShader(material, entity) {
    const effect = effectFor(entity?.shaderId);
    if (!effect) return material;
    try {
      const wrapped = renderer.library.fromMaterial(material);
      if (!wrapped) return material;
      wrapped.outputNode = mix(output, effect.effect(output, uv(), effectTime, screenUV), 1);
      if (effect.usesScreen) screenMaterials.add(wrapped);
      return wrapped;
    } catch (error) {
      // A shader that cannot wrap this material must not hide the object, and the edit
      // must not be silent either: the reason is reported on the canvas and in the log.
      canvas.dataset.shaderError = `${entity?.name || 'node'}: ${error.message}`;
      console.warn(`Shader on ${entity?.name || 'node'} failed: ${error.message}`);
      return material;
    }
  }
  // The selected node is framed by a box, so a translucent panel or an unlit sprite still
  // says which node is selected when a tint alone cannot be seen.
  const selectionOutline = new THREE.Box3Helper(new THREE.Box3(), 0xffc46b);
  selectionOutline.visible = false;
  selectionOutline.name = 'selection-outline';
  scene.add(selectionOutline);
  // Joint links: a dashed line through the anchor plus a marker where it pivots.
  const joints = new THREE.Group();
  world.add(joints);
  let assetsById = new Map(), entities = [], selectionId = null, disposed = false;

  function nodeHeight(entity) {
    if (entity.physics?.body && entity.physics.body !== 'none') return entity.physics.height || 32;
    if (entity.type === 'enemy') return 56;
    if (entity.type === 'light') return 8;
    return entity.height || 32;
  }

  function modelFor(asset) {
    let pending = modelCache.get(asset.id);
    if (!pending) {
      pending = (async () => {
        const bytes = decodeDataURI(asset.src);
        const { json, binary } = readModel(bytes, asset.format);
        validateModelDocument(json, binary?.length);
        const loaded = await loader.parseAsync(asset.format === 'glb' ? bytes.buffer : new TextDecoder().decode(bytes), '');
        if (!loaded.scene) throw new Error(`Model ${asset.name} has no default scene`);
        return loaded;
      })();
      // A model that failed to parse must not poison the cache: the next edit retries it.
      pending.catch(() => modelCache.delete(asset.id));
      modelCache.set(asset.id, pending);
    }
    return pending;
  }

  function spriteTexture(asset) {
    let texture = textureCache.get(asset.id);
    if (!texture) {
      texture = new THREE.TextureLoader().load(asset.src);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      textureCache.set(asset.id, texture);
    }
    return texture;
  }

  function disposeGroup(group) {
    group.traverse(node => {
      node.geometry?.dispose?.();
      const list = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
      for (const material of list) material.dispose?.();
    });
    group.removeFromParent();
  }

  function buildEntity(entity) {
    const group = new THREE.Group();
    group.position.set(entity.x, entity.y, entity.elevation || 0);
    group.rotation.z = (Number(entity.angle) || 0) * Math.PI / 180;
    group.userData.entityId = entity.id;
    const modelAsset = entity.modelAsset ? assetsById.get(entity.modelAsset) : null;
    if (modelAsset) {
      // A box stands in until the model is parsed, so the node is never invisible.
      const placeholder = new THREE.Mesh(new THREE.BoxGeometry(32, 32, 32),
        new THREE.MeshStandardMaterial({ color: '#7b7f8c', transparent: true, opacity: .35 }));
      placeholder.userData.placeholder = true;
      group.add(placeholder);
      modelFor(modelAsset).then(loaded => {
        if (disposed || group.userData.disposed) return;
        const object = cloneModel(loaded.scene);
        object.userData.modelRoot = true;
        object.scale.setScalar(Number(entity.modelScale) || 32);
        // Models are authored Y-up; inside the Z-up group that is a quarter turn.
        object.rotation.x = Math.PI / 2;
        const tilt = entity.modelTilt || {};
        if (tilt.pitch) object.rotation.y += Number(tilt.pitch) * Math.PI / 180;
        if (tilt.roll) object.rotation.z += Number(tilt.roll) * Math.PI / 180;
        object.traverse(node => {
          if (!node.material) return;
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          node.material = materials.map(material => {
            // Emissive is the selection tint, so remember what to restore it to.
            if (material.emissive) {
              material.userData.baseEmissive = material.emissive.getHex();
              material.emissive.setHex(entity.id === selectionId ? 0x4a4230 : 0);
            }
            return withShader(material, entity);
          });
          if (!Array.isArray(object.material) && materials.length === 1) node.material = node.material[0];
          if (materials.some(material => screenMaterials.has(material))) screenGroups.add(group);
        });
        // Drop whatever stand-in the group still holds, then show the real mesh.
        for (const child of [...group.children]) {
          if (!child.userData.placeholder) continue;
          child.removeFromParent();
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        }
        group.add(object);
        report();
      }).catch(error => { group.userData.error = error.message; report(); });
    } else if (entity.panel) {
      // A panel is drawn as the translucent slab it is, so a plastic strip curtain looks
      // like one and a rigid strip is a body you can push.
      const panel = entity.panel;
      const material = withShader(new THREE.MeshPhysicalMaterial({
        color: panel.color || PANEL_DEFAULTS.color,
        transparent: true,
        opacity: panel.opacity ?? PANEL_DEFAULTS.opacity,
        roughness: panel.roughness ?? PANEL_DEFAULTS.roughness,
        metalness: panel.metalness ?? PANEL_DEFAULTS.metalness,
        side: THREE.DoubleSide,
        depthWrite: false,
      }), entity);
      // Inside the Z-up group local Z is up and local Y is map depth, so the slab's height
      // has to be its Z size; putting it on Y laid every strip flat on the floor.
      const slab = new THREE.Mesh(new THREE.BoxGeometry(panel.width, Math.max(.5, panel.thickness ?? 2), panel.height), material);
      slab.position.z = panel.height / 2;
      slab.userData.pickable = true;
      slab.userData.panel = true;
      group.userData.panel = true;
      if (screenMaterials.has(material)) screenGroups.add(group);
      group.add(slab);
    } else if (entity.spriteAsset) {
      const art = assetsById.get(entity.spriteAsset);
      const scale = Number(entity.spriteScale) || 1;
      const width = (art?.width || DEFAULT_SPRITE.width) * scale;
      const height = (art?.height || DEFAULT_SPRITE.height) * scale;
      const material = withShader(new THREE.MeshBasicMaterial({
        map: art?.src ? spriteTexture(art) : null, color: '#ffffff', transparent: false, alphaTest: .5, side: THREE.DoubleSide,
      }), entity);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      // Doom sprites hang from their bottom edge, so the quad is raised by half a height.
      quad.position.z = height / 2;
      quad.userData.pickable = true;
      quad.userData.billboard = true;
      billboards.add(quad);
      if (screenMaterials.has(material)) screenGroups.add(group);
      group.add(quad);
    } else {
      const height = nodeHeight(entity);
      const box = new THREE.Mesh(new THREE.BoxGeometry(24, 24, height),
        new THREE.MeshStandardMaterial({ color: entity.type === 'light' ? '#a9beff' : '#9aa0b4', transparent: true, opacity: .55 }));
      box.position.z = height / 2;
      box.userData.pickable = true;
      group.add(box);
    }
    if (entity.type === 'light' && entity.light) {
      group.add(new THREE.PointLight(entity.light.color || '#ffbd72', Number(entity.light.intensity) || 1,
        Number(entity.light.radius) || 192, 1.4));
    }
    return group;
  }

  function entityFor(object) {
    for (let node = object; node; node = node.parent) if (node.userData.entityId) return node.userData.entityId;
    return null;
  }

  /** Frames the selected node, padded so the box does not sit inside its faces. */
  function outlineSelection() {
    const group = selectionId ? groups.get(selectionId) : null;
    if (!group) { selectionOutline.visible = false; return; }
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) { selectionOutline.visible = false; return; }
    const padding = Math.max(2, Math.min(24, box.getSize(new THREE.Vector3()).length() * 0.02));
    selectionOutline.box.copy(box.expandByScalar(padding));
    selectionOutline.visible = true;
  }

  function highlight() {
    outlineSelection();
    for (const [id, group] of groups) {
      const selected = id === selectionId;
      group.traverse(node => {
        const list = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
        for (const material of list) {
          if (material.emissive && material.userData.baseEmissive !== undefined) {
            material.emissive.setHex(selected ? 0x4a4230 : material.userData.baseEmissive);
          }
          // A selected sprite is tinted, because a billboard has no faces to light up.
          if (node.userData.billboard && material.color) material.color.set(selected ? '#ffe9a8' : '#ffffff');
        }
      });
    }
  }

  /** Draws one dashed link per joint, from each object to the joint's anchor. */
  function buildJoints(jointList) {
    for (const child of [...joints.children]) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
      joints.remove(child);
    }
    if (!jointList?.length) return;
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    const positions = [], anchorPoints = [];
    for (const joint of jointList) {
      const anchor = joint.anchor || { x: 0, y: 0, z: 0 };
      anchorPoints.push(anchor.x, anchor.y, (anchor.z || 0) + 2);
      for (const side of [joint.a, joint.b]) {
        const entity = byId.get(side);
        if (!entity) continue;
        const height = (entity.physics?.height || 32) / 2;
        positions.push(entity.x, entity.y, (entity.elevation || 0) + height, anchor.x, anchor.y, anchor.z || 0);
      }
    }
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.LineDashedMaterial({ color: '#78d6ff', dashSize: 8, gapSize: 6, transparent: true, opacity: .9 });
      const lines = new THREE.LineSegments(geometry, material);
      lines.computeLineDistances();
      joints.add(lines);
    }
    if (anchorPoints.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(anchorPoints, 3));
      const material = new THREE.PointsMaterial({ color: '#78d6ff', size: 6, sizeAttenuation: false });
      joints.add(new THREE.Points(geometry, material));
    }
  }

  /** Replaces what the viewport draws, keeping the loaded models and textures. */
  function setScene(sceneEntities, assets, jointList = [], shaderList = []) {
    entities = sceneEntities || [];
    assetsById = new Map((assets || []).map(asset => [asset.id, asset]));
    const wantedShaders = new Map((shaderList || []).map(shader => [shader.id, shader]));
    // A different shader set means the cached wrappers are stale.
    for (const key of [...shaderEffects.keys()]) if (!wantedShaders.has(key.split('\u0000')[0])) shaderEffects.delete(key);
    shadersById = wantedShaders;
    screenGroups.clear();
    for (const group of groups.values()) { group.userData.disposed = true; disposeGroup(group); }
    groups.clear();
    billboards.clear();
    for (const entity of entities) {
      const group = buildEntity(entity);
      groups.set(entity.id, group);
      world.add(group);
    }
    // One grid square is 64 units, and the grid grows with the scene.
    const span = Math.max(512, ...entities.map(entity => Math.max(Math.abs(entity.x), Math.abs(entity.y)) * 2));
    grid.scale.setScalar(Math.max(1, Math.round(span / 4096 * 8) / 8));
    buildJoints(jointList);
    highlight();
    report();
  }

  function resize() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return false;
    const ratio = renderer.getPixelRatio();
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    screenSize.set(Math.round(width * ratio), Math.round(height * ratio));
    return true;
  }

  /** True while a group whose material reads the screen is actually on screen. */
  function needsScreenPass() {
    for (const group of screenGroups) {
      let shown = group.visible;
      for (let node = group.parent; node && shown; node = node.parent) shown = node.visible;
      if (shown) return true;
    }
    return false;
  }

  function render(dt = 0) {
    if (disposed || !resize()) return;
    effectTime.value += Math.min(.1, Math.max(0, dt));
    // Billboards keep their height and turn towards the camera, like a Doom sprite.
    for (const quad of billboards) if (quad.parent) quad.lookAt(camera.position);
    effectResolution.value.set(screenSize.x, screenSize.y);
    canvas.dataset.screenGroups = String(screenGroups.size);
    canvas.dataset.screenPass = String(needsScreenPass());
    // What is actually drawn per node kind, so an invisible node can be told apart from
    // one that was never built.
    let panelGroups = 0;
    for (const group of groups.values()) if (group.children.some(child => child.userData.panel)) panelGroups++;
    canvas.dataset.panels = String(panelGroups);
    // What is behind a refractive object has to be drawn before the object itself, so
    // the screen-sampling panels are drawn into a target with themselves hidden.
    if (needsScreenPass()) {
      if (screenTarget.width !== screenSize.x || screenTarget.height !== screenSize.y) screenTarget.setSize(screenSize.x, screenSize.y);
      const hidden = [];
      for (const group of screenGroups) if (group.visible) { hidden.push(group); group.visible = false; }
      renderer.setRenderTarget(screenTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      for (const object of hidden) object.visible = true;
    }
    renderer.render(scene, camera);
  }

  /** Counts the drawn node kinds, the way the layout view reports its world parts. */
  function report() {
    let models = 0, sprites = 0, boxes = 0, failed = 0;
    for (const group of groups.values()) {
      if (group.userData.error) failed++;
      // A model group also holds a temporary placeholder until the mesh arrives, so the
      // count walks every child instead of trusting the first one.
      const children = group.children.filter(child => !child.isLight);
      if (!children.length) continue;
      if (children.some(child => child.userData.billboard)) sprites++;
      else if (children.some(child => child.userData.modelRoot)) models++;
      else boxes++;
      if (children.some(child => child.userData.placeholder)) boxes += 0;
    }
    canvas.dataset.nodes = String(groups.size);
    canvas.dataset.models = String(models);
    canvas.dataset.sprites = String(sprites);
    canvas.dataset.placeholders = String(boxes);
    canvas.dataset.failed = String(failed);
    canvas.dataset.selection = selectionId || '';
  }

  function pointerRay(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    return raycaster;
  }

  /** The node under the pointer, in map space, or null over empty space. */
  function pickNode(clientX, clientY) {
    for (const hit of pointerRay(clientX, clientY).intersectObjects(world.children, true)) {
      const id = entityFor(hit.object);
      if (id) return { id, point: toMap(hit.point) };
    }
    return null;
  }

  /** Where the pointer meets the floor, for drops and ground drags. */
  function groundPoint(clientX, clientY) {
    const hit = pointerRay(clientX, clientY).intersectObject(ground, false)[0];
    return hit ? toMap(hit.point) : null;
  }

  /** Aims the camera from a map-space eye and forward vector. */
  function aimCamera(eye, forward) {
    const position = toThree(eye), direction = toThree(forward);
    camera.position.set(position.x, position.y, position.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(position.x + direction.x, position.y + direction.y, position.z + direction.z);
    camera.updateMatrixWorld();
  }

  /** Moves one node's group without rebuilding the scene, so a drag follows the pointer. */
  function setNodePosition(id, x, y) {
    const group = groups.get(id);
    if (group) group.position.set(x, y, group.position.z);
  }

  function select(id) {
    if (id === selectionId) return;
    selectionId = id;
    highlight();
    report();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    screenGroups.clear();
    screenTarget.dispose();
    for (const group of groups.values()) { group.userData.disposed = true; disposeGroup(group); }
    groups.clear();
    billboards.clear();
    for (const texture of textureCache.values()) texture.dispose();
    textureCache.clear();
    for (const pending of modelCache.values()) {
      pending.then(loaded => disposeGroup(loaded.scene)).catch(() => {});
    }
    modelCache.clear();
    renderer.dispose();
  }

  return { scene, camera, renderer, setScene, render, resize, pickNode, groundPoint, aimCamera, setNodePosition, select, dispose };
}
