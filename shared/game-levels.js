import { LIMITS } from './limits.js';
import { cloneProjectForEdit } from './project.js';
import { resolveMusicAsset, musicReport } from './music.js';
import { resolveString } from './language.js';
import { engineCommand } from './engine-script.js';
import { spriteAssetNames } from './sprite-animation.js';

// `actors` describes the game as a whole (monster and weapon state machines),
// so it is stored once instead of being duplicated into every level.
// What belongs to the game rather than to one map. Addons are here because an addon adds *commands*:
// one level cannot have a vocabulary the next one lacks, or a rule would stop resolving the moment
// the author looked at another map. Its artwork already went into the shared asset list.
const sharedKeys = new Set(['version', 'title', 'assets', 'game', 'actors', 'strings', 'soundAliases', 'addons']);

/**
 * Point a level's environment at its music asset. MAPINFO `music` wins, then the
 * `D_<map name>` lump, then the classic Doom/Doom II tables. A level that declares
 * nothing while the WAD ships a soundtrack gets a reported placeholder instead of
 * silence, so an unplayable level name never hides the music that was imported.
 */
export function applyLevelMusic(data, levelId, explicit, assets, warnings) {
  const resolution = resolveMusicAsset(assets, levelId, explicit);
  if (!resolution.asset) {
    warnings?.add(musicReport(levelId, resolution));
    return data;
  }
  data.environment = { ...(data.environment || {}), music: resolution.asset.name, musicAsset: resolution.asset.id };
  // Conventional choices stay quiet; only a guess or a WAD without music is worth a line.
  if (resolution.reason === 'placeholder') warnings?.add(musicReport(levelId, resolution));
  return data;
}

export function levelData(project) {
  return Object.fromEntries(Object.entries(project).filter(([key]) => !sharedKeys.has(key)));
}

