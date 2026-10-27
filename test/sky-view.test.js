import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skyView } from '../shared/sky-view.js';

test('the panorama sky follows the player in play, and the free camera in the editor', () => {
  const player = { angle: 1.2, pitch: -0.4 };
  assert.deepEqual(skyView({ player }), { heading: 1.2, pitch: -0.4 });
  // A player object without pitch (older saves, or a body before the first frame)
  // must not make the render loop throw "pitch is not defined".
  assert.deepEqual(skyView({ player: { angle: 0 } }), { heading: 0, pitch: 0 });
  assert.deepEqual(skyView({}), { heading: 0, pitch: 0 });
  const direction = { x: 0, y: 0, z: 0 };
  assert.equal(skyView({ editor: true, direction }).heading, 0);
  assert.equal(skyView({ editor: true, direction: { x: 0, y: 0.5, z: 1 } }).pitch, Math.asin(0.5));
  // Out-of-range direction components must not produce NaN.
  assert.equal(Number.isFinite(skyView({ editor: true, direction: { x: 1, y: 4, z: 0 } }).pitch), true);
});

test('the renderer reads the sky view from the shared helper', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.ok(render.includes('skyView({ editor, direction: camera.getWorldDirection(cameraDirection), player: state.player })'),
    'the render loop must not compute the sky view from a local that a refactor can remove');
  // A bare identifier there is the exact shape of the crash: the block used to end
  // with `= pitch;` referring to a local that the camera refactor removed.
  assert.ok(!/panoramaUniforms\.pitch\.value = [^;]*[=:]\s*pitch;/.test(render), 'no bare pitch local');
});
