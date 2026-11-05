import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceLight, surfaceBrightness } from '../shared/light-levels.js';
import { spritePlacement } from '../shared/entity-visuals.js';
import { actorFrameRun } from '../shared/sprite-animation.js';

// Rendering / sprite / model-visual bug hunt. Each regression below names one distinct
// root cause and fails against the unfixed implementation.

test('light mode 4 (legacy) and 8 (software) are linear, exactly like GZDoom CalcLightLevel', () => {
  // GZDoom's `isDarkLightMode` is { ELightMode::Doom (2), ELightMode::DoomDark (3) } only.
  // CalcLightLevel applies the crushed 192..100 curve for those two modes; DoomLegacy (4) and
  // ZDoomSoftware (8) take the linear `lightlevel + rellight` branch.
  assert.equal(surfaceLight(136, 2), 87, 'Doom mode is still crushed');
  assert.equal(surfaceLight(136, 3), 87, 'DoomDark mode is still crushed');
  assert.equal(surfaceLight(136, 4), 136, 'DoomLegacy renders linearly, not crushed');
  assert.equal(surfaceLight(136, 8), 136, 'software mode renders linearly in CalcLightLevel');
  assert.equal(surfaceLight(136, 0), 136);
  assert.equal(surfaceLight(136, 1), 136, 'DoomBright is linear');
  assert.equal(surfaceBrightness(136, 4), surfaceBrightness(136, 0), 'legacy is as bright as standard');
});

test('a Doom patch with offsetY 0 anchors its top row, not its feet', () => {
  // Doom's patch `top offset` is the distance from the image top to the thing origin; 0 is a
  // valid value (origin at the top row). The renderer's effect path already reads it raw
  // (center.y = 1 - offsetY/height); spritePlacement must not turn 0 into "missing".
  const entity = { x: 0, y: 0 };
  const asset = { width: 40, height: 56, offsetX: 20, offsetY: 0 };
  const placement = spritePlacement(entity, asset, 0);
  assert.equal(placement.offsetY, 0);
  // The card is 56 tall, centred on its size, so the top row lands on the object.
  assert.equal(placement.centre.y, -28, 'top-anchored: centre sits half a height below the anchor');
  // Companions: a bottom anchor (offsetY == height) still sits 28 above the floor, and a
  // missing offset still defaults to the bottom of the artwork.
  assert.equal(spritePlacement(entity, { ...asset, offsetY: 56 }, 0).centre.y, 28);
  assert.equal(spritePlacement(entity, { width: 40, height: 56, offsetX: 20 }, 0).centre.y, 28);
  assert.equal(spritePlacement(entity, { width: 40, height: 56, offsetX: 20, offsetY: null }, 0).centre.y, 28);
});

test('a zero-duration actor frame does not cut the rest of the state block off', () => {
  // DECORATE/ZScript zero-duration states (`SKEL G 0 A_FaceTarget`) run and fall through to the
  // following states; they are not block terminators. The Revenant's Missile block starts with
  // one, so its run must still contain the follow-up frames.
  const actor = { states: { labels: { Missile: 0 }, frames: [
    { kind: 'frame', sprite: 'SKEL', letter: 'J', duration: 0, label: 'Missile' },
    { kind: 'frame', sprite: 'SKEL', letter: 'J', duration: 10, label: 'Missile' },
    { kind: 'frame', sprite: 'SKEL', letter: 'K', duration: 10, label: 'Missile' },
    { kind: 'goto', target: 'See', label: 'Missile' },
  ] } };
  assert.deepEqual(actorFrameRun(actor, 'Missile').map(frame => `${frame.letter}:${frame.duration}`),
    ['J:0', 'J:10', 'K:10']);
});

test('actorFrameRun still ends at terminators, labels and the final corpse frame', () => {
  const actor = { states: { labels: { Spawn: 0, See: 3, Death: 5 }, frames: [
    { kind: 'frame', sprite: 'TROO', letter: 'A', duration: 10, label: 'Spawn' },
    { kind: 'frame', sprite: 'TROO', letter: 'B', duration: 10, label: 'Spawn' },
    { kind: 'loop', label: 'Spawn' },
    { kind: 'frame', sprite: 'TROO', letter: 'C', duration: 4, label: 'See' },
    { kind: 'goto', target: 'Spawn', label: 'See' },
    { kind: 'frame', sprite: 'TROO', letter: 'D', duration: 6, label: 'Death' },
    { kind: 'frame', sprite: 'TROO', letter: 'E', duration: -1, label: 'Death' },
    { kind: 'stop', label: 'Death' },
  ] } };
  assert.deepEqual(actorFrameRun(actor, 'Spawn').map(frame => frame.letter), ['A', 'B']);
  assert.deepEqual(actorFrameRun(actor, 'See').map(frame => frame.letter), ['C']);
  // The -1 duration corpse frame is the last one drawn, so it stays in the run.
  assert.deepEqual(actorFrameRun(actor, 'Death').map(frame => `${frame.letter}:${frame.duration}`), ['D:6', 'E:-1']);
  assert.deepEqual(actorFrameRun(actor, 'Missing'), []);
});
