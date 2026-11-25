// What is in the Projects folder, and what the engine can do with each map file.
//
// This exists because "put the maps in the Projects folder and press import" did nothing: the file
// picker filtered for `.map` sources and the local library only looked for `*.wad` at the top level,
// so a folder of compiled maps was invisible — the person saw folders and no files. A compiled
// `.bsp` (or a `.pk3` holding one) genuinely cannot be imported yet, and saying so by name is worth
// more than an empty dialog.
//
// Nothing here converts geometry: it reads what is there, reports it honestly, and hands back the
// text of a `.map` source so the importer can read one from the folder instead of a file dialog.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import yauzl from 'yauzl';

/** How many files a browse may list, so a huge folder cannot hang the dialog. */
export const MAP_BROWSER_LIMIT = 400;
/** A map file, as source or compiled. A `.wad` is a Doom level container and has its own import. */
const MAP_PATTERN = /\.(map|bsp|pk3|zip|pak)$/i;
const ARCHIVE_PATTERN = /\.(pk3|zip|pak)$/i;
/** One file, read whole, is bounded: a map source is a few megabytes and a fake is not worth it. */
const READ_LIMIT = 64 * 1024 * 1024;

/** The game a compiled BSP was made for, by the format version in its first four bytes. */
const BSP_ENGINES = new Map([
  [29, 'Quake'],
  [30, 'Half-Life'],
  [38, 'Quake 2'],
  [46, 'Quake 3'],
  [47, 'Quake 3 Team Arena'],
]);

export const bspEngine = version => BSP_ENGINES.get(Number(version)) || null;

/**
 * The header of a compiled map, or null when the bytes are not one.
 *
 * A BSP starts with its format version and then a directory of lumps (15 for Quake, Half-Life and
 * Quake 2; 17 for Quake 3). A file whose version matches but whose lump offsets point outside it is
 * not a BSP, and calling it one would send someone hunting for a bug in the importer instead.
 */
export function bspInfo(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getInt32(0, true);
  const engine = bspEngine(version);
  if (!engine) return null;
  const lumps = version >= 46 ? 17 : 15;
  const directoryEnd = 4 + lumps * 8;
  if (bytes.length >= directoryEnd) {
    for (let index = 0; index < lumps; index++) {
      const offset = view.getInt32(4 + index * 8, true), length = view.getInt32(8 + index * 8, true);
      if (offset < directoryEnd || length < 0 || offset + length > bytes.length) return null;
    }
  }
  return { version, engine, lumps };
}

function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Every file name inside an archive (`.pk3` and Quake's `.pak` are both zips), or null. */
function listArchive(file) {
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
    return { kind: 'map', importable: true, detail: '.map source — importable as a project or a layout' };
  }
  if (extension === '.bsp') {
    let info = null;
    try { info = bspInfo(readFileSync(file)); } catch { info = null; }
    return {
      kind: 'bsp',
      importable: false,
      engine: info?.engine ?? null,
      detail: info
        ? `${info.engine} BSP v${info.version} (compiled) — a compiled map is not read yet; import its .map source`
        : 'compiled map of an unknown format — a .map source is what the importer reads',
    };
  }
  return { kind: extension.slice(1), importable: false, detail: `${sizeText(size)} — inspected for a .map source` };
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
    const compiled = names.filter(name => /\.bsp$/i.test(name));
    entry.inside = (sources.length ? sources : compiled).slice(0, 8);
    if (sources.length) {
      entry.importable = true;
      entry.entry = sources[0];
      entry.detail = `contains ${sources[0]} — map source, importable from here`;
    } else if (compiled.length) {
      entry.detail = `contains ${compiled.slice(0, 3).join(', ')} (compiled) — import the .map source instead`;
    } else {
      entry.detail = 'no .map or .bsp inside';
    }
  }
  // What can be imported first, then source before compiled: the list is for acting on.
  const order = entry => (entry.importable ? 0 : entry.kind === 'bsp' ? 1 : 2);
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
 * The text of a `.map` the browser listed, whether it is a file of its own or an entry in a `.pk3`
 * or `.zip`. This is what makes "import from the Projects folder" possible without a file dialog.
 */
export async function readLocalMapSource(root, path, entry = null) {
  const file = inside(root, path);
  let info;
  try { info = lstatSync(file); } catch { throw new Error(`${path} is no longer there`); }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > READ_LIMIT) throw new Error(`${path} is larger than ${READ_LIMIT / (1024 * 1024)} MiB`);
  if (!entry) {
    if (!/\.map$/i.test(file)) throw new Error(`${path} is not a .map source`);
    return readFileSync(file, 'utf8');
  }
  return new Promise((done, fail) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { fail(new Error(`${path} could not be read as an archive (${error.message})`)); return; }
      let settled = false;
      const stop = next => { if (!settled) { settled = true; fail(next); } };
      zip.on('error', stop);
      zip.on('end', () => stop(new Error(`${path} has no ${entry}`)));
      zip.on('entry', archiveEntry => {
        if (settled) return;
        if (archiveEntry.fileName !== entry) { zip.readEntry(); return; }
        if (!/\.map$/i.test(archiveEntry.fileName)) { stop(new Error(`${entry} is not a .map source`)); return; }
        zip.openReadStream(archiveEntry, (streamError, stream) => {
          if (streamError) { stop(streamError); return; }
          const chunks = [];
          stream.on('error', stop);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => { if (!settled) { settled = true; done(Buffer.concat(chunks).toString('utf8')); } });
        });
      });
      zip.readEntry();
    });
  });
}

/** A one-line summary for the status bar. */
export function describeScan(result) {
  const total = result.entries.length;
  const importable = result.entries.filter(entry => entry.importable).length;
  // A `.pk3`/`.zip` that only holds a compiled map is a compiled map too, and saying "0 compiled"
  // beside three of them would be the same kind of half-truth this browser exists to avoid.
  const compiled = result.entries.filter(entry => entry.kind === 'bsp' ||
    (!entry.importable && entry.inside?.some(name => /\.bsp$/i.test(name)))).length;
  return `${total} map file${total === 1 ? '' : 's'} in the Projects folder: ${importable} importable` +
    (compiled ? `, ${compiled} compiled map${compiled === 1 ? '' : 's'}` : '') +
    (result.truncated ? ' — the listing stopped at its limit' : '');
}
