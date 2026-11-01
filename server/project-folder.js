/**
 * The project folder: a project on disk as `project.json` plus its own asset files.
 *
 * A project is mostly bytes that are not its document. Importing Doom 2 produces a couple of
 * thousand sprites and sounds, and keeping them as base64 inside one JSON file made a 137 MiB
 * document that had to be parsed whole to read one number, could not be diffed, and grew again
 * on every save. The folder format keeps the document readable and the payloads as the files
 * they are:
 *
 * ```
 * projects/<id>/project.json   the document, with `file` where an asset's bytes used to be
 * projects/<id>/assets/*.png   one file per unique payload, named from the asset and its hash
 * ```
 *
 * Nothing about the engine changes: an asset's `src` is still a data URL once the project is
 * loaded, because that is what the renderer, the audio player and a portable build all read.
 * The split happens on the way to disk and the join on the way back — this module is the only
 * place that knows the difference.
 *
 * Identical payloads share one file (the hash is in the name), so a route's two copies of the
 * same sound are one file, and a save only writes files it has not written before.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, posix, relative, resolve } from 'node:path';

/** Written into `project.json` so a reader knows the assets live beside it. */
export const FOLDER_VERSION = 2;
export const PROJECT_FILE = 'project.json';
export const ASSET_DIRECTORY = 'assets';
/**
 * Sections that dwarf everything else and therefore get a file of their own.
 *
 * The actor table is the imported WAD's DECORATE/state data (34 MiB in the Doom 2 import) and the
 * game is the campaign built from it (24 MiB). Keeping them beside the document rather than in it
 * is what leaves `project.json` small enough to open and read, which is the point of the folder.
 */
export const SECTION_FILES = { actors: 'actors.json', game: 'game.json' };
/** A document this large is written compact; below it, indented so it can be read. */
const PRETTY_LIMIT = 2 * 1024 * 1024;

/** The JSON bytes of a document or a section, indented while it is small enough to read. */
export function documentBytes(value) {
  const compact = JSON.stringify(value);
  return Buffer.from(`${compact.length <= PRETTY_LIMIT ? JSON.stringify(value, null, 2) : compact}\n`, 'utf8');
}

const MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tga': 'tga', 'image/x-tga': 'tga',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a',
  'audio/midi': 'mid', 'audio/x-midi': 'mid', 'audio/x-mus': 'mus',
  'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf', 'model/obj': 'obj',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/json': 'json', 'text/plain': 'txt', 'application/octet-stream': 'bin',
};
const EXTENSION_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', tga: 'image/tga', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/opus',
  flac: 'audio/flac', m4a: 'audio/mp4', mid: 'audio/midi', mus: 'audio/x-mus', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  obj: 'model/obj', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  json: 'application/json', txt: 'text/plain', bin: 'application/octet-stream',
};

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

/** A file name built from what the asset is called, so a folder can be browsed by a person. */
export function assetFileName(asset, mime, digest) {
  const base = String(asset?.name || asset?.id || 'asset').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';
  return `${base}-${digest.slice(0, 8)}.${MIME_EXTENSIONS[mime] || 'bin'}`;
}

/**
 * Splits a project into the document and the payload files beside it.
 *
 * Returns `{ document, files }` where `files` is `[{ path, bytes }]` with paths relative to the
 * project folder and `/` separators. The caller writes them; nothing here touches the disk.
 */
export function packProject(project, { revision = 0 } = {}) {
  const document = structuredClone(project);
  const files = new Map(), shared = new Map();
  let inline = 0, split = 0;
  for (const asset of document.assets || []) {
    const src = asset.src;
    if (typeof src !== 'string') continue;
    const match = DATA_URL.exec(src);
    // A `src` that is already a URL or a blob stays in the document: only bytes we hold move.
    if (!match || !match[2]) { inline++; continue; }
    const mime = (match[1] || 'application/octet-stream').toLowerCase();
    const bytes = Buffer.from(match[3], 'base64');
    const digest = createHash('sha1').update(bytes).digest('hex');
    // Identical bytes are one file, named after the first asset that carried them: a route's
    // repeated sound and a texture used by two materials are stored and shipped once.
    const path = shared.get(digest) || posix.join(ASSET_DIRECTORY, assetFileName(asset, mime, digest));
    shared.set(digest, path);
    files.set(path, bytes);
    delete asset.src;
    asset.file = path;
    // The extension carries most mime types, but not all of them — a Doom MUS track and a WAV
    // both deserve their own name, and an exotic type has to be written down or it comes back as
    // application/octet-stream and the asset fails the validation that reads it.
    const implied = EXTENSION_MIME[extname(path).slice(1).toLowerCase()];
    if (implied !== mime) asset.srcMime = mime;
    split++;
  }
  // The imported bundles get their own file, so the document a person opens is the document they
  // edit: paths, events, variables, HUD — not a megabyte of actor states.
  const sections = {};
  for (const [key, name] of Object.entries(SECTION_FILES)) {
    if (document[key] === undefined) continue;
    sections[key] = name;
    files.set(name, documentBytes(document[key]));
    delete document[key];
  }
  return {
    document: { version: FOLDER_VERSION, format: 'project-folder', revision, sections, project: document },
    files: [...files].map(([path, bytes]) => ({ path, bytes })),
    assets: split,
    inline,
  };
}

/**
 * Reads one file of a project folder, refusing anything that would escape it.
 *
 * A project document can be hand-edited, so a path in it is untrusted input: the resolved file
 * has to stay inside the project folder, and a missing file is `null` (reported by the caller).
 */
export function readFolderFile(directory, path) {
  const root = resolve(directory), target = resolve(root, path);
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  try { return readFileSync(target); }
  catch { return null; }
}

/**
 * Rebuilds a project from a folder document, putting each asset's bytes back as a data URL.
 *
 * `read(path)` returns the bytes of one file (or throws when it is missing). A document that was
 * never split — an old single-file project — comes back unchanged.
 */
export function unpackProject(document, read = null) {
  const project = structuredClone(document.project);
  const missing = [];
  // A section lives in its own file; the document names it so the project comes back whole.
  for (const [key, name] of Object.entries(document.sections || {})) {
    const bytes = read ? read(name) : null;
    if (!bytes) { missing.push(name); continue; }
    try { project[key] = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error(`Project section ${name} is not valid JSON (${error.message})`); }
  }
  for (const asset of project.assets || []) {
    if (!asset.file) continue;
    const mime = asset.srcMime || EXTENSION_MIME[extname(asset.file).slice(1).toLowerCase()] || 'application/octet-stream';
    const bytes = read ? read(asset.file) : null;
    if (!bytes) { missing.push(asset.file); continue; }
    asset.src = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    delete asset.file;
    delete asset.srcMime;
  }
  if (missing.length) throw new Error(`Project asset files are missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
  return { project, revision: Number.isSafeInteger(document.revision) ? document.revision : 0 };
}

/** True when a parsed `project.json` names files beside it rather than holding the bytes. */
export function isFolderDocument(saved) {
  return Boolean(saved) && saved.format === 'project-folder' && typeof saved.project === 'object' && saved.project !== null;
}

/** The zip entries of a project folder: the document first, then its assets. */
export function projectZipEntries(project, { revision = 0 } = {}) {
  const { document, files } = packProject(project, { revision });
  return [
    { path: PROJECT_FILE, data: documentBytes(document), mode: 0o644 },
    ...files.map(file => ({ path: file.path, data: file.bytes, mode: 0o644 })),
  ];
}

