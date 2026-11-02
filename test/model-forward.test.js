import test from 'node:test';
import assert from 'node:assert/strict';
import { modelBounds, modelForwardAngle, measureAssetForward } from '../shared/model-forward.js';
import { dataURI, encodeGLB } from '../shared/gltf.js';

/**
 * A one-mesh glTF document whose single box is `size` units, so the measurements are the only
 * thing the test has to reason about.
 */
function box(size, { translation = [0, 0, 0], rotation = null } = {}) {
  const half = size.map(value => value / 2);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation, ...(rotation ? { rotation } : {}) }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 8, min: half.map(v => -v), max: half }],
  };
}

test('a model is measured along its own geometry, not from how it was posed', () => {
  // Longer along Z than across X: the body runs north-south, which is a facing of 90.
  assert.equal(modelForwardAngle(box([1, 1, 3])), 90);
  // Longer along X: the body already runs east-west, which is a facing of 0.
  assert.equal(modelForwardAngle(box([3, 1, 1])), 0);
  // A square footprint has no front, so there is nothing honest to report.
  assert.equal(modelForwardAngle(box([2, 1, 2])), null);
  assert.equal(modelForwardAngle(box([2, 1, 2.05])), null, 'a near-square footprint is still ambiguous');
  assert.equal(modelForwardAngle({}), null, 'a document with no geometry has no answer');
});

test('the measurement follows the node transforms, the way a renderer places the geometry', () => {
  // The same long-on-X body, turned a quarter turn about Y, is long on Z in world space.
  const turned = box([3, 1, 1], { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
  assert.equal(modelForwardAngle(turned), 90, 'a rotated node is measured where it ends up');
  const bounds = modelBounds(turned);
  assert.ok(Math.abs(bounds.size[2] - 3) < 1e-9, `the long side is Z after the turn, got ${bounds.size}`);
  assert.ok(Math.abs(bounds.size[0] - 1) < 1e-9);
  // A scaled node counts too.
  assert.equal(modelForwardAngle(box([1, 1, 2], { translation: [4, 0, 0] })), 90);
});

// The trap a renderer's matrix stack exists to avoid: a node's own transform is T·R·S, so its
// translation is *not* turned by its own rotation. Composing R·[S|t] instead moves every placed
// part of the model, and the longest side can then come out on the wrong axis — reporting a body
// that runs east-west as 90° and leaving the truck skewed again.
test('a node that is both placed and turned keeps its place', () => {
  const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const one = box([1, 1, 1], { translation: [10, 0, 0], rotation: quarter });
  const bounds = modelBounds(one);
  assert.ok(Math.abs(bounds.min[0] - 9.5) < 1e-9 && Math.abs(bounds.max[0] - 10.5) < 1e-9,
    `the part sits ten units east, got x ${bounds.min[0]}…${bounds.max[0]}`);
  assert.ok(Math.abs(bounds.min[2] + .5) < 1e-9, 'and nowhere else');
  // Two turned parts placed either side of the origin: the body is seven long on X, so its own
  // forward is 0 — not 90, which is what turning the translations would have claimed.
  const both = {
    ...one,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, translation: [3, 0, 0], rotation: quarter }, { mesh: 0, translation: [-3, 0, 0], rotation: quarter }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  assert.deepEqual(modelBounds(both).size.map(value => Math.round(value)), [7, 1, 1]);
  assert.equal(modelForwardAngle(both), 0);
});

test('the measurement is taken from the asset itself, so an unpreviewed model still measures', () => {
  const glb = encodeGLB(box([1, 1, 3]), null);
  const asset = { id: 'm', kind: 'model', name: 'truck.glb', src: dataURI(glb, 'model/gltf-binary') };
  assert.equal(measureAssetForward(asset), 90);
  const gltf = JSON.stringify(box([3, 1, 1]));
  const bytes = Uint8Array.from(gltf, character => character.charCodeAt(0));
  assert.equal(measureAssetForward({ id: 'g', kind: 'model', name: 'crate.gltf', src: dataURI(bytes, 'model/gltf+json') }), 0);
  // Anything that is not a model, or whose bytes are missing or broken, measures nothing at all —
  // the editor must not fail to open an inspector because a model is odd.
  assert.equal(measureAssetForward({ id: 't', kind: 'texture', src: 'data:image/png;base64,AAAA' }), null);
  assert.equal(measureAssetForward({ id: 'z', kind: 'model', src: 'blob:not-a-data-url' }), null);
  assert.equal(measureAssetForward({ id: 'b', kind: 'model', name: 'broken.gltf', src: 'data:model/gltf+json;base64,bm90IGpzb24=' }), null);
  assert.equal(measureAssetForward(null), null);
  // Measuring is cached on the asset object, because the inspector renders on every edit and a
  // model's document is megabytes: the same object answers from the cache, a replaced one is
  // measured again (an asset edit replaces the entry rather than writing through it).
  const cached = { id: 'c', kind: 'model', name: 'truck.glb', src: dataURI(glb, 'model/gltf-binary') };
  assert.equal(measureAssetForward(cached), 90);
  const first = cached.src;
  cached.src = dataURI(encodeGLB(box([3, 1, 1]), null), 'model/gltf-binary');
  assert.equal(measureAssetForward(cached), 0, 'and even a write-through edit is measured again');
  assert.equal(measureAssetForward({ ...cached, src: dataURI(encodeGLB(box([3, 1, 1]), null), 'model/gltf-binary') }), 0,
    'a replaced asset is measured from its new bytes');
  assert.notEqual(first, cached.src);
});
