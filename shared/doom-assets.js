import { parseSurfaceAnimations, rangeNames } from './animdefs.js';
import { LIMITS } from './limits.js';
import { doomSound, encodeMusic } from './sound.js';
import { decodeFON2 } from './doom-font.js';
const decoder = new TextDecoder('ascii');
import { translationLookup, applyTranslation } from './translation.js';

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

// Flats are square palette images; 64x64 is the classic size, and 32x32, 128x128 and
// 256x256 are all in use (modern flats are routinely 256x256).
const FLAT_SIZES = new Map([[1024, 32], [4096, 64], [16384, 128], [65536, 256]]);

/** Four letter sprite name, frame letter, rotation, and an optional mirrored pair. */
const SPRITE_FRAME_NAME = /^[A-Z0-9_]{4}[A-Z][0-9A-G](?:[A-Z][0-9A-G])?$/;

/** GZDoom's rotation character: '0'-'9' then 'A'-'G' for the sixteen view angles. */
function spriteRotation(character) {
  const code = String(character ?? '').toUpperCase().charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 71) return code - 65 + 10;
  return null;
}

export function flatSize(bytes) {
  return FLAT_SIZES.get(bytes?.length) || null;
}

export function decodeFlat(bytes, palette) {
  const size = flatSize(bytes);
  check(size !== null && palette.length >= 768,
    `A flat must be a square palette image (1024, 4096, 16384 or 65536 bytes); this one has ${bytes?.length ?? 0}`);
  const result = image(size, size);
  for (let i = 0; i < bytes.length; i++) pixel(result.pixels, i * 4, palette, bytes[i]);
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

/**
 * ZDoom's text `TEXTURES` format: textures defined as a list of patches.
 *
 * `Texture`, `WallTexture`, `FlatTexture`, `SpriteTexture` and `Graphic` all build one
 * image out of patches, which is how a mod adds a wall texture that exists in no
 * TEXTURE1 table. Patch options such as `FlipX` or `Rotate` are reported instead of
 * silently drawn untransformed.
 */
export function textureDefinitionsFromText(text, { warnings = [], source = 'TEXTURES' } = {}) {
  const clean = String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^\s*#.*$/gm, ' ');
  const definitions = [];
  const guards = [/check ?range ?\{[^}]*\}/i, /(?:pink|blue|gold|red|green)blood ?\{[^}]*\}/i];
  let body = clean;
  for (const guard of guards) body = body.replace(guard, ' ');
  const block = /\b(?:Texture|WallTexture|FlatTexture|SpriteTexture|Graphic)\s+"?([^",\s{}]+)"?\s*,\s*(\d+)\s*,\s*(\d+)[^{]*\{([^}]*)\}/gi;
  for (const match of body.matchAll(block)) {
    const name = match[1], width = Number(match[2]), height = Number(match[3]), patchText = match[4];
    if (!(width > 0 && height > 0 && width <= LIMITS.imageSize && height <= LIMITS.imageSize)) {
      warnings.push(`${source}: texture ${name} has unsupported dimensions ${width}x${height}.`);
      continue;
    }
    const patches = [];
    for (const patch of patchText.matchAll(/\bPatch\s+"?([^",\s{}]+)"?\s*,\s*(-?\d+)\s*,\s*(-?\d+)/gi)) {
      patches.push({ name: patch[1], x: Number(patch[2]), y: Number(patch[3]) });
    }
    // Patch options follow the coordinates; several patches can share a line.
    if (/\b(?:FlipX|FlipY|Rotate)\b/i.test(patchText)) {
      warnings.push(`${source}: ${name} uses rotated or flipped patches, which are not applied yet.`);
    }
    if (!patches.length) { warnings.push(`${source}: texture ${name} lists no patches.`); continue; }
    definitions.push({ name, width, height, patches });
  }
  return definitions;
}

export function composeTexture(definition, getPatch) {
  const result = image(definition.width, definition.height);
  let work = 0;
  for (const placement of definition.patches) {
    const patch = getPatch(placement.name);
    work += patch.width * patch.height;
    check(work <= LIMITS.assetPixels, 'Texture composition exceeds pixel budget');
    for (let y = Math.max(0, placement.y); y < Math.min(result.height, placement.y + patch.height); y++) {
      for (let x = Math.max(0, placement.x); x < Math.min(result.width, placement.x + patch.width); x++) {
        const source = ((y - placement.y) * patch.width + x - placement.x) * 4;
        if (patch.pixels[source + 3]) result.pixels.set(patch.pixels.subarray(source, source + 4), (y * result.width + x) * 4);
      }
    }
  }
  return result;
}

