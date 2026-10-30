import { sectorGeometry } from './sectors.js';
import { LIMITS } from './limits.js';
import { decodeDataURI, readModel, validateModelDocument } from './gltf.js';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS, INPUT_KEYS, engineCommand } from './engine-script.js';
import { validateEventStructure } from './events.js';
import { validateHUD, validateHUDProperty, MAX_HUD_ELEMENTS } from './hud.js';
import { WEAPONS } from './player-state.js';
import { isExpression, validateExpression, validateVariables, scalar, expressionContext } from './expressions.js';
import { validateShaders } from './shaders.js';
import { AREA_SHAPES } from './areas.js';
import { MAX_SCENES, MAX_SCENE_ENTITIES, MAX_SCENE_EVENTS } from './scenes.js';
import { MAX_JOINTS, validateJoint } from './joints.js';
import { validatePanel } from './panel.js';
import { GAME_SETTINGS, validateSetting } from './game-settings.js';

export const VERSION = 1;
export const CONDITIONS = ['onStart', 'always', 'keyPressed', 'nearEntity', 'collisionStarted', 'collisionEnded', 'isTouching', 'playerGrounded', 'animationFinished', ...ENGINE_CONDITIONS.map(command => command.type)];
export const ACTIONS = ['showMessage', 'setVariable', 'addVariable', 'teleport', 'removeEntity', 'setEntityPosition', 'rotateEntity', 'applyImpulse', 'applyForce', 'setVelocity', 'playAnimation', 'stopAnimation', ...ENGINE_ACTIONS.map(command => command.type)];
export const ENTITY_TYPES = ['player', 'enemy', 'pickup', 'light', 'decoration', 'ramp'];
const colorPattern = /^#[0-9a-f]{6}$/i;
// Surface texture scaling: one texture tile covers `scale` times its pixel size in map
// units, so 2 draws the artwork twice as large and 0.5 twice as fine.
export const MIN_TEXTURE_SCALE = .05;
export const MAX_TEXTURE_SCALE = 16;
/**
 * GZDoom scales a texture by a factor, and a **negative** factor mirrors it. Real maps use that
 * (Lullaby's MAP01 has `scalex_mid = -1.0` on 72 sides), so the range is checked on the magnitude
 * and the sign is kept. Zero means "not set" in some editors and reads as 1 downstream.
 */
export function textureScaleInRange(value) {
  if (!Number.isFinite(value)) return false;
  const magnitude = Math.abs(value);
  return magnitude === 0 || (magnitude >= MIN_TEXTURE_SCALE && magnitude <= MAX_TEXTURE_SCALE);
}
export function assertTextureScale(value, label) {
  assert(textureScaleInRange(value), `${label} must be between ${MIN_TEXTURE_SCALE} and ${MAX_TEXTURE_SCALE}; a negative value mirrors the texture`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}
function object(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
function text(value, label, max = 200) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, `${label} must be 1-${max} characters`);
}
function number(value, label, min = -65536, max = 65536) {
  assert(Number.isFinite(value) && value >= min && value <= max, `${label} must be between ${min} and ${max}`);
}
function array(value, label, max) {
  assert(Array.isArray(value) && value.length <= max, `${label} must be an array with at most ${max} items`);
}
function identifier(value, label) {
  text(value, label, 80);
  assert(/^[a-zA-Z0-9_-]+$/.test(value), `${label} contains invalid characters`);
}

export function eventConditions(event) {
  return [event.condition, ...(event.conditions || [])];
}

export function resolveEntityId(event, id) {
  return id === '$self' ? event.ownerId : id;
}

// Interactive edits re-validate the same thousands of embedded payloads (PNG
// data URIs, sounds, models) on every change. In `fast` mode each asset object
// is only screened once and then remembered by identity; structural checks and
// cumulative budgets still run every time. Asset objects are treated as
// immutable while editing, so a replaced payload is a new object and gets
// screened again, and save/import/export/MCP always validate fully.
const verifiedAssets = new WeakMap();
/** Actor tables already validated in fast mode, by identity. */
const verifiedActorTables = new WeakSet();
/**
 * Whether a payload is a base64 data URI of the expected media type.
 *
 * The old check ran a `[A-Za-z0-9+/]+` regex over the **whole** data URI, so validating
 * a project with two thousand embedded images and sounds scanned tens of megabytes on
 * every edit. A prefix test plus a cheap base64 character check on the tail of the
 * string is equivalent for anything a browser can decode, and costs nothing.
 */
function isDataUri(src, types) {
  if (typeof src !== 'string') return false;
  const comma = src.indexOf(',');
  if (comma < 0) return false;
  const header = src.slice(0, comma);
  if (!header.endsWith(';base64')) return false;
  if (!types.some(type => header === `data:${type};base64`)) return false;
  const body = src.length - comma - 1;
  if (!body) return false;
  // Sampling the last characters catches truncation and padding mistakes without
  // walking the payload; the browser decodes the actual base64 either way.
  const tail = src.slice(-4);
  return /^[A-Za-z0-9+/]*={0,2}$/.test(tail) || tail.length < 4;
}

function assetPayload(asset, cacheable) {
  const cached = cacheable ? verifiedAssets.get(asset) : undefined;
  if (cached) return cached;
  const result = measureAssetPayload(asset);
  if (cacheable) verifiedAssets.set(asset, result);
  return result;
}
function measureAssetPayload(asset) {
  if (asset.kind === 'music') {
    assert(['midi', 'mus'].includes(asset.format), 'Invalid music format');
    assert(isDataUri(asset.src, ['audio/midi', 'audio/x-midi', 'audio/x-mus']), 'Music must be embedded MIDI or Doom MUS');
    assert(asset.src.length <= 2 * 1024 * 1024, 'Embedded music budget exceeded (2 MiB per track, 32 MiB total)');
    return { bucket: 'music', bytes: asset.src.length };
  }
  if (asset.kind === 'sound') {
    assert(isDataUri(asset.src, ['audio/wav', 'audio/ogg', 'audio/mpeg']), 'Sounds must be embedded WAV/OGG/MP3');
    assert(asset.src.length <= 12 * 1024 * 1024, 'Embedded sound budget exceeded (12 MiB each, 64 MiB total)');
    return { bucket: 'sound', bytes: asset.src.length };
  }
  if (asset.kind === 'font') {
    assert(isDataUri(asset.src, ['font/woff', 'font/woff2', 'font/ttf', 'font/otf']), 'Fonts must be embedded WOFF/WOFF2/TTF/OTF');
    assert(asset.src.length <= 6 * 1024 * 1024, 'Embedded font budget exceeded');
    return { bucket: 'image', bytes: asset.src.length };
  }
  if (asset.kind === 'model') {
    assert(['glb', 'gltf'].includes(asset.format), 'Invalid model format');
    assert(isDataUri(asset.src, ['model/gltf-binary', 'model/gltf+json']), 'Models must be embedded GLB/glTF');
    assert(asset.src.length <= 23 * 1024 * 1024, 'Embedded model budget exceeded');
    const parsed = readModel(decodeDataURI(asset.src), asset.format);
    validateModelDocument(parsed.json, parsed.binary?.length);
    array(asset.animations, 'Animation clip names', 256);
    assert(asset.animations.every(name => typeof name === 'string' && name.length <= 200), 'Invalid clip name');
    assert(JSON.stringify(asset.animations) === JSON.stringify((parsed.json.animations || []).map(clip => clip.name)), 'Model clip metadata does not match its source');
    if (asset.preview !== undefined) {
      assert(isDataUri(asset.preview, ['image/png']), 'Model preview must be an embedded PNG');
      assert(asset.preview.length <= 96 * 1024, 'Model preview is too large');
    }
    return { bucket: 'image', bytes: asset.src.length };
  }
  assert(isDataUri(asset.src, ['image/png']), 'Assets must be embedded PNG images');
  assert(asset.src.length <= LIMITS.imageBytes, `Embedded image budget exceeded (${LIMITS.imageBytes / 1024 / 1024} MiB per image, ${LIMITS.imageTotalBytes / 1024 / 1024} MiB total)`);
  return { bucket: 'image', bytes: asset.src.length };
}
/**
 * Copies a project for an in-place edit. A large imported campaign carries a
 * `game` block of compiled level data (~44 MB for a 32-level game) plus tens of
 * megabytes of embedded artwork, and copying both on every edit took seconds.
 * Level data and asset objects are never mutated in place, so they are shared
 * between snapshots; `deepGame` is for the edits that do rewrite campaign data
 * (switching levels, campaign routing).
 */