export function gameLevelAssetIds(project) {
  const references = new Set();
  function visit(value) {
    if (typeof value === 'string') references.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(levelData(project));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  // Rotation tables can refer back to their base frame or to other tables.
  for (const id of references) visit(assets.get(id)?.rotations);
  // Sprite clips belong to the game as a whole, and a projectile's artwork is only
  // ever referenced from its clip, so the frames travel with every level.
  for (const clip of project.spriteClips || []) for (const id of clip.frames || []) references.add(id);
  for (const mapping of project.materialAnimations || []) {
    references.add(mapping.assetId);
  }
  // A weapon is drawn from its own state frames — the gun's `Ready`/`Fire`/`Select` pictures and
  // its `Flash` muzzle bloom — and no clip names them, so they have to travel with every level the
  // same way a clip's frames do: without them the first shot throws
  // "Preview image PISFA0 was not loaded".
  const spriteNames = spriteAssetNames(project);
  const everyFrame = actor => {
    for (const frame of actor?.states?.frames || []) {
      if (frame.kind !== 'frame' || !frame.sprite) continue;
      const sprite = String(frame.sprite).toUpperCase();
      const id = spriteNames.get(`${sprite}${frame.letter}0`) || spriteNames.get(`${sprite}${frame.letter}1`);
      if (id) references.add(id);
    }
  };
  for (const actor of project.actors || []) if (actor?.flags?.WEAPON) everyFrame(actor);
  // A monster leaves items the level may never place — Doom's zombieman drops his clip wherever
  // he dies — so their pictures have to travel too. Without this the first drop threw
  // "Preview image CLIPA0 was not loaded" and stopped the game.
  for (const actor of project.actors || []) {
    for (const drop of actor.drops || []) {
      if (!drop?.item) continue;
      const item = (project.actors || []).find(candidate => String(candidate.name).toLowerCase() === String(drop.item).toLowerCase());
      if (!item) continue;
      everyFrame(item);
      if (item.spawnFrame) everyFrame({ states: { frames: [item.spawnFrame] } });
    }
  }
  // Skies travel with every level: a script can ChangeSky to one no map thing names.
  return project.assets.filter(asset => ['sound', 'music', 'sky'].includes(asset.kind) || references.has(asset.id)).map(asset => asset.id);
}

/**
 * A copy of the project whose level can be switched without disturbing the undo snapshot.
 *
 * `cloneProjectForEdit(project, { deepGame: true })` copies every level's whole map, which on an
 * imported campaign is hundreds of megabytes and seconds of work — most of the pause a level
 * switch caused. Switching only needs the game *container* to be private (so `active` can change)
 * and the level being written to be private; `selectGameLevel` already clones the data it stores,
 * so a shallow copy of the level list is enough.
 */
export function cloneForLevelSwitch(project) {
  const next = cloneProjectForEdit(project, { shareActors: true });
  if (project.game) {
    next.game = { ...project.game, levels: project.game.levels.map(level => ({ ...level })) };
    next.assets = [...(project.assets || [])];
  }
  return next;
}

/**
 * The project with every level but one emptied, ready to be cloned for a preview.
 *
 * A preview plays one level at a time, but the clone it starts from carried all of an imported
 * campaign's maps: on the Furdoom import that is thirty-one maps of vertices, walls and things
 * copied only to be thrown away a moment later. The copy was a few hundred megabytes of garbage
 * that the browser then had to collect while the level ran, which is one of the stalls the
 * player saw right after loading. Only the level about to be played is kept.
 */
export function stripInactiveLevels(project, keepId) {
  if (!project.game) return project;
  const keep = keepId || project.game.active;
  return {
    ...project,
    game: {
      ...project.game,
      levels: project.game.levels.map(level => level.id === keep ? level : { ...level, data: {}, assetIds: [] }),
    },
  };
}

export function selectGameLevel(project, id) {
  const game = project.game;
  if (!game) throw new Error('This project contains only one level. Reimport the full game to select other levels.');
  const target = game.levels.find(level => level.id === id);
  if (!target) throw new Error(`Unknown game level: ${id}`);
  const current = game.levels.find(level => level.id === game.active);
  current.data = structuredClone(levelData(project));
  current.assetIds = gameLevelAssetIds(project);
  if (id === game.active) return project;
  for (const key of Object.keys(project)) if (!sharedKeys.has(key)) delete project[key];
  const data = structuredClone(target.data);
  // A level saved before addons were shared may still carry its own list; the project's is the one
  // that counts, so a stale copy cannot switch the catalogue out from under the rules.
  delete data.addons;
  Object.assign(project, data);
  game.active = id;
  return project;
}

export function nextGameLevel(game, secret = false) {
  const level = game?.levels.find(level => level.id === game.active);
  // Like G_GetSecretExitMap, a secret exit with no secret destination takes the normal one.
  return level ? (secret ? level.secretNext || level.next : level.next) || null : null;
}

function classicNext(id, secret) {
  const doom = /^MAP(\d\d)$/.exec(id);
  if (doom) {
    const n = Number(doom[1]);
    if (secret && n === 15) return 'MAP31';
    if (secret && n === 31) return 'MAP32';
    if (n === 31 || n === 32) return 'MAP16';
    return n === 30 ? null : `MAP${String(n + 1).padStart(2, '0')}`;
  }
  const episode = /^E([1-4])M([1-9])$/.exec(id);
  if (episode) {
    const e = Number(episode[1]), m = Number(episode[2]), afterSecret = [0, 4, 6, 7, 3][e];
    // A secret map's own exit rejoins the episode (doom1.txt: E1M9 → E1M4 … E4M9 → E4M3);
    // only a secret exit on a regular map leads to E*M9, and E*M8 ends the episode.
    if (m === 9) return `E${e}M${afterSecret}`;
    if (secret) return `E${e}M9`;
    return m === 8 ? null : `E${e}M${m + 1}`;
  }
  return undefined;
}

function remapLevelAssets(data, replacements, project) {
  const ref = id => replacements.get(id) || id;
  const fields = (value, keys) => {
    if (!value) return;
    for (const key of keys) if (typeof value[key] === 'string') value[key] = ref(value[key]);
  };
  const command = value => {
    if (!value) return;
    const keys = (engineCommand(value.type, project)?.fields || [])
      .filter(field => field.kind === 'image').map(field => field.name);
    if (value.type === 'playAssetSound') keys.push('assetId');
    fields(value, keys);
  };
  for (const holder of [data, ...(data.scenes || [])]) {
    for (const entity of holder.map?.entities || holder.entities || []) {
      fields(entity, ['spriteAsset', 'modelAsset']);
      fields(entity.sound, ['assetId']);
      fields(entity.projector, ['assetId']);
    }
    for (const event of holder.events || []) {
      command(event.condition);
      for (const condition of event.conditions || []) command(condition);
      for (const action of event.actions || []) command(action);
    }
    for (const sheet of holder.timesheets || [])
      for (const cue of sheet.cues || []) for (const action of cue.actions || []) command(action);
    for (const clip of holder.spriteClips || []) clip.frames = clip.frames.map(ref);
    for (const mapping of holder.materialAnimations || []) fields(mapping, ['assetId']);
  }
  for (const wall of data.map?.walls || []) {
    fields(wall, ['assetId']);
    for (const side of [wall.right, wall.left]) fields(side, ['upper', 'middle', 'lower']);
  }
  for (const sector of data.map?.sectors || []) fields(sector, ['floorAsset', 'ceilingAsset']);
  for (const item of [...(data.hud?.elements || []), ...(data.hud?.fonts || [])])
    fields(item, ['assetId', 'fillAssetId']);
  fields(data.environment, ['skyAsset', 'weaponAsset', 'musicAsset']);
  if (data.environment?.weaponAssets)
    for (const weapon of Object.keys(data.environment.weaponAssets)) data.environment.weaponAssets[weapon] = ref(data.environment.weaponAssets[weapon]);
  fields(data.environment?.skybox, ['px', 'nx', 'py', 'ny', 'pz', 'nz']);
  return data;
}

function assetSignature(asset, byId) {
  const { id, ...content } = asset;
  if (!asset.rotations?.length) return JSON.stringify(content);
  // Equal rotation IDs do not imply equal artwork in another map; include the reachable graph.
  const seen = new Set([id]), pending = [asset], related = [];
  for (let index = 0; index < pending.length; index++) for (const view of pending[index].rotations || []) {
    if (seen.has(view.assetId)) continue;
    seen.add(view.assetId);
    const target = byId.get(view.assetId);
    if (target) { pending.push(target); related.push(target); }
  }
  related.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([content, related]);
}

export function assembleGameLevels(entries, entryId, title, routes = new Map()) {
  const assets = [], byId = new Map(), byContent = new Map(), levels = [], warnings = new Set(), ids = new Set();
  let version, sharedActors = null, sharedStrings = null, sharedAddons = null, sharedSounds = null;
  const repeatedWarnings = new Set();
  for (const entry of entries) {
    if (levels.length >= LIMITS.levels) throw new Error(`A game must contain 1–${LIMITS.levels} levels`);
    if (ids.has(entry.id)) throw new Error(`Duplicate game level ${entry.id}`);
    ids.add(entry.id);
    const project = entry.project, replacements = new Map(), assetIds = [], added = [];
    const sourceAssets = new Map(project.assets.map(asset => [asset.id, asset]));
    version = project.version;
    // The actor table describes the whole game (monster and weapon state
    // machines), so it is taken from the first level that has one.
    if (!sharedActors && project.actors?.length) sharedActors = structuredClone(project.actors);
    if (!sharedStrings && project.strings) sharedStrings = { ...project.strings };
    if (!sharedAddons && project.addons?.length) sharedAddons = structuredClone(project.addons);
    if (!sharedSounds && project.soundAliases) sharedSounds = structuredClone(project.soundAliases);
    for (const asset of project.assets) {
      const originalId = asset.id;
      const signature = assetSignature(asset, sourceAssets), existing = byContent.get(signature);
      let id = existing;
      if (!id) {
        id = asset.id;
        let suffix = 0;
        while (byId.has(id)) id = `level_${levels.length}_${suffix++}_${originalId}`.slice(0, 80);
        const copy = structuredClone({ ...asset, id });
        assets.push(copy); added.push(copy); byId.set(id, copy);
        byContent.set(signature, id);
      }
      replacements.set(asset.id, id); assetIds.push(id);
    }
    for (const asset of added)
      for (const view of asset.rotations || []) view.assetId = replacements.get(view.assetId) || view.assetId;
    const route = routes.get(entry.id);
    const data = remapLevelAssets(structuredClone(levelData(project)), replacements, project);
    applyLevelMusic(data, entry.id, route?.music, assets, warnings);
    // The map's own lighting model travels with the level, the way its sky does: `lightmode = 2`
    // is Doom's crushed brightness curve, which is the difference between a dark room and black.
    if (route?.lightMode !== undefined) data.environment = { ...(data.environment || {}), lightMode: route.lightMode };
    // `sky1 = "NEBUSKY4", 0.1` makes the sky slide; the speed belongs to the level, so a
    // still sky is the absence of the value rather than a hard-coded default.
    if (route?.skyScroll !== undefined) data.environment = { ...(data.environment || {}), skyScroll: route.skyScroll };
    // MAPINFO names and LANGUAGE keywords (`$TXT_MAP1`) resolve against the
    // project string table so the level list shows real names.
    const rawName = route?.name || entry.name || entry.id;
    levels.push({ id: entry.id, name: resolveString(sharedStrings, rawName, rawName),
      assetIds: [...new Set(assetIds)], data });
    // A game-wide notice (menu support, screen-size notes, actor state machines) is
    // identical for every level; repeating it 32 times buried the real per-level
    // problems in the import report. Identical text is reported once.
    for (const warning of entry.warnings || []) {
      const first = !repeatedWarnings.has(warning);
      repeatedWarnings.add(warning);
      warnings.add(first ? `${entry.id}: ${warning}` : warning);
    }
  }
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i], route = routes.get(level.id);
    for (const [key, secret] of [['next', false], ['secretNext', true]]) {
      const specified = route && Object.hasOwn(route, key);
      const conventional = classicNext(level.id, secret);
      const target = specified ? route[key] : conventional;
      level[key] = ids.has(target) ? target : null;
      if (specified && target && !ids.has(target)) warnings.add(`${level.id}: destination ${target} is unavailable; the campaign ends at this exit.`);
    }
  }
  const active = levels.find(level => level.id === entryId);
  if (!active) throw new Error(`Missing game entry level ${entryId}`);
  const project = { version, title: title.slice(0, 100), assets,
    ...(sharedStrings ? { strings: sharedStrings } : {}), ...(sharedActors ? { actors: sharedActors } : {}),
    ...(sharedAddons ? { addons: sharedAddons } : {}),
    ...(sharedSounds ? { soundAliases: sharedSounds } : {}),
    ...structuredClone(active.data), game: { version: 1, entry: entryId, active: entryId, levels } };
  if (JSON.stringify(project).length > LIMITS.gameBytes) {
    throw new Error(`Imported game exceeds the ${LIMITS.gameBytes / 1024 / 1024} MiB portable project limit`);
  }
  return { project, warnings: [...warnings] };
}

