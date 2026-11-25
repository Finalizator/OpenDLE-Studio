// The artwork a compiled map refers to, as project assets.
//
// A `.bsp` names its materials and nothing more, so the pictures come from wherever the format keeps
// them:
//
//   * Quake 1 and Half-Life embed the textures in the map itself — a `miptex` directory of 8-bit
//     images, four mip levels each, indexed into a palette that is *not* in the file. The palette
//     lives in a WAD3 (`gfx/palette.lmp` inside `halflife.wad`) or as a bare `palette.lmp`, so one is
//     looked for beside the map and in the Projects folder. Without one the images are readable and
//     their colours are not, which is reported rather than guessed at.
//   * Quake 2 and Quake 3 ship their textures beside the map, in the `.pk3` that holds it:
//     `textures/<shader>.tga|jpg|png`. JPEG and PNG are handed to the browser as they are; TGA is not
//     a format a browser draws, so it is decoded here and re-encoded as PNG.
//
// Everything becomes a project asset (`{ id, name, kind: 'texture', width, height, src }`) with a `src`
// data URL, which is the same shape a WAD import produces.

import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { LIMITS } from '../shared/limits.js';
import { listArchive, readArchiveEntries } from './local-maps.js';

/** How large a WAD or archive may be before it is not worth opening for a palette. */
const PALETTE_FILE_LIMIT = 128 * 1024 * 1024;
/**
 * How many folders a hunt looks in.
 *
 * A folder of game data grows deep — `ascentoftitan-1-1/maps/...`, a mod's `textures/...` — and the
 * cap that stopped a runaway walk also stopped it before reaching a WAD someone had just dropped in
 * the last folder alphabetically. A few hundred `readdir` calls cost milliseconds; the expensive part
 * is opening an archive, and that is cached per file.
 */
const PALETTE_FOLDER_LIMIT = 512;
/**
 * How many other archives and WADs are searched for a texture the map does not carry.
 *
 * A Quake 3 map only carries what its mapper added; the rest of its shaders live in `baseq3`'s
 * `pak0.pk3`, and a Half-Life map's textures may live in `halflife.wad` rather than in the map. Both
 * are found by dropping the file anywhere under `Projects/`, and the search is bounded so a folder
 * full of game data cannot turn one import into a scan.
 */
const SOURCE_LIMIT = 12;
/** A texture archive larger than this is not opened at all. */
const SOURCE_FILE_LIMIT = 2 * 1024 * 1024 * 1024;
/** The image extensions a Quake 2 / Quake 3 map's shaders are stored with, in the order tried. */
const IMAGE_EXTENSIONS = ['tga', 'jpg', 'jpeg', 'png'];

const MiB = 1024 * 1024;

function cstring(bytes, offset, length) {
  let end = offset;
  const limit = Math.min(offset + length, bytes.length);
  while (end < limit && bytes[end] !== 0) end++;
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, end - offset).toString('latin1');
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------------------------------

/**
 * The 768 palette bytes of a WAD3 or a bare `palette.lmp`, or null.
 *
 * A WAD3 keeps `gfx/palette.lmp` as one of its lumps; Half-Life's own `halflife.wad` is where every
 * texture the game ever drew found its colours. A `.lmp` on its own is the same 768 bytes.
 */
export function readPalette(bytes) {
  if (!bytes || bytes.length < 768) return null;
  const magic = cstring(bytes, 0, 4);
  if (magic === 'WAD3' || magic === 'WAD2') {
    if (bytes.length < 12) return null;
    const view = viewOf(bytes);
    const count = view.getInt32(4, true), directory = view.getInt32(8, true);
    if (count < 0 || directory < 0 || directory + count * 32 > bytes.length) return null;
    for (let index = 0; index < count; index++) {
      const at = directory + index * 32;
      const name = cstring(bytes, at + 16, 16).toLowerCase();
      if (name !== 'gfx/palette.lmp' && name !== 'palette.lmp' && name !== 'gfx/palette') continue;
      const offset = view.getInt32(at, true);
      if (offset < 0 || offset + 768 > bytes.length) continue;
      return Uint8Array.from(bytes.subarray(offset, offset + 768));
    }
    return null;
  }
  // A bare palette lump is 768 bytes, sometimes padded to 1024 with a transparent colour after it.
  // Anything else is some other kind of file, and taking its first 768 bytes for a palette would
  // colour every texture with the opening of a WAD's directory.
  if (bytes.length === 768 || bytes.length === 1024) return Uint8Array.from(bytes.subarray(0, 768));
  return null;
}

