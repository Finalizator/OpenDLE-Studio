import * as THREE from '/vendor/three/three.module.js';
import { createPreview } from './render.js';
import { selectionAtTriangle } from '/shared/surface-batch.js';
import { createRuntime, runtimeEntities } from '/shared/runtime.js';
import { newId } from '/shared/project.js';
import { sectorAt, sectorGeometry } from '/shared/sectors.js';
import { dragSelection } from '/shared/scene-edit.js';
import {
  addEntityWithModel, applyEntityModel, applyEntitySprite, applySurfaceAsset, describeSurfaceTarget,
  moveEntityToFloor, requireImageAsset, requireModelAsset, resolveWallSide, sectorTarget, snapValue,
  wallPartAt, wallTarget,
} from './editor-drop.js';
import { areaVolume, overlayVolumes } from '/shared/areas.js';
import { instantiateScene, sceneIsEmpty } from '/shared/scenes.js';
import { samplePath } from '/shared/paths.js';
import {
  GIZMO_LENGTH, axisAmount, axisByKey, axisDirection, axisField, dragPlaneNormal, formSizeFromDrag,
  rayPlaneHit, ringDegrees, ringDelta, scaleFactorFromDrag, screenAngle,
} from '/shared/gizmo-math.js';
import { buildFormFaces, buildGizmo, disposeHandles, paintHandles } from './gizmo.js';

