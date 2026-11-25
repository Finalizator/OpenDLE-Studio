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
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { LIMITS } from '../shared/limits.js';

/** How large a WAD or archive may be before it is not worth opening for a palette. */
const PALETTE_FILE_LIMIT = 128 * 1024 * 1024;
/** How many folders the palette hunt looks in, so a huge Projects folder cannot stall an import. */
const PALETTE_FOLDER_LIMIT = 64;
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
  const queue = [start.startsWith(base) ? start : base];
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
export async function compiledMapAssets({ bytes, info, parsed, root, relativePath, archive, paletteCache } = {}) {
  const assets = [], materials = new Map(), warnings = [];
  const wanted = new Set();
  for (const entity of parsed?.entities || []) {
    for (const brush of entity.brushes || []) {
      for (const face of brush.faces || []) if (face.texture) wanted.add(face.texture);
    }
  }
  if (!wanted.size) return { assets, materials, warnings };

  const add = (name, width, height, src) => {
    if (assets.length >= LIMITS.assets) return null;
    const id = textureId(name);
    if (materials.has(name)) return materials.get(name);
    assets.push({ id, name: name.slice(0, 100), kind: 'texture', width, height, offsetX: 0, offsetY: 0, src });
    materials.set(name, id);
    return id;
  };

  if (Number(info?.version) >= 38) {
    const available = new Map();
    if (archive) {
      // The archive's own listing is the index: a shader names a picture, not a path, and the file's
      // case is whatever the mapper's filesystem had.
      for (const name of (await archive.list()) || []) available.set(name.toLowerCase(), name);
    }
    let missing = 0;
    for (const shader of wanted) {
      const picture = pictureNameFor(shader, available);
      if (!picture) { missing++; continue; }
      const data = await archive.read(picture);
      if (!data) { missing++; continue; }
      const extension = extname(picture).slice(1).toLowerCase();
      // A PNG travels as it is — it is already the format a project stores — and the rest is decoded
      // to pixels and written back out as one.
      const decoded = extension === 'png' ? null : extension === 'tga' ? decodeTga(data) : decodeJpeg(data);
      const src = extension === 'png' ? `data:image/png;base64,${Buffer.from(data).toString('base64')}` : pngDataUri(decoded);
      const size = extension === 'png' ? imageSize(data) : decoded;
      if (!src || !size) { missing++; continue; }
      add(shader, size.width, size.height, src);
    }
    if (missing) warnings.push(`${parsed?.name || 'the map'}: ${missing} of its ${wanted.size} textures are not in the archive; those faces keep the renderer's own material`);
    return { assets, materials, warnings };
  }

  const textures = miptexTextures(bytes, info);
  if (!textures.size) return { assets, materials, warnings };
  const palette = findPalette(root, relativePath, paletteCache);
  if (!palette) {
    warnings.push(`${parsed?.name || 'the map'}: its ${textures.size} textures are embedded here, but the palette they were indexed into is not in the Projects folder — put halflife.wad there (or a palette.lmp) and import again`);
    return { assets, materials, warnings };
  }
  let pixels = 0;
  for (const name of wanted) {
    const entry = textures.get(String(name).toLowerCase());
    if (!entry) continue;
    pixels += entry.width * entry.height;
    if (pixels > LIMITS.assetPixels) break;
    const source = miptexPixels({ ...entry, data: bytes.subarray(entry.data, entry.data + entry.width * entry.height) }, palette);
    const src = `data:image/png;base64,${PNG.sync.write({ width: entry.width, height: entry.height, data: Buffer.from(source) }).toString('base64')}`;
    add(name, entry.width, entry.height, src);
  }
  return { assets, materials, warnings };
}

/** A colour word for a report: how much artwork came across. */
export function describeAssets(assets) {
  if (!assets?.length) return null;
  const bytes = assets.reduce((total, asset) => total + (asset.src?.length || 0), 0);
  return `${assets.length} texture${assets.length === 1 ? '' : 's'} (${(bytes / MiB).toFixed(1)} MB)`;
}