/**
 * A palette for a map that needs one, found where a Half-Life install or a mapper would put it.
 *
 * The map's own folder comes first, then the Projects folder: an import must not wander outside it.
 * The result is cached per folder because a level of a thousand textures asks once.
 */
export function findPalette(root, relativePath, cache = new Map()) {
  const base = resolve(root);
  const start = relativePath && relativePath.includes('/')
    ? join(base, relativePath.slice(0, relativePath.lastIndexOf('/')))
    : base;
  const folders = [];
  // The map's own folder first, then the whole Projects tree: a `halflife.wad` is usually kept in a
  // folder of its own beside `Maps/`, and looking only *down* from the map missed it entirely.
  const queue = [start.startsWith(base) ? start : base, base];
  const seen = new Set();
  while (queue.length && folders.length < PALETTE_FOLDER_LIMIT) {
    const folder = queue.shift();
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) queue.push(join(folder, entry.name));
    }
  }
  for (const folder of folders) {
    if (cache.has(folder)) { if (cache.get(folder)) return cache.get(folder); continue; }
    let entries;
    try { entries = readdirSync(folder); } catch { cache.set(folder, null); continue; }
    let found = null;
    for (const name of entries.sort()) {
      const file = join(folder, name);
      const extension = extname(name).toLowerCase();
      if (extension !== '.wad' && extension !== '.lmp') continue;
      let info;
      try { info = lstatSync(file); } catch { continue; }
      if (!info.isFile() || info.size < 768 || info.size > PALETTE_FILE_LIMIT) continue;
      try {
        found = readPalette(readFileSync(file));
      } catch { found = null; }
      if (found) break;
    }
    cache.set(folder, found);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Half-Life and Quake: textures inside the map
// ---------------------------------------------------------------------------------------------------

/**
 * The miptex directory of a compiled Quake or Half-Life map: one entry per texture.
 *
 * Entry layout is `name[16]`, width, height, then four mip offsets — the first is the base image as
 * `width * height` palette indices.
 */
export function miptexTextures(bytes, info) {
  const lump = info?.lumps?.[2];
  const textures = new Map();
  if (!lump || lump.length < 4) return textures;
  const view = viewOf(bytes);
  const count = view.getInt32(lump.offset, true);
  if (count < 0 || 4 + count * 4 > lump.length) return textures;
  for (let index = 0; index < count; index++) {
    const entry = lump.offset + view.getInt32(lump.offset + 4 + index * 4, true);
    if (entry < lump.offset || entry + 40 > lump.offset + lump.length) continue;
    const name = cstring(bytes, entry, 16);
    const width = view.getUint32(entry + 16, true), height = view.getUint32(entry + 20, true);
    const data = entry + view.getUint32(entry + 24, true);
    if (!name || !width || !height || width > LIMITS.imageSize || height > LIMITS.imageSize) continue;
    if (data + width * height > bytes.length) continue;
    textures.set(name.toLowerCase(), { name, width, height, data, masked: name.startsWith('{') });
  }
  return textures;
}

/** One miptex as RGBA, through the palette the map's game would have used. */
export function miptexPixels(entry, palette) {
  const pixels = new Uint8ClampedArray(entry.width * entry.height * 4);
  for (let index = 0; index < entry.width * entry.height; index++) {
    const colour = entry.data[index];
    pixels[index * 4] = palette[colour * 3];
    pixels[index * 4 + 1] = palette[colour * 3 + 1];
    pixels[index * 4 + 2] = palette[colour * 3 + 2];
    // Half-Life marks a cut-out texture with a leading `{`, and its transparent colour is the last
    // palette entry. Everything else is opaque.
    pixels[index * 4 + 3] = entry.masked && colour === 255 ? 0 : 255;
  }
  return pixels;
}

// ---------------------------------------------------------------------------------------------------
// Quake 2 and Quake 3: textures beside the map
// ---------------------------------------------------------------------------------------------------

/**
 * A Truevision TGA image as RGBA, or null.
 *
 * Quake maps are full of TGA and no browser draws one, so it is decoded here: the two uncompressed
 * truecolour forms and their run-length encoded twins cover every texture id software shipped.
 */
export function decodeTga(bytes) {
  if (!bytes || bytes.length < 18) return null;
  const view = viewOf(bytes);
  const idLength = bytes[0], colourMap = bytes[1], kind = bytes[2];
  const width = view.getUint16(12, true), height = view.getUint16(14, true);
  const depth = bytes[16], descriptor = bytes[17];
  if (!width || !height || colourMap || (kind !== 2 && kind !== 10)) return null;
  if (depth !== 24 && depth !== 32) return null;
  if (width > LIMITS.imageSize || height > LIMITS.imageSize) return null;
  const step = depth / 8;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let offset = 18 + idLength;
  const topDown = (descriptor & 0x20) !== 0;
  const put = (index, source) => {
    const row = topDown ? Math.floor(index / width) : height - 1 - Math.floor(index / width);
    const column = index % width;
    const target = (row * width + column) * 4;
    pixels[target] = source[2];
    pixels[target + 1] = source[1];
    pixels[target + 2] = source[0];
    pixels[target + 3] = step === 4 ? source[3] : 255;
  };
  if (kind === 2) {
    for (let index = 0; index < width * height; index++) {
      if (offset + step > bytes.length) return null;
      put(index, bytes.subarray(offset, offset + step));
      offset += step;
    }
    return { width, height, pixels };
  }
  let index = 0;
  while (index < width * height) {
    if (offset >= bytes.length) return null;
    const header = bytes[offset++];
    const run = (header & 0x7f) + 1;
    if (header & 0x80) {
      if (offset + step > bytes.length) return null;
      const colour = bytes.subarray(offset, offset + step);
      offset += step;
      for (let repeat = 0; repeat < run && index < width * height; repeat++, index++) put(index, colour);
    } else {
      for (let repeat = 0; repeat < run && index < width * height; repeat++, index++) {
        if (offset + step > bytes.length) return null;
        put(index, bytes.subarray(offset, offset + step));
        offset += step;
      }
    }
  }
  return { width, height, pixels };
}

/** The size of a JPEG or PNG without decoding it, so an asset can describe the picture it holds. */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 26) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = viewOf(bytes);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    // Every start-of-frame marker carries the picture's size; the arithmetic-coded ones do too.
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** A JPEG as RGBA, through the one decoder this package brings. */
export function decodeJpeg(bytes) {
  try {
    const { width, height, data } = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    if (!width || !height || width > LIMITS.imageSize || height > LIMITS.imageSize) return null;
    return { width, height, pixels: new Uint8ClampedArray(data) };
  } catch { return null; }
}