const SELECT_COLOR = '#ffd34d', DROP_COLOR = '#7fe6ff';
/** How long a gizmo arm should be on screen, as a share of the viewport's shorter side. */
const GIZMO_ARM_FRACTION = .15;

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
  // Form resizes a volume by its own faces, which live at the volume's edges rather than on the
  // object's origin, and are the volume's real size rather than a fixed screen size — so they are
  // not part of the scaled `handles` group.
  const faceGroup = new THREE.Group();
  faceGroup.visible = false;
  // Paths are drawn as their curve, not as their waypoints: the line a traveller follows is the
  // thing being authored, and the control points are what shape it.
  const pathGroup = new THREE.Group();
  scene.add(handles, helperGroup, vertexGroup, pathGroup, faceGroup);
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

  // Interaction areas and colliders are wireframes over the world: they show what a
  // "player entered area" event and the physics body actually cover.
  const overlayGroup = new THREE.Group();
  overlayGroup.renderOrder = 204; overlayGroup.frustumCulled = false;
  helperGroup.add(overlayGroup);
  const overlayColours = { area: '#ffb45c', areaSelected: '#ffe6a8', physicsFixed: '#8fa6ff', physicsDynamic: '#7fe6a0',
    physicsKinematic: '#d6b3ff', sensor: '#79d7ff', player: '#ffd34d' };
  const overlayMaterials = new Map();
  function overlayMaterial(colour) {
    let material = overlayMaterials.get(colour);
    if (!material) {
      material = own(new THREE.LineBasicMaterial({ color: colour, depthTest: true, transparent: true, opacity: .9 }));
      overlayMaterials.set(colour, material);
    }
    return material;
  }
  let showAreas = false, showPhysics = false, overlaySignature = '';
  function rebuildOverlays() {
    for (const child of [...overlayGroup.children]) {
      overlayGroup.remove(child);
      if (child.userData.temporary && child.geometry) child.geometry.dispose();
    }
    if (!showAreas && !showPhysics) { overlaySignature = ''; canvas.dataset.overlayShapes = '0'; return; }
    const plans = overlayVolumes(project.map.entities, { areas: showAreas, physics: showPhysics, player: showPhysics },
      entity => sectorAt(sectors, entity.x, entity.y)?.floorHeight ?? 0, selected?.kind === 'entity' ? selected.id : null);
    for (const plan of plans) {
      const colour = plan.kind === 'area' ? (plan.selected ? overlayColours.areaSelected : overlayColours.area)
        : plan.kind === 'player' ? overlayColours.player
        : plan.sensor ? overlayColours.sensor : overlayColours[`physics${plan.body[0].toUpperCase()}${plan.body.slice(1)}`] || overlayColours.physicsFixed;
      const size = [plan.half.width * 2, plan.half.height * 2, plan.half.depth * 2];
      let geometry;
      if (plan.shape === 'box') geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      else if (plan.shape === 'sphere') geometry = new THREE.SphereGeometry(plan.radius, 12, 8);
      else geometry = new THREE.CapsuleGeometry(plan.radius, Math.max(.01, size[1] - plan.radius * 2), 4, 10);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), overlayMaterial(colour));
      geometry.dispose();
      lines.userData.temporary = true;
      // Map space is (x, y) with z up; the scene draws it as (x, height, y).
      lines.position.set(plan.center.x, plan.center.z, plan.center.y);
      lines.renderOrder = 204; lines.frustumCulled = false;
      overlayGroup.add(lines);
    }
    canvas.dataset.overlayShapes = String(plans.length);
  }
  function overlayKey() {
    if (!showAreas && !showPhysics) return '';
    const selectedId = selected?.kind === 'entity' ? selected.id : '';
    return `${showAreas}/${showPhysics}/${selectedId}/` + project.map.entities.map(entity =>
      `${entity.id}:${entity.x},${entity.y},${entity.elevation || 0}:${entity.area ? `${entity.area.shape}/${entity.area.width}/${entity.area.height}/${entity.area.depth}/${entity.area.radius}` : ''}:${entity.physics && entity.physics.body !== 'none' ? `${entity.physics.body}/${entity.physics.shape}/${entity.physics.width}/${entity.physics.height}/${entity.physics.depth}/${entity.physics.radius}` : ''}`
    ).join('|');
  }
  // One curve per path, rebuilt whenever the layout changes. The line is what the mapper
  // shapes; the small cubes are the waypoints that shape it.
  const PATH_COLOR = '#b18cff', PATH_SELECTED = '#ffffff';
  const pathLineMaterial = own(new THREE.LineBasicMaterial({ color: PATH_COLOR, depthTest: false, transparent: true, opacity: .95 }));
  const pathLineSelectedMaterial = own(new THREE.LineBasicMaterial({ color: PATH_SELECTED, depthTest: false }));
  const pathPointGeometry = own(new THREE.BoxGeometry(6, 6, 6));
  const pathPointMaterial = own(new THREE.MeshBasicMaterial({ color: PATH_COLOR, depthTest: false }));
  const pathPointSelectedMaterial = own(new THREE.MeshBasicMaterial({ color: PATH_SELECTED, depthTest: false }));
  let pathSignature = '';
  /** A path's own update key: any change to a waypoint or its curvature invalidates it. */
  function pathsSignature() {
    return (project.paths || []).map(path => `${path.id}:${path.closed ? 1 : 0}:` +
      path.points.map(point => `${point.id}@${point.x},${point.y},${point.z || 0},${point.curve ?? 1}`).join(';')).join('|') +
      `#${selected?.kind === 'pathPoint' || selected?.kind === 'path' ? `${selected.kind}:${selected.id}` : ''}`;
  }
  /**
   * Rebuilds the drawn paths.
   *
   * Sampled at the same density the engine uses for travel, so what the editor shows is what a
   * walker will follow. Points are drawn in map space (x, height, y) to match the world, and the
   * overlay ignores depth so a path inside a wall is still visible while it is being authored.
   */
  function rebuildPaths() {
    const signature = pathsSignature();
    if (signature === pathSignature) return;
    pathSignature = signature;
    for (const child of [...pathGroup.children]) {
      pathGroup.remove(child);
      if (child.geometry && child.geometry !== pathPointGeometry) child.geometry.dispose();
    }
    for (const path of project.paths || []) {
      const samples = samplePath(path);
      if (samples.length > 1) {
        const positions = new Float32Array(samples.length * 3);
        samples.forEach((sample, index) => {
          positions[index * 3] = sample.x; positions[index * 3 + 1] = sample.z || 0; positions[index * 3 + 2] = sample.y;
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const line = new THREE.Line(geometry, selected?.kind === 'path' && selected.id === path.id ? pathLineSelectedMaterial : pathLineMaterial);
        line.renderOrder = 207; line.frustumCulled = false;
        pathGroup.add(line);
      }
      for (const point of path.points) {
        const isSelected = selected?.kind === 'pathPoint' && selected.id === point.id && selected.pathId === path.id;
        const marker = new THREE.Mesh(pathPointGeometry, isSelected ? pathPointSelectedMaterial : pathPointMaterial);
        marker.position.set(point.x, point.z || 0, point.y);
        marker.renderOrder = 208; marker.frustumCulled = false;
        marker.userData.selection = { kind: 'pathPoint', id: point.id, pathId: path.id };
        marker.userData.pathPoint = true;
        pathGroup.add(marker);
      }
    }
    pathGroup.visible = (project.paths || []).length > 0;
    canvas.dataset.paths = String((project.paths || []).length);
    canvas.dataset.pathPoints = String((project.paths || []).reduce((total, path) => total + path.points.length, 0));
  }

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
  // Whether the selection is a volume (a zone, or an object with an interaction area), which is
  // what makes Form and volume scaling mean something.
  let hasVolume = false;
  // What the gizmo is currently showing, so a live drag's re-select does not rebuild it every
  // frame: the mode and the axes are the whole of it.
  let handleAxes = [], handleSignature = '', faceSignature = '', hoverAxis = null;
  let vertexHeights = new Map();
  let pickables = [];
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
    pickables = [];
    for (const child of scene.children) {
      if (child === handles || child === faceGroup || child === helperGroup || child === vertexGroup || child === roomOutline || child === pathGroup) continue;
      child.traverse(object => {
        // The static world is drawn from merged buffers, so a world mesh names the wall
        // or sector it belongs to per triangle instead of holding one selection itself.
        if (!object.userData.selection && !object.userData.selectionRanges?.length) return;
        pickables.push(object);
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
    rebuildPaths();
  }
  vertexHeights = collectVertexHeights();
  collectSceneHandles();
  rebuildPaths();

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

  /**
   * Frame the room: a three-quarter view from outside it, far enough that it fits the view.
   *
   * The old rule put the camera at (centre - d, d, centre) and looked along +x, where d was three
   * quarters of the room's longest side. That is a side-on view from a height equal to the room's
   * size, so a large room was framed from thousands of units away and edge-on at that: the room
   * was a sliver at the edge of the picture, which reads as "the camera is very far away". Fit by
   * the bounding sphere and the field of view instead, and point the camera at the centre.
   */
  function fit() {
    const fitBounds = new THREE.Box3();
    const floors = (project.map.sectors || []).map(sector => sector.floorHeight);
    const ceilings = (project.map.sectors || []).map(sector => sector.ceilingHeight);
    const bottom = floors.length ? Math.min(...floors) : 0;
    const top = ceilings.length ? Math.max(...ceilings) : 128;
    const corners = project.map.vertices.map(vertex => new THREE.Vector3(vertex.x, bottom, vertex.y));
    for (const entity of project.map.entities) corners.push(new THREE.Vector3(entity.x, bottom + (entity.elevation || 0), entity.y));
    if (!corners.length) corners.push(new THREE.Vector3());
    for (const corner of corners) fitBounds.expandByPoint(corner);
    fitBounds.max.y = top;
    const center = fitBounds.getCenter(new THREE.Vector3()), size = fitBounds.getSize(new THREE.Vector3());
    // The sphere around the room has to fit the vertical field of view; the horizontal one is
    // wider at this aspect, so the vertical angle is the one that decides the distance.
    const radius = Math.max(64, size.length() / 2);
    const fieldOfView = (camera.fov || 70) * Math.PI / 180;
    let distance = Math.max(256, radius / Math.sin(fieldOfView / 2));
    yaw = -Math.PI * .75; pitch = -.55;
    const look = direction(new THREE.Vector3());
    const corners3d = [
      [fitBounds.min.x, fitBounds.min.y, fitBounds.min.z], [fitBounds.max.x, fitBounds.min.y, fitBounds.min.z],
      [fitBounds.min.x, fitBounds.max.y, fitBounds.min.z], [fitBounds.max.x, fitBounds.max.y, fitBounds.min.z],
      [fitBounds.min.x, fitBounds.min.y, fitBounds.max.z], [fitBounds.max.x, fitBounds.min.y, fitBounds.max.z],
      [fitBounds.min.x, fitBounds.max.y, fitBounds.max.z], [fitBounds.max.x, fitBounds.max.y, fitBounds.max.z],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    // The bounding sphere is bigger than the room, so fit the eight corners of the box instead:
    // aim the camera, project them, and pull in to whatever makes the widest one just fit. The
    // camera is oriented by the frame loop, not here, so it has to be aimed before projecting or
    // the corners are measured through a camera that is looking somewhere else entirely.
    const projected = new THREE.Vector3();
    const aim = () => {
      camera.position.copy(center).addScaledVector(look, -distance);
      camera.lookAt(lookTarget.copy(camera.position).add(look));
      camera.updateMatrixWorld();
    };
    for (let pass = 0; pass < 2; pass++) {
      aim();
      let worst = 0;
      for (const corner of corners3d) {
        projected.copy(corner).project(camera);
        worst = Math.max(worst, Math.abs(projected.x), Math.abs(projected.y));
      }
      // Only ever pull in: a corner measured behind the camera reads as huge, and growing the
      // distance on that is how the camera ended up thousands of units away from the room.
      if (!(worst > 0) || !Number.isFinite(worst) || worst >= 1) break;
      distance = Math.max(64, distance * worst * 1.08);
    }
    aim();
    // A room can be bigger than the far plane that was set for gameplay.
    if (camera.far < distance + radius * 4) { camera.far = distance + radius * 4; camera.updateProjectionMatrix(); }
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
  /**
   * What a raycast hit belongs to. A merged world mesh holds every wall and sector that
   * shares its material, so the triangle the ray hit decides which one it was.
   */
  function selectionOf(hit) {
    const object = hit?.object;
    if (!object) return null;
    const ranges = object.userData.selectionRanges;
    const selection = ranges
      ? selectionAtTriangle(ranges, hit.faceIndex)
      : parentSelection(object);
    // A ceiling cut away by the shader is still geometry to a raycast, so a click where
    // the room is open must fall through to whatever is under it.
    if (selection?.kind === 'sector' && selection.surface === 'ceilingHeight' && !ceilingDrawn(selection.id)) return null;
    return selection;
  }
  function parentSelection(object) {
    for (let node = object; node; node = node.parent) if (node.userData.selection) return node.userData.selection;
    return null;
  }
  /** The same rule the ceiling shader cut uses, so picking and drawing agree. */
  function ceilingDrawn(id) {
    if (showCeilings) return true;
    const sector = sectorById.get(id);
    return sector ? camera.position.y < sector.ceilingHeight - 2 : true;
  }
  function worldHit() {
    for (const hit of ray.intersectObjects(pickables, true)) if (visibleThrough(hit.object) && selectionOf(hit)) return hit;
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
        // A volume is what the object is — a zone has no artwork at all, and an object with an
        // interaction area is defined by it — so its outline is the volume itself rather than a
        // guess sized from a sprite it may not have.
        const floor = sectorAt(sectors, entity.x, entity.y)?.floorHeight ?? 0;
        const volume = entity.area ? areaVolume(entity, floor) : null;
        if (volume) {
          box.set(
            new THREE.Vector3(volume.center.x - volume.half.width, volume.center.z - volume.half.height, volume.center.y - volume.half.depth),
            new THREE.Vector3(volume.center.x + volume.half.width, volume.center.z + volume.half.height, volume.center.y + volume.half.depth));
          return box;
        }
        // Anything that is actually drawn knows its own extent — a model from its
        // geometry, a sprite from its quad, which also carries the artwork's vertical
        // anchor. Only an object with nothing drawn falls back to a guess.
        const rendered = view.boundsOfEntity?.(entity.id);
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
    disposeHandles([...handles.children]);
    handleAxes = [];
  }
  /**
   * Builds the gizmo for what is selected and what the tool is.
   *
   * Godot's three sets of handles, one per mode: arrows along the axes to move, a ring about each
   * axis to turn, and a shaft with a box on the end to scale. They are rebuilt only when the mode
   * or the axis list changes, because a live drag re-selects on every frame.
   */
  function buildHandles(axes) {
    clearHandles();
    handleAxes = [...axes];
    for (const mesh of buildGizmo(mode, axes)) handles.add(mesh);
    hideHover();
  }
  function hideHover() {
    hoverAxis = null;
    paintHandles([...handles.children], null);
    canvas.dataset.gizmoHover = '';
  }
  /** The volume being formed, or null: Form needs a box, because it is its faces that are dragged. */
  function formVolume() {
    if (mode !== 'form' || !hasVolume || selected?.kind !== 'entity') return null;
    const entity = entityById.get(selected.id);
    if (!entity?.area) return null;
    const volume = areaVolume(entity, sectorAt(sectors, entity.x, entity.y)?.floorHeight ?? 0);
    return volume?.shape === 'box' ? volume : null;
  }
  /**
   * Puts the volume's faces where the volume is.
   *
   * A live form drag changes the size on every frame, so the plates are rebuilt from the volume
   * signature rather than once when the selection changes — otherwise the plate under the pointer
   * would stay the size it had when the drag began.
   */
  function syncFormFaces() {
    const volume = formVolume();
    if (!volume) {
      if (faceGroup.children.length) { disposeHandles([...faceGroup.children]); }
      faceGroup.visible = false;
      faceSignature = '';
      canvas.dataset.formFaces = '0';
      return;
    }
    const entity = entityById.get(selected.id);
    const signature = [entity.id, volume.half.width, volume.half.depth, volume.half.height,
      volume.center.x, volume.center.z, volume.center.y, volume.angle].map(value => Number(value.toFixed ? value.toFixed(2) : value)).join('/');
    if (signature !== faceSignature) {
      disposeHandles([...faceGroup.children]);
      faceSignature = signature;
      for (const mesh of buildFormFaces(volume)) faceGroup.add(mesh);
      canvas.dataset.formFaces = String(faceGroup.children.length);
    }
    faceGroup.position.set(volume.center.x, volume.center.z, volume.center.y);
    faceGroup.rotation.set(0, -(Number(entity.angle) || 0) * Math.PI / 180, 0);
    faceGroup.visible = true;
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
    // The highlighted volume follows the selection, including when nothing is selected.
    if (showAreas || showPhysics) rebuildOverlays();
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
    } else if (kind === 'pathPoint') {
      // A waypoint gets the same three axis arrows as an object, because dragging one is how a
      // route is shaped: the arrows move that waypoint and the curve follows it. It has no
      // bounding box of its own, so only the position below is used.
      rebuildPaths();
      const path = (project.paths || []).find(item => item.id === selected.pathId);
      const point = path?.points.find(item => item.id === id);
      if (!point) { clearHandles(); return; }
      hideReadout();
      position = new THREE.Vector3(point.x, point.z || 0, point.y);
    } else if (kind === 'path') {
      // A whole path is edited through its waypoints and its inspector: three bars at one
      // waypoint would suggest that dragging there moves the entire route.
      rebuildPaths();
      const path = (project.paths || []).find(item => item.id === id);
      if (!path) { clearHandles(); return; }
      canvas.dataset.sceneSelection = `${kind}:${id}`;
      hideReadout();
      const anchor = path.points[0];
      handles.position.set(anchor?.x ?? 0, anchor?.z || 0, anchor?.y ?? 0);
      selectionOutline.visible = false; clearHandles();
      return;
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
    syncFormFaces();
    const axes = axesFor(kind);
    const signature = `${mode}/${axes.join()}`;
    if (rebuildHandles || signature !== handleSignature) { handleSignature = signature; buildHandles(axes); }
    canvas.dataset.sceneSelection = `${kind}:${id}${selected.surface ? `:${selected.surface}` : ''}`;
  }
  /**
   * One side of the selected object's volume, in map units.
   *
   * A bar drags one side of the volume, so the size it grows from has to be the size the object
   * had — read from the project, not from the handle, because the handle only knows where the
   * middle is.
   */
  function areaSizeOf(id, axis) {
    const entity = project.map.entities.find(item => item.id === id);
    const area = entity?.area || {};
    return Number(area[axisField(axis)]) || 128;
  }
  function applyEdit(fn, message, after) {
    try { callbacks.edit(fn, message); after?.(); } catch (error) { callbacks.error(error.message); cancel(); }
  }

  function screenXY(point) {
    const rect = canvas.getBoundingClientRect(), projected = point.clone().project(camera);
    return [(projected.x * .5 + .5) * rect.width, (-.5 * projected.y + .5) * rect.height];
  }
  function screenOf(point) {
    const [x, y] = screenXY(point);
    return `${Math.round(x)},${Math.round(y)}`;
  }
  const pointerXY = event => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  /** Paints the volume's faces, so the one under the pointer or in hand is the obvious one. */
  function paintFaces(key = null) {
    paintHandles([...faceGroup.children], key, { faces: true });
    canvas.dataset.formHover = key || '';
  }
  /**
   * Lights up the handle or the face under the pointer.
   *
   * Godot does this, and it is not decoration: an arrow pointing at the camera is a square you
   * cannot tell apart from the one beside it until it tells you which axis it is.
   */
  function updateHover(event) {
    if (!handles.visible && !faceGroup.visible) return;
    cast(event);
    const face = faceAt(event);
    const faceKey = face ? `${face.axis}${face.side > 0 ? '+' : '-'}` : null;
    paintFaces(faceKey);
    const axis = face ? null : hits(handles)[0]?.object.userData.axis || null;
    if (axis !== hoverAxis) { hoverAxis = axis; paintHandles([...handles.children], axis); }
    canvas.dataset.gizmoHover = axis || faceKey || '';
  }
  /**
   * Which handles the gizmo shows.
   *
   * A zone is a volume: in Rotate it gets only the ground ring, because a tilted trigger volume
   * would change nothing a rule tests, and in Form it gets its own faces instead of arrows. A
   * surface only moves vertically, and a waypoint only ever moves — so a tool that would do
   * nothing draws nothing, rather than an arrow that turns out to be inert.
   */
  function axesFor(kind) {
    if (kind === 'pathPoint') return mode === 'move' ? ['x', 'y', 'z'] : [];
    if (kind === 'sector') return mode === 'move' ? ['y'] : [];
    if (kind === 'vertex' || kind === 'wall') return mode === 'move' ? ['x', 'z'] : [];
    if (mode === 'form' && formVolume()) return [];
    if (mode === 'rotate' && hasVolume) return ['y'];
    return ['x', 'y', 'z'];
  }
  /**
   * The axis a press should drag.
   *
   * Godot's handles are thin and their middle is empty, so a press near the gizmo's centre grabs
   * the axis whose line the pointer is closest to instead of doing nothing.
   */
  function axisAt(event) {
    const hit = hits(handles)[0];
    if (hit?.object.userData.axis) return hit.object.userData.axis;
    if (!handles.visible || !handleAxes.length) return null;
    const rect = canvas.getBoundingClientRect();
    const [sx, sy] = screenOf(handles.position).split(',').map(Number);
    const distance = Math.hypot(event.clientX - rect.left - sx, event.clientY - rect.top - sy);
    return distance <= 14 ? nearestAxis(event) : null;
  }
  /** Which axis line the pointer is closest to, for grabbing the gizmo by its middle. */
  function nearestAxis(event) {
    const rect = canvas.getBoundingClientRect();
    const origin = handles.position.clone().project(camera);
    const ox = (origin.x * .5 + .5) * rect.width, oy = (-origin.y * .5 + .5) * rect.height;
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const span = GIZMO_LENGTH * handles.scale.x;
    let best = null;
    for (const axis of handleAxes) {
      const tip = handles.position.clone().add(new THREE.Vector3(...axisDirection(axis)).multiplyScalar(span)).project(camera);
      const dx = (tip.x * .5 + .5) * rect.width - ox, dy = (-tip.y * .5 + .5) * rect.height - oy;
      const size = Math.hypot(dx, dy) || 1;
      const distance = Math.abs(dx * (py - oy) - dy * (px - ox)) / size;
      if (!best || distance < best.distance) best = { axis, distance };
    }
    return best?.axis || handleAxes[0] || null;
  }
  /** The face of the formed volume under the pointer, if there is one. */
  function faceAt(event) {
    if (!faceGroup.visible) return null;
    const hit = hits(faceGroup)[0];
    return hit?.object.userData.face || null;
  }

  /** Where the view is pointing, which is what decides the plane a drag is measured on. */
  function viewDirection() {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    return direction.toArray();
  }
  /**
   * What a drag along an axis needs, captured when the pointer goes down.
   *
   * `press` is where the pointer gripped the drag plane and `origin` is where that plane sits:
   * both are kept, because the object moves while the plane it is measured on must not.
   */
  function axisDragStart(event, origin, axis) {
    const normal = dragPlaneNormal(viewDirection());
    const press = normal ? rayPlaneHit(origin.toArray(), normal, ray.ray.origin.toArray(), ray.ray.direction.toArray()) : null;
    return { axis, origin: origin.toArray(), normal, press };
  }
  /**
   * How far the pointer has travelled along the axis since it went down.
   *
   * Read off the drag plane, so the grabbed point follows the pointer exactly. When the axis is
   * aimed straight at the camera there is no such plane, and the drag borrows the screen
   * projection of the axis instead.
   */
  function dragAlong(event, drag) {
    if (!drag.normal || !drag.press) return 0;
    const hit = rayPlaneHit(drag.origin, drag.normal, ray.ray.origin.toArray(), ray.ray.direction.toArray());
    return axisAmount(hit, drag.press, axisDirection(drag.axis));
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

  /** The floor point under the pointer, for placing a copy where the user is looking. */
  function pointUnderPointer() {
    if (!lastPointer) return null;
    const pick = pickAt(lastPointer);
    if (pick) return floorPointAt(pick.point);
    return floorPointAt({ ...emptyDropPoint() });
  }

  function assetFromTile(tile) {
    const list = tile.closest('#asset-list');
    if (!list) return null;
    // The tile carries its asset id, which is exact; the position match below is the
    // fallback for tiles rendered before that attribute existed.
    if (tile.dataset.assetId) {
      const byId = (project.assets || []).find(asset => asset.id === tile.dataset.assetId);
      if (byId) return byId;
    }
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
    if (tile.dataset.sceneId) {
      const scene = (project.scenes || []).find(item => item.id === tile.dataset.sceneId);
      return scene ? { scene, label: `${scene.name} (scene)` } : null;
    }
    const asset = assetFromTile(tile);
    return asset ? { asset, label: `${asset.name} (${asset.kind})` } : null;
  }

  const external = { pointerId: null, assetId: null, entityId: null, sceneId: null, label: '', startX: 0, startY: 0, active: false, suppressClick: false };
  // Where the pointer last was over the viewport, so a pasted object lands where the user is
  // looking rather than at an arbitrary offset.
  let lastPointer = null;
  function endExternalDrag() {
    const active = external.active;
    ghost.hidden = true; ghost.textContent = '';
    canvas.classList.remove('scene-drop-target');
    document.body.classList.remove('scene-dragging');
    clearDropPreview(); hideReadout();
    external.pointerId = null; external.assetId = null; external.entityId = null; external.sceneId = null;
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
      const selection = selectionOf(hit);
      if (selection) return { hit, point: hit.point.clone(), selection };
    }
    return null;
  }
  function planDrop(pick) {
    const selection = pick?.selection || null;
    if (external.sceneId) {
      const scene = (project.scenes || []).find(item => item.id === external.sceneId);
      if (!scene) return { error: 'That scene is no longer part of this project' };
      if (sceneIsEmpty(scene)) return { error: `Scene ${scene.name} has no objects` };
      const point = floorPointAt(pick?.point || emptyDropPoint());
      const placed = instantiateScene(scene, { x: point.x, y: point.y });
      return { label: `Place ${scene.name} (${placed.entities.length} objects) at ${point.x}, ${point.y}`,
        highlight: selection, point: pick?.point || new THREE.Vector3(point.x, point.floor, point.y),
        apply: next => { next.map.entities.push(...placed.entities); next.events.push(...placed.events); },
        select: placed.entities.length ? { kind: 'entity', id: placed.entities[0].id } : null };
    }
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
        return { label: entity.type === 'ramp' ? `Set texture ${asset.name} on ${entity.name}` : `Set sprite ${asset.name} on ${entity.name}`,
          highlight: selection, apply: next => applyEntitySprite(next, entity.id, asset.id) };
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
    // Models and scenes are placed on empty space; other assets need a surface to land on.
    if (!pick && asset?.kind !== 'model' && !external.sceneId) { showReadout('Aim at a wall, floor, ceiling or object in the 3D view', 'warn'); return; }
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
    external.sceneId = source.scene?.id || null;
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
    // What can be picked is read from the scene, and the scene fills in after this editor is
    // built: sector surfaces arrive with the renderer and objects as their assets load. Collecting
    // the pickable set once at creation therefore captured an empty scene, and nothing in the 3D
    // view could be clicked at all until an edit happened to refresh it. Refresh on the way in
    // instead, so the set is whatever is on screen at the moment of the click.
    collectSceneHandles();
    if (event.button !== 0 && event.button !== 2) return;
    canvas.focus();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
    cast(event);
    // The right button flies the camera; a right click that never moves opens the menu. Either
    // way it gives up whatever drawing tool was armed, so a click cannot keep adding geometry.
    if (event.button === 2) {
      callbacks.clearTool?.();
      action = { kind: 'fly', x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
      return;
    }
    const tool = callbacks.tool();
    if (tool !== 'select') {
      const hit = worldHit(), point = hit?.point || planePoint(0);
      if (!point) { callbacks.error('Aim at a floor or the ground plane to place geometry'); return; }
      if (tool === 'entity') callbacks.place({ x: point.x, y: point.z, z: point.y });
      else if (tool === 'path') callbacks.pathPoint?.({ x: point.x, y: point.z, z: point.y });
      else { action = { kind: 'room', start: point.clone(), end: point.clone() }; roomOutline.visible = true; }
      return;
    }
    // A face of the volume being formed is grabbed where it is drawn, the way a wall is: the
    // plate covers the side, so the surface under the pointer is the side that moves.
    const volume = formVolume();
    const face = volume ? faceAt(event) : null;
    if (face && selected) {
      const center = new THREE.Vector3(volume.center.x, volume.center.z, volume.center.y);
      action = { kind: 'transform', mode: 'form', axis: face.axis, side: face.side, selection: { ...selected },
        x: event.clientX, y: event.clientY, origin: center.clone(), drag: axisDragStart(event, center, face.axis),
        // The size the drag grows from is the one it started at: reading it back from the live
        // project would add each frame's growth to the next, which is how a small drag used to
        // turn a room-sized zone into a tower.
        startSize: areaSizeOf(selected.id, face.axis),
        baseline: project, moved: false };
      paintFaces(`${face.axis}${face.side > 0 ? '+' : '-'}`);
      canvas.dataset.transform = `form:${face.axis}${face.side > 0 ? '+' : '-'}`;
      return;
    }
    const axis = selected ? axisAt(event) : null;
    if (axis) {
      if (mode !== 'move' && selected.kind !== 'entity') { callbacks.error('Select an object to rotate or scale; geometry uses Move'); return; }
      const origin = handles.position.clone();
      action = { kind: 'transform', mode, axis, selection: { ...selected }, x: event.clientX, y: event.clientY,
        origin, drag: axisDragStart(event, origin, axis), startSize: areaSizeOf(selected.id, axis),
        reference: GIZMO_LENGTH * handles.scale.x,
        turn: screenAngle(screenXY(origin), pointerXY(event)), baseline: project, moved: false };
      canvas.dataset.transform = `transform:${axis}`;
      return;
    }
    const hit = hits(pathGroup)[0] || hits(vertexGroup)[0] || worldHit();
    const selection = hit ? { ...selectionOf(hit) } : null;
    if (selection?.kind === 'sector') {
      selection.surface = selectionOf(hit)?.surface || callbacks.surface();
      callbacks.select(selection);
      if (mode === 'move') {
        action = { kind: 'surface', selection, axis: 'y', start: hit.point.clone(), x: event.clientX, y: event.clientY,
          drag: axisDragStart(event, hit.point.clone(), 'y'),
          startHeight: sectorById.get(selection.id)?.[selection.surface] ?? hit.point.y, moved: false, endHeight: null, baseline: project };
      }
      return;
    }
    callbacks.select(selection, { additive: Boolean(event.ctrlKey || event.metaKey) });
    // A waypoint cube can be grabbed and dragged straight away, which is how a route is usually
    // reshaped: pick it up where it is and drop it where it belongs. The axis arrows that appear
    // on selection are for the moves this cannot express — height, and a single axis.
    if (hit?.object.userData.pathPoint) {
      const point = hit.object.position.clone();
      action = { kind: 'pathPoint', selection: { ...selection }, x: event.clientX, y: event.clientY,
        start: point, end: point.clone(), baseline: project, moved: false };
    }
  });
  listen(canvas, 'pointermove', event => {
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
    if (!action) { if (selected) updateHover(event); return; }
    if (action.kind === 'fly') {
      if (!action.moved && Math.hypot(event.clientX - action.startX, event.clientY - action.startY) >= 3) action.moved = true;
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
    if (action.kind === 'pathPoint') {
      if (!action.moved && Math.hypot(event.clientX - action.x, event.clientY - action.y) < 4) return;
      action.moved = true;
      const point = planePoint(action.start.y);
      if (!point) return;
      action.end.copy(point);
      const delta = { x: action.end.x - action.start.x, y: action.end.z - action.start.z, z: 0 };
      liveDrag(action.selection, action.baseline, 'move', delta,
        `Waypoint ${Math.round(action.end.x)}, ${Math.round(action.end.z)}`);
      handles.position.copy(action.end);
      return;
    }
    if (action.kind === 'surface') {
      if (!action.moved && Math.hypot(event.clientX - action.x, event.clientY - action.y) < 4) return;
      action.moved = true;
      const distance = dragAlong(event, action.drag);
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
    if (!action.moved && Math.hypot(event.clientX - action.x, event.clientY - action.y) < 2) return;
    action.moved = true;
    if (action.mode === 'form') {
      // One face moves: its side grows and the opposite side gives way, so the face under the
      // pointer stays under it. The object's own position is the middle of the volume, so this
      // grows about the middle instead of dragging the object across the map.
      const key = axisField(action.axis);
      const size = snapValue(formSizeFromDrag(action.startSize, dragAlong(event, action.drag)), callbacks.grid());
      showReadout(`${key} ${action.side > 0 ? '+' : '−'} → ${size}`);
      canvas.dataset.formSize = `${key}=${size}`;
      action.formKey = key; action.formSize = size;
      liveDrag(action.selection, action.baseline, 'form', { sizes: { [key]: size } }, `3D form ${key} ${size}`);
      return;
    }
    if (action.mode === 'move') {
      const amount = dragAlong(event, action.drag);
      const direction = axisDirection(action.axis);
      const delta = { x: direction[0] * amount, y: direction[2] * amount, z: direction[1] * amount };
      liveDrag(action.selection, action.baseline, 'move', delta,
        `3D move ${axisByKey(action.axis)?.name} ${Math.round(amount)}`);
      return;
    }
    if (action.mode === 'rotate') {
      // A ring is followed, not measured: the pointer's angle around the gizmo is the turn, which
      // is what makes a ring grab feel like grabbing the ring.
      const turn = ringDegrees({ axis: axisDirection(action.axis), viewDirection: viewDirection(),
        from: action.turn, to: screenAngle(screenXY(action.origin), pointerXY(event)) });
      const delta = ringDelta(action.axis, turn);
      const label = delta.angle !== undefined ? `yaw ${Math.round(turn)}deg`
        : delta.pitch !== undefined ? `pitch ${Math.round(turn)}deg` : `roll ${Math.round(turn)}deg`;
      liveDrag(action.selection, action.baseline, 'rotate', delta, `3D rotate ${label}`);
      return;
    }
    const factor = scaleFactorFromDrag({ amount: dragAlong(event, action.drag), reference: action.reference });
    liveDrag(action.selection, action.baseline, 'scale', { scale: factor },
      hasVolume ? `3D volume ${Math.round(factor * 100)}%` : `3D scale ${Math.round(factor * 100)}%`);
  });
  listen(canvas, 'pointerup', event => {
    const completed = action; action = null; keys.clear(); roomOutline.visible = false;
    canvas.dataset.transform = '';
    if (!completed) return;
    if (completed.kind === 'fly') {
      // A right click that stayed put is a context menu request, not a camera drag.
      if (!completed.moved) {
        cast(event);
        const contextHit = worldHit();
        callbacks.menu?.(event, contextHit ? selectionOf(contextHit) : null);
      }
      return;
    }
    if (completed.kind === 'room') { callbacks.room(completed.start, completed.end); return; }
    if (completed.kind === 'surface') {
      hideReadout();
      canvas.dataset.surfaceHeight = '';
      if (!completed.moved) { callbacks.liveFinish(null); select(callbacks.selection()); return; }
      const name = completed.selection.surface === 'ceilingHeight' ? 'ceiling' : 'floor';
      callbacks.liveFinish(`3D ${name} height ${completed.endHeight}`);
      return;
    }
    if (completed.kind === 'pathPoint') {
      hideReadout();
      if (!completed.moved) { callbacks.liveFinish(null); select(callbacks.selection()); return; }
      callbacks.liveFinish(`3D waypoint moved to ${Math.round(completed.end.x)}, ${Math.round(completed.end.z)}`);
      return;
    }
    if (!completed.moved) { callbacks.liveFinish(null); select(callbacks.selection()); return; }
    if (completed.formKey) { hideReadout(); canvas.dataset.formSize = ''; }
    callbacks.liveFinish(completed.selection?.kind === 'pathPoint' ? '3D waypoint moved'
      : completed.formKey ? `3D ${completed.formKey} ${completed.formSize}` : `3D ${completed.mode || mode}`);
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
  listen(canvas, 'dblclick', event => { cast(event); const hit = worldHit(); const target = hit && selectionOf(hit); if (target?.kind === 'entity') callbacks.script(target.id); });

  // Ceilings are part of the merged world now, so they are cut away in the shader at the
  // camera's height instead of being hidden one mesh at a time. The count is reported
  // from the sectors themselves, which is also what the cut is decided on.
  function updateCeilings(dt, force = false) {
    ceilingTimer -= dt;
    if (!force && ceilingTimer > 0) return;
    ceilingTimer = .1;
    view.ceilings(showCeilings);
    let visible = 0, total = 0;
    for (const sector of sectors) {
      if (sector.sky || sector.ceilingHeight <= sector.floorHeight) continue;
      total++;
      if (showCeilings || camera.position.y < sector.ceilingHeight - 2) visible++;
    }
    canvas.dataset.ceilings = `${visible}/${total}`;
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
      rebuildOverlays();
      return true;
    },
    mode(value) { mode = value; select(callbacks.selection()); },
    /** Does the selection have a volume? Form and volume scaling only apply when it does. */
    hasVolume(value) { hasVolume = Boolean(value); select(callbacks.selection(), { rebuildHandles: false }); },
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
      // A gizmo arm is about an eighth of the viewport, whatever the distance: the world size that
      // projects to that is the perspective scale at the gizmo's depth. Dividing the distance by
      // the canvas height instead — which is what this did — makes the gizmo shrink with the
      // square of the viewport and leaves arrows a few pixels long and impossible to grab.
      const eyeDistance = camera.position.distanceTo(handles.position);
      const worldPerPixel = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * eyeDistance / rect.height;
      handles.scale.setScalar(Math.max(.05, worldPerPixel * (GIZMO_ARM_FRACTION * Math.min(rect.width, rect.height)) / GIZMO_LENGTH));
      camera.updateMatrixWorld();
      projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionView);
      handles.visible = Boolean(selected) && handles.children.length > 0 && frustum.containsPoint(handles.position);
      let markers = 0;
      for (const marker of vertexMarkers) {
        if (marker.userData.active) marker.visible = frustum.containsPoint(marker.position);
        if (marker.visible) markers++;
      }
      // Waypoint cubes keep a constant size on screen, so a path crossing a large room is still
      // editable from a distance: 1.9·distance/height makes a 6-unit cube about eight pixels.
      for (const marker of pathGroup.children) {
        if (!marker.userData.pathPoint) continue;
        marker.scale.setScalar(Math.max(.8, 1.9 * camera.position.distanceTo(marker.position) / rect.height));
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
      // Which handles the gizmo is showing, and where their tips are: the mode changes what a
      // selection gets, and a handle can only be dragged where it is drawn.
      const tipAxes = handles.visible ? [...new Set(handles.children.filter(child => child.userData.axis).map(child => child.userData.axis))] : [];
      canvas.dataset.transformAxes = tipAxes.join(',');
      canvas.dataset.transformMode = mode;
      canvas.dataset.formFaces = faceGroup.visible ? String(faceGroup.children.length) : '0';
      canvas.dataset.gizmoTips = handles.visible ? tipAxes.map(axis => `${axis}:${screenOf(handles.position.clone()
        .add(new THREE.Vector3(...axisDirection(axis)).multiplyScalar(GIZMO_LENGTH * handles.scale.x * .95)))}`).join(';') : '';
      // What the pointer is doing right now: a drag kind ('transform', 'pathPoint', 'room'…),
      // so an interaction can be followed from outside the canvas.
      canvas.dataset.action = action ? `${action.kind}${action.axis ? `:${action.axis}` : ''}` : '';
      canvas.dataset.outlineAt = selectionOutline.visible ? screenOf(selectionOutline.position) : '';
    },
    ceilings(visible) { showCeilings = Boolean(visible); updateCeilings(0, true); },
    /** Where a scene placed from the asset browser should land: the view target. */
    sceneTarget() {
      const point = emptyDropPoint();
      const grid = callbacks.grid();
      return { x: Math.round(snapValue(point.x, grid)), y: Math.round(snapValue(point.z, grid)) };
    },
    /** Wireframe interaction areas for "player entered area" events. */
    areas(visible) { showAreas = Boolean(visible); rebuildOverlays(); },
    /** Wireframe rigid-body colliders, so physics volumes are visible while editing. */
    physicsOverlay(visible) { showPhysics = Boolean(visible); rebuildOverlays(); },
    /** The floor point under the pointer, so a pasted copy lands where the user is looking. */
    pointUnderPointer,
    /** Frame the whole room, for when the camera has been flown somewhere unhelpful. */
    fit,
    /** Objects this view had to draw without artwork, for the editor's placeholder log. */
    placeholderReport: () => view.placeholderReport?.() || [],
    dispose() {
      endExternalDrag();
      listeners.forEach(remove => remove()); clearHandles(); resources.forEach(resource => resource.dispose()); view.dispose();
    },
  };
}
