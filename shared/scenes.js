// Scenes are reusable object groups: a scene holds objects (models, sprites, lights,
// physics, interaction areas) plus the events that script them, so it can be dropped
// into a map as one thing. Instances are copies, exactly like the rest of the editor
// data, so every placed object stays individually editable.
export const MAX_SCENES = 64;
export const MAX_SCENE_ENTITIES = 128;
export const MAX_SCENE_EVENTS = 256;
const ID_LIMIT = 120;

/** Scene identifiers follow the project's `<kind>_<random>` shape. */
export function newSceneId() {
  return `scene_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

const round = value => { const rounded = Math.round(value); return rounded === 0 ? 0 : rounded; };

function rotate(x, y, degrees) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function sceneBounds(scene) {
  const entities = scene?.entities || [];
  if (!entities.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const xs = entities.map(entity => entity.x), ys = entities.map(entity => entity.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function sceneOrigin(scene) {
  if (Number.isFinite(scene?.origin?.x) && Number.isFinite(scene?.origin?.y)) return { x: scene.origin.x, y: scene.origin.y };
  const bounds = sceneBounds(scene);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/** Rewrites every string that names a captured entity, so copied events follow their objects. */
function remapReferences(value, mapping, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') {
    return typeof value === 'string' && mapping.has(value) ? mapping.get(value) : value;
  }
  if (Array.isArray(value)) return value.map(child => remapReferences(child, mapping, depth + 1));
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = remapReferences(child, mapping, depth + 1);
  return result;
}

/**
 * Captures the given objects (and the events that own them) into a scene. Object
 * coordinates become relative to the scene origin, so placing the scene anywhere
 * reproduces the layout.
 */
export function captureScene(project, entityIds, { id = newSceneId(), name } = {}) {
  const ids = [...new Set(entityIds)];
  if (!ids.length) throw new Error('Select at least one object to capture a scene');
  if (ids.length > MAX_SCENE_ENTITIES) throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  const entities = ids.map(id => project.map.entities.find(entity => entity.id === id));
  if (entities.some(entity => !entity)) throw new Error('The selection references an object that no longer exists');
  if (entities.some(entity => entity.type === 'player')) throw new Error('A scene cannot contain the player object');
  const bounds = {
    minX: Math.min(...entities.map(entity => entity.x)), maxX: Math.max(...entities.map(entity => entity.x)),
    minY: Math.min(...entities.map(entity => entity.y)), maxY: Math.max(...entities.map(entity => entity.y)),
  };
  const origin = { x: round((bounds.minX + bounds.maxX) / 2), y: round((bounds.minY + bounds.maxY) / 2) };
  const owned = new Set(ids);
  const events = project.events.filter(event => event.ownerId && owned.has(event.ownerId));
  if (events.length > MAX_SCENE_EVENTS) throw new Error(`A scene holds at most ${MAX_SCENE_EVENTS} events`);
  return {
    id,
    name: (name || `Scene ${project.scenes ? project.scenes.length + 1 : 1}`).slice(0, 100),
    origin,
    entities: entities.map(entity => structuredClone({ ...entity, x: entity.x - origin.x, y: entity.y - origin.y })),
    events: structuredClone(events),
  };
}

/**
 * Copies a scene into a map at x/y/angle. Every object and event gets a fresh id and
 * event references are rewritten, so instances never share identifiers.
 */
export function instantiateScene(scene, { x = 0, y = 0, angle = 0, prefix = newSceneId().replace('scene_', 'instance_') } = {}) {
  if (!scene || !Array.isArray(scene.entities)) throw new Error('Unknown scene');
  const mapping = new Map();
  for (const entity of scene.entities) {
    const copy = `${prefix}_${entity.id}`;
    if (copy.length > ID_LIMIT) throw new Error('Scene object identifiers are too long to copy');
    mapping.set(entity.id, copy);
  }
  const entities = scene.entities.map(entity => {
    const offset = rotate(entity.x, entity.y, angle);
    const copy = structuredClone(entity);
    copy.id = mapping.get(entity.id);
    copy.x = round(x + offset.x);
    copy.y = round(y + offset.y);
    copy.angle = (Number(entity.angle) || 0) + angle;
    return copy;
  });
  const events = (scene.events || []).map(event => {
    const copy = remapReferences(structuredClone(event), mapping);
    copy.id = `${prefix}_${event.id}`.slice(0, ID_LIMIT);
    if (event.sheetId !== undefined) delete copy.sheetId;
    return copy;
  });
  return { entities, events, prefix };
}

/** True when the scene has something to draw, so empty scenes can be reported. */
export function sceneIsEmpty(scene) {
  return !scene?.entities?.length;
}
