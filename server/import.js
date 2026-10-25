import { PNG } from 'pngjs';
import { readWad, importWadMap } from '../shared/wad.js';

export function encodeImage({ width, height, pixels }) {
  return `data:image/png;base64,${PNG.sync.write({ width, height, data: Buffer.from(pixels) }).toString('base64')}`;
}

export function importWad(buffer, mapName) {
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return importWadMap(readWad(array), mapName, { encodeImage });
}
