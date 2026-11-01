// The 3D transform gizmo, drawn the way Godot draws one: an arrow to move along an axis, a ring
// to turn about one, and a shaft with a box at the end to scale.
//
// Form has no Godot equivalent, so it gets six arrows — one standing on each face of the volume,
// pointing out of it. Filling the faces was the first attempt and it was a mistake: from inside a
// large volume the plates covered the whole view, and a plate says nothing about which way it
// moves. An arrow standing on a face says both.
//
// Axis handles bake their orientation into the geometry and sit at the origin of the scaled gizmo
// group; face arrows carry a transform of their own, because they are placed on the volume rather
// than around the object.
import * as THREE from '/vendor/three/three.module.js';
import { GIZMO_LENGTH, axisByKey } from '/shared/gizmo-math.js';

const SHAFT_RADIUS = 1.4;
const HEAD_LENGTH = 14;
const HEAD_RADIUS = 4.6;
const SCALE_MOVE = .72;
const RING_RADIUS = GIZMO_LENGTH * .95;
const RING_TUBE = 1.1;
const REST_OPACITY = .92;
/** How far a face arrow stands off its face: shorter than an axis arm, so six of them still read. */
const FACE_ARM = GIZMO_LENGTH * .62;
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

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Six arrows, one standing on each face of a volume and pointing out of it.
 *
 * Each arrow knows the side it belongs to, so a drag resizes the side that was grabbed and the
 * side moves the way the arrow points. They are built along +Y and turned to their face, so the
 * caller only has to position the group on the volume and keep the arrows at the gizmo's own
 * on-screen size.
 */
export function buildFaceArrows(volume) {
  const half = volume?.half;
  if (!half) return [];
  const faces = [
    { axis: 'x', side: 1, at: [half.width, 0, 0] }, { axis: 'x', side: -1, at: [-half.width, 0, 0] },
    { axis: 'y', side: 1, at: [0, half.height, 0] }, { axis: 'y', side: -1, at: [0, -half.height, 0] },
    { axis: 'z', side: 1, at: [0, 0, half.depth] }, { axis: 'z', side: -1, at: [0, 0, -half.depth] },
  ];
  const reach = FACE_ARM + HEAD_LENGTH;
  const meshes = [];
  for (const face of faces) {
    const colour = axisByKey(face.axis).color;
    const direction = axisByKey(face.axis).direction.map(value => value * face.side);
    const shaft = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, FACE_ARM, 8).translate(0, FACE_ARM / 2, 0);
    const head = new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 12).translate(0, FACE_ARM + HEAD_LENGTH / 2, 0);
    const body = new THREE.CylinderGeometry(PICK_RADIUS, PICK_RADIUS, reach, 6).translate(0, reach / 2, 0);
    for (const [part, geometry] of [['shaft', shaft], ['tip', head], ['pick', body]]) {
      const material = part === 'pick'
        ? new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })
        : axisMaterial(colour);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...face.at);
      mesh.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...direction));
      mesh.userData = { face: { axis: face.axis, side: face.side }, part, baseColor: colour, pick: part === 'pick' };
      mesh.renderOrder = 200;
      meshes.push(mesh);
    }
  }
  return meshes;
}

/** What a handle is called when the pointer is over it: an axis, or an axis and a side. */
export const handleKey = mesh => mesh.userData.face
  ? `${mesh.userData.face.axis}${mesh.userData.face.side > 0 ? '+' : '-'}`
  : mesh.userData.axis;

/**
 * Paints one handle, or one face, as the one the pointer is over.
 *
 * Godot lights up the handle under the pointer, and without that an arrow pointing at the camera
 * is a blip you cannot tell apart from the one beside it.
 */
export function paintHandles(meshes, hovered = null) {
  const highlight = new THREE.Color('#ffffff');
  for (const mesh of meshes) {
    // Picking volumes are never drawn, so there is nothing to paint.
    if (mesh.userData.pick) continue;
    const active = hovered !== null && handleKey(mesh) === hovered;
    mesh.material.color.set(mesh.userData.baseColor);
    if (active) mesh.material.color.lerp(highlight, .55);
    mesh.material.opacity = active ? 1 : REST_OPACITY;
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
