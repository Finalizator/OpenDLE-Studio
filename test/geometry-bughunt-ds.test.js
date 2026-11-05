import test from 'node:test';
import assert from 'node:assert/strict';
import { facesModelDocument, faceNormal, rampFaces } from '../shared/ramp-model.js';

const TILE = 64;

/** Decode the interleaved positions and UVs of one generated wedge model. */
function wedgeMeshUvs(shape) {
  const { json, binary } = facesModelDocument(rampFaces(shape));
  const [positionsView, normalsView, uvView] = json.bufferViews;
  const positions = new Float32Array(binary.buffer, binary.byteOffset, positionsView.byteLength / 4);
  const uvs = new Float32Array(
    binary.buffer, binary.byteOffset + positionsView.byteLength + normalsView.byteLength, uvView.byteLength / 4);
  return { positions, uvs };
}

/** The four corners of the surf face come first, so its four UV pairs open the UV array. */
function surfFaceV(shape) {
  const { uvs } = wedgeMeshUvs(shape);
  return [uvs[1], uvs[3], uvs[5], uvs[7]];
}

test('the wedge surf face is textured along the slope from its low edge, not from the wedge origin', () => {
  // An asymmetric wedge: the slope runs 300 across and 150 up, so its surface is
  // hypot(300, 150) = 335.41 map units long; the face texture must span that, not a
  // radial distance from the entity origin.
  const shape = { width: 300, height: 150, depth: 100, facing: 'right' };
  const alongSlope = Math.hypot(shape.width, shape.height);
  const [lowBackV, ridgeBackV, ridgeFrontV, lowFrontV] = surfFaceV(shape);

  // The low edge is the one a player steps onto: its V is the start of the slope.
  assert.ok(Math.abs(lowBackV) < 1e-9, `low edge V ${lowBackV} should be 0`);
  assert.ok(Math.abs(lowFrontV) < 1e-9, `low edge V ${lowFrontV} should be 0`);
  // The ridge is the far end: exactly one full slope length in tiles.
  assert.ok(Math.abs(ridgeBackV - alongSlope / TILE) < 1e-6,
    `ridge V ${ridgeBackV} should be ${alongSlope / TILE}`);
  assert.ok(Math.abs(ridgeFrontV - alongSlope / TILE) < 1e-6,
    `ridge V ${ridgeFrontV} should be ${alongSlope / TILE}`);
  // The face must not fold: V rises monotonically from the low edge to the ridge.
  assert.ok(ridgeBackV > lowBackV, 'V increases towards the ridge');
});

test('the surf face texture starts at the low edge for a left-facing ramp too', () => {
  const shape = { width: 300, height: 150, depth: 100, facing: 'left' };
  const alongSlope = Math.hypot(shape.width, shape.height);
  const [lowBackV, ridgeBackV] = surfFaceV(shape);
  assert.ok(Math.abs(lowBackV) < 1e-9, `low edge V ${lowBackV} should be 0`);
  assert.ok(Math.abs(ridgeBackV - alongSlope / TILE) < 1e-6,
    `ridge V ${ridgeBackV} should be ${alongSlope / TILE}`);
});

test('the wedge surf face keeps its across-slope U axis and outward normal', () => {
  const shape = { width: 300, height: 150, depth: 100, facing: 'right' };
  const { positions, uvs } = wedgeMeshUvs(shape);
  // U spans the depth (z), centred on the wedge origin, one tile per 64 map units.
  const uBack = uvs[0], uFront = uvs[4];
  assert.ok(Math.abs(uBack - -shape.depth / 2 / TILE) < 1e-6, `back U ${uBack}`);
  assert.ok(Math.abs(uFront - shape.depth / 2 / TILE) < 1e-6, `front U ${uFront}`);
  const face = rampFaces(shape).find(item => item.name === 'surf');
  const normal = faceNormal(face.corners);
  assert.ok(normal[1] > 0, 'the surf face normal points up');
});
