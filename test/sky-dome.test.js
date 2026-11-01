import test from 'node:test';
import assert from 'node:assert/strict';
import { skyDomeMapping, skyDomeAngle, skyDomeV, SKY_DOME_SCALE } from '../shared/sky-dome.js';

const ROW = rows => elevation => Math.round(skyDomeV(rows, elevation) * rows);

test('the dome is mapped with the branch GZDoom picks for the picture height', () => {
  // FSkyVertexBuffer::SetupMatrices in hw_skydome.cpp, one branch per size, and a normal Doom
  // level has LEVEL_FORCETILEDSKY off — so the stock 128-row sky takes the `texh < 200` branch.
  const small = skyDomeMapping(128);
  assert.equal(small.scale, 128 / 230);
  assert.equal(small.shift, -1250 / SKY_DOME_SCALE);
  assert.equal(small.textureScale, 1);
  // A 200-row picture needs no correction at all.
  assert.deepEqual(skyDomeMapping(200), { scale: 1, shift: 0, textureScale: 1 });
  // 200..240 stretches and slides by the sky offset factor (57) on a 10000-unit dome.
  const lullaby = skyDomeMapping(240);
  assert.equal(lullaby.scale, 1 + ((240 - 200) / 200) * 1.17);
  assert.equal(lullaby.shift, (200 - 240) * 57 / SKY_DOME_SCALE);
  // Taller pictures are handled like a tiled small sky, and their V repeats.
  const tall = skyDomeMapping(256);
  assert.equal(tall.scale, 1.2 * 1.17);
  assert.ok(Math.abs(tall.textureScale - 240 / 256) < 1e-9);
  // Below 128 rows GZDoom squashes 128 rows onto the dome and tiles the picture.
  const tiny = skyDomeMapping(64);
  assert.equal(tiny.scale, 128 / 230);
  assert.equal(tiny.textureScale, 2);
  // An explicitly tiled sky takes the tiled branch even at 128 rows.
  const tiled = skyDomeMapping(128, { tiled: true });
  assert.equal(tiled.scale, 1.2 * 1.17);
  assert.equal(tiled.textureScale, 240 / 128);
});

test('a 128-row sky shows its mountains at the horizon, not its dark top band', () => {
  const row = ROW(128);
  // SKY1 is 128 rows: 0-45 is the dark sky, ~46-90 the ridge line, 90+ the lit ground haze.
  // `texh < 200` puts the horizon on row 100; the old 200..240 branch put it on the bottom row
  // and the top band on the horizon, which is the flat black sky seen through windows.
  assert.equal(row(0), 100);
  assert.equal(row(10), 64);
  assert.equal(row(20), 34);
  assert.equal(row(30), 11);
  // Past the top of the dome the picture clamps instead of wrapping away.
  assert.equal(row(45), 0);
  assert.equal(row(80), 0);
  const heights = [-5, 0, 5, 10, 20, 30, 45, 60, 89].map(e => skyDomeV(128, e));
  assert.deepEqual([...heights].sort((a, b) => b - a), heights, 'the picture descends as the view rises');
  for (const value of heights) assert.ok(value >= 0 && value <= 1);
});

test('a 240-row sky keeps the horizon row Lullaby was verified against', () => {
  // The comment in render.js pins row 197 on the horizon for the 240-row sky; the mapping table
  // must not move it when other branches are added.
  assert.equal(ROW(240)(0), 197);
  assert.equal(ROW(240)(30), 101);
});

test('a picture taller than the dome covers repeats from the top', () => {
  const rows = 256;
  const v = elevation => skyDomeV(rows, elevation);
  // The V runs past 1 near the horizon, so the top band comes back in above the ridge line,
  // which is GZDoom's CLAMP_NONE on the sky material.
  assert.ok(v(0) < .95 && v(0) > .7);
  for (const elevation of [0, 10, 20, 30, 45, 60]) assert.ok(v(elevation) >= .001 && v(elevation) <= .999);
  const angles = [0, 10, 20, 30, 45].map(e => skyDomeAngle(rows, e));
  assert.deepEqual([...angles].sort((a, b) => a - b), angles, 'a higher view lands higher on the dome');
  assert.ok(angles.at(-1) > angles[0]);
});
