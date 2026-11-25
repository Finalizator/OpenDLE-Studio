// A compiled map's textures have to become pictures, not names.
//
// A `.bsp` names its materials; the artwork is either inside the file (Quake, Half-Life: 8-bit images
// indexed into a palette that is *not* in the map) or beside it in the `.pk3` that ships the map
// (Quake 2/3: TGA, JPEG or PNG). Everything a project can hold is a PNG data URL, so this is where
// decoding happens — and where a map with no palette says so instead of importing grey.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  compiledMapAssets, decodeJpeg, decodeTga, findPalette, imageSize, miptexPixels, miptexTextures, readPalette,
} from '../server/bsp-textures.js';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'opendle-textures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
    return file;
  };
  return { root, write };
}

/** A WAD3 with one lump in it, which is how `halflife.wad` carries the palette. */
function wad3(name, data) {
  const header = Buffer.alloc(12);
  header.write('WAD3', 0, 'latin1');
  header.writeInt32LE(1, 4);
  header.writeInt32LE(12, 8);
  const entry = Buffer.alloc(32);
  entry.writeInt32LE(12 + 32, 0);
  entry.writeInt32LE(data.length, 4);
  entry.writeInt32LE(data.length, 8);
  entry.write(':' === name[1] ? 'none' : 'D', 12, 'latin1');
  entry.write(name, 16, 'latin1');
  return Buffer.concat([header, entry, data]);
}

/** A palette whose entry `index` is a recognisable colour: (index, 255 - index, 128). */
function paletteBytes() {
  const palette = Buffer.alloc(768);
  for (let index = 0; index < 256; index++) {
    palette[index * 3] = index;
    palette[index * 3 + 1] = 255 - index;
    palette[index * 3 + 2] = 128;
  }
  return palette;
}

/** A packet of BSP lumps holding just a texture directory, which is all the reader needs here. */
function bspWithTexture(name, width, height, indices) {
  const entry = Buffer.alloc(40 + indices.length);
  entry.write(name, 0, 'latin1');
  entry.writeUInt32LE(width, 16);
  entry.writeUInt32LE(height, 20);
  entry.writeUInt32LE(40, 24);
  indices.forEach((value, index) => { entry[40 + index] = value; });
  const header = Buffer.alloc(8);
  header.writeInt32LE(1, 0);
  header.writeInt32LE(8, 4);
  const lump = Buffer.concat([header, entry]);
  const lumps = Array.from({ length: 15 }, () => ({ offset: 0, length: 0 }));
  lumps[2] = { offset: 0, length: lump.length };
  return { bytes: lump, info: { version: 30, engine: 'Half-Life', lumps } };
}

const mapUsing = (...names) => ({
  name: 'test.bsp',
  entities: [{ properties: { classname: 'worldspawn' },
    brushes: [{ faces: names.map(texture => ({ texture })) }] }],
});

const pixelsOf = asset => PNG.sync.read(Buffer.from(asset.src.split(',')[1], 'base64'));

/** A TGA of `width` x `height` 24-bit pixels, run-length encoded when `rle` says so. */
function tga(width, height, colours, { rle = false } = {}) {
  const header = Buffer.alloc(18);
  header[2] = rle ? 10 : 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  const body = [];
  if (rle) body.push(0x80 | (colours.length - 1), colours[0][2], colours[0][1], colours[0][0]);
  else for (const colour of colours) body.push(colour[2], colour[1], colour[0]);
  return Buffer.concat([header, Buffer.from(body)]);
}

test('a palette is read from a WAD3 and from a bare lump, and refused from anything else', () => {
  const palette = paletteBytes();
  assert.deepEqual(readPalette(wad3('gfx/palette.lmp', palette)).subarray(0, 3), Uint8Array.from([0, 255, 128]));
  assert.deepEqual(readPalette(palette).subarray(768 - 3), Uint8Array.from([255, 0, 128]));
  assert.equal(readPalette(Buffer.from('too short')), null);
  // A Doom IWAD is not a palette: its first 768 bytes are a header and a directory.
  assert.equal(readPalette(Buffer.alloc(50 * 1024 * 1024, 7)), null);
  assert.equal(readPalette(Buffer.concat([Buffer.from('PWAD'), Buffer.alloc(2000)])), null);
  // A WAD with no palette in it is not a palette, however big it is.
  assert.equal(readPalette(wad3('gfx/colormap.lmp', palette)), null);
});

test('the palette is found beside the map, in a folder of maps, or not at all', t => {
  const { root, write } = scratch(t);
  write('Maps/HL/crossfire.bsp', Buffer.from('not read here'));
  assert.equal(findPalette(root, 'Maps/HL/crossfire.bsp'), null, 'nothing to find yet');
  write('Maps/HL/halflife.wad', wad3('gfx/palette.lmp', paletteBytes()));
  const found = findPalette(root, 'Maps/HL/crossfire.bsp');
  assert.equal(found?.length, 768);
  // The answer is cached per folder, so a level of a thousand textures reads the WAD once.
  const cache = new Map();
  assert.equal(findPalette(root, 'Maps/HL/crossfire.bsp', cache).length, 768);
  assert.ok(cache.size >= 1);
});

