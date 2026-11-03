import test from 'node:test';
import assert from 'node:assert/strict';
import { rampProfile, rampProfileVertices, profileArea, validateRampProfile, editProfileVertex,
  moveProfileEdge, splitProfileEdge, removeProfileVertex, MAX_PROFILE_VERTICES } from '../shared/ramp-profile.js';

const shape = change => ({ profile: 'ridge', slope: 45, length: 64, width: 128, facing: 'right', ...change });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const areaOfCaps = geometry => geometry.triangles.reduce((sum, triangle) =>
  sum + Math.abs(profileArea(triangle.map(index => geometry.vertices[index]))), 0);

test('default profiles are unchanged triangles; flat tops and flat feet have real measurable planes', () => {
  for (const profile of ['single', 'ridge']) for (const facing of ['left', 'right']) {
    const original = rampProfile(shape({ profile, facing }));
    assert.equal(original.vertices.length, 3);
    const geometry = rampProfile(shape({ profile, facing, topWidth: 24, footWidth: 32, baseThickness: 8 }));
    const vertices = geometry.vertices, planes = vertices.map((point, index) => [point, vertices[(index + 1) % vertices.length]])
      .filter(([a, b]) => Math.abs(a.z - b.z) < 1e-6);
    const top = planes.find(([a]) => Math.abs(a.z - 64) < 1e-6);
    near(Math.abs(top[0].x - top[1].x), 24);
    const feet = planes.filter(([a]) => a.z === 0);
    assert.equal(feet.length, profile === 'ridge' ? 2 : 1);
    for (const [a, b] of feet) near(Math.abs(a.x - b.x), 32);
    near(Math.min(...vertices.map(point => point.z)), -8);
    near(areaOfCaps(geometry), Math.abs(profileArea(vertices)));
    assert.ok(profileArea(vertices) < 0);
  }
});

test('bevels cut actual corners while rounded fillets and concave toes have tangent plane joins', () => {
  const ramp = shape({ topWidth: 32, footWidth: 48, baseThickness: 8, edgeSize: 8, toeSize: 16 });
  const sharp = rampProfile(ramp), bevel = rampProfile({ ...ramp, edgeStyle: 'bevel' });
  assert.ok(Math.max(...bevel.vertices.map(point => point.z)) <= 64);
  assert.ok(Math.abs(profileArea(bevel.vertices)) < Math.abs(profileArea(sharp.vertices)), 'a bevel removes solid top corners');
  for (const segments of [2, 6, 16]) {
    const rounded = rampProfile({ ...ramp, edgeStyle: 'round', toeStyle: 'round', roundSegments: segments });
    assert.equal(rounded.vertices.length, sharp.vertices.length + 4 * segments);
    near(areaOfCaps(rounded), Math.abs(profileArea(rounded.vertices)));
    const leftToe = rounded.vertices.filter(point => point.smooth && point.x < -32 && point.z < 32);
    near(leftToe[0].z, 0);
    assert.ok(leftToe.at(-1).z > 0 && leftToe.at(-1).x > -80, 'the toe rounds into the sloped face');
    assert.ok(rounded.vertices.some(point => point.z === 0 && point.x < leftToe[0].x), 'a flat landing remains');
    const [a, b] = leftToe;
    assert.ok((b.z - a.z) / (b.x - a.x) < 1, 'the transition begins softer than the 45 degree slope');
  }
  const low = rampProfile({ ...ramp, edgeStyle: 'round', roundSegments: 2 });
  const high = rampProfile({ ...ramp, edgeStyle: 'round', roundSegments: 16 });
  assert.ok(high.vertices.length > low.vertices.length, 'density controls actual geometry, not only normals');
});

test('custom concave and reverse-wound polygons triangulate without filling their notches', () => {
  const vertices = [{ x: -64, z: -8 }, { x: -64, z: 64 }, { x: -24, z: 64 }, { x: -24, z: 16 },
    { x: 24, z: 16 }, { x: 24, z: 64 }, { x: 64, z: 64 }, { x: 64, z: -8 }];
  for (const points of [vertices, [...vertices].reverse(), splitProfileEdge(vertices, 2)]) {
    const geometry = rampProfile(shape({ profile: 'custom', vertices: points }));
    assert.equal(geometry.triangles.length, points.length - 2);
    near(areaOfCaps(geometry), Math.abs(profileArea(points)));
    for (const triangle of geometry.triangles) {
      const centre = triangle.map(index => geometry.vertices[index]).reduce((sum, point) =>
        ({ x: sum.x + point.x / 3, z: sum.z + point.z / 3 }), { x: 0, z: 0 });
      assert.ok(Math.abs(centre.x) >= 24 || centre.z <= 16, 'no triangle covers the concave notch');
    }
  }
});

test('vertex, corner, face-offset, split and remove edits are immutable and preserve exact coordinates', () => {
  const vertices = rampProfileVertices(shape()), snapshot = structuredClone(vertices);
  const moved = editProfileVertex(vertices, 1, { x: 4, z: 80, style: 'round', size: 6 });
  assert.equal(moved[1].x, 4); assert.equal(moved[1].z, 80);
  assert.equal(moved[1].style, 'round'); assert.equal(moved[1].size, 6);
  rampProfile(shape({ profile: 'custom', vertices: moved }));
  for (const points of [vertices, [...vertices].reverse()]) {
    const base = points.findIndex((point, index) => point.z === 0 && points[(index + 1) % points.length].z === 0);
    const offset = moveProfileEdge(points, base, 12);
    near(offset[base].z, -12);
    near(offset[(base + 1) % points.length].z, -12);
  }
  const split = splitProfileEdge(vertices, 0);
  near(split[1].x, (vertices[0].x + vertices[1].x) / 2);
  assert.equal(rampProfile(shape({ profile: 'custom', vertices: split })).triangles.length, 2);
  const removed = removeProfileVertex(split, 1);
  assert.deepEqual(removed, vertices);
  assert.deepEqual(vertices, snapshot, 'no editor operation mutates the previous undo snapshot');
  assert.throws(() => removeProfileVertex(vertices, 1), /at least three/);
  assert.throws(() => splitProfileEdge(Array.from({ length: MAX_PROFILE_VERTICES }, () => ({ x: 1, z: 2 })), 0), /at most/);
});

test('malformed outlines, dimensions, detail and overlapping corner trims fail explicitly', () => {
  const triangle = rampProfileVertices(shape());
  for (const changes of [{ profile: 'unknown' }, { topWidth: -1 }, { footWidth: Infinity }, { edgeSize: NaN },
    { edgeStyle: 'soft' }, { roundSegments: 1.5 }, { roundSegments: 17 }, { profile: 'custom' },
    { profile: 'custom', vertices: [null, ...triangle] }, { profile: 'custom', vertices: [] },
    { profile: 'custom', vertices: [...triangle, { ...triangle[0] }] },
    { profile: 'custom', vertices: [{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 }] },
    { profile: 'custom', vertices: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }] },
    { footWidth: 32, baseThickness: 0 }, { edgeStyle: 'round', edgeSize: 200 },
    { topWidth: 16, edgeStyle: 'round', edgeSize: 8 }, { topWidth: 4096 }]) {
    assert.throws(() => rampProfile(shape(changes)), /Ramp profile:/);
  }
  for (const point of [{ style: 'soft' }, { size: -2 }, { x: NaN }, { z: 9000 }])
    assert.throws(() => validateRampProfile(shape({ vertices: editProfileVertex(triangle, 1, point) })), /Ramp profile:/);
});
