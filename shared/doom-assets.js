import { doomSound } from './sound.js';
const decoder = new TextDecoder('ascii');
export function doomName(bytes) {
  return decoder.decode(bytes).replace(/\0.*$/, '').toUpperCase();
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function image(width, height) {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= 2048 && height <= 2048, 'Doom image dimensions exceed 2048x2048');
  return { width, height, pixels: new Uint8Array(width * height * 4), offsetX: 0, offsetY: 0 };
}
function pixel(target, index, palette, color) {
  target[index] = palette[color * 3]; target[index + 1] = palette[color * 3 + 1];
  target[index + 2] = palette[color * 3 + 2]; target[index + 3] = 255;
}

export function decodePatch(bytes, palette) {
  check(bytes.length >= 8 && palette.length >= 768, 'Truncated Doom patch or palette');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = image(view.getUint16(0, true), view.getUint16(2, true));
  result.offsetX = view.getInt16(4, true); result.offsetY = view.getInt16(6, true);
  check(8 + result.width * 4 <= bytes.length, 'Truncated Doom patch column table');
  for (let x = 0; x < result.width; x++) {
    let cursor = view.getUint32(8 + x * 4, true), previous = -1, posts = 0;
    check(cursor >= 8 + result.width * 4, 'Doom patch column points into its header');
    while (true) {
      check(cursor < bytes.length && ++posts <= 4096, 'Unterminated Doom patch column');
      const top = bytes[cursor++];
      if (top === 255) break;
      check(cursor + 2 <= bytes.length, 'Truncated Doom patch post');
      const length = bytes[cursor++]; cursor++;
      const y = top <= previous ? previous + top : top;
      previous = y;
      check(cursor + length + 1 <= bytes.length, 'Doom patch post exceeds lump bounds');
      check(y + length <= result.height, 'Doom patch post exceeds image height');
      for (let row = 0; row < length; row++) pixel(result.pixels, ((y + row) * result.width + x) * 4, palette, bytes[cursor + row]);
      cursor += length + 1;
    }
  }
  return result;
}

export function decodeFlat(bytes, palette) {
  check(bytes.length === 4096 && palette.length >= 768, 'A classic flat must contain exactly 4096 palette indices');
  const result = image(64, 64);
  for (let i = 0; i < 4096; i++) pixel(result.pixels, i * 4, palette, bytes[i]);
  return result;
}

export function patchNames(bytes) {
  check(bytes.length >= 4, 'Truncated PNAMES');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  check(count <= 65536 && 4 + count * 8 <= bytes.length, 'Invalid PNAMES count');
  return Array.from({ length: count }, (_, index) => doomName(bytes.subarray(4 + index * 8, 12 + index * 8)));
}

export function textureDefinitions(bytes, names) {
  check(bytes.length >= 4, 'Truncated TEXTURE table');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(0, true);
  check(count <= 10000 && 4 + count * 4 <= bytes.length, 'Invalid texture count');
  return Array.from({ length: count }, (_, index) => {
    const offset = view.getUint32(4 + index * 4, true);
    check(offset >= 4 + count * 4 && offset + 22 <= bytes.length, 'Texture offset is out of bounds');
    const width = view.getUint16(offset + 12, true), height = view.getUint16(offset + 14, true);
    check(width > 0 && height > 0 && width <= 2048 && height <= 2048, 'Invalid texture dimensions');
    const patchCount = view.getUint16(offset + 20, true);
    check(patchCount <= 1024 && offset + 22 + patchCount * 10 <= bytes.length, 'Invalid texture patch count');
    const patches = Array.from({ length: patchCount }, (_, i) => {
      const entry = offset + 22 + i * 10, patch = view.getUint16(entry + 4, true);
      check(patch < names.length, 'Texture references an unknown PNAMES index');
      return { x: view.getInt16(entry, true), y: view.getInt16(entry + 2, true), name: names[patch] };
    });
    return { name: doomName(bytes.subarray(offset, offset + 8)), width, height, patches };
  });
}

export function composeTexture(definition, getPatch) {
  const result = image(definition.width, definition.height);
  let work = 0;
  for (const placement of definition.patches) {
    const patch = getPatch(placement.name);
    work += patch.width * patch.height;
    check(work <= 32 * 1024 * 1024, 'Texture composition exceeds pixel budget');
    for (let y = Math.max(0, placement.y); y < Math.min(result.height, placement.y + patch.height); y++) {
      for (let x = Math.max(0, placement.x); x < Math.min(result.width, placement.x + patch.width); x++) {
        const source = ((y - placement.y) * patch.width + x - placement.x) * 4;
        if (patch.pixels[source + 3]) result.pixels.set(patch.pixels.subarray(source, source + 4), (y * result.width + x) * 4);
      }
    }
  }
  return result;
}