// Read declarative routing only; custom MAPINFO script behavior is not executed.
export function parseLevelRoutes(sources) {
  const routes = new Map();
  for (const source of sources) {
    if (source.length > LIMITS.textBytes) throw new Error(`MAPINFO exceeds ${LIMITS.textBytes / 1024 / 1024} MiB`);
    const clean = source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, token =>
      token.startsWith('"') ? token : ' ');
    const map = /\bmap\s+("[^"]+"|[a-zA-Z0-9_-]+)\s*(?:"([^"]*)")?\s*\{/gi;
    let match;
    while ((match = map.exec(clean))) {
      let end = map.lastIndex, depth = 1;
      const tokens = /"(?:\\.|[^"\\])*"|[{}]/g; tokens.lastIndex = end;
      let token;
      while (depth && (token = tokens.exec(clean))) {
        if (token[0] === '{') depth++;
        if (token[0] === '}') depth--;
        end = tokens.lastIndex;
      }
      if (depth) throw new Error('Unterminated MAPINFO map block');
      const id = match[1].replaceAll('"', '').toUpperCase(), route = { ...routes.get(id) };
      if (match[2]) route.name = match[2];
      const body = clean.slice(map.lastIndex, end - 1);
      const fields = [];
      const assignments = /"(?:\\.|[^"\\])*"|\b(next|secretnext|music|sky1|lightmode)\s*=\s*("(?:\\.|[^"\\])*"|[a-zA-Z0-9_.-]+)(?:\s*,\s*(-?[\d.]+))?/gi;
      for (const field of body.matchAll(assignments)) if (field[1]) fields.push(field);
      // `lightmode` is a number, not a name, so it is read on its own: Doom's own lighting is
      // the difference between a dark room and a black one.
      const lightMode = fields.find(field => field[1].toLowerCase() === 'lightmode');
      if (lightMode && /^\d+$/.test(lightMode[2])) route.lightMode = Number(lightMode[2]);
      // `sky1 = "NEBUSKY4", 0.1` slides the sky sideways: the number is GZDoom's scroll speed,
      // and a title map that names one has a turning sky rather than a still picture.
      const skyScroll = fields.find(field => field[1].toLowerCase() === 'sky1' && field[3] !== undefined);
      if (skyScroll && Number.isFinite(Number(skyScroll[3]))) route.skyScroll = Number(skyScroll[3]);
      for (const field of fields) {
        if (field[1].toLowerCase() === 'lightmode') continue;
        const value = field[2].replaceAll('"', '').toUpperCase();
        const key = field[1].toLowerCase();
        if (key === 'music') { route.music = value; continue; }
        // A map can name its own sky; a title map usually has no SKY1 to fall back on.
        if (key === 'sky1') { route.sky = value; continue; }
        route[key === 'next' ? 'next' : 'secretNext'] = /^END/.test(value) ? null : value;
      }
      routes.set(id, route); map.lastIndex = end;
    }
  }
  return routes;
}
