/**
 * What an object instance *is*, in one place.
 *
 * GDevelop and Construct both let an event read any property of an object — its position, its
 * angle, its instance variables, its animation — and use that number anywhere a number goes.
 * This module is that vocabulary: one list of properties, one reader, used by expressions
 * (`property("enemy_1", "animation")`), by the picking conditions ("pick enemies whose health is
 * below 5") and by the editor, so a property cannot exist in one and be missing from another.
 *
 * A property reads the *live* instance when the game is running and the authored object when it
 * is not, because the editor validates expressions before anything is playing.
 */
import { sectorAt, sectorGeometry } from './sectors.js';
import { momentumSpeed } from './player-motion.js';
import { floorHeightAt } from './three-d-floors.js';
import { PLAYER_CYLINDER } from './gravity.js';
import { modelOrientation, modelPoseFromOrientation } from './entity-visuals.js';

/** Horizontal FOV, pitch and eye height above the camera object's position. */
export const CAMERA_DEFAULTS = Object.freeze({ fov: 90, pitch: 0, height: 48 });

/**
 * The kinds of object a level can hold.
 *
 * It lives here, in a module that imports nothing from the project, because three things need it:
 * the project's validation, the event catalogue (a pick or a for-each names a type) and the
 * property reader. Keeping one list is what stops a type existing in one of them only.
 */
export const INSTANCE_TYPES = Object.freeze(['player', 'enemy', 'pickup', 'light', 'decoration', 'ramp', 'zone', 'camera']);
/** The types an instance rule can iterate or pick: everything except the one player. */
export const INSTANCE_PICKABLE_TYPES = Object.freeze(INSTANCE_TYPES.filter(type => type !== 'player'));

/**
 * Every readable instance property.
 *
 * `kind` is `number` or `text`, which is what a comparison and a variable assignment need to
 * know. `state: true` means the value only exists during play: reading it in the editor answers
 * the authored value or zero rather than failing, because a rule must be valid before it runs.
 */
export const INSTANCE_PROPERTIES = Object.freeze([
  // Where it is.
  { name: 'x', label: 'X position', kind: 'number' },
  { name: 'y', label: 'Y position', kind: 'number' },
  { name: 'z', label: 'Z position (floor or own height)', kind: 'number' },
  { name: 'elevation', label: 'Elevation above the floor', kind: 'number' },
  { name: 'floorHeight', label: 'Floor height under it', kind: 'number' },
  // Which way it faces.
  { name: 'angle', label: 'Facing angle (degrees)', kind: 'number' },
  { name: 'pitch', label: 'Pitch (degrees)', kind: 'number' },
  { name: 'roll', label: 'Roll (degrees)', kind: 'number' },
  { name: 'facing', label: 'Left / right facing (-1 or 1)', kind: 'number' },
  // What it looks like and how big it is.
  { name: 'scale', label: 'Visual scale', kind: 'number' },
  { name: 'width', label: 'Width (collider or area)', kind: 'number' },
  { name: 'height', label: 'Height (collider or area)', kind: 'number' },
  { name: 'depth', label: 'Depth (collider or area)', kind: 'number' },
  { name: 'radius', label: 'Radius (collider or area)', kind: 'number' },
  { name: 'opacity', label: 'Opacity (0-1)', kind: 'number' },
  // What state it is in.
  { name: 'health', label: 'Health', kind: 'number' },
  { name: 'alive', label: 'Alive (1 or 0)', kind: 'number' },
  { name: 'animation', label: 'Sprite state name (stand, walk, attack, …)', kind: 'text' },
  { name: 'animationClip', label: 'Sprite clip id playing', kind: 'text' },
  { name: 'animationTime', label: 'Seconds into the current clip', kind: 'number', state: true },
  { name: 'animationFrame', label: 'Frame index in the current clip', kind: 'number', state: true },
  // How it is moving.
  { name: 'speed', label: 'Speed (units per second)', kind: 'number', state: true },
  { name: 'vx', label: 'Velocity X', kind: 'number', state: true },
  { name: 'vy', label: 'Velocity Y', kind: 'number', state: true },
  { name: 'vz', label: 'Velocity Z', kind: 'number', state: true },
  { name: 'grounded', label: 'On the ground (1 or 0)', kind: 'number', state: true },
  // What it is.
  { name: 'type', label: 'Object type', kind: 'text' },
  { name: 'name', label: 'Object name', kind: 'text' },
  { name: 'id', label: 'Object id', kind: 'text' },
  { name: 'doomType', label: 'Doom thing type', kind: 'number' },
  { name: 'count', label: 'Number of local variables', kind: 'number' },
  // Light, when it is one.
  { name: 'lightIntensity', label: 'Light intensity', kind: 'number' },
  { name: 'lightRadius', label: 'Light radius', kind: 'number' },
  // Camera, when it is one.
  { name: 'cameraFov', label: 'Camera field of view', kind: 'number' },
  { name: 'cameraPitch', label: 'Camera pitch (degrees)', kind: 'number' },
  { name: 'cameraHeight', label: 'Camera eye height', kind: 'number' },
]);

