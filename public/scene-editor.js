import * as THREE from '/vendor/three/three.module.js';
import { createPreview } from './render.js';
import { createRuntime } from '/shared/runtime.js';
import { sectorAt, sectorGeometry } from '/shared/sectors.js';
import { transformSelection } from '/shared/scene-edit.js';

export async function createSceneEditor(canvas, project, callbacks, pose) {
  const state = createRuntime(project);
  state.animations.clear();
  const view = await createPreview(canvas, project, state, { editor: true });
  const { scene, camera, renderer } = view;
  const sectors = sectorGeometry(project), ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const handles = new THREE.Group(), vertices = new THREE.Group();
  scene.add(handles, vertices);
  const roomGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 5 }, () => new THREE.Vector3()));
  const roomMaterial = new THREE.LineBasicMaterial({ color: '#8ce0a6', depthTest: false });
  const roomOutline = new THREE.Line(roomGeometry, roomMaterial); roomOutline.renderOrder = 200; roomOutline.visible = false; scene.add(roomOutline);
  const resources = [], keys = new Set(), listeners = [];
  let selected = null, action = null, speed = pose?.speed || 320, yaw = pose?.yaw ?? 0, pitch = pose?.pitch ?? -.65;
  let mode = 'move';
  const vertexGeometry = new THREE.SphereGeometry(4, 6, 4);
  const vertexMaterial = new THREE.MeshBasicMaterial({ color: '#f3da86', depthTest: false });
  resources.push(vertexGeometry, vertexMaterial, roomGeometry, roomMaterial);
  const vertexHeights = new Map();
  const sectorById = new Map(sectors.map(sector => [sector.id, sector]));
  for (const wall of project.map.walls) for (const side of [wall.right, wall.left]) {
    const floor = sectorById.get(side?.sectorId)?.floorHeight;
    if (floor === undefined) continue;
    for (const id of [wall.a, wall.b]) vertexHeights.set(id, Math.min(vertexHeights.get(id) ?? Infinity, floor));
  }
  for (const vertex of project.map.vertices) {
    const marker = new THREE.Mesh(vertexGeometry, vertexMaterial);
    marker.position.set(vertex.x, (vertexHeights.get(vertex.id) || 0) + 4, vertex.y);
    marker.userData.selection = { kind: 'vertex', id: vertex.id };
    marker.renderOrder = 100; vertices.add(marker);
  }
  function fit() {
    const bounds = new THREE.Box3();
    project.map.vertices.forEach(vertex => bounds.expandByPoint(new THREE.Vector3(vertex.x, 0, vertex.y)));
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const distance = Math.max(256, Math.max(size.x, size.z) * .75);
    camera.position.set(center.x - distance, distance, center.z);
    yaw = 0; pitch = -.65;
  }
  if (pose) camera.position.copy(pose.position); else fit();
  function direction() { return new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)); }
  function listen(target, name, fn, options) {
    target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options));
  }
  function cast(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateMatrixWorld(); scene.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
  }
  function hits(group) { return ray.intersectObjects(group.children, true).filter(hit => hit.object.visible); }
  function selectionOf(object) {
    for (let node = object; node; node = node.parent) if (node.userData.selection) return node.userData.selection;
    return null;
  }
  function worldHit() {
    return ray.intersectObjects(scene.children, true).find(hit => hit.object.visible && selectionOf(hit.object) && !vertices.children.includes(hit.object));
  }
  function planePoint(height) {
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), new THREE.Vector3());
  }
  function clearHandles() {
    for (const child of [...handles.children]) { handles.remove(child); child.geometry.dispose(); child.material.dispose(); }
  }
  function select(selection) {
    selected = selection; clearHandles();
    if (!selected) return;
    const { kind, id } = selected;
    let position;
    if (kind === 'entity') {
      const entity = project.map.entities.find(entity => entity.id === id);
      position = new THREE.Vector3(entity.x, (sectorAt(sectors, entity.x, entity.y)?.floorHeight || 0) + (entity.elevation || 0), entity.y);
    } else if (kind === 'vertex') {
      const vertex = project.map.vertices.find(vertex => vertex.id === id); position = new THREE.Vector3(vertex.x, (vertexHeights.get(id) || 0) + 4, vertex.y);
    } else if (kind === 'wall') {
      const wall = project.map.walls.find(wall => wall.id === id);
      const a = project.map.vertices.find(vertex => vertex.id === wall.a), b = project.map.vertices.find(vertex => vertex.id === wall.b);
      position = new THREE.Vector3((a.x + b.x) / 2, 32, (a.y + b.y) / 2);
    } else {
      const sector = sectors.find(sector => sector.id === id);
      position = new THREE.Vector3((sector.bounds.minX + sector.bounds.maxX) / 2, sector[selected.surface || 'floorHeight'], (sector.bounds.minY + sector.bounds.maxY) / 2);
      if (!Number.isFinite(position.x)) return;
    }
    handles.position.copy(position);
    const axes = kind === 'sector' ? ['z'] : kind === 'vertex' || kind === 'wall' ? ['x', 'y'] : ['x', 'y', 'z'];
    for (const axis of axes) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? 50 : 6, axis === 'z' ? 50 : 6, axis === 'y' ? 50 : 6),
        new THREE.MeshBasicMaterial({ color: axis === 'x' ? '#ef7777' : axis === 'y' ? '#7baaff' : '#85da85', depthTest: false }));
      mesh.position.set(axis === 'x' ? 25 : 0, axis === 'z' ? 25 : 0, axis === 'y' ? 25 : 0);
      mesh.userData.axis = axis; mesh.renderOrder = 200; handles.add(mesh);
    }
  }
  function applyEdit(fn, message) {
    try { callbacks.edit(fn, message); } catch (error) { callbacks.error(error.message); cancel(); }
  }
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(canvas, 'pointerdown', event => {
    if (event.button !== 0 && event.button !== 2) return;
    canvas.focus(); canvas.setPointerCapture(event.pointerId); cast(event);
    if (event.button === 2) { action = { kind: 'fly', x: event.clientX, y: event.clientY }; return; }
    const tool = callbacks.tool();
    if (tool !== 'select') {
      const hit = worldHit(), point = hit?.point || planePoint(0);
      if (!point) { callbacks.error('Aim at a floor or the ground plane to place geometry'); return; }
      if (tool === 'entity') callbacks.place({ x: point.x, y: point.z, z: point.y });
      else { action = { kind: 'room', start: point.clone(), end: point.clone() }; roomOutline.visible = true; }
      return;
    }
    const handle = hits(handles)[0];
    if (handle && selected) {
      if (mode !== 'move' && selected.kind !== 'entity') { callbacks.error('Select an object to rotate or scale; geometry uses Move'); return; }
      action = { kind: 'transform', axis: handle.object.userData.axis, selection: { ...selected }, x: event.clientX, y: event.clientY, start: handles.position.clone(), end: handles.position.clone() };
      return;
    }
    const hit = hits(vertices)[0] || worldHit();
    const selection = hit ? { ...selectionOf(hit.object) } : null;
    if (selection?.kind === 'sector') selection.surface = callbacks.surface();
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
      if (point) {
        action.end.copy(point);
        const a = action.start, b = action.end, y = a.y + 1;
        roomGeometry.setFromPoints([new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, a.z),
          new THREE.Vector3(b.x, y, b.z), new THREE.Vector3(a.x, y, b.z), new THREE.Vector3(a.x, y, a.z)]);
        roomGeometry.computeBoundingSphere();
      }
      return;
    }
    const delta = event.clientX - action.x - (event.clientY - action.y);
    action.amount = delta; action.moved = event.clientX !== action.x || event.clientY !== action.y;
    if (mode === 'move') {
      const vector = action.axis === 'x' ? new THREE.Vector3(1, 0, 0) : action.axis === 'y' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const origin = action.start.clone().project(camera);
      const tip = action.start.clone().addScaledVector(vector, 50).project(camera);
      const rect = canvas.getBoundingClientRect(), dx = (tip.x - origin.x) * rect.width / 2, dy = -(tip.y - origin.y) * rect.height / 2;
      const length = dx * dx + dy * dy;
      const distance = length > 1 ? ((event.clientX - action.x) * dx + (event.clientY - action.y) * dy) / length * 50 : -(event.clientY - action.y);
      action.end.copy(action.start).addScaledVector(vector, distance);
      handles.position.copy(action.end);
      const entity = state.entities.find(entity => action.selection.kind === 'entity' && entity.id === action.selection.id);
      if (entity) {
        const original = project.map.entities.find(entity => entity.id === action.selection.id);
        entity.x = original.x + action.end.x - action.start.x; entity.y = original.y + action.end.z - action.start.z;
        entity.z = action.end.y;
      }
    } else {
      const entity = state.entities.find(entity => action.selection.kind === 'entity' && entity.id === action.selection.id);
      if (entity) {
        const original = project.map.entities.find(entity => entity.id === action.selection.id);
        if (mode === 'rotate') entity.angle = original.angle + delta * .5;
        else {
          const key = original.modelAsset ? 'modelScale' : 'spriteScale';
          entity[key] = Math.max(original.modelAsset ? .001 : .05, Math.min(original.modelAsset ? 4096 : 16,
            (original[key] ?? (original.modelAsset ? 32 : 1)) * Math.exp(delta * .01)));
        }
      }
    }
  });
  listen(canvas, 'pointerup', () => {
    const completed = action; action = null; keys.clear(); roomOutline.visible = false;
    if (!completed || completed.kind === 'fly') return;
    if (completed.kind === 'room') { callbacks.room(completed.start, completed.end); return; }
    if (!completed.moved) { select(callbacks.selection()); return; }
    const delta = completed.end.clone().sub(completed.start);
    applyEdit(next => transformSelection(next, completed.selection, mode, {
      x: delta.x, y: delta.z, z: delta.y, angle: completed.amount * .5, scale: Math.exp(completed.amount * .01),
    }, callbacks.grid()), `3D ${mode}`);
  });
  function cancel() {
    action = null; keys.clear(); roomOutline.visible = false;
    state.entities = structuredClone(project.map.entities);
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
  return {
    select, fit,
    mode(value) { mode = value; },
    pose() { return { position: camera.position.clone(), yaw, pitch, speed }; },
    frame(dt) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) renderer.setSize(Math.round(rect.width), Math.round(rect.height), false);
      camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix();
      if (action?.kind === 'fly') {
        const forward = direction(), right = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
        const motion = forward.multiplyScalar(Number(keys.has('KeyW')) - Number(keys.has('KeyS')))
          .addScaledVector(right, Number(keys.has('KeyD')) - Number(keys.has('KeyA')));
        motion.y += Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
        if (motion.lengthSq()) camera.position.addScaledVector(motion.normalize(), speed * Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1));
      }
      camera.lookAt(camera.position.clone().add(direction()));
      handles.scale.setScalar(Math.max(.2, camera.position.distanceTo(handles.position) * .98 / rect.height));
      view.render(state);
      canvas.dataset.camera = camera.position.toArray().map(value => value.toFixed(2)).join(',');
      canvas.dataset.flySpeed = String(Math.round(speed));
    },
    ceilings(visible) {
      scene.traverse(object => { if (object.userData.selection?.surface === 'ceilingHeight') object.visible = visible; });
    },
    dispose() {
      listeners.forEach(remove => remove()); clearHandles(); resources.forEach(resource => resource.dispose()); view.dispose();
    },
  };
}
