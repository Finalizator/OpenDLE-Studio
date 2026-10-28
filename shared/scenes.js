// Scenes are reusable object groups: a scene holds objects (models, sprites, lights,
// physics, interaction areas) plus the events that script them, so it can be dropped
// into a map as one thing. Instances are copies, exactly like the rest of the editor
// data, so every placed object stays individually editable.
import { MAX_JOINTS, pruneJoints, remapJoint } from './joints.js';

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
  // A joint is captured only when both of its objects come along, so a captured group
  // keeps its hinges and sliders.
  const joints = (project.map.joints || []).filter(joint => owned.has(joint.a) && owned.has(joint.b));
  if (events.length > MAX_SCENE_EVENTS) throw new Error(`A scene holds at most ${MAX_SCENE_EVENTS} events`);
  return {
    id,
    name: (name || `Scene ${project.scenes ? project.scenes.length + 1 : 1}`).slice(0, 100),
    origin,
    entities: entities.map(entity => structuredClone({ ...entity, x: entity.x - origin.x, y: entity.y - origin.y })),
    events: structuredClone(events),
    joints: structuredClone(joints),
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
    // Grouping is an editing aid inside the scene; a placed copy joins the flat map.
    delete copy.parentId;
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
  // A placed copy keeps its joints, re-pointed at the copied objects.
  const joints = (scene.joints || []).map(joint => remapJoint(joint, mapping, { id: `${prefix}_${joint.id}` }));
  return { entities, events, joints, prefix };
}

/** True when the scene has something to draw, so empty scenes can be reported. */
export function sceneIsEmpty(scene) {
  return !scene?.entities?.length;
}

/* ------------------------------------------------------------------------- *
 * Scene object editing
 *
 * A scene's objects are also its node tree: `parentId` groups them the way a Godot
 * scene groups nodes, so an editor can fold a group, move a whole branch and show
 * where each object belongs. Coordinates stay absolute inside the scene (a child is
 * not re-based on its parent), so placing a scene in a map behaves exactly as before
 * and an imported or captured scene is still a flat list.
 * ------------------------------------------------------------------------- */

const MAX_DEPTH = 16;

/** Children of every parent, in stored order, with the roots under `''`. */
export function sceneChildren(scene) {
  const known = new Set((scene?.entities || []).map(entity => entity.id));
  const children = new Map();
  for (const entity of scene?.entities || []) {
    const parent = entity.parentId && known.has(entity.parentId) && entity.parentId !== entity.id ? entity.parentId : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entity);
  }
  return children;
}

/** Depth of each object (roots are 0), clamped so a malformed chain cannot loop. */
export function sceneDepths(scene) {
  const children = sceneChildren(scene), depths = new Map();
  const walk = (parent, depth) => {
    for (const entity of children.get(parent) || []) {
      depths.set(entity.id, depth);
      if (depth < MAX_DEPTH) walk(entity.id, depth + 1);
    }
  };
  walk('', 0);
  for (const entity of scene?.entities || []) if (!depths.has(entity.id)) depths.set(entity.id, 0);
  return depths;
}

/** An object plus everything grouped under it, parents first. */
export function sceneSubtree(scene, id) {
  const children = sceneChildren(scene), out = [];
  const walk = (entity) => {
    out.push(entity);
    for (const child of children.get(entity.id) || []) walk(child);
  };
  const root = (scene?.entities || []).find(entity => entity.id === id);
  if (root) walk(root);
  return out;
}

/** Every object that would be shown folded with `id` collapsed. */
export function sceneDescendants(scene, id) {
  return sceneSubtree(scene, id).slice(1).map(entity => entity.id);
}