const BY_NAME = new Map(INSTANCE_PROPERTIES.map(property => [property.name, property]));

/** The property names a comparison or an assignment may name. */
export const INSTANCE_PROPERTY_NAMES = INSTANCE_PROPERTIES.map(property => property.name);
/** The names that answer text rather than a number. */
export const INSTANCE_TEXT_PROPERTIES = INSTANCE_PROPERTIES.filter(property => property.kind === 'text')
  .map(property => property.name);

export function instanceProperty(name) {
  return BY_NAME.get(String(name ?? '').trim()) ?? null;
}

function floorFor(project, state, entity) {
  const sectors = state?.sectors ?? sectorGeometry(project);
  const position = entity.type === 'player' && state?.player ? state.player : entity;
  const sector = sectorAt(sectors, position.x, position.y);
  const live = state ? sector : project.map.sectors.find(candidate => candidate.id === sector?.id);
  return floorHeightAt(live, position.z);
}

function animationFor(project, state, entity) {
  const animation = state?.spriteAnimations?.get(entity.id);
  const clipId = animation?.clipId ?? entity.spriteStates?.stand;
  const clip = project.spriteClips?.find(candidate => candidate.id === clipId);
  const elapsed = state && clip ? Math.max(0, state.time - (animation?.start ?? 0)) : 0;
  const duration = clip ? clip.frames.length * clip.seconds : 0;
  const frame = duration > 0
    ? Math.min(clip.frames.length - 1, Math.floor((clip.loop ? elapsed % duration : Math.min(elapsed, duration)) / clip.seconds)) : 0;
  return { name: animation?.name ?? (clipId ? 'stand' : ''), clipId: clipId ?? '', elapsed, frame };
}

function velocityFor(state, entity) {
  if (entity.type === 'player') return state?.physics?.playerVelocity ?? momentumSpeed(state?.momentum || {});
  return state?.physics?.getVelocity?.(entity.id) ?? { x: entity.vx ?? 0, y: entity.vy ?? 0, z: entity.vz ?? 0 };
}

function dimensions(entity) {
  if (entity.type === 'player') return { width: PLAYER_CYLINDER.radius * 2,
    height: PLAYER_CYLINDER.halfHeight * 2, depth: PLAYER_CYLINDER.radius * 2, radius: PLAYER_CYLINDER.radius };
  const size = entity.area || entity.mesh || entity.spritePlane || entity.projector || entity.terminal || entity.panel || entity.physics || {};
  const round = !entity.mesh && ['sphere', 'ball', 'capsule', 'cylinder', 'cone'].includes(size.shape);
  return {
    width: round ? (size.radius ?? 0) * 2 : size.width ?? 0,
    height: ['sphere', 'ball'].includes(size.shape) ? (size.radius ?? 0) * 2 : size.height ?? 0,
    depth: round ? (size.radius ?? 0) * 2 : size.depth ?? size.thickness ?? 0,
    radius: size.radius ?? 0,
  };
}

