import { LIMITS } from './limits.js';
import { cloneProjectForEdit } from './project.js';
import { resolveMusicAsset, musicReport } from './music.js';
import { resolveString } from './language.js';

// `actors` describes the game as a whole (monster and weapon state machines),
// so it is stored once instead of being duplicated into every level.
const sharedKeys = new Set(['version', 'title', 'assets', 'game', 'actors', 'strings', 'soundAliases']);

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

function levelData(project) {
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
  Object.assign(project, structuredClone(target.data));
  game.active = id;
  return project;
}

export function nextGameLevel(game, secret = false) {
  const level = game?.levels.find(level => level.id === game.active);
  return level ? (secret ? level.secretNext : level.next) || null : null;
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
    const e = Number(episode[1]), m = Number(episode[2]), secretFrom = [0, 3, 5, 6, 2][e];
    if (secret) return `E${e}M9`;
    return m === 8 ? null : `E${e}M${m === 9 ? secretFrom + 1 : m + 1}`;
  }
  return undefined;
}

export function assembleGameLevels(entries, entryId, title, routes = new Map()) {
  const assets = [], byId = new Map(), byContent = new Map(), levels = [], warnings = new Set(), ids = new Set();
  let version, sharedActors = null, sharedStrings = null;
  const repeatedWarnings = new Set();
  for (const entry of entries) {
    if (levels.length >= 128) throw new Error('A game must contain 1–128 levels');
    if (ids.has(entry.id)) throw new Error(`Duplicate game level ${entry.id}`);
    ids.add(entry.id);
    const project = entry.project, replacements = new Map(), assetIds = [];
    version = project.version;
    // The actor table describes the whole game (monster and weapon state
    // machines), so it is taken from the first level that has one.
    if (!sharedActors && project.actors?.length) sharedActors = structuredClone(project.actors);
    if (!sharedStrings && project.strings) sharedStrings = { ...project.strings };
    for (const asset of project.assets) {
      const { id: originalId, ...content } = asset;
      const signature = JSON.stringify(content), existing = byContent.get(signature);
      let id = existing;
      if (!id) {
        id = asset.id;
        let suffix = 0;
        while (byId.has(id)) id = `level_${levels.length}_${suffix++}_${originalId}`.slice(0, 80);
        const copy = { ...asset, id };
        assets.push(copy); byId.set(id, copy); byContent.set(signature, id);
      }
      replacements.set(asset.id, id); assetIds.push(id);
    }
    function remap(value) {
      if (typeof value === 'string') return replacements.get(value) || value;
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)]));
      return value;
    }
    const route = routes.get(entry.id);
    const data = remap(levelData(project));
    applyLevelMusic(data, entry.id, route?.music, assets, warnings);
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
      for (const field of body.matchAll(/\b(next|secretnext|music|sky1)\s*=\s*("[^"]*"|[a-zA-Z0-9_-]+)/gi)) {
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
