import { createProject, validateProject } from './project.js';
import { LIMITS } from './limits.js';
import { doomName, createDoomAssets, doomThings } from './doom-assets.js';
import { installWorldScripts } from './world-motion.js';
import { installSpriteAnimations, installActorSpriteStates, actorSpriteCells } from './sprite-animation.js';
import { installEngineScripts } from './engine-script.js';
import { importDoomHUD, installDoomInventoryScripts } from './doom-hud.js';
import { installDefaultHUD } from './hud.js';
import { parseUDMF, udmfRecords } from './udmf.js';
import { installGameMenu } from './game-menu.js';
import { importSBarInfo } from './sbarinfo.js';
import { assembleGameLevels, parseLevelRoutes } from './game-levels.js';
import { parseGameEpisodes } from './game-episodes.js';
import { resolveMusicAsset, musicReport } from './music.js';
import { applyThreeDFloors } from './three-d-floors.js';
import { importActors, actorIndex } from './actors.js';
import { unsupportedActorActions, mergeActorActionGaps, describeActorActionGaps, installActorProjectileSprites, usedActors, missileEffectActors } from './actor-runtime.js';
import { buildStringTable, resolveString } from './language.js';
import { parseSndInfo, soundTable, VANILLA_SOUNDS } from './sndinfo.js';
import { describeMapScripts } from './map-scripts.js';
import { acsLibrariesFromWad, selectAcsLibraries } from './acs-libraries.js';
import { unsupportedSpecials } from './line-specials.js';
import { translationSpecs, parseTranslationTable } from './translation.js';
import { parseCameraTextures } from './cameratextures.js';
import { parseSurfaceAnimations, rangeNames } from './animdefs.js';

const mapPattern = /^(MAP\d\d|E\dM\d)$/;

/** The map's per-thing scale, as the entity fields the renderer reads. */
function thingScale(record) {
  const x = record.scaleX ?? 1, y = record.scaleY ?? 1;
  if (x === 1 && y === 1) return {};
  if (x === y) return { spriteScale: x };
  return { spriteScaleX: x, spriteScaleY: y };
}

export function importWadGame(wad, entry, options = {}) {
  if (wad.maps.length > 128) throw new Error('A game exceeds the 128-level limit');
  entry ||= wad.maps.includes('MAP01') ? 'MAP01' : wad.maps.includes('E1M1') ? 'E1M1' : wad.maps[0];
  if (!wad.maps.includes(entry)) throw new Error(`Game entry map not found: ${entry}`);
  const sources = wad.lumps.filter(lump => ['MAPINFO', 'ZMAPINFO'].includes(lump.name)).map(lump => {
    if (lump.size > LIMITS.textBytes) throw new Error(`MAPINFO exceeds ${LIMITS.textBytes / 1024 / 1024} MiB`);
    return new TextDecoder().decode(new Uint8Array(wad.buffer, lump.start, lump.size));
  });
  const episodeInfo = parseGameEpisodes(sources, wad.maps);
  const gapReports = [];
  function* levels() {
    for (const id of wad.maps) {
      const level = importWadMap(wad, id, { ...options, episodeInfo, deferActionGaps: true });
      gapReports.push(level.actionGaps);
      yield { id, ...level };
    }
  }
  const result = assembleGameLevels(levels(),
    entry, options.title || 'Imported WAD game', parseLevelRoutes(sources));
  result.warnings.push(...episodeInfo.warnings);
  // Action-function gaps repeat for every level, so a 32-level game reports the
  // union once instead of 32 near-identical lines.
  const gameGaps = mergeActorActionGaps(gapReports);
  if (gameGaps.length) result.warnings.push(describeActorActionGaps(gameGaps, 'the imported levels'));
  validateProject(result.project);
  return result;
}

/**
 * Repaints the sprites of actors that declare a DECORATE/ZScript translation.
 * Sprites are baked with the palette, so the recolour happens here; the runtime
 * and the editor only see additional editable image assets and clips.
 */
/** Short stable suffix so translated assets can be shared and recognised. */
function translationSuffix(specs) {
  const hash = [...specs.join(',')].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7);
  return `tr${hash.toString(36).slice(0, 6)}`;
}

/** Loads pictures named by a script's strings, which `SetFont` turns into one-picture fonts. */
function importScriptPictureFonts(assets, program, limit = 64) {
  let imported = 0;
  for (const { module } of program.modules) {
    for (const name of module?.strings || []) {
      if (imported >= limit) return imported;
      if (typeof name !== 'string' || !name || name.length > 64) continue;
      if (!assets.has(name)) continue;
      for (const kind of ['sprite', 'texture', 'flat']) {
        try { assets.get(name, kind); imported++; break; } catch { /* try the next namespace */ }
      }
    }
  }
  return imported;
}

/**
 * Loads the artwork an ANIMDEFS animation names but the map does not place by itself.
 *
 * `assets.get` creates an asset for a picture the package ships; a name the package does not
 * have throws, and a range stepping past the shipped frames simply stops there.
 */
function importSurfaceAnimationFrames(assets, sources, wad) {
  const texts = [...sources.map(source => (typeof source === 'string' ? source : source?.source ?? source?.text)).filter(Boolean),
    ...wad.lumps.filter(lump => lump.name === 'ANIMDEFS' && lump.size > 0 && lump.size <= 1024 * 1024)
      .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)))];
  if (!texts.length) return;
  const parsed = parseSurfaceAnimations(texts);
  for (const sequence of parsed.sequences) {
    const names = sequence.range ? rangeNames(sequence.range) : sequence.frames.map(frame => frame.name);
    for (const name of names) {
      if (!assets.has(name)) continue;
      for (const kind of [sequence.kind, sequence.kind === 'texture' ? 'flat' : 'texture']) {
        try { assets.get(name, kind); break; } catch { /* the other namespace may have it */ }
      }
    }
  }
}