/** An image as a PNG data URL, which is the only kind a project asset holds. */
function pngDataUri(image) {
  if (!image) return null;
  return `data:image/png;base64,${PNG.sync.write({ width: image.width, height: image.height,
    data: Buffer.from(image.pixels) }).toString('base64')}`;
}

/** The name a Quake shader's picture has in the archive, trying the extensions a mod uses. */
function pictureNameFor(shader, available) {
  const base = shader.toLowerCase();
  const candidates = [];
  const extension = extname(base).slice(1);
  if (IMAGE_EXTENSIONS.includes(extension)) candidates.push(base);
  for (const kind of IMAGE_EXTENSIONS) candidates.push(`${base}.${kind}`);
  return candidates.map(name => available.get(name)).find(Boolean) || null;
}

// ---------------------------------------------------------------------------------------------------
// The whole job
// ---------------------------------------------------------------------------------------------------

/**
 * The files under `Projects/` that could hold textures the map does not: archives (a `.pk3` and a
 * `.zip` are the same thing) and WAD3s. The map's own archive is excluded — it has already been read.
 *
 * The list is cached per folder because a level names a hundred textures and the same three archives
 * answer all of them.
 */
export function textureSources(root, { exclude = null } = {}) {
  const base = resolve(root);
  const archives = [], wads = [];
  const queue = [base], seen = new Set();
  let folders = 0;
  while (queue.length && folders < PALETTE_FOLDER_LIMIT) {
    const folder = queue.shift();
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders++;
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { queue.push(path); continue; }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      let info;
      try { info = lstatSync(path); } catch { continue; }
      if (!info.size || info.size > SOURCE_FILE_LIMIT) continue;
      // The stamp is what makes a cached index honest: a file that was replaced is a new source.
      const source = { file: path, key: `${path}:${info.mtimeMs}:${info.size}` };
      if (extension === '.pk3' || extension === '.zip' || extension === '.pke' || extension === '.pk7') archives.push(source);
      else if (extension === '.wad') {
        // Four bytes decide whether a WAD is a source; reading a 50 MB IWAD whole for them would
        // make an import wait on the disk once per Doom WAD in the folder.
        let head = null;
        try {
          const handle = openSync(path, 'r');
          try {
            const buffer = Buffer.alloc(4);
            readSync(handle, buffer, 0, 4, 0);
            head = buffer;
          } finally { closeSync(handle); }
        } catch { head = null; }
        if (head && cstring(head, 0, 4) === 'WAD3') wads.push(source);
      }
    }
  }
  // The walk is cheap — directory entries only — and it is what notices a file someone has just
  // dropped in. What is cached is the *index* of each archive, which is the expensive part.
  //
  // `pak0.pk3` is the name every Quake 2/3 game ships its stock art under, so those are looked at
  // first: a folder of unrelated mod archives must not push the one that matters out of the list.
  const keep = source => source.file !== exclude;
  const priority = source => (/^pak\d+\.(pk3|zip|pak)$/i.test(basename(source.file)) ? 0 : 1);
  const order = (a, b) => priority(a) - priority(b) || a.file.localeCompare(b.file);
  return { archives: archives.filter(keep).sort(order).slice(0, SOURCE_LIMIT),
    wads: wads.filter(keep).sort(order).slice(0, SOURCE_LIMIT) };
}

