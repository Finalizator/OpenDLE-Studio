import test from 'node:test';
import assert from 'node:assert/strict';
import { gameView, statusBarHidden, viewNeedsScissor } from '../shared/game-view.js';
import { gameSettings, validateSetting, verticalFov } from '../shared/game-settings.js';

test('screen size reserves the classic status bar and centers reduced game viewports', () => {
  const hud = { width: 320, height: 200, reserveBottom: 32, scaleMode: 'fit' };
  assert.deepEqual(gameView(hud, gameSettings(), 800, 450),
    { x: 0, y: 0, width: 800, height: 378, inset: 72, statusbar: true });
  assert.deepEqual(gameView(hud, { viewSize: 5 }, 800, 450),
    { x: 200, y: 94, width: 400, height: 189, inset: 72, statusbar: true });
  assert.deepEqual(gameView(hud, { viewSize: 11 }, 800, 450),
    { x: 0, y: 0, width: 800, height: 450, inset: 0, statusbar: false });
  assert.deepEqual(gameView(hud, gameSettings(), 800, 450, false),
    { x: 0, y: 0, width: 800, height: 450, inset: 0, statusbar: false });
  assert.equal(gameView(hud, { viewSize: 10 }, 450, 800).inset, 45);
});

test('native Detail and Screen size settings serialize and reject invalid values', () => {
  const settings = gameSettings({ lowDetail: true, viewSize: 3 });
  assert.equal(gameSettings(JSON.parse(JSON.stringify(settings))).lowDetail, true);
  for (const value of [2, 12, 3.5, NaN, '10']) assert.throws(() => validateSetting('viewSize', value));
  for (const value of [0, 1, 'false']) assert.throws(() => validateSetting('lowDetail', value));
});

test('the status bar hidden by screen size 11 is one shared answer', () => {
  const hud = { elements: [{ id: 'stat', statusbar: true }, { id: 'cross' }] };
  assert.equal(statusBarHidden(hud, { viewSize: 11 }), true);
  assert.equal(statusBarHidden(hud, { viewSize: 10 }), false);
  // A HUD with no status bar element is never "hidden": nothing is missing.
  assert.equal(statusBarHidden({ elements: [{ id: 'cross' }] }, { viewSize: 11 }), false);
  assert.equal(statusBarHidden(undefined, { viewSize: 11 }), false);
  assert.equal(statusBarHidden(hud, {}), false);
});

test('a full-buffer view never asks for a scissor rectangle', () => {
  const hud = { width: 320, height: 200, reserveBottom: 32, scaleMode: 'fit' };
  // The bug this guards: a preview resized away from the renderer's construction size kept
  // its old scissor box, because with a full-buffer view Three never re-applies the
  // rectangle but still enables the test — the world was clipped to a corner of the canvas.
  const full = gameView(hud, { viewSize: 11 }, 1083, 609, false);
  assert.deepEqual(full, { x: 0, y: 0, width: 1083, height: 609, inset: 0, statusbar: false });
  assert.equal(viewNeedsScissor(full, 1083, 609), false);
  // Low detail renders at half the width but the same height, and still covers the buffer.
  assert.equal(viewNeedsScissor({ ...full, width: 2166 }, 2166, 609), false);
  assert.equal(viewNeedsScissor({ ...full, width: 2166 }, 2166, 609, 2), true);
  // A reduced screen size, or a status bar inset, is a real sub-viewport and needs one.
  assert.equal(viewNeedsScissor(gameView(hud, { viewSize: 5 }, 1083, 609), 1083, 609), true);
  assert.equal(viewNeedsScissor(gameView(hud, gameSettings(), 1083, 609), 1083, 609), true);
});

test('a wide window shows more world instead of closing the vertical field of view', () => {
  // GZDoom anchors `fov` to a 4:3 view: `fovratio = ratio >= 1.3 ? 4/3 : ratio` in
  // hw_entrypoint.cpp, and GetProjection divides by it. A 90 was 73.7 degrees vertically
  // whatever the window shape, and the extra width added to the horizontal instead — dividing
  // by the real aspect narrowed the frame as the window widened, which is what fullscreen
  // looked "too small" for.
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .05, `${actual} is not ${expected}`);
  close(verticalFov(90, 4 / 3), 73.74);
  close(verticalFov(90, 16 / 9), 73.74);
  close(verticalFov(90, 21 / 9), 73.74);
  close(verticalFov(70, 16 / 9), 55.41);
  // A taller-than-4:3 window keeps the horizontal angle and grows the vertical one.
  close(verticalFov(90, 1), 90);
  close(verticalFov(90, .75), 106.26);
  // The horizontal the camera ends up showing, at 16:9, is the same 4:3 angle widened.
  const horizontal = aspect => 2 * Math.atan(Math.tan(verticalFov(90, aspect) * Math.PI / 360) * aspect) * 180 / Math.PI;
  close(horizontal(4 / 3), 90);
  close(horizontal(16 / 9), 106.26);
  close(horizontal(2000 / 951), 115.25);
});