/**
 * Imports the sprite lumps an actor's states name. The importer used to import
 * only artwork a map thing, HUD element or weapon referenced, so a spawned-only
 * actor — a mod's fireball, a summon, a custom monster's projectile — had no
 * frames to draw at all.
 */
export function importActorSprites(project, assets, warnings) {
  if (!assets?.spriteFrame) return 0;
  const wanted = new Map();
  const want = actor => {
    for (const [prefix, letters] of actorSpriteCells(actor)) {
      if (!wanted.has(prefix)) wanted.set(prefix, new Set());
      for (const letter of letters) wanted.get(prefix).add(letter);
    }
  };
  for (const actor of usedActors(project)) want(actor);
  // Attacks name their projectile in a handler rather than in the actor data, so
  // every missile actor whose art exists is included too.
  for (const actor of project.actors || []) {
    const flags = actor.flags || {};
    if (flags.MISSILE || flags.PROJECTILE) want(actor);
  }
  // A missile's states spawn their trail and spray actors by name, so those frames
  // are needed even when nothing in the level places the missile.
  for (const actor of missileEffectActors(project)) want(actor);
  let imported = 0;
  const missing = new Set();
  for (const [prefix, letters] of wanted) {
    for (const letter of letters) {
      if (assets.spriteFrame(prefix, letter)) imported++;
      else if (missing.size < 12) missing.add(`${prefix}${letter}`);
    }
  }
  if (missing.size) warnings.push(`Actor state artwork missing from this game: ${[...missing].join(', ')}; those frames are skipped.`);
  return imported;
}

export function applyActorTranslations(project, assets, table, warnings) {
  const index = actorIndex(project.actors || []);
  const clipCache = new Map(), unresolved = new Set(), resolved = new Map();
  let placed = 0, clips = 0;
  const specsOf = actor => {
    if (resolved.has(actor.name)) return resolved.get(actor.name);
    let specs = translationSpecs(actor.translation);
    if (!specs.length && typeof actor.translation === 'number') {
      // A numeric translation indexes the game's table, one-based.
      specs = table.ordered[actor.translation - 1]?.specs || [];
    }
    if (!specs.length) specs = table.named.get(String(actor.translation).toLowerCase()) || [];
    if (!specs.length && !unresolved.has(actor.name)) {
      unresolved.add(actor.name);
      warnings.push(`Actor ${actor.name} uses translation ${JSON.stringify(actor.translation)}, which this game does not define; its sprites keep the original colours.`);
    }
    resolved.set(actor.name, specs);
    return specs;
  };
  const translateFrames = (frames, suffix, specs) => frames.map(assetId => assets.translate(assetId, suffix, specs) || assetId);

  // Placed things get their own clips, because the same sprite prefix may be used
  // by an untranslated actor.
  for (const entity of project.map.entities) {
    const actor = (entity.doomType !== undefined && index.byDoomed.get(entity.doomType)) ||
      (entity.actorName && index.byName.get(String(entity.actorName).toLowerCase())) || null;
    if (!actor?.translation) continue;
    const specs = specsOf(actor);
    if (!specs.length) continue;
    const suffix = translationSuffix(specs), spriteStates = {};
    for (const [state, clipId] of Object.entries(entity.spriteStates || {})) {
      const clip = project.spriteClips.find(candidate => candidate.id === clipId);
      if (!clip) continue;
      const key = `${clipId}\u0000${suffix}`;
      if (!clipCache.has(key)) {
        const id = `${clipId}_${suffix}`;
        if (!project.spriteClips.some(candidate => candidate.id === id)) {
          project.spriteClips.push({ ...clip, id, name: `${clip.name} / translated`.slice(0, 100),
            frames: translateFrames(clip.frames, suffix, specs) });
        }
        clipCache.set(key, id);
      }
      spriteStates[state] = clipCache.get(key);
    }
    if (Object.keys(spriteStates).length) entity.spriteStates = spriteStates;
    if (entity.spriteAsset) entity.spriteAsset = assets.translate(entity.spriteAsset, suffix, specs) || entity.spriteAsset;
    placed++;
  }

  // Spawned actors (projectiles, effects) never appear as things, so their clips
  // are translated in place: the clip already belongs to that one actor.
  for (const actor of project.actors || []) {
    if (!actor?.translation) continue;
    const specs = specsOf(actor);
    if (!specs.length) continue;
    const suffix = translationSuffix(specs);
    for (const kind of ['fly', 'impact']) {
      const clip = project.spriteClips.find(candidate => candidate.id === `clip_actor_${actor.id}_${kind}`);
      if (!clip) continue;
      clip.frames = translateFrames(clip.frames, suffix, specs);
      clips++;
    }
  }
  if (placed) warnings.push(`${placed} placed actor(s) have DECORATE/ZScript translations applied as translated sprite assets; edit them in the asset and sprite panels.`);
  if (clips) warnings.push(`${clips} spawned-actor animation(s) use translated sprites for actors that never appear as map things.`);
}

/**
 * `music` declared for one map in MAPINFO/ZMAPINFO, or null.
 *
 * Single-map imports show that map only, so they cannot rely on the whole-game route
 * table; reading the block here keeps a map that names its own track working.
 */
export function mapInfoMusic(wad, mapName) {
  const sources = wad.lumps.filter(lump => ['MAPINFO', 'ZMAPINFO'].includes(lump.name) && lump.size <= 1024 * 1024)
    .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)));
  if (!sources.length) return null;
  try {
    return parseLevelRoutes(sources).get(String(mapName).toUpperCase())?.music || null;
  } catch {
    return null;
  }
}

/**
 * `sky1` declared for one map in MAPINFO/ZMAPINFO, or null.
 *
 * A title map is usually built as an untextured shell around a sky, so without its declared
 * sky it renders as flat black. `mapInfoMusic` reads the same blocks; this is its twin.
 */
export function mapInfoSky(wad, mapName) {
  const sources = wad.lumps.filter(lump => ['MAPINFO', 'ZMAPINFO'].includes(lump.name) && lump.size <= 1024 * 1024)
    .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)));
  return skyFromSources(sources, mapName);
}

