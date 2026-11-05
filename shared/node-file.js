// Single-node files: one node — or one node with the group under it — saved as its own
// `.node` document and imported into another scene later.
//
// A node is not portable on its own: it names artwork by asset id, may run a shader and
// may be held by joints. A `.node` file therefore carries the subtree, the joints inside
// it, the assets and shaders it references (embedded, so the file works on another
// machine) and the events that only talk to objects inside the subtree. Coordinates are
// stored relative to the group, so importing places the group wherever the pointer is.
import { validateEntity, cloneProjectData } from './project.js';
import {
  sceneEntityId, sceneSubtree, sceneEventsForEntities, sceneEventTargets, remapReferences,
  MAX_SCENE_ENTITIES, MAX_SCENE_EVENTS,
} from './scenes.js';
import { MAX_JOINTS, validateJoint, newJointId, jointWithin, transformJoint } from './joints.js';
import { MODEL_FACING_SEMANTICS, hasModelFacing } from './entity-visuals.js';
import { bakePathRamp } from './paths.js';
import { validateSignalEvent } from './signals.js';
import { createSceneInstanceGroup, sceneInstanceOf, membersOf } from './entity-groups.js';

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
  return sceneEventTargets(command).map(target => target.id);
}

/** Every command of a rule, including the ones inside its sub-events. */
function eventCommands(event) {
  return [...(event?.conditions || []), event?.condition, ...(event?.actions || [])].filter(Boolean);
}

/**
 * The references a command makes that a node file cannot bring along.
 *
 * A file carries the object, its artwork, its shaders, its sprite clips and its own script. What
 * it cannot carry is a name from one of the project's own tables — a route, a timesheet, a
 * linedef, a HUD element — so a rule that names one is left out rather than written into a file
 * that would dangle the moment it lands somewhere else.
 */
const UNCARRYABLE_FIELDS = ['pathId', 'timesheetId', 'wallId', 'sectorId', 'zoneId', 'elementId', 'animationId', 'screen', 'levelId'];

/** The fields naming a picture (carried as an asset) and the fields naming a sprite clip. */
const ASSET_FIELDS = ['assetId'];
const CLIP_FIELDS = ['clipId', 'impactClipId'];
const stableJson = value => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
};
const sameResource = (left, right) => {
  const withoutId = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'id'));
  return JSON.stringify(stableJson(withoutId(left))) === JSON.stringify(stableJson(withoutId(right)));
};

/**
 * Builds the document for one node and its group.
 *
 * `name` defaults to the node's name. Assets and shaders that the subtree references are
 * embedded; events are kept only when every object they name is inside the subtree,
 * because an imported event that points at an object the destination does not have would
 * make the project invalid.
 */
/**
 * The layout read as a container of the same shape a scene has, so one exporter serves both.
 *
 * A layout object is a node in every way that matters — it has artwork, a body, an interaction
 * area, variables and possibly a visual script — and it was the one thing that could not be
 * saved on its own. What differs is only where its table lives: `map.entities` and `events`
 * instead of a scene's own.
 */
export function layoutContainer(project) {
  // The container is a live view: the importer pushes into these arrays, so a missing one has to
  // become the project's own empty array rather than a throwaway.
  const map = project?.map || (project.map = {});
  map.entities ||= [];
  map.joints ||= [];
  project.events ||= [];
  project.spriteClips ||= [];
  project.eventSheets ||= [];
  project.eventGroups ||= [];
  return {
    id: 'layout',
    name: project?.title || 'Layout',
    entities: map.entities,
    events: project.events,
    joints: map.joints,
    spriteClips: project.spriteClips,
    eventSheets: project.eventSheets,
    eventGroups: project.eventGroups,
    layoutProject: project,
  };
}

/**
 * Builds the document for one node and its group.
 *
 * `name` defaults to the node's name. Assets and shaders that the subtree references are
 * embedded; `includeEvents` says whether the object's visual script travels with it, and events
 * are kept only when every object they name is inside the subtree, because an imported event
 * that points at an object the destination does not have would make the project invalid.
 *
 * Two references cannot travel at all: a route (`entity.path`) and a layout object group
 * (`entity.groupId`) both name things the project owns rather than the object. They are dropped
 * and reported instead of being written into a file that would dangle on import.
 */
