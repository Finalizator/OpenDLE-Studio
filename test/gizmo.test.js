import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIZMO_AXES, GIZMO_LENGTH, angleDegrees, axisAmount, axisField, axisPressPoint, dragPlaneNormal,
  formCentreShift, formSizeFromDrag, normalize, rayPlaneHit, ringDegrees, ringDelta, scaleFactorFromDrag, screenAngle,
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

test('form and scale turn a drag into a size', () => {
  // By default only the grabbed face moves: the side grows by the drag, and the middle goes half
  // way so the opposite face stays put.
  assert.equal(formSizeFromDrag(128, 64), 192);
  assert.equal(formCentreShift(64), 32);
  assert.equal(formSizeFromDrag(128, -64), 64);
  // Holding Shift grows both faces: twice the drag, and the middle stays where it is.
  assert.equal(formSizeFromDrag(128, 64, 1, true), 256);
  assert.equal(formCentreShift(64, true), 0);
  // A face on the negative side pulls the other way on the axis, and still has to grow when it is
  // dragged away from the volume — one-sided or symmetric.
  assert.equal(formSizeFromDrag(128, -64, -1), 192);
  assert.equal(formSizeFromDrag(128, -64, -1, true), 256);
  assert.equal(formSizeFromDrag(128, 64, -1), 64);
  // One gizmo length of drag doubles a size, and a size can never reach nothing.
  assert.equal(scaleFactorFromDrag({ amount: 100, reference: 100 }), 2);
  assert.equal(scaleFactorFromDrag({ amount: -50, reference: 100 }), .5);
  assert.equal(scaleFactorFromDrag({ amount: -1e6, reference: 100 }), .02);
});
