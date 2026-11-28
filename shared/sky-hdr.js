// Repairs for high-dynamic-range sky pictures.
//
// A float panorama is decoded sample by sample, and the tools that write them do not all agree on
// what an empty sample is: denoisers leave NaN and -Inf behind, and compositors write negative
// values that no display can show. A NaN anywhere in a texture is undefined behaviour on the GPU —
// on some drivers it paints the whole surface a colour that has nothing to do with the picture,
// which is what "my nebula came out green" looks like. Repairing the few bad samples at decode
// time costs one pass over the data and removes the whole class.

/** IEEE 754 binary16 → number, so a half-float texture's raw words can be inspected. */
export function halfToNumber(bits) {
  const sign = (bits & 0x8000) >> 15, exponent = (bits & 0x7c00) >> 10, fraction = bits & 0x03ff;
  if (exponent === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/**
 * Replace non-finite samples with zero and clamp negatives, in place.
 *
 * Half-float textures keep their samples as raw 16-bit words, so they are decoded here rather than
 * compared as numbers: `data[i] < 0` on a `Uint16Array` is always false and a NaN would sail
 * straight through to the GPU.
 */
export function repairFloatSamples(data, { channels = 4 } = {}) {
  if (!data || typeof data.length !== 'number') return { nonFinite: 0, negative: 0, samples: 0 };
  const half = data instanceof Uint16Array;
  let nonFinite = 0, negative = 0;
  for (let index = 0; index < data.length; index += channels) {
    for (let channel = 0; channel < channels; channel++) {
      const raw = data[index + channel];
      const value = half ? halfToNumber(raw) : raw;
      if (!Number.isFinite(value)) {
        data[index + channel] = 0;
        nonFinite++;
      } else if (value < 0) {
        data[index + channel] = 0;
        negative++;
      }
    }
  }
  return { nonFinite, negative, samples: Math.floor(data.length / channels) };
}

/** Does this typed array hold float samples that can carry NaN/Inf (so repairing is meaningful)? */
export function isFloatSampleArray(data) {
  return Boolean(data) && (data instanceof Float32Array || data instanceof Uint16Array);
}

/**
 * Whether a decoded texture can be sampled the way the sky shader samples it.
 *
 * Integer textures cannot be linearly filtered at all, and a sky is always filtered: a format the
 * sampler cannot read paints garbage rather than failing loudly.
 */
export function samplerReadyTexture(texture, THREE) {
  if (!texture) return { ok: false, reason: 'no texture' };
  const integer = THREE ? texture.type === THREE.UnsignedIntType || texture.type === THREE.IntType
    : false;
  const integerFormat = THREE ? texture.format === THREE.RGBAIntegerFormat || texture.format === THREE.RGBIntegerFormat
    : false;
  if (integer || integerFormat) return { ok: false, reason: 'the picture is stored as integers, which a sky cannot filter' };
  return { ok: true, reason: '' };
}
