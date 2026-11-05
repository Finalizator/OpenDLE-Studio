import { addSceneObject, sceneSubtree, uniqueSceneName } from './scenes.js';
import { formDrag } from './gizmo-math.js';
import { modelOrientation, modelPoseFromOrientation, rotateQuaternion, multiplyQuaternion, axisRotation } from './entity-visuals.js';
import { MEDIA_NODE_DEFAULTS } from './media-nodes.js';
import { jointWithin } from './joints.js';

const mesh = shape => ({ type: 'decoration', nodeKind: 'mesh',
  mesh: { ...MEDIA_NODE_DEFAULTS.mesh, shape } });
export const SCENE_NODE_TYPES = [
  { id: 'node3d', name: 'Node3D', category: 'Spatial', description: 'Transform and organize a branch of child nodes.', defaults: { type: 'decoration', nodeKind: 'node3d' } },
  { id: 'marker', name: 'Marker3D', category: 'Spatial', description: 'A visible editor reference point; no artwork in play.', defaults: { type: 'decoration', nodeKind: 'marker' } },
  { id: 'sprite', name: 'Sprite3D', category: 'Visual', description: 'An oriented sprite plane with editable dimensions and texture.', defaults: { type: 'decoration', nodeKind: 'sprite', spritePlane: MEDIA_NODE_DEFAULTS.spritePlane } },
  { id: 'billboard', name: 'Billboard sprite', category: 'Visual', description: 'A Doom-style sprite that turns to face the camera.', defaults: { type: 'decoration' } },
  ...['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane'].map(shape => ({
    id: shape, name: `${shape[0].toUpperCase()}${shape.slice(1)} mesh`, category: 'Geometry',
    description: `Editable ${shape} geometry with color, texture and optional physics.`, defaults: mesh(shape),
  })),
  { id: 'sound', name: 'AudioStreamPlayer3D', category: 'Media', description: 'An embedded positional sound with range, looping and volume.', defaults: { type: 'decoration', nodeKind: 'sound', sound: MEDIA_NODE_DEFAULTS.sound } },
  { id: 'projector', name: 'VideoProjector3D', category: 'Media', description: 'An image or video displayed on a projection plane.', defaults: { type: 'decoration', nodeKind: 'projector', projector: MEDIA_NODE_DEFAULTS.projector } },
  { id: 'terminal', name: 'InteractiveScreen3D', category: 'Interface', description: 'A surface-operated screen with local digits and a submitted signal.', defaults: { type: 'decoration', nodeKind: 'terminal', variables: { digits: '' }, signals: ['submitted'], terminal: { ...MEDIA_NODE_DEFAULTS.terminal, variable: null, inputVariable: 'digits', submitSignal: 'submitted', mode: 'terminal', title: 'Terminal', buttons: [{ label: 'Enable', value: 1 }, { label: 'Disable', value: 0 }] } } },
  { id: 'keypad', name: 'Code lock', category: 'Interface', description: 'A surface keypad that stores local digits and emits submitted for visual-script conditions.', defaults: { type: 'decoration', nodeKind: 'terminal', variables: { digits: '' }, signals: ['submitted'], terminal: { ...MEDIA_NODE_DEFAULTS.terminal, variable: null, inputVariable: 'digits', submitSignal: 'submitted', width: 48, height: 64, resolutionWidth: 384, resolutionHeight: 512, title: 'Access control' } } },
  { id: 'light', name: 'PointLight3D', category: 'Lighting', description: 'A point light with color, intensity and radius.', defaults: { type: 'light', nodeKind: 'light' } },
  { id: 'area', name: 'Area3D', category: 'Physics', description: 'A scriptable interaction volume, invisible in play.', defaults: { type: 'zone', nodeKind: 'zone', area: { shape: 'box', width: 128, height: 128, depth: 128, radius: 64 } } },
  { id: 'body', name: 'RigidBody3D', category: 'Physics', description: 'A dynamic box mesh and matching rigid body.', defaults: { ...mesh('box'), physics: { body: 'dynamic', shape: 'box', width: 64, height: 64, depth: 64, radius: 32, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: false } } },
  { id: 'static', name: 'StaticBody3D', category: 'Physics', description: 'A fixed box mesh with solid collision.', defaults: { ...mesh('box'), physics: { body: 'fixed', shape: 'box', width: 64, height: 64, depth: 64, radius: 32, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true } } },
  { id: 'enemy', name: 'Enemy', category: 'Gameplay', description: 'An enemy with sprite/model artwork, health and object events.', defaults: { type: 'enemy', nodeKind: 'enemy', health: 20 } },
  { id: 'pickup', name: 'Pickup', category: 'Gameplay', description: 'A pickup with sprite/model artwork and object events.', defaults: { type: 'pickup', nodeKind: 'pickup' } },
  { id: 'ramp', name: 'Ramp', category: 'Geometry', description: 'A procedural ramp; geometry is generated from slope, length and width.', defaults: { type: 'ramp', nodeKind: 'ramp', ramp: { slope: 30, length: 192, width: 96, facing: 'left' } } },
  { id: 'panel', name: 'Panel', category: 'Visual', description: 'A translucent physical panel or glass surface.', defaults: { type: 'decoration', nodeKind: 'panel', panel: { width: 128, height: 128, thickness: 2, opacity: .35, roughness: .12, metalness: 0, color: '#d7e8f2' } } },
  // A point of view rather than a thing: placed where a cutscene should look from, then
  // selected by the Camera: switch actions. No artwork in play.
  { id: 'camera', name: 'Camera3D', category: 'Gameplay',
    description: 'A point of view a script can switch to, with its own field of view, pitch and eye height.',
    defaults: { type: 'camera', nodeKind: 'camera', cameraFov: 90, cameraPitch: 0, cameraHeight: 48 } },
];