test('an embedded miptex becomes pixels through the palette the game used', () => {
  const { bytes, info } = bspWithTexture('BRICK1', 2, 2, [1, 2, 3, 4]);
  const textures = miptexTextures(bytes, info);
  const entry = textures.get('brick1');
  assert.deepEqual({ width: entry.width, height: entry.height }, { width: 2, height: 2 });
  const pixels = miptexPixels({ ...entry, data: bytes.subarray(entry.data, entry.data + 4) }, paletteBytes());
  assert.deepEqual([...pixels.subarray(0, 4)], [1, 254, 128, 255], 'palette entry 1, opaque');
  assert.deepEqual([...pixels.subarray(12, 16)], [4, 251, 128, 255], 'and entry 4 for the last pixel');
});

test('a Half-Life map imports its textures once a palette is in the folder', async t => {
  const { root, write } = scratch(t);
  write('Maps/HL/halflife.wad', wad3('gfx/palette.lmp', paletteBytes()));
  const { bytes, info } = bspWithTexture('BRICK1', 2, 2, [1, 2, 3, 4]);
  const result = await compiledMapAssets({ bytes, info, parsed: mapUsing('BRICK1'), root, relativePath: 'Maps/HL/test.bsp' });
  assert.equal(result.assets.length, 1);
  const asset = result.assets[0];
  assert.equal(asset.kind, 'texture');
  assert.deepEqual([asset.width, asset.height], [2, 2]);
  assert.ok(asset.src.startsWith('data:image/png;base64,'), 'a project holds PNG and nothing else');
  assert.equal(result.materials.get('BRICK1'), asset.id, 'the face is pointed at the asset');
  const image = pixelsOf(asset);
  assert.deepEqual([image.data[0], image.data[1], image.data[2]], [1, 254, 128]);
});

test('a Half-Life map with no palette says what is missing instead of importing grey', async t => {
  const { root } = scratch(t);
  const { bytes, info } = bspWithTexture('BRICK1', 2, 2, [1, 2, 3, 4]);
  const result = await compiledMapAssets({ bytes, info, parsed: mapUsing('BRICK1'), root, relativePath: 'Maps/HL/test.bsp' });
  assert.equal(result.assets.length, 0);
  assert.equal(result.materials.size, 0);
  assert.match(result.warnings.join('\n'), /palette.*not in the Projects folder/s);
});

test('a TGA is decoded, run-length encoded or not, because no browser draws one', () => {
  const flat = decodeTga(tga(2, 1, [[10, 20, 30], [40, 50, 60]]));
  assert.deepEqual([flat.width, flat.height], [2, 1]);
  assert.deepEqual([...flat.pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
  const packed = decodeTga(tga(2, 1, [[10, 20, 30], [40, 50, 60]], { rle: true }));
  assert.deepEqual([...packed.pixels], [10, 20, 30, 255, 10, 20, 30, 255], 'one run of two identical pixels');
  assert.equal(decodeTga(Buffer.from('not a tga at all')), null);
});

test('a picture is measured from its own header, so an asset describes what it holds', () => {
  const png = PNG.sync.write({ width: 3, height: 5, data: Buffer.alloc(3 * 5 * 4, 200) });
  assert.deepEqual(imageSize(png), { width: 3, height: 5 });
  // A minimal JPEG: SOI, an APP0 to skip, then a baseline frame with the size in it.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
    0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 16, height: 32 });
  assert.equal(imageSize(Buffer.from('nope')), null);
  assert.equal(decodeJpeg(Buffer.from('nope')), null);
});

test('a Quake 3 shader takes its picture from the archive beside it', async () => {
  const images = new Map([
    ['textures/base/wall.tga', tga(1, 1, [[1, 2, 3]])],
    ['textures/base/floor.png', PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) })],
  ]);
  const archive = {
    list: async () => [...images.keys()],
    read: async name => images.get(name) || null,
  };
  const parsed = mapUsing('textures/base/wall', 'textures/base/floor', 'textures/base/missing');
  const result = await compiledMapAssets({ bytes: Buffer.alloc(16), info: { version: 46, lumps: [] }, parsed, archive });
  assert.equal(result.assets.length, 2);
  assert.deepEqual(new Set(result.assets.map(asset => asset.name)), new Set(['textures/base/wall', 'textures/base/floor']));
  assert.ok(result.assets.every(asset => asset.src.startsWith('data:image/png;base64,')));
  assert.match(result.warnings.join('\n'), /1 of its 3 textures are not in the archive/);
  // The TGA came out the right way up and the right colour; the PNG was already a PNG.
  assert.deepEqual([...pixelsOf(result.assets[0]).data.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([result.assets[1].width, result.assets[1].height], [2, 2]);
});
