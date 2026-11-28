/**
 * DDS: the container a cubemap and a compressed sky usually ship in.
 *
 * A DDS file is a header and then the pixels, either raw or in a block-compressed format (the
 * "DXT" family). Browsers decode none of it, and the compressed blocks cannot be re-uploaded as
 * ordinary pixels — so the blocks are expanded here, in plain JavaScript, into the RGBA the rest of
 * the engine already knows how to draw. That keeps one code path for the editor's preview and the
 * game, and makes the decoding testable without a GPU.
 *
 * Supported: DXT1/BC1, DXT3/BC2, DXT5/BC3, and uncompressed 24/32-bit. Six-face files answer six
 * faces in `px, nx, py, ny, pz, nz` order; one-face files answer one.
 */

const MAGIC = 'DDS ';

const readU32 = (view, offset) => view.getUint32(offset, true);

/** The DDS header fields this module reads, with the parts it needs named. */
export function parseDdsHeader(bytes) {
  if (!bytes || bytes.length < 128) throw new Error('DDS file is shorter than its header');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC) throw new Error(`Not a DDS file (starts with "${magic}")`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = readU32(view, 4);
  if (size !== 124) throw new Error(`DDS header is ${size} bytes, expected 124`);
  const height = readU32(view, 12), width = readU32(view, 16);
  const mipmaps = Math.max(1, readU32(view, 28) || 1);
  const fourCc = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
  const pixelFlags = readU32(view, 80);
  const rgbBits = readU32(view, 88);
  const caps2 = readU32(view, 112);
  // DDSCAPS2_CUBEMAP: the six face bits follow it. A file that claims to be a cubemap but names
  // only some faces is still six faces here, because that is how it is sampled.
  const faces = (caps2 & 0x200) ? 6 : 1;
  const block = { DXT1: 'bc1', DXT3: 'bc2', DXT5: 'bc3' }[fourCc] || null;
  const uncompressed = !block && (pixelFlags & 0x40 || fourCc === '' || /^\0+$/.test(fourCc));
  if (!block && !uncompressed) throw new Error(`Unsupported DDS pixel format ${JSON.stringify(fourCc)}`);
  const bytesPerPixel = uncompressed ? Math.max(3, Math.round(rgbBits / 8)) : 0;
  return { width, height, mipmaps, faces, format: block || `raw${bytesPerPixel * 8}`, fourCc, bytesPerPixel,
    pixelFlags, caps2 };
}

/** Expands one BC1 colour block (8 bytes) into 16 RGBA pixels. */
function decodeBc1Block(view, at, out, outOffset, outStride, punchThrough) {
  const c0 = view.getUint16(at, true), c1 = view.getUint16(at + 2, true);
  const bits = view.getUint32(at + 4, true);
  const colour = value => [
    Math.round(((value >> 11) & 31) * 255 / 31),
    Math.round(((value >> 5) & 63) * 255 / 63),
    Math.round((value & 31) * 255 / 31),
    255,
  ];
  const first = colour(c0), second = colour(c1);
  const palette = [first, second, [0, 0, 0, 255], [0, 0, 0, 255]];
  const c0Bigger = c0 > c1 || !punchThrough;
  if (c0Bigger) {
    for (let channel = 0; channel < 3; channel++)
      palette[2][channel] = Math.round((2 * first[channel] + second[channel]) / 3);
    for (let channel = 0; channel < 3; channel++)
      palette[3][channel] = Math.round((first[channel] + 2 * second[channel]) / 3);
    palette[2][3] = 255; palette[3][3] = 255;
  } else {
    for (let channel = 0; channel < 3; channel++)
      palette[2][channel] = Math.round((first[channel] + second[channel]) / 2);
    palette[2][3] = 255;
    // BC1's three-colour mode: the fourth entry is transparent black.
    palette[3] = [0, 0, 0, 0];
  }
  for (let pixel = 0; pixel < 16; pixel++) {
    const entry = palette[(bits >> (pixel * 2)) & 3];
    const at2 = outOffset + (pixel >> 2) * outStride + (pixel & 3) * 4;
    out[at2] = entry[0]; out[at2 + 1] = entry[1]; out[at2 + 2] = entry[2]; out[at2 + 3] = entry[3];
  }
}