export function sceneNodeType(entity) {
  if (entity.terminal) return entity.terminal.mode === 'keypad' ? 'keypad' : 'terminal';
  if (entity.mesh) return entity.mesh.shape;
  if (entity.spritePlane) return 'sprite';
  if (entity.projector) return 'projector';
  if (entity.sound) return 'sound';
  if (entity.panel) return 'panel';
  if (entity.nodeKind) return entity.nodeKind === 'zone' ? 'area' : entity.nodeKind;
  return entity.type === 'decoration' ? 'billboard' : entity.type === 'zone' ? 'area' : entity.type;
}

export function sceneNodeLabel(entity) {
  return SCENE_NODE_TYPES.find(type => type.id === sceneNodeType(entity))?.name || entity.type;
}

export function sceneNodeSupportsTilt(entity) {
  return Boolean(entity.modelAsset || entity.mesh || entity.spritePlane && !entity.spritePlane.billboard
    || entity.projector || entity.terminal || ['node3d', 'marker', 'sound', 'light', 'camera'].includes(entity.nodeKind));
}

export function createSceneNode(scene, kind, options = {}) {
  const definition = SCENE_NODE_TYPES.find(type => type.id === kind);
  if (!definition) throw new Error(`Unknown scene node type: ${kind}`);
  return addSceneObject(scene, { ...structuredClone(definition.defaults),
    name: uniqueSceneName(scene, definition.name), ...options });
}

export function sceneNodeDimensions(entity) {
  const volume = entity.mesh || entity.spritePlane || entity.projector || entity.terminal || entity.panel || entity.area
    || (entity.physics?.body !== 'none' ? entity.physics : null);
  if (!volume) return null;
  if (!entity.mesh && ['sphere', 'ball', 'capsule', 'cylinder', 'cone'].includes(volume.shape)) {
    return { width: (volume.radius || 16) * 2, depth: (volume.radius || 16) * 2,
      height: ['sphere', 'ball'].includes(volume.shape) ? (volume.radius || 16) * 2 : volume.height || 32 };
  }
  return { width: volume.width || (volume.radius || 16) * 2, height: volume.height || 32,
    depth: volume.depth ?? volume.thickness ?? 2 };
}

export function sceneNodePivot(entity) {
  const centred = entity.mesh || entity.spritePlane || entity.projector || entity.terminal || entity.panel || entity.area;
  return { x: entity.x, y: entity.y,
    z: (entity.z ?? entity.elevation ?? 0) + (centred ? sceneNodeDimensions(entity).height / 2 : 0) };
}

