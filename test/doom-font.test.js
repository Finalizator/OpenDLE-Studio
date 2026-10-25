import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFON2 } from '../shared/doom-font.js';
import { createDoomAssets } from '../shared/doom-assets.js';
import { encodeImage } from '../server/import.js';
import { bitmapGlyph } from '../shared/hud.js';

function font({ widths = [2, 1], height = 2, kerning, constant = false, runs = [3, 1, 0, 0, 1, 255, 1] } = {}) {
  const header = Buffer.alloc(12); header.write('FON2'); header.writeUInt16LE(height, 4);
  header[6] = 65; header[7] = 64 + widths.length; header[8] = Number(constant); header[10] = 1;
  header[11] = Number(kerning !== undefined);
  const metrics = Buffer.alloc((constant ? 1 : widths.length) * 2 + (kerning === undefined ? 0 : 2));
  let offset = 0;
  if (kerning !== undefined) { metrics.writeInt16LE(kerning); offset = 2; }
  for (const width of constant ? widths.slice(0, 1) : widths) { metrics.writeUInt16LE(width, offset); offset += 2; }
  return Buffer.concat([header, metrics, Buffer.from([0, 0, 0, 200, 60, 20]), Buffer.from(runs)]);
}

test('FON2 decodes proportional metrics, transparent palette entries and literal/repeated glyph runs', () => {
  const decoded = decodeFON2(font());
  assert.deepEqual([decoded.width, decoded.height, decoded.cellWidth, decoded.cellHeight, decoded.columns], [4, 2, 2, 2, 2]);
  assert.equal(decoded.chars, 'AB'); assert.deepEqual(decoded.widths, [2, 1]);
  const pixel = (x, y) => [...decoded.pixels.slice((y * decoded.width + x) * 4, (y * decoded.width + x + 1) * 4)];
  assert.deepEqual(pixel(0, 0), [200, 60, 20, 255]); assert.deepEqual(pixel(1, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(0, 1), [0, 0, 0, 0]); assert.deepEqual(pixel(1, 1), [200, 60, 20, 255]);
  assert.deepEqual(pixel(2, 0), [200, 60, 20, 255]); assert.deepEqual(pixel(2, 1), [200, 60, 20, 255]);
  assert.deepEqual(pixel(3, 1), [0, 0, 0, 0]);
});

test('FON2 supports constant width, signed kerning, zero-width glyphs and RLE no-ops', () => {
  const positive = decodeFON2(font({ constant: true, widths: [2, 2], kerning: 2, runs: [128, 253, 1, 253, 1] }));
  assert.deepEqual(positive.widths, [4, 4]);
  assert.equal(positive.cellWidth, 2);
  const negative = decodeFON2(font({ widths: [2, 0], kerning: -1, runs: [253, 1] }));
  assert.deepEqual(negative.widths, [1, 1]);
  const legacy = font({ kerning: -1 }); legacy[11] = 49;
  assert.deepEqual(decodeFON2(legacy).widths, [1, 1]);
});

test('FON2 rejects truncated, overflowing, invalid palette and excessive atlas data', () => {
  const bytes = font();
  for (let length = 0; length < bytes.length; length++)
    assert.throws(() => decodeFON2(bytes.subarray(0, length)), /FON2/, `length ${length}`);
  assert.throws(() => decodeFON2(font({ runs: [4, 1, 1, 1, 1, 1] })), /run exceeds/);
  assert.throws(() => decodeFON2(font({ runs: [253, 2, 255, 1] })), /palette/);
  assert.throws(() => decodeFON2(font({ height: 257 })), /dimensions/);
  assert.throws(() => decodeFON2(font({ widths: [257] })), /256 pixels/);
  assert.throws(() => decodeFON2(font({ widths: Array(256 - 65).fill(256) })), /atlas budget/);
  assert.throws(() => decodeFON2(font({ kerning: 32767 })), /advance/);
});

test('WAD FON2 and package BIGFONT aliases reuse a portable embedded atlas', () => {
  const palette = Buffer.alloc(768), bytes = Buffer.concat([palette, font()]);
  const wad = { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    lumps: [{ name: 'PLAYPAL', start: 0, size: 768 }, { name: 'DBIGFONT', start: 768, size: bytes.length - 768 }] };
  for (const resources of [new Map(), new Map([['DBIGFONT', font()]])]) {
    const assets = createDoomAssets(wad, encodeImage, new Map(), resources);
    const big = assets.font('BigFont');
    assert.equal(big, assets.font('DBIGFONT')); assert.equal(big, assets.font('BIGFONT'));
    assert.equal(big.type, 'bitmap'); assert.deepEqual(big.widths, [2, 1]);
    assert.equal(assets.assets.filter(asset => asset.id === big.assetId).length, 1);
    assert.ok(assets.assets.find(asset => asset.id === big.assetId).src.startsWith('data:image/png;base64,'));
    assert.equal(assets.font('NotPresent'), null);
  }
});

test('bitmap glyph metrics preserve kerning advances and uppercase/space fallback', () => {
  const font = { chars: 'AB ', cellWidth: 8, widths: [6, 9, 3], spaceWidth: 4 };
  assert.deepEqual(bitmapGlyph(font, 'a'), { index: 0, advance: 6 });
  assert.deepEqual(bitmapGlyph(font, 'B'), { index: 1, advance: 9 });
  assert.deepEqual(bitmapGlyph(font, ' '), { index: 2, advance: 4 });
  assert.deepEqual(bitmapGlyph(font, '?'), { index: -1, advance: 8 });
});
