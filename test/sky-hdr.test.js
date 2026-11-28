/**
 * High-dynamic-range sky repair.
 *
 * A float panorama is decoded sample by sample, and the tools that write them disagree about what
 * an empty sample is: denoisers leave NaN and -Inf, compositors write negatives. One NaN in a
 * texture is undefined behaviour on the GPU — on some drivers the whole surface comes out a colour
 * that has nothing to do with the picture, which is what a "green" nebula is. These tests pin the
 * repair, including the half-float case, where the samples are raw 16-bit words and comparing them
 * as numbers silently passes everything through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairFloatSamples, isFloatSampleArray, samplerReadyTexture, halfToNumber } from '../shared/sky-hdr.js';

/** IEEE 754 binary16 of a number, so a half-float buffer can be built by hand. */
function halfBits(value) {
  const buffer = new Float32Array([value]);
  const bits = new Uint32Array(buffer.buffer)[0];
  const sign = (bits >> 16) & 0x8000, exponent = ((bits >> 23) & 0xff) - 127, mantissa = (bits >> 13) & 0x3ff;
  if (exponent === 128) return sign | 0x7c00 | (mantissa ? 1 : 0);
  return sign | ((exponent + 15) << 10) | mantissa;
}

test('a float texture has its non-finite and negative samples repaired', () => {
  const data = new Float32Array([1, NaN, -2, 1, 0.5, Infinity, 0.2, 1]);
  const report = repairFloatSamples(data, { channels: 4 });
  assert.deepEqual({ ...report }, { nonFinite: 2, negative: 1, samples: 2 });
  assert.deepEqual([...data].map(value => Math.round(value * 10) / 10), [1, 0, 0, 1, 0.5, 0, 0.2, 1]);
});

test('half-float words are decoded, not compared as raw integers, so NaN cannot slip through', () => {
  const data = new Uint16Array([halfBits(1), halfBits(NaN), halfBits(-2), halfBits(1), halfBits(0.5), halfBits(1), halfBits(1), halfBits(1)]);
  assert.ok(Number.isNaN(halfToNumber(data[1])));
  const report = repairFloatSamples(data, { channels: 4 });
  assert.equal(report.nonFinite, 1, 'the NaN sample is found');
  assert.equal(report.negative, 1, 'the negative sample is found');
  assert.deepEqual([...data].map(halfToNumber), [1, 0, 0, 1, 0.5, 1, 1, 1]);
});

test('a clean picture is left exactly as it was', () => {
  const data = new Float32Array([0, .5, 1, 1, .25, .75, .1, 1]);
  const copy = [...data];
  const report = repairFloatSamples(data, { channels: 4 });
  assert.deepEqual({ ...report }, { nonFinite: 0, negative: 0, samples: 2 });
  assert.deepEqual([...data], copy);
});

test('only float buffers are worth scanning', () => {
  assert.equal(isFloatSampleArray(new Float32Array(4)), true);
  assert.equal(isFloatSampleArray(new Uint16Array(4)), true, 'half floats are raw 16-bit words');
  assert.equal(isFloatSampleArray(new Uint8Array(4)), false);
  assert.equal(isFloatSampleArray(null), false);
});

test('an integer texture is refused before it reaches a sky sampler', () => {
  const THREE = { UnsignedIntType: 1010, IntType: 1011, RGBAIntegerFormat: 1033, RGBIntegerFormat: 1032 };
  assert.equal(samplerReadyTexture({ type: THREE.UnsignedIntType, format: 1023 }, THREE).ok, false);
  assert.match(samplerReadyTexture({ type: THREE.UnsignedIntType, format: 1023 }, THREE).reason, /integers/);
  assert.equal(samplerReadyTexture({ type: 1016, format: 1023 }, THREE).ok, true, 'half float is fine');
  assert.equal(samplerReadyTexture(null, THREE).ok, false);
});