/**
 * Deep copy of plain project data (objects, arrays, strings, numbers, buffers, null).
 *
 * `structuredClone` is the obvious choice but it is several times slower than a plain
 * recursive copy for this shape of data — an imported campaign copies 5 MB on every
 * edit, which was a 200-800 ms pause per click. Anything that is not plain data (a
 * Map, a typed array, a class instance) is handed to `structuredClone` so semantics are
 * never lost.
 */
export function cloneProjectData(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let index = 0; index < value.length; index++) out[index] = cloneProjectData(value[index]);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out = {};
  for (const key in value) out[key] = cloneProjectData(value[key]);
  return out;
}

/**
 * Copy of a project for an in-place edit.
 *
 * `game` and `assets` are already shared (a campaign's other levels and the embedded
 * media are not edited from the map). `shareActors` does the same for the actor table,
 * which is the largest part of an imported project — the actor panel asks for a real
 * copy, everything else reads it.
 */
export function cloneProjectForEdit(project, { deepGame = false, shareActors = false } = {}) {
  const next = project.game
    ? cloneProjectData({ ...project, actors: undefined, game: null, assets: [] })
    : cloneProjectData({ ...project, actors: undefined });
  // The actor table is copied only when the edit can change it: it is the largest part
  // of an imported project, and copying it to throw the copy away was most of the
  // pause between a click and the screen updating.
  if (project.actors !== undefined) next.actors = shareActors ? project.actors : cloneProjectData(project.actors);
  else delete next.actors;
  if (project.game) {
    next.game = deepGame ? cloneProjectData(project.game) : project.game;
    next.assets = [...(project.assets || [])];
  }
  return next;
}

/**
 * `fast` skips re-validating dormant campaign levels and the multi-megabyte
 * game size check. Interactive edits only touch the active level, so a full
 * re-validation of 32 imported maps would add seconds to every drag; the full
 * check still runs on save, import, export and MCP changes.
 */
/** Shared object rules, used by map objects and by the objects inside a scene. */
export function validateEntity(entity, { assetRef, clipRef, modelRef, assets = [] }) {
  assert(ENTITY_TYPES.includes(entity.type), 'Unknown entity type');
  // A ramp carries the four numbers a mapper edits and derives everything else from them, so a
  // ramp with no parameters (an old project, or a decoration switched to a ramp) is given the
  // defaults rather than loaded as a solid block with no slope.
  if (entity.type === 'ramp') {
    const ramp = entity.ramp;
    if (ramp !== undefined) {
      assert(ramp && typeof ramp === 'object', 'Ramp parameters must be an object');
      for (const key of ['slope', 'length', 'width']) assert(Number.isFinite(ramp[key]), `Ramp ${key} must be a number`);
      assert(ramp.slope > 0 && ramp.slope < 90, 'Ramp slope must be between 0 and 90 degrees');
      assert(ramp.length > 0 && ramp.width > 0, 'Ramp length and width must be positive');
      assert(ramp.facing === 'left' || ramp.facing === 'right', 'Ramp facing must be left or right');
    }
  }
  number(entity.x, 'Entity X');
  number(entity.y, 'Entity Y');
  number(entity.angle, 'Entity angle', -3600, 3600);
  // Model tilt is a visual roll/pitch on top of the yaw: enough to lay a model on its
  // side or stand it on its head without changing where the object faces.
  if (entity.modelTilt !== undefined) {
    assert(typeof entity.modelTilt === 'object' && entity.modelTilt !== null, 'Model tilt must be an object');
    for (const key of ['pitch', 'roll']) {
      if (entity.modelTilt[key] === undefined) continue;
      number(entity.modelTilt[key], `Model tilt ${key}`, -3600, 3600);
    }
  }
  if (entity.health !== undefined) number(entity.health, 'Object health', 0, 1000000);
  if (entity.ambush !== undefined) assert(typeof entity.ambush === 'boolean', 'Object ambush must be boolean');
  if (entity.skillMask !== undefined) {
    number(entity.skillMask, 'Object skill mask', 1, 7);
    assert(Number.isInteger(entity.skillMask), 'Object skill mask must be an integer');
  }
  if (entity.tid !== undefined) {
    number(entity.tid, 'Object TID', 0, 65535);
    assert(Number.isInteger(entity.tid), 'Object TID must be an integer');
  }
  if (entity.doomType !== undefined) {
    number(entity.doomType, 'Doom thing type', 0, 65535);
    assert(Number.isInteger(entity.doomType), 'Doom thing type must be an integer');
  }
  text(entity.name, 'Entity name', 100);
  if (entity.variables !== undefined) validateVariables(entity.variables);
  assetRef(entity.spriteAsset, 'Sprite');
  if (entity.spriteStates !== undefined) {
    object(entity.spriteStates, 'Sprite state mappings');
    for (const [name, id] of Object.entries(entity.spriteStates)) {
      assert(['stand', 'walk', 'attack', 'pain', 'death'].includes(name), 'Unknown sprite state'); clipRef(id);
    }
  }
  if (entity.spriteScale !== undefined) number(entity.spriteScale, 'Sprite scale', .05, 16);
  if (entity.spriteScaleX !== undefined) number(entity.spriteScaleX, 'Sprite scale X', .05, 16);
  if (entity.spriteScaleY !== undefined) number(entity.spriteScaleY, 'Sprite scale Y', .05, 16);
  if (entity.elevation !== undefined) number(entity.elevation, 'Elevation', -32768, 32767);
  modelRef(entity.modelAsset);
  assert(entity.type !== 'player' || !entity.modelAsset, 'Assign world models to non-player objects');
  if (entity.modelScale !== undefined) number(entity.modelScale, 'Model scale', .001, 4096);
  if (entity.animation !== undefined) {
    object(entity.animation, 'Animation');
    const model = assets.find(asset => asset.id === entity.modelAsset);
    assert(model?.animations.includes(entity.animation.clip), 'Animation references an unknown clip');
    number(entity.animation.speed, 'Animation speed', .01, 10);
    assert(typeof entity.animation.loop === 'boolean' && typeof entity.animation.autoPlay === 'boolean', 'Animation flags must be boolean');
  }
  if (entity.physics !== undefined) {
    const config = entity.physics;
    object(config, 'Physics');
    assert(entity.type !== 'player', 'Player uses the built-in Rapier capsule controller');
    assert(['none', 'fixed', 'dynamic', 'kinematic'].includes(config.body), 'Invalid rigid-body type');
    if (config.body !== 'none') {
      assert(['box', 'ball', 'capsule', 'cylinder', 'cone', 'wedge', 'model'].includes(config.shape), 'Invalid collider shape');
      // A shape collided from a model's own faces needs the model to exist and be one.
      if (config.shape === 'model') {
        assert(entity.modelAsset, 'A model collider needs the object to have a model');
        assert(assets.find(asset => asset.id === entity.modelAsset)?.kind === 'model', 'A model collider needs a model asset');
      }
      // A wedge's own numbers: how steep its face is and which edge is the ridge.
      if (config.shape === 'wedge') {
        object(config.wedge, 'Wedge');
        assert(Number.isFinite(config.wedge?.slope) && config.wedge.slope > 0 && config.wedge.slope < 90,
          'Wedge slope must be between 0 and 90 degrees');
        assert(['left', 'right'].includes(config.wedge?.facing), 'Wedge facing must be left or right');
      }
      for (const key of ['width', 'height', 'depth', 'radius']) number(config[key], `Collider ${key}`, .1, 4096);
      if (config.shape === 'capsule') assert(config.height >= config.radius * 2, 'Capsule height must be at least twice its radius');
      if (config.shape === 'ball') assert(config.height === config.radius * 2, 'Ball height must be twice its radius');
      number(config.mass, 'Body mass (kg)', .01, 100000);
      number(config.friction, 'Friction', 0, 10); number(config.restitution, 'Restitution', 0, 1);
      assert(typeof config.sensor === 'boolean' && typeof config.lockRotation === 'boolean', 'Physics flags must be boolean');
    }
  }
  if (entity.panel !== undefined) {
    validatePanel(entity.panel);
    assert(entity.type !== 'player', 'The player uses the built-in capsule, not a panel');
  }
  if (entity.light !== undefined) {
    object(entity.light, 'Object light');
    assert(colorPattern.test(entity.light.color), 'Light color must be #rrggbb');
    number(entity.light.intensity, 'Light intensity', 0, 10);
    number(entity.light.radius, 'Light radius', 1, 8192);
  }
  if (entity.area !== undefined) {
    object(entity.area, 'Interaction area');
    assert(AREA_SHAPES.includes(entity.area.shape), 'Invalid interaction area shape');
    for (const key of ['width', 'height', 'depth', 'radius']) number(entity.area[key], `Interaction area ${key}`, 1, 65536);
  }
}


