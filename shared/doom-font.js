export function decodeFON2(bytes) {
  const fail = message => { throw new Error(`FON2: ${message}`); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FON2')
    fail('invalid header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint16(4, true), first = bytes[6], last = bytes[7], count = last - first + 1;
  if (count < 1 || height < 1 || height > 256) fail('unsupported dimensions');
  let offset = 12;
  function take(size) {
    if (offset + size > bytes.length) fail('truncated data');
    const start = offset; offset += size; return start;
  }
  // Legacy font writers leave other flag bits set; only bit zero declares kerning.
  const kerning = bytes[11] & 1 ? view.getInt16(take(2), true) : 0;
  const widths = bytes[8] ? Array(count).fill(view.getUint16(take(2), true))
    : Array.from({ length: count }, () => view.getUint16(take(2), true));
  if (widths.some(width => width > 256)) fail('glyph exceeds 256 pixels');
  const cellWidth = Math.max(1, ...widths), columns = Math.min(16, count), rows = Math.ceil(count / columns);
  const width = cellWidth * columns, atlasHeight = height * rows;
  if (width > 2048 || atlasHeight > 2048 || width * atlasHeight > 4 * 1024 * 1024) fail('atlas budget exceeded');
  const paletteSize = bytes[10] + 1, palette = take(paletteSize * 3);
  const pixels = new Uint8Array(width * atlasHeight * 4);
  for (let glyph = 0; glyph < count; glyph++) {
    const size = widths[glyph] * height, colors = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const code = bytes[take(1)];
      if (code === 128) continue;
      const length = code < 128 ? code + 1 : 257 - code;
      if (written + length > size) fail(`RLE run exceeds glyph ${glyph + first}`);
      if (code < 128) colors.set(bytes.subarray(offset, offset + length), written), take(length);
      else colors.fill(bytes[take(1)], written, written + length);
      written += length;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < widths[glyph]; x++) {
      const color = colors[y * widths[glyph] + x];
      if (color >= paletteSize) fail('glyph palette index out of range');
      if (!color) continue;
      const destination = ((Math.floor(glyph / columns) * height + y) * width + glyph % columns * cellWidth + x) * 4;
      pixels.set(bytes.subarray(palette + color * 3, palette + color * 3 + 3), destination);
      pixels[destination + 3] = 255;
    }
  }
  const advances = widths.map(width => Math.max(1, width + kerning));
  if (advances.some(width => width > 512)) fail('glyph advance exceeds 512 pixels');
  const spaceWidth = Math.max(1, first <= 32 && last >= 32 ? advances[32 - first]
    : first <= 78 && last >= 78 ? Math.ceil(advances[78 - first] / 2) : Math.round(cellWidth / 2));
  return { width, height: atlasHeight, pixels, cellWidth, cellHeight: height, columns,
    chars: Array.from({ length: count }, (_, i) => String.fromCharCode(first + i)).join(''),
    widths: advances, spaceWidth };
}
