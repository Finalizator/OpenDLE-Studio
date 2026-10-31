import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePlaneMotion, startWaggle, syncThreeDFloors, TICRATE } from '../shared/plane-motion.js';

// Lullaby's title map calls `Ceiling_Waggle(7, 24, 32, 0, 0)` and `Floor_Waggle(7, 24, 32, 0, 0)`
// on the control sectors of its 3D floors: amplitude 24, frequency 32, no delay, forever.
function titleMap() {
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  const control = { id: 'sector24', tag: 7, floorHeight: 48, ceilingHeight: 53, light: 192, rings: [], bounds };
  const platform = { id: 'sector86', tag: 5, floorHeight: 0, ceilingHeight: 3072, light: 176, rings: [], bounds,
    threeDFloors: [{ controlId: 'sector24', top: 53, bottom: 48, solid: true, thin: false }] };
  const far = { id: 'sector0', tag: 0, floorHeight: 0, ceilingHeight: 128, light: 160, rings: [], bounds };
  return {
    state: { sectors: [control, platform, far], entities: [], player: { x: -999, y: -999 }, worldRevision: 0 },
    control, platform,
  };
}

test('a waggle drifts a plane the way GZDoom pulses it', () => {
  const { state, control } = titleMap();
  assert.equal(startWaggle(state, { tag: 7, amplitude: 24, speed: 32, offset: 0, timer: 0, ceiling: true }), 1);
  assert.equal(state.waggles.length, 1);
  // `BobSin` doubles the amplitude with its 8 and the scale divides by 64, so 24 units of
  // amplitude is a quarter of 24 in each direction at full swing.
  const swing = 24 / 64 * 8;
  let lowest = Infinity, highest = -Infinity;
  for (let frame = 0; frame < 2000; frame++) {
    advancePlaneMotion(state, 1 / 60);
    lowest = Math.min(lowest, control.ceilingHeight);
    highest = Math.max(highest, control.ceilingHeight);
  }
  assert.ok(highest > 53, 'the ceiling rises above where the map put it');
  assert.ok(lowest < 53, 'and falls below it');
  assert.ok(highest - 53 <= swing + 0.001, `the rise stays within the amplitude (${(highest - 53).toFixed(2)} > ${swing})`);
  assert.ok(53 - lowest <= swing + 0.001, 'and so does the fall');
  assert.equal(control.floorHeight, 48, 'a ceiling waggle leaves the floor alone');
});

test('a waggle with a timer puts the plane back where it started', () => {
  const { state, control } = titleMap();
  startWaggle(state, { tag: 7, amplitude: 24, speed: 32, offset: 0, timer: 1, ceiling: true });
  for (let frame = 0; frame < TICRATE * 3; frame++) advancePlaneMotion(state, 1 / 60);
  assert.equal(control.ceilingHeight, 53, 'the ceiling returns to the map height');
  assert.equal(state.waggles.length, 0, 'and the thinker is gone');
});

test('a 3D floor rides the control sector it was built from', () => {
  const { state, control, platform } = titleMap();
  startWaggle(state, { tag: 7, amplitude: 24, speed: 32, offset: 0, timer: 0, ceiling: true });
  for (let frame = 0; frame < 240; frame++) advancePlaneMotion(state, 1 / 60);
  assert.notEqual(platform.threeDFloors[0].top, 53, 'the platform top moved');
  assert.equal(platform.threeDFloors[0].top, control.ceilingHeight, 'and it is exactly the control ceiling');
  assert.equal(platform.threeDFloors[0].bottom, control.floorHeight, 'the bottom is the control floor');
});

test('what stands on a moving 3D floor travels with it', () => {
  const { state, platform } = titleMap();
  platform.rings = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
  const star = { id: 'thing9', tid: 9, x: 50, y: 50, z: 53, elevation: 53 };
  state.entities.push(star);
  startWaggle(state, { tag: 7, amplitude: 24, speed: 32, offset: 0, timer: 0, ceiling: true });
  const before = star.z;
  for (let frame = 0; frame < 240; frame++) advancePlaneMotion(state, 1 / 60);
  assert.notEqual(star.z, before, 'the actor standing on the platform moved with it');
  assert.equal(star.z, platform.threeDFloors[0].top, 'and it is still exactly on the surface');
});

test('a thin 3D floor stays on the control ceiling', () => {
  const sectors = [
    { id: 'a', tag: 1, floorHeight: 0, ceilingHeight: 64, light: 160, rings: [], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
    { id: 'b', tag: 0, floorHeight: 0, ceilingHeight: 200, light: 160, rings: [], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
      threeDFloors: [{ controlId: 'a', top: 64, bottom: 64, solid: true, thin: true }] },
  ];
  const index = new Map(sectors.map(sector => [sector.id, sector]));
  sectors[0].ceilingHeight = 70;
  assert.equal(syncThreeDFloors(sectors, index), true);
  assert.equal(sectors[1].threeDFloors[0].top, 70);
  assert.equal(sectors[1].threeDFloors[0].bottom, 70, 'a thin floor has no thickness to keep');
});
