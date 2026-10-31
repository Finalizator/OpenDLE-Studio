import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceLight, surfaceBrightness } from '../shared/light-levels.js';

// The numbers are GZDoom's own (`CalcLightLevel` in hw_lighting.cpp), so a level that asks for
// Doom's lighting is drawn the way Doom draws it rather than with a linear ramp.
test("Doom's light mode crushes a sector's light the way GZDoom does", () => {
  assert.equal(surfaceLight(136, 2), 87, 'light 136 is drawn at 87 in Doom mode');
  assert.equal(surfaceLight(96, 2), 19.2, 'below 100 the level is divided by five');
  assert.equal(surfaceLight(192, 2), 192, 'from 192 upward the level is used as written');
  assert.equal(surfaceLight(255, 2), 255);
  assert.equal(surfaceLight(0, 2), 0, 'a sector at light 0 is black, as in Doom');
  // The standard mode is linear, which is what a project without `lightmode` uses.
  assert.equal(surfaceLight(136, 0), 136);
  assert.equal(surfaceLight(136), 136);
  // Fake contrast never turns a lit surface into a black one.
  assert.equal(surfaceLight(136, 2, -16), 71, 'the offset is applied after the curve');
  assert.equal(surfaceLight(1, 2), 1);
  assert.ok(surfaceBrightness(136, 2) < surfaceBrightness(136, 0));
});
