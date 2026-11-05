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

/** The number a property answers, for a comparison or a variable being set from it. */
function numbersFor(project, state, entity, cache) {
  const isPlayer = entity.type === 'player';
  const z = isPlayer
    ? state?.player?.z ?? entity.z ?? (cache.sector(entity)?.floorHeight ?? 0)
    : entity.z ?? (cache.sector(entity)?.floorHeight ?? 0) + (entity.elevation || 0);
  const tilt = entity.modelTilt;
  const animation = state?.spriteAnimations?.get(entity.id);
  const velocity = isPlayer ? state?.momentum : entity.momentum;
  const area = entity.area, physics = entity.physics;
  const size = area || physics || {};
  const clip = animation?.clipId ? project.spriteClips?.find(candidate => candidate.id === animation.clipId) : null;
  const elapsed = animation && state ? Math.max(0, state.time - animation.start) : 0;
  const frame = clip?.seconds ? Math.floor(elapsed / clip.seconds) : 0;
  return {
    x: isPlayer ? state?.player?.x ?? entity.x ?? 0 : entity.x ?? 0,
    y: isPlayer ? state?.player?.y ?? entity.y ?? 0 : entity.y ?? 0,
    z,
    elevation: entity.elevation || 0,
    floorHeight: cache.sector(entity)?.floorHeight ?? 0,
    angle: isPlayer ? (state?.player?.angle ?? 0) * 180 / Math.PI : entity.angle || 0,
    pitch: isPlayer ? (state?.player?.pitch ?? 0) * 180 / Math.PI : tilt?.pitch ?? entity.cameraPitch ?? 0,
    roll: isPlayer ? 0 : tilt?.roll ?? 0,
    facing: entity.facing === 'right' || entity.facing === 1 ? 1 : entity.facing === 'left' || entity.facing === -1 ? -1 : 1,
    scale: Number.isFinite(entity.scale) ? entity.scale : 1,
    width: size.width ?? (size.radius ? size.radius * 2 : 0),
    height: size.height ?? 0,
    depth: size.depth ?? 0,
    radius: size.radius ?? 0,
    opacity: Number.isFinite(entity.opacity) ? entity.opacity : 1,
    health: Number.isFinite(entity.health) ? entity.health : (isPlayer ? state?.playerStats?.health ?? 0 : 20),
    alive: (Number.isFinite(entity.health) ? entity.health : isPlayer ? state?.playerStats?.health ?? 1 : 20) > 0 ? 1 : 0,
    animationTime: elapsed,
    animationFrame: Math.max(0, frame),
    speed: velocity ? Math.hypot(velocity.x || 0, velocity.y || 0, velocity.z || 0) : 0,
    vx: velocity?.x || 0, vy: velocity?.y || 0, vz: velocity?.z || 0,
    grounded: isPlayer ? (state?.physics?.grounded ? 1 : 0) : entity.grounded ? 1 : 0,
    doomType: Number.isFinite(entity.doomType) ? entity.doomType : 0,
    count: Object.keys(entity.variables || {}).length,
    lightIntensity: entity.light?.intensity ?? 0,
    lightRadius: entity.light?.radius ?? 0,
    cameraFov: entity.cameraFov ?? 0,
    cameraPitch: entity.cameraPitch ?? 0,
    cameraHeight: entity.cameraHeight ?? 0,
  };
}

function textsFor(entity, animation) {
  return {
    type: entity.type ?? '',
    name: entity.name ?? '',
    id: entity.id ?? '',
    animation: animation?.name ?? (entity.spriteStates?.stand ? 'stand' : ''),
    animationClip: animation?.clipId ?? entity.spriteStates?.stand ?? '',
  };
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
  const cache = { sector: makeSectorLookup(project) };
  const animation = state?.spriteAnimations?.get(entity.id);
  if (property.kind === 'text') return textsFor(entity, animation)[property.name] ?? '';
  const values = numbersFor(project, state, entity, cache);
  return Number.isFinite(values[property.name]) ? values[property.name] : 0;
}

/** One sector lookup per read, memoised so a pick of 200 instances is not 200 searches. */
function makeSectorLookup(project) {
  let geometry = null;
  const memo = new Map();
  return entity => {
    const key = `${entity.x},${entity.y}`;
    if (memo.has(key)) return memo.get(key);
    geometry ||= sectorGeometry(project);
    const sector = sectorAt(geometry, entity.x, entity.y);
    memo.set(key, sector);
    return sector;
  };
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
  const numeric = property?.kind !== 'text';
  const right = numeric ? Number(value) : String(value);
  if (numeric && !Number.isFinite(right)) throw new Error(`${name} is a number; the comparison value must be a number`);
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