export function createDoomAssets(wad, encodeImage, images = new Map()) {
  const lumpMap = new Map(wad.lumps.map(lump => [lump.name, lump]));
  const flats = new Set();
  let inFlats = false;
  for (const lump of wad.lumps) {
    if (/^F(?:F|\d)?_START$/.test(lump.name)) inFlats = true;
    else if (/^F(?:F|\d)?_END$/.test(lump.name)) inFlats = false;
    else if (inFlats) flats.add(lump.name);
  }
  const data = lump => new Uint8Array(wad.buffer, lump.start, lump.size);
  const palette = lumpMap.get('PLAYPAL');
  check(palette && palette.size >= 768, 'No usable PLAYPAL palette. Supply a complete Freedoom IWAD; standalone PWAD assets may need their base IWAD.');
  const colors = data(palette).subarray(0, 768);
  const names = lumpMap.has('PNAMES') ? patchNames(data(lumpMap.get('PNAMES'))) : [];
  const definitions = new Map();
  for (const table of ['TEXTURE1', 'TEXTURE2']) if (lumpMap.has(table)) {
    for (const definition of textureDefinitions(data(lumpMap.get(table)), names)) definitions.set(definition.name, definition);
  }
  const cache = new Map(), assets = [], warnings = new Set(), patchCache = new Map();
  let soundBytes = 0;
  for (const [name, lump] of lumpMap) {
    if (!/^DS[A-Z0-9_]+$/.test(name)) continue;
    let src;
    try { src = doomSound(data(lump)); }
    catch (error) { warnings.add(`Sound ${name} was not imported: ${error.message}`); continue; }
    soundBytes += src.length;
    check(soundBytes <= 64 * 1024 * 1024 && assets.length < 512, 'WAD sound budget exceeded');
    assets.push({ id: `sound_${name}`, name, kind: 'sound', src });
  }
  let totalPixels = 0;
  function patch(name) {
    const external = images.get(`sprite_${name}`) || images.get(`weapon_${name}`) || images.get(`texture_${name}`);
    if (external) return external();
    check(lumpMap.has(name), `Missing patch ${name}`);
    if (!patchCache.has(name)) {
      let decoded;
      try { decoded = decodePatch(data(lumpMap.get(name)), colors); }
      catch (error) { throw new Error(`Doom patch ${name}: ${error.message}`, { cause: error }); }
      totalPixels += decoded.width * decoded.height;
      check(totalPixels <= 32 * 1024 * 1024, 'WAD image decoding exceeds pixel budget');
      patchCache.set(name, decoded);
    }
    return patchCache.get(name);
  }
  function get(name, kind) {
    if (!name || name === '-') return null;
    const key = `${kind}_${name}`;
    if (cache.has(key)) return cache.get(key);
    const external = images.get(`${kind}_${name}`) ||
      (kind === 'sky' || kind === 'flat' ? images.get(`texture_${name}`) : null) ||
      (kind === 'texture' ? images.get(`flat_${name}`) : null);
    if (!external && !lumpMap.has(name) && !definitions.has(name)) {
      warnings.add(`Missing ${kind} ${name}; uses a visible fallback.`); return null;
    }
    let decoded;
    if (external) decoded = external();
    else if (['texture', 'sky'].includes(kind) && definitions.has(name)) decoded = composeTexture(definitions.get(name), patch);
    else if (flats.has(name)) decoded = decodeFlat(data(lumpMap.get(name)), colors);
    else if (kind === 'flat' && lumpMap.get(name)?.size === 4096) decoded = decodeFlat(data(lumpMap.get(name)), colors);
    else if (kind === 'flat' && definitions.has(name)) decoded = composeTexture(definitions.get(name), patch);
    else decoded = patch(name);
    totalPixels += decoded.width * decoded.height;
    check(totalPixels <= 32 * 1024 * 1024 && assets.length < 3000, 'WAD asset budget exceeded');
    const asset = {
      id: /^[a-zA-Z0-9_-]{1,74}$/.test(key) ? `asset_${key}` : `asset_image_${assets.length}`,
      name: name.slice(0, 100), kind, width: decoded.width, height: decoded.height,
      offsetX: decoded.offsetX, offsetY: decoded.offsetY, src: encodeImage(decoded),
    };
    assets.push(asset); cache.set(key, asset.id);
    return asset.id;
  }
  const spriteNames = kind => [...new Set([...lumpMap.keys(), ...[...images.keys()]
    .filter(key => key.startsWith(`${kind}_`)).map(key => key.slice(kind.length + 1))])];
  function spriteFrame(prefix, letter, kind = 'sprite') {
    const rotations = Array(8).fill(null);
    let unrotated;
    for (const name of spriteNames(kind)) {
      if (!name.startsWith(prefix) || !/^[A-Z0-9_]{4}[A-Z][0-8]([A-Z][0-8])?$/.test(name)) continue;
      for (const offset of [4, 6]) {
        if (name[offset] !== letter) continue;
        const rotation = Number(name[offset + 1]), assetId = get(name, kind);
        if (rotation === 0) unrotated = assetId;
        else rotations[rotation - 1] = { assetId, flip: offset === 6 };
      }
    }
    if (unrotated) return unrotated;
    const base = rotations[0] || rotations.find(Boolean);
    if (!base) return null;
    assets.find(asset => asset.id === base.assetId).rotations = rotations.map(view => view || base);
    return base.assetId;
  }
  function sprite(prefix, kind = 'sprite') {
    const available = new Set(spriteNames(kind));
    const preferred = [`${prefix}A0`, `${prefix}A1`].find(name => available.has(name));
    const fallback = [...available].find(name => new RegExp(`^${prefix}[A-Z][0-8]`).test(name));
    return preferred || fallback ? spriteFrame(prefix, (preferred || fallback)[4], kind) : null;
  }
  function materialSequences() {
    const sequences = [
      ['NUKAGE1', 'NUKAGE3', 'flat'], ['FWATER1', 'FWATER4', 'flat'], ['SWATER1', 'SWATER4', 'flat'],
      ['LAVA1', 'LAVA4', 'flat'], ['BLOOD1', 'BLOOD3', 'flat'], ['RROCK05', 'RROCK08', 'flat'],
      ['SLIME01', 'SLIME04', 'flat'], ['SLIME05', 'SLIME08', 'flat'], ['SLIME09', 'SLIME12', 'flat'],
      ['BLODGR1', 'BLODGR4', 'texture'], ['SLADRIP1', 'SLADRIP3', 'texture'], ['BLODRIP1', 'BLODRIP4', 'texture'],
      ['FIREWALA', 'FIREWALL', 'texture'], ['GSTFONT1', 'GSTFONT3', 'texture'],
      ['FIRELAVA', 'FIRELAV3', 'texture'], ['FIREMAG1', 'FIREMAG3', 'texture'], ['FIREBLU1', 'FIREBLU2', 'texture'],
      ['ROCKRED1', 'ROCKRED3', 'texture'], ['BFALL1', 'BFALL4', 'texture'], ['SFALL1', 'SFALL4', 'texture'], ['WFALL1', 'WFALL4', 'texture'],
    ].map(([start, end, kind]) => ({ start, end, kind, seconds: 8 / 35 }));
    const lump = lumpMap.get('ANIMATED');
    if (lump) {
      const bytes = data(lump), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset < bytes.length && bytes[offset] !== 255; offset += 23) {
        check(offset + 23 <= bytes.length, 'Truncated ANIMATED record');
        const kind = bytes[offset] & 1 ? 'texture' : 'flat';
        const end = doomName(bytes.subarray(offset + 1, offset + 10)), start = doomName(bytes.subarray(offset + 10, offset + 19));
        const tics = view.getUint32(offset + 19, true);
        check(tics > 0 && tics <= 2100, 'Invalid ANIMATED frame duration');
        sequences.push({ start, end, kind, seconds: tics / 35 });
      }
    }
    return sequences.flatMap(sequence => {
      const order = sequence.kind === 'flat' ? [...flats] : [...definitions.keys()];
      const start = order.indexOf(sequence.start), end = order.indexOf(sequence.end);
      if (start < 0 || end < start || end - start > 255) return [];
      const names = order.slice(start, end + 1);
      const used = assets.filter(asset => asset.kind === sequence.kind && names.includes(asset.name));
      return used.length ? [{ ...sequence, names, used: used.map(asset => asset.id) }] : [];
    });
  }
  function atlas(name, patches, { offsets = false } = {}) {
    check(patches.length > 0 && patches.length <= 256, 'A WAD atlas needs 1-256 patches');
    const key = `sprite_${name}`;
    check(!cache.has(key) && !lumpMap.has(name), `Duplicate WAD atlas name: ${name}`);
    const decoded = patches.map(name => {
      get(name, 'sprite');
      return patch(name);
    });
    const left = offsets ? Math.min(0, ...decoded.map(item => -item.offsetX)) : 0;
    const top = offsets ? Math.min(0, ...decoded.map(item => -item.offsetY)) : 0;
    const cellWidth = Math.max(...decoded.map(item => item.width - (offsets ? item.offsetX : 0))) - left;
    const cellHeight = Math.max(...decoded.map(item => item.height - (offsets ? item.offsetY : 0))) - top;
    const columns = Math.min(10, patches.length), rows = Math.ceil(patches.length / columns);
    const result = image(cellWidth * columns, cellHeight * rows);
    decoded.forEach((item, index) => {
      const x = index % columns * cellWidth - (offsets ? item.offsetX : 0) - left;
      const y = Math.floor(index / columns) * cellHeight - (offsets ? item.offsetY : 0) - top;
      for (let row = 0; row < item.height; row++) {
        const start = row * item.width * 4;
        result.pixels.set(item.pixels.subarray(start, start + item.width * 4), ((y + row) * result.width + x) * 4);
      }
    });
    totalPixels += result.width * result.height;
    check(totalPixels <= 32 * 1024 * 1024 && assets.length < 3000, 'WAD atlas budget exceeded');
    const asset = { id: `asset_${key}`, name, kind: 'sprite', width: result.width, height: result.height,
      offsetX: left, offsetY: top, src: encodeImage(result) };
    assets.push(asset); cache.set(key, asset.id);
    return { assetId: asset.id, cellWidth, cellHeight, columns, rows, left, top,
      frames: Object.fromEntries(patches.map((name, index) => [name, index])) };
  }
  return { get, sprite, spriteFrame, atlas, materialSequences, assets, warnings, has: name => lumpMap.has(name) || definitions.has(name) ||
    ['sprite', 'weapon', 'texture', 'flat'].some(kind => images.has(`${kind}_${name}`)) };
}

