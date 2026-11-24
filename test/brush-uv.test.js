import test from 'node:test';
import assert from 'node:assert/strict';
import { brushUvAxes, brushFaceUv, BRUSH_TEXTURE_SIZE } from '../shared/uv.js';
import { createBoxBrush, brushGeometry, moveBrush, duplicateBrush, splitBrush, setBrushFaceMaterial } from '../shared/brushes.js';
import { createProject } from '../shared/project.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const length = Math.hypot(...a) || 1; return a.map(value => value / length); };
const span = values => Math.max(...values) - Math.min(...values);

function cube() {
  const project = createProject();
  const brush = createBoxBrush(project, { x: -64, y: -64, z: 0, width: 128, depth: 128, height: 64 });
  return { project, brush };
}

test('every box face gets a texture frame that actually spans it', () => {
  // A face whose normal is axis-aligned used to be projected with its point components in the wrong
  // order, which left U constant on three of the six faces: the texture stretched into stripes.
  const { brush } = cube();
  for (const entry of brushGeometry(brush).faces) {
    const face = brush.faces[entry.index];
    const us = entry.points.map(point => brushFaceUv(face, entry.plane.normal, point)[0]);
    const vs = entry.points.map(point => brushFaceUv(face, entry.plane.normal, point)[1]);
    assert.ok(span(us) > 1 || span(vs) > 1, `face ${entry.index} is degenerate: u spans ${span(us)}, v spans ${span(vs)}`);
    // A 128-unit side is two repeats at the default scale.
    assert.ok(Math.max(span(us), span(vs)) >= 2 - 1e-9, `face ${entry.index} should span two repeats`);
  }
});

test('the frame is orthonormal and lies in the face plane', () => {
  for (const normal of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], normalize([1, 1, 1])]) {
    const { u, v } = brushUvAxes(normal);
    assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
    assert.ok(Math.abs(dot(u, v)) < 1e-12, 'the axes are perpendicular');
    assert.ok(Math.abs(dot(u, normal)) < 1e-12, 'u lies in the plane');
    assert.ok(Math.abs(dot(v, normal)) < 1e-12, 'v lies in the plane');
  }
});

test('offset, scale and rotation compose the way the inspector says', () => {
  const normal = [0, 0, 1];
  const { u, v } = brushUvAxes(normal);
  const point = [64, 32, 0];
  const plain = brushFaceUv({}, normal, point);
  assert.deepEqual(plain, [dot(point, u) / BRUSH_TEXTURE_SIZE, dot(point, v) / BRUSH_TEXTURE_SIZE]);
  // Scale 2 covers twice the distance with the same artwork, so the coordinates halve.
  assert.deepEqual(brushFaceUv({ scaleX: 2, scaleY: 2 }, normal, point), [plain[0] / 2, plain[1] / 2]);
  // A 64-unit offset is exactly one repeat.
  assert.deepEqual(brushFaceUv({ offsetX: 64 }, normal, point), [plain[0] + 1, plain[1]]);
  // A 90 degree turn swaps the two axes and flips one, which is a rotation, not a mirror.
  const turned = brushFaceUv({ rotation: 90 }, normal, point);
  assert.ok(Math.abs(turned[0] + plain[1]) < 1e-12);
  assert.ok(Math.abs(turned[1] - plain[0]) < 1e-12);
});

test('a negative scale mirrors the texture, as the validator documents', () => {
  const normal = [0, 0, 1];
  const point = [64, 32, 0];
  const plain = brushFaceUv({}, normal, point);
  const mirrored = brushFaceUv({ scaleY: -1 }, normal, point);
  assert.ok(Math.abs(mirrored[1] + plain[1]) < 1e-12, 'Y mirrors and X does not move');
});

test('a face that carries a basis projects from the basis alone', () => {
  const normal = [0, 0, 1];
  const face = { uvBasis: { u: [0, 0.5, 0], v: [-0.25, 0, 0] } };
  const point = [8, 4, 99];
  assert.deepEqual(brushFaceUv(face, normal, point), [2, -2]);
  // A fourth component shifts the axis, in texture repeats.
  const shifted = { uvBasis: { u: [0, 0.5, 0, 3], v: [-0.25, 0, 0] } };
  assert.deepEqual(brushFaceUv(shifted, normal, point), [5, -2]);
});

test('editing an offset or scale replaces the basis, editing only the texture does not', () => {
  const { project, brush } = cube();
  const basis = { u: [0, 1 / 64, 0], v: [-1 / 64, 0, 0] };
  brush.faces[0] = { ...brush.faces[0], uvBasis: basis };
  setBrushFaceMaterial(project, brush.id, 0, { offsetX: 32 });
  assert.equal(brush.faces[0].uvBasis, undefined, 'the typed offset wins');
  assert.equal(brush.faces[0].offsetX, 32);

  brush.faces[1] = { ...brush.faces[1], uvBasis: basis };
  setBrushFaceMaterial(project, brush.id, 1, { texture: null });
  assert.deepEqual(brush.faces[1].uvBasis, basis, 'a retexture keeps the projection');
});

test('a basis survives the operations that move and copy a brush', () => {
  // The projection is fixed in world space, like TrenchBroom's: moving geometry slides the texture
  // over the surface instead of dragging the pattern along with it.
  const { project, brush } = cube();
  const basis = { u: [0, 1 / 64, 0], v: [-1 / 64, 0, 0] };
  brush.faces[2] = { ...brush.faces[2], uvBasis: basis };
  moveBrush(project, brush.id, { x: 0, y: 0, z: 16 });
  assert.deepEqual(brush.faces[2].uvBasis, basis, 'moving keeps the projection');
  const copy = duplicateBrush(project, brush.id);
  assert.deepEqual(copy.faces[2].uvBasis, basis, 'a duplicate keeps the projection');
  const { front } = splitBrush(brush, { normal: [0, 0, 1], distance: 32 });
  assert.ok(front, 'the split produced the upper half');
  assert.ok(front.faces.some(face => face.uvBasis), 'a split keeps it on the faces it reuses');
});