/**
 * Joints hold two objects together, so they are checked against the objects that exist:
 * a joint to a deleted object is a broken project, not a harmless leftover.
 */
/**
 * An object may run a shader of its own instead of the level-wide one, so the reference
 * has to exist; the shader validation in shared/shaders.js checks the rest.
 */
function validateEntityShaders(project) {
  const known = new Set((project.shaders || []).map(shader => shader.id));
  const check = (entity, label) => {
    if (entity?.shaderId === undefined || entity.shaderId === null) return;
    assert(typeof entity.shaderId === 'string' && known.has(entity.shaderId),
      `${label} references the unknown shader ${entity.shaderId}`);
  };
  for (const entity of project.map?.entities || []) check(entity, `Object ${entity.id}`);
  for (const scene of project.scenes || []) for (const entity of scene.entities || []) check(entity, `Scene object ${entity.id}`);
}

function validateLevelJoints(map, entityIds) {
  if (map.joints === undefined) return;
  array(map.joints, 'Joints', MAX_JOINTS);
  const ids = new Set();
  for (const joint of map.joints) {
    assert(!ids.has(joint?.id), `Duplicate joint id: ${joint?.id}`);
    ids.add(joint?.id);
    validateJoint(joint, { ids: entityIds, label: `Joint ${joint?.id}` });
    const bodies = [joint.a, joint.b].filter(Boolean)
      .map(id => map.entities.find(entity => entity.id === id));
    assert(bodies.every(entity => entity && entity.physics && entity.physics.body !== 'none'),
      `Joint ${joint.id} needs objects with an enabled rigid body`);
  }
}

