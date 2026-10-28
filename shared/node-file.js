// Single-node files: one node — or one node with the group under it — saved as its own
// `.node` document and imported into another scene later.
//
// A node is not portable on its own: it names artwork by asset id, may run a shader and
// may be held by joints. A `.node` file therefore carries the subtree, the joints inside
// it, the assets and shaders it references (embedded, so the file works on another
// machine) and the events that only talk to objects inside the subtree. Coordinates are
// stored relative to the group, so importing places the group wherever the pointer is.
import { validateEntity, cloneProjectData } from './project.js';
import { sceneEntityId, sceneSubtree, remapReferences, MAX_SCENE_ENTITIES, MAX_SCENE_EVENTS } from './scenes.js';
import { MAX_JOINTS, validateJoint, newJointId } from './joints.js';

export const NODE_FILE_FORMAT = 'opendle-node';
export const NODE_FILE_VERSION = 1;
export const NODE_FILE_EXTENSION = '.node';
/** A node file is text; models alone can reach the model budget, so this is generous. */
export const MAX_NODE_FILE_CHARS = 48 * 1024 * 1024;

const round = value => {
  const rounded = Math.round(Number(value) || 0);
  return rounded === 0 ? 0 : rounded;
};

/** The entity ids a command points at, ignoring the special `$self`/`$world` targets. */
function commandReferences(command) {
  const refs = [];
  for (const key of ['entityId', 'otherId', 'templateId']) {
    const value = command?.[key];
    if (typeof value === 'string' && value && !value.startsWith('$')) refs.push(value);
  }
  return refs;
}

/**
 * Builds the document for one node and its group.
 *
 * `name` defaults to the node's name. Assets and shaders that the subtree references are
 * embedded; events are kept only when every object they name is inside the subtree,
 * because an imported event that points at an object the destination does not have would
 * make the project invalid.
 */
export function exportNodeFile(scene, nodeId, { name, assets = [], shaders = [] } = {}) {
  // Selecting the scene root means "save the whole scene", so the top-level nodes are
  // wrapped in a group named after the scene and travel as one object.
  const wholeScene = nodeId === scene?.id;
  const subtree = wholeScene ? [...(scene.entities || [])] : sceneSubtree(scene, nodeId);
  if (!subtree.length) throw new Error('That node no longer exists');
  const root = wholeScene ? { id: `${scene.id}_root`, type: 'decoration', name: name || scene.name || 'Scene',
    x: 0, y: 0, angle: 0, elevation: 0 } : null;
  const carried = root ? [root, ...subtree] : subtree;
  if (carried.length > MAX_SCENE_ENTITIES) throw new Error(`A node file holds at most ${MAX_SCENE_ENTITIES} nodes`);
  const ids = new Set(subtree.map(node => node.id));
  const minX = Math.min(...carried.map(node => node.x));
  const minY = Math.min(...carried.map(node => node.y));
  const nodes = carried.map(node => {
    const copy = cloneProjectData(node);
    copy.x = round(node.x - minX);
    copy.y = round(node.y - minY);
    if (root && node.id !== root.id && !copy.parentId) copy.parentId = root.id;
    return copy;
  });

  // Joints with both ends in the subtree, plus the ones that hang it from the world.
  const joints = (scene.joints || [])
    .filter(joint => (joint.a ? ids.has(joint.a) : true) && (joint.b ? ids.has(joint.b) : true)
      && (ids.has(joint.a) || ids.has(joint.b)))
    .map(joint => {
      const copy = cloneProjectData(joint);
      if (copy.anchor) { copy.anchor.x = round(copy.anchor.x - minX); copy.anchor.y = round(copy.anchor.y - minY); }
      return copy;
    });

  const assetIds = new Set(), shaderIds = new Set();
  for (const node of subtree) {
    if (node.spriteAsset) assetIds.add(node.spriteAsset);
    if (node.modelAsset) assetIds.add(node.modelAsset);
    for (const clipId of Object.values(node.spriteStates || {})) assetIds.add(clipId);
    if (node.shaderId) shaderIds.add(node.shaderId);
  }
  const embeddedAssets = cloneProjectData((assets || []).filter(asset => assetIds.has(asset.id)));
  const missingAssets = [...assetIds].filter(id => !embeddedAssets.some(asset => asset.id === id));
  const embeddedShaders = cloneProjectData((shaders || []).filter(shader => shaderIds.has(shader.id)));
  const missingShaders = [...shaderIds].filter(id => !embeddedShaders.some(shader => shader.id === id));

  const owners = (scene.events || []).filter(event => event.ownerId && ids.has(event.ownerId));
  const keptEvents = [], droppedEvents = [];
  for (const event of owners) {
    const commands = [...(event.conditions || []), event.condition, ...(event.actions || [])].filter(Boolean);
    const outside = commands.flatMap(commandReferences).filter(id => !ids.has(id));
    if (outside.length) droppedEvents.push(event.name || event.id);
    else keptEvents.push(cloneProjectData(event));
  }

  const warnings = [];
  if (missingAssets.length) warnings.push(`Missing artwork: ${missingAssets.join(', ')}`);
  if (missingShaders.length) warnings.push(`Missing shaders: ${missingShaders.join(', ')}`);
  if (droppedEvents.length) warnings.push(`${droppedEvents.length} event(s) left out because they use objects outside this node`);

  return {
    format: NODE_FILE_FORMAT,
    version: NODE_FILE_VERSION,
    name: String(name || root?.name || subtree[0].name || 'Node').slice(0, 100),
    createdAt: new Date().toISOString(),
    // The group's floor corner, so an importer can place it without guesswork.
    origin: { x: round(minX), y: round(minY) },
    nodes,
    joints,
    events: keptEvents,
    assets: embeddedAssets,
    shaders: embeddedShaders,
    warnings,
  };
}