function skyFromSources(sources, mapName) {
  const texts = (sources || []).filter(source => typeof source === 'string' && source.length <= 1024 * 1024);
  if (!texts.length) return null;
  try {
    return parseLevelRoutes(texts).get(String(mapName).toUpperCase())?.sky || null;
  } catch {
    return null;
  }
}

export function readWad(buffer, { allowNoMaps = false } = {}) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw new Error('WAD header is truncated');
  if (buffer.byteLength > LIMITS.archiveBytes) {
    throw new Error(`WAD exceeds the ${LIMITS.archiveBytes / 1024 / 1024} MiB import limit`);
  }
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (!['IWAD', 'PWAD'].includes(doomName(bytes.subarray(0, 4)))) throw new Error('Not an IWAD or PWAD file');
  const count = view.getUint32(4, true), directory = view.getUint32(8, true);
  if (count > 100000 || directory < 12 || directory + count * 16 > buffer.byteLength) throw new Error('Invalid WAD directory');
  const lumps = [];
  for (let index = 0; index < count; index++) {
    const offset = directory + index * 16;
    const start = view.getUint32(offset, true), size = view.getUint32(offset + 4, true);
    if (start > buffer.byteLength || size > buffer.byteLength - start) throw new Error(`Lump ${index} is out of bounds`);
    lumps.push({ name: doomName(bytes.subarray(offset + 8, offset + 16)), start, size });
  }
  const maps = lumps.filter((lump, index) => mapPattern.test(lump.name) ||
    ['THINGS', 'TEXTMAP'].includes(lumps[index + 1]?.name) && lump.size === 0).map(lump => lump.name);
  if (!maps.length && !allowNoMaps) throw new Error('No classic Doom map markers found');
  return { buffer, lumps, maps: [...new Set(maps)] };
}

/**
 * What a placed actor is, from its own flags and the class it descends from.
 *
 * DECORATE and ZScript classes inherit their parents' flags, and the record keeps only the
 * ones a class states itself, so the chain is walked. A light or sector-action marker draws
 * nothing and reports `null`: placing a placeholder for it only buries the map in grey boxes.
 */
function actorRoleOf(actor, byName) {
  const chain = [], flags = {};
  for (let current = actor, depth = 0; current && depth < 12; depth++) {
    chain.push(current);
    for (const [flag, on] of Object.entries(current.flags || {})) if (on) flags[flag] = true;
    current = current.parent ? byName.get(String(current.parent).toLowerCase()) || null : null;
  }
  const names = new Set(chain.map(item => String(item.name).toLowerCase()));
  // Markers draw nothing. `TeleportDest`, `TeleportDest2`, `TeleportDest3` and `Waterzone` are
  // all markers, so a prefix match is what keeps a map's 24 teleport destinations from being
  // reported — and drawn — as twenty-four grey boxes in the sky.
  const marker = [...names].some(name => /^(sectoraction|dynamiclight|teleportdest|waterzone|mapspot|interpolationpoint|pathfollower|movingcamera)$/.test(name));
  if (marker || flags.INVISIBLE) return null;
  if (flags.MONSTER || (flags.COUNTKILL && (actor.health || 0) > 0)) return 'enemy';
  if (names.has('inventory') || names.has('pickup') || names.has('custominventory')) return 'pickup';
  return 'decoration';
}