/**
 * The miptex directory of a WAD3, by texture name.
 *
 * A Half-Life map that does not embed a texture references the WAD it lives in — `halflife.wad`
 * usually — so the picture is in a file the person already has, just not in the map.
 */
export function wadMiptexIndex(source, cache = new Map()) {
  const key = typeof source === 'string' ? source : source.key;
  const file = typeof source === 'string' ? source : source.file;
  if (cache.has(key)) return cache.get(key);
  const index = new Map();
  let bytes;
  try { bytes = readFileSync(file); } catch { cache.set(key, index); return index; }
  if (cstring(bytes, 0, 4) !== 'WAD3' || bytes.length < 12) { cache.set(key, index); return index; }
  const view = viewOf(bytes);
  const count = view.getInt32(4, true), directory = view.getInt32(8, true);
  if (count < 0 || directory < 0 || directory + count * 32 > bytes.length) { cache.set(key, index); return index; }
  for (let entry = 0; entry < count; entry++) {
    const at = directory + entry * 32;
    const offset = view.getInt32(at, true), size = bytes.readUInt32LE(at + 4);
    if (offset < 0 || size < 40 || offset + 40 > bytes.length) continue;
    const name = cstring(bytes, offset, 16);
    const width = view.getUint32(offset + 16, true), height = view.getUint32(offset + 20, true);
    const data = offset + view.getUint32(offset + 24, true);
    if (!name || !width || !height || width > LIMITS.imageSize || height > LIMITS.imageSize) continue;
    if (data + width * height > bytes.length) continue;
    index.set(name.toLowerCase(), { name, width, height, data, masked: name.startsWith('{'), bytes });
  }
  cache.set(key, index);
  return index;
}

/** A stable asset id for a texture name, so importing the same map twice does not duplicate it. */
const textureId = name => `asset_tex_${createHash('sha1').update(name).digest('hex').slice(0, 10)}`;

