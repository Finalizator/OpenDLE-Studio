import { sectorGeometry } from './sectors.js';
import { decodeDataURI, readModel, validateModelDocument } from './gltf.js';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS, INPUT_KEYS, engineCommand } from './engine-script.js';
import { validateEventStructure } from './events.js';
import { validateHUD, validateHUDProperty, MAX_HUD_ELEMENTS } from './hud.js';
import { WEAPONS } from './player-state.js';
import { isExpression, validateExpression, validateVariables, scalar, expressionContext } from './expressions.js';
import { validateShaders } from './shaders.js';
import { GAME_SETTINGS, validateSetting } from './game-settings.js';

export const VERSION = 1;
export const CONDITIONS = ['onStart', 'always', 'keyPressed', 'nearEntity', 'collisionStarted', 'collisionEnded', 'isTouching', 'playerGrounded', 'animationFinished', ...ENGINE_CONDITIONS.map(command => command.type)];
export const ACTIONS = ['showMessage', 'setVariable', 'addVariable', 'teleport', 'removeEntity', 'setEntityPosition', 'rotateEntity', 'applyImpulse', 'applyForce', 'setVelocity', 'playAnimation', 'stopAnimation', ...ENGINE_ACTIONS.map(command => command.type)];
export const ENTITY_TYPES = ['player', 'enemy', 'pickup', 'light', 'decoration'];
const colorPattern = /^#[0-9a-f]{6}$/i;

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
    assert(typeof asset.src === 'string' && /^data:audio\/(midi|x-midi|x-mus);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.src), 'Music must be embedded MIDI or Doom MUS');
    assert(asset.src.length <= 2 * 1024 * 1024, 'Embedded music budget exceeded (2 MiB per track, 32 MiB total)');
    return { bucket: 'music', bytes: asset.src.length };
  }
  if (asset.kind === 'sound') {
    assert(typeof asset.src === 'string' && /^data:audio\/(wav|ogg|mpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.src), 'Sounds must be embedded WAV/OGG/MP3');
    assert(asset.src.length <= 12 * 1024 * 1024, 'Embedded sound budget exceeded (12 MiB each, 64 MiB total)');
    return { bucket: 'sound', bytes: asset.src.length };
  }
  if (asset.kind === 'font') {
    assert(typeof asset.src === 'string' && /^data:font\/(woff2?|ttf|otf);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.src), 'Fonts must be embedded WOFF/WOFF2/TTF/OTF');
    assert(asset.src.length <= 6 * 1024 * 1024, 'Embedded font budget exceeded');
    return { bucket: 'image', bytes: asset.src.length };
  }
  if (asset.kind === 'model') {
    assert(['glb', 'gltf'].includes(asset.format), 'Invalid model format');
    assert(typeof asset.src === 'string' && /^data:model\/gltf(-binary|\+json);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.src), 'Models must be embedded GLB/glTF');
    assert(asset.src.length <= 23 * 1024 * 1024, 'Embedded model budget exceeded');
    const parsed = readModel(decodeDataURI(asset.src), asset.format);
    validateModelDocument(parsed.json, parsed.binary?.length);
    array(asset.animations, 'Animation clip names', 256);
    assert(asset.animations.every(name => typeof name === 'string' && name.length <= 200), 'Invalid clip name');
    assert(JSON.stringify(asset.animations) === JSON.stringify((parsed.json.animations || []).map(clip => clip.name)), 'Model clip metadata does not match its source');
    return { bucket: 'image', bytes: asset.src.length };
  }
  assert(typeof asset.src === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.src), 'Assets must be embedded PNG images');
  assert(asset.src.length <= 6 * 1024 * 1024, 'Embedded image budget exceeded (6 MiB per image, 48 MiB total)');
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
export function cloneProjectForEdit(project, { deepGame = false } = {}) {
  if (!project.game) return structuredClone(project);
  const next = structuredClone({ ...project, game: null, assets: [] });
  next.game = deepGame ? structuredClone(project.game) : project.game;
  next.assets = [...(project.assets || [])];
  return next;
}

