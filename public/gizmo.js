// The 3D transform gizmo, drawn the way Godot draws one: an arrow to move along an axis, a ring
// to turn about one, and a shaft with a box at the end to scale. Form has no Godot equivalent, so
// it gets the volume's own faces as handles — the same idea as picking a wall in the world, except
// the surface under the pointer is the side of a box.
//
// Everything here builds geometry with the orientation baked in, so each handle sits at the origin
// of the gizmo group with an identity transform: the group is what is positioned and scaled.
import * as THREE from '/vendor/three/three.module.js';
import { GIZMO_LENGTH, axisByKey, faceLabel } from '/shared/gizmo-math.js';

const SHAFT_RADIUS = 1.4;
const HEAD_LENGTH = 14;
const HEAD_RADIUS = 4.6;
const SCALE_MOVE = .72;
const RING_RADIUS = GIZMO_LENGTH * .95;
const RING_TUBE = 1.1;
const FACE_COLOR = '#ffd34d';
const REST_OPACITY = .92;
/**
 * How fat a handle is to the pointer.
 *
 * A shaft a pixel wide is a shaft nobody can hit: at arm's length an arm projects to about ninety
 * pixels and the drawn shaft is one of them. Godot's handles read as ease to grab because the
 * shapes are chunky, so here each handle carries an invisible volume — much wider than it looks,
 * never drawn — that the pointer is tested against.
 */
const PICK_RADIUS = 6;
const PICK_TIP_RADIUS = 9;
const PICK_RING_TUBE = 4.5;

/** Turns a +Y-aligned geometry onto an axis. */
function orient(geometry, axisKey) {
  if (axisKey === 'x') geometry.rotateZ(-Math.PI / 2);
  else if (axisKey === 'z') geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Slides a geometry out along an axis, which is how far along it the shape belongs. */
function along(geometry, axisKey, distance) {
  if (axisKey === 'x') geometry.translate(distance, 0, 0);
  else if (axisKey === 'z') geometry.translate(0, 0, distance);
  else geometry.translate(0, distance, 0);
  return geometry;
}

/** A ring lies in the plane its axis is perpendicular to; the torus is built in XY. */
function ringGeometry(axisKey) {
  const geometry = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 6, 72);
  if (axisKey === 'y') geometry.rotateX(Math.PI / 2);
  else if (axisKey === 'x') geometry.rotateY(Math.PI / 2);
  return geometry;
}

function axisMaterial(color, opacity = REST_OPACITY) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity, side: THREE.DoubleSide });
}

function handle(geometry, material, axisKey, part) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData = { axis: axisKey, part, baseColor: material.color.getHex() };
  mesh.renderOrder = 200;
  return mesh;
}

/** A handle nobody sees that the pointer can still hit, so a thin arm is easy to grab. */
function pick(geometry, axisKey) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false,
  }));
  mesh.userData = { axis: axisKey, part: 'pick', pick: true };
  mesh.renderOrder = 199;
  return mesh;
}

/**
 * Handles for a transform mode.
 *
 * `form` is the odd one out: on a box it becomes its six faces, so there is nothing to draw here.
 */
export function buildGizmo(kind, axes) {
  const meshes = [];
  for (const key of axes) {
    const axis = axisByKey(key);
    if (!axis) continue;
    if (kind === 'rotate') {
      meshes.push(handle(ringGeometry(key), axisMaterial(axis.color, .85), key, 'ring'));
      const fat = new THREE.TorusGeometry(RING_RADIUS, PICK_RING_TUBE, 4, 48);
      if (key === 'y') fat.rotateX(Math.PI / 2);
      else if (key === 'x') fat.rotateY(Math.PI / 2);
      meshes.push(pick(fat, key));
    } else if (kind === 'scale') {
      const reach = GIZMO_LENGTH * SCALE_MOVE;
      meshes.push(handle(along(orient(new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, reach, 8), key), key, reach / 2),
        axisMaterial(axis.color), key, 'shaft'));
      meshes.push(handle(along(orient(new THREE.BoxGeometry(8, 8, 8), key), key, reach + 4), axisMaterial(axis.color), key, 'tip'));
      pushPick(meshes, key, reach);
    } else {
      meshes.push(handle(along(orient(new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, GIZMO_LENGTH, 8), key), key, GIZMO_LENGTH / 2),
        axisMaterial(axis.color), key, 'shaft'));
      const head = along(orient(new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 12), key), key, GIZMO_LENGTH + HEAD_LENGTH / 2);
      meshes.push(handle(head, axisMaterial(axis.color), key, 'tip'));
      pushPick(meshes, key, GIZMO_LENGTH + HEAD_LENGTH);
    }
  }
  return meshes;
}