function sceneEntityId(scene, base) {
  const used = new Set((scene.entities || []).map(entity => entity.id));
  if (used.has(base)) base = `${base}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  return base.slice(0, ID_LIMIT);
}

/** A new, empty scene with the name the caller asked for. */
export function newScene(name = 'Scene') {
  return { id: newSceneId(), name: String(name).slice(0, 100), origin: { x: 0, y: 0 }, entities: [], events: [], joints: [] };
}

/** Adds an object under `parentId` (or at the root) and returns it. */
export function addSceneObject(scene, { type = 'decoration', name, x = 0, y = 0, parentId = null, ...rest } = {}) {
  if (!Array.isArray(scene.entities)) throw new Error('Scene has no object list');
  if (scene.entities.length >= MAX_SCENE_ENTITIES) throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  if (parentId && !scene.entities.some(entity => entity.id === parentId)) throw new Error('Unknown parent object');
  const label = name || `New ${type}`;
  const entity = {
    id: sceneEntityId(scene, `node_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'object'}`),
    type, name: String(label).slice(0, 100), x: round(x), y: round(y), angle: 0, elevation: 0,
    ...(parentId ? { parentId } : {}),
    ...(type === 'light' ? { light: { color: '#ffbd72', intensity: 1, radius: 192 } } : {}),
    ...rest,
  };
  scene.entities.push(entity);
  return entity;
}

/** Removes objects, everything grouped under them, and the events that scripted them. */
export function removeSceneObjects(scene, ids) {
  const removing = new Set();
  for (const id of [].concat(ids)) for (const entity of sceneSubtree(scene, id)) removing.add(entity.id);
  if (!removing.size) return { removed: 0, events: 0 };
  const events = (scene.events || []).filter(event => event.ownerId && removing.has(event.ownerId));
  scene.events = (scene.events || []).filter(event => !event.ownerId || !removing.has(event.ownerId));
  scene.entities = scene.entities.filter(entity => !removing.has(entity.id));
  const joints = (scene.joints || []).length;
  scene.joints = pruneJoints(scene.joints, scene.entities.map(entity => entity.id));
  return { removed: removing.size, events: events.length, joints: joints - scene.joints.length };
}

/** Copies an object (and its group) with fresh ids, nudged so the copy is visible. */
export function duplicateSceneObject(scene, id, { offset = 32 } = {}) {
  const subtree = sceneSubtree(scene, id);
  if (!subtree.length) throw new Error('That object no longer exists');
  const added = subtree.length;
  if (scene.entities.length + added > MAX_SCENE_ENTITIES) throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  const mapping = new Map();
  for (const entity of subtree) mapping.set(entity.id, sceneEntityId(scene, `${entity.id}_copy`));
  const copies = subtree.map(entity => {
    const copy = structuredClone(entity);
    copy.id = mapping.get(entity.id);
    if (entity.parentId && mapping.has(entity.parentId)) copy.parentId = mapping.get(entity.parentId);
    copy.x = round(entity.x + offset);
    copy.y = round(entity.y + offset);
    copy.name = `${entity.name} copy`.slice(0, 100);
    return copy;
  });
  scene.entities.push(...copies);
  const idMap = mapping;
  const events = (scene.events || []).filter(event => event.ownerId && mapping.has(event.ownerId)).map(event => {
    const copy = remapReferences(structuredClone(event), idMap);
    copy.id = `${event.id}_copy_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`.slice(0, ID_LIMIT);
    copy.ownerId = idMap.get(event.ownerId);
    return copy;
  });
  if ((scene.events || []).length + events.length <= MAX_SCENE_EVENTS) scene.events = [...(scene.events || []), ...events];
  // Only joints whose two ends were both copied can be duplicated.
  const joints = (scene.joints || []).filter(joint => mapping.has(joint.a) && mapping.has(joint.b))
    .map(joint => remapJoint(joint, idMap, { id: `${joint.id}_copy_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 6)}` }));
  if ((scene.joints || []).length + joints.length <= MAX_JOINTS) scene.joints = [...(scene.joints || []), ...joints];
  return { ids: copies.map(copy => copy.id), root: mapping.get(id), joints: joints.map(joint => joint.id) };
}

/** Moves an object (with its group) under another object, or back to the scene root. */
export function reparentSceneObject(scene, id, parentId) {
  const entity = (scene.entities || []).find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  if (parentId) {
    if (parentId === id) throw new Error('An object cannot be grouped under itself');
    if (!scene.entities.some(item => item.id === parentId)) throw new Error('Unknown parent object');
    if (sceneDescendants(scene, id).includes(parentId)) throw new Error('An object cannot be grouped under its own child');
  }
  if (parentId) entity.parentId = parentId;
  else delete entity.parentId;
  return entity;
}

/** Reorders an object among its siblings; `direction` is -1 (up) or 1 (down). */
export function moveSceneObject(scene, id, direction) {
  const entity = (scene?.entities || []).find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  const siblings = (sceneChildren(scene).get(entity.parentId || '') || []).map(sibling => sibling.id);
  const index = siblings.indexOf(id), target = index + Math.sign(direction);
  if (index < 0 || target < 0 || target >= siblings.length) return false;
  // Stored order is the display order, so swap the two records in the array.
  const order = new Map(scene.entities.map((item, position) => [item.id, position]));
  const swap = siblings[target];
  const first = order.get(id), second = order.get(swap);
  const temporary = scene.entities[first];
  scene.entities[first] = scene.entities[second];
  scene.entities[second] = temporary;
  return true;
}

/** Renames one object, rejecting empty names. */
export function renameSceneObject(scene, id, name) {
  const entity = (scene?.entities || []).find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('An object name cannot be empty');
  if (clean.length > 100) throw new Error('Object names are limited to 100 characters');
  entity.name = clean;
  return entity;
}

/* ------------------------------------------------------------------------- *
 * Assets on scene objects
 *
 * Dropping an asset on a scene is the same gesture as dropping it on the layout: a
 * picture becomes the object's sprite, a 3D model becomes its mesh, and dropping it on
 * empty space places a new decoration that already carries it.
 * ------------------------------------------------------------------------- */

const SPRITE_ASSET_KINDS = ['sprite', 'weapon', 'flat', 'texture', 'sky', 'image', 'hud'];

/** 'sprite', 'model' or null for an asset a scene object cannot show. */
export function sceneAssetUse(asset) {
  if (!asset || typeof asset !== 'object') return null;
  if (asset.kind === 'model') return 'model';
  return SPRITE_ASSET_KINDS.includes(asset.kind) ? 'sprite' : null;
}

function uniqueSceneName(scene, base) {
  const names = new Set((scene.entities || []).map(entity => entity.name));
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) if (!names.has(`${base} ${index}`)) return `${base} ${index}`;
}

/** The name a newly placed object takes from an asset: the file name without its extension. */
export function sceneAssetName(asset) {
  const base = String(asset?.name || 'Object').replace(/\.[^.]+$/, '').trim();
  return (base || 'Object').slice(0, 100);
}

/** Points an existing scene object at an asset, dropping the other kind of artwork. */
export function setSceneObjectAsset(scene, id, asset) {
  const entity = (scene?.entities || []).find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  const use = sceneAssetUse(asset);
  if (!use) throw new Error(`${asset?.name || 'That asset'} is not a picture or a model; drop a sprite, an image or a 3D model on a node`);
  if (use === 'model') {
    entity.modelAsset = asset.id;
    delete entity.animation;
    return `Model ${asset.name} set on ${entity.name}`;
  }
  const hadModel = Boolean(entity.modelAsset);
  entity.spriteAsset = asset.id;
  if (hadModel) { delete entity.modelAsset; delete entity.animation; }
  return `Sprite ${asset.name} set on ${entity.name}${hadModel ? ' (3D model removed)' : ''}`;
}

/** Places a new object that already carries `asset`, at x/y, optionally under a parent. */
export function addSceneObjectFromAsset(scene, asset, { x = 0, y = 0, parentId = null, type = 'decoration' } = {}) {
  const use = sceneAssetUse(asset);
  if (!use) throw new Error(`${asset?.name || 'That asset'} is not a picture or a model`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Drop the asset inside the scene view to place it');
  const artwork = use === 'model' ? { modelAsset: asset.id, modelScale: 32 } : { spriteAsset: asset.id };
  return addSceneObject(scene, {
    type, name: uniqueSceneName(scene, sceneAssetName(asset)), x, y, parentId, ...artwork,
  });
}

/** Copies a layout object into a scene, so dragging an object tile into a scene works. */
export function addSceneObjectFromEntity(scene, entity, { x = 0, y = 0, parentId = null } = {}) {
  if (!entity) throw new Error('That object no longer exists');
  if (entity.type === 'player') throw new Error('A scene cannot contain the player object');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Drop the object inside the scene view');
  const copy = structuredClone(entity);
  copy.id = sceneEntityId(scene, `${entity.id}_in_scene`);
  copy.x = round(x);
  copy.y = round(y);
  copy.name = uniqueSceneName(scene, entity.name).slice(0, 100);
  delete copy.parentId;
  if (parentId) copy.parentId = parentId;
  if ((scene.entities || []).length >= MAX_SCENE_ENTITIES) throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  scene.entities.push(copy);
  return copy;
}

/**
 * Nesting a scene inside another scene, which is how a Godot scene instance behaves:
 * the copied nodes become children of one group node named after the source.
 */
export function nestScene(scene, source, { x = 0, y = 0, parentId = null } = {}) {
  if (!source || !Array.isArray(source.entities)) throw new Error('That scene object no longer exists');
  if (source.id === scene.id) throw new Error('A scene cannot be placed inside itself');
  if (!source.entities.length) throw new Error(`${source.name} has no objects to place`);
  if ((scene.entities || []).length + source.entities.length + 1 > MAX_SCENE_ENTITIES) {
    throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  }
  const group = addSceneObject(scene, {
    type: 'decoration', name: uniqueSceneName(scene, source.name).slice(0, 100), x, y, parentId,
  });
  const origin = sceneOrigin(source);
  const mapping = new Map(source.entities.map(entity => [entity.id, sceneEntityId(scene, `${group.id}_${entity.id}`)]));
  const copies = source.entities.map(entity => {
    const copy = structuredClone(entity);
    copy.id = mapping.get(entity.id);
    copy.parentId = entity.parentId && mapping.has(entity.parentId) ? mapping.get(entity.parentId) : group.id;
    copy.x = round(entity.x - origin.x + x);
    copy.y = round(entity.y - origin.y + y);
    return copy;
  });
  scene.entities.push(...copies);
  const events = (source.events || []).filter(event => event.ownerId && mapping.has(event.ownerId));
  const room = MAX_SCENE_EVENTS - (scene.events || []).length;
  if (events.length && room > 0) {
    scene.events = [...(scene.events || []), ...events.slice(0, room).map(event => {
      const copy = remapReferences(structuredClone(event), mapping);
      copy.id = `${event.id}_nest_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`.slice(0, ID_LIMIT);
      copy.ownerId = mapping.get(event.ownerId);
      if (event.sheetId !== undefined) delete copy.sheetId;
      return copy;
    })];
  }
  const jointCopies = (source.joints || []).filter(joint => mapping.has(joint.a) && mapping.has(joint.b))
    .map(joint => remapJoint(joint, mapping, { id: `${group.id}_${joint.id}` }));
  if ((scene.joints || []).length + jointCopies.length <= MAX_JOINTS) scene.joints = [...(scene.joints || []), ...jointCopies];
  return { group, ids: copies.map(copy => copy.id), joints: jointCopies.map(joint => joint.id) };
}

/**
 * The artwork a scene object draws: the sprite image and its world size, or the model's
 * preview picture. The scene view uses this so assigning an asset visibly changes
 * something instead of leaving a plain box.
 */
export function sceneArtwork(entity, assets) {
  if (!entity) return null;
  const find = id => (assets || []).find(asset => asset && asset.id === id) || null;
  if (entity.modelAsset) {
    const asset = find(entity.modelAsset);
    const size = Math.max(1, Number(entity.modelScale) || 32);
    return { kind: 'model', asset, src: asset?.preview || null, width: size, height: size,
      label: asset?.name || entity.modelAsset };
  }
  if (entity.spriteAsset) {
    const asset = find(entity.spriteAsset);
    if (!asset) return null;
    const scale = Number(entity.spriteScale) || 1;
    return { kind: 'sprite', asset, src: asset.src || null,
      width: Math.max(1, (asset.width || 32) * scale), height: Math.max(1, (asset.height || 32) * scale),
      label: asset.name };
  }
  return null;
}