export function importWadMap(wad, mapName, { encodeImage, images, sounds = new Map(), menuDefinitions = [], hudDefinitions = [], fontResources, episodeInfo, music, actorSources = [], dehacked = [], languageSources = [], sndInfoSources = [], acsLibraries = [], loadacs = [], translationSources = [], animDefsSources = [], actors = true, deferActionGaps = false, options = {} } = {}) {
  const start = wad.lumps.findLastIndex(lump => lump.name === mapName);
  if (start < 0) throw new Error('Map not found');
  const mapLumps = [];
  for (let index = start + 1; index < wad.lumps.length && !wad.maps.includes(wad.lumps[index].name); index++) mapLumps.push(wad.lumps[index]);
  const textMap = mapLumps.find(lump => lump.name === 'TEXTMAP');
  let source, data;
  if (textMap) {
    if (textMap.size > LIMITS.udmfTextBytes) throw new Error(`UDMF TEXTMAP exceeds ${LIMITS.udmfTextBytes / 1024 / 1024} MiB`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(wad.buffer, textMap.start, textMap.size));
    source = parseUDMF(text);
    data = udmfRecords(source);
  }
  // Exactly GZDoom's rule: a BEHAVIOR lump means the Hexen binary layout, where lines
  // and things carry argument bytes and 16/20 byte records. A map saved in that layout
  // without BEHAVIOR is read as Doom format, which is what GZDoom does as well (the
  // record sizes alone are ambiguous: 112 bytes is 8 Doom or 7 Hexen lines).
  const hexen = !data && mapLumps.some(lump => lump.name === 'BEHAVIOR');
  function records(lumpName, recordSize) {
    const lump = mapLumps.find(item => item.name === lumpName);
    if (!lump || lump.size % recordSize !== 0) throw new Error(`Missing or malformed ${lumpName}`);
    const limits = { VERTEXES: LIMITS.vertices, LINEDEFS: LIMITS.walls, SIDEDEFS: LIMITS.sidedefs,
      SECTORS: LIMITS.sectors, THINGS: LIMITS.entities };
    if (lump.size / recordSize > limits[lumpName]) throw new Error(`${lumpName} exceeds the import record limit`);
    return Array.from({ length: lump.size / recordSize }, (_, index) => new DataView(wad.buffer, lump.start + index * recordSize, recordSize));
  }
  const lumpText = (view, offset) => doomName(new Uint8Array(view.buffer, view.byteOffset + offset, 8));
  // Hexen's line activation is a three-bit index into the SPAC bits, stored in the
  // middle of the flags word; GZDoom turns `1 << index` into its activation mask.
  const HEXEN_ACTIVATION = [['cross'], ['use'], ['cross'], ['shoot'], ['use'], ['shoot'], ['use'], ['shoot']];
  if (hexen) data = {
    vertices: records('VERTEXES', 4).map(view => ({ x: view.getInt16(0, true), y: view.getInt16(2, true) })),
    // Sectors are the classic 26 byte record in both binary formats.
    sectors: records('SECTORS', 26).map(view => ({ floorHeight: view.getInt16(0, true), ceilingHeight: view.getInt16(2, true),
      floor: lumpText(view, 4), ceiling: lumpText(view, 12), light: view.getInt16(20, true),
      special: view.getUint16(22, true), tag: view.getUint16(24, true) })),
    sides: records('SIDEDEFS', 30).map(view => ({ sector: view.getUint16(28, true), offsetX: view.getInt16(0, true),
      offsetY: view.getInt16(2, true), upper: lumpText(view, 4), lower: lumpText(view, 12), middle: lumpText(view, 20) })),
    lines: records('LINEDEFS', 16).map(view => {
      const flags = view.getUint16(4, true);
      return { a: view.getUint16(0, true), b: view.getUint16(2, true), flags,
        special: view.getUint8(6), args: Array.from({ length: 5 }, (unused, index) => view.getUint8(7 + index)),
        right: view.getUint16(12, true) === 65535 ? -1 : view.getUint16(12, true),
        left: view.getUint16(14, true) === 65535 ? -1 : view.getUint16(14, true),
        tag: view.getUint8(7), activationModes: HEXEN_ACTIVATION[(flags & 0x1c00) >> 10] || [] };
    }),
    things: records('THINGS', 20).map(view => ({ tid: view.getInt16(0, true), x: view.getInt16(2, true), y: view.getInt16(4, true),
      elevation: view.getInt16(6, true), angle: view.getInt16(8, true), type: view.getUint16(10, true),
      flags: view.getUint16(12, true), special: view.getUint8(14),
      args: Array.from({ length: 5 }, (unused, index) => view.getUint8(15 + index)) })),
  };
  if (!data) data = {
    vertices: records('VERTEXES', 4).map(view => ({ x: view.getInt16(0, true), y: view.getInt16(2, true) })),
    sectors: records('SECTORS', 26).map(view => ({ floorHeight: view.getInt16(0, true), ceilingHeight: view.getInt16(2, true),
      floor: lumpText(view, 4), ceiling: lumpText(view, 12), light: view.getInt16(20, true),
      special: view.getUint16(22, true), tag: view.getUint16(24, true) })),
    sides: records('SIDEDEFS', 30).map(view => ({ sector: view.getUint16(28, true), offsetX: view.getInt16(0, true),
      offsetY: view.getInt16(2, true), upper: lumpText(view, 4), lower: lumpText(view, 12), middle: lumpText(view, 20) })),
    lines: records('LINEDEFS', 14).map(view => ({ a: view.getUint16(0, true), b: view.getUint16(2, true),
      right: view.getUint16(10, true) === 65535 ? -1 : view.getUint16(10, true),
      left: view.getUint16(12, true) === 65535 ? -1 : view.getUint16(12, true), flags: view.getUint16(4, true),
      special: view.getUint16(6, true), tag: view.getUint16(8, true) })),
    things: records('THINGS', 10).map(view => ({ type: view.getUint16(6, true), flags: view.getUint16(8, true),
      x: view.getInt16(0, true), y: view.getInt16(2, true), angle: view.getInt16(4, true), elevation: 0 })),
  };
  const { vertices, lines, sides, sectors, things } = data;
  // UDMF and Hexen-format lines both carry a Hexen special number with five args and
  // their own activation types, which the runtime executes from the special table.
  const zdoomFormat = Boolean(source) || hexen;
  // A mod-only WAD has no palette of its own; its geometry, actors and sounds still
  // import and the artwork it cannot decode is reported instead of failing the import.
  const assets = encodeImage ? createDoomAssets(wad, encodeImage, images, fontResources,
    { requirePalette: false, animationSources: animDefsSources }) : null;
  // An animated surface needs every frame, and a map usually references only the first one:
  // `TEALW1 Range TEALW4` puts three textures in the pack that nothing places. They are loaded
  // here, the way an actor's own state frames are, so the animation has frames to show.
  if (assets) importSurfaceAnimationFrames(assets, animDefsSources, wad);
  // ACS: the compiled BEHAVIOR lump is executed natively at Doom's 35 Hz, together
  // with every LOADACS library the game ships.
  const behaviorLump = mapLumps.find(lump => lump.name === 'BEHAVIOR');
  const scriptWarnings = [];
  let mapScriptInfo = null;
  const local = acsLibrariesFromWad(wad);
  const selection = selectAcsLibraries([...loadacs, ...local.lists], [...acsLibraries, ...local.libraries]);
  const libraries = selection.libraries;
  if (behaviorLump || libraries.length) {
    if (behaviorLump && behaviorLump.size > LIMITS.scriptBytes) {
      throw new Error(`BEHAVIOR lump exceeds the ${LIMITS.scriptBytes / 1024 / 1024} MiB script limit`);
    }
    try {
      mapScriptInfo = describeMapScripts(behaviorLump
        ? new Uint8Array(wad.buffer, behaviorLump.start, behaviorLump.size) : null, libraries);
    } catch (error) {
      scriptWarnings.push(`This map's ACS module could not be read (${error.message}); its lines are imported without script execution.`);
    }
    if (selection.missing.length) {
      scriptWarnings.push(`LOADACS lists ACS librar${selection.missing.length === 1 ? 'y' : 'ies'} that this package does not contain: ${selection.missing.join(', ')}.`);
    }
    if (libraries.length) {
      scriptWarnings.push(`ACS libraries loaded in LOADACS order: ${libraries.map(library => library.name).join(', ')}. Their scripts, strings and map variables are separate from the map's own module.`);
    }
    if (mapScriptInfo?.missingLibraries?.length) {
      scriptWarnings.push(`ACS libraries with an unmet dependency: ${mapScriptInfo.missingLibraries.join('; ')}. Calls into the missing library stop with a named error, as in GZDoom.`);
    }
  }

  const material = (name, kind) => assets?.get(name, kind) || null;
  const project = createProject();
  project.title = `${mapName} - imported WAD`;
  if (source) project.importSource = { format: 'udmf', mapName, ...source };
  else if (hexen) project.importSource = { format: 'hexen', mapName };
  project.map.vertices = vertices.map((vertex, index) => ({ id: `v${index}`, x: vertex.x, y: -vertex.y }));
  project.map.sectors = sectors.map((record, index) => {
    const { floor, ceiling } = record;
    return {
      id: `sector${index}`, floorHeight: record.floorHeight, ceilingHeight: record.ceilingHeight,
      floorAsset: material(floor, 'flat'), ceilingAsset: ceiling === 'F_SKY1' ? null : material(ceiling, 'flat'),
      sky: ceiling === 'F_SKY1', light: Math.max(0, Math.min(255, record.light)),
      special: record.special, tag: record.tag,
      ...(record.textureScale ? { textureScale: record.textureScale } : {}),
    };
  });
  function side(index) {
    if (index === -1) return null;
    if (index < 0 || index >= sides.length) throw new Error('Linedef references an invalid sidedef');
    const record = sides[index], sector = record.sector;
    if (sector < 0 || sector >= sectors.length) throw new Error('Sidedef references an invalid sector');
    return {
      sectorId: `sector${sector}`, offsetX: record.offsetX, offsetY: record.offsetY,
      upper: material(record.upper, 'texture'), lower: material(record.lower, 'texture'),
      middle: material(record.middle, 'texture'),
      ...(record.textureScale ? { textureScale: record.textureScale } : {}),
    };
  }
  project.map.walls = lines.map((record, index) => {
    const { a, b } = record;
    if (a < 0 || b < 0 || a >= vertices.length || b >= vertices.length) throw new Error('Linedef references an invalid vertex');
    const right = side(record.right), left = side(record.left);
    const sector = project.map.sectors.find(sector => sector.id === (right || left)?.sectorId);
    return {
      id: `w${index}`, a: `v${a}`, b: `v${b}`, right, left, flags: record.flags,
      special: record.special || 0, tag: record.tag || 0, ...(zdoomFormat ? { specialFormat: 'zdoom', args: record.args,
        ...(record.activationModes?.length ? { activationModes: [...new Set(record.activationModes)] } : {}) } : {}),
      color: '#9aa3ab', height: sector ? Math.max(8, Math.min(4096, sector.ceilingHeight - sector.floorHeight)) : 128,
      solid: !left || !right || Boolean(record.flags & 1),
    };
  }).filter(wall => {
    const a = project.map.vertices[Number(wall.a.slice(1))], b = project.map.vertices[Number(wall.b.slice(1))];
    return a.x !== b.x || a.y !== b.y;
  });
  // A `Sector_Set3DFloor` line is geometry the map is built from, so it is resolved here,
  // before anything looks at the sectors, and the line stops being a special.
  const threeDFloors = applyThreeDFloors(project.map);
  // The actor table is read before the things are mapped: a mod's own editor numbers say
  // what each thing is and which sprite draws it, which is the difference between a mod's
  // decorations and a screen of grey placeholder boxes.
  const dehackedSources = [...dehacked];
  for (const lump of wad.lumps) {
    if (lump.name !== 'DEHACKED' || lump.size > 4 * 1024 * 1024) continue;
    dehackedSources.push({ name: 'DEHACKED', text: new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)) });
  }
  for (const lump of wad.lumps) {
    if (!['DECORATE', 'ZSCRIPT', 'MAPINFO', 'ZMAPINFO'].includes(lump.name) || lump.size > 4 * 1024 * 1024) continue;
    actorSources.push({ name: lump.name, text: new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)) });
  }
  const actorWarnings = [];
  if (actors) project.actors = importActors({ sources: actorSources, dehacked: dehackedSources, warnings: actorWarnings }).actors;
  const actorNumbers = actorIndex(project.actors || []);

  let playerFound = false, unknownThings = 0, invisibleThings = 0, lightCount = 0;
  project.map.entities = things.flatMap((record, index) => {
    const { type, flags } = record;
    // Bit 0x10 is "not in single player" in a Doom map and "dormant" in a Hexen one,
    // where the single/coop/deathmatch presence lives in the 0x100..0x400 bits.
    const multiplayerOnly = hexen ? Boolean(flags & 0x700) && !(flags & 0x100) : Boolean(flags & 16);
    if (type !== 1 && (!(flags & 7) || multiplayerOnly || [2, 3, 4, 11].includes(type))) return [];
    const isPlayer = type === 1 && !playerFound;
    if (type === 1 && playerFound) return [];
    if (isPlayer) playerFound = true;
    const mapping = doomThings[type];
    // A mod's things carry their identity in its actor table, not in the classic table: the
    // editor number names the class, which names the sprite and the flags. That is also how a
    // replaced vanilla monster gets its replacement's artwork instead of the original's.
    const actor = !isPlayer ? actorNumbers.byDoomed.get(type) || null : null;
    const prefix = actor?.spritePrefixes?.find(name => !/^TNT1$/i.test(name)) || null;
    const artwork = mapping?.[0] || prefix;
    const spriteAsset = !isPlayer && artwork ? assets?.sprite(artwork) || null : null;
    const role = actor ? actorRoleOf(actor, actorNumbers.byName) : null;
    // A class that says nothing about its role is a decoration, and the classic table still
    // knows more than that: a lamp is a light whoever defines its class.
    const classic = mapping?.[1] || null;
    const kind = role === 'decoration' && classic ? classic : role || classic || 'decoration';
    if (!isPlayer && !mapping && !actor) unknownThings++;
    // An actor that draws nothing is not a thing the mapper can see: GZDoom's light and
    // sector-action markers are marked invisible, and drawing a placeholder for each one
    // buried a map under grey rectangles.
    if (!isPlayer && actor && !prefix && !role) { invisibleThings++; return []; }
    const entity = {
      id: `thing${index}`, name: isPlayer ? 'Player start' : actor?.name || `${mapping?.[0] || 'Doom thing'} ${type}`,
      type: isPlayer ? 'player' : kind, doomType: type,
      x: record.x, y: -record.y, angle: -record.angle, spriteAsset,
      ...(zdoomFormat ? { elevation: record.elevation, ...(record.tid ? { tid: record.tid } : {}) } : {}),
      // A resized thing is resized: a prop scaled to 0.6 in the map is drawn at 0.6, not full
      // size. Uniform scaling uses the single field the editor exposes; unequal X and Y keep
      // both, because a squashed lamp is not the lamp.
      ...thingScale(record),
      ...(hexen && flags & 0x10 ? { dormant: true } : {}),
      ...(kind === 'enemy' ? { ambush: Boolean(flags & 8) } : {}),
      ...(actor ? { actorId: actor.id, actorName: actor.name, ...(kind === 'enemy' && actor.health > 0 ? { health: actor.health } : {}) } : {}),
      ...(!isPlayer ? { skillMask: flags & 7 } : {}),
    };
    if (entity.type === 'light' && lightCount++ < 16) entity.light = { color: '#ffbd72', intensity: 1, radius: 192 };
    return [entity];
  });
  if (!playerFound) throw new Error('Map has no player-one start');
  const warnings = [
    'Imported monsters and weapons run their own DECORATE/ZScript state machines (or classic Doom actor data) with their real stats, flags, sounds and action functions; the actor table is editable under Actors and through MCP actor tools. Input, HUD, doors/lifts and campaign flow stay editable Engine rules.',
    'Eight-way sprite views, mirrored patches, gunfire wake-up and directional chase are imported. Action functions without an engine equivalent are reported by name instead of silently ignored. ACS map scripts run natively; ACS source-level features outside the compiled script module (custom ZScript functions) are not executed.',
    'Single-player skill flags are retained; New Game difficulty selects placement at runtime. Unknown thing types appear as colored placeholders.',
  ];
  warnings.push(...scriptWarnings, ...actorWarnings);
  if (source) {
    warnings.push(`UDMF ${source.namespace} geometry imported natively. Original global/block properties are retained in importSource as an import snapshot, not live gameplay state. Later visual edits change native map data, not that snapshot.`);
    if (sectors.some(sector => sector.light < 0 || sector.light > 255)) warnings.push('UDMF lightlevel values outside 0-255 are clamped for the current renderer; original values are preserved in importSource.');
    const unsupported = new Set();
    const supported = {
      vertex: ['x', 'y'], linedef: ['v1', 'v2', 'sidefront', 'sideback', 'blocking', 'blockplayers', 'blockeverything', 'dontpegtop', 'dontpegbottom', 'twosided'],
      sidedef: ['sector', 'offsetx', 'offsety', 'texturetop', 'texturebottom', 'texturemiddle'],
      sector: ['heightfloor', 'heightceiling', 'texturefloor', 'textureceiling', 'lightlevel'],
      thing: ['x', 'y', 'angle', 'height', 'type', 'skill1', 'skill2', 'skill3', 'skill4', 'skill5', 'single', 'coop', 'dm'],
    };
    for (const block of source.blocks) for (const key of Object.keys(block.properties)) {
      if (!supported[block.type]?.includes(key)) unsupported.add(`${block.type}.${key}`);
    }
    if (unsupported.size) warnings.push(`UDMF properties preserved but not simulated/rendered: ${[...unsupported].sort().join(', ')}. Slopes, per-surface transforms and custom actor behavior require further native compatibility work.`);
    if (mapLumps.some(lump => lump.name === 'SCRIPTS')) warnings.push('This UDMF map ships ACS source (SCRIPTS); the compiled BEHAVIOR lump is what runs.');
    if (mapLumps.some(lump => lump.name === 'DIALOGUE')) warnings.push('This map ships a DIALOGUE lump; NPC conversations are imported as data but not played yet.');
  }
  if (hexen) {
    warnings.push('Hexen-format map imported natively: linedef specials run from the Hexen/ZDoom special table with their five arguments and activation types, and things keep their tag (tid), spawn height and dormant flag. Sector arguments are not stored in this format; scripts read them through ACS GetSectorSpecial/args.');
  }
  for (const sector of project.map.sectors) {
    const boundaries = project.map.walls.filter(wall => wall.right?.sectorId !== wall.left?.sectorId &&
      (wall.right?.sectorId === sector.id || wall.left?.sectorId === sector.id));
    const directed = new Set(), balance = new Map();
    for (const wall of boundaries) {
      const forward = wall.right?.sectorId === sector.id;
      const a = project.map.vertices[Number((forward ? wall.a : wall.b).slice(1))];
      const b = project.map.vertices[Number((forward ? wall.b : wall.a).slice(1))];
      const from = `${a.x},${a.y}`, to = `${b.x},${b.y}`, key = `${from}/${to}`;
      if (directed.has(key)) continue;
      directed.add(key);
      balance.set(from, (balance.get(from) || 0) + 1);
      balance.set(to, (balance.get(to) || 0) - 1);
    }
    if (boundaries.length > 0 && (directed.size < 3 || [...balance.values()].some(value => value !== 0))) {
      sector.wallsOnly = true;
      warnings.push(`${sector.id} has an open or non-polygon boundary (${boundaries.length} lines); retained its walls and metadata but omitted floor/ceiling surfaces.`);
    }
  }
  if (assets) {
    // The level table is already parsed for a full game, so its sources carry the sky too.
    const declaredSky = options.sky || skyFromSources(episodeInfo?.sources?.map(item => item.source ?? item), mapName)
      || (episodeInfo ? null : mapInfoSky(wad, mapName));
    const mapNumber = Number(mapName.match(/\d+$/)?.[0] || 1);
    // A map's own `sky1` wins over the SKY1/SKY2/SKY3 convention, which only describes
    // vanilla maps and leaves a title map with no sky at all.
    const skyName = declaredSky && assets.has(declaredSky) ? declaredSky
      : mapName.startsWith('MAP') ? `SKY${mapNumber <= 11 ? 1 : mapNumber <= 20 ? 2 : 3}` : `SKY${mapName[1]}`;
    if (assets.has(skyName)) { project.environment.skyAsset = assets.get(skyName, 'sky'); project.environment.skyMode = 'doom'; }
    // A script can ChangeSky to another classic sky mid-level, so all of them are
    // imported as editable image assets, not only the one this map starts with.
    for (const name of assets.skyTextures()) assets.get(name, 'sky');
    for (const prefix of ['PUNG', 'PISG', 'SHTG', 'SHT2', 'CHGG', 'MISG', 'PLSG', 'BFGG', 'SAWG']) assets.sprite(prefix, 'weapon');
    project.environment.weaponAsset = assets.assets.find(asset => asset.name.startsWith('PISG'))?.id || null;
    project.assets = assets.assets;
  } else warnings.push('No image encoder supplied: imported geometry and sector lighting only, without textures or sprites.');
  if (unknownThings) warnings.push(`${unknownThings} unmapped things use placeholders.`);
  if (invisibleThings) warnings.push(`${invisibleThings} marker things that draw nothing (dynamic lights, sector actions, teleport destinations) were not placed; their effect comes from the sector and line specials that use them.`);
  if (lightCount > 16) warnings.push(`${lightCount} lamp sprites imported; only the first 16 emit added point light. Sector lighting is preserved throughout.`);
  project.events = [];
  for (const [name, src] of sounds) {
    const existing = project.assets?.find(asset => asset.kind === 'sound' && asset.name === name);
    if (existing) existing.src = src;
    else {
      project.assets ||= [];
      project.assets.push({ id: `package_sound_${project.assets.length}`, name, kind: 'sound', src });
    }
  }
  // Actor definitions: the map's own game may ship DECORATE/ZScript (from a
  // package) and a DEHACKED lump (nearly every WAD does). They are compiled into
  // native actor records before the engine starter so generated rules know
  // whether real state machines exist.
  // LANGUAGE keyword strings: menus, level names and pickup messages reference
  // them by keyword, so the table is kept for the editor and the runtime.
  const languageTexts = [...languageSources].map(source => typeof source === 'string' ? source : source.text);
  for (const lump of wad.lumps) {
    if (!/^LANGUAGE/i.test(lump.name) || lump.size > 2 * 1024 * 1024) continue;
    languageTexts.push(new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)));
  }
  if (languageTexts.length) {
    project.strings = buildStringTable(languageTexts);
    if (!Object.keys(project.strings).length) delete project.strings;
  }
  // Sound names in DECORATE/ZScript states are logical (`grunt/sight`), so the
  // SNDINFO table is compiled once into the project and resolves at playback.
  const sndInfoTexts = [...sndInfoSources].map(source => typeof source === 'string' ? source : source.text);
  for (const lump of wad.lumps) {
    if (!/^SNDINFO$/i.test(lump.name) || lump.size > 2 * 1024 * 1024) continue;
    sndInfoTexts.push(new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)));
  }
  if (sndInfoTexts.length) {
    project.soundAliases = soundTable(VANILLA_SOUNDS, ...sndInfoTexts.map(parseSndInfo));
    if (!Object.keys(project.soundAliases.aliases).length) delete project.soundAliases;
  }
  if (mapScriptInfo) {
    project.mapScripts = mapScriptInfo.mapScripts;
    const kinds = mapScriptInfo.summary.kinds;
    const named = (kinds.closed || 0) + (kinds.open || 0) + (kinds.enter || 0);
    const moduleNames = mapScriptInfo.summary.modules.map(module => module.name);
    warnings.push(`ACS: ${mapScriptInfo.summary.scripts} script(s) (${kinds.open || 0} open, ${kinds.enter || 0} enter, ${kinds.closed || 0} line-triggered) run natively at 35 Hz with ${mapScriptInfo.summary.strings} string(s) across ${moduleNames.length} module(s) (${moduleNames.join(', ')}); ${named} named or numbered entries are listed in the Scripts tab.`);
    if (mapScriptInfo.unsupportedOpcodes.length) {
      warnings.push(`ACS instructions the native interpreter does not implement: ${mapScriptInfo.unsupportedOpcodes.join(', ')}. Scripts that reach them stop and report instead of hanging.`);
    }
  }
  // UDMF and Hexen lines carry Hexen numbers the line-special table runs directly;
  // binary Doom lines use Doom's own numbering and become engine rules below, so
  // the two are reported against their own tables.
  const scriptedSpecials = new Set(mapScriptInfo?.specials || []);
  for (const wall of project.map.walls) if (wall.specialFormat === 'zdoom' && wall.special) scriptedSpecials.add(wall.special);
  // Camera textures: ANIMDEFS reserves a surface no image backs, and a script
  // points it at a camera thing at run time.
  const cameraSources = [
    ...animDefsSources.map(source => (typeof source === 'string' ? source : source.text)),
    ...wad.lumps.filter(lump => lump.name === 'ANIMDEFS' && lump.size <= 1024 * 1024)
      .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size))),
  ];
  const cameraTextures = parseCameraTextures(cameraSources);
  if (cameraTextures.length) {
    if (cameraTextures.length > 32) throw new Error('Level declares more than 32 camera textures');
    project.cameraTextures = cameraTextures;
    if (assets) {
      for (const definition of cameraTextures) {
        if (!assets.has(definition.name)) assets.cameraTexture(definition.name, definition.width, definition.height);
      }
    }
    warnings.push(`${cameraTextures.length} camera texture(s) declared (${cameraTextures.map(definition => `${definition.name} ${definition.width}x${definition.height}`).join(', ')}); they show a live view once a script binds a camera with SetCameraToTexture.`);
  }
  const missingSpecials = unsupportedSpecials([...scriptedSpecials]);
  if (missingSpecials.length) {
    warnings.push(`Line specials kept as data but not performed by the native runtime: ${missingSpecials.join(', ')}.`);
  }
  installEngineScripts(project, { includeHUD: false });
  // Classic Doom numbers are translated into rules, so their report comes from the
  // translator itself (it knows which ones it could not perform).
  installWorldScripts(project, warnings);
  const generatedSounds = project.assets.filter(asset => asset.kind === 'sound' && asset.generated).length;
  if (generatedSounds) warnings.push(`${generatedSounds} missing standard combat sounds use generated OpenDLE fallback effects, editable as sound assets.`);
  const hudSource = lump => {
    if (lump.size > 1024 * 1024) throw new Error(`Interface resource ${lump.name} exceeds 1 MiB`);
    return { name: `WAD:${lump.name}`, source: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(wad.buffer, lump.start, lump.size)) };
  };
  const resolveHUD = name => {
    const lump = wad.lumps.findLast(lump => lump.name === name.toUpperCase());
    return lump ? hudSource(lump) : null;
  };
  const wadHUD = wad.lumps.filter(lump => lump.name === 'SBARINFO').map(lump => ({ ...hudSource(lump), resolve: resolveHUD }));
  const customHUD = [...wadHUD, ...hudDefinitions];
  if (assets) {
    if (!importSBarInfo(project, assets, customHUD, warnings)) importDoomHUD(project, assets);
  } else {
    if (customHUD.length) warnings.push('Custom SBARINFO HUD was not imported: no image encoder supplied.');
    installDefaultHUD(project);
  }
  installDoomInventoryScripts(project);
  if (assets && project.actors?.length) importActorSprites(project, assets, warnings);
  // A font name in a script is often a picture: GZDoom turns a name that is not a font
  // definition into a one-picture font, which is how Lullaby draws its title logo. Those
  // names live in the script's string table, so the artwork is loaded even though no map
  // surface, HUD element or menu references it.
  if (assets && mapScriptInfo?.program) importScriptPictureFonts(assets, mapScriptInfo.program);
  if (assets) installSpriteAnimations(project, assets);
  // Actor states are authoritative: a mod's own frame letters replace the classic
  // letter guesses for every placed thing that has an actor record.
  if (project.actors?.length) {
    const repainted = installActorSpriteStates(project);
    if (repainted) warnings.push(`${repainted} placed actor(s) animate from their own state frames instead of the classic letter tables.`);
  }
  if (assets && project.actors?.length) installActorProjectileSprites(project);
  if (assets) {
    // Actor translations repaint sprites, so they run after the animation clips
    // exist and can point at translated frames.
    const table = parseTranslationTable([
      ...translationSources.map(source => (typeof source === 'string' ? source : source.text)),
      ...wad.lumps.filter(lump => ['TRANSLATION', 'TRNSLATE'].includes(lump.name) && lump.size <= 1024 * 1024)
        .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size))),
    ]);
    applyActorTranslations(project, assets, table, warnings);
  }
  const definitions = wad.lumps.filter(lump => lump.name === 'MENUDEF').map(lump => ({
    ...hudSource(lump), resolve: resolveHUD,
  }));
  installGameMenu(project, assets, [...definitions, ...menuDefinitions], warnings, episodeInfo);
  // A single-map import has no MAPINFO routing of its own, so read the map's own
  // music declaration here; the full game assembles routes for every level instead.
  const declaredMusic = music || (episodeInfo ? null : mapInfoMusic(wad, mapName));
  const musicTrack = resolveMusicAsset(project.assets, mapName, declaredMusic);
  if (musicTrack.asset) project.environment = { ...project.environment, music: musicTrack.asset.name, musicAsset: musicTrack.asset.id };
  if (assets) warnings.push(musicReport(mapName, musicTrack));
  warnings.push('Menus are editable HUD/events. MENUDEF support is partial: custom menu classes, arbitrary CVARs/commands and exact Nightmare respawn/fast states are not translated yet. Native browser save slots do not interoperate with GZDoom .zds saves. Full-game imports support native level selection and supported exits; scripted campaign behavior is not executed.');
  if (assets) warnings.push(...assets.warnings);
  // A 3D floor is drawn from its control sector's planes. Clipping the sector's own
  // planes away from it needs a stencil pass this renderer does not have yet, and a
  // translucent 3D floor is drawn opaque, so say so where the map actually uses one.
  const transparentFloors = threeDFloors.filter(floor => floor.floor.alpha < 255).length;
  const nonSolidFloors = threeDFloors.filter(floor => !floor.floor.solid).length;
  if (transparentFloors) warnings.push(`${transparentFloors} translucent 3D floor(s) are drawn opaque; translucency is not applied to 3D floor surfaces yet.`);
  if (nonSolidFloors) warnings.push(`${nonSolidFloors} 3D floor(s) are non-solid in the map: they are drawn as surfaces, but nothing stands on them.`);
  const unsupported = [...new Set(project.map.entities.filter(entity => entity.type === 'pickup' &&
    [2022, 2023, 2024, 2025, 2026, 2045].includes(entity.doomType)).map(entity => entity.doomType))];
  if (unsupported.length) warnings.push(`Power-up effects are not imported for Doom thing types ${unsupported.join(', ')}; these objects remain visible until scripted.`);
  // Actor action functions this runtime has no implementation for are skipped at
  // the frame that calls them, so the gap belongs in the import report.
  const actionGaps = unsupportedActorActions(project);
  // A game import reports the union once instead of repeating this per level.
  if (actionGaps.length && !deferActionGaps) warnings.push(describeActorActionGaps(actionGaps));
  validateProject(project, { gameLevelIds: episodeInfo?.levelIds ? new Set(episodeInfo.levelIds) : undefined });
  return { project, warnings, ...(actionGaps.length ? { actionGaps } : {}) };
}