/** The invisible core and tip a pointer aims at: the whole arm, and its end. */
function pushPick(meshes, key, reach) {
  meshes.push(pick(along(orient(new THREE.CylinderGeometry(PICK_RADIUS, PICK_RADIUS, reach, 6), key), key, reach / 2), key));
  const tip = new THREE.SphereGeometry(PICK_TIP_RADIUS, 8, 6);
  tip.translate(...(key === 'x' ? [reach, 0, 0] : key === 'z' ? [0, 0, reach] : [0, reach, 0]));
  meshes.push(pick(tip, key));
}

/**
 * The six sides of a volume as pickable plates.
 *
 * A plate carries the axis and the side it is on, so a drag knows which face was grabbed and which
 * side of the volume it resizes. They are placed at the volume's own faces rather than around the
 * object's origin, and the caller gives the group the volume's yaw.
 */
export function buildFormFaces(volume) {
  const half = volume?.half;
  if (!half) return [];
  const width = Math.max(1, half.width * 2), depth = Math.max(1, half.depth * 2), height = Math.max(1, half.height * 2);
  const plates = [
    { axis: 'x', side: 1, size: [depth, height], at: [half.width, 0, 0], turn: Math.PI / 2 },
    { axis: 'x', side: -1, size: [depth, height], at: [-half.width, 0, 0], turn: Math.PI / 2 },
    { axis: 'z', side: 1, size: [width, height], at: [0, 0, half.depth], turn: 0 },
    { axis: 'z', side: -1, size: [width, height], at: [0, 0, -half.depth], turn: 0 },
    { axis: 'y', side: 1, size: [width, depth], at: [0, half.height, 0], turn: -Math.PI / 2 },
    { axis: 'y', side: -1, size: [width, depth], at: [0, -half.height, 0], turn: -Math.PI / 2 },
  ];
  return plates.map(plate => {
    const geometry = new THREE.PlaneGeometry(plate.size[0], plate.size[1]);
    geometry.rotateX(plate.turn);
    geometry.translate(...plate.at);
    const material = new THREE.MeshBasicMaterial({
      color: FACE_COLOR, transparent: true, opacity: .04, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { face: { axis: plate.axis, side: plate.side }, baseColor: FACE_COLOR, label: `${plate.side > 0 ? '+' : '−'}${faceLabel(plate.axis)}` };
    mesh.renderOrder = 210;
    return mesh;
  });
}

/**
 * Paints one handle, or one face, as the one the pointer is over.
 *
 * Godot lights up the handle under the pointer, and without that an arrow pointing at the camera
 * is a blip you cannot tell apart from the one beside it.
 */
export function paintHandles(meshes, hovered = null, { faces = false } = {}) {
  const highlight = new THREE.Color('#ffffff');
  for (const mesh of meshes) {
    // Picking volumes are never drawn, so there is nothing to paint.
    if (mesh.userData.pick) continue;
    const own = faces ? `${mesh.userData.face?.axis}${mesh.userData.face?.side > 0 ? '+' : '-'}` : mesh.userData.axis;
    const active = hovered !== null && own === hovered;
    mesh.material.color.set(mesh.userData.baseColor);
    if (active) mesh.material.color.lerp(highlight, faces ? .35 : .55);
    mesh.material.opacity = faces ? (active ? .3 : .04) : (active ? 1 : REST_OPACITY);
  }
}

/** Frees what a rebuild replaces. Shared by the gizmo and the face plates. */
export function disposeHandles(meshes) {
  for (const mesh of meshes) {
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    mesh.material?.dispose();
  }
}
