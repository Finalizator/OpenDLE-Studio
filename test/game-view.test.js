import test from 'node:test';
import assert from 'node:assert/strict';
import { gameView, statusBarHidden } from '../shared/game-view.js';
import { gameSettings, validateSetting } from '../shared/game-settings.js';

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