/** The file text: readable JSON, because a `.node` file is meant to be inspectable. */
export function nodeFileText(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseNodeFile(text, { maxChars = MAX_NODE_FILE_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('That .node file is empty');
  if (text.length > maxChars) throw new Error(`A .node file is limited to ${Math.round(maxChars / 1048576)} MiB`);
  let document;
  try { document = JSON.parse(text); } catch (error) { throw new Error(`That .node file is not JSON: ${error.message}`); }
  validateNodeFile(document);
  return document;
}

/**
 * Throws unless the document is a node file this build can import. Every node is checked
 * with the same rules a scene object is, against the artwork the file itself carries, so
 * a damaged or hand-edited file cannot reach the project.
 */
export function validateNodeFile(document) {
  const fail = message => { throw new Error(`Not a usable .node file: ${message}`); };
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('the document must be an object');
  if (document.format !== NODE_FILE_FORMAT) fail(`format must be "${NODE_FILE_FORMAT}"`);
  if (document.version !== NODE_FILE_VERSION) fail(`version ${document.version} is not supported (this build reads version ${NODE_FILE_VERSION})`);
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.length > 100) fail('it needs a name');
  if (!Array.isArray(document.nodes) || !document.nodes.length) fail('it has no nodes');
  if (document.nodes.length > MAX_SCENE_ENTITIES) fail(`a node file holds at most ${MAX_SCENE_ENTITIES} nodes`);

  const assets = Array.isArray(document.assets) ? document.assets : [];
  const shaders = Array.isArray(document.shaders) ? document.shaders : [];
  const assetIds = new Set(assets.map(asset => asset?.id));
  const shaderIds = new Set(shaders.map(shader => shader?.id));
  const assetRef = (id, label) => {
    if (id === undefined || id === null) return;
    if (typeof id !== 'string' || !assetIds.has(id)) fail(`${label} ${id} is not part of the file`);
  };
  const clipRef = id => {
    if (id !== undefined && id !== null && typeof id !== 'string') fail('a sprite state must name a clip');
  };
  const modelRef = id => assetRef(id, 'Model');

  const ids = new Set();
  for (const node of document.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('every node must be an object');
    if (typeof node.id !== 'string' || !node.id || node.id.length > 120) fail('every node needs an id');
    if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
    ids.add(node.id);
    if (node.type === 'player') fail('a node file cannot contain the player object');
    try { validateEntity(node, { assetRef, clipRef, modelRef, assets }); }
    catch (error) { fail(`${node.id}: ${error.message}`); }
    if (node.shaderId !== undefined && !shaderIds.has(node.shaderId)) fail(`shader ${node.shaderId} is not part of the file`);
  }
  // Grouping must stay a tree inside the file.
  for (const node of document.nodes) {
    if (node.parentId === undefined) continue;
    if (!ids.has(node.parentId)) fail(`node ${node.id} is grouped under the unknown node ${node.parentId}`);
    const seen = new Set([node.id]);
    let parent = node.parentId;
    for (let depth = 0; parent && depth <= document.nodes.length; depth++) {
      if (seen.has(parent)) fail(`grouping has a cycle at ${node.id}`);
      seen.add(parent);
      parent = document.nodes.find(item => item.id === parent)?.parentId;
    }
  }
  if (document.joints !== undefined) {
    if (!Array.isArray(document.joints) || document.joints.length > MAX_JOINTS) fail(`it holds at most ${MAX_JOINTS} joints`);
    for (const joint of document.joints) {
      try { validateJoint(joint, { ids, label: `Joint ${joint?.id}` }); }
      catch (error) { fail(error.message); }
      for (const side of [joint.a, joint.b]) {
        if (!side) continue;
        const node = document.nodes.find(item => item.id === side);
        if (!node.physics || node.physics.body === 'none') fail(`joint ${joint.id} needs objects with a rigid body`);
      }
    }
  }
  if (document.events !== undefined) {
    if (!Array.isArray(document.events) || document.events.length > MAX_SCENE_EVENTS) fail(`it holds at most ${MAX_SCENE_EVENTS} events`);
    for (const event of document.events) {
      if (!event || typeof event !== 'object') fail('every event must be an object');
      if (event.ownerId !== undefined && !ids.has(event.ownerId)) fail(`event ${event.id} is owned by an object the file does not contain`);
    }
  }
  if (document.origin !== undefined) {
    if (!document.origin || !['x', 'y'].every(key => Number.isFinite(document.origin[key]))) fail('the origin must be two numbers');
  }
  return document;
}

/**
 * Adds the document's nodes to a scene at x/y. Assets and shaders must already be in the
 * project — the app installs them in the same edit — and every id is fresh, so importing
 * the same file twice never collides with what is already there.
 */
export function applyNodeFile(scene, document, {
  x = 0, y = 0, parentId = null, degrees = 0, assetRemap = new Map(), shaderRemap = new Map(),
} = {}) {
  validateNodeFile(document);
  if (!scene) throw new Error('There is no scene to import into');
  if ((scene.entities || []).length + document.nodes.length > MAX_SCENE_ENTITIES) {
    throw new Error(`A scene holds at most ${MAX_SCENE_ENTITIES} objects`);
  }
  const radians = (Number(degrees) || 0) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const mapping = new Map();
  for (const node of document.nodes) mapping.set(node.id, sceneEntityId(scene, node.id));
  const roots = document.nodes.filter(node => !node.parentId);
  const copies = document.nodes.map(node => {
    const copy = cloneProjectData(node);
    copy.id = mapping.get(node.id);
    // Relative coordinates are turned by `degrees`, so a rotated import still lines up.
    const local = { x: node.x, y: node.y };
    copy.x = round(x + local.x * cos - local.y * sin);
    copy.y = round(y + local.x * sin + local.y * cos);
    copy.angle = (Number(node.angle) || 0) + (Number(degrees) || 0);
    if (node.parentId) copy.parentId = mapping.get(node.parentId);
    else if (parentId) copy.parentId = parentId;
    // An asset that clashed with different artwork in the destination got a new id.
    if (copy.spriteAsset && assetRemap.has(copy.spriteAsset)) copy.spriteAsset = assetRemap.get(copy.spriteAsset);
    if (copy.modelAsset && assetRemap.has(copy.modelAsset)) copy.modelAsset = assetRemap.get(copy.modelAsset);
    if (copy.spriteStates) {
      for (const [state, id] of Object.entries(copy.spriteStates)) {
        if (assetRemap.has(id)) copy.spriteStates[state] = assetRemap.get(id);
      }
    }
    if (copy.shaderId && shaderRemap.has(copy.shaderId)) copy.shaderId = shaderRemap.get(copy.shaderId);
    return copy;
  });
  scene.entities.push(...copies);

  const joints = (document.joints || []).map(joint => {
    const copy = cloneProjectData(joint);
    copy.id = newJointId();
    if (copy.a) copy.a = mapping.get(copy.a);
    if (copy.b) copy.b = mapping.get(copy.b);
    const local = { x: copy.anchor.x, y: copy.anchor.y };
    copy.anchor.x = round(x + local.x * cos - local.y * sin);
    copy.anchor.y = round(y + local.x * sin + local.y * cos);
    return copy;
  });
  if (joints.length) {
    if ((scene.joints || []).length + joints.length > MAX_JOINTS) throw new Error(`A scene holds at most ${MAX_JOINTS} joints`);
    scene.joints = [...(scene.joints || []), ...joints];
  }

  const events = (document.events || []).map(event => {
    const copy = remapReferences(cloneProjectData(event), mapping);
    copy.id = `${event.id}_import_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`.slice(0, 120);
    if (event.ownerId) copy.ownerId = mapping.get(event.ownerId);
    return copy;
  });
  if (events.length) {
    if ((scene.events || []).length + events.length > MAX_SCENE_EVENTS) throw new Error(`A scene holds at most ${MAX_SCENE_EVENTS} events`);
    scene.events = [...(scene.events || []), ...events];
  }

  return { ids: copies.map(copy => copy.id), root: roots.length ? mapping.get(roots[0].id) : null,
    assets: document.assets || [], shaders: document.shaders || [] };
}

const freshId = base => `${String(base).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_r${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

/**
 * Works out what a destination project has to gain before the nodes land in it.
 *
 * An asset the project already has — same id, same kind, same payload — is reused so
 * importing the same file twice does not duplicate artwork. An id that exists with
 * different content gets a fresh id, and the copied nodes are re-pointed at it, so a file
 * never silently picks up someone else's texture.
 */
export function planNodeFileInstall(document, { assets = [], shaders = [] } = {}) {
  validateNodeFile(document);
  const assetRemap = new Map(), shaderRemap = new Map();
  const addAssets = [], addShaders = [];
  const byAssetId = new Map(assets.map(asset => [asset.id, asset]));
  for (const incoming of document.assets || []) {
    const existing = byAssetId.get(incoming.id);
    if (!existing) { addAssets.push(incoming); continue; }
    const same = existing.kind === incoming.kind && existing.src === incoming.src && existing.name === incoming.name;
    if (same) continue;
    const id = freshId(incoming.id);
    assetRemap.set(incoming.id, id);
    addAssets.push({ ...incoming, id });
  }
  const byShaderId = new Map(shaders.map(shader => [shader.id, shader]));
  for (const incoming of document.shaders || []) {
    const existing = byShaderId.get(incoming.id);
    if (!existing) { addShaders.push(incoming); continue; }
    if (existing.source === incoming.source) continue;
    const id = freshId(incoming.id);
    shaderRemap.set(incoming.id, id);
    addShaders.push({ ...incoming, id });
  }
  return { assetRemap, shaderRemap, addAssets, addShaders };
}

/** The file name a saved node should get: the node's name, made safe for a filesystem. */
export function nodeFileName(name) {
  const base = String(name || 'node').trim().replace(/[^a-zA-Z0-9 _-]+/g, '').replace(/[ _]+/g, '-').replace(/^-+|-+$/g, '');
  return `${(base || 'node').slice(0, 60)}${NODE_FILE_EXTENSION}`;
}