function resizeNode(entity, origin, factors) {
  const component = ['mesh', 'spritePlane', 'projector', 'terminal', 'panel', 'area']
    .find(key => origin[key]);
  const keys = component ? [component, ...(origin.physics && origin.physics.body !== 'none' ? ['physics'] : [])]
    : origin.physics && origin.physics.body !== 'none' ? ['physics'] : [];
  for (const key of keys) {
    const volume = structuredClone(origin[key]);
    for (const [field, axis] of [['width', 'x'], ['height', 'z'], ['depth', 'y'], ['thickness', 'y']]) {
      if (volume[field] !== undefined) volume[field] = Math.max(.1, Math.min(4096, origin[key][field] * factors[axis]));
    }
    if (volume.radius !== undefined) {
      const round = ['sphere', 'ball', 'capsule', 'cylinder', 'cone'].includes(volume.shape);
      const factor = round ? factors.x !== 1 ? factors.x : factors.y !== 1 ? factors.y
        : ['sphere', 'ball'].includes(volume.shape) ? factors.z : 1 : Math.min(factors.x, factors.y);
      volume.radius = Math.max(.1, Math.min(2048, origin[key].radius * factor));
      if (['sphere', 'ball'].includes(volume.shape)) volume.height = volume.radius * 2;
      if (volume.shape === 'capsule') volume.height = Math.max(volume.height, volume.radius * 2);
    }
    entity[key] = volume;
  }
  if (origin.modelAsset) entity.modelScale = Math.min(4096, Math.max(.001, (origin.modelScale ?? 32) * factors.x));
  for (const key of ['sound', 'light']) if (origin[key]?.radius !== undefined) {
    entity[key] = { ...origin[key], radius: Math.min(8192, Math.max(1, origin[key].radius * factors.x)) };
  }
  if (!component && !origin.modelAsset && !origin.sound && !origin.light
    && origin.type !== 'camera' && !['node3d', 'marker', 'camera'].includes(origin.nodeKind)) {
    entity.spriteScale = Math.min(16, Math.max(.05, (origin.spriteScale ?? 1) * factors.x));
  }
}