/** Expands one BC3 alpha block (8 bytes, two 8-entry ramps) into the alpha channel of 16 pixels. */
function decodeBc3Alpha(view, at, out, outOffset, outStride) {
  const a0 = view.getUint8(at), a1 = view.getUint8(at + 1);
  let bitsLow = 0, bitsHigh = 0;
  for (let index = 0; index < 3; index++) bitsLow |= view.getUint8(at + 2 + index) << (8 * index);
  for (let index = 0; index < 3; index++) bitsHigh |= view.getUint8(at + 5 + index) << (8 * index);
  const ramp = new Array(8);
  ramp[0] = a0; ramp[1] = a1;
  if (a0 > a1) {
    for (let index = 1; index <= 6; index++) ramp[index + 1] = Math.round(((7 - index) * a0 + index * a1) / 7);
  } else {
    for (let index = 1; index <= 4; index++) ramp[index + 1] = Math.round(((5 - index) * a0 + index * a1) / 5);
    ramp[6] = 0; ramp[7] = 255;
  }
  for (let pixel = 0; pixel < 16; pixel++) {
    const value = pixel < 8 ? (bitsLow >> (pixel * 3)) & 7 : (bitsHigh >> ((pixel - 8) * 3)) & 7;
    const at2 = outOffset + (pixel >> 2) * outStride + (pixel & 3) * 4;
    out[at2 + 3] = ramp[value];
  }
}

/** Expands one BC2/BC3 explicit 4-bit alpha block into the alpha channel of 16 pixels. */
function decodeBc2Alpha(view, at, out, outOffset, outStride) {
  const low = view.getUint32(at, true), high = view.getUint32(at + 4, true);
  for (let pixel = 0; pixel < 16; pixel++) {
    const nibble = pixel < 8 ? (low >> (pixel * 4)) & 15 : (high >> ((pixel - 8) * 4)) & 15;
    const at2 = outOffset + (pixel >> 2) * outStride + (pixel & 3) * 4;
    out[at2 + 3] = nibble * 17;
  }
}

/**
 * Decodes one face (or one image) of a DDS file into RGBA bytes, top row first.
 *
 * Only the largest mip is expanded: a sky is drawn covered, and a mip chain here would cost four
 * times the memory to save a little texture bandwidth the GPU generates for itself.
 */
export function decodeDdsFace(bytes, header, face = 0) {
  const { width, height, format, faces, mipmaps, bytesPerPixel } = header;
  const out = new Uint8Array(width * height * 4);
  const stride = width * 4;
  // Where this face's pixels start: every face repeats the whole mip chain.
  const faceSize = blockFaceSize(header);
  let at = 128 + face * faceSize;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format.startsWith('raw')) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = at + (y * width + x) * bytesPerPixel;
        const target = y * stride + x * 4;
        out[target] = bytes[source];
        out[target + 1] = bytes[source + 1];
        out[target + 2] = bytes[source + 2];
        out[target + 3] = bytesPerPixel >= 4 ? bytes[source + 3] : 255;
      }
    }
    return out;
  }
  const blocksWide = Math.max(1, Math.ceil(width / 4)), blocksHigh = Math.max(1, Math.ceil(height / 4));
  const blockBytes = format === 'bc1' ? 8 : 16;
  for (let by = 0; by < blocksHigh; by++) {
    for (let bx = 0; bx < blocksWide; bx++) {
      const blockAt = at + (by * blocksWide + bx) * blockBytes;
      const target = by * 4 * stride + bx * 4 * 4;
      if (format === 'bc1') decodeBc1Block(view, blockAt, out, target, stride, true);
      else {
        decodeBc1Block(view, blockAt + 8, out, target, stride, false);
        if (format === 'bc2') decodeBc2Alpha(view, blockAt, out, target, stride);
        else decodeBc3Alpha(view, blockAt, out, target, stride);
      }
    }
  }
  // A picture that is not a multiple of four is padded by the block; clip the padding by copying
  // the used part of each row into place.
  return width % 4 === 0 && height % 4 === 0 ? out : cropBlocks(out, width, height);
}

function cropBlocks(padded, width, height) {
  const paddedWidth = Math.ceil(width / 4) * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * paddedWidth * 4, to = y * width * 4;
    out.set(padded.subarray(from, from + width * 4), to);
  }
  return out;
}

/** The bytes one face takes, including its whole mip chain. */
function blockFaceSize({ width, height, format, mipmaps, bytesPerPixel }) {
  const blockBytes = format === 'bc1' ? 8 : format.startsWith('raw') ? 0 : 16;
  let size = 0, w = width, h = height;
  for (let level = 0; level < mipmaps; level++) {
    if (format.startsWith('raw')) size += w * h * bytesPerPixel;
    else size += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockBytes;
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }
  return size;
}

/**
 * Decodes a whole DDS file: `{ width, height, faces: [rgba, …], cubemap }`.
 *
 * The face order is the one a cubemap samples in three.js (`px, nx, py, ny, pz, nz`), which is also
 * the order DDS stores them in.
 */
export function decodeDds(bytes) {
  const header = parseDdsHeader(bytes);
  const faces = [];
  for (let face = 0; face < header.faces; face++) faces.push(decodeDdsFace(bytes, header, face));
  return { width: header.width, height: header.height, faces, cubemap: header.faces === 6, format: header.format };
}
