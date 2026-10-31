import { readdirSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { PNG } from 'pngjs';
import { readWad, importWadMap } from '../shared/wad.js';
import { actorSourcesFromArchive, actorSourcesFromWad, loadGzdoomActors, sndInfoFromWad } from './actor-sources.js';
import { mergeActorActionGaps, describeActorActionGaps } from '../shared/actor-runtime.js';
import { acsLibrariesFromFiles, acsLibrariesFromWad } from '../shared/acs-libraries.js';
import { validateProject } from '../shared/project.js';
import { decodePatch, decodeFlat, flatSize, composeTexture, textureDefinitionsFromText } from '../shared/doom-assets.js';
import { encodeImage, cachedImageEncoder } from './import.js';
import { doomSound, encodeSound } from '../shared/sound.js';
import { assembleGameLevels, parseLevelRoutes } from '../shared/game-levels.js';
import { parseGameEpisodes } from '../shared/game-episodes.js';
import { LIMITS } from '../shared/limits.js';

const MiB = 1024 * 1024;
// Archive budgets, not engine restrictions: mods are commonly a few hundred megabytes
// and an expanded archive exceeds it. See shared/limits.js.
const MAX_BYTES = LIMITS.archiveBytes, MAX_EXPANDED = LIMITS.archiveExpandedBytes, MAX_FILES = LIMITS.archiveEntries;
/** Zip-based package extensions GZDoom loads: .pk3/.ipk3 for games, .pk7/.pke/.pkz for mods. */
const PACKAGE_PATTERN = /\.(?:i?pk3|pk7|pke|pkz)$/i;
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
// Folders a mod can be made of. A pack of only flats, sounds or patches is still a
// resource package, and so is a directory that only declares actors or MAPINFO.
const RESOURCE_FOLDERS = new Set(['maps', 'textures', 'flats', 'sprites', 'graphics', 'patches', 'hires', 'sounds', 'music', 'fonts', 'models', 'voxels']);
function resourcesDirectory(path) {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.some(entry => entry.isDirectory() && RESOURCE_FOLDERS.has(entry.name.toLowerCase())) ||
    entries.some(entry => entry.isFile() && /^(gameinfo|mapinfo|zmapinfo|emapinfo|zscript|decorate|menudef|sbarinfo|sndinfo|animdefs|language|keyconf)(\.|$)/i.test(entry.name));
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
      else if (entry.isFile() && PACKAGE_PATTERN.test(name)) packages.push({ name, type: 'pk3', ...(/\.ipk3$/i.test(name) ? { standalone: true } : {}) });
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
  check(info.isFile() && info.size <= MAX_BYTES, `WAD is missing or exceeds ${MAX_BYTES / MiB} MiB`);
  return readFileSync(path);
}
function imageKind(name) {
  const folder = name.split('/')[0];
  return ['', '.png', '.lmp', '.jpg', '.jpeg', '.webp', '.dds', '.tga', '.pcx'].includes(extname(name))
    ? imageFolders.get(folder) : undefined;
}
function needed(name, size) {
  // Includes may have arbitrary names/extensions. Script sources are kept at any size:
  // a 1.2 MiB ZScript library is an ordinary file, and dropping it silently removed
  // every actor it declared.
  const script = /\.(?:zc|zs|zsc|dec|deh|bex|acs|o|sf|snd|rnd|sp|bex)$/i.test(name) ||
    /(^|\/)(zscript|decorate|dehacked|language|keyconf|sndinfo|animdefs|menudef|sbarinfo|gl_defs|gldefs|mapinfo|zmapinfo|gameinfo|textures|texture1|texture2|pnames)(\.|$)/i.test(name);
  return script || name.startsWith('sounds/') || name.startsWith('music/') || Boolean(imageKind(name)) || /\.wad$/i.test(name) ||
    /^playpal(\.lmp)?$/i.test(name) || /\.(?:txt|techbase|pk3t|zipinfo)$/i.test(name) || size <= MiB;
}
export async function readPackageArchive(buffer) {
  check(typeof zlib.crc32 === 'function', 'PK3 archive CRC validation requires Node.js 22.2 or newer');
  check(Buffer.isBuffer(buffer) && buffer.length <= MAX_BYTES, `PK3 exceeds the ${MAX_BYTES / MiB} MiB import limit`);
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  return new Promise((resolve, reject) => {
    const files = new Map(), skipped = [];
    let total = 0, count = 0, finished = false;
    const fail = error => { if (!finished) { finished = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', () => {
      if (finished) return;
      finished = true;
      // Entries this reader cannot decompress are skipped by name instead of failing the
      // whole archive: one LZMA file used to make an otherwise importable mod unusable.
      if (skipped.length) files.skippedEntries = skipped;
      resolve(files);
    });
    zip.on('entry', entry => {
      try {
        const name = safePath(entry.fileName).toLowerCase();
        check(++count <= MAX_FILES, `PK3 exceeds ${MAX_FILES} entries`);
        check(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'PK3 symlinks are not supported');
        total += entry.uncompressedSize;
        check(entry.uncompressedSize <= MAX_BYTES && total <= MAX_EXPANDED, `PK3 expanded data exceeds ${MAX_EXPANDED / MiB} MiB`);
        if (name.endsWith('/')) { zip.readEntry(); return; }
        check(!files.has(name), `Duplicate package path: ${name}`);
        files.set(name, { size: entry.uncompressedSize });
        // Encrypted entries and compression methods other than stored/Deflate (bzip2,
        // LZMA, ...) cannot be read here; they are named in the import warnings.
        const encrypted = Boolean(entry.generalPurposeBitFlag & 1), method = entry.compressionMethod;
        if (encrypted || ![0, 8].includes(method)) {
          if (skipped.length < 40) skipped.push(`${name} (${encrypted ? 'encrypted' : `compression method ${method}`})`);
          zip.readEntry(); return;
        }
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
    check(PACKAGE_PATTERN.test(name) && info.size <= MAX_BYTES, `Expected a PK3/IPK3/PK7/PKE of at most ${MAX_BYTES / MiB} MiB`);
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
      check(++count <= MAX_FILES, `Package exceeds ${MAX_FILES} entries`);
      check(!entry.isSymbolicLink(), 'Package symlinks are not supported');
      const name = safePath(`${prefix}${entry.name}`).toLowerCase(), child = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(child, `${prefix}${entry.name}/`, depth + 1); continue; }
      check(entry.isFile(), 'Only regular package files are supported');
      const info = lstatSync(child);
      total += info.size;
      check(total <= MAX_EXPANDED, `Package expanded data exceeds ${MAX_EXPANDED / MiB} MiB`);
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
      maps.push({ id: `${path}#${marker}`, name: `${basename(path)} / ${marker}`, marker, path, format, supported: true });
    }
  }
  return maps;
}
/**
 * Reads the actor definition files and everything they `#include`.
 *
 * The classic layout is a small root DECORATE plus `#include "monsters.txt"` and
 * friends in subfolders. Only the root was read, so every included monster and weapon
 * silently disappeared from the import and its placed things fell back to vanilla
 * artwork. Includes resolve like GZDoom's: relative to the including file first, then
 * from the archive root, then by a unique path suffix.
 */
function collectWithIncludes(entryNames, files, warnings) {
  const byPath = new Map([...files].map(([name, file]) => [name.toLowerCase(), file]));
  const collect = (path, target) => {
    const clean = String(target ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!clean) return null;
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const candidates = [`${directory}${clean}`, clean];
    for (const candidate of candidates) if (byPath.get(candidate)?.data) return candidate;
    const suffix = `/${clean}`, matches = [...byPath.keys()].filter(name => name.endsWith(suffix) && byPath.get(name).data);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) warnings.push(`${path}: include "${target}" matches ${matches.length} files; the first is used.`);
    return matches.sort()[0] || null;
  };
  const sources = [], visited = new Set();
  const add = (path, depth, from) => {
    if (depth > 24) { warnings.push(`${path}: include depth exceeded; deeper includes were skipped.`); return; }
    const key = path.toLowerCase();
    if (visited.has(key)) return;
    const file = byPath.get(key);
    if (!file?.data) { if (from) warnings.push(`${from}: included file ${path} was not found in the package.`); return; }
    visited.add(key);
    const text = Buffer.from(file.data).toString('latin1');
    sources.push({ name: path, text });
    for (const include of text.matchAll(/#include\s+(?:"([^"]+)"|<([^>]+)>)/g)) {
      const resolved = collect(key, include[1] || include[2]);
      if (resolved) add(resolved, depth + 1, path);
      else warnings.push(`${path}: #include "${include[1] || include[2]}" was not found in the package.`);
    }
  };
  for (const name of entryNames) add(name, 0, null);
  return sources;
}
export function inspectPackage(files) {
  const skippedEntries = Array.isArray(files.skippedEntries) ? files.skippedEntries : [];
  const warnings = ['PK3 is a ZIP resource container, not an engine. Actor definitions, MAPINFO editor numbers, LANGUAGE keywords and DEHACKED patches are imported as editable data, and each map\'s compiled ACS module (BEHAVIOR) runs natively; ACS libraries loaded through LOADACS and full ZScript code are not executed.'];
  // DECORATE/ZSCRIPT actor definitions, MAPINFO DoomEdNums, LANGUAGE keyword
  // tables and DEHACKED patches are imported now, so only the remaining kinds are
  // reported as unread.
  const interpreterSupport = /(^|\/)(zscript|decorate|mapinfo|zmapinfo|gameinfo|language|dehacked)$|^(zscript|decorate)([./]|$)|\.(zc|zs|zsc|dec|deh|bex)$|(^|\/)language(\.[a-z]{2,3})?(\.txt)?$|(^|\/)mapinfo\//i;
  // LOADACS and acs/*.o are read now, so they are not "uninterpreted".
  // TEXTURES is composed now, so texture definitions are no longer listed here.
  const unsupported = [...files.keys()].filter(name => /(^|\/)(gldefs|modeldef|cvarinfo)([./]|$)|^filter\//i.test(name) &&
    !imageKind(name) && !/^sbarinfo(?:\.txt)?$/i.test(name) && !interpreterSupport.test(name));
  if (unsupported.length) warnings.push(`${unsupported.length} definition files are not interpreted (examples: ${unsupported.slice(0, 8).join(', ')}). Dynamic lights, models and filter classes need separate runtime support; actor stats, states, MAPINFO editor numbers, LANGUAGE strings, DEHACKED patches, TEXTURES definitions, per-map ACS scripts and LOADACS libraries are imported.`);
  const actorFiles = [...files.keys()].filter(name => /(^|\/)(zscript|decorate)(\.(txt|zc|zs|zsc))?$|\.(zc|zs|zsc|dec)$/i.test(name));
  if (actorFiles.length) warnings.push(`${actorFiles.length} DECORATE/ZScript file(s) are imported as editable actor data (stats, flags, sounds, state machines). ZScript code beyond defaults and state blocks is not executed; map scripts call these actors through ACS_* actions.`);
  const maps = mapsIn(files);
  if (maps.some(map => map.format === 'Hexen')) {
    warnings.push('Binary Hexen-format maps import natively: linedef specials run from the Hexen/ZDoom table with their five arguments and activation types, and things keep their tag, spawn height and dormant flag.');
  }
  if (maps.some(map => map.format === 'UDMF')) warnings.push('UDMF geometry and line specials import natively, and each map\'s ACS module runs with the package\'s LOADACS libraries; advanced rendering (portals, slopes, translucent 3D floors) is still incomplete. Full GZDoom fidelity remains the target, not current capability.');
  if ([...files.keys()].some(name => /^models\//.test(name))) warnings.push('Native model definitions are not imported yet.');
  if ([...files.keys()].some(name => /(^|\/)sndinfo(?:\.txt)?$/.test(name))) warnings.push('SNDINFO aliases and $random groups are imported so actor sound names resolve to lumps; per-sound volume, rolloff, limit and channel rules are not translated.');
  const images = [...files.keys()].filter(name => imageKind(name));
  if (!images.length) warnings.push('No images found in supported textures/flats/sprites/graphics/patches/hires namespaces. Brightmaps and other engine-specific namespaces are not imported.');
  const formats = images.filter(name => ['.jpg', '.jpeg', '.webp', '.dds', '.tga', '.pcx'].includes(extname(name)));
  if (formats.length) warnings.push(`${formats.length} images use unsupported JPEG/WebP/DDS/TGA/PCX package formats; selecting these reports an error. PNG and palette-based Doom patches/flats are supported.`);
  if (skippedEntries.length) {
    warnings.push(`${skippedEntries.length} archive entr${skippedEntries.length === 1 ? 'y' : 'ies'} could not be read and were skipped `
      + `(bzip2/LZMA compression and encryption are not supported): ${skippedEntries.slice(0, 10).join(', ')}`
      + `${skippedEntries.length > 10 ? ', ...' : ''}.`);
  }
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
      check(width > 0 && height > 0 && width <= LIMITS.imageSize && height <= LIMITS.imageSize,
        `Image dimensions exceed ${LIMITS.imageSize}x${LIMITS.imageSize}: ${path}`);
      check(pixels + width * height <= LIMITS.assetPixels, 'Package image decoding exceeds pixel budget; select a smaller image batch');
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
      // Modern flats are 128x128 or 256x256, so the size decides, not a fixed 4096.
      decoded = imageKind(path) === 'flat' && flatSize(bytes) ? decodeFlat(bytes, palette) : decodePatch(bytes, palette);
    }
    pixels += decoded.width * decoded.height;
    check(pixels <= LIMITS.assetPixels, 'Package image decoding exceeds pixel budget; select a smaller image batch');
    cache.set(path, decoded); return decoded;
  };
}
function mergeWads(sources) {
  let size = 0;
  const lumps = [], chunks = [];
  for (const source of sources) for (const lump of source.lumps) {
    size += lump.size;
    check(size <= MAX_EXPANDED, `Combined WAD resources exceed ${MAX_EXPANDED / MiB} MiB`);
    chunks.push(Buffer.from(source.buffer, lump.start, lump.size));
    lumps.push({ ...lump, start: size - lump.size });
  }
  const bytes = Buffer.concat(chunks);
  return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lumps,
    maps: [...new Set(sources.flatMap(source => source.maps))] };
}
export function importPackage(files, { map, paths, baseBytes, fullGame = false, context, projectsDir, deferActionGaps, packageName } = {}) {
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
    const gapReports = [];
    function* levels() {
      for (const [id, item] of maps) {
        check(item.supported, `${item.marker}: ${item.format} map is not supported; full-game import was not applied`);
        const level = importPackage(files, { map: item.id, baseBytes, context: shared, deferActionGaps: true, packageName });
        gapReports.push(level.actionGaps);
        yield { id, ...level };
      }
    }
    // A resource package often declares no game title (gzdoom.pk3, a brightmaps pack), so the
    // archive's own name is a better label than "Imported package game" for every one of them.
    const fallbackTitle = packageName ? `${basename(packageName).replace(/\.(pk3|ipk3|pk7|pke|zip|wad)$/i, '')} - imported package` : 'Imported package game';
    const result = assembleGameLevels(levels(), entry, inspection.game.title || fallbackTitle, routes);
    result.warnings.push(...episodeInfo.warnings);
    const gameGaps = mergeActorActionGaps(gapReports);
    if (gameGaps.length) result.warnings.push(describeActorActionGaps(gameGaps, 'the imported levels'));
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
      check(src.length <= LIMITS.imageBytes && bytes <= LIMITS.imageTotalBytes, 'Package image batch exceeds embedded asset budget');
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
  // WADs shipped inside the archive can sit at the root or in a subfolder (many mods
  // keep their resources in wads/), and each one may bring assets the map needs.
  for (const [name, file] of files) if (/\.wad$/i.test(name) && name !== selected.path) sources.push(wad(file.data));
  if (selected.path) sources.push(wad(files.get(selected.path).data));
  const combined = mergeWads(sources);
  const localPalette = files.get('playpal') || files.get('playpal.lmp');
  if (localPalette) {
    check(combined.buffer.byteLength + localPalette.data.length <= MAX_EXPANDED, `Combined WAD resources exceed ${MAX_EXPANDED / MiB} MiB`);
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
  // ZDoom's text TEXTURES defines textures as a list of patches, which is how a mod
  // adds a wall or flat that exists in no TEXTURE1 table. Composed lazily, so only the
  // textures a map actually uses pay for their patches.
  const textTextures = new Map();
  for (const [path, file] of files) {
    if (!/(^|\/)textures(\.(txt|textures))?$/i.test(path) || !file.data) continue;
    for (const definition of textureDefinitionsFromText(Buffer.from(file.data).toString('latin1'),
      { warnings: aliasWarnings, source: path })) {
      if (textTextures.has(definition.name.toUpperCase())) {
        aliasWarnings.push(`${path}: texture ${definition.name} is defined more than once; the last definition is used.`);
      }
      textTextures.set(definition.name.toUpperCase(), definition);
    }
  }
  const composing = new Set();
  const texturePatch = name => {
    const upper = name.toUpperCase();
    // The graphic a definition shares its name with comes first, then any other picture of that
    // name, and only then a composed texture (which is what would recurse).
    const raw = images.get(`patch_${upper}`);
    if (raw) return raw();
    for (const key of [`texture_${upper}`, `sprite_${upper}`, `flat_${upper}`]) {
      // A patch names a graphic, and a TEXTURES definition can share that name (Lullaby defines
      // STAR2 from a lump also called STAR2). Composing the definition into itself is not a cycle
      // in the mod, it is the same name used for two different things, so skip the definition
      // being composed and let the file or lump below answer.
      if (key === `texture_${upper}` && composing.has(key)) continue;
      const entry = images.get(key);
      if (entry) return entry();
    }
    const lump = combined.lumps.find(candidate => candidate.name.toUpperCase() === upper);
    check(lump, `Texture patch ${name} was not found in the package`);
    check(palette?.length >= 768, `Texture patch ${name} is a palette image and this package has no PLAYPAL`);
    return decodePatch(new Uint8Array(combined.buffer, lump.start, lump.size), palette);
  };
  // A patch is reachable if the package ships it under any of the names a graphic can be
  // filed as, or if the base IWAD has a lump of that name. This is a name test only, so
  // nothing is decoded here.
  const patchAvailable = name => {
    const upper = name.toUpperCase();
    return ['patch_', 'texture_', 'sprite_', 'flat_'].some(prefix => images.has(`${prefix}${upper}`)) ||
      combined.lumps.some(candidate => candidate.name.toUpperCase() === upper);
  };
  for (const [upper, definition] of textTextures) {
    const key = `texture_${upper}`;
    // Widescreen graphics packages compose pictures out of artwork that only some IWADs
    // carry (a TNT patch, a Strife title). Composing one used to throw at the moment the
    // texture was first asked for, which aborted the whole import, so a definition whose
    // patches cannot be resolved is skipped here with a note instead.
    const absent = definition.patches.map(placement => placement.name).filter(name => !patchAvailable(name));
    if (absent.length) {
      aliasWarnings.push(`TEXTURES ${definition.name} needs artwork this package and its base do not provide (${[...new Set(absent)].slice(0, 3).join(', ')}); it was skipped.`);
      continue;
    }
    if (aliases.has(key)) aliasWarnings.push(`Package texture ${definition.name} is defined by both an image and TEXTURES; the TEXTURES definition wins.`);
    // A patch is a graphic, and a definition may share its name: Lullaby's `TEXTURES/STAR2`
    // composes a picture called STAR2 that is drawn from a file called STAR2. Keeping the file
    // reachable under its own key is what stops the definition from being composed into itself.
    if (images.has(key)) images.set(`patch_${upper}`, images.get(key));
    aliases.set(key, `TEXTURES:${definition.name}`);
    images.set(key, () => {
      check(!composing.has(key), `Texture ${definition.name} includes itself through its patches`);
      composing.add(key);
      try { return composeTexture(definition, texturePatch); }
      finally { composing.delete(key); }
    });
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
    check(file.size <= LIMITS.textBytes && file.data, `Interface resource ${path} exceeds ${LIMITS.textBytes / MiB} MiB or was not retained`);
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
    check(file.data && file.size <= LIMITS.textBytes, `Font ${path} exceeds ${LIMITS.textBytes / MiB} MiB or was not retained`);
    fontResources.set(basename(path, extname(path)).toUpperCase(), new Uint8Array(file.data));
  }
  // Everything the package (and a local gzdoom.pk3) defines about actors, so the
  // imported monsters and weapons run their real state machines.
  const projectRoot = projectsDir || context?.projectsDir;
  const actorSources = [], dehackedSources = [], languageSources = [];
  const isActorSource = name => /(^|\/)(DECORATE|ZSCRIPT)$/i.test(name) || /\.(dec|zc|zs|zsc)$/i.test(name);
  actorSources.push(...collectWithIncludes([...files.keys()].filter(isActorSource), files, aliasWarnings));
  for (const [name, file] of files) {
    if (!file.data) continue;
    if (isActorSource(name)) {
      continue;
    } else if (/(^|\/)DEHACKED$/i.test(name) || /\.(deh|bex)$/i.test(name)) {
      dehackedSources.push({ name, text: Buffer.from(file.data).toString('latin1') });
    } else if (/(^|\/)language(\.[a-z]{2,3})?(\.txt)?$/i.test(name) || /\.(enu|ita|deu|fra|spa)$/i.test(name)) {
      languageSources.push({ name, text: Buffer.from(file.data).toString('latin1') });
    }
  }
  const fromBase = actorSourcesFromWad(combined, { prefix: 'base:' });
  actorSources.push(...fromBase.sources);
  dehackedSources.push(...fromBase.dehacked);
  // SNDINFO maps DECORATE sound names onto lumps, so it travels with the actors.
  const sndInfoSources = [...files].filter(([name]) => /(^|\/)sndinfo(\.[a-z]{2,3})?(\.txt)?$/i.test(name))
    .map(([, file]) => (file.data ? Buffer.from(file.data).toString('latin1') : null)).filter(Boolean);
  sndInfoSources.push(...sndInfoFromWad(combined));
  // ANIMDEFS reserves camera textures the renderer fills with a live view.
  const animDefsSources = [...files].filter(([name]) => /(^|\/)animdefs(\.[a-z]{2,3})?(\.txt)?$/i.test(name))
    .map(([, file]) => (file.data ? Buffer.from(file.data).toString('latin1') : null)).filter(Boolean);
  // Actor translations can be named entries in a TRANSLATION/TRNSLATE text lump.
  const translationSources = [...files].filter(([name]) => /(^|\/)(trnslate|translation)(\.[a-z]{2,3})?(\.txt)?$/i.test(name))
    .map(([, file]) => (file.data ? Buffer.from(file.data).toString('latin1') : null)).filter(Boolean);
  // ACS libraries: compiled modules in acs/, selected by LOADACS. They carry
  // scripts and strings the maps call into.
  const packageLibraries = acsLibrariesFromFiles(files);
  const baseLibraries = acsLibrariesFromWad(combined);
  const loadacsLists = [...packageLibraries.lists, ...baseLibraries.lists];
  const acsLibraries = [...packageLibraries.libraries, ...baseLibraries.libraries];
  if (projectRoot) {
    const gzdoom = loadGzdoomActors(projectRoot);
    if (gzdoom.available) {
      actorSources.push(...gzdoom.sources);
      dehackedSources.push(...gzdoom.dehacked);
      sndInfoSources.push(...(gzdoom.sndinfo || []));
      // GZDoom's own fonts: a MENUDEF asking for BIGFONT is asking for one of these, and a
      // Doom 2 IWAD does not carry it.
      for (const [name, bytes] of gzdoom.fonts || []) if (!fontResources.has(name)) fontResources.set(name, bytes);
    }
  }
  const result = importWadMap(combined, selected.marker,
    { encodeImage: context?.encodeImage || encodeImage, images, sounds, menuDefinitions, hudDefinitions, fontResources,
      episodeInfo: context?.episodeInfo, actorSources, dehacked: dehackedSources, languageSources,
      sndInfoSources, acsLibraries, loadacs: loadacsLists, translationSources, animDefsSources, deferActionGaps: deferActionGaps ?? fullGame });
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
    ...(result.actionGaps?.length ? { actionGaps: result.actionGaps } : {}),
    ...(automatic ? { entry: { map: selected.marker, path: selected.path, reason: inspection.game.entryReason, mapCount: inspection.maps.length } } : {}) };
}