function numberFor(project, state, entity, name) {
  const isPlayer = entity.type === 'player';
  switch (name) {
    case 'x': case 'y': return isPlayer ? state?.player?.[name] ?? entity[name] ?? 0 : entity[name] ?? 0;
    case 'z': return (isPlayer ? state?.player?.z : undefined) ?? entity.z
      ?? floorFor(project, state, entity) + (entity.elevation || 0);
    case 'elevation': return numberFor(project, state, entity, 'z') - floorFor(project, state, entity);
    case 'floorHeight': return floorFor(project, state, entity);
    case 'angle': return isPlayer && state?.player ? state.player.angle * 180 / Math.PI
      : entity.rotation ? modelPoseFromOrientation(modelOrientation(entity)).angle : entity.angle || 0;
    case 'pitch': return isPlayer ? (state?.player?.pitch ?? 0) * 180 / Math.PI
      : entity.rotation ? modelPoseFromOrientation(modelOrientation(entity)).modelTilt.pitch : entity.modelTilt?.pitch ?? entity.cameraPitch ?? 0;
    case 'roll': return isPlayer ? 0
      : entity.rotation ? modelPoseFromOrientation(modelOrientation(entity)).modelTilt.roll : entity.modelTilt?.roll ?? 0;
    case 'facing': return (entity.ramp?.facing ?? entity.facing) === 'left' || entity.facing === -1 ? -1 : 1;
    case 'scale': return entity.modelAsset ? entity.modelScale ?? 32 : entity.spriteScale ?? 1;
    case 'width': case 'height': case 'depth': case 'radius': return dimensions(entity)[name];
    case 'opacity': return entity.mesh?.opacity ?? entity.spritePlane?.opacity ?? entity.projector?.opacity ?? entity.panel?.opacity ?? 1;
    case 'health': return isPlayer ? state?.playerStats?.health ?? entity.health ?? 100 : entity.health ?? 20;
    case 'alive': return numberFor(project, state, entity, 'health') > 0 ? 1 : 0;
    case 'animationTime': return animationFor(project, state, entity).elapsed;
    case 'animationFrame': return animationFor(project, state, entity).frame;
    case 'speed': {
      const velocity = velocityFor(state, entity);
      return Math.hypot(velocity.x || 0, velocity.y || 0, velocity.z || 0);
    }
    case 'vx': case 'vy': case 'vz': return velocityFor(state, entity)[name[1]] ?? 0;
    case 'grounded': {
      if (isPlayer) return state?.physics ? Number(state.physics.grounded) : 1;
      if (entity.grounded !== undefined) return Number(Boolean(entity.grounded));
      const floor = floorFor(project, state, entity);
      return Number(Math.abs(numberFor(project, state, entity, 'z') - floor) <= 1 &&
        (velocityFor(state, entity).z ?? 0) <= 0);
    }
    case 'doomType': return entity.doomType ?? 0;
    case 'count': return Object.keys(entity.variables || {}).length;
    case 'lightIntensity': return entity.light?.intensity ?? 0;
    case 'lightRadius': return entity.light?.radius ?? 0;
    case 'cameraFov': return entity.cameraFov ?? (entity.type === 'camera' ? CAMERA_DEFAULTS.fov : 0);
    case 'cameraPitch': return entity.cameraPitch ?? 0;
    case 'cameraHeight': return entity.cameraHeight ?? (entity.type === 'camera' ? CAMERA_DEFAULTS.height : 0);
  }
}

function textFor(project, state, entity, name) {
  if (['type', 'name', 'id'].includes(name)) return entity[name] ?? '';
  const animation = animationFor(project, state, entity);
  return name === 'animation' ? animation.name : animation.clipId;
}

/**
 * Reads one property of one instance.
 *
 * An unknown name throws: a rule that reads `property("enemy_1", "hight")` must say so when it is
 * written, not quietly answer zero at play time.
 */
export function readInstanceProperty(project, state, entity, name) {
  const property = instanceProperty(name);
  if (!property) throw new Error(`Unknown object property: ${name}`);
  if (!entity) return property.kind === 'text' ? '' : 0;
  if (property.kind === 'text') return textFor(project, state, entity, property.name);
  const value = numberFor(project, state, entity, property.name);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Compares one property of an instance to a value, using the same operators an event does.
 *
 * A text property compares as text; a number as a number. Mixing the two is an authoring mistake
 * and says so, which is the same rule the runtime already applies to variable comparisons.
 */
export function compareInstanceProperty(project, state, entity, name, operator, value) {
  const property = instanceProperty(name);
  const left = readInstanceProperty(project, state, entity, name);
  const expected = property.kind === 'text' ? 'string' : 'number';
  if (typeof value !== expected) throw new Error(`${name} comparison value must be ${expected === 'number' ? 'a number' : 'text'}`);
  const right = value;
  switch (operator) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '=': return left === right;
    case '!=': return left !== right;
    case '>=': return left >= right;
    case '>': return left > right;
    default: throw new Error(`Unsupported comparison operator: ${operator}`);
  }
}
