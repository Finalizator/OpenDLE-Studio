import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIZMO_AXES, GIZMO_LENGTH, angleDegrees, axisAmount, axisField, axisPressPoint, dragPlaneNormal,
  formDrag, normalize, rayPlaneHit, ringDegrees, ringDelta, scaleFactorFromDrag, screenAngle,
} from '../shared/gizmo-math.js';

// A pointer ray from a camera at `eye` through `point`: enough of a camera to test the drag maths
// without a renderer, which is the whole reason the maths lives outside one.
const rayThrough = (eye, point) => ({ rayOrigin: eye, rayDirection: normalize([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]) });

test('the gizmo uses the Godot axes and colours', () => {
  assert.deepEqual(GIZMO_AXES.map(axis => axis.key), ['x', 'y', 'z']);
  assert.deepEqual(GIZMO_AXES.map(axis => axis.direction), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  // X red, Y green, Z blue — the same three an artist has seen in every Godot gizmo.
  assert.deepEqual(GIZMO_AXES.map(axis => axis.color), ['#f55252', '#8fdc7c', '#5a8cf0']);
  assert.deepEqual(GIZMO_AXES.map(axis => axis.field), ['width', 'height', 'depth']);
  assert.equal(axisField('y'), 'height');
  assert.equal(GIZMO_LENGTH, 50);
});

test('a drag is measured on a plane facing the camera', () => {
  assert.deepEqual(dragPlaneNormal([0, 0, -1]), [0, 0, -1]);
  assert.deepEqual(dragPlaneNormal([0, 0, -4]), [0, 0, -1]);
  assert.equal(dragPlaneNormal([0, 0, 0]), null);

  // Camera at +z looking down -z at the origin plane. A ray towards (x, 0, 0) meets it at x.
  const eye = [0, 0, 100];
  const hit = rayPlaneHit([0, 0, 0], [0, 0, -1], eye, normalize([40, 0, -100]));
  assert.ok(Math.abs(hit[0] - 40) < 1e-9 && Math.abs(hit[2]) < 1e-9, JSON.stringify(hit));
  // A ray that runs along the plane never meets it.
  assert.equal(rayPlaneHit([0, 0, 0], [0, 0, -1], eye, [1, 0, 0]), null);
});

test('a point follows the pointer exactly along its axis', () => {
  const eye = [0, 0, 100], view = [0, 0, -1];
  const press = axisPressPoint({ origin: [0, 0, 0], viewDirection: view, ...rayThrough(eye, [0, 0, 0]) });
  const moved = rayPlaneHit([0, 0, 0], dragPlaneNormal(view), eye, normalize([40, 0, -100]));
  // The world distance the pointer covered, which is what the object has to move by.
  assert.ok(Math.abs(axisAmount(moved, press, [1, 0, 0]) - 40) < 1e-9);
  assert.equal(axisAmount(moved, press, [0, 1, 0]), 0);
});

test('an axis aimed at the camera goes stiff instead of exploding', () => {
  const eye = [0, 0, 100], view = [0, 0, -1];
  const depth = [0, 0, -1];   // pointing away from the camera, seen end-on
  const press = axisPressPoint({ origin: [0, 0, 0], viewDirection: view, ...rayThrough(eye, [0, 0, 0]) });
  const moved = rayPlaneHit([0, 0, 0], dragPlaneNormal(view), eye, normalize([40, 0, -100]));
  assert.equal(axisAmount(moved, press, depth), 0);
  // Measured on the facing plane, the amount along a sideways axis is the pointer's own travel:
  // the old projection formula divided by the axis's screen length and gave thousands of units
  // for the same 40 pixels once the axis turned towards the camera.
  const sideways = [1, 0, 0];
  assert.ok(Math.abs(axisAmount(moved, press, sideways) - 40) < 1e-9);
  // Squeezing the axis a twentieth of the way towards the camera only slightly reduces the answer.
  const squeezed = normalize([.05, 0, 1]);
  const alongSqueezed = axisAmount(moved, press, squeezed);
  assert.ok(Math.abs(alongSqueezed - 40 * .05) < .01, String(alongSqueezed));
});

test('rings turn with the pointer, and the axis decides which way', () => {
  const centre = [400, 300];
  const from = screenAngle(centre, [500, 300]);            // due right
  const quarter = screenAngle(centre, [400, 400]);         // a quarter turn, screen y down
  assert.ok(Math.abs(angleDegrees(from, quarter) - 90) < 1e-9);
  assert.ok(Math.abs(angleDegrees(quarter, from) + 90) < 1e-9);
  // Wrapping the short way round, so a full turn is no turn at all.
  assert.ok(Math.abs(angleDegrees(from, from + Math.PI * 2)) < 1e-9);
  assert.ok(Math.abs(angleDegrees(from, from + Math.PI * 1.5) + 90) < 1e-9);

  // An axis pointing away from the camera turns the object with the pointer; one facing it turns
  // the other way, because the two are watched from opposite sides.
  const view = [0, 0, -1];
  assert.equal(ringDegrees({ axis: [0, 0, -1], viewDirection: view, from, to: quarter }), 90);
  assert.equal(ringDegrees({ axis: [0, 0, 1], viewDirection: view, from, to: quarter }), -90);

  // The stored yaw turns the other way from the scene's +Y, and tilt lives on the model's frame.
  assert.deepEqual(ringDelta('y', 30), { angle: -30 });
  assert.deepEqual(ringDelta('x', 30), { pitch: 30 });
  assert.deepEqual(ringDelta('z', 30), { roll: 30 });
});

test('a face drag snaps the grabbed face and pins the other one', () => {
  // A 128-wide volume from 64 to 192, dragging the +x face outwards.
  const out = formDrag({ centre: 128, size: 128, amount: 64, side: 1, grid: 16 });
  assert.equal(out.size, 192);
  assert.equal(out.centre, 128 + 32, 'the middle travels half the drag');
  assert.equal(out.centre + out.size / 2, 192 + 64, 'the grabbed face follows the pointer');
  assert.equal(out.centre - out.size / 2, 64, 'the opposite face has not moved');

  // The same drag on the -x face grows the volume the other way, and still pins +x.
  const mirrored = formDrag({ centre: 128, size: 128, amount: -64, side: -1, grid: 16 });
  assert.equal(mirrored.size, 192);
  assert.equal(mirrored.centre - mirrored.size / 2, 64 - 64);
  assert.equal(mirrored.centre + mirrored.size / 2, 192);

  // The opposite face is pinned for every step of a drag, not just the ends: this is the wobble
  // that snapping the middle and the size separately produced.
  const pinned = new Set();
  for (let amount = 20; amount <= 180; amount += 3) {
    const step = formDrag({ centre: 128, size: 128, amount, side: 1, grid: 16 });
    pinned.add(Math.round((step.centre - step.size / 2) * 1000) / 1000);
  }
  assert.deepEqual([...pinned], [64]);

  // The grabbed face lands on the grid, and the size is a whole number (rounding it after the
  // middle is derived is what leaves a few units of creep).
  for (let amount = 20; amount <= 180; amount += 3) {
    const step = formDrag({ centre: 128, size: 128, amount, side: 1, grid: 16 });
    assert.equal((step.centre + step.size / 2) % 16, 0);
    assert.ok(Number.isInteger(step.size), String(step.size));
  }
  // An odd starting size still pins the opposite face exactly: the size is rounded before the
  // middle is taken from it.
  for (const size of [127, 95, 33]) {
    for (let amount = 10; amount <= 90; amount += 7) {
      const step = formDrag({ centre: 200, size, amount, side: 1, grid: 16 });
      assert.equal(step.centre - step.size / 2, 200 - size / 2, `size ${size} amount ${amount}`);
    }
  }

  // Shift moves both faces and leaves the middle alone.
  const both = formDrag({ centre: 128, size: 128, amount: 64, side: 1, grid: 16, symmetric: true });
  assert.equal(both.size, 256);
  assert.equal(both.centre, 128);
  assert.equal(both.shift, 0);

  // A volume can never be dragged thinner than 8 units, and the pinned face still holds.
  const tiny = formDrag({ centre: 128, size: 128, amount: -200, side: 1, grid: 16 });
  assert.equal(tiny.size, 8);
  assert.equal(tiny.centre - tiny.size / 2, 64);
});

test('scale turns a drag into a factor', () => {
  // One gizmo length of drag doubles a size, and a size can never reach nothing.
  assert.equal(scaleFactorFromDrag({ amount: 100, reference: 100 }), 2);
  assert.equal(scaleFactorFromDrag({ amount: -50, reference: 100 }), .5);
  assert.equal(scaleFactorFromDrag({ amount: -1e6, reference: 100 }), .02);
});
