import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { doomName } from '../shared/doom-assets.js';
import { importActors } from '../shared/actors.js';
import { parseSndInfo } from '../shared/sndinfo.js';

/**
 * Actor source collection.
 *
 * Finds the DECORATE/ZScript/DEHACKED resources an imported game ships, plus the
 * GZDoom actor definitions from a local `gzdoom.pk3` when one is available.
 * Reading GZDoom's own files means vanilla monsters and weapons run from their
 * real definitions instead of our approximations.
 */

const SCRIPT_NAME = /^(decorate|zscript|dehacked|sbarinfo|menudef|mapinfo|zmapinfo|keyconf|sndinfo|gldefs|animdefs|language|cvarinfo|dialog\d*)$/i;
const SCRIPT_EXT = /\.(dec|zc|zs|zsc|bex|deh|acs)$/i;
const BUDGET = 24 * 1024 * 1024;

// MAPINFO/ZMAPINFO text carries `DoomEdNums` blocks, so it is part of the actor
// definition set even though it is not a DECORATE file.
const isScript = name => SCRIPT_EXT.test(name) || SCRIPT_NAME.test(name.split('/').pop()) ||
  /^mapinfo\//i.test(name);
const looksTextual = data => data && data.length > 0 && data.length <= 4 * 1024 * 1024 && !data.subarray(0, 512).includes(0);

/** Local ZIP entry reader (stored + deflate), reused for actor sources. */
export function zipEntries(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10), compressed: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24), localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return { buffer, entries };
}

export function zipEntryData(zip, entry) {
  const local = entry.localOffset;
  if (zip.buffer.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + zip.buffer.readUInt16LE(local + 26) + zip.buffer.readUInt16LE(local + 28);
  const data = zip.buffer.subarray(start, start + entry.compressed);
  return entry.method === 0 ? data : inflateRawSync(data);
}

/** Reads actor/DEHACKED text resources out of an archive buffer. */
export function actorSourcesFromArchive(buffer, { prefix = '', filter = null } = {}) {
  const zip = zipEntries(buffer);
  if (!zip) return { sources: [], dehacked: [], sndinfo: [] };
  const sources = [], dehacked = [], sndinfo = [];
  let budget = 0;
  for (const entry of zip.entries) {
    if (!isScript(entry.name)) continue;
    if (filter && !filter(entry.name)) continue;
    const data = zipEntryData(zip, entry);
    if (!looksTextual(data)) continue;
    budget += data.length;
    if (budget > BUDGET) break;
    const text = data.toString('latin1');
    if (/dehacked|\.(deh|bex)$/i.test(entry.name)) dehacked.push({ name: `${prefix}${entry.name}`, text });
    else sources.push({ name: `${prefix}${entry.name}`, text });
  }
  // SNDINFO is additive and carries the logical-name table, not actor definitions,
  // so it is read separately even though `isScript` also matches its file name.
  for (const entry of zip.entries) {
    if (!SNDINFO_NAME.test(entry.name) || entry.size > 2 * 1024 * 1024) continue;
    if (filter && !filter(entry.name)) continue;
    const data = zipEntryData(zip, entry);
    if (!looksTextual(data)) continue;
    sndinfo.push(data.toString('latin1'));
  }
  return { sources, dehacked, sndinfo };
}

/** Reads actor/DEHACKED text lumps out of a merged WAD. */
export const SNDINFO_NAME = /(^|\/)sndinfo(\.[a-z]{2,3})?(\.txt)?$/i;

/** SNDINFO text from any container, so logical sound names resolve to lumps. */
export function sndInfoFromWad(wad) {
  const texts = [];
  const bytes = new Uint8Array(wad.buffer);
  for (const lump of wad.lumps || []) {
    if (!/^SNDINFO$/i.test(lump.name) || lump.size > 2 * 1024 * 1024) continue;
    let text = '';
    for (let index = 0; index < lump.size; index++) text += String.fromCharCode(bytes[lump.start + index]);
    texts.push(text);
  }
  return texts;
}

export function sndInfoFromArchive(entries) {
  const texts = [];
  for (const [name, file] of entries) {
    if (!SNDINFO_NAME.test(name) || !file?.data || file.data.length > 2 * 1024 * 1024) continue;
    texts.push(Buffer.from(file.data).toString('latin1'));
  }
  return texts;
}

export function actorSourcesFromWad(wad, { prefix = '' } = {}) {
  const sources = [], dehacked = [];
  let budget = 0;
  for (const lump of wad.lumps || []) {
    if (!SCRIPT_NAME.test(lump.name)) continue;
    if (lump.size > 4 * 1024 * 1024) continue;
    budget += lump.size;
    if (budget > BUDGET) break;
    const data = Buffer.from(wad.buffer, lump.start, lump.size);
    if (!looksTextual(data)) continue;
    if (lump.name === 'DEHACKED') dehacked.push({ name: `${prefix}${lump.name}`, text: data.toString('latin1') });
    else sources.push({ name: `${prefix}${lump.name}`, text: data.toString('latin1') });
  }
  return { sources, dehacked };
}

const gzdoomCache = new Map();

/**
 * Loads the actor definitions from a local `gzdoom.pk3`, which is GZDoom's own
 * resource archive and holds the complete vanilla bestiary and arsenal.
 */
export function loadGzdoomActors(projectsDir) {
  if (!projectsDir) return { sources: [], dehacked: [], available: false };
  const candidates = [];
  const walk = (directory, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^gzdoom\.pk3$/i.test(entry.name)) candidates.push(full);
    }
  };
  walk(resolve(projectsDir), 0);
  const found = candidates[0];
  if (!found) return { sources: [], dehacked: [], sndinfo: [], available: false };
  const stamp = statSync(found);
  const cached = gzdoomCache.get(found);
  if (cached && cached.mtime === stamp.mtimeMs && cached.size === stamp.size) return cached.result;
  const buffer = readFileSync(found);
  const result = { ...actorSourcesFromArchive(buffer, { prefix: 'gzdoom.pk3:' }), available: true, path: found };
  // Vanilla monster and weapon sound names (`grunt/sight`, `weapons/pistol`) are
  // defined in the per-game filter files, not in the shared sndinfo.txt.
  const zip = zipEntries(buffer);
  for (const entry of zip?.entries || []) {
    if (!/^filter\/game-[a-z]+\/sndinfo\.txt$/i.test(entry.name)) continue;
    const data = zipEntryData(zip, entry);
    if (data) result.sndinfo.push(data.toString('latin1'));
  }
  gzdoomCache.set(found, { mtime: stamp.mtimeMs, size: stamp.size, result });
  return result;
}

/**
 * Compiles a project's actor table from everything the import found: the game's
 * own definitions, any base IWAD definitions and an available gzdoom.pk3.
 */
export function attachActors(project, { sources = [], dehacked = [], warnings = [] }) {
  const seen = new Set();
  const uniqueSources = sources.filter(source => {
    const key = `${source.name}:${source.text.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { actors } = importActors({ sources: uniqueSources, dehacked, warnings });
  project.actors = actors;
  return actors;
}

export function gzdoomAvailable(projectsDir) {
  return loadGzdoomActors(projectsDir).available;
}

export { existsSync };

// ACS library discovery lives in shared/ so the map importer and the editor can
// use it without depending on the server.
export { loadacsNames, acsLibrariesFromFiles, acsLibrariesFromWad, selectAcsLibraries } from '../shared/acs-libraries.js';
