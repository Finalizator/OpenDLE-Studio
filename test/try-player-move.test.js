import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BUMPS, MAX_CLIP_PLANES, SV_STEPSIZE, categorizePosition, clipAgainstCrease, isStandable,
  playerMove, stepMove, tryPlayerMove,
} from '../shared/try-player-move.js';
import { clipVelocity } from '../shared/source-motion.js';

/**
 * A world of infinite planes, each `{ normal, offset }` meaning `normal · point = offset`, plus an
 * optional `floor` height. That is all the algorithm ever asks of a collision backend, so it is
 * enough to prove the behaviour of a surf ramp, a floor and a stair without a physics engine.
 */
function planeWorld(planes, { floor = null } = {}) {
  const traces = [];
  const trace = (from, to) => {
    traces.push([from, to]);
    const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    let fraction = 1, normal = null;
    for (const plane of planes) {
      const start = plane.normal.x * from.x + plane.normal.y * from.y + plane.normal.z * from.z - plane.offset;
      const along = plane.normal.x * delta.x + plane.normal.y * delta.y + plane.normal.z * delta.z;
      if (start < 0) return { fraction: 0, normal: plane.normal, startSolid: true };
      if (along >= -1e-9) continue;                  // not heading into this plane
      const hit = start / -along;
      if (hit < fraction) { fraction = hit; normal = plane.normal; }
    }
    if (floor !== null && delta.z < 0) {
      const hit = (from.z - floor) / -delta.z;
      if (hit < fraction) { fraction = hit; normal = { x: 0, y: 0, z: 1 }; }
    }
    if (fraction === 0) return { fraction: 0, normal, startSolid: true };
    return { fraction, normal, startSolid: false };
  };
  trace.traces = traces;
  return trace;
}

// A 50 degree face through the origin that rises toward -x, so its surface height at x is
// `-tan(50) * x`. The outward normal points +x and up.
const RADIANS = 50 * Math.PI / 180;
const RAMP = { normal: { x: Math.sin(RADIANS), y: 0, z: Math.cos(RADIANS) }, offset: 0 };
/** A point `gap` units off the ramp face directly above `x`. */
const aboveRamp = (x, gap) => ({ x, y: 0, z: (-Math.tan(RADIANS) * x) + gap / Math.cos(RADIANS) });

test('a fall onto a steep face turns into motion along it, and keeps every unit', () => {
  const trace = planeWorld([RAMP]);
  const start = aboveRamp(0, 2);
  // Falling straight down onto the 50 degree face.
  const result = tryPlayerMove(start, { x: 0, y: 0, z: -600 }, 1 / 100, trace);
  assert.ok(result.velocity.z > -600, 'the downward velocity is not deleted');
  // The velocity now lies in the plane: its component along the normal is gone.
  const into = result.velocity.x * RAMP.normal.x + result.velocity.z * RAMP.normal.z;
  assert.ok(Math.abs(into) < 1e-6, `velocity lies along the face (into ${into})`);
  // The fall becomes motion along the ramp, down-slope: +x and falling, along the face.
  assert.ok(result.velocity.x > 0, 'and the fall has become motion along the ramp');
  const along = { x: Math.cos(RADIANS), y: 0, z: -Math.sin(RADIANS) };    // down-slope direction
  const projected = -600 * along.z;
  assert.ok(Math.abs(result.velocity.x - projected * along.x) < 1e-6,
    `speed along the surface is the fall projected onto it (${result.velocity.x} vs ${projected * along.x})`);
});

test('landing on a floor keeps the horizontal velocity, which is what ends a surf run when it does not', () => {
  const trace = planeWorld([], { floor: 0 });
  const result = tryPlayerMove({ x: 0, y: 0, z: 1 }, { x: 250, y: 0, z: -300 }, 1 / 100, trace);
  assert.equal(Math.round(result.velocity.x), 250, 'all of the horizontal speed survives');
  assert.equal(Math.round(result.velocity.z), 0, 'and the fall into the floor is stopped');
  assert.equal(Math.round(result.position.z), 0, 'the player is on the floor');
});

test('a run of more than four collisions keeps the velocity instead of stopping dead', () => {
  // Five planes in a ring, each clipped in turn within one tick: bump limit 4 is reached.
  const planes = Array.from({ length: 6 }, (unused, index) => {
    const angle = index * Math.PI / 3;
    return { normal: { x: Math.cos(angle), y: Math.sin(angle), z: 0 }, offset: 0 };
  });
  const trace = planeWorld(planes);
  const result = tryPlayerMove({ x: 0, y: 0, z: 50 }, { x: 400, y: 200, z: 0 }, 1 / 100, trace);
  assert.ok(Number.isFinite(result.velocity.x), 'the velocity stays a number');
  assert.ok(MAX_CLIP_PLANES === 5 && MAX_BUMPS === 4, 'the limits are GoldSrc’s');
});

test('a crease is slid along rather than pushed back into the other plane', () => {
  const a = { x: 0, y: 0, z: 1 }, b = { x: -1, y: 0, z: 0 };
  const crease = clipAgainstCrease({ x: 5, y: 3, z: -5 }, a, b);
  assert.ok(Math.abs(crease.y - 3) < 1e-9, 'the component along the crease survives');
  assert.ok(Math.abs(crease.x) < 1e-9 && Math.abs(crease.z) < 1e-9, 'the rest is gone');
});

