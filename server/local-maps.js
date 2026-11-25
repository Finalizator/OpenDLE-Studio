// What is in the Projects folder, and what the engine can do with each map file.
//
// This exists because "put the maps in the Projects folder and press import" did nothing: the file
// picker filtered for `.map` sources and the local library only looked for `*.wad` at the top level,
// so a folder of maps was invisible — the person saw folders and no files.
//
// Both kinds are importable now, and this file stays the place that says which is which: a `.map` is
// handed back as text for the source reader, a `.bsp` as bytes for `shared/bsp.js`, which turns a
// compiled map into the same brushes a source one becomes.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import yauzl from 'yauzl';
import { bspEngine, bspInfo } from '../shared/bsp.js';

export { bspEngine, bspInfo };

/** How many files a browse may list, so a huge folder cannot hang the dialog. */
export const MAP_BROWSER_LIMIT = 400;
/** A map file, as source or compiled. A `.wad` is a Doom level container and has its own import. */
const MAP_PATTERN = /\.(map|bsp|pk3|zip|pak)$/i;
const ARCHIVE_PATTERN = /\.(pk3|zip|pak)$/i;
/** One file, read whole, is bounded: a map source is a few megabytes and a fake is not worth it. */
const READ_LIMIT = 64 * 1024 * 1024;

function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Every file name inside an archive (a `.pk3` and a `.zip` are both zips), or null. */
export function listArchive(file) {
  return new Promise(done => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { done(null); return; }
      const names = [];
      const finish = () => done(names);
      zip.on('error', finish);
      zip.on('end', finish);
      zip.on('entry', entry => {
        if (!entry.fileName.endsWith('/')) names.push(entry.fileName);
        if (names.length >= 20000) { finish(); return; }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/** The verdict for one file the browser found. */
function describe(file, size) {
  const extension = extname(file).toLowerCase();
  if (extension === '.map') {
    return { kind: 'map', importable: true, holds: 'map', detail: '.map source — importable as a project or a layout' };
  }
  if (extension === '.bsp') return compiled(readFileSync(file), size);
  return { kind: extension.slice(1), importable: false, detail: `${sizeText(size)} — not a map file` };
}

/** A compiled map, named by the game and version its header carries. */
function compiled(bytes, size) {
  const info = bspInfo(bytes);
  if (!info) {
    return { kind: 'bsp', holds: 'bsp', importable: false,
      detail: `${sizeText(size)} — a compiled map of a format this reader does not know` };
  }
  return {
    kind: 'bsp',
    holds: 'bsp',
    importable: true,
    engine: info.engine,
    version: info.version,
    detail: `${info.engine} BSP v${info.version} — imports as brushes`,
  };
}

/**
 * Lists the map files under `root`, each with what it is.
 *
 * Hidden folders and symlinks are skipped: the first is never a game, and the second could point
 * anywhere. An archive is opened only to say what is inside it.
 */
export async function scanLocalMaps(root, { limit = MAP_BROWSER_LIMIT, depth = 6 } = {}) {
  const base = resolve(root);
  const found = [];
  let truncated = false;
  const walk = (directory, prefix, level) => {
    if (truncated || level > depth) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(path, `${prefix}${entry.name}/`, level + 1); continue; }
      if (!entry.isFile() || !MAP_PATTERN.test(entry.name)) continue;
      if (found.length >= limit) { truncated = true; return; }
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.size > READ_LIMIT) continue;
        found.push({ path: `${prefix}${entry.name}`, file: path, size: info.size, ...describe(path, info.size) });
      } catch { /* a file that vanished between the listing and the read is not worth a row */ }
    }
  };
  walk(base, '', 0);

  // Archives are opened after the walk, so the walk itself stays synchronous and cheap. One that
  // holds neither a source nor a compiled map is not a map package — a Doom mod's pk3, a texture
  // pack — and listing it here would bury the three files the person actually put there.
  for (const entry of [...found]) {
    if (!ARCHIVE_PATTERN.test(entry.path)) continue;
    const names = await listArchive(entry.file);
    if (!names) { entry.detail = 'archive could not be read'; continue; }
    const holdsMap = names.some(name => /\.(map|bsp)$/i.test(name));
    if (!holdsMap) { found.splice(found.indexOf(entry), 1); continue; }
    const sources = names.filter(name => /\.map$/i.test(name));
    const maps = names.filter(name => /\.bsp$/i.test(name));
    entry.inside = (sources.length ? sources : maps).slice(0, 8);
    if (sources.length) {
      entry.importable = true;
      entry.holds = 'map';
      entry.entry = sources[0];
      entry.detail = `contains ${sources[0]} — map source, importable from here`;
    } else if (maps.length) {
      // The archive is a wrapper around a compiled map; the game it was built for is in the header,
      // so the row can say what it is instead of only that something is inside.
      const inner = await readArchiveEntry(entry.file, maps[0]);
      const info = inner ? bspInfo(inner) : null;
      entry.holds = 'bsp';
      entry.importable = Boolean(info);
      entry.engine = info?.engine ?? null;
      entry.version = info?.version ?? null;
      entry.detail = info
        ? `contains ${maps[0]} — ${info.engine} BSP v${info.version}, imports as brushes`
        : `contains ${maps.slice(0, 3).join(', ')} — compiled in a format this reader does not know`;
      if (info) entry.entry = maps[0];
    } else {
      entry.detail = 'no .map or .bsp inside';
    }
  }
  // Sources before compiled maps, then anything else: the list is for acting on.
  const order = entry => (entry.importable ? 0 : 2) + (entry.holds === 'bsp' ? 1 : 0);
  found.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  return {
    root: base,
    // The absolute path is this machine's business; a row shows the path inside the folder.
    entries: found.map(({ file, ...entry }) => entry),
    truncated,
  };
}