export function createDoomAssets(wad, encodeImage, images = new Map(), fontResources = new Map(), { requirePalette = true, animationSources = [] } = {}) {
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
  check(!requirePalette || palette && palette.size >= 768,
    'No usable PLAYPAL palette. Supply a complete Freedoom IWAD; standalone PWAD assets may need their base IWAD.');
  // Without a palette the palette-indexed artwork cannot be expanded, but a mod that
  // ships only PNG images still imports: the geometry, actors, sounds and images work
  // and the report names what was skipped.
  const colors = palette && palette.size >= 768 ? data(palette).subarray(0, 768) : null;
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
  // Music lumps: standard MIDI ('MThd') or Doom MUS ('MUS\x1a'), usually named D_*.
  let musicBytes = 0, musicCount = 0;
  for (const [name, lump] of lumpMap) {
    if (lump.size < 16) continue;
    const head = data(lump);
    const midi = head[0] === 77 && head[1] === 84 && head[2] === 104 && head[3] === 100;
    const mus = head[0] === 77 && head[1] === 85 && head[2] === 83 && head[3] === 0x1a;
    if (!midi && !mus) continue;
    if (!/^D_[A-Z0-9_]+$/.test(name) && !midi && !mus) continue;
    let src;
    try { src = encodeMusic(head, midi ? 'midi' : 'mus'); }
    catch (error) { warnings.add(`Music ${name} was not imported: ${error.message}`); continue; }
    musicBytes += src.length;
    if (musicBytes > 32 * 1024 * 1024 || ++musicCount > 128) { warnings.add('Music budget exceeded; remaining tracks were skipped.'); break; }
    assets.push({ id: `music_${name}`, name, kind: 'music', format: midi ? 'midi' : 'mus', src });
  }
  let totalPixels = 0;
  const noPalette = () => warnings.add('This game has no PLAYPAL palette, so its palette-based graphics and flats were skipped; import it over a base IWAD to decode them.');
  function patch(name) {
    const external = images.get(`sprite_${name}`) || images.get(`weapon_${name}`) || images.get(`texture_${name}`);
    if (external) return external();
    check(lumpMap.has(name), `Missing patch ${name}`);
    if (!colors) { noPalette(); throw new Error('no palette'); }
    if (!patchCache.has(name)) {
      let decoded;
      try { decoded = decodePatch(data(lumpMap.get(name)), colors); }
      catch (error) { throw new Error(`Doom patch ${name}: ${error.message}`, { cause: error }); }
      totalPixels += decoded.width * decoded.height;
      check(totalPixels <= LIMITS.assetPixels, 'WAD image decoding exceeds pixel budget');
      patchCache.set(name, decoded);
    }
    return patchCache.get(name);
  }
  function get(name, kind) {
    if (!name || name === '-') return null;
    const key = `${kind}_${name}`;
    if (cache.has(key)) return cache.get(key);
    // A mod ships its skies as `graphics/<NAME>`, which this importer files as a sprite, so a
    // sky has to look there too: `sky1 = "NEBUSKY4"` otherwise finds nothing and the map
    // renders against the flat fallback colour.
    const external = images.get(`${kind}_${name}`) ||
      (kind === 'sky' ? images.get(`texture_${name}`) || images.get(`sprite_${name}`) : null) ||
      (kind === 'flat' ? images.get(`texture_${name}`) : null) ||
      (kind === 'texture' ? images.get(`flat_${name}`) : null);
    if (!external && !lumpMap.has(name) && !definitions.has(name)) {
      warnings.add(`Missing ${kind} ${name}; uses a visible fallback.`); return null;
    }
    // Palette-indexed artwork needs the palette; PNG resources in `images` do not.
    if (!external && !colors) { noPalette(); return null; }
    let decoded;
    if (external) decoded = external();
    else if (['texture', 'sky'].includes(kind) && definitions.has(name)) decoded = composeTexture(definitions.get(name), patch);
    else if (flats.has(name)) decoded = decodeFlat(data(lumpMap.get(name)), colors);
    else if (kind === 'flat' && flatSize(lumpMap.get(name) && data(lumpMap.get(name)))) decoded = decodeFlat(data(lumpMap.get(name)), colors);
    else if (kind === 'flat' && definitions.has(name)) decoded = composeTexture(definitions.get(name), patch);
    else decoded = patch(name);
    totalPixels += decoded.width * decoded.height;
    check(totalPixels <= LIMITS.assetPixels && assets.length < LIMITS.assets, 'WAD asset budget exceeded');
    const asset = {
      id: /^[a-zA-Z0-9_-]{1,74}$/.test(key) ? `asset_${key}` : `asset_image_${assets.length}`,
      name: name.slice(0, 100), kind, width: decoded.width, height: decoded.height,
      offsetX: decoded.offsetX, offsetY: decoded.offsetY, src: encodeImage(decoded),
    };
    assets.push(asset); cache.set(key, asset.id);
    return asset.id;
  }
  // The name list is the whole WAD's lump table (three thousand names in an IWAD), and
  // every sprite lookup used to rebuild and de-duplicate it — which made importing a
  // full game quadratic in lumps × sprites. It cannot change while importing.
  const spriteNameCache = new Map();
  const spriteNames = kind => {
    let names = spriteNameCache.get(kind);
    if (!names) {
      names = [...new Set([...lumpMap.keys(), ...[...images.keys()]
        .filter(key => key.startsWith(`${kind}_`)).map(key => key.slice(kind.length + 1))])];
      spriteNameCache.set(kind, names);
    }
    return names;
  };
  // Frames grouped by their four-letter sprite name, so a lookup examines a handful of
  // names instead of every lump in the WAD.
  const spriteGroups = new Map();
  const framesFor = (prefix, kind) => {
    let groups = spriteGroups.get(kind);
    if (!groups) {
      groups = new Map();
      for (const name of spriteNames(kind)) {
        // GZDoom accepts rotation characters 0-9 and A-G (sixteen view angles), and a
        // second frame/rotation pair for mirrored frames. Requiring 0-8 skipped every
        // sixteen-angle sprite frame a mod ships.
        if (!SPRITE_FRAME_NAME.test(name.toUpperCase())) continue;
        const key = name.slice(0, 4).toUpperCase();
        let list = groups.get(key);
        if (!list) groups.set(key, list = []);
        list.push(name);
      }
      spriteGroups.set(kind, groups);
    }
    return groups.get(String(prefix).toUpperCase());
  };
  function spriteFrame(prefix, letter, kind = 'sprite') {
    const rotations = Array(8).fill(null);
    let unrotated;
    for (const name of framesFor(prefix, kind) || []) {
      for (const offset of [4, 6]) {
        if (name[offset] !== letter) continue;
        const rotation = spriteRotation(name[offset + 1]), assetId = get(name, kind);
        if (rotation === 0) unrotated = assetId;
        // Views 9-16 are a sixteen-angle set; the renderer draws eight, so those frames
        // are kept as artwork but never used as a view.
        else if (rotation >= 1 && rotation <= 8) rotations[rotation - 1] = { assetId, flip: offset === 6 };
      }
    }
    if (unrotated) return unrotated;
    const base = rotations[0] || rotations.find(Boolean);
    if (!base) return null;
    assets.find(asset => asset.id === base.assetId).rotations = rotations.map(view => view || base);
    return base.assetId;
  }
  function sprite(prefix, kind = 'sprite') {
    const names = framesFor(prefix, kind) || [];
    const preferred = [`${prefix}A0`, `${prefix}A1`].find(name => names.includes(name));
    const chosen = preferred || names[0];
    return chosen ? spriteFrame(prefix, chosen[4], kind) : null;
  }
  function materialSequences() {
    // ANIMDEFS first, because it overrides the built-in ranges: a mod that re-times the
    // water wants its timing, not Doom's.
    const declared = animatedSurfaces();
    const sequences = [
      ['NUKAGE1', 'NUKAGE3', 'flat'], ['FWATER1', 'FWATER4', 'flat'], ['SWATER1', 'SWATER4', 'flat'],
      ['LAVA1', 'LAVA4', 'flat'], ['BLOOD1', 'BLOOD3', 'flat'], ['RROCK05', 'RROCK08', 'flat'],
      ['SLIME01', 'SLIME04', 'flat'], ['SLIME05', 'SLIME08', 'flat'], ['SLIME09', 'SLIME12', 'flat'],
      ['BLODGR1', 'BLODGR4', 'texture'], ['SLADRIP1', 'SLADRIP3', 'texture'], ['BLODRIP1', 'BLODRIP4', 'texture'],
      ['FIREWALA', 'FIREWALL', 'texture'], ['GSTFONT1', 'GSTFONT3', 'texture'],
      ['FIRELAVA', 'FIRELAV3', 'texture'], ['FIREMAG1', 'FIREMAG3', 'texture'], ['FIREBLU1', 'FIREBLU2', 'texture'],
      ['ROCKRED1', 'ROCKRED3', 'texture'], ['BFALL1', 'BFALL4', 'texture'], ['SFALL1', 'SFALL4', 'texture'], ['WFALL1', 'WFALL4', 'texture'],
    ].filter(([start]) => !declared.some(sequence => sequence.names[0] === start))
      .map(([start, end, kind]) => ({ start, end, kind, seconds: 8 / 35 }));
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
    return [...declared, ...sequences.flatMap(sequence => {
      const order = sequence.kind === 'flat' ? [...flats] : [...definitions.keys()];
      const start = order.indexOf(sequence.start), end = order.indexOf(sequence.end);
      if (start < 0 || end < start || end - start > 255) return [];
      const names = order.slice(start, end + 1);
      const used = assets.filter(asset => asset.kind === sequence.kind && names.includes(asset.name));
      return used.length ? [{ ...sequence, names, used: used.map(asset => asset.id) }] : [];
    })];
  }
  /**
   * The surfaces an ANIMDEFS declares, resolved to the artwork this import actually has.
   *
   * A `range` names every lump between two names, so it is expanded against the imported
   * names rather than trusting the two endpoints: `PSTAR01 Range PSTAR12` is twelve frames.
   */
  function expandRange({ from, to, tics }, pool, fallback = []) {
    const exists = name => pool.some(asset => asset.name.toUpperCase() === name.toUpperCase())
      || fallback.some(asset => asset.name.toUpperCase() === name.toUpperCase());
    const frames = rangeNames({ from, to }).filter(exists).map(name => ({ name, tics }));
    // Artwork the package never shipped (a range reaching past the last imported lump) still
    // animates over what exists; if none of the names exist this returns nothing.
    return frames.length ? frames : [{ name: from, tics }, { name: to, tics }];
  }
  function animatedSurfaces() {
    const sources = [...animationSources.map(source => (typeof source === 'string' ? source : source?.source ?? source?.text)).filter(Boolean),
      ...wad.lumps.filter(lump => lump.name === 'ANIMDEFS' && lump.size > 0 && lump.size <= 1024 * 1024)
        .map(lump => new TextDecoder('latin1').decode(new Uint8Array(wad.buffer, lump.start, lump.size)))];
    if (!sources.length) return [];
    const parsed = parseSurfaceAnimations(sources, { warn: message => warnings.add(message) });
    const byKind = { texture: [], flat: [] };
    for (const asset of assets) if (byKind[asset.kind]) byKind[asset.kind].push(asset);
    return parsed.sequences.flatMap(sequence => {
      // A package may file a wall texture under flats/ (Lullaby's TEALW1 is declared as a
      // texture but ships in the flats namespace), so the declared kind is a preference, not a
      // requirement, and the frame remembers which namespace it really came from.
      const pool = byKind[sequence.kind] || [];
      const fallback = byKind[sequence.kind === 'texture' ? 'flat' : 'texture'] || [];
      const find = name => pool.find(entry => entry.name.toUpperCase() === name.toUpperCase())
        || fallback.find(entry => entry.name.toUpperCase() === name.toUpperCase()) || null;
      const frames = sequence.range ? expandRange(sequence.range, pool, fallback) : sequence.frames;
      const resolved = frames.map(frame => ({ ...frame, asset: find(frame.name) })).filter(frame => frame.asset);
      if (!resolved.length) return [];
      const used = [];
      for (const frame of resolved) if (!used.includes(frame.asset.id)) used.push(frame.asset.id);
      return [{ kind: sequence.kind, names: resolved.map(frame => frame.name), kinds: resolved.map(frame => frame.asset.kind),
        tics: resolved.map(frame => frame.tics), used, start: resolved[0].name, end: resolved[resolved.length - 1].name }];
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
    check(totalPixels <= LIMITS.assetPixels && assets.length < LIMITS.assets, 'WAD atlas budget exceeded');
    const asset = { id: `asset_${key}`, name, kind: 'sprite', width: result.width, height: result.height,
      offsetX: left, offsetY: top, src: encodeImage(result) };
    assets.push(asset); cache.set(key, asset.id);
    return { assetId: asset.id, cellWidth, cellHeight, columns, rows, left, top,
      frames: Object.fromEntries(patches.map((name, index) => [name, index])) };
  }
  const fonts = new Map();
  function font(name) {
    name = name.toUpperCase();
    if (fonts.has(name)) return fonts.get(name);
    // GZDoom's own names for the fonts it ships: BIGFONT is the lump `ZBIGFONT`, and a mod's
    // MENUDEF names the font, not the lump.
    const candidates = name === 'BIGFONT' ? [name, 'ZBIGFONT', 'DBIGFONT']
      : name === 'SMALLFONT' ? [name, 'SMALLFNT', 'ZSMALLFONT'] : [name];
    const key = candidates.find(key => fontResources.has(key) || lumpMap.has(key) &&
      doomName(data(lumpMap.get(key)).subarray(0, 4)) === 'FON2');
    if (!key) return null;
    if (fonts.has(key)) { fonts.set(name, fonts.get(key)); return fonts.get(key); }
    const decoded = decodeFON2(fontResources.get(key) || data(lumpMap.get(key)));
    const { pixels, width, height, ...layout } = decoded;
    totalPixels += width * height;
    check(totalPixels <= LIMITS.assetPixels && assets.length < LIMITS.assets, 'WAD font atlas budget exceeded');
    const assetId = `asset_font_${key}`;
    if (!assets.some(asset => asset.id === assetId)) assets.push({ id: assetId, name: key, kind: 'sprite', width, height,
      src: encodeImage({ pixels, width, height }) });
    const result = { name: key, type: 'bitmap', assetId, ...layout };
    fonts.set(key, result); fonts.set(name, result); return result;
  }
  /**
   * A translated copy of a sprite asset. Translations are baked here because the
   * palette and the decoded pixels only exist during import; the renderer then
   * just picks the translated frames for a translated actor.
   */
  /**
   * Reserves a camera-texture name. Nothing in the WAD backs it: the surface is
   * filled by the renderer with a live view once a script binds a camera.
   */
  function cameraTexture(name, width, height) {
    const key = `camera_${name}`;
    if (cache.has(key)) return cache.get(key);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 12; pixels[offset + 1] = 14; pixels[offset + 2] = 18; pixels[offset + 3] = 255;
    }
    const id = /^[a-zA-Z0-9_-]{1,74}$/.test(key) ? `asset_${key}` : `asset_image_${assets.length}`;
    assets.push({ id, name: name.slice(0, 100), kind: 'texture', width, height, offsetX: 0, offsetY: 0,
      src: encodeImage({ width, height, pixels }), camera: true });
    cache.set(key, id);
    return id;
  }
  const translations = new Map();
  function translate(assetId, key, specs) {
    const cacheKey = `${assetId}\u0000${key}`;
    if (translations.has(cacheKey)) return translations.get(cacheKey);
    const original = assets.find(asset => asset.id === assetId);
    if (!original || !colors) { translations.set(cacheKey, null); return null; }
    const { lookup, unsupported } = translationLookup(specs, colors);
    if (unsupported.length) warnings.add(`Translation ${unsupported.join(', ')} uses unsupported syntax; those colours are unchanged.`);
    if (!lookup.size) { translations.set(cacheKey, null); return null; }
    const decoded = original.kind === 'flat' ? decodeFlat(data(lumpMap.get(original.name)), colors) : patch(original.name);
    const pixels = applyTranslation(decoded.pixels, lookup);
    totalPixels += decoded.width * decoded.height;
    check(totalPixels <= LIMITS.assetPixels && assets.length < LIMITS.assets, 'WAD asset budget exceeded');
    const id = `asset_t${assets.length}_${original.kind}`;
    assets.push({ id, name: `${original.name} (translated)`.slice(0, 100), kind: original.kind,
      width: decoded.width, height: decoded.height,
      offsetX: decoded.offsetX ?? original.offsetX, offsetY: decoded.offsetY ?? original.offsetY,
      src: encodeImage({ ...decoded, pixels }) });
    translations.set(cacheKey, id);
    return id;
  }
  // Classic Doom switches sky by episode; ChangeSky can name any of them, so the
  // importer registers every SKYn texture the game defines, not only the current one.
  function skyTextures() {
    const names = new Set([...definitions.keys(), ...lumpMap.keys()]);
    for (const key of images.keys()) {
      const match = /^(?:sky|texture)_(.+)$/.exec(key);
      if (match && /^SKY\w*$/i.test(match[1])) names.add(match[1]);
    }
    return [...names].filter(name => /^SKY\w*$/i.test(name)).sort();
  }
  return { get, sprite, spriteFrame, atlas, font, materialSequences, translate, cameraTexture, skyTextures, palette: colors, assets, warnings, has: name => lumpMap.has(name) || definitions.has(name) ||
    ['sprite', 'weapon', 'texture', 'flat'].some(kind => images.has(`${kind}_${name}`)) };
}

export const doomThings = {
  // Teleport destinations are pure markers: invisible in game, but ACS and
  // `Teleport` line specials aim at them, so they must survive the import.
  14: ['TNT1', 'decoration'],
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