/** Absolute baseline transforms: a branch moves as one and a repeated frame never compounds. */
export function transformSceneNodes(scene, baseline, id, mode, delta, grid = 0) {
  const root = baseline.entities.find(node => node.id === id);
  if (!root) throw new Error('Selected scene node no longer exists');
  if (!['move', 'rotate', 'scale', 'form'].includes(mode)) throw new Error('Unknown node transform');
  const snap = value => grid > 0 ? Math.round(value / grid) * grid : value;
  const before = sceneSubtree(baseline, id);
  const ids = new Set(before.map(node => node.id));
  const rootZ = root.z ?? root.elevation ?? 0;
  if (mode === 'rotate' && delta.axis && delta.axis !== 'z' && !sceneNodeSupportsTilt(root)) {
    throw new Error('This node supports yaw rotation only');
  }
  const pivot = sceneNodePivot(root);
  const shift = { x: delta.x ? snap(root.x + delta.x) - root.x : 0,
    y: delta.y ? snap(root.y + delta.y) - root.y : 0,
    z: delta.z ? snap(rootZ + delta.z) - rootZ : 0 };
  const degrees = delta.angle || 0;
  const rotationAxis = delta.axis === 'x' ? [1, 0, 0] : delta.axis === 'y' ? [0, 0, 1] : [0, 1, 0];
  let turn = axisRotation(rotationAxis, delta.axis === 'x' || delta.axis === 'y' ? degrees : -degrees);
  if (mode === 'rotate' && delta.local && (delta.axis === 'x' || delta.axis === 'y')) {
    const key = delta.axis === 'x' ? 'pitch' : 'roll', pose = structuredClone(root);
    pose.modelTilt = { ...root.modelTilt, [key]: (root.modelTilt?.[key] || 0) + degrees };
    delete pose.rotation;
    const q = modelOrientation(root);
    turn = multiplyQuaternion(modelOrientation(pose), [-q[0], -q[1], -q[2], q[3]]);
  }
  let factors = { x: delta.scale ?? 1, y: delta.scale ?? 1, z: delta.scale ?? 1 };
  if (mode === 'scale' && delta.axis && sceneNodeDimensions(root)) factors = { x: 1, y: 1, z: 1, [delta.axis]: delta.scale ?? 1 };
  if (mode === 'form') {
    const dimensions = sceneNodeDimensions(root);
    if (!dimensions) throw new Error('Form needs a mesh, sprite plane, screen, panel, area or collider');
    const field = delta.axis === 'z' ? 'height' : delta.axis === 'y' ? 'depth' : 'width';
    const volume = root.mesh || root.spritePlane || root.projector || root.terminal || root.panel || root.area || root.physics;
    const minimum = !root.mesh && volume.shape === 'capsule' && field === 'height' ? dimensions.width : 1;
    const vector = delta.axis === 'z' ? [0, 1, 0] : delta.axis === 'y' ? [0, 0, 1] : [1, 0, 0];
    const nativeDirection = rotateQuaternion(vector, modelOrientation(sceneNodeSupportsTilt(root) ? root : { angle: root.angle }));
    const direction = { x: nativeDirection[0], y: nativeDirection[2], z: nativeDirection[1] };
    const centre = root.x * direction.x + root.y * direction.y + (rootZ + dimensions.height / 2) * direction.z;
    const formed = formDrag({ centre, size: dimensions[field], amount: delta.amount || 0,
      side: delta.side ?? 1, symmetric: Boolean(delta.symmetric), grid, min: minimum, max: 4096 });
    factors = { x: 1, y: 1, z: 1, [delta.axis || 'x']: formed.size / dimensions[field] };
    const resized = structuredClone(root);
    resizeNode(resized, root, factors);
    const nextHeight = sceneNodeDimensions(resized).height;
    shift.x = direction.x * formed.shift;
    shift.y = direction.y * formed.shift;
    shift.z = direction.z * formed.shift + (dimensions.height - nextHeight) / 2;
  }
  if (mode === 'move' && !shift.x && !shift.y && !shift.z
    || mode === 'rotate' && !degrees
    || mode === 'scale' && factors.x === 1 && factors.y === 1 && factors.z === 1) return [...ids];
  for (const base of before) {
    const node = scene.entities.find(item => item.id === base.id);
    if (!node) throw new Error('A node in the transformed branch no longer exists');
    if (mode === 'move' || mode === 'form') {
      node.x = base.x + shift.x; node.y = base.y + shift.y;
      if (shift.z || base.elevation !== undefined) node.elevation = (base.elevation || 0) + shift.z;
      if (base.z !== undefined) node.z = base.z + shift.z;
      if (mode === 'form' && base.id === id) resizeNode(node, base, factors);
    } else if (mode === 'rotate') {
      const basePivot = sceneNodePivot(base), offset = basePivot.z - (base.z ?? base.elevation ?? 0);
      const position = rotateQuaternion([base.x - pivot.x, basePivot.z - pivot.z, base.y - pivot.y], turn);
      node.x = pivot.x + position[0]; node.y = pivot.y + position[2];
      const z = pivot.z + position[1] - offset;
      if (z !== (base.z ?? base.elevation ?? 0) || base.elevation !== undefined) {
        node.elevation = (base.elevation || 0) + z - (base.z ?? base.elevation ?? 0);
      }
      if (base.z !== undefined) node.z = z;
      Object.assign(node, modelPoseFromOrientation(multiplyQuaternion(turn, modelOrientation(base))));
      delete node.rotation;
    } else {
      node.x = root.x + (base.x - root.x) * factors.x;
      node.y = root.y + (base.y - root.y) * factors.y;
      const z = rootZ + ((base.z ?? base.elevation ?? 0) - rootZ) * factors.z;
      if (z !== (base.z ?? base.elevation ?? 0) || base.elevation !== undefined) {
        node.elevation = (base.elevation || 0) + z - (base.z ?? base.elevation ?? 0);
      }
      if (base.z !== undefined) node.z = z;
      resizeNode(node, base, factors);
    }
  }
  for (const source of baseline.joints || []) {
    if (!jointWithin(source, ids)) continue;
    const joint = (scene.joints || []).find(item => item.id === source.id);
    if (!joint || !source.anchor) continue;
    const anchor = source.anchor, x = anchor.x - root.x, y = anchor.y - root.y, z = (anchor.z || 0) - rootZ;
    if (mode === 'move' || mode === 'form') {
      joint.anchor = { x: anchor.x + shift.x, y: anchor.y + shift.y, z: (anchor.z || 0) + shift.z };
    } else if (mode === 'scale') {
      joint.anchor = { x: root.x + x * factors.x, y: root.y + y * factors.y, z: rootZ + z * factors.z };
    } else {
      const point = rotateQuaternion([anchor.x - pivot.x, (anchor.z || 0) - pivot.z, anchor.y - pivot.y], turn);
      joint.anchor = { x: pivot.x + point[0], y: pivot.y + point[2], z: pivot.z + point[1] };
      if (source.axis) {
        const axis = rotateQuaternion([source.axis.x, source.axis.z, source.axis.y], turn);
        joint.axis = { x: axis[0], y: axis[2], z: axis[1] };
      }
    }
  }
  return before.map(node => node.id);
}