export function exportNodeFile(scene, nodeId, { name, assets = [], shaders = [], clips = null, eventSheets = null, eventGroups = null, includeEvents = true } = {}) {
  // Selecting the scene root means "save the whole scene", so the top-level nodes are
  // wrapped in a group named after the scene and travel as one object.
  const wholeScene = nodeId === scene?.id;
  const instance = scene.layoutProject ? sceneInstanceOf(scene.layoutProject, nodeId) : null;
  if (instance) {
    const members = membersOf(scene.layoutProject, instance.id).map(entity => {
      const copy = cloneProjectData(entity);
      delete copy.groupId;
      return copy;
    });
    const events = sceneEventsForEntities(scene.events || [], new Set(members.map(entity => entity.id)));
    return exportNodeFile({ ...scene, layoutProject: null, id: instance.id, name: instance.name, entities: members, events },
      instance.id, { name, assets, shaders, clips, eventSheets, eventGroups, includeEvents });
  }
  const subtree = wholeScene ? [...(scene.entities || [])] : sceneSubtree(scene, nodeId);
  if (!subtree.length) throw new Error('That node no longer exists');
  const root = wholeScene ? { id: `${scene.id}_root`, type: 'decoration', name: name || scene.name || 'Scene',
    x: 0, y: 0, angle: 0, elevation: 0 } : null;
  const carried = root ? [root, ...subtree] : subtree;
  if (carried.length > MAX_SCENE_ENTITIES) throw new Error(`A node file holds at most ${MAX_SCENE_ENTITIES} nodes`);
  const ids = new Set(subtree.map(node => node.id));
  const owners = wholeScene ? scene.events || [] : sceneEventsForEntities(scene.events || [], ids);
  const selectedEvents = new Set(owners);
  const carriedIds = new Set(carried.map(node => node.id));
  const availableGroups = new Set(((eventGroups ?? scene.eventGroups) || []).map(group => group.id));
  const minX = Math.min(...carried.map(node => node.x));
  const minY = Math.min(...carried.map(node => node.y));
  let droppedRoutes = 0, droppedGroups = 0, droppedParents = 0, droppedTargets = 0;
  const nodes = carried.map(node => {
    const copy = cloneProjectData(node);
    copy.x = round(node.x - minX);
    copy.y = round(node.y - minY);
    if (root && node.id !== root.id && !copy.parentId) copy.parentId = root.id;
    // A parent outside the file would be an id nothing in the file defines, so the node travels
    // on its own instead of arriving under a group that does not exist.
    if (copy.parentId && !carriedIds.has(copy.parentId)) { delete copy.parentId; droppedParents += 1; }
    // A route lives in the project's own path list and a group in its own group list, so neither
    // can be carried by a file that has to stand on its own.
    if (copy.path) { delete copy.path; droppedRoutes += 1; }
    if (bakePathRamp(copy)) droppedRoutes += 1;
    if (copy.groupId) { delete copy.groupId; droppedGroups += 1; }
    // A follow or attack target outside the file would be an id nothing in the file defines, so
    // it is dropped the same way a captured scene drops one; a target the file does carry is
    // rewritten to the id it will have rather than left as a name that could collide.
    for (const field of ['targetId', 'cameraFollow']) {
      const value = copy[field];
      if (typeof value !== 'string' || value.startsWith('$')) continue;
      const target = carried.find(item => item.id === value || field === 'cameraFollow' && item.name === value);
      if (!target || !carriedIds.has(target.id)) { delete copy[field]; droppedTargets += 1; }
      else copy[field] = target.id;
    }
    return copy;
  });

  // Joints with both ends in the subtree, plus the ones that hang it from the world.
  const joints = (scene.joints || [])
    .filter(joint => jointWithin(joint, ids))
    .map(joint => {
      const copy = cloneProjectData(joint);
      if (copy.anchor) { copy.anchor.x = round(copy.anchor.x - minX); copy.anchor.y = round(copy.anchor.y - minY); }
      return copy;
    });

  const assetById = new Map((assets || []).map(asset => [asset.id, asset]));
  const clipById = new Map((clips || scene.spriteClips || []).map(clip => [clip.id, clip]));

  // The sprite clips the file has to bring along: the ones its nodes paint with and the ones
  // their rules play. A clip is only carried when every frame's picture travels too.
  const wantedClips = new Set();
  for (const node of subtree) {
    for (const id of Object.values(node.spriteStates || {})) if (typeof id === 'string' && id) wantedClips.add(id);
  }
  for (const event of includeEvents ? owners : []) {
    for (const command of eventCommands(event)) for (const key of CLIP_FIELDS) if (command[key]) wantedClips.add(command[key]);
  }
  const carriedClips = [], missingClips = [];
  for (const id of wantedClips) {
    const clip = clipById.get(id);
    if (!clip || !(clip.frames || []).every(frame => assetById.has(frame))) { missingClips.push(id); continue; }
    carriedClips.push(cloneProjectData(clip));
  }
  const carriedClipIds = new Set(carriedClips.map(clip => clip.id));
  // A state that names a clip the file could not carry would make the file reject itself on
  // import, so the state is dropped — the missing-clip warning below already says which clip
  // did not travel.
  for (const node of nodes) {
    if (!node.spriteStates) continue;
    for (const [state, id] of Object.entries(node.spriteStates)) {
      if (typeof id === 'string' && id && !carriedClipIds.has(id)) delete node.spriteStates[state];
    }
    if (!Object.keys(node.spriteStates).length) delete node.spriteStates;
  }

  const assetIds = new Set(), shaderIds = new Set();
  for (const node of subtree) {
    if (node.spriteAsset) assetIds.add(node.spriteAsset);
    if (node.modelAsset) assetIds.add(node.modelAsset);
    for (const component of [node.sound, node.projector]) if (component?.assetId) assetIds.add(component.assetId);
    if (node.shaderId) shaderIds.add(node.shaderId);
  }
  for (const clip of carriedClips) for (const frame of clip.frames) assetIds.add(frame);
  for (const event of includeEvents ? owners : []) {
    for (const command of eventCommands(event)) for (const key of ASSET_FIELDS) if (command[key]) assetIds.add(command[key]);
  }
  const embeddedAssets = cloneProjectData((assets || []).filter(asset => assetIds.has(asset.id)));
  const missingAssets = [...assetIds].filter(id => !assetById.has(id));
  const embeddedShaders = cloneProjectData((shaders || []).filter(shader => shaderIds.has(shader.id)));
  const missingShaders = [...shaderIds].filter(id => !embeddedShaders.some(shader => shader.id === id));

  const keptEvents = [], droppedEvents = [], droppedReasons = new Set();
  const keptEventIds = new Set();
  // Sub-events travel with their parent or not at all: a child alone would arrive with a parent
  // the destination does not have.
  for (const event of scene.events || []) {
    const parentKept = event.parentId === undefined || keptEventIds.has(event.parentId);
    const isOwned = selectedEvents.has(event);
    if (!includeEvents || !isOwned || !parentKept) {
      if (isOwned) {
        droppedEvents.push(event.name || event.id);
        droppedReasons.add(parentKept ? 'script not included' : 'its parent rule was left out');
      }
      continue;
    }
    const commands = eventCommands(event);
    const outside = commands.flatMap(commandReferences).filter(id => !ids.has(id));
    const offClips = commands.flatMap(command => CLIP_FIELDS.map(key => command[key]).filter(Boolean)).filter(id => !carriedClipIds.has(id));
    const offAssets = commands.flatMap(command => ASSET_FIELDS.map(key => command[key]).filter(Boolean)).filter(id => !assetById.has(id));
    const unportable = commands.flatMap(command => UNCARRYABLE_FIELDS.filter(key => command[key] !== undefined)
      .map(key => `${key} ${command[key]}`));
    const missingGroups = commands.flatMap(command => command.groupId === undefined ? [] : [command.groupId])
      .filter(id => !availableGroups.has(id));
    if (outside.length) { droppedEvents.push(event.name || event.id); droppedReasons.add('it uses an object outside this node'); }
    else if (offClips.length) { droppedEvents.push(event.name || event.id); droppedReasons.add('it plays a sprite clip the file cannot carry'); }
    else if (offAssets.length) { droppedEvents.push(event.name || event.id); droppedReasons.add('it uses a picture the file cannot carry'); }
    else if (missingGroups.length) { droppedEvents.push(event.name || event.id); droppedReasons.add('it uses an event group the file cannot carry'); }
    else if (unportable.length) { droppedEvents.push(event.name || event.id); droppedReasons.add('it names something only this project has'); }
    else { keptEvents.push(cloneProjectData(event)); keptEventIds.add(event.id); }
  }

  // A script that travelled keeps the sheets and groups it was written in, so it reads the same
  // way where it lands. Anything the caller did not describe falls back to the project's first
  // sheet rather than naming a sheet the destination has never heard of.
  const sheetIds = new Set(keptEvents.map(event => event.sheetId).filter(Boolean));
  const groupIds = new Set(keptEvents.map(event => event.groupId).filter(Boolean));
  for (const event of keptEvents) for (const command of eventCommands(event)) {
    if (command.groupId !== undefined && availableGroups.has(command.groupId)) groupIds.add(command.groupId);
  }
  const sourceGroups = (eventGroups ?? scene.eventGroups) || [];
  const embeddedGroups = cloneProjectData(sourceGroups.filter(group => groupIds.has(group.id)));
  for (const group of embeddedGroups) if (group.sheetId) sheetIds.add(group.sheetId);
  const embeddedSheets = cloneProjectData(((eventSheets ?? scene.eventSheets) || []).filter(sheet => sheetIds.has(sheet.id)));
  const embeddedGroupIds = new Set(embeddedGroups.map(group => group.id));
  const embeddedSheetIds = new Set(embeddedSheets.map(sheet => sheet.id));
  for (const event of keptEvents) {
    if (event.groupId !== undefined && !embeddedGroupIds.has(event.groupId)) delete event.groupId;
    if (event.sheetId !== undefined && !embeddedSheetIds.has(event.sheetId)) delete event.sheetId;
  }

  const warnings = [];
  if (missingAssets.length) warnings.push(`Missing artwork: ${missingAssets.join(', ')}`);
  if (missingClips.length) warnings.push(`Missing sprite clips: ${missingClips.join(', ')}`);
  if (missingShaders.length) warnings.push(`Missing shaders: ${missingShaders.join(', ')}`);
  if (droppedEvents.length) warnings.push(`${droppedEvents.length} event(s) left out (${[...droppedReasons].join('; ')})`);
  if (!includeEvents && owners.length) warnings.push(`Its visual script was not included (${owners.length} event(s))`);
  if (droppedParents) warnings.push(`Its parent group was not included — the node travels on its own`);
  if (droppedRoutes) warnings.push(`Its route was not included — a route belongs to the layout, not to the object`);
  if (droppedGroups) warnings.push(`Its layout group was not included`);
  if (droppedTargets) warnings.push(`Its target was not included — it names an object outside this node`);

  return {
    format: NODE_FILE_FORMAT,
    version: NODE_FILE_VERSION,
    // Which meaning of a declared facing the nodes' angles are written in (`migrateModelFacing`).
    modelFacingSemantics: MODEL_FACING_SEMANTICS,
    name: String(name || root?.name || subtree[0].name || 'Node').slice(0, 100),
    createdAt: new Date().toISOString(),
    // The group's floor corner, so an importer can place it without guesswork.
    origin: { x: round(minX), y: round(minY) },
    nodes,
    joints,
    events: keptEvents,
    // What the file carries of the object's script, so a reader can see the choice was made
    // rather than the script having been lost.
    script: { available: owners.length, included: keptEvents.length },
    clips: carriedClips,
    sheets: embeddedSheets,
    groups: embeddedGroups,
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
  // A file without a marker predates the facing change and is moved over on import; a marker this
  // build does not know means an angle could mean something else again, so it is refused the same
  // way a stored project is.
  if (document.modelFacingSemantics !== undefined && document.modelFacingSemantics !== MODEL_FACING_SEMANTICS)
    fail(`modelFacingSemantics ${document.modelFacingSemantics} is not supported (this build reads ${MODEL_FACING_SEMANTICS})`);
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.length > 100) fail('it needs a name');
  if (!Array.isArray(document.nodes) || !document.nodes.length) fail('it has no nodes');
  if (document.nodes.length > MAX_SCENE_ENTITIES) fail(`a node file holds at most ${MAX_SCENE_ENTITIES} nodes`);

  for (const key of ['assets', 'shaders', 'clips', 'sheets', 'groups']) {
    if (document[key] !== undefined && !Array.isArray(document[key])) fail(`it declares ${key} that are not a list`);
  }
  const assets = document.assets || [];
  const shaders = document.shaders || [];
  const clips = document.clips || [];
  const resourceIds = new Set();
  for (const [key, label] of [['assets', 'asset'], ['shaders', 'shader'], ['clips', 'sprite clip'],
    ['sheets', 'event sheet'], ['groups', 'event group']]) {
    for (const item of document[key] || []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`every ${label} must be an object`);
      if (typeof item.id !== 'string' || !item.id) fail(`every ${label} needs an id`);
      if (resourceIds.has(item.id)) fail(`duplicate ${label} id ${item.id}`);
      resourceIds.add(item.id);
    }
  }
  const assetIds = new Set(assets.map(asset => asset?.id));
  const shaderIds = new Set(shaders.map(shader => shader?.id));
  const clipIds = new Set(clips.map(clip => clip?.id));
  const assetRef = (id, label) => {
    if (id === undefined || id === null) return;
    if (typeof id !== 'string' || !assetIds.has(id)) fail(`${label} ${id} is not part of the file`);
  };
  const clipRef = id => {
    if (id === undefined || id === null) return;
    if (typeof id !== 'string' || !clipIds.has(id)) fail(`sprite clip ${id} is not part of the file`);
  };
  const modelRef = id => assetRef(id, 'Model');

  for (const clip of clips) {
    if (!clip || typeof clip !== 'object' || Array.isArray(clip)) fail('every sprite clip must be an object');
    if (typeof clip.id !== 'string' || !clip.id) fail('every sprite clip needs an id');
    if (!Array.isArray(clip.frames) || !clip.frames.length) fail(`sprite clip ${clip.id} has no frames`);
    for (const frame of clip.frames) assetRef(frame, 'Sprite frame');
  }
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
    const sheetIds = new Set((document.sheets || []).map(sheet => sheet.id));
    const groupIds = new Set((document.groups || []).map(group => group.id));
    for (const group of document.groups || []) {
      if (group.sheetId !== undefined && !sheetIds.has(group.sheetId)) {
        fail(`event group ${group.id} belongs to a sheet the file does not describe`);
      }
    }
    const eventIds = new Set();
    for (const event of document.events) {
      if (!event || typeof event !== 'object') fail('every event must be an object');
      if (typeof event.id !== 'string' || !event.id) fail('every event needs an id');
      if (eventIds.has(event.id)) fail(`duplicate event id ${event.id}`);
      eventIds.add(event.id);
      validateSignalEvent(event, document.nodes);
      if (event.ownerId !== undefined && !ids.has(event.ownerId)) fail(`event ${event.id} is owned by an object the file does not contain`);
      if (event.sheetId !== undefined && !sheetIds.has(event.sheetId)) fail(`event ${event.id} belongs to a sheet the file does not describe`);
      if (event.groupId !== undefined && !groupIds.has(event.groupId)) fail(`event ${event.id} belongs to a group the file does not describe`);
      for (const command of [event.condition, ...(event.conditions || []), ...(event.actions || [])]) {
        for (const key of CLIP_FIELDS) clipRef(command?.[key]);
        for (const key of ASSET_FIELDS) assetRef(command?.[key], 'Picture');
        if (command?.groupId !== undefined && !groupIds.has(command.groupId)) {
          fail(`event ${event.id} uses a group the file does not describe`);
        }
      }
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
  clipRemap = new Map(), sheetRemap = new Map(), groupRemap = new Map(),
  // A layout holds a whole map's worth of objects where a scene stops at 128, so the ceiling is
  // the destination's, not the file's.
  maxEntities = MAX_SCENE_ENTITIES, maxEvents = MAX_SCENE_EVENTS,
  // Every command type the destination understands (the engine's, plus the ones its addons
  // declare). A rule naming anything else is stripped instead of arriving as an invalid project —
  // the file cannot know whether the addon that wrote it will be there.
  knownTypes = null,
} = {}) {
  validateNodeFile(document);
  if (!scene) throw new Error('There is no scene to import into');
  if ((scene.entities || []).length + document.nodes.length > maxEntities) {
    throw new Error(`The destination holds at most ${maxEntities} objects`);
  }
  if (parentId && !scene.entities.some(node => node.id === parentId)) throw new Error('Unknown parent object');
  if ((scene.joints || []).length + (document.joints || []).length > MAX_JOINTS) {
    throw new Error(`A scene holds at most ${MAX_JOINTS} joints`);
  }
  const radians = (Number(degrees) || 0) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const mapping = new Map();
  const reserved = new Set();
  for (const node of document.nodes) mapping.set(node.id, sceneEntityId(scene, node.id, reserved));
  const roots = document.nodes.filter(node => !node.parentId);
  // A file written before a facing stopped turning the mesh stored the pose the old renderer drew,
  // so its angle has to move over — otherwise the object lands visibly turned by its own facing.
  const staleFacing = document.modelFacingSemantics === undefined;
  const copies = document.nodes.map(node => {
    const copy = remapReferences(cloneProjectData(node), mapping);
    copy.id = mapping.get(node.id);
    // Relative coordinates are turned by `degrees`, so a rotated import still lines up.
    const local = { x: node.x, y: node.y };
    copy.x = round(x + local.x * cos - local.y * sin);
    copy.y = round(y + local.x * sin + local.y * cos);
    copy.angle = (Number(node.angle) || 0) + (Number(degrees) || 0);
    if (staleFacing && hasModelFacing(copy)) copy.angle = (((copy.angle - Number(copy.modelFacing)) % 360) + 360) % 360;
    if (node.parentId) copy.parentId = mapping.get(node.parentId);
    else if (parentId) copy.parentId = parentId;
    // An asset that clashed with different artwork in the destination got a new id.
    if (copy.spriteAsset && assetRemap.has(copy.spriteAsset)) copy.spriteAsset = assetRemap.get(copy.spriteAsset);
    if (copy.modelAsset && assetRemap.has(copy.modelAsset)) copy.modelAsset = assetRemap.get(copy.modelAsset);
    for (const component of [copy.sound, copy.projector]) {
      if (component?.assetId && assetRemap.has(component.assetId)) component.assetId = assetRemap.get(component.assetId);
    }
    if (copy.spriteStates) {
      for (const [state, id] of Object.entries(copy.spriteStates)) {
        if (clipRemap.has(id)) copy.spriteStates[state] = clipRemap.get(id);
        else if (assetRemap.has(id)) copy.spriteStates[state] = assetRemap.get(id);
      }
    }
    if (copy.shaderId && shaderRemap.has(copy.shaderId)) copy.shaderId = shaderRemap.get(copy.shaderId);
    return copy;
  });
  const joints = (document.joints || []).map(joint => {
    const copy = cloneProjectData(joint);
    copy.id = newJointId();
    if (copy.a) copy.a = mapping.get(copy.a);
    if (copy.b) copy.b = mapping.get(copy.b);
    return transformJoint(copy, { x, y, angle: Number(degrees) || 0 });
  });

  const events = [];
  const stripped = { commands: 0, rules: 0, types: new Set() };
  const known = knownTypes ? (knownTypes instanceof Set ? knownTypes : new Set(knownTypes)) : null;
  const keptIds = new Map();
  // Sub-events travel with their parent or not at all: a child alone would arrive with a parent the
  // destination does not have.
  for (const event of document.events || []) {
    const parentKept = event.parentId === undefined || keptIds.has(event.parentId);
    if (!parentKept) { stripped.rules += 1; continue; }
    const copy = remapReferences(cloneProjectData(event), mapping);
    copy.id = freshId(event.id);
    if (event.parentId !== undefined) copy.parentId = keptIds.get(event.parentId);
    if (event.ownerId) copy.ownerId = mapping.get(event.ownerId);
    // The script keeps its sheet and its group; an id the destination could not offer is dropped
    // rather than left dangling.
    if (copy.sheetId !== undefined) copy.sheetId = sheetRemap.get(copy.sheetId) ?? copy.sheetId;
    if (copy.groupId !== undefined && groupRemap.has(copy.groupId)) {
      const mapped = groupRemap.get(copy.groupId);
      if (mapped === null) delete copy.groupId;
      else copy.groupId = mapped;
    }
    for (const command of [copy.condition, ...(copy.conditions || []), ...(copy.actions || [])]) {
      if (!command) continue;
      for (const key of CLIP_FIELDS) if (command[key] && clipRemap.has(command[key])) command[key] = clipRemap.get(command[key]);
      for (const key of ASSET_FIELDS) if (command[key] && assetRemap.has(command[key])) command[key] = assetRemap.get(command[key]);
      if (command.groupId !== undefined && groupRemap.has(command.groupId)) {
        const mapped = groupRemap.get(command.groupId);
        if (mapped === null) delete command.groupId;
        else command.groupId = mapped;
      }
    }
    if (known) {
      const keep = command => {
        if (!command || known.has(command.type)) return true;
        stripped.commands += 1;
        stripped.types.add(command.type);
        return false;
      };
      const conditions = [copy.condition, ...(copy.conditions || [])].filter(Boolean);
      const hadActions = (copy.actions || []).length;
      copy.actions = (copy.actions || []).filter(keep);
      const keptConditions = conditions.filter(keep);
      copy.condition = keptConditions[0] || null;
      copy.conditions = keptConditions.slice(1);
      const hasChildren = (document.events || []).some(child => child.parentId === event.id);
      // Losing a gate must never turn a constrained rule into an unconditional one.
      if (keptConditions.length !== conditions.length || !keptConditions.length
        || hadActions && !copy.actions.length && !hasChildren) { stripped.rules += 1; continue; }
    }
    keptIds.set(event.id, copy.id);
    events.push(copy);
  }
  if ((scene.events || []).length + events.length > maxEvents) throw new Error(`The destination holds at most ${maxEvents} events`);
  scene.entities.push(...copies);
  // Keep the destination arrays live: layout containers share these with the project.
  if (joints.length) { scene.joints ||= []; scene.joints.push(...joints); }
  if (events.length) { scene.events ||= []; scene.events.push(...events); }

  const root = roots.length ? mapping.get(roots[0].id) : copies[0]?.id;
  if (scene.layoutProject) createSceneInstanceGroup(scene.layoutProject, copies.map(copy => copy.id), { name: document.name, rootId: root });
  return { ids: copies.map(copy => copy.id), root,
    assets: document.assets || [], shaders: document.shaders || [], clips: document.clips || [],
    sheets: document.sheets || [], groups: document.groups || [],
    stripped: { ...stripped, types: [...stripped.types] } };
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
export function planNodeFileInstall(document, { assets = [], shaders = [], spriteClips = [], eventSheets = [], eventGroups = [] } = {}) {
  validateNodeFile(document);
  const assetRemap = new Map(), shaderRemap = new Map(), clipRemap = new Map();
  const addAssets = [], addShaders = [], addClips = [];
  const byAssetId = new Map(assets.map(asset => [asset.id, asset]));
  for (const incoming of document.assets || []) {
    const existing = byAssetId.get(incoming.id);
    if (!existing) { addAssets.push(incoming); continue; }
    const same = sameResource(existing, incoming);
    if (same) continue;
    const id = freshId(incoming.id);
    assetRemap.set(incoming.id, id);
    addAssets.push({ ...incoming, id });
  }
  const byShaderId = new Map(shaders.map(shader => [shader.id, shader]));
  for (const incoming of document.shaders || []) {
    const existing = byShaderId.get(incoming.id);
    if (!existing) { addShaders.push(incoming); continue; }
    if (sameResource(existing, incoming)) continue;
    const id = freshId(incoming.id);
    shaderRemap.set(incoming.id, id);
    addShaders.push({ ...incoming, id });
  }
  // A sprite clip is the frames it plays, so its pictures are remapped first and it is compared
  // against the destination with those new ids.
  const byClipId = new Map(spriteClips.map(clip => [clip.id, clip]));
  for (const incoming of document.clips || []) {
    const clip = { ...incoming, frames: incoming.frames.map(frame => assetRemap.get(frame) ?? frame) };
    const existing = byClipId.get(clip.id);
    if (!existing) { addClips.push(clip); continue; }
    const same = sameResource(existing, clip);
    if (same) continue;
    const id = freshId(clip.id);
    clipRemap.set(clip.id, id);
    addClips.push({ ...clip, id });
  }

  // A sheet is only metadata — a name, a section and a phase — so a file that was written in a
  // sheet this project already has rejoins it; otherwise the sheet comes along, under a fresh id
  // when the id is taken by something else.
  const sheetRemap = new Map(), groupRemap = new Map();
  const addSheets = [], addGroups = [];
  const bySheetId = new Map(eventSheets.map(sheet => [sheet.id, sheet]));
  const sheetIdByName = new Map(eventSheets.map(sheet => [sheet.name, sheet.id]));
  for (const incoming of document.sheets || []) {
    const same = bySheetId.get(incoming.id);
    if (same && sameResource(same, incoming)) continue;
    const byName = sheetIdByName.get(incoming.name);
    const namedSheet = eventSheets.find(sheet => sheet.id === byName);
    if (namedSheet && sameResource(namedSheet, incoming)) { sheetRemap.set(incoming.id, byName); continue; }
    const id = same ? freshId(incoming.id) : incoming.id;
    if (id !== incoming.id) sheetRemap.set(incoming.id, id);
    addSheets.push({ ...cloneProjectData(incoming), id });
    sheetIdByName.set(incoming.name, id);
  }
  const byGroupId = new Map(eventGroups.map(group => [group.id, group]));
  for (const incoming of document.groups || []) {
    // A group belongs to a sheet, so it follows that sheet's new id; a group whose sheet the
    // destination will not have is dropped and its rules join the sheet directly.
    let sheetId = incoming.sheetId;
    if (sheetId !== undefined) sheetId = sheetRemap.get(sheetId) ?? sheetId;
    const known = sheetId === undefined || bySheetId.has(sheetId) || addSheets.some(sheet => sheet.id === sheetId);
    if (!known) { groupRemap.set(incoming.id, null); continue; }
    const same = byGroupId.get(incoming.id);
    const normalized = { ...cloneProjectData(incoming), sheetId };
    if (same && sameResource(same, normalized)) continue;
    const byName = eventGroups.find(group => group.name === incoming.name && group.sheetId === sheetId
      && sameResource(group, normalized));
    if (byName) { groupRemap.set(incoming.id, byName.id); continue; }
    const id = same ? freshId(incoming.id) : incoming.id;
    if (id !== incoming.id) groupRemap.set(incoming.id, id);
    addGroups.push({ ...cloneProjectData(incoming), id, sheetId });
  }
  return { assetRemap, shaderRemap, clipRemap, sheetRemap, groupRemap, addAssets, addShaders, addClips, addSheets, addGroups };
}

/** The file name a saved node should get: the node's name, made safe for a filesystem. */
export function nodeFileName(name) {
  const base = String(name || 'node').trim().replace(/[^a-zA-Z0-9 _-]+/g, '').replace(/[ _]+/g, '-').replace(/^-+|-+$/g, '');
  return `${(base || 'node').slice(0, 60)}${NODE_FILE_EXTENSION}`;
}
