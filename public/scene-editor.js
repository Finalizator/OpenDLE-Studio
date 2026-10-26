import * as THREE from '/vendor/three/three.module.js';
import { createPreview } from './render.js';
import { createRuntime, runtimeEntities } from '/shared/runtime.js';
import { newId } from '/shared/project.js';
import { sectorAt, sectorGeometry } from '/shared/sectors.js';
import { dragSelection } from '/shared/scene-edit.js';
import {
  addEntityWithModel, applyEntityModel, applyEntitySprite, applySurfaceAsset, axisDragAmount, describeSurfaceTarget,
  moveEntityToFloor, requireImageAsset, requireModelAsset, resolveWallSide, sectorTarget, snapValue,
  wallPartAt, wallTarget,
} from './editor-drop.js';

const SELECT_COLOR = '#ffd34d', DROP_COLOR = '#7fe6ff';
const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 0, 1), z: new THREE.Vector3(0, 1, 0) };
const AXIS_LENGTH = 50;

export async function createSceneEditor(canvas, project, callbacks, pose) {
  const state = createRuntime(project);
  state.animations.clear();
  const view = await createPreview(canvas, project, state, { editor: true });
  const { scene, camera } = view;
  let sectors = sectorGeometry(project);
  let sectorById = new Map(sectors.map(sector => [sector.id, sector]));
  let wallById = new Map(project.map.walls.map(wall => [wall.id, wall]));
  let vertexById = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  let entityById = new Map(project.map.entities.map(entity => [entity.id, entity]));
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const handles = new THREE.Group(), helperGroup = new THREE.Group(), vertexGroup = new THREE.Group();
  scene.add(handles, helperGroup, vertexGroup);
  const resources = [], keys = new Set(), listeners = [];
  const own = resource => { resources.push(resource); return resource; };

  const roomPositions = new Float32Array(15);
  const roomGeometry = own(new THREE.BufferGeometry());
  roomGeometry.setAttribute('position', new THREE.BufferAttribute(roomPositions, 3));
  const roomMaterial = own(new THREE.LineBasicMaterial({ color: '#8ce0a6', depthTest: false }));
  const roomOutline = new THREE.Line(roomGeometry, roomMaterial);
  roomOutline.renderOrder = 200; roomOutline.visible = false; roomOutline.frustumCulled = false; scene.add(roomOutline);

  const outlineGeometry = own(new THREE.EdgesGeometry(own(new THREE.BoxGeometry(1, 1, 1))));
  const selectionOutline = new THREE.LineSegments(outlineGeometry, own(new THREE.LineBasicMaterial({
    color: SELECT_COLOR, depthTest: false, transparent: true, opacity: .95,
  })));
  selectionOutline.renderOrder = 205; selectionOutline.visible = false; selectionOutline.frustumCulled = false;
  helperGroup.add(selectionOutline);
  const dropOutline = new THREE.LineSegments(outlineGeometry, own(new THREE.LineBasicMaterial({ color: DROP_COLOR, depthTest: false })));
  dropOutline.renderOrder = 206; dropOutline.visible = false; dropOutline.frustumCulled = false;
  helperGroup.add(dropOutline);
  const dropMarker = new THREE.Mesh(own(new THREE.BoxGeometry(10, 10, 10)),
    own(new THREE.MeshBasicMaterial({ color: DROP_COLOR, depthTest: false, transparent: true, opacity: .85 })));
  dropMarker.renderOrder = 206; dropMarker.visible = false; dropMarker.frustumCulled = false;
  helperGroup.add(dropMarker);

  const vertexGeometry = own(new THREE.SphereGeometry(4, 8, 6));
  const vertexMaterial = own(new THREE.MeshBasicMaterial({ color: '#ffe89a', depthTest: false }));
  const vertexMarkers = [0, 1].map(() => {
    const marker = new THREE.Mesh(vertexGeometry, vertexMaterial);
    marker.renderOrder = 210; marker.visible = false; marker.frustumCulled = false;
    vertexGroup.add(marker);
    return marker;
  });

  let selected = null, action = null, speed = pose?.speed || 320, yaw = pose?.yaw ?? 0, pitch = pose?.pitch ?? -.65;
  let mode = 'move', showCeilings = false, ceilingTimer = 0;
  let vertexHeights = new Map();
  let pickables = [],
    surfaceMeshes = new Map(),
    ceilingSurfaces = [];
  function collectVertexHeights() {
    const heights = new Map();
    for (const wall of project.map.walls) for (const side of [wall.right, wall.left]) {
      const floor = sectorById.get(side?.sectorId)?.floorHeight;
      if (floor === undefined) continue;
      for (const id of [wall.a, wall.b]) heights.set(id, Math.min(heights.get(id) ?? Infinity, floor));
    }
    return heights;
  }
  function collectSceneHandles() {
    pickables = []; surfaceMeshes = new Map(); ceilingSurfaces = [];
    for (const child of scene.children) {
      if (child === handles || child === helperGroup || child === vertexGroup || child === roomOutline) continue;
      child.traverse(object => {
        const selection = object.userData.selection;
        if (!selection) return;
        pickables.push(object);
        if (selection.kind !== 'sector') return;
        const key = `${selection.id}/${selection.surface || 'floorHeight'}`;
        if (!surfaceMeshes.has(key)) surfaceMeshes.set(key, []);
        surfaceMeshes.get(key).push(object);
        if (selection.surface === 'ceilingHeight') ceilingSurfaces.push({ mesh: object, y: sectorById.get(selection.id)?.ceilingHeight ?? 0 });
      });
    }
  }
  /**
   * After a live edit the derived lookups (sector geometry, vertices, walls,
   * objects) must follow the new project. Keeping the originals is what made the
   * selection outline and gizmo snap back to the pre-drag position.
   */
  function refreshProjectData() {
    sectors = sectorGeometry(project);
    sectorById = new Map(sectors.map(sector => [sector.id, sector]));
    wallById = new Map(project.map.walls.map(wall => [wall.id, wall]));
    vertexById = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
    entityById = new Map(project.map.entities.map(entity => [entity.id, entity]));
    vertexHeights = collectVertexHeights();
    collectSceneHandles();
  }
  vertexHeights = collectVertexHeights();
  collectSceneHandles();

  const frustum = new THREE.Frustum(), projectionView = new THREE.Matrix4(), bounds = new THREE.Box3();
  const boundsSphere = new THREE.Sphere(), boundsCenter = new THREE.Vector3(), boundsSize = new THREE.Vector3();
  const outlineCenter = new THREE.Vector3(), outlineSize = new THREE.Vector3(), outlineShift = new THREE.Vector3();
  const forwardVector = new THREE.Vector3(), rightVector = new THREE.Vector3(), motionVector = new THREE.Vector3(), lookTarget = new THREE.Vector3();
  let hasOutline = false;

  function direction(target) {
    return target.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
  }

  const readout = document.createElement('div');
  readout.className = 'scene-readout'; readout.hidden = true; readout.setAttribute('role', 'status');
  (canvas.parentElement || document.body).append(readout);
  listeners.push(() => readout.remove());
  const ghost = document.createElement('div');
  ghost.className = 'scene-drag-ghost'; ghost.hidden = true; ghost.setAttribute('aria-hidden', 'true');
  document.body.append(ghost);
  listeners.push(() => ghost.remove());
  function showReadout(text, tone = 'info') {
    readout.textContent = text; readout.dataset.tone = tone; readout.hidden = false;
  }
  const hideReadout = () => { readout.hidden = true; };

  function fit() {
    const fitBounds = new THREE.Box3();
    project.map.vertices.forEach(vertex => fitBounds.expandByPoint(new THREE.Vector3(vertex.x, 0, vertex.y)));
    const center = fitBounds.getCenter(new THREE.Vector3()), size = fitBounds.getSize(new THREE.Vector3());
    const distance = Math.max(256, Math.max(size.x, size.z) * .75);
    camera.position.set(center.x - distance, distance, center.z);
    yaw = 0; pitch = -.65;
  }
  if (pose) camera.position.copy(pose.position); else fit();
  function listen(target, name, fn, options) {
    target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options));
  }
  function cast(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateMatrixWorld(); scene.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
  }
  function visibleThrough(object) {
    for (let node = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  }
  function hits(group) { return ray.intersectObjects(group.children, true).filter(hit => visibleThrough(hit.object)); }
  function selectionOf(object) {
    for (let node = object; node; node = node.parent) if (node.userData.selection) return node.userData.selection;
    return null;
  }
  function worldHit() {
    for (const hit of ray.intersectObjects(pickables, true)) if (visibleThrough(hit.object) && selectionOf(hit.object)) return hit;
    return null;
  }
  function planePoint(height) {
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), new THREE.Vector3());
  }
  function updateRoomOutline(a, b, y) {
    roomPositions[0] = a.x; roomPositions[1] = y; roomPositions[2] = a.z;
    roomPositions[3] = b.x; roomPositions[4] = y; roomPositions[5] = a.z;
    roomPositions[6] = b.x; roomPositions[7] = y; roomPositions[8] = b.z;
    roomPositions[9] = a.x; roomPositions[10] = y; roomPositions[11] = b.z;
    roomPositions[12] = a.x; roomPositions[13] = y; roomPositions[14] = a.z;
    roomGeometry.attributes.position.needsUpdate = true;
  }

  function boundsFor(selection, box) {
    box.makeEmpty();
    if (!selection) return box;
    if (selection.kind === 'sector') {
      const sector = sectorById.get(selection.id);
      if (sector) box.set(
        new THREE.Vector3(sector.bounds.minX, Math.min(sector.floorHeight, sector.ceilingHeight), sector.bounds.minY),
        new THREE.Vector3(sector.bounds.maxX, Math.max(sector.floorHeight, sector.ceilingHeight), sector.bounds.maxY));
    } else if (selection.kind === 'wall') {
      const wall = wallById.get(selection.id), a = vertexById.get(wall?.a), b = vertexById.get(wall?.b);
      if (a && b) {
        const front = sectorById.get(wall.right?.sectorId || wall.left?.sectorId);
        box.set(new THREE.Vector3(Math.min(a.x, b.x), front?.floorHeight ?? 0, Math.min(a.y, b.y)),
          new THREE.Vector3(Math.max(a.x, b.x), front?.ceilingHeight ?? wall.height ?? 128, Math.max(a.y, b.y)));
      }
    } else if (selection.kind === 'vertex') {
      const vertex = vertexById.get(selection.id);
      if (vertex) {
        const y = vertexHeights.get(vertex.id) || 0;
        box.set(new THREE.Vector3(vertex.x - 16, y, vertex.y - 16), new THREE.Vector3(vertex.x + 16, y + 32, vertex.y + 16));
      }
    } else if (selection.kind === 'entity') {
      const entity = entityById.get(selection.id);
      if (entity) {
        // A rendered model knows its own extent; guessing from the sprite gave a
        // taller box around an object that did not actually draw the model.
        const rendered = entity.modelAsset ? view.boundsOfEntity?.(entity.id) : null;
        if (rendered && !rendered.isEmpty()) box.copy(rendered);
        else {
          const base = (sectorAt(sectors, entity.x, entity.y)?.floorHeight ?? 0) + (entity.elevation || 0);
          const asset = (project.assets || []).find(candidate => candidate.id === entity.spriteAsset);
          const width = Math.max(24, (asset?.width || 32) * (entity.spriteScale || 1));
          const height = Math.max(32, (asset?.height || 48) * (entity.spriteScale || 1));
          box.set(new THREE.Vector3(entity.x - width / 2, base, entity.y - width / 2),
            new THREE.Vector3(entity.x + width / 2, base + height, entity.y + width / 2));
        }
      }
    }
    return box;
  }
  function updateSelectionOutline() {
    if (!hasOutline || !selected) { selectionOutline.visible = false; return; }
    selectionOutline.position.copy(outlineCenter).add(outlineShift);
    selectionOutline.scale.set(Math.max(outlineSize.x, 8) + 4, Math.max(outlineSize.y, 8) + 4, Math.max(outlineSize.z, 8) + 4);
    boundsSphere.center.copy(selectionOutline.position);
    boundsSphere.radius = Math.hypot(selectionOutline.scale.x, selectionOutline.scale.y, selectionOutline.scale.z) * .5;
    selectionOutline.visible = frustum.intersectsSphere(boundsSphere);
  }
  function clearDropPreview() {
    dropOutline.visible = false; dropMarker.visible = false;
    canvas.dataset.dropPreview = '';
  }
  function highlightDrop(selection, point) {
    boundsFor(selection, bounds);
    dropOutline.visible = false;
    if (!bounds.isEmpty()) {
      bounds.getCenter(boundsCenter); bounds.getSize(boundsSize);
      dropOutline.position.copy(boundsCenter);
      dropOutline.scale.set(Math.max(boundsSize.x, 8) + 8, Math.max(boundsSize.y, 8) + 8, Math.max(boundsSize.z, 8) + 8);
      dropOutline.visible = true;
    }
    if (point) { dropMarker.position.copy(point); dropMarker.visible = true; }
  }

  function clearHandles() {
    for (const child of [...handles.children]) { handles.remove(child); child.geometry.dispose(); child.material.dispose(); }
  }
  function updateVertexMarkers() {
    const shown = selected?.kind === 'vertex' ? [selected.id]
      : selected?.kind === 'wall' ? [wallById.get(selected.id)?.a, wallById.get(selected.id)?.b] : [];
    vertexMarkers.forEach((marker, index) => {
      const vertex = shown[index] && vertexById.get(shown[index]);
      marker.userData.selection = vertex ? { kind: 'vertex', id: vertex.id } : null;
      marker.userData.active = Boolean(vertex);
      marker.visible = Boolean(vertex);
      if (vertex) marker.position.set(vertex.x, (vertexHeights.get(vertex.id) || 0) + 4, vertex.y);
    });
  }
  function select(selection, { rebuildHandles = true } = {}) {
    selected = selection;
    updateVertexMarkers();
    selectionOutline.visible = false; outlineShift.set(0, 0, 0);
    canvas.dataset.sceneSelection = '';
    if (!selected) { clearHandles(); return; }
    const { kind, id } = selected;
    let position;
    if (kind === 'entity') {
      const entity = entityById.get(id);
      if (!entity) { clearHandles(); return; }
      position = new THREE.Vector3(entity.x, (sectorAt(sectors, entity.x, entity.y)?.floorHeight || 0) + (entity.elevation || 0), entity.y);
    } else if (kind === 'vertex') {
      const vertex = vertexById.get(id); if (!vertex) { clearHandles(); return; }
      position = new THREE.Vector3(vertex.x, (vertexHeights.get(id) || 0) + 4, vertex.y);
    } else if (kind === 'wall') {
      const wall = wallById.get(id), a = vertexById.get(wall?.a), b = vertexById.get(wall?.b);
      if (!a || !b) { clearHandles(); return; }
      position = new THREE.Vector3((a.x + b.x) / 2, 32, (a.y + b.y) / 2);
    } else {
      const sector = sectorById.get(id);
      if (!sector || !Number.isFinite(sector.bounds.minX)) { clearHandles(); return; }
      position = new THREE.Vector3((sector.bounds.minX + sector.bounds.maxX) / 2,
        sector[selected.surface || 'floorHeight'], (sector.bounds.minY + sector.bounds.maxY) / 2);
    }
    boundsFor(selected, bounds);
    hasOutline = !bounds.isEmpty();
    if (hasOutline) { bounds.getCenter(outlineCenter); bounds.getSize(outlineSize); }
    handles.position.copy(position);
    const axes = axesFor(kind);
    // Live drags re-select on every frame; rebuilding three geometries and
    // materials each time is pointless when the axes did not change.
    if (rebuildHandles || handles.children.filter(child => child.userData.axis).map(child => child.userData.axis).join() !== axes.join()) {
      clearHandles();
      for (const axis of axes) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? AXIS_LENGTH : 6, axis === 'z' ? AXIS_LENGTH : 6, axis === 'y' ? AXIS_LENGTH : 6),
          new THREE.MeshBasicMaterial({ color: axis === 'x' ? '#ef7777' : axis === 'y' ? '#7baaff' : '#85da85', depthTest: false }));
        mesh.position.set(axis === 'x' ? AXIS_LENGTH / 2 : 0, axis === 'z' ? AXIS_LENGTH / 2 : 0, axis === 'y' ? AXIS_LENGTH / 2 : 0);
        mesh.userData.axis = axis; mesh.renderOrder = 200; handles.add(mesh);
      }
      // The three bars meet at an empty corner, so the middle of the gizmo used to
      // be a dead spot. This invisible sphere makes the whole gizmo grabbable.
      const core = new THREE.Mesh(new THREE.SphereGeometry(9, 8, 6),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false }));
      core.userData.axis = null; core.renderOrder = 201; handles.add(core);
    }
    canvas.dataset.sceneSelection = `${kind}:${id}${selected.surface ? `:${selected.surface}` : ''}`;
  }
  function applyEdit(fn, message, after) {
    try { callbacks.edit(fn, message); after?.(); } catch (error) { callbacks.error(error.message); cancel(); }
  }

  function screenOf(point) {
    const rect = canvas.getBoundingClientRect(), projected = point.clone().project(camera);
    return `${Math.round((projected.x * .5 + .5) * rect.width)},${Math.round((-.5 * projected.y + .5) * rect.height)}`;
  }
  const axesFor = kind => kind === 'sector' ? ['z'] : kind === 'vertex' || kind === 'wall' ? ['x', 'y'] : ['x', 'y', 'z'];
  const axisLabel = axis => axis === 'x' ? 'X' : axis === 'y' ? 'Z' : 'Y';
  /**
   * The axis a press should drag. The bars are thin, and the point where they
   * meet has no geometry at all, so a press near the gizmo centre grabs the
   * closest axis instead of doing nothing.
   */
  function axisAt(event) {
    const hit = hits(handles)[0];
    if (hit) return hit.object.userData.axis || nearestAxis(event);
    if (!handles.visible) return null;
    const rect = canvas.getBoundingClientRect();
    const [sx, sy] = screenOf(handles.position).split(',').map(Number);
    const distance = Math.hypot(event.clientX - rect.left - sx, event.clientY - rect.top - sy);
    return distance <= 12 ? nearestAxis(event) : null;
  }
  /** Which axis bar the pointer is closest to, for grabbing the gizmo centre. */
  function nearestAxis(event) {
    const rect = canvas.getBoundingClientRect();
    const origin = handles.position.clone().project(camera);
    const ox = (origin.x * .5 + .5) * rect.width, oy = (-origin.y * .5 + .5) * rect.height;
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    let best = null;
    for (const axis of axesFor(selected?.kind)) {
      const tip = handles.position.clone().addScaledVector(AXIS_VECTORS[axis], AXIS_LENGTH * handles.scale.x).project(camera);
      const dx = (tip.x * .5 + .5) * rect.width - ox, dy = (-tip.y * .5 + .5) * rect.height - oy;
      const length = Math.hypot(dx, dy) || 1;
      const distance = Math.abs(dx * (py - oy) - dy * (px - ox)) / length;
      if (!best || distance < best.distance) best = { axis, distance };
    }
    return best?.axis || 'z';
  }
  const formatDistance = delta => {
    const parts = [['x', delta.x], ['z', delta.y], ['y', delta.z]]
      .filter(([, value]) => Math.abs(value) >= .01).map(([name, value]) => `${name} ${Math.round(value)}`);
    return parts.length ? parts.join(', ') : '0';
  };

  function axisDistance(start, axis, fromX, fromY, toX, toY) {
    const rect = canvas.getBoundingClientRect();
    const origin = start.clone().project(camera);
    const tip = start.clone().addScaledVector(AXIS_VECTORS[axis], AXIS_LENGTH).project(camera);
    return axisDragAmount({ originX: origin.x, originY: origin.y, tipX: tip.x, tipY: tip.y,
      width: rect.width, height: rect.height, deltaX: toX - fromX, deltaY: toY - fromY, length: AXIS_LENGTH });
  }

  // Vertical editing moves whole sector surfaces. Per-vertex (sloped floor/ceiling) heights are
  // intentionally not supported yet: the project model stores one height per sector.
  function liveDrag(selection, baseline, mode, delta, message) {
    callbacks.live(next => dragSelection(next, baseline, selection, mode, delta, callbacks.grid()), message);
  }

  function surfaceTargetFor(selection, point) {
    if (selection?.kind === 'sector') return sectorTarget(selection.id, selection.surface || 'floorHeight');
    if (selection?.kind !== 'wall') return null;
    const wall = wallById.get(selection.id);
    if (!wall) return null;
    const side = resolveWallSide(sectors, wall, camera.position);
    if (!side) return null;
    return wallTarget(selection.id, side, wallPartAt(sectorById, wall, side, point.y) || 'middle');
  }
  function floorPointAt(point) {
    const x = snapValue(point.x, callbacks.grid()), y = snapValue(point.z, callbacks.grid());
    return { x, y, floor: sectorAt(sectors, x, y)?.floorHeight ?? 0 };
  }
  // Dropping on empty sky still has to land somewhere: use where the view ray meets
  // the floor of the sector the camera is in, or a short step ahead when looking up.
  function emptyDropPoint() {
    const directionVector = new THREE.Vector3();
    camera.getWorldDirection(directionVector);
    const floor = sectorAt(sectors, camera.position.x, camera.position.z)?.floorHeight ?? 0;
    const travel = directionVector.y < -.05 ? (floor - camera.position.y) / directionVector.y : 256;
    const point = camera.position.clone().addScaledVector(directionVector, Math.max(64, Math.min(travel, 2048)));
    return { x: point.x, z: point.z };
  }

  function assetFromTile(tile) {
    const list = tile.closest('#asset-list');
    if (!list) return null;
    const tiles = [...list.querySelectorAll(':scope > .asset-tile')];
    const filter = document.getElementById('asset-filter')?.value || 'all';
    const search = (document.getElementById('asset-search')?.value || '').trim().toLowerCase();
    const assets = (project.assets || []).filter(asset => (filter === 'all' || asset.kind === filter) &&
      asset.name.toLowerCase().includes(search));
    const candidate = assets[tiles.indexOf(tile)];
    if (candidate && tile.textContent.includes(candidate.name)) return candidate;
    const source = tile.querySelector('img[src], audio[src]')?.getAttribute('src');
    const bySource = source && (project.assets || []).find(asset => asset.src === source);
    if (bySource) return bySource;
    const names = [...tile.querySelectorAll('strong')].map(node => node.textContent);
    return (project.assets || []).find(asset => names.includes(asset.name)) || null;
  }
  function dragSourceFrom(target) {
    if (!target?.closest) return null;
    const objectTile = target.closest('[data-object-id]');
    if (objectTile) {
      const entity = entityById.get(objectTile.dataset.objectId);
      return entity ? { entity, label: entity.name } : null;
    }
    const tile = target.closest('#asset-list .asset-tile');
    if (!tile) return null;
    const control = target.closest('button, audio, input');
    if (control && control !== tile) return null;
    const asset = assetFromTile(tile);
    return asset ? { asset, label: `${asset.name} (${asset.kind})` } : null;
  }

  const external = { pointerId: null, assetId: null, entityId: null, label: '', startX: 0, startY: 0, active: false, suppressClick: false };
  function endExternalDrag() {
    const active = external.active;
    ghost.hidden = true; ghost.textContent = '';
    canvas.classList.remove('scene-drop-target');
    document.body.classList.remove('scene-dragging');
    clearDropPreview(); hideReadout();
    external.pointerId = null; external.assetId = null; external.entityId = null;
    external.active = false; external.label = '';
    if (active) {
      external.suppressClick = true;
      setTimeout(() => { external.suppressClick = false; }, 0);
    }
    return active;
  }
  function overViewport(event) {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 && event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
  }
  function pickAt(event) {
    cast(event);
    for (const hit of ray.intersectObjects(pickables, true)) {
      if (!visibleThrough(hit.object)) continue;
      const selection = selectionOf(hit.object);
      if (selection) return { hit, point: hit.point.clone(), selection };
    }
    return null;
  }
  function planDrop(pick) {
    const selection = pick?.selection || null;
    if (external.assetId) {
      const asset = (project.assets || []).find(item => item.id === external.assetId);
      if (!asset) return { error: 'That asset is no longer part of this project' };
      if (selection?.kind === 'entity') {
        const entity = entityById.get(selection.id);
        if (!entity) return { error: 'That object no longer exists' };
        if (asset.kind === 'model') {
          try { requireModelAsset(project, asset.id); } catch (error) { return { error: error.message }; }
          return { label: `Set model ${asset.name} on ${entity.name}`, highlight: selection, apply: next => applyEntityModel(next, entity.id, asset.id) };
        }
        try { requireImageAsset(project, asset.id, 'drop a sprite image instead'); } catch (error) { return { error: error.message }; }
        return { label: `Set sprite ${asset.name} on ${entity.name}`, highlight: selection, apply: next => applyEntitySprite(next, entity.id, asset.id) };
      }
      // Dropping a model anywhere else places a new decoration that already carries it.
      if (asset.kind === 'model') {
        try { requireModelAsset(project, asset.id); } catch (error) { return { error: error.message }; }
        const point = floorPointAt(pick?.point || emptyDropPoint());
        const entityId = newId('entity');
        return { label: `Place ${asset.name} at ${point.x}, ${point.y}`, highlight: selection,
          point: pick?.point || new THREE.Vector3(point.x, point.floor, point.y),
          apply: next => addEntityWithModel(next, { id: entityId, x: point.x, y: point.y, assetId: asset.id }),
          select: { kind: 'entity', id: entityId } };
      }
      if (!pick) return { error: 'Drop images on a wall, floor or ceiling' };
      const target = surfaceTargetFor(selection, pick.point);
      if (!target) return { error: 'Drop images on a wall, floor or ceiling' };
      try { requireImageAsset(project, asset.id); } catch (error) { return { error: error.message }; }
      return { label: `Apply ${asset.name} to ${describeSurfaceTarget(target)}`, highlight: selection, point: pick.point,
        apply: next => applySurfaceAsset(next, target, asset.id) };
    }
    if (external.entityId) {
      if (!pick) return { error: 'Drop objects on a wall, floor, ceiling or another object' };
      const entity = entityById.get(external.entityId);
      if (!entity) return { error: 'That object no longer exists' };
      const point = floorPointAt(pick.point);
      return { label: `Move ${entity.name} to floor ${point.floor} at ${point.x}, ${point.y}`, highlight: selection, point: pick.point,
        apply: next => moveEntityToFloor(next, entity.id, point.x, point.y) };
    }
    return { error: 'Nothing to drop' };
  }
  function updateDropPreview(event) {
    clearDropPreview(); hideReadout();
    if (!overViewport(event)) return;
    const asset = external.assetId && (project.assets || []).find(item => item.id === external.assetId);
    const pick = pickAt(event);
    if (!pick && asset?.kind !== 'model') { showReadout('Aim at a wall, floor, ceiling or object in the 3D view', 'warn'); return; }
    const plan = planDrop(pick);
    if (plan.error) { showReadout(plan.error, 'error'); return; }
    showReadout(plan.label);
    highlightDrop(plan.highlight, plan.point);
    canvas.dataset.dropPreview = plan.label;
  }

  listen(document, 'pointerdown', event => {
    if (event.button !== 0 || external.pointerId !== null) return;
    const source = dragSourceFrom(event.target);
    if (!source) return;
    external.pointerId = event.pointerId;
    external.assetId = source.asset?.id || null;
    external.entityId = source.entity?.id || null;
    external.label = source.label;
    external.startX = event.clientX; external.startY = event.clientY;
  });
  listen(document, 'pointermove', event => {
    if (external.pointerId === null || event.pointerId !== external.pointerId) return;
    if (!external.active) {
      if (Math.hypot(event.clientX - external.startX, event.clientY - external.startY) < 5) return;
      external.active = true;
      ghost.hidden = false;
      document.body.classList.add('scene-dragging');
    }
    event.preventDefault();
    ghost.textContent = external.label;
    ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
    canvas.classList.toggle('scene-drop-target', overViewport(event));
    updateDropPreview(event);
  });
  listen(document, 'pointerup', event => {
    if (external.pointerId === null || event.pointerId !== external.pointerId) return;
    const active = external.active, over = active && overViewport(event);
    let plan = null;
    if (over) plan = planDrop(pickAt(event));
    endExternalDrag();
    if (!active || !over) return;
    if (!plan) { callbacks.error('Drop targets are walls, floors, ceilings and objects in the 3D view'); return; }
    if (plan.error) { callbacks.error(plan.error); return; }
    applyEdit(plan.apply, plan.label, plan.select ? () => callbacks.select?.(plan.select) : null);
  });
  listen(document, 'pointercancel', () => { if (external.pointerId !== null) endExternalDrag(); });
  // Tiles contain images that browsers would otherwise drag natively, which cancels pointer moves.
  listen(document, 'dragstart', event => {
    if (event.target?.closest?.('#asset-list .asset-tile, [data-object-id]')) event.preventDefault();
  });
  listen(document, 'click', event => {
    if (!external.suppressClick) return;
    external.suppressClick = false;
    event.stopPropagation(); event.preventDefault();
  }, true);

  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(canvas, 'pointerdown', event => {
    if (event.button !== 0 && event.button !== 2) return;
    canvas.focus();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
    cast(event);
    if (event.button === 2) { action = { kind: 'fly', x: event.clientX, y: event.clientY }; return; }
    const tool = callbacks.tool();
    if (tool !== 'select') {
      const hit = worldHit(), point = hit?.point || planePoint(0);
      if (!point) { callbacks.error('Aim at a floor or the ground plane to place geometry'); return; }
      if (tool === 'entity') callbacks.place({ x: point.x, y: point.z, z: point.y });
      else { action = { kind: 'room', start: point.clone(), end: point.clone() }; roomOutline.visible = true; }
      return;
    }
    const axis = selected ? axisAt(event) : null;
    if (axis) {
      if (mode !== 'move' && selected.kind !== 'entity') { callbacks.error('Select an object to rotate or scale; geometry uses Move'); return; }
      action = { kind: 'transform', axis, selection: { ...selected }, x: event.clientX, y: event.clientY,
        start: handles.position.clone(), end: handles.position.clone(), baseline: project, moved: false, amount: 0 };
      canvas.dataset.transform = `transform:${axis}`;
      return;
    }
    const hit = hits(vertexGroup)[0] || worldHit();
    const selection = hit ? { ...selectionOf(hit.object) } : null;
    if (selection?.kind === 'sector') {
      selection.surface = selectionOf(hit.object)?.surface || callbacks.surface();
      callbacks.select(selection);
      if (mode === 'move') {
        action = { kind: 'surface', selection, axis: 'z', start: hit.point.clone(), x: event.clientX, y: event.clientY,
          startHeight: sectorById.get(selection.id)?.[selection.surface] ?? hit.point.y, moved: false, endHeight: null, baseline: project };
      }
      return;
    }
    callbacks.select(selection);
  });
  listen(canvas, 'pointermove', event => {
    if (!action) return;
    if (action.kind === 'fly') {
      yaw += (event.clientX - action.x) * .003;
      pitch = THREE.MathUtils.clamp(pitch - (event.clientY - action.y) * .003, -1.48, 1.48);
      action.x = event.clientX; action.y = event.clientY; return;
    }
    cast(event);
    if (action.kind === 'room') {
      const point = planePoint(action.start.y);
      if (point) { action.end.copy(point); updateRoomOutline(action.start, action.end, action.start.y + 1); }
      return;
    }
    if (action.kind === 'surface') {
      if (!action.moved && Math.hypot(event.clientX - action.x, event.clientY - action.y) < 4) return;
      action.moved = true;
      const distance = axisDistance(action.start, 'z', action.x, action.y, event.clientX, event.clientY);
      const height = snapValue(action.startHeight + distance, callbacks.grid());
      action.endHeight = height;
      const name = action.selection.surface === 'ceilingHeight' ? 'Ceiling' : 'Floor';
      showReadout(`${name} ${action.startHeight} → ${height}`);
      canvas.dataset.surfaceHeight = String(height);
      // Apply as the pointer moves: the world is rebuilt incrementally, so the
      // geometry follows the cursor instead of snapping when the button is released.
      liveDrag(action.selection, action.baseline, 'move', { x: 0, y: 0, z: height - action.startHeight }, `3D ${name.toLowerCase()} height ${height}`);
      return;
    }
    const dragDelta = event.clientX - action.x - (event.clientY - action.y);
    action.amount = dragDelta; action.moved = event.clientX !== action.x || event.clientY !== action.y;
    if (!action.moved) return;
    let delta;
    if (mode === 'move') {
      const distance = axisDistance(action.start, action.axis, action.x, action.y, event.clientX, event.clientY);
      action.end.copy(action.start).addScaledVector(AXIS_VECTORS[action.axis], distance);
      delta = { x: action.end.x - action.start.x, y: action.end.z - action.start.z, z: action.end.y - action.start.y };
      liveDrag(action.selection, action.baseline, 'move', delta, `3D move ${axisLabel(action.axis)} ${formatDistance(delta)}`);
      handles.position.copy(action.end);
    } else if (mode === 'rotate') {
      liveDrag(action.selection, action.baseline, 'rotate', { angle: dragDelta * .5 }, `3D rotate ${Math.round(dragDelta * .5)}deg`);
    } else {
      liveDrag(action.selection, action.baseline, 'scale', { scale: Math.exp(dragDelta * .01) }, `3D scale ${Math.round(Math.exp(dragDelta * .01) * 100)}%`);
    }
  });
  listen(canvas, 'pointerup', () => {
    const completed = action; action = null; keys.clear(); roomOutline.visible = false;
    canvas.dataset.transform = '';
    if (!completed || completed.kind === 'fly') return;
    if (completed.kind === 'room') { callbacks.room(completed.start, completed.end); return; }
    if (completed.kind === 'surface') {
      hideReadout();
      canvas.dataset.surfaceHeight = '';
      if (!completed.moved) { callbacks.liveFinish(null); select(callbacks.selection()); return; }
      const name = completed.selection.surface === 'ceilingHeight' ? 'ceiling' : 'floor';
      callbacks.liveFinish(`3D ${name} height ${completed.endHeight}`);
      return;
    }
    if (!completed.moved) { callbacks.liveFinish(null); select(callbacks.selection()); return; }
    callbacks.liveFinish(`3D ${mode}`);
  });
  function cancel() {
    action = null; keys.clear(); roomOutline.visible = false;
    hideReadout(); canvas.dataset.surfaceHeight = '';
    callbacks.liveFinish(null, { revert: true });
    select(callbacks.selection());
  }
  listen(canvas, 'pointercancel', cancel);
  listen(canvas, 'lostpointercapture', () => { if (action) cancel(); });
  listen(canvas, 'blur', cancel);
  listen(window, 'blur', cancel);
  listen(canvas, 'keydown', event => {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) { event.preventDefault(); keys.add(event.code); }
    if (event.code === 'Escape') cancel();
    if (event.code === 'Delete' && selected?.kind === 'entity') callbacks.remove(selected.id);
  });
  listen(canvas, 'keyup', event => keys.delete(event.code));
  listen(canvas, 'wheel', event => { event.preventDefault(); speed = THREE.MathUtils.clamp(speed * Math.exp(-event.deltaY * .001), 16, 8192); }, { passive: false });
  listen(canvas, 'dblclick', event => { cast(event); const hit = worldHit(); const target = hit && selectionOf(hit.object); if (target?.kind === 'entity') callbacks.script(target.id); });

  function updateCeilings(dt, force = false) {
    ceilingTimer -= dt;
    if (!force && ceilingTimer > 0) return;
    ceilingTimer = .1;
    let visible = 0;
    for (const entry of ceilingSurfaces) {
      entry.mesh.visible = showCeilings || camera.position.y < entry.y - 2;
      if (entry.mesh.visible) visible++;
    }
    canvas.dataset.ceilings = `${visible}/${ceilingSurfaces.length}`;
  }
  updateCeilings(0, true);

  return {
    select, fit,
    /**
     * Apply an edited project without rebuilding the renderer. Returns false when
     * the change introduces artwork that is not decoded yet, so the caller falls
     * back to a full reload for that rare case.
     */
    update(next) {
      if (!view.setProject || !view.setProject(next)) return false;
      project = next;
      state.entities = runtimeEntities(next);
      refreshProjectData();
      select(callbacks.selection(), { rebuildHandles: false });
      return true;
    },
    mode(value) { mode = value; },
    /** Engine tweaks (render resolution, FOV, brightness) apply to the editor preview too. */
    settings(values) { Object.assign(state.settings, values || {}); },
    pose() { return { position: camera.position.clone(), yaw, pitch, speed }; },
    frame(dt) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // The renderer owns the drawing-buffer size (Engine tweaks render resolution).
      camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix();
      if (action?.kind === 'fly') {
        rightVector.set(-Math.sin(yaw), 0, Math.cos(yaw));
        motionVector.copy(direction(forwardVector)).multiplyScalar(Number(keys.has('KeyW')) - Number(keys.has('KeyS')))
          .addScaledVector(rightVector, Number(keys.has('KeyD')) - Number(keys.has('KeyA')));
        motionVector.y += Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
        if (motionVector.lengthSq()) camera.position.addScaledVector(motionVector.normalize(), speed * Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1));
      }
      camera.lookAt(lookTarget.copy(camera.position).add(direction(forwardVector)));
      handles.scale.setScalar(Math.max(.2, camera.position.distanceTo(handles.position) * .98 / rect.height));
      camera.updateMatrixWorld();
      projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionView);
      handles.visible = Boolean(selected) && handles.children.length > 0 && frustum.containsPoint(handles.position);
      let markers = 0;
      for (const marker of vertexMarkers) {
        if (marker.userData.active) marker.visible = frustum.containsPoint(marker.position);
        if (marker.visible) markers++;
      }
      updateSelectionOutline();
      updateCeilings(dt);
      view.render(state);
      canvas.dataset.camera = camera.position.toArray().map(value => value.toFixed(2)).join(',');
      canvas.dataset.flySpeed = String(Math.round(speed));
      canvas.dataset.outline = selectionOutline.visible ? 'visible' : 'hidden';
      canvas.dataset.handles = handles.visible ? 'visible' : 'hidden';
      canvas.dataset.vertexMarkers = String(markers);
      // Screen positions of the gizmo and the selection box, so a drag can be
      // followed (and regression-tested) from the outside.
      canvas.dataset.handlesAt = handles.visible ? screenOf(handles.position) : '';
      canvas.dataset.outlineAt = selectionOutline.visible ? screenOf(selectionOutline.position) : '';
    },
    ceilings(visible) { showCeilings = Boolean(visible); updateCeilings(0, true); },
    dispose() {
      endExternalDrag();
      listeners.forEach(remove => remove()); clearHandles(); resources.forEach(resource => resource.dispose()); view.dispose();
    },
  };
}