/**
 * `fast` skips re-validating dormant campaign levels and the multi-megabyte
 * game size check. Interactive edits only touch the active level, so a full
 * re-validation of 32 imported maps would add seconds to every drag; the full
 * check still runs on save, import, export and MCP changes.
 */
export function validateProject(project, { gameLevelIds, fast = false } = {}) {
  object(project, 'Project');
  assert(project.version === VERSION, `Unsupported project version; expected ${VERSION}`);
  text(project.title, 'Title', 100);
  object(project.map, 'Map');
  if (project.importSource !== undefined) {
    const source = project.importSource;
    object(source, 'Import provenance');
    assert(source.format === 'udmf', 'Unknown import provenance format');
    text(source.mapName, 'Source map name', 80); text(source.namespace, 'UDMF namespace', 80);
    const properties = record => {
      object(record, 'UDMF source properties');
      assert(Object.keys(record).length <= 256, 'UDMF source property limit exceeded');
      for (const [key, value] of Object.entries(record)) {
        assert(/^[a-z_][a-z0-9_]*$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid UDMF source key');
        assert(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
          typeof value === 'string' && value.length <= 65536, 'UDMF source values must be bounded scalars');
      }
    };
    properties(source.globals); array(source.blocks, 'UDMF source blocks', 105000);
    for (const block of source.blocks) {
      object(block, 'UDMF source block'); text(block.type, 'UDMF source block type', 80); properties(block.properties);
    }
    assert(JSON.stringify(source).length <= 24 * 1024 * 1024, 'UDMF import provenance exceeds 24 MiB');
  }
  const { vertices, walls, entities } = project.map;
  array(vertices, 'Vertices', 20000);
  array(walls, 'Walls', 20000);
  array(entities, 'Entities', 5000);
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
  array(assets, 'Assets', 3000);
  const assetIds = new Set();
  let assetBytes = 0, soundBytes = 0, musicBytes = 0;
  for (const asset of assets) {
    unique(asset, 'Asset');
    text(asset.name, 'Asset name', 100);
    assert(['texture', 'flat', 'sky', 'sprite', 'weapon', 'model', 'font', 'sound', 'music'].includes(asset.kind), 'Invalid asset kind');
    const payload = assetPayload(asset, fast);
    if (payload.bucket === 'music') {
      musicBytes += payload.bytes;
      assert(musicBytes <= 32 * 1024 * 1024, 'Embedded music budget exceeded (2 MiB per track, 32 MiB total)');
      assert(assets.filter(candidate => candidate.kind === 'music' && candidate.name === asset.name).length === 1, 'Music names must be unique');
      assetIds.add(asset.id); continue;
    }
    if (payload.bucket === 'sound') {
      soundBytes += payload.bytes;
      assert(soundBytes <= 64 * 1024 * 1024, 'Embedded sound budget exceeded (12 MiB each, 64 MiB total)');
      assert(assets.filter(candidate => candidate.kind === 'sound' && candidate.name === asset.name).length === 1, 'Sound names must be unique');
      assetIds.add(asset.id); continue;
    }
    assetBytes += payload.bytes;
    assert(assetBytes <= 48 * 1024 * 1024, asset.kind === 'model' ? 'Embedded model budget exceeded' : asset.kind === 'font'
      ? 'Embedded font budget exceeded' : 'Embedded image budget exceeded (6 MiB per image, 48 MiB total)');
    if (asset.kind !== 'model' && asset.kind !== 'font') {
      number(asset.width, 'Image width', 1, 2048);
      number(asset.height, 'Image height', 1, 2048);
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
    array(project.materialAnimations, 'Material animation mappings', 3000);
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
  array(sectors, 'Sectors', 20000);
  for (const sector of sectors) {
    unique(sector, 'Sector');
    number(sector.floorHeight, 'Floor height', -32768, 32767);
    number(sector.ceilingHeight, 'Ceiling height', -32768, 32767);
    number(sector.light, 'Sector light', 0, 255);
    assert(typeof sector.sky === 'boolean', 'Sector sky must be boolean');
    if (sector.wallsOnly !== undefined) assert(typeof sector.wallsOnly === 'boolean', 'Sector wallsOnly must be boolean');
    assetRef(sector.floorAsset, 'Floor material');
    assetRef(sector.ceilingAsset, 'Ceiling material');
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
  for (const entity of entities) {
    unique(entity, 'Entity');
    assert(ENTITY_TYPES.includes(entity.type), 'Unknown entity type');
    number(entity.x, 'Entity X');
    number(entity.y, 'Entity Y');
    number(entity.angle, 'Entity angle', -3600, 3600);
    if (entity.health !== undefined) number(entity.health, 'Object health', 0, 1000000);
    if (entity.ambush !== undefined) assert(typeof entity.ambush === 'boolean', 'Object ambush must be boolean');
    if (entity.skillMask !== undefined) {
      number(entity.skillMask, 'Object skill mask', 1, 7);
      assert(Number.isInteger(entity.skillMask), 'Object skill mask must be an integer');
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
        assert(['box', 'ball', 'capsule'].includes(config.shape), 'Invalid collider shape');
        for (const key of ['width', 'height', 'depth', 'radius']) number(config[key], `Collider ${key}`, .1, 4096);
        if (config.shape === 'capsule') assert(config.height >= config.radius * 2, 'Capsule height must be at least twice its radius');
        if (config.shape === 'ball') assert(config.height === config.radius * 2, 'Ball height must be twice its radius');
        number(config.mass, 'Body mass (kg)', .01, 100000);
        number(config.friction, 'Friction', 0, 10); number(config.restitution, 'Restitution', 0, 1);
        assert(typeof config.sensor === 'boolean' && typeof config.lockRotation === 'boolean', 'Physics flags must be boolean');
      }
    }
    if (entity.light !== undefined) {
      object(entity.light, 'Object light');
      assert(colorPattern.test(entity.light.color), 'Light color must be #rrggbb');
      number(entity.light.intensity, 'Light intensity', 0, 10);
      number(entity.light.radius, 'Light radius', 1, 8192);
    }
  }
  assert(entities.filter(entity => entity.type === 'light' && entity.light).length <= 16, 'At most 16 dynamic point lights are supported');
  assert(entities.filter(entity => entity.physics && entity.physics.body !== 'none').length <= 256, 'At most 256 object rigid bodies are supported');
  assert(entities.filter(entity => entity.type === 'player').length === 1, 'A map must have exactly one player');
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
  array(project.events, 'Events', 2048);
  validateEventStructure(project, assert);
  const entityIds = new Set(entities.map(entity => entity.id));
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
        else identifier(command[field.name], field.name);
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
  if (project.game !== undefined) {
    const game = project.game;
    object(game, 'Game'); assert(game.version === 1, 'Unknown game format');
    array(game.levels, 'Game levels', 128); assert(game.levels.length > 0, 'Game needs levels');
    const levelIds = new Set();
    for (const level of game.levels) {
      object(level, 'Game level'); identifier(level.id, 'Level ID'); text(level.name, 'Level name', 100);
      assert(!levelIds.has(level.id), `Duplicate game level ${level.id}`); levelIds.add(level.id);
      object(level.data, 'Level data');
      assert(!['game', 'version', 'title', 'assets'].some(key => Object.hasOwn(level.data, key)), 'Level data must not nest shared game fields');
      array(level.assetIds, 'Level assets', 3000);
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
    if (!fast) assert(JSON.stringify(game).length <= 128 * 1024 * 1024, 'Game level data exceeds 128 MiB');
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
}
