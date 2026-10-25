import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { readWad, importWadMap, importWadGame } from '../shared/wad.js';

export function encodeImage({ width, height, pixels }) {
  return `data:image/png;base64,${PNG.sync.write({ width, height, data: Buffer.from(pixels) }).toString('base64')}`;
}

export function cachedImageEncoder() {
  const cache = new Map();
  return image => {
    const key = `${image.width}/${image.height}/${createHash('sha256').update(image.pixels).digest('hex')}`;
    if (!cache.has(key)) cache.set(key, encodeImage(image));
    return cache.get(key);
  };
}

export function importWad(buffer, mapName, { fullGame = !mapName, title } = {}) {
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return (fullGame ? importWadGame : importWadMap)(readWad(array), mapName,
    { encodeImage: fullGame ? cachedImageEncoder() : encodeImage, title });
}