/**
 * The pictures a compiled map needs, as project assets.
 *
 * `archive` is `{ list, read }` for a map that came out of a `.pk3` or `.zip` and nothing at all for a
 * map on disk, and `relativePath` is where the map sits inside the Projects folder. Nothing here
 * fails an import: a map whose artwork cannot be found imports with its texture *names* and a line
 * saying what is missing, which is exactly what it did before any of this existed.
 */
export async function compiledMapAssets({ bytes, info, parsed, root, relativePath, archive, exclude = null, paletteCache, sourceCache } = {}) {
  const assets = [], materials = new Map(), warnings = [];
  const name = parsed?.name || 'the map';
  const wanted = new Set();
  for (const entity of parsed?.entities || []) {
    for (const brush of entity.brushes || []) {
      for (const face of brush.faces || []) if (face.texture) wanted.add(face.texture);
    }
  }
  if (!wanted.size) return { assets, materials, warnings };

  const add = (texture, width, height, src) => {
    if (assets.length >= LIMITS.assets) return null;
    const id = textureId(texture);
    if (materials.has(texture)) return materials.get(texture);
    assets.push({ id, name: texture.slice(0, 100), kind: 'texture', width, height, offsetX: 0, offsetY: 0, src });
    materials.set(texture, id);
    return id;
  };

  const missing = Number(info?.version) >= 38
    ? await archiveTextures({ wanted, archive, root, exclude, sourceCache, add, warnings, name })
    : await wadTextures({ wanted, bytes, info, root, relativePath, exclude, paletteCache, sourceCache, add, warnings, name });

  if (missing.size) {
    warnings.push(`${name}: ${missing.size} of its ${wanted.size} textures could not be found; those faces keep the renderer's own material. `
      + `${Number(info?.version) >= 38
        ? 'A Quake 2/3 map takes its pictures from the .pk3 beside it — put the archive that holds them (baseq3\'s pak0.pk3) anywhere under Projects/ and import again.'
        : 'A Half-Life map takes the textures it does not embed from a WAD3 — put halflife.wad under Projects/ and import again.'}`);
  }
  return { assets, materials, warnings };
}

/** An archive's own listing as a lower-case lookup, so a shader's case does not decide the match. */
async function archiveIndex(source, cache) {
  if (cache.has(source.key)) return cache.get(source.key);
  const names = await listArchive(source.file);
  const index = names ? new Map(names.map(entry => [entry.toLowerCase(), entry])) : new Map();
  cache.set(source.key, index);
  return index;
}

/** One picture file as an asset: PNG travels as it is, TGA and JPEG are decoded and re-encoded. */
function pictureAsset(data, extension) {
  if (!data?.length) return null;
  const decoded = extension === 'png' ? null : extension === 'tga' ? decodeTga(data) : decodeJpeg(data);
  const src = extension === 'png'
    ? `data:image/png;base64,${Buffer.from(data).toString('base64')}`
    : pngDataUri(decoded);
  const size = extension === 'png' ? imageSize(data) : decoded;
  return src && size ? { src, width: size.width, height: size.height } : null;
}

/**
 * A Quake 2/3 map's textures: its own archive first, then any other archive under `Projects/`.
 *
 * A mapper's `.pk3` carries only what they added; the rest of a Quake 3 map's shaders are stock
 * `baseq3` textures that live in `pak0.pk3`. Dropping that file under `Projects/` is what makes the
 * difference between a level with seven textures and one with all of them.
 */
