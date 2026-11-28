/**
 * The sky's wrap seam.
 *
 * A panorama's longitude wraps at one meridian, and a sampler left to derive its own mip level sees
 * the coordinate jump there as an enormous screen-space derivative: the fragments on the seam take
 * the coarsest mip — the picture's average colour — and draw a bright line down the sky. The
 * material therefore picks the level from the view's own detail budget (pixels per radian) instead
 * of from derivatives, so there is no derivative to spike.
 *
 * This pins the parts a GPU would otherwise hide: the level is computed from numbers the consumer
 * feeds, and both consumers feed it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const material = readFileSync(resolve(root, 'public/sky-material.js'), 'utf8');
const render = readFileSync(resolve(root, 'public/render.js'), 'utf8');
const viewport = readFileSync(resolve(root, 'public/skybox-viewport.js'), 'utf8');

test('a picture layer is sampled at an explicit mip level, not from screen derivatives', () => {
  assert.match(material, /textureLevel\(source, vec2\(sampleU, sampleV\), level\)/,
    'the picture sampler takes a level');
  assert.doesNotMatch(material, /const sampler = texture\(source, vec2\(sampleU, sampleV\)\)/,
    'no implicit-derivative sample is left behind');
  assert.match(material, /const pixelsPerRadian = uniform\(/, 'the level comes from a uniform');
});

test('the level follows the picture detail against the screen detail', () => {
  // texels per radian grows with the picture and with its tiling, and shrinks with the window.
  assert.match(material, /const texelsPerRadian = Math\.max\(1, \(Number\(source\.image\?\.width\) \|\| 1024\) \*/);
  assert.match(material, /Math\.max\(1, Number\(uvRepeat\.repeatU \?\? 1\) \|\| 1\)/);
  assert.match(material, /const level = float\(texelsPerRadian\)\.div\(pixelsPerRadian\.max\(1\)\)\.log2\(\)\.max\(0\)/);
});

test('both renderers tell the material how detailed the view is', () => {
  // The engine's level view.
  assert.match(render, /layered\.uniforms\.pixelsPerRadian\.value = Math\.max\(1, canvas\.height \/ \(camera\.fov \* Math\.PI \/ 180\)\)/);
  // The tab's own viewport.
  assert.match(viewport, /built\.uniforms\.pixelsPerRadian\.value = Math\.max\(1, \(bounds\.height \|\| 240\) \/ \(view\.fov \* DEG\)\)/);
});
