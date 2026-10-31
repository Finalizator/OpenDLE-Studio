import test from 'node:test';
import assert from 'node:assert/strict';
import { wallScroll, scrolledSlots, TICRATE, WALL_SCROLLS } from '../shared/scrollers.js';

const wall = (special, args) => ({ special, args });
// Lullaby's title map: every mountain wall is special 101 with a speed of 32.
const ridge = wall(101, [32, 0, 0, 0, 0]);

test('specials 100-103 are wall scrollers and nothing else is', () => {
  assert.deepEqual([...WALL_SCROLLS].sort(), [100, 101, 102, 103]);
  assert.equal(wallScroll(wall(99, [32, 0, 0, 0, 0])), null);
  assert.equal(wallScroll(wall(104, [32, 0, 0, 0, 0])), null);
});

test('Scroll_Texture_Right slides right; Left, Up and Down take their own axes', () => {
  const width = 1024, height = 256;
  assert.deepEqual(wallScroll(wall(101, [32, 0]), { textureWidth: width, textureHeight: height }),
    { u: -0.5 / width, v: 0 });
  assert.deepEqual(wallScroll(wall(100, [32, 0]), { textureWidth: width, textureHeight: height }),
    { u: 0.5 / width, v: 0 });
  assert.deepEqual(wallScroll(wall(102, [32, 0]), { textureWidth: width, textureHeight: height }),
    { u: 0, v: 0.5 / height });
  assert.deepEqual(wallScroll(wall(103, [32, 0]), { textureWidth: width, textureHeight: height }),
    { u: 0, v: -0.5 / height });
});

test('a speed of zero scrolls nothing', () => {
  assert.equal(wallScroll(wall(101, [0, 0])), null);
});

test('the ridge walls wrap their 1024-wide picture once every 2048 tics', () => {
  const scroll = wallScroll(ridge, { textureWidth: 1024, textureHeight: 256 });
  // 0.5 texels per tic over a 1024 texel picture: one full turn of the picture per 2048 tics,
  // i.e. one every 58.5 seconds at 35 tics per second.
  assert.equal(1 / Math.abs(scroll.u), 2048);
  assert.equal(2048 / TICRATE, 2048 / 35);
});

test('args[1] selects which texture slots move, zero meaning all three', () => {
  // `SCROLLTYPE` in specials.cpp: zero, negative or out-of-range gives 7, which is all slots.
  assert.deepEqual(scrolledSlots([32, 0]), ['top', 'mid', 'bottom']);
  assert.deepEqual(scrolledSlots([32, 1]), ['top']);
  assert.deepEqual(scrolledSlots([32, 2]), ['mid']);
  assert.deepEqual(scrolledSlots([32, 4]), ['bottom']);
  assert.deepEqual(scrolledSlots([32, 5]), ['top', 'bottom']);
  assert.deepEqual(scrolledSlots([32, 8]), ['top', 'mid', 'bottom']);
  assert.deepEqual(scrolledSlots([32]), ['top', 'mid', 'bottom']);
  // A wall that only scrolls its middle texture must leave the lintel alone.
  assert.notEqual(wallScroll(wall(101, [32, 2]), { slot: 'mid' }), null);
  assert.equal(wallScroll(wall(101, [32, 2]), { slot: 'top' }), null);
});

test('a scaled wall scrolls at the rate its tiled picture is drawn at', () => {
  const plain = wallScroll(ridge, { textureWidth: 1024, textureHeight: 256 });
  const scaled = wallScroll(ridge, { textureWidth: 1024, textureHeight: 256, scale: 2 });
  assert.equal(scaled.u, plain.u / 2);
  // The offset is added to the sidedef's own, which is divided by `width * scale`, so a
  // scrolled wall has to use the same divisor or it would slide at the wrong speed.
  assert.equal(scaled.u, -0.5 / (1024 * 2));
});
