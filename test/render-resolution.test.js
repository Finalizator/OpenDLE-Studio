import test from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_RESOLUTIONS, RENDER_RESOLUTION_VALUES, parseRenderResolution, renderBufferSize } from '../shared/render-resolution.js';
import { GAME_SETTINGS, gameSettings, validateSetting } from '../shared/game-settings.js';
import { engineTweaks } from '../shared/engine-tweaks.js';

test('the render resolution is a selectable engine tweak', () => {
  assert.equal(GAME_SETTINGS.renderResolution.value, 'display');
  assert.deepEqual(GAME_SETTINGS.renderResolution.options, RENDER_RESOLUTION_VALUES);
  assert.deepEqual(RENDER_RESOLUTION_VALUES, ['display', '1280x720', '1600x900', '1920x1080', '2560x1440', '3840x2160']);
  assert.equal(RENDER_RESOLUTIONS[0].value, 'display');
  for (const value of RENDER_RESOLUTION_VALUES) assert.equal(validateSetting('renderResolution', value), value);
  assert.throws(() => validateSetting('renderResolution', '9000x9000'), /Invalid game setting/);
  assert.throws(() => validateSetting('renderResolution', 2), /Invalid game setting/);
  assert.equal(gameSettings({ renderResolution: '2560x1440' }).renderResolution, '2560x1440');
  assert.equal(engineTweaks({}).renderResolution, 'display');
  assert.equal(engineTweaks({ renderResolution: '1920x1080' }).renderResolution, '1920x1080');
  assert.throws(() => engineTweaks({ renderResolution: 'cinema' }), /Invalid game setting/);
});

test('display resolution renders at the panel pixel size, capped at 2x', () => {
  assert.deepEqual(renderBufferSize({ cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 }),
    { width: 1280, height: 720, pixelated: false });
  assert.deepEqual(renderBufferSize({ cssWidth: 1280, cssHeight: 720, devicePixelRatio: 2 }),
    { width: 2560, height: 1440, pixelated: false });
  // HiDPI beyond 2x would cost more than it shows, so the ratio is capped.
  assert.deepEqual(renderBufferSize({ cssWidth: 1280, cssHeight: 720, devicePixelRatio: 3 }),
    { width: 2560, height: 1440, pixelated: false });
  assert.deepEqual(renderBufferSize({ cssWidth: 800, cssHeight: 450 }),
    { width: 800, height: 450, pixelated: false });
});

test('a chosen preset sets the vertical resolution and keeps the panel aspect', () => {
  // A 16:9 panel at 1080p renders exactly 1920x1080.
  assert.deepEqual(renderBufferSize({ resolution: '1920x1080', cssWidth: 960, cssHeight: 540 }),
    { width: 1920, height: 1080, pixelated: false });
  // A wider panel keeps its aspect instead of stretching the picture.
  assert.deepEqual(renderBufferSize({ resolution: '1920x1080', cssWidth: 1000, cssHeight: 500 }),
    { width: 2160, height: 1080, pixelated: false });
  // Rendering below the panel size is upscaled, so it stays crisp.
  assert.deepEqual(renderBufferSize({ resolution: '1280x720', cssWidth: 1920, cssHeight: 1080 }),
    { width: 1280, height: 720, pixelated: true });
  // Presets ignore the device pixel ratio: 720p is 720 lines on any display, and on a
  // 2x panel that is below the physical size, so the upscale stays crisp.
  assert.deepEqual(renderBufferSize({ resolution: '1280x720', cssWidth: 960, cssHeight: 540, devicePixelRatio: 2 }),
    { width: 1280, height: 720, pixelated: true });
});

test('render scale, low detail and output limits still apply on top', () => {
  assert.deepEqual(renderBufferSize({ resolution: '1920x1080', cssWidth: 960, cssHeight: 540, scale: .5 }),
    { width: 960, height: 540, pixelated: false });
  assert.deepEqual(renderBufferSize({ resolution: '1920x1080', cssWidth: 960, cssHeight: 540, scale: 1.5 }),
    { width: 2880, height: 1620, pixelated: false });
  // Classic low detail halves horizontal resolution only.
  assert.deepEqual(renderBufferSize({ resolution: '1920x1080', cssWidth: 960, cssHeight: 540, lowDetail: true }),
    { width: 960, height: 1080, pixelated: true });
  // Oversized buffers shrink together so the aspect ratio survives.
  assert.deepEqual(renderBufferSize({ resolution: '3840x2160', cssWidth: 3840, cssHeight: 2160, scale: 2, maxSize: 4096 }),
    { width: 4096, height: 2304, pixelated: false });
  // A collapsed panel keeps a usable buffer instead of a degenerate one.
  assert.deepEqual(renderBufferSize({ cssWidth: 0, cssHeight: 0 }),
    { width: 800, height: 450, pixelated: false });
});

test('resolution parsing accepts WxH presets only', () => {
  assert.deepEqual(parseRenderResolution('1920x1080'), { width: 1920, height: 1080 });
  assert.equal(parseRenderResolution('display'), null);
  assert.equal(parseRenderResolution('1920'), null);
  assert.equal(parseRenderResolution('0x1080'), null);
  assert.equal(parseRenderResolution(''), null);
  assert.equal(parseRenderResolution(undefined), null);
  // An unknown value falls back to display size instead of failing the frame.
  assert.deepEqual(renderBufferSize({ resolution: 'cinema', cssWidth: 800, cssHeight: 450 }),
    { width: 800, height: 450, pixelated: false });
});