/** Resolves a browser path inside `root`, refusing anything that would leave it. */
function inside(root, path) {
  const base = resolve(root);
  const target = resolve(base, String(path ?? ''));
  if (target === base || target.startsWith(`${base}${sep}`)) return target;
  throw new Error('That file is outside the Projects folder');
}

/**
 * The bytes of several entries of one archive, in a single pass.
 *
 * A map names a hundred textures and each one lives somewhere in a `.pk3` of ten thousand entries;
 * opening the archive once per picture is the difference between a second and a minute.
 */
export function readArchiveEntries(file, wanted, { limit = READ_LIMIT } = {}) {
  const names = new Map([...wanted].map(name => [name.toLowerCase(), name]));
  return new Promise(done => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      const found = new Map();
      if (error) { done(found); return; }
      let settled = false;
      const finish = () => { if (!settled) { settled = true; done(found); } };
      zip.on('error', finish);
      zip.on('end', finish);
      zip.on('entry', entry => {
        if (settled) return;
        const wantedName = names.get(entry.fileName.toLowerCase());
        if (!wantedName || entry.uncompressedSize > limit) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { zip.readEntry(); return; }
          const chunks = [];
          stream.on('error', () => zip.readEntry());
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            if (found.size < names.size) found.set(wantedName, Buffer.concat(chunks));
            if (found.size >= names.size) { finish(); return; }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** One entry of a `.pk3`/`.zip`/`.pak`, read whole, or null when it is not there. */
function readArchiveEntry(file, wanted, limit = READ_LIMIT) {
  return new Promise(done => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { done(null); return; }
      let settled = false;
      const finish = value => { if (!settled) { settled = true; done(value); } };
      zip.on('error', () => finish(null));
      zip.on('end', () => finish(null));
      zip.on('entry', archiveEntry => {
        if (settled) return;
        if (archiveEntry.fileName !== wanted || archiveEntry.uncompressedSize > limit) {
          if (archiveEntry.fileName === wanted) { finish(null); return; }
          zip.readEntry();
          return;
        }
        zip.openReadStream(archiveEntry, (streamError, stream) => {
          if (streamError) { finish(null); return; }
          const chunks = [];
          stream.on('error', () => finish(null));
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => finish(Buffer.concat(chunks)));
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Read access to the archive a map came in, for the textures beside it.
 *
 * A `.pk3` is where a Quake 3 map keeps its pictures, so importing the map without the archive would
 * import names and no artwork. `list`/`read` are all the texture importer needs, and a map on disk
 * gets nothing, which is how it knows there is no archive to look in.
 */
export function localArchive(root, path) {
  const file = inside(root, path);
  return {
    list: () => listArchive(file),
    read: name => readArchiveEntry(file, name),
    file,
  };
}

/**
 * A map the browser listed: the text of a `.map`, or the bytes of a `.bsp`.
 *
 * Both come from the folder rather than a file dialog, and both work inside a `.pk3` or `.zip` —
 * which is how a mod ships a map, and why refusing an archive would have left most of a Quake
 * folder unimportable.
 */
export async function readLocalMapFile(root, path, entry = null) {
  const file = inside(root, path);
  let info;
  try { info = lstatSync(file); } catch { throw new Error(`${path} is no longer there`); }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > READ_LIMIT) throw new Error(`${path} is larger than ${READ_LIMIT / (1024 * 1024)} MiB`);
  const wanted = entry || null;
  const name = wanted || path.split('/').pop();
  if (!wanted) {
    const bytes = readFileSync(file);
    if (/\.map$/i.test(file)) return { kind: 'map', name, text: bytes.toString('utf8') };
    if (/\.bsp$/i.test(file)) return { kind: 'bsp', name, bytes };
    throw new Error(`${path} is not a .map source or a .bsp`);
  }
  const bytes = await readArchiveEntry(file, wanted);
  if (!bytes) throw new Error(`${path} has no readable ${wanted}`);
  if (/\.map$/i.test(wanted)) return { kind: 'map', name, text: bytes.toString('utf8') };
  if (/\.bsp$/i.test(wanted)) return { kind: 'bsp', name, bytes };
  throw new Error(`${wanted} is not a .map source or a .bsp`);
}

/** A one-line summary for the status bar. */
export function describeScan(result) {
  const total = result.entries.length;
  const importable = result.entries.filter(entry => entry.importable).length;
  // A `.pk3`/`.zip` that only holds a compiled map is a compiled map too, and saying "0 compiled"
  // beside three of them would be the same kind of half-truth this browser exists to avoid.
  const compiled = result.entries.filter(entry => entry.holds === 'bsp').length;
  return `${total} map file${total === 1 ? '' : 's'} in the Projects folder: ${importable} importable` +
    (compiled ? `, ${compiled} compiled map${compiled === 1 ? '' : 's'}` : '') +
    (result.truncated ? ' — the listing stopped at its limit' : '');
}
