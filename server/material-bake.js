/**
 * Baking a material: turning its maps into the resolution the project plays with.
 *
 * The editor draws previews, so a material can be designed at 2K and looked at 256² at a time.
 * When the creator is happy, the maps are resampled once to the size the project keeps, and the
 * preview copies are dropped: from then on the project carries one set, at the size that was
 * chosen, and the authored material stays a link the editor can open again.
 *
 * Resampling a normal map is not resampling a picture. Averaging the encoded bytes of a normal map
 * gives a shorter vector pointing the wrong way, so the vectors are decoded, averaged and
 * renormalised, which is what an image editor's own downscale does.
 */

import { PNG } from 'pngjs';
import { MATERIAL_CHANNELS, BAKE_SIZES } from '../shared/materials.js';

/** A PNG data URL as pixels, keeping its 8-bit RGBA channel count. */
export function readPng(source) {
  const base64 = String(source || '').replace(/^data:image\/png;base64,/, '');
  if (!base64) throw new Error('A material map must be a PNG image');
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, data: png.data };
}

export function writePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

export function imageSize(source) {
  const base64 = String(source || '').replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Resamples an image to a square of `size` pixels.
 *
 * Area averaging, so a 2048² brick wall downscaled to 256² keeps its mortar instead of picking one
 * texel per pixel and turning the pattern into noise. `normal` decodes the RGB as a direction,
 * averages that, and writes it back normalised.
 */
export function resample(image, size, { normal = false } = {}) {
  if (!Number.isInteger(size) || size < 1) throw new Error('A material resolution must be a whole number of pixels');
  if (size > 4096) throw new Error('A material resolution may not exceed 4096 pixels');
  const out = Buffer.alloc(size * size * 4);
  const scaleX = image.width / size, scaleY = image.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY), y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX), x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * 4;
          r += image.data[at]; g += image.data[at + 1]; b += image.data[at + 2]; a += image.data[at + 3];
          count++;
        }
      }
      const target = (y * size + x) * 4;
      if (normal) {
        // A direction averaged as a direction: decode, mean, renormalise, encode.
        let nx = (r / count) / 127.5 - 1, ny = (g / count) / 127.5 - 1, nz = (b / count) / 127.5 - 1;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx = nx / length * .5 + .5; ny = ny / length * .5 + .5; nz = nz / length * .5 + .5;
        out[target] = clamp(Math.round(nx * 255), 0, 255);
        out[target + 1] = clamp(Math.round(ny * 255), 0, 255);
        out[target + 2] = clamp(Math.round(nz * 255), 0, 255);
        out[target + 3] = 255;
      } else {
        out[target] = clamp(Math.round(r / count), 0, 255);
        out[target + 1] = clamp(Math.round(g / count), 0, 255);
        out[target + 2] = clamp(Math.round(b / count), 0, 255);
        out[target + 3] = clamp(Math.round(a / count), 0, 255);
      }
    }
  }
  return { width: size, height: size, data: out };
}

/**
 * Every channel of a material at one resolution, as data URLs.
 *
 * A channel that is already the right size is passed through untouched: re-encoding a PNG that is
 * the size the creator asked for is a generation of quality lost for nothing.
 */
export function bakeChannels(channels, size, { sizes = null } = {}) {
  if (!BAKE_SIZES.includes(size)) throw new Error(`A material may be baked at ${BAKE_SIZES.join(', ')} pixels`);
  const result = {};
  for (const channel of MATERIAL_CHANNELS) {
    const source = channels?.[channel];
    if (!source) continue;
    const image = readPng(source);
    const measured = sizes?.[channel];
    if (measured && measured.width === size && measured.height === size) { result[channel] = source; continue; }
    if (image.width === size && image.height === size) { result[channel] = source; continue; }
    result[channel] = writePng(resample(image, size, { normal: channel === 'normal' }));
  }
  return result;
}

/** The same maps downscaled for the editor, which draws them instead of the full set. */
export function previewChannels(channels, size) {
  const result = {};
  for (const channel of MATERIAL_CHANNELS) {
    const source = channels?.[channel];
    if (!source) continue;
    const image = readPng(source);
    // A map already smaller than the preview is passed through: upscaling it would cost memory
    // and buy nothing.
    if (image.width <= size && image.height <= size) { result[channel] = source; continue; }
    result[channel] = writePng(resample(image, size, { normal: channel === 'normal' }));
  }
  return result;
}
