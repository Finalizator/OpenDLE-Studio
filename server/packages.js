import { readdirSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { PNG } from 'pngjs';
import { readWad, importWadMap } from '../shared/wad.js';
import { actorSourcesFromArchive, actorSourcesFromWad, loadGzdoomActors } from './actor-sources.js';
import { validateProject } from '../shared/project.js';
import { decodePatch, decodeFlat } from '../shared/doom-assets.js';
import { encodeImage, cachedImageEncoder } from './import.js';
import { doomSound, encodeSound } from '../shared/sound.js';
import { assembleGameLevels, parseLevelRoutes } from '../shared/game-levels.js';
import { parseGameEpisodes } from '../shared/game-episodes.js';

const MiB = 1024 * 1024;
const MAX_BYTES = 128 * MiB, MAX_FILES = 10000;
const imageFolders = new Map([['textures', 'texture'], ['flats', 'flat'], ['sprites', 'sprite'],
  ['graphics', 'sprite'], ['patches', 'texture'], ['hires', 'texture']]);
function check(value, message) { if (!value) throw new Error(message); }
function safePath(name) {
  check(typeof name === 'string' && name.length > 0 && name.length <= 512 &&
    !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') &&
    !name.includes(':') && !name.split('/').some(part => part === '..' || part === '.'),
  'Unsafe package entry path');
  return name;
}
function inside(root, name) {
  safePath(name);
  const path = resolve(root, name), rel = relative(realpathSync(root), realpathSync(path));
  check(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'), 'Package path escapes Projects');
  let current = root;
  for (const part of name.split('/')) {
    current = resolve(current, part);
    check(!lstatSync(current).isSymbolicLink(), 'Package symlinks are not supported');
  }
  return path;
}
function resourcesDirectory(path) {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.some(entry => entry.isDirectory() && ['maps', 'textures', 'sprites', 'graphics'].includes(entry.name.toLowerCase())) ||
    entries.some(entry => entry.isFile() && /^(gameinfo|mapinfo|zscript|decorate)(\.|$)/i.test(entry.name));
}
export function packageLibrary(root) {
  const packages = [], wads = [];
  let count = 0;
  function walk(dir, prefix = '', depth = 0) {
    check(depth <= 8, 'Projects library exceeds directory depth limit');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      check(++count <= 20000, 'Projects library exceeds entry limit');
      const name = `${prefix}${entry.name}`, path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && /\.wad$/i.test(name)) wads.push(name);
      else if (entry.isFile() && /\.i?pk3$/i.test(name)) packages.push({ name, type: 'pk3', ...(/\.ipk3$/i.test(name) ? { standalone: true } : {}) });
      else if (entry.isDirectory()) {
        if (resourcesDirectory(path)) packages.push({ name, type: 'directory' });
        else walk(path, `${name}/`, depth + 1);
      }
    }
  }
  walk(root);
  return { packages, wads };
}
export function localWadBytes(root, name) {
  check(typeof name === 'string' && /\.wad$/i.test(name), 'Invalid WAD filename');
  const path = inside(root, name), info = lstatSync(path);
  check(info.isFile() && info.size <= MAX_BYTES, 'WAD is missing or exceeds 128 MiB');
  return readFileSync(path);
}
function imageKind(name) {
  const folder = name.split('/')[0];
  return ['', '.png', '.lmp', '.jpg', '.jpeg', '.webp', '.dds', '.tga', '.pcx'].includes(extname(name))
    ? imageFolders.get(folder) : undefined;
}
function needed(name, size) {
  // Includes may have arbitrary names/extensions. Keep small resources within the existing package budget.
  return name.startsWith('sounds/') || name.startsWith('music/') || Boolean(imageKind(name)) || /\.wad$/i.test(name) || /^playpal(\.lmp)?$/i.test(name) ||
    /^(?:gameinfo|[z]?mapinfo|menudef|sbarinfo)(?:[./]|$)/i.test(name) || /\.(?:txt|techbase|pk3t)$/i.test(name) || size <= MiB;
}
export async function readPackageArchive(buffer) {
  check(typeof zlib.crc32 === 'function', 'PK3 archive CRC validation requires Node.js 22.2 or newer');
  check(Buffer.isBuffer(buffer) && buffer.length <= MAX_BYTES, 'PK3 exceeds the 128 MiB import limit');
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  return new Promise((resolve, reject) => {
    const files = new Map();
    let total = 0, count = 0, finished = false;
    const fail = error => { if (!finished) { finished = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!finished) { finished = true; resolve(files); } });
    zip.on('entry', entry => {
      try {
        const name = safePath(entry.fileName).toLowerCase();
        check(++count <= MAX_FILES, 'PK3 exceeds 10000 entries');
        check(!(entry.generalPurposeBitFlag & 1), 'Encrypted PK3 entries are not supported');
        check([0, 8].includes(entry.compressionMethod), 'Only stored/Deflate PK3 entries are supported');
        check(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'PK3 symlinks are not supported');
        total += entry.uncompressedSize;
        check(entry.uncompressedSize <= MAX_BYTES && total <= MAX_BYTES, 'PK3 expanded data exceeds 128 MiB');
        if (name.endsWith('/')) { zip.readEntry(); return; }
        check(!files.has(name), `Duplicate package path: ${name}`);
        files.set(name, { size: entry.uncompressedSize });
        if (!needed(name, entry.uncompressedSize)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(error); return; }
          const chunks = [];
          let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_BYTES) { stream.destroy(new Error('PK3 entry size exceeded')); return; }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (finished) return;
            const data = Buffer.concat(chunks);
            if (data.length !== entry.uncompressedSize || zlib.crc32(data) !== entry.crc32) { fail(new Error(`PK3 CRC/size mismatch: ${name}`)); return; }
            files.get(name).data = data; zip.readEntry();
          });
        });
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}
export async function readLocalPackage(root, name) {
  const path = inside(root, name), info = lstatSync(path);
  if (info.isFile()) {
    check(/\.i?pk3$/i.test(name) && info.size <= MAX_BYTES, 'Expected a PK3/IPK3 of at most 128 MiB');
    const files = await readPackageArchive(readFileSync(path));
    files.standalone = /\.ipk3$/i.test(name);
    return files;
  }
  check(info.isDirectory() && resourcesDirectory(path), 'Not an unpacked resource package');
  const files = new Map();
  let total = 0, count = 0;
  function walk(dir, prefix = '', depth = 0) {
    check(depth <= 16, 'Package exceeds directory depth limit');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      check(++count <= MAX_FILES, 'Package exceeds 10000 entries');
      check(!entry.isSymbolicLink(), 'Package symlinks are not supported');
      const name = safePath(`${prefix}${entry.name}`).toLowerCase(), child = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(child, `${prefix}${entry.name}/`, depth + 1); continue; }
      check(entry.isFile(), 'Only regular package files are supported');
      const info = lstatSync(child);
      total += info.size;
      check(total <= MAX_BYTES, 'Package expanded data exceeds 128 MiB');
      check(!files.has(name), `Duplicate package path: ${name}`);
      files.set(name, { size: info.size, ...(needed(name, info.size) ? { data: readFileSync(child) } : {}) });
    }
  }
  walk(path);
  return files;
}
function wad(bytes) {
  return readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { allowNoMaps: true });
}
function mapsIn(files) {
  const maps = [];
  for (const [path, file] of files) {
    if (!/^maps\/[^/]+\.wad$/i.test(path)) continue;
    const source = wad(file.data);
    for (const marker of source.maps) {
      const index = source.lumps.findIndex(lump => lump.name === marker);
      const end = source.lumps.findIndex((lump, i) => i > index && source.maps.includes(lump.name));
      const lumps = source.lumps.slice(index + 1, end < 0 ? undefined : end);
      const format = lumps.some(lump => lump.name === 'TEXTMAP') ? 'UDMF'
        : lumps.some(lump => lump.name === 'BEHAVIOR') ? 'Hexen' : 'Doom';
      maps.push({ id: `${path}#${marker}`, name: `${basename(path)} / ${marker}`, marker, path, format, supported: format !== 'Hexen' });
    }
  }
  return maps;
}
export function inspectPackage(files) {
  const warnings = ['PK3 is a ZIP resource container, not an engine. Actor definitions, MAPINFO editor numbers, LANGUAGE keywords and DEHACKED patches are imported as editable data, and each map\'s compiled ACS module (BEHAVIOR) runs natively; ACS libraries loaded through LOADACS and full ZScript code are not executed.'];
  // DECORATE/ZSCRIPT actor definitions, MAPINFO DoomEdNums, LANGUAGE keyword
  // tables and DEHACKED patches are imported now, so only the remaining kinds are
  // reported as unread.
  const interpreterSupport = /(^|\/)(zscript|decorate|mapinfo|zmapinfo|gameinfo|language|dehacked)$|^(zscript|decorate)([./]|$)|\.(zc|zs|zsc|dec|deh|bex)$|(^|\/)language(\.[a-z]{2,3})?(\.txt)?$|(^|\/)mapinfo\//i;
  const unsupported = [...files.keys()].filter(name => /(^|\/)(gldefs|sndinfo|animdefs|sbarinfo|modeldef|loadacs|cvarinfo|textures)([./]|$)|^acs\/|^filter\//i.test(name) &&
    !imageKind(name) && !/^sbarinfo(?:\.txt)?$/i.test(name) && !interpreterSupport.test(name));
  if (unsupported.length) warnings.push(`${unsupported.length} definition files are not interpreted (examples: ${unsupported.slice(0, 8).join(', ')}). Scripted HUDs, texture definitions, animations and filter classes need separate runtime support; actor stats, states, MAPINFO editor numbers, LANGUAGE strings, DEHACKED patches and per-map ACS scripts are imported.`);
  const actorFiles = [...files.keys()].filter(name => /(^|\/)(zscript|decorate)(\.(txt|zc|zs|zsc))?$|\.(zc|zs|zsc|dec)$/i.test(name));
  if (actorFiles.length) warnings.push(`${actorFiles.length} DECORATE/ZScript file(s) are imported as editable actor data (stats, flags, sounds, state machines). ZScript code beyond defaults and state blocks is not executed; map scripts call these actors through ACS_* actions.`);
  const maps = mapsIn(files), rejected = maps.filter(map => !map.supported);
  if (rejected.length) warnings.push(`${rejected.length} binary Hexen maps cannot be imported yet; image assets can still be imported.`);
  if (maps.some(map => map.format === 'UDMF')) warnings.push('UDMF geometry and line specials import natively and each map\'s ACS module executes; advanced rendering (portals, 3D floors, slopes) and ACS libraries are still incomplete. Full GZDoom fidelity remains the target, not current capability.');
  if ([...files.keys()].some(name => /^models\//.test(name))) warnings.push('Native model definitions are not imported yet.');
  if ([...files.keys()].some(name => /(^|\/)sndinfo(?:\.txt)?$/.test(name))) warnings.push('Sound files are imported by filename; custom SNDINFO aliases, random groups and channel rules are not translated yet. Edit playSound names in Engine sheets to bind custom effects.');
  const images = [...files.keys()].filter(name => imageKind(name));
  if (!images.length) warnings.push('No images found in supported textures/flats/sprites/graphics/patches/hires namespaces. Brightmaps and other engine-specific namespaces are not imported.');
  const formats = images.filter(name => ['.jpg', '.jpeg', '.webp', '.dds', '.tga', '.pcx'].includes(extname(name)));
  if (formats.length) warnings.push(`${formats.length} images use unsupported JPEG/WebP/DDS/TGA/PCX package formats; selecting these reports an error. PNG and palette-based Doom patches/flats are supported.`);
  const game = { ...packageGameInfo(files, maps), standalone: Boolean(files.standalone) };
  return { maps, images, warnings, game };
}
function packageGameInfo(files, maps) {
  const values = { title: null, requiredBase: null, entryMap: null, entryReason: null };
  let budget = 0;
  const visited = new Set(), episodes = [], declarations = [];
  function scan(path, depth = 0) {
    if (visited.has(path)) return;
    check(depth <= 16, 'Package metadata include depth exceeded');
    visited.add(path);
    const data = files.get(path)?.data;
    check(data, `Package metadata include not found: ${path}`);
    budget += data.length;
    check(budget <= 2 * MiB, 'Package metadata exceeds 2 MiB');
    const text = data.toString('utf8');
    const tokens = text.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|[a-zA-Z0-9_./-]+|[{}=#]/g) || [];
    const useful = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'));
    const unquote = value => value?.startsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
    for (let i = 0; i < useful.length; i++) {
      const key = useful[i].toLowerCase();
      let next = i + 1;
      if (useful[next] === '=') next++;
      const value = unquote(useful[next]);
      if (key === 'include' && value) {
        const relativePath = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}${value}` : value;
        const target = files.has(value.toLowerCase()) ? value.toLowerCase() : relativePath.toLowerCase();
        safePath(target); scan(target, depth + 1);
      }
      if (['startuptitle', 'iwad'].includes(key) && value) values[key === 'iwad' ? 'requiredBase' : 'title'] = value;
      if (key === 'episode' && value) episodes.push(value);
      if (key === 'startmap' && value) episodes.unshift(value);
      if (key === 'map' && value) declarations.push(value);
    }
  }
  for (const name of files.keys()) if (/^(gameinfo|zmapinfo|mapinfo)(\.|$)/i.test(name)) scan(name);
  const find = name => maps.find(map => basename(map.path, '.wad').toLowerCase() === name.toLowerCase()) ||
    maps.find(map => map.marker.toLowerCase() === name.toLowerCase());
  const declared = episodes[0];
  const entry = declared ? find(declared)
    : declarations.map(find).find(Boolean) || find('MAP01') ||
      maps.find(map => !/title|endmap|testmap/i.test(map.path)) || maps[0];
  values.entryMap = entry?.id || null;
  values.entryReason = declared ? `Declared entry: ${declared}` : entry ? 'First declared or conventional gameplay map' : 'Uses the selected base game entry map';
  if (declared && !entry) values.entryError = `The mod declares entry map ${declared}, but that map was not found in this package. Check its required dependency packages.`;
  return values;
}
function paletteFrom(base, files) {
  const local = files.get('playpal') || files.get('playpal.lmp');
  if (local) { check(local.data.length >= 768, 'Truncated package PLAYPAL'); return local.data.subarray(0, 768); }
  if (!base) return null;
  const lump = base.lumps.findLast(lump => lump.name === 'PLAYPAL');
  return lump ? Buffer.from(base.buffer, lump.start, Math.min(768, lump.size)) : null;
}
function imageDecoder(files, palette) {
  let pixels = 0;
  const cache = new Map();
  return path => {
    if (cache.has(path)) return cache.get(path);
    const bytes = files.get(path)?.data;
    check(bytes, `Package image not found: ${path}`);
    let decoded;
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      check(width > 0 && height > 0 && width <= 2048 && height <= 2048, `Image dimensions exceed 2048x2048: ${path}`);
      check(pixels + width * height <= 32 * MiB, 'Package image decoding exceeds pixel budget; select a smaller image batch');
      const png = PNG.sync.read(bytes, { checkCRC: true });
      decoded = { width, height, pixels: png.data, offsetX: 0, offsetY: 0 };
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        check(offset + length + 12 <= bytes.length, `Truncated PNG chunk: ${path}`);
        if (type === 'grAb') {
          check(length === 8, `Invalid PNG grAb offset: ${path}`);
          decoded.offsetX = bytes.readInt32BE(offset + 8); decoded.offsetY = bytes.readInt32BE(offset + 12);
        }
        offset += length + 12;
      }
    } else {
      check(!/^\xff\xd8/.test(bytes.toString('latin1', 0, 2)) && !['.jpg', '.jpeg', '.webp', '.dds', '.tga', '.pcx'].includes(extname(path)),
        `Unsupported package image format: ${path}. Import PNG or Doom patches instead.`);
      check(palette?.length >= 768, `Legacy Doom image ${path} needs a base IWAD PLAYPAL palette`);
      decoded = imageKind(path) === 'flat' && bytes.length === 4096 ? decodeFlat(bytes, palette) : decodePatch(bytes, palette);
    }
    pixels += decoded.width * decoded.height;
    check(pixels <= 32 * MiB, 'Package image decoding exceeds pixel budget; select a smaller image batch');
    cache.set(path, decoded); return decoded;
  };
}
function mergeWads(sources) {
  let size = 0;
  const lumps = [], chunks = [];
  for (const source of sources) for (const lump of source.lumps) {
    size += lump.size;
    check(size <= MAX_BYTES, 'Combined WAD resources exceed 128 MiB');
    chunks.push(Buffer.from(source.buffer, lump.start, lump.size));
    lumps.push({ ...lump, start: size - lump.size });
  }
  const bytes = Buffer.concat(chunks);
  return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lumps,
    maps: [...new Set(sources.flatMap(source => source.maps))] };
}
export function importPackage(files, { map, paths, baseBytes, fullGame = false, context, projectsDir } = {}) {
  const inspection = context?.inspection || inspectPackage(files), base = context?.base || (baseBytes ? wad(baseBytes) : null);
  const automatic = map === 'auto';
  if (automatic) {
    check(!inspection.game.entryError, inspection.game.entryError);
    map = inspection.game.entryMap || 'base-entry';
  }
  if (fullGame && map) {
    const selected = inspection.maps.find(item => item.id === map);
    const logicalId = item => item.path?.startsWith('maps/') ? basename(item.path, '.wad').toUpperCase() : item.marker;
    const entry = selected ? logicalId(selected) : (map === 'base-entry' && base ?
      base.maps.includes('MAP01') ? 'MAP01' : base.maps.includes('E1M1') ? 'E1M1' : base.maps[0] : null);
    check(entry, 'Game entry map not found; select the required base IWAD');
    const metadata = name => {
      const file = files.get(name);
      if (!file) return null;
      check(file.data && file.size <= MiB, `MAPINFO ${name} exceeds 1 MiB or was not retained`);
      return { name, source: file.data.toString('utf8') };
    };
    const resolveMetadata = (name, parent) => {
      safePath(name);
      const directory = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/') + 1) : '';
      return metadata(name.toLowerCase()) || metadata(`${directory}${name.toLowerCase()}`);
    };
    const definitions = [...files.keys()].filter(path => /^[z]?mapinfo(?:[./]|$)/i.test(path))
      .map(path => ({ ...metadata(path), resolve: resolveMetadata }));
    const candidateIds = [...inspection.maps.map(logicalId), ...base?.maps || []];
    const episodeInfo = parseGameEpisodes(definitions, candidateIds, { inferClassic: false });
    const replacesEpisodes = episodeInfo.sources.some(definition => /\bclearepisodes\b/i.test(
      definition.source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ')));
    const baseCampaign = !inspection.maps.length || !inspection.game.standalone && !replacesEpisodes &&
      inspection.maps.every(item => /^(MAP\d\d|E\dM\d)$/.test(logicalId(item)));
    if (baseCampaign) Object.assign(episodeInfo, parseGameEpisodes(definitions, candidateIds));
    const routes = parseLevelRoutes(episodeInfo.sources.map(source => source.source));
    const maps = new Map((baseCampaign ? base?.maps || [] : [])
      .map(id => [id, { id: `base:${id}`, marker: id, supported: true }]));
    for (const item of inspection.maps) maps.set(logicalId(item), item);
    for (const episode of episodeInfo.episodes)
      if (!maps.has(episode.levelId) && base?.maps.includes(episode.levelId))
        maps.set(episode.levelId, { id: `base:${episode.levelId}`, marker: episode.levelId, supported: true });
    for (const route of routes.values()) for (const id of [route.next, route.secretNext])
      if (id && !maps.has(id) && base?.maps.includes(id)) maps.set(id, { id: `base:${id}`, marker: id, supported: true });
    check(maps.size <= 128, 'Game exceeds 128 levels');
    const shared = { inspection, base, decode: imageDecoder(files, paletteFrom(base, files)), encodeImage: cachedImageEncoder(), episodeInfo, projectsDir };
    function* levels() {
      for (const [id, item] of maps) {
        check(item.supported, `${item.marker}: ${item.format} map is not supported; full-game import was not applied`);
        yield { id, ...importPackage(files, { map: item.id, baseBytes, context: shared }) };
      }
    }
    const result = assembleGameLevels(levels(), entry, inspection.game.title || 'Imported package game', routes);
    result.warnings.push(...episodeInfo.warnings);
    validateProject(result.project);
    return { ...result, entry: { map: entry, path: selected?.path || null,
      reason: inspection.game.entryReason, mapCount: maps.size } };
  }
  const palette = paletteFrom(base, files), decode = context?.decode || imageDecoder(files, palette);
  if (!map) {
    check(Array.isArray(paths) && paths.length > 0 && paths.length <= 64 && new Set(paths).size === paths.length,
      'Select 1-64 distinct package image paths');
    let bytes = 0;
    const assets = paths.map(path => {
      check(inspection.images.includes(path), `Unknown package image: ${path}`);
      const image = decode(path), src = encodeImage(image);
      bytes += src.length;
      check(src.length <= 6 * MiB && bytes <= 48 * MiB, 'Package image batch exceeds embedded asset budget');
      return { id: `package_${createHash('sha256').update(path).update(src).digest('hex').slice(0, 24)}`,
        name: path.length <= 100 ? path : `${path.slice(0, 49)}...${path.slice(-48)}`, kind: imageKind(path),
        width: image.width, height: image.height, offsetX: image.offsetX, offsetY: image.offsetY, src };
    });
    return { assets, warnings: inspection.warnings };
  }
  const selected = typeof map === 'string' && map.startsWith('base:') && base?.maps.includes(map.slice(5))
    ? { marker: map.slice(5), supported: true, path: null }
    : map === 'base-entry' && automatic && !inspection.maps.length && base
    ? { marker: base.maps.includes('MAP01') ? 'MAP01' : base.maps.includes('E1M1') ? 'E1M1' : base.maps[0], supported: true, path: null }
    : inspection.maps.find(item => item.id === map);
  if (automatic && !inspection.maps.length && !base) throw new Error('This mod needs a base game. Select its required base IWAD before importing.');
  check(selected, 'Package map not found');
  check(selected.supported, `${selected.format} maps are not supported; import image assets instead`);
  const sources = base ? [base] : [];
  for (const [name, file] of files) if (/^[^/]+\.wad$/.test(name)) sources.push(wad(file.data));
  if (selected.path) sources.push(wad(files.get(selected.path).data));
  const combined = mergeWads(sources);
  const localPalette = files.get('playpal') || files.get('playpal.lmp');
  if (localPalette) {
    check(combined.buffer.byteLength + localPalette.data.length <= MAX_BYTES, 'Combined WAD resources exceed 128 MiB');
    const bytes = Buffer.concat([Buffer.from(combined.buffer), localPalette.data]);
    combined.lumps.push({ name: 'PLAYPAL', start: combined.buffer.byteLength, size: localPalette.data.length });
    combined.buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const images = new Map(), aliases = new Map(), aliasWarnings = [];
  for (const path of inspection.images) {
    const name = basename(path, extname(path)).toUpperCase(), kind = imageKind(path), key = `${kind}_${name}`;
    if (aliases.has(key)) aliasWarnings.push(`Package image alias ${name}: ${path} replaces ${aliases.get(key)} in package enumeration order. Full relative paths remain addressable.`);
    aliases.set(key, path); images.set(key, () => decode(path));
    const fullName = path.slice(path.indexOf('/') + 1, extname(path) ? -extname(path).length : undefined).toUpperCase();
    images.set(`${kind}_${fullName}`, () => decode(path));
    images.set(`${kind}_${path.toUpperCase()}`, () => decode(path));
    images.set(`${kind}_${path.slice(path.indexOf('/') + 1).toUpperCase()}`, () => decode(path));
    if (kind === 'sprite' && path.startsWith('sprites/')) images.set(`weapon_${name}`, () => decode(path));
  }
  const sounds = new Map();
  let soundBytes = 0;
  for (const [path, file] of files) if (path.startsWith('sounds/')) {
    const extension = extname(path).toLowerCase(), name = basename(path, extension).toUpperCase();
    let src;
    if (['.wav', '.ogg', '.mp3'].includes(extension)) {
      src = encodeSound(new Uint8Array(file.data), extension.slice(1));
    } else {
      try { src = doomSound(new Uint8Array(file.data)); }
      catch (error) { aliasWarnings.push(`Sound ${path} was not imported: ${error.message}`); continue; }
    }
    soundBytes += src.length;
    check(sounds.size < 512 && soundBytes <= 64 * MiB && src.length <= 12 * MiB,
      `Package sound budget exceeded at ${path} (${file.data.length} source bytes, ${src.length} embedded bytes; 12 MiB each, 64 MiB total)`);
    if (sounds.has(name)) aliasWarnings.push(`Sound filename ${name}: ${path} replaces an earlier file with the same basename.`);
    sounds.set(name, src);
  }
  const interfaceText = path => {
    const file = files.get(path);
    if (!file) return null;
    check(file.size <= MiB && file.data, `Interface resource ${path} exceeds 1 MiB or was not retained`);
    return { name: path, source: new TextDecoder('utf-8', { fatal: true }).decode(file.data) };
  };
  const resolveInterface = (name, parent) => {
    safePath(name);
    const path = name.toLowerCase(), directory = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/') + 1) : '';
    return interfaceText(path) || interfaceText(`${directory}${path}`);
  };
  const menuDefinitions = [...files.keys()].filter(name => /(^|\/)menudef(?:\.txt)?$/i.test(name))
    .map(name => ({ ...interfaceText(name), resolve: resolveInterface }));
  const hudDefinitions = [...files.keys()].filter(name => /^(?:sbarinfo|sbarinfo\.txt)$/i.test(name))
    .map(name => ({ ...interfaceText(name), resolve: resolveInterface }));
  for (const name of files.keys()) if (/\/sbarinfo(?:\.txt)?$/i.test(name))
    aliasWarnings.push(`${name}: filtered/nested SBARINFO is not selected automatically; root SBARINFO may include it explicitly.`);
  const fontResources = new Map();
  for (const [path, file] of files) if (/\.fon2$/i.test(path) || !path.includes('/') && file.data?.toString('ascii', 0, 4) === 'FON2') {
    check(file.data && file.size <= MiB, `Font ${path} exceeds 1 MiB or was not retained`);
    fontResources.set(basename(path, extname(path)).toUpperCase(), new Uint8Array(file.data));
  }
  // Everything the package (and a local gzdoom.pk3) defines about actors, so the
  // imported monsters and weapons run their real state machines.
  const projectRoot = projectsDir || context?.projectsDir;
  const actorSources = [], dehackedSources = [], languageSources = [];
  for (const [name, file] of files) {
    if (!file.data) continue;
    if (/(^|\/)(DECORATE|ZSCRIPT)$/i.test(name) || /\.(dec|zc|zs|zsc)$/i.test(name)) {
      actorSources.push({ name, text: Buffer.from(file.data).toString('latin1') });
    } else if (/(^|\/)DEHACKED$/i.test(name) || /\.(deh|bex)$/i.test(name)) {
      dehackedSources.push({ name, text: Buffer.from(file.data).toString('latin1') });
    } else if (/(^|\/)language(\.[a-z]{2,3})?(\.txt)?$/i.test(name) || /\.(enu|ita|deu|fra|spa)$/i.test(name)) {
      languageSources.push({ name, text: Buffer.from(file.data).toString('latin1') });
    }
  }
  const fromBase = actorSourcesFromWad(combined, { prefix: 'base:' });
  actorSources.push(...fromBase.sources);
  dehackedSources.push(...fromBase.dehacked);
  if (projectRoot) {
    const gzdoom = loadGzdoomActors(projectRoot);
    if (gzdoom.available) {
      actorSources.push(...gzdoom.sources);
      dehackedSources.push(...gzdoom.dehacked);
    }
  }
  const result = importWadMap(combined, selected.marker,
    { encodeImage: context?.encodeImage || encodeImage, images, sounds, menuDefinitions, hudDefinitions, fontResources,
      episodeInfo: context?.episodeInfo, actorSources, dehacked: dehackedSources, languageSources });
  let musicBytes = 0;
  for (const [path, file] of files) if (path.startsWith('music/')) {
    const format = extname(path).slice(1);
    if (!['wav', 'ogg', 'mp3'].includes(format)) { result.warnings.push(`Music ${path}: MUS/MIDI and other formats are not playable yet`); continue; }
    const src = encodeSound(new Uint8Array(file.data), format);
    musicBytes += src.length;
    check(musicBytes <= 32 * MiB, 'Package music exceeds 32 MiB');
    result.project.assets.push({ id: `music_${result.project.assets.length}`, name: path.slice(0, 100), kind: 'sound', music: true, src });
  }
  result.project.title = inspection.game.title?.slice(0, 100) || `${basename(selected.path || selected.marker).slice(0, 80)} - imported PK3`;
  validateProject(result.project);
  return { project: result.project, warnings: [...inspection.warnings, ...aliasWarnings, ...result.warnings],
    ...(automatic ? { entry: { map: selected.marker, path: selected.path, reason: inspection.game.entryReason, mapCount: inspection.maps.length } } : {}) };
}