export function validateProject(project, { gameLevelIds, fast = false } = {}) {
  object(project, 'Project');
  assert(project.version === VERSION, `Unsupported project version; expected ${VERSION}`);
  text(project.title, 'Title', 100);
  object(project.map, 'Map');
  if (project.importSource !== undefined) {
    const source = project.importSource;
    object(source, 'Import provenance');
    assert(['udmf', 'hexen'].includes(source.format), 'Unknown import provenance format');
    text(source.mapName, 'Source map name', 80);
    // A binary Hexen-format map has no UDMF namespace or property blocks: the map data
    // itself is native, so only the format and the source name are recorded.
    if (source.format === 'hexen') {
      assert(Object.keys(source).every(key => ['format', 'mapName'].includes(key)), 'Unknown Hexen provenance field');
    } else {
      text(source.namespace, 'UDMF namespace', 80);
      const properties = record => {
        object(record, 'UDMF source properties');
        assert(Object.keys(record).length <= 256, 'UDMF source property limit exceeded');
        for (const [key, value] of Object.entries(record)) {
          assert(/^[a-z_][a-z0-9_]*$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid UDMF source key');
          assert(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && value.length <= 65536, 'UDMF source values must be bounded scalars');
        }
      };
      properties(source.globals); array(source.blocks, 'UDMF source blocks', LIMITS.udmfBlocks);
      for (const block of source.blocks) {
        object(block, 'UDMF source block'); text(block.type, 'UDMF source block type', 80); properties(block.properties);
      }
      assert(JSON.stringify(source).length <= LIMITS.udmfProvenanceBytes,
        `UDMF import provenance exceeds ${LIMITS.udmfProvenanceBytes / 1024 / 1024} MiB`);
    }
  }
  if (project.soundAliases !== undefined) {
    const table = project.soundAliases;
    object(table, 'Sound aliases');
    object(table.aliases || {}, 'Sound alias map');
    assert(Object.keys(table.aliases || {}).length <= LIMITS.soundAliases, 'Sound alias limit exceeded');
    for (const [name, lump] of Object.entries(table.aliases || {})) {
      assert(/^[a-z0-9_/*#-]{1,80}$/.test(name), 'Sound alias names must be plain identifiers');
      // The target is usually a lump name but may be another logical name (a
      // `$playersounddup` chain) or an engine sound like `*usefail`.
      assert(typeof lump === 'string' && /^\*?[A-Za-z0-9_/*#-]{1,64}$/.test(lump), 'Sound aliases must point at a lump name');
    }
    object(table.random || {}, 'Sound alias groups');
    assert(Object.keys(table.random || {}).length <= 2000, 'Sound alias group limit exceeded');
    for (const [name, members] of Object.entries(table.random || {})) {
      assert(/^[a-z0-9_/*#-]{1,80}$/.test(name), 'Sound group names must be plain identifiers');
      array(members, 'Sound alias group', 32);
      assert(members.every(member => typeof member === 'string' && /^[a-z0-9_/*#-]{1,80}$/.test(member)),
        'Sound groups must list plain names');
    }
  }
  if (project.mapScripts !== undefined) {
    const scripts = project.mapScripts;
    object(scripts, 'Map scripts');
    assert(['old', 'enhanced', 'little'].includes(scripts.format), 'Unknown ACS module format');
    if (scripts.data !== undefined) {
      text(scripts.data, 'ACS module data', 8 * 1024 * 1024);
      assert(/^[A-Za-z0-9+/=]+$/.test(scripts.data), 'ACS module data must be base64');
    }
    if (scripts.libraries !== undefined) {
      array(scripts.libraries, 'ACS libraries', 32);
      for (const library of scripts.libraries) {
        object(library, 'ACS library');
        text(library.name, 'ACS library name', 64);
        assert(/^[^/\\]+$/.test(library.name), 'ACS library name must be a plain name');
        text(library.data, 'ACS library data', LIMITS.scriptBytes);
        assert(/^[A-Za-z0-9+/=]+$/.test(library.data), 'ACS library data must be base64');
      }
    }
    assert(scripts.data !== undefined || scripts.libraries?.length, 'Map scripts need a module or a library');
  }
  const { vertices, walls, entities } = project.map;
  array(vertices, 'Vertices', LIMITS.vertices);
  array(walls, 'Walls', LIMITS.walls);
  array(entities, 'Entities', LIMITS.entities);
  assert(vertices.length >= 3 && walls.length >= 3, 'A map needs at least three vertices and walls');
  const ids = new Set();
  const unique = (item, label) => {
    object(item, label);
    identifier(item.id, `${label} ID`);
    assert(!ids.has(item.id), `Duplicate ID: ${item.id}`);
    ids.add(item.id);
  };
  for (const vertex of vertices) {
    unique(vertex, 'Vertex');
    number(vertex.x, 'Vertex X');
    number(vertex.y, 'Vertex Y');
  }
  const vertexMap = new Map(vertices.map(vertex => [vertex.id, vertex]));
  const assets = project.assets || [];
  array(assets, 'Assets', LIMITS.assets);
  const assetIds = new Set();
  let assetBytes = 0, soundBytes = 0, musicBytes = 0;
  // Sound and music names must be unique. Counting them in one pass replaces a
  // `filter` over every asset for every asset, which is quadratic on an imported game
  // (hundreds of sounds x thousands of assets on every validation).
  const nameCounts = new Map();
  for (const asset of assets) {
    if (asset.kind !== 'sound' && asset.kind !== 'music') continue;
    const key = `${asset.kind}\u0000${asset.name}`;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  for (const asset of assets) {
    unique(asset, 'Asset');
    text(asset.name, 'Asset name', 100);
    assert(['texture', 'flat', 'sky', 'sprite', 'weapon', 'model', 'font', 'sound', 'music'].includes(asset.kind), 'Invalid asset kind');
    const payload = assetPayload(asset, fast);
    if (payload.bucket === 'music') {
      musicBytes += payload.bytes;
      assert(musicBytes <= 32 * 1024 * 1024, 'Embedded music budget exceeded (2 MiB per track, 32 MiB total)');
      assert(nameCounts.get(`music\u0000${asset.name}`) === 1, 'Music names must be unique');
      assetIds.add(asset.id); continue;
    }
    if (payload.bucket === 'sound') {
      soundBytes += payload.bytes;
      assert(soundBytes <= 64 * 1024 * 1024, 'Embedded sound budget exceeded (12 MiB each, 64 MiB total)');
      assert(nameCounts.get(`sound\u0000${asset.name}`) === 1, 'Sound names must be unique');
      assetIds.add(asset.id); continue;
    }
    assetBytes += payload.bytes;
    assert(assetBytes <= LIMITS.imageTotalBytes, asset.kind === 'model' ? 'Embedded model budget exceeded' : asset.kind === 'font'
      ? 'Embedded font budget exceeded' : `Embedded image budget exceeded (${LIMITS.imageBytes / 1024 / 1024} MiB per image, ${LIMITS.imageTotalBytes / 1024 / 1024} MiB total)`);
    if (asset.kind !== 'model' && asset.kind !== 'font') {
      number(asset.width, 'Image width', 1, LIMITS.imageSize);
      number(asset.height, 'Image height', 1, LIMITS.imageSize);
      assert(Number.isInteger(asset.width) && Number.isInteger(asset.height), 'Image dimensions must be integers');
      for (const key of ['offsetX', 'offsetY']) if (asset[key] !== undefined) number(asset[key], key);
    }
    assetIds.add(asset.id);
  }
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const assetRef = (id, label) => {
    if (id !== undefined && id !== null) {
      assert(assetIds.has(id), `${label} references an unknown asset`);
      if (label !== 'Model') assert(!['model', 'font', 'sound', 'music'].includes(assetById.get(id)?.kind), `${label} requires an image`);
    }
  };
  for (const asset of assets) if (asset.rotations !== undefined) {
    assert(asset.kind === 'sprite' || asset.kind === 'weapon', 'Directional views require a sprite');
    array(asset.rotations, 'Sprite rotations', 8);
    assert(asset.rotations.length === 8, 'Sprite rotations require eight views');
    for (const view of asset.rotations) {
      object(view, 'Sprite rotation'); assetRef(view.assetId, 'Sprite rotation');
      assert(typeof view.assetId === 'string' && typeof view.flip === 'boolean', 'Invalid sprite rotation');
    }
  }
  const spriteClips = project.spriteClips || [];
  array(spriteClips, 'Sprite clips', 1024);
  for (const clip of spriteClips) {
    unique(clip, 'Sprite clip'); text(clip.name, 'Sprite clip name', 100);
    array(clip.frames, 'Sprite frames', 256); assert(clip.frames.length > 0, 'Sprite clip needs frames');
    for (const id of clip.frames) { assert(assetIds.has(id), 'Sprite frame references an unknown image'); assetRef(id, 'Sprite frame'); }
    number(clip.seconds, 'Sprite frame duration', .001, 60);
    assert(typeof clip.loop === 'boolean', 'Sprite loop flag must be boolean');
  }
  const clipRef = id => assert(spriteClips.some(clip => clip.id === id), 'Command references an unknown sprite clip');
  if (project.materialAnimations !== undefined) {
    array(project.materialAnimations, 'Material animation mappings', LIMITS.assets);
    for (const mapping of project.materialAnimations) {
      object(mapping, 'Material animation'); assetRef(mapping.assetId, 'Animated material');
      assert(assetIds.has(mapping.assetId), 'Animated material references an unknown image');
      clipRef(mapping.clipId); number(mapping.offset, 'Material animation offset', 0, 65536);
    }
  }
  const modelRef = id => {
    assetRef(id, 'Model');
    if (id !== undefined && id !== null) assert(assetById.get(id)?.kind === 'model', 'Object model must reference a model asset');
  };
  const sectors = project.map.sectors || [];
  array(sectors, 'Sectors', LIMITS.sectors);
  for (const sector of sectors) {
    unique(sector, 'Sector');
    number(sector.floorHeight, 'Floor height', -32768, 32767);
    number(sector.ceilingHeight, 'Ceiling height', -32768, 32767);
    number(sector.light, 'Sector light', 0, 255);
    assert(typeof sector.sky === 'boolean', 'Sector sky must be boolean');
    if (sector.wallsOnly !== undefined) assert(typeof sector.wallsOnly === 'boolean', 'Sector wallsOnly must be boolean');
    assetRef(sector.floorAsset, 'Floor material');
    assetRef(sector.ceilingAsset, 'Ceiling material');
    if (sector.textureScale !== undefined) assertTextureScale(sector.textureScale, 'Surface texture scale');
  }
  const sectorIds = new Set(sectors.map(sector => sector.id));
  for (const wall of walls) {
    unique(wall, 'Wall');
    assert(vertexMap.has(wall.a) && vertexMap.has(wall.b), 'Wall references an unknown vertex');
    const a = vertexMap.get(wall.a), b = vertexMap.get(wall.b);
    assert(a.x !== b.x || a.y !== b.y, 'Wall endpoints must be distinct');
    assert(colorPattern.test(wall.color), 'Wall color must be #rrggbb');
    number(wall.height, 'Wall height', 8, 4096);
    assert(typeof wall.solid === 'boolean', 'Wall solid must be boolean');
    assetRef(wall.assetId, 'Wall material');
    for (const side of [wall.right, wall.left]) {
      if (side === undefined || side === null) continue;
      object(side, 'Wall side');
      assert(sectorIds.has(side.sectorId), 'Wall side references an unknown sector');
      number(side.offsetX, 'Wall X offset');
      number(side.offsetY, 'Wall Y offset');
      if (side.textureScale !== undefined) assertTextureScale(side.textureScale, 'Wall texture scale');
      for (const key of ['upper', 'middle', 'lower']) assetRef(side[key], 'Side material');
    }
    if (wall.flags !== undefined) number(wall.flags, 'Wall flags', 0, 65535);
    if (wall.activationModes !== undefined) {
      array(wall.activationModes, 'Wall activation modes', 3);
      for (const mode of wall.activationModes) assert(['use', 'cross', 'shoot'].includes(mode), 'Unknown wall activation mode');
    }
    for (const key of ['special', 'tag']) if (wall[key] !== undefined) {
      number(wall[key], `Wall ${key}`, 0, 65535); assert(Number.isInteger(wall[key]), `Wall ${key} must be an integer`);
    }
    if (wall.specialFormat !== undefined) assert(wall.specialFormat === 'zdoom', 'Unknown linedef special format');
    if (wall.args !== undefined) {
      array(wall.args, 'Linedef arguments', 5);
      assert(wall.args.length === 5, 'Linedef requires five arguments');
      for (const value of wall.args) number(value, 'Linedef argument', -32768, 32767);
    }
  }
  // Object groups are a label on objects, one level deep: the members stay ordinary objects that
  // the renderer, the physics world and the event sheet know nothing about.
  const objectGroups = project.map.entityGroups || [];
  array(objectGroups, 'Object groups', 512);
  const groupIds = new Set();
  for (const group of objectGroups) {
    object(group, 'Object group');
    assert(typeof group.id === 'string' && group.id.length > 0 && group.id.length <= 120, 'Invalid object group id');
    assert(!groupIds.has(group.id), `Duplicate object group ${group.id}`);
    groupIds.add(group.id);
    text(group.name, 'Object group name', 100);
  }
  for (const entity of entities) {
    unique(entity, 'Entity');
    validateEntity(entity, { assetRef, clipRef, modelRef, assets });
    if (entity.groupId !== undefined) {
      assert(typeof entity.groupId === 'string' && groupIds.has(entity.groupId),
        `Object ${entity.id} is in an unknown group`);
    }
  }
  assert(entities.filter(entity => entity.type === 'light' && entity.light).length <= 16, 'At most 16 dynamic point lights are supported');
  assert(entities.filter(entity => entity.physics && entity.physics.body !== 'none').length <= 256, 'At most 256 object rigid bodies are supported');
  assert(entities.filter(entity => entity.type === 'player').length === 1, 'A map must have exactly one player');
  // Scenes hold reusable objects and the events that script them; the objects keep
  // the same rules as map objects, but their identifiers live in the scene.
  if (project.scenes !== undefined) {
    array(project.scenes, 'Scenes', MAX_SCENES);
    const sceneIds = new Set();
    for (const scene of project.scenes) {
      object(scene, 'Scene');
      identifier(scene.id, 'Scene ID');
      assert(!sceneIds.has(scene.id), `Duplicate scene ID: ${scene.id}`);
      sceneIds.add(scene.id);
      text(scene.name, 'Scene name', 100);
      array(scene.entities, 'Scene objects', MAX_SCENE_ENTITIES);
      const sceneEntityIds = new Set();
      for (const entity of scene.entities) {
        object(entity, 'Scene object');
        identifier(entity.id, 'Scene object ID');
        assert(!sceneEntityIds.has(entity.id), `Duplicate ID in scene ${scene.name}: ${entity.id}`);
        sceneEntityIds.add(entity.id);
        assert(entity.type !== 'player', 'A scene cannot contain the player object');
        validateEntity(entity, { assetRef, clipRef, modelRef, assets });
      }
      // Scene objects can be grouped like nodes; the parent must exist in the same scene
      // and the grouping must stay a tree.
      for (const entity of scene.entities) {
        if (entity.parentId === undefined) continue;
        identifier(entity.parentId, 'Scene object parent');
        assert(entity.parentId !== entity.id, 'A scene object cannot be grouped under itself');
        assert(sceneEntityIds.has(entity.parentId), 'A scene object parent references an unknown object');
        const seen = new Set([entity.id]);
        let parent = entity.parentId;
        for (let depth = 0; parent && depth <= scene.entities.length; depth++) {
          assert(!seen.has(parent), `Scene object grouping has a cycle at ${entity.id}`);
          seen.add(parent);
          parent = scene.entities.find(item => item.id === parent)?.parentId;
        }
      }
      if (scene.joints !== undefined) {
        array(scene.joints, 'Scene joints', MAX_JOINTS);
        const jointIds = new Set();
        for (const joint of scene.joints) {
          assert(!jointIds.has(joint?.id), `Duplicate joint id in scene ${scene.name}: ${joint?.id}`);
          jointIds.add(joint?.id);
          validateJoint(joint, { ids: sceneEntityIds, label: `Scene ${scene.name} joint ${joint?.id}` });
          for (const side of [joint.a, joint.b]) {
            if (!side) continue;
            const node = scene.entities.find(entity => entity.id === side);
            assert(node.physics && node.physics.body !== 'none',
              `Scene ${scene.name} joint ${joint.id} needs objects with an enabled rigid body`);
          }
        }
      }
      if (scene.events !== undefined) {
        array(scene.events, 'Scene events', MAX_SCENE_EVENTS);
        const eventIds = new Set();
        for (const event of scene.events) {
          object(event, 'Scene event');
          identifier(event.id, 'Scene event ID');
          assert(!eventIds.has(event.id), `Duplicate event ID in scene ${scene.name}: ${event.id}`);
          eventIds.add(event.id);
          assert(typeof event.enabled === 'boolean' && typeof event.once === 'boolean', 'Scene event enabled/once must be boolean');
          if (event.ownerId !== undefined) assert(sceneEntityIds.has(event.ownerId), 'Scene event owner references an unknown scene object');
          // A scene event carries the same commands a map event does: core actions such
          // as addVariable live in ACTIONS, not in the engine tables, so looking them up
          // in engineCommand alone rejected a scene holding a pickup's own script.
          for (const [list, label] of [[event.conditions, 'condition'], [event.actions, 'action']]) {
            array(list || [], 'Scene event commands', 64);
            for (const command of list || []) {
              object(command, 'Scene event command');
              assert(label === 'action' ? ACTIONS.includes(command.type) : CONDITIONS.includes(command.type),
                `Unknown scene event ${label}: ${command.type}`);
            }
          }
          if (event.condition !== undefined) assert(CONDITIONS.includes(event.condition?.type), `Unknown scene event condition: ${event.condition?.type}`);
        }
      }
    }
  }
  object(project.environment, 'Environment');
  const shaderErrors = validateShaders(project);
  assert(shaderErrors.length === 0, shaderErrors.join('; '));
  for (const shader of project.shaders || []) unique(shader, 'Shader');
  for (const key of ['sky', 'floor']) assert(colorPattern.test(project.environment[key]), `${key} must be #rrggbb`);
  assetRef(project.environment.skyAsset, 'Sky panorama');
  assetRef(project.environment.weaponAsset, 'Weapon overlay');
  if (project.environment.weaponAssets !== undefined) {
    object(project.environment.weaponAssets, 'Weapon overlay mappings');
    for (const [weapon, id] of Object.entries(project.environment.weaponAssets)) {
      assert(WEAPONS.includes(weapon), 'Unknown weapon overlay mapping');
      assetRef(id, 'Weapon overlay');
    }
  }
  if (project.environment.skyMode !== undefined) assert(['doom', 'panorama'].includes(project.environment.skyMode), 'Invalid sky projection');
  if (project.environment.skybox !== undefined) {
    object(project.environment.skybox, 'Skybox');
    for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
      assert(typeof project.environment.skybox[face] === 'string', 'A skybox needs all six faces');
      assetRef(project.environment.skybox[face], 'Skybox face');
    }
  }
  if (sectors.length) sectorGeometry(project);
  validateVariables(project.variables);
  if (project.playerControl !== undefined) assert(['legacy', 'events'].includes(project.playerControl), 'Unknown player control mode');
  const sheets = project.eventSheets || [];
  array(sheets, 'Event sheets', 100);
  for (const sheet of sheets) {
    unique(sheet, 'Event sheet');
    text(sheet.name, 'Sheet name', 100);
    assert(['engine', 'game', 'object'].includes(sheet.section), 'Unknown event sheet section');
    assert(typeof sheet.enabled === 'boolean', 'Sheet enabled must be boolean');
    assert(['beforePhysics', 'afterPhysics', 'interface'].includes(sheet.phase), 'Unknown event sheet phase');
  }
  const sheetIds = new Set(sheets.map(sheet => sheet.id));
  const groups = project.eventGroups || [];
  array(groups, 'Event groups', 200);
  for (const group of groups) {
    unique(group, 'Event group'); text(group.name, 'Group name', 100);
    assert(typeof group.enabled === 'boolean', 'Group enabled must be boolean');
    if (group.description !== undefined) assert(typeof group.description === 'string' && group.description.length <= 2000, 'Group description must be text up to 2000 characters');
  }
  array(project.events, 'Events', LIMITS.events);
  validateEventStructure(project, assert);
  const entityIds = new Set(entities.map(entity => entity.id));
  validateLevelJoints(project.map, entityIds);
  validateEntityShaders(project);
  validateHUD(project.hud, { unique, assets, variables: project.variables, assert });
  if (project.gameMenus !== undefined) {
    object(project.gameMenus, 'Game menus');
    assert(project.gameMenus.version === 1, 'Unknown game menu version');
    if (project.gameMenus.presentation !== undefined) assert(project.gameMenus.presentation === 2, 'Unknown game menu presentation version');
    array(project.gameMenus.screens, 'Game menu screens', 128);
    for (const name of project.gameMenus.screens) identifier(name, 'Game menu screen');
    assert(new Set(project.gameMenus.screens).size === project.gameMenus.screens.length, 'Duplicate game menu screens');
    assert(project.gameMenus.screens.includes(project.gameMenus.entry), 'Unknown game entry menu');
    array(project.gameMenus.elementIds, 'Game menu HUD IDs', MAX_HUD_ELEMENTS);
    for (const id of project.gameMenus.elementIds) assert(project.hud?.elements.some(item => item.id === id), 'Menu references an unknown HUD element');
    if (project.gameMenus.episodes !== undefined) {
      array(project.gameMenus.episodes, 'Game episodes', 32);
      const episodeIds = new Set();
      for (const episode of project.gameMenus.episodes) {
        object(episode, 'Game episode');
        identifier(episode.levelId, 'Episode level');
        assert(!episodeIds.has(episode.levelId), 'Duplicate episode entry');
        episodeIds.add(episode.levelId);
        text(episode.name, 'Episode name', 100);
        if (episode.patch !== undefined) text(episode.patch, 'Episode patch', 100);
        if (episode.key !== undefined) text(episode.key, 'Episode key', 8);
        assert(typeof episode.noSkillMenu === 'boolean', 'Episode skill-menu flag must be boolean');
        if (project.game || gameLevelIds) assert(project.game?.levels.some(level => level.id === episode.levelId) ||
          gameLevelIds?.has(episode.levelId), 'Episode references an unknown game level');
      }
    }
    if (project.gameMenus.episodeSources !== undefined) {
      array(project.gameMenus.episodeSources, 'Episode definition sources', 64);
      for (const source of project.gameMenus.episodeSources) {
        text(source.name, 'Episode definition filename', 256);
        assert(typeof source.source === 'string' && source.source.length <= 1024 * 1024, 'Invalid episode definition source');
      }
    }
    if (project.gameMenus.sources !== undefined) {
      array(project.gameMenus.sources, 'Menu definition sources', 64);
      for (const source of project.gameMenus.sources) {
        text(source.name, 'Menu definition filename', 256);
        text(source.source, 'Menu definition source', 1024 * 1024);
      }
    }
  }
  for (const event of project.events) {
    unique(event, 'Event');
    if (event.name !== undefined) text(event.name, 'Event name', 100);
    if (event.comment !== undefined) assert(typeof event.comment === 'string' && event.comment.length <= 2000, 'Event comment must be text up to 2000 characters');
    if (event.conditionMode !== undefined) assert(['and', 'or'].includes(event.conditionMode), 'Condition mode must be and/or');
    if (event.sheetId !== undefined) assert(sheetIds.has(event.sheetId), 'Event references an unknown sheet');
    assert(typeof event.enabled === 'boolean' && typeof event.once === 'boolean', 'Event enabled/once must be boolean');
    if (event.forEachType !== undefined) {
      assert(['enemy', 'pickup', 'decoration'].includes(event.forEachType), 'Unsupported for-each object type');
      assert(event.ownerId === undefined, 'For-each rules cannot also have an owner');
    }
    if (event.ownerId !== undefined) assert(entityIds.has(event.ownerId), 'Event owner references an unknown entity');
    if (event.conditions !== undefined) array(event.conditions, 'Additional conditions', 15);
    const targetId = id => {
      if (id === '$self') {
        assert(event.ownerId !== undefined || event.forEachType, 'This object requires an object-owned or for-each event');
        if (event.forEachType) return '$self';
      }
      const resolved = resolveEntityId(event, id);
      assert(entityIds.has(resolved), 'Event references an unknown entity');
      return resolved;
    };
    const targetEntities = id => {
      const resolved = targetId(id);
      return resolved === '$self' ? entities.filter(entity => entity.type === event.forEachType) : entities.filter(entity => entity.id === resolved);
    };
    const expression = value => validateExpression(value, expressionContext(project, event));
    const numberOrExpression = (value, label, min, max) => isExpression(value) ? expression(value) : number(value, label, min, max);
    const validateCommand = command => {
      const definition = engineCommand(command.type);
      if (!definition) return;
      for (const field of definition.fields) {
        if (field.optional && command[field.name] === undefined) continue;
        if (isExpression(command[field.name]) && ['number', 'value', 'string'].includes(field.kind)) { expression(command[field.name]); continue; }
        if (field.kind === 'number') {
          number(command[field.name], field.name, field.min, field.max);
          if (['diceSides', 'pellets'].includes(field.name)) assert(Number.isInteger(command[field.name]), `${field.name} must be an integer`);
        } else if (field.kind === 'value') scalar(command[field.name]);
        else if (field.kind === 'choice') assert(field.options.includes(command[field.name]), `Unsupported ${field.name}`);
        else if (field.kind === 'string') assert(typeof command[field.name] === 'string' && command[field.name].length <= 2000, `${field.name} must be text up to 2000 characters`);
        else if (field.kind === 'image') {
          // An empty image means "not chosen yet": the event is still valid, and the
          // runtime reports which spray needed artwork when it is triggered.
          if (command[field.name] === '') continue;
          identifier(command[field.name], field.name);
          assert((project.assets || []).some(asset => asset.id === command[field.name] &&
            !['sound', 'music', 'model', 'font'].includes(asset.kind)), `${field.name} must be an imported image asset`);
        } else identifier(command[field.name], field.name);
      }
      if (definition.target) {
        const targets = targetEntities(command.entityId);
        assert(['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(command.type) || targets.every(entity => entity.type !== 'player'), 'Use player stat commands for the player, not object health');
      }
      if (definition.variable) assert(Object.hasOwn(project.variables, command.variable), 'Condition references an unknown variable');
      if (['gameScreen', 'setGameScreen'].includes(command.type)) {
        assert(['playing', 'return', 'pause'].includes(command.screen) || project.gameMenus?.screens.includes(command.screen), 'Unknown game menu screen');
      }
      if (command.type === 'setGameSetting' && !isExpression(command.value)) validateSetting(command.setting, command.value);
      if (command.type === 'toggleGameSetting') assert(typeof GAME_SETTINGS[command.setting].value === 'boolean', 'Only boolean settings can be toggled');
      if (command.type === 'adjustGameSetting') assert(typeof GAME_SETTINGS[command.setting].value === 'number', 'Only numeric settings can be adjusted');
      if (['setShaderUniform', 'setShaderEnabled', 'shaderEnabled'].includes(command.type)) {
        const shader = project.shaders?.find(shader => shader.id === project.environment.shaderId);
        assert(shader, 'Shader commands require a selected environment shader');
        if (command.type === 'setShaderUniform') assert(Object.hasOwn(shader.uniforms || {}, command.uniform), 'Shader command references an unknown uniform');
      }
      if (['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(command.type)) {
        const targets = targetEntities(command.entityId);
        assert(targets.every(entity => Object.hasOwn(entity.variables || {}, command.variable)), 'Command references an unknown object variable');
        if (!isExpression(command.value) && command.type !== 'objectVariableCompare') {
          assert(targets.every(entity => typeof entity.variables[command.variable] === typeof command.value), 'Object variable assignment must preserve its type');
        }
        if (command.type === 'addObjectVariable') assert(targets.every(entity => typeof entity.variables[command.variable] === 'number'), 'Only numeric object variables can be added');
      }
      if (definition.wall) assert(walls.some(wall => wall.id === command.wallId), 'Command references an unknown wall');
      if (command.type === 'loadGameLevel')
        assert(project.game?.levels.some(level => level.id === command.levelId) || gameLevelIds?.has(command.levelId), 'Command references an unknown game level');
      if (['saveGame', 'loadGame'].includes(command.type)) assert(Number.isInteger(command.slot), 'Game save slot must be an integer');
      if (command.type === 'spawnEntity') assert(project.map.entities.some(entity => entity.id === command.templateId), 'Spawn command references an unknown template object');
      if (command.type === 'distanceBetween') {
        assert(typeof command.otherId === 'string' && ['$player', '$self'].includes(command.otherId) || entityIds.has(command.otherId),
          'Distance condition references an unknown comparison object');
      }
      if (command.type === 'selectGameEpisode')
        assert(project.game?.levels.some(level => level.id === command.levelId) || gameLevelIds?.has(command.levelId) ||
          !project.game && !gameLevelIds && project.gameMenus?.episodes?.some(episode => episode.levelId === command.levelId),
        'Episode command references an unknown game level');
      if (definition.sector) assert(sectorIds.has(command.sectorId), 'Command references an unknown sector');
      if (definition.spriteClip) clipRef(command.clipId);
      for (const key of ['clipId', 'impactClipId']) if (['launchProjectile', 'enemyProjectile'].includes(command.type) && command[key] !== undefined) clipRef(command[key]);
      if (definition.group) assert(groups.some(group => group.id === command.groupId), 'Command references an unknown event group');
      if (definition.hudElement) {
        const element = project.hud?.elements.find(element => element.id === command.elementId);
        assert(element, 'Command references an unknown HUD element');
        if (['hudClicked', 'hudFocused'].includes(command.type)) assert(element.interactive, 'HUD click/focus conditions need an interactive element');
        if (command.type === 'setHUDProperty' && !isExpression(command.value)) validateHUDProperty(command.property, command.value, element, assert);
        if (['setHUDText', 'setHUDBinding'].includes(command.type) && !isExpression(command.text)) {
          const override = command.type === 'setHUDText' ? { text: command.text } : { binding: command.binding };
          validateHUD({ ...project.hud, elements: [{ ...element, parentId: undefined, ...override }], animations: [] },
            { unique: () => {}, assets, variables: project.variables, assert });
        }
      }
      if (definition.hudAnimation) assert(project.hud?.animations.some(clip => clip.id === command.animationId), 'Command references an unknown HUD animation');
      if (command.type === 'playSound' || ['launchProjectile', 'enemyProjectile', 'moveSector'].includes(command.type) && command.sound !== undefined) {
        assert(assets.some(asset => asset.kind === 'sound' && asset.name === command.sound), 'Sound command references an unknown sound name');
      }
      if (['moveEnemy', 'enemySeesPlayer', 'enemyHitscan', 'enemyProjectile', 'enemyAlert', 'enemyAttackChance'].includes(command.type)) {
        assert(targetEntities(command.entityId).every(entity => entity.type === 'enemy'), 'Enemy commands require enemy objects');
      }
      if (command.stat === 'armorDivisor' && command.type === 'setPlayerStat') numberOrExpression(command.value, 'Armor divisor', 1, 1000000);
      if (command.stat === 'armorDivisor' && command.type === 'addPlayerStat') throw new Error('Set the armor divisor instead of adding to it');
      if (command.type === 'entityDoomType' && !isExpression(command.doomType)) assert(Number.isInteger(command.doomType), 'Doom thing type must be an integer');
      if (command.type === 'damagePlayer' && command.direction !== undefined) assert(['front', 'left', 'right', 'self'].includes(command.direction), 'Unsupported damage direction');
      if (['movePlayer', 'turnPlayer', 'mouseLook', 'jumpPlayer'].includes(command.type)) {
        assert(project.playerControl === 'events', 'Scripted input actions require event-driven player controls');
        assert(sheets.find(sheet => sheet.id === event.sheetId)?.phase === 'beforePhysics', 'Input actions need a beforePhysics event sheet');
      }
    };
    for (const condition of eventConditions(event)) {
      object(condition, 'Condition');
      assert(CONDITIONS.includes(condition.type), 'Unknown condition');
      if (condition.inverted !== undefined) {
        assert(typeof condition.inverted === 'boolean', 'Condition inversion must be boolean');
        assert(!condition.inverted || !['onStart', 'keyPressed', 'mouseMoved', 'collisionStarted', 'collisionEnded', 'animationFinished', 'hudClicked', 'hudAnimationFinished', 'hudStatChanged', 'entityDamaged', 'wallActivated'].includes(condition.type), 'Trigger conditions cannot be inverted');
      }
      validateCommand(condition);
      if (condition.type === 'keyPressed') {
        assert(INPUT_KEYS.includes(condition.key), 'Unsupported event key');
      }
      if (condition.type === 'nearEntity') {
        targetId(condition.entityId);
        numberOrExpression(condition.distance, 'Trigger distance', 1, 4096);
      }
      if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(condition.type)) {
        const entityId = targetId(condition.entityId);
        const otherId = condition.otherId === '$world' ? '$world' : targetId(condition.otherId);
        assert(entityId !== otherId, 'A collision condition needs two distinct targets');
        for (const id of [entityId, otherId]) {
          if (id === '$world') continue;
          for (const entity of targetEntities(id)) assert(entity.type === 'player' || (entity.physics && entity.physics.body !== 'none'), 'Collision targets need enabled physics');
        }
      }
      if (condition.type === 'animationFinished') {
        for (const entity of targetEntities(condition.entityId)) assert(entity.modelAsset, 'Animation condition needs a model object');
      }
    }
    array(event.actions, 'Actions', 32);
    for (const action of event.actions) {
      object(action, 'Action');
      assert(ACTIONS.includes(action.type), 'Unknown action');
      validateCommand(action);
      if (action.type === 'showMessage') isExpression(action.message) ? expression(action.message) : text(action.message, 'Message', 500);
      if (['setVariable', 'addVariable'].includes(action.type)) {
        assert(Object.hasOwn(project.variables, action.variable), 'Action references an unknown variable');
        if (isExpression(action.value)) expression(action.value);
        else {
          scalar(action.value);
          assert(typeof action.value === typeof project.variables[action.variable], 'Variable assignment must preserve its type');
        }
        if (action.type === 'addVariable') assert(typeof project.variables[action.variable] === 'number', 'Only numeric variables can be added');
      }
      if (action.type === 'teleport') {
        numberOrExpression(action.x, 'Teleport X');
        numberOrExpression(action.y, 'Teleport Y');
        if (action.z !== undefined) numberOrExpression(action.z, 'Teleport height', -32768, 32767);
        // Imported Doom teleport lines carry the landing angle.
        if (action.angle !== undefined) numberOrExpression(action.angle, 'Teleport angle', -3600, 3600);
      }
      if (action.type === 'removeEntity') {
        assert(targetEntities(action.entityId).every(entity => entity.type !== 'player'), 'Cannot remove the player');
      }
      if (action.type === 'setEntityPosition') {
        targetId(action.entityId);
        numberOrExpression(action.x, 'Object X');
        numberOrExpression(action.y, 'Object Y');
        if (action.z !== undefined) numberOrExpression(action.z, 'Object height', -32768, 32767);
      }
      if (action.type === 'rotateEntity') {
        targetId(action.entityId);
        numberOrExpression(action.angle, 'Object angle', -3600, 3600);
      }
      if (['applyImpulse', 'applyForce', 'setVelocity'].includes(action.type)) {
        assert(targetEntities(action.entityId).every(entity => entity.physics?.body === 'dynamic'), 'Force, impulse and velocity actions need a dynamic rigid body');
        for (const key of ['x', 'y', 'z']) numberOrExpression(action[key], `Physics ${key}`, -100000, 100000);
      }
      if (['playAnimation', 'stopAnimation'].includes(action.type)) {
        for (const entity of targetEntities(action.entityId)) {
          const model = assets.find(asset => asset.id === entity.modelAsset);
          assert(model?.kind === 'model', 'Animation actions need a model object');
          if (action.type === 'playAnimation') assert(model.animations.includes(action.clip), 'Animation action references an unknown clip');
        }
        if (action.type === 'playAnimation') {
          text(action.clip, 'Animation clip', 200);
          numberOrExpression(action.speed, 'Animation speed', .01, 10);
          assert(typeof action.loop === 'boolean', 'Animation loop must be boolean');
        }
      }
    }
  }
  if (project.strings !== undefined) {
    object(project.strings, 'Language strings');
    const keys = Object.keys(project.strings);
    assert(keys.length <= LIMITS.languageKeys, 'Too many language strings');
    for (const [key, value] of Object.entries(project.strings)) {
      assert(/^[A-Za-z0-9_$.]+$/.test(key) && key.length <= 80, 'Invalid language keyword');
      assert(typeof value === 'string' && value.length <= 8192, 'Language strings must be bounded text');
    }
  }
  if (project.actors !== undefined) {
    array(project.actors, 'Actors', 4000);
    // The actor table is the largest part of an imported project (thousands of records
    // with every frame and action) and only changes when the actor panel edits it. In
    // fast (interactive) mode it is screened once per table object; save, export,
    // import and MCP changes still validate it in full.
    if (!fast || !verifiedActorTables.has(project.actors)) {
    if (fast) verifiedActorTables.add(project.actors);
    const actorIds = new Set(), actorNames = new Set();
    for (const actor of project.actors) {
      object(actor, 'Actor');
      identifier(actor.id, 'Actor ID');
      assert(!actorIds.has(actor.id), `Duplicate actor ID: ${actor.id}`);
      actorIds.add(actor.id);
      text(actor.name, 'Actor name', 80);
      assert(!actorNames.has(actor.name.toLowerCase()), `Duplicate actor name: ${actor.name}`);
      actorNames.add(actor.name.toLowerCase());
      if (actor.doomedNum !== null && actor.doomedNum !== undefined) number(actor.doomedNum, 'Actor editor number', 0, 65535);
      for (const key of ['health', 'speed', 'damage', 'painChance', 'radius', 'height', 'mass', 'reactionTime', 'fastSpeed']) {
        if (actor[key] !== undefined) number(actor[key], `Actor ${key}`, -1, 1e12);
      }
      object(actor.flags || {}, 'Actor flags');
      object(actor.sounds || {}, 'Actor sounds');
      object(actor.states, 'Actor states');
      array(actor.states.frames, 'Actor frames', 4000);
      for (const [label, index] of Object.entries(actor.states.labels || {})) {
        text(label, 'State label', 60);
        assert(Number.isInteger(index) && index >= 0 && index <= actor.states.frames.length, `State label ${label} points outside the frame list`);
      }
      for (const frame of actor.states.frames) {
        object(frame, 'Actor frame');
        assert(['frame', 'goto', 'loop', 'stop', 'wait', 'fail'].includes(frame.kind), 'Invalid actor frame kind');
        if (frame.kind !== 'frame') continue;
        if (frame.sprite !== undefined) assert(typeof frame.sprite === 'string' && /^[A-Za-z0-9_#-]{1,8}$/.test(frame.sprite), 'Invalid frame sprite');
        if (frame.letter !== undefined) assert(typeof frame.letter === 'string' && /^[A-Za-z0-9#]$/.test(frame.letter), 'Invalid frame letter');
        number(frame.duration, 'Frame duration', -1, 65535);
        array(frame.actions || [], 'Frame actions', 24);
      }
    }
    }
  }
  if (project.cameraTextures !== undefined) {
    array(project.cameraTextures, 'Camera textures', 32);
    for (const definition of project.cameraTextures) {
      object(definition, 'Camera texture');
      assert(typeof definition.name === 'string' && /^[A-Za-z0-9_]{1,8}$/.test(definition.name), 'Invalid camera texture name');
      number(definition.width, 'Camera texture width', 1, LIMITS.imageSize);
      number(definition.height, 'Camera texture height', 1, LIMITS.imageSize);
      if (definition.fit !== undefined) assert(typeof definition.fit === 'boolean', 'Camera texture fit must be boolean');
    }
  }
  if (project.game !== undefined) {
    const game = project.game;
    object(game, 'Game'); assert(game.version === 1, 'Unknown game format');
    array(game.levels, 'Game levels', LIMITS.levels); assert(game.levels.length > 0, 'Game needs levels');
    const levelIds = new Set();
    for (const level of game.levels) {
      object(level, 'Game level'); identifier(level.id, 'Level ID'); text(level.name, 'Level name', 100);
      assert(!levelIds.has(level.id), `Duplicate game level ${level.id}`); levelIds.add(level.id);
      object(level.data, 'Level data');
      assert(!['game', 'version', 'title', 'assets'].some(key => Object.hasOwn(level.data, key)), 'Level data must not nest shared game fields');
      array(level.assetIds, 'Level assets', LIMITS.assets);
      assert(new Set(level.assetIds).size === level.assetIds.length, 'Duplicate level asset references');
      if (level.id !== game.active)
        for (const id of level.assetIds) assert(assetIds.has(id), `Level ${level.id} references unknown asset ${id}`);
    }
    assert(levelIds.has(game.entry) && levelIds.has(game.active), 'Game entry/active level is missing');
    for (const level of game.levels) {
      for (const key of ['next', 'secretNext'])
        assert(level[key] === null || levelIds.has(level[key]), `Level ${level.id} has an unknown ${key} destination`);
      if (level.id === game.active || fast) continue;
      const retained = new Set(level.assetIds);
      validateProject({ version: project.version, title: project.title,
        assets: assets.filter(asset => retained.has(asset.id)), ...level.data }, { gameLevelIds: levelIds });
    }
    if (!fast) assert(JSON.stringify(game).length <= LIMITS.gameBytes, `Game level data exceeds ${LIMITS.gameBytes / 1024 / 1024} MiB`);
  }
  return project;
}

export function newId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function createProject() {
  return {
    version: VERSION,
    title: 'My first OpenDLE world',
    map: {
      vertices: [
        { id: 'v1', x: -384, y: -256 }, { id: 'v2', x: 384, y: -256 },
        { id: 'v3', x: 384, y: 256 }, { id: 'v4', x: -384, y: 256 },
      ],
      walls: [
        { id: 'w1', a: 'v1', b: 'v2', color: '#597b9a', height: 128, solid: true, right: { sectorId: 'room0', offsetX: 0, offsetY: 0 } },
        { id: 'w2', a: 'v2', b: 'v3', color: '#d29859', height: 128, solid: true, right: { sectorId: 'room0', offsetX: 0, offsetY: 0 } },
        { id: 'w3', a: 'v3', b: 'v4', color: '#597b9a', height: 128, solid: true, right: { sectorId: 'room0', offsetX: 0, offsetY: 0 } },
        { id: 'w4', a: 'v4', b: 'v1', color: '#d29859', height: 128, solid: true, right: { sectorId: 'room0', offsetX: 0, offsetY: 0 } },
      ],
      sectors: [{ id: 'room0', floorHeight: 0, ceilingHeight: 128, light: 208, sky: false }],
      entities: [
        { id: 'player', name: 'Player start', type: 'player', x: -180, y: 0, angle: 0 },
        { id: 'pickup', name: 'Energy cell', type: 'pickup', x: 160, y: 0, angle: 0 },
      ],
    },
    environment: { sky: '#172639', floor: '#272c34' },
    variables: { score: 0 },
    events: [
      { id: 'welcome', enabled: true, once: true, condition: { type: 'onStart' },
        actions: [{ type: 'showMessage', message: 'Welcome to OpenDLE. WASD to move, arrows to turn. Find the energy cell!' }] },
      { id: 'collect', ownerId: 'pickup', enabled: true, once: true, condition: { type: 'nearEntity', entityId: '$self', distance: 40 },
        actions: [{ type: 'addVariable', variable: 'score', value: 1 }, { type: 'removeEntity', entityId: '$self' },
          { type: 'showMessage', message: 'Energy cell collected! Your first no-code event works.' }] },
    ],
  };
}

export function addRoom(project, { x, y, width, depth, color = '#597b9a' }) {
  number(x, 'Room X');
  number(y, 'Room Y');
  number(width, 'Room width', 32, 8192);
  number(depth, 'Room depth', 32, 8192);
  const vertices = [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]]
    .map(([vx, vy]) => ({ id: newId('v'), x: vx, y: vy }));
  project.map.vertices.push(...vertices);
  const sectorId = newId('sector');
  if (project.map.sectors) project.map.sectors.push({ id: sectorId, floorHeight: 0, ceilingHeight: 128, light: 208, sky: false });
  project.map.walls.push(...vertices.map((vertex, index) => ({
    id: newId('w'), a: vertex.id, b: vertices[(index + 1) % 4].id, color, height: 128, solid: true,
    ...(project.map.sectors ? { right: { sectorId, offsetX: 0, offsetY: 0 } } : {}),
  })));
}

export function removeEntity(project, id) {
  const entity = project.map.entities.find(item => item.id === id);
  assert(entity && entity.type !== 'player', 'Select a non-player entity to delete');
  const referenced = project.events.some(event => event.ownerId !== id &&
    (eventConditions(event).some(condition => condition.entityId === id || condition.otherId === id) || event.actions.some(action => action.entityId === id)));
  assert(!referenced, 'This entity is used by an event. Remove those references first.');
  project.events = project.events.filter(event => event.ownerId !== id);
  project.map.entities = project.map.entities.filter(item => item.id !== id);
  // A group holds objects; when its last member is gone it is not a group any more.
  if (project.map.entityGroups) {
    const used = new Set(project.map.entities.map(item => item.groupId).filter(Boolean));
    project.map.entityGroups = project.map.entityGroups.filter(group => used.has(group.id));
  }
  // A joint cannot hold an object that is gone.
  if (project.map.joints) project.map.joints = project.map.joints.filter(joint => joint.a !== id && joint.b !== id);
}