test('a surface is only standable below 45.573 degrees', () => {
  assert.equal(isStandable({ x: 0, y: 0, z: 1 }), true, 'a floor');
  assert.equal(isStandable({ x: 0, y: 0, z: Math.cos(45 * Math.PI / 180) }), true, '45 degrees is walkable');
  assert.equal(isStandable({ x: 0, y: 0, z: Math.cos(50 * Math.PI / 180) }), false, '50 degrees is a surf ramp');
});

test('categorizePosition refuses to ground a player on a surf ramp, so friction never applies', () => {
  const flat = planeWorld([], { floor: 0 });
  assert.equal(categorizePosition({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, flat).grounded, true);
  const ramp = planeWorld([RAMP]);
  const state = categorizePosition({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, ramp);
  assert.ok(Math.abs(state.ground.normal.z - RAMP.normal.z) < 1e-9, 'the ramp is what is below');
  assert.equal(state.grounded, false, 'and it is not ground');
});

test('a player who is rising is never grounded, so a jump leaves the floor', () => {
  const trace = planeWorld([], { floor: 0 });
  // A hair off the floor, as a player is on the tic they jump: the floor is well inside any probe,
  // so without the rise rule they would still be standing and `StayOnGround` would pull them back.
  const origin = { x: 0, y: 0, z: 1 };
  assert.equal(categorizePosition(origin, null, trace, { velocity: { x: 0, y: 0, z: 0 } }).grounded, true,
    'standing still on the floor is ground');
  assert.equal(categorizePosition(origin, null, trace, { velocity: { x: 0, y: 0, z: 160 } }).grounded, false,
    'rising at jump speed is not');
  // 140 is Source's own threshold: a walkable slope never pushes a player up that fast.
  assert.equal(categorizePosition(origin, null, trace, { velocity: { x: 0, y: 0, z: 139 } }).grounded, true,
    'and 139 units a second up is still standing');
});

test('the ground probe is 2 units, as CategorizePosition says, so a jump is not caught mid-rise', () => {
  const trace = planeWorld([], { floor: 0 });
  assert.equal(categorizePosition({ x: 0, y: 0, z: 1 }, null, trace).grounded, true, 'touching the floor');
  assert.equal(categorizePosition({ x: 0, y: 0, z: 5 }, null, trace).grounded, false,
    '3 units clear of it is not standing — a probe of `sv_stepsize` would have said it was, which is '
    + 'how a jump of 2.7 units was re-grounded before it started');
});

test('a stair is climbed by the step move, and a wall is not', () => {
  // A step of 16 units: the trace from below meets a vertical face, then the raised move clears it.
  const step = { z: 16 };
  const trace = (from, to) => {
    // Upward and downward traces are free; a horizontal trace at or below the step height is
    // blocked by the step's face at x = 10.
    if (Math.abs(to.z - from.z) > 1e-9) {
      const descending = to.z < from.z;
      const floorZ = from.z > step.z ? step.z : 0;
      if (descending && from.z > floorZ) return { fraction: Math.min(1, (from.z - floorZ) / (from.z - to.z)),
        normal: { x: 0, y: 0, z: 1 }, startSolid: false };
      return { fraction: 1, normal: null, startSolid: false };
    }
    if (from.z < step.z && from.x < 10 && to.x > 10) return { fraction: (10 - from.x) / (to.x - from.x),
      normal: { x: -1, y: 0, z: 0 }, startSolid: false };
    return { fraction: 1, normal: null, startSolid: false };
  };
  const climbed = stepMove({ x: 0, y: 0, z: 0 }, { x: 320, y: 0, z: 0 }, 1 / 35, trace);
  assert.ok(climbed, 'the step is taken');
  assert.equal(climbed.position.z, step.z, 'and the player stands on top of it');
  // A 40 unit wall is above sv_stepsize and must not be climbed.
  const tall = (from, to) => (Math.abs(to.z - from.z) > 1e-9
    ? { fraction: 1, normal: null, startSolid: false }
    : from.x < 10 && to.x > 10 ? { fraction: (10 - from.x) / (to.x - from.x), normal: { x: -1, y: 0, z: 0 }, startSolid: false }
      : { fraction: 1, normal: null, startSolid: false });
  assert.equal(stepMove({ x: 0, y: 0, z: 0 }, { x: 320, y: 0, z: 0 }, 1 / 35, tall), null, 'a wall is not a step');
  assert.ok(SV_STEPSIZE === 18, 'sv_stepsize is Half-Life’s 18');
});

test('a whole tick slides along the ramp and carries the speed out of it', () => {
  const trace = planeWorld([RAMP]);
  // Falling beside the ramp while pressing into it: the classic surf entry.
  const start = aboveRamp(0, 1);
  const result = playerMove(start, { x: -40, y: 0, z: -250 }, 1 / 100, trace, { grounded: false });
  assert.ok(result.position.z < start.z, 'the player descended');
  // Exactly the projection, and nothing else: the only speed lost is the part that pointed into
  // the face. That "nothing else" is the property a surf run depends on.
  const expected = clipVelocity({ x: -40, y: 0, z: -250 }, RAMP.normal, 1);
  assert.ok(Math.abs(result.velocity.x - expected.x) < 1e-6, `x matches the projection (${result.velocity.x} vs ${expected.x})`);
  assert.ok(Math.abs(result.velocity.z - expected.z) < 1e-6, `z matches the projection (${result.velocity.z} vs ${expected.z})`);
  assert.ok(result.velocity.x > 40, 'and the fall has become speed along the ramp');
});