export const doomThings = {
  3004: ['POSS', 'enemy'], 9: ['SPOS', 'enemy'], 65: ['CPOS', 'enemy'], 3001: ['TROO', 'enemy'],
  3002: ['SARG', 'enemy'], 58: ['SARG', 'enemy'], 3006: ['SKUL', 'enemy'], 3005: ['HEAD', 'enemy'],
  69: ['BOS2', 'enemy'], 3003: ['BOSS', 'enemy'], 68: ['BSPI', 'enemy'], 71: ['PAIN', 'enemy'],
  66: ['SKEL', 'enemy'], 67: ['FATT', 'enemy'], 64: ['VILE', 'enemy'], 16: ['CYBR', 'enemy'], 7: ['SPID', 'enemy'],
  2001: ['SHOT', 'pickup'], 82: ['SGN2', 'pickup'], 2002: ['MGUN', 'pickup'], 2003: ['LAUN', 'pickup'],
  2004: ['PLAS', 'pickup'], 2005: ['CSAW', 'pickup'], 2006: ['BFUG', 'pickup'],
  2007: ['CLIP', 'pickup'], 2008: ['SHEL', 'pickup'], 2010: ['ROCK', 'pickup'], 2047: ['CELL', 'pickup'],
  2048: ['AMMO', 'pickup'], 2049: ['SBOX', 'pickup'], 2046: ['BROK', 'pickup'], 17: ['CELP', 'pickup'],
  2011: ['STIM', 'pickup'], 2012: ['MEDI', 'pickup'], 2013: ['SOUL', 'pickup'], 2014: ['BON1', 'pickup'],
  2015: ['BON2', 'pickup'], 2018: ['ARM1', 'pickup'], 2019: ['ARM2', 'pickup'], 83: ['MEGA', 'pickup'],
  8: ['BPAK', 'pickup'],
  5: ['BKEY', 'pickup'], 6: ['YKEY', 'pickup'], 13: ['RKEY', 'pickup'], 38: ['RSKU', 'pickup'],
  39: ['YSKU', 'pickup'], 40: ['BSKU', 'pickup'], 2022: ['PINV', 'pickup'], 2023: ['PSTR', 'pickup'],
  2024: ['PINS', 'pickup'], 2025: ['SUIT', 'pickup'], 2026: ['PMAP', 'pickup'], 2045: ['PVIS', 'pickup'],
  2035: ['BAR1', 'decoration'], 70: ['FCAN', 'decoration'], 2028: ['COLU', 'decoration'],
  34: ['CAND', 'light'], 35: ['CBRA', 'light'], 44: ['TBLU', 'light'], 45: ['TGRN', 'light'],
  46: ['TRED', 'light'], 55: ['SMBT', 'light'], 56: ['SMGT', 'light'], 57: ['SMRT', 'light'],
  48: ['ELEC', 'decoration'], 30: ['COL1', 'decoration'], 31: ['COL2', 'decoration'],
  85: ['TLMP', 'light'], 86: ['TLP2', 'light'],
  32: ['COL3', 'decoration'], 33: ['COL4', 'decoration'], 36: ['COL5', 'decoration'], 37: ['COL6', 'decoration'],
  41: ['CEYE', 'decoration'], 42: ['FSKU', 'decoration'], 43: ['TRE1', 'decoration'], 54: ['TRE2', 'decoration'],
  25: ['POL1', 'decoration'], 26: ['POL6', 'decoration'], 27: ['POL4', 'decoration'], 28: ['POL2', 'decoration'],
  29: ['POL3', 'decoration'], 10: ['PLAY', 'decoration'], 15: ['PLAY', 'decoration'],
};
