import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Group, Mesh, MeshBasicMaterial, Points, PointsMaterial, Scene, Sprite, SpriteMaterial, BoxGeometry } from 'three';
import {
  restoreCulling, restoreVisibility, revealForWarmup, uncullDrawables,
} from '../shared/render-warmup.js';

function studio() {
  const scene = new Scene(), overlay = new Scene();
  const group = new Group(), geometry = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  const sprite = new Sprite(new SpriteMaterial());
  const points = new Points(geometry, new PointsMaterial());
  const alwaysVisible = new Mesh(geometry, new MeshBasicMaterial());
  alwaysVisible.frustumCulled = false;
  group.add(mesh, sprite, points, alwaysVisible);
  scene.add(group);
  // Weapon overlays: only the equipped one is visible when the preview starts.
  const weaponA = new Sprite(new SpriteMaterial()), weaponB = new Sprite(new SpriteMaterial());
  weaponB.visible = false;
  overlay.add(weaponA, weaponB);
  return { scene, overlay, mesh, sprite, points, alwaysVisible, weaponA, weaponB };
}

test('the warm-up pass sees drawables that culling or visibility would skip', () => {
  const { scene, overlay, mesh, sprite, points, alwaysVisible, weaponA, weaponB } = studio();
  assert.equal(mesh.frustumCulled, true);
  const cleared = uncullDrawables([scene, overlay]);
  // Every drawable is eligible, including the ones the renderer would drop.
  for (const object of [mesh, sprite, points, weaponA, weaponB]) assert.equal(object.frustumCulled, false);
  assert.ok(!cleared.includes(alwaysVisible), 'objects that were already unculled are not tracked');
  assert.equal(alwaysVisible.frustumCulled, false);
  const hidden = revealForWarmup([...overlay.children]);
  assert.deepEqual(hidden, [weaponB]);
  assert.equal(weaponB.visible, true);
  // Restoring must not turn culling back on for objects that opted out themselves.
  restoreCulling(cleared);
  restoreVisibility(hidden);
  assert.equal(mesh.frustumCulled, true);
  assert.equal(sprite.frustumCulled, true);
  assert.equal(alwaysVisible.frustumCulled, false);
  assert.equal(weaponA.visible, true);
  assert.equal(weaponB.visible, false);
});

test('culling restores only what the warm-up changed, even when it runs twice', () => {
  const { scene, mesh } = studio();
  const first = uncullDrawables([scene]);
  const second = uncullDrawables([scene]);
  assert.deepEqual(second, [], 'a second pass finds nothing left to clear');
  restoreCulling(first);
  assert.equal(mesh.frustumCulled, true);
  assert.deepEqual(revealForWarmup([{ visible: true }, null]), []);
  assert.doesNotThrow(() => uncullDrawables([null, {}]));
});

test('the preview warms every pipeline before the first frame', () => {
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  const warm = source.indexOf('await warmEverything();');
  const firstFrame = source.indexOf('await renderer.compileAsync(scene, camera)');
  assert.ok(warm > 0 && firstFrame > 0);
  assert.ok(source.includes('uncullDrawables([scene, warmupScene, backgroundScene, overlayScene])'),
    'the whole world must be warmed, not just what the spawn camera sees');
  assert.ok(source.includes('restoreCulling(unculled)') && source.includes('restoreVisibility(hidden)'),
    'culling and visibility must return to their original values');
  // The warm-up must finish before the render loop starts handing frames out.
  assert.ok(warm < source.indexOf('function setProject(next)'));
});