async function archiveTextures({ wanted, archive, root, exclude, sourceCache, add, warnings, name }) {
  const missing = new Set(wanted);
  const take = (index, dataFor, from) => {
    let found = 0;
    for (const shader of [...missing]) {
      const picture = pictureNameFor(shader, index);
      if (!picture) continue;
      const data = dataFor(picture);
      const asset = data && pictureAsset(data, extname(picture).slice(1).toLowerCase());
      if (!asset) continue;
      add(shader, asset.width, asset.height, asset.src);
      missing.delete(shader);
      found++;
    }
    if (found) warnings.push(`${name}: ${found} texture${found === 1 ? '' : 's'} from ${from}`);
    return found;
  };

  if (archive) {
    const available = new Map(((await archive.list()) || []).map(entry => [entry.toLowerCase(), entry]));
    if (available.size) {
      const pending = new Map();
      for (const shader of missing) {
        const picture = pictureNameFor(shader, available);
        if (picture) pending.set(picture, await archive.read(picture));
      }
      take(available, picture => pending.get(picture), 'the map\'s own archive');
    }
  }
  if (!missing.size || !root) return missing;

  const indexes = sourceCache?.archives || new Map();
  const { archives } = textureSources(root, { exclude });
  for (const source of archives) {
    if (!missing.size) break;
    const index = await archiveIndex(source, indexes);
    if (!index.size) continue;
    const pictures = new Map();
    for (const shader of missing) {
      const picture = pictureNameFor(shader, index);
      if (picture) pictures.set(shader, picture);
    }
    if (!pictures.size) continue;
    const bytes = await readArchiveEntries(source.file, [...pictures.values()].map(stored => index.get(stored.toLowerCase())));
    const byPicture = new Map();
    for (const [stored, data] of bytes) byPicture.set(stored, data);
    take(index, picture => byPicture.get(index.get(picture.toLowerCase())), basename(source.file));
  }
  return missing;
}

/**
 * A Quake 1 / Half-Life map's textures: the ones embedded in the map, then the ones its WAD3s hold.
 *
 * Both are palette indices, so the palette is what turns either into a picture — and it is found in
 * the same place the textures are, which is why a `halflife.wad` in `Projects/` fixes both at once.
 */
async function wadTextures({ wanted, bytes, info, root, relativePath, exclude, paletteCache, sourceCache, add, warnings, name }) {
  const missing = new Set(wanted);
  const embedded = miptexTextures(bytes, info);
  const palette = findPalette(root, relativePath, paletteCache);
  if (!palette) {
    warnings.push(`${name}: its ${wanted.size} textures are textures the game indexes into a palette, and that palette is not under Projects/ — `
      + 'put halflife.wad there (or a palette.lmp) and import again');
    return missing;
  }
  let pixels = 0;
  const store = (texture, entry) => {
    pixels += entry.width * entry.height;
    if (pixels > LIMITS.assetPixels) return false;
    const source = miptexPixels({ ...entry, data: entry.bytes ? entry.bytes.subarray(entry.data, entry.data + entry.width * entry.height)
      : bytes.subarray(entry.data, entry.data + entry.width * entry.height) }, palette);
    add(texture, entry.width, entry.height,
      `data:image/png;base64,${PNG.sync.write({ width: entry.width, height: entry.height, data: Buffer.from(source) }).toString('base64')}`);
    return true;
  };
  let fromMap = 0;
  for (const texture of [...missing]) {
    const entry = embedded.get(String(texture).toLowerCase());
    if (!entry || !store(texture, entry)) continue;
    missing.delete(texture);
    fromMap++;
  }
  if (fromMap) warnings.push(`${name}: ${fromMap} texture${fromMap === 1 ? '' : 's'} embedded in the map`);
  if (!missing.size || !root) return missing;

  const indexes = sourceCache?.wads || new Map();
  const { wads } = textureSources(root, { exclude });
  for (const source of wads) {
    if (!missing.size) break;
    const index = wadMiptexIndex(source, indexes);
    let found = 0;
    for (const texture of [...missing]) {
      const entry = index.get(String(texture).toLowerCase());
      if (!entry || !store(texture, entry)) continue;
      missing.delete(texture);
      found++;
    }
    if (found) warnings.push(`${name}: ${found} texture${found === 1 ? '' : 's'} from ${basename(source.file)}`);
  }
  return missing;
}

/** A colour word for a report: how much artwork came across. */
export function describeAssets(assets) {
  if (!assets?.length) return null;
  const bytes = assets.reduce((total, asset) => total + (asset.src?.length || 0), 0);
  return `${assets.length} texture${assets.length === 1 ? '' : 's'} (${(bytes / MiB).toFixed(1)} MB)`;
}
