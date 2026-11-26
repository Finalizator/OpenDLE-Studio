import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { cloneNodeMaterial } from '../shared/node-material.js';

const renderer = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');

test('a node material clone loses its alpha test, which is why clones go through the helper', () => {
  const material = new SpriteNodeMaterial({ map: null, transparent: false, alphaTest: .5, depthWrite: false });
  // `NodeMaterial.copy` walks the properties it can enumerate, and `alphaTest` is an accessor on
  // `Material.prototype`, so three leaves it behind. If this ever stops being true the helper can
  // go, and this test is the one that says so.
  assert.equal(material.clone().alphaTest, 0, 'three copies only enumerable properties, so alphaTest is dropped');
});

test('the helper keeps the alpha test and the other flags a masked sprite needs', () => {
  for (const alphaTest of [.5, .1, 0]) {
    const material = new SpriteNodeMaterial({ transparent: false, alphaTest, depthWrite: false });
    const copy = cloneNodeMaterial(material);
    assert.equal(copy.alphaTest, alphaTest);
    assert.equal(copy.transparent, material.transparent);
    assert.equal(copy.depthWrite, material.depthWrite);
  }
  // The material a monster's sprite is cloned from is a plain node material, and every transparent
  // pixel of its picture has to be cut away rather than drawn as black.
  const masked = cloneNodeMaterial(new SpriteNodeMaterial({ alphaTest: .5 }));
  assert.ok(masked.alphaTest > 0, 'a cloned sprite material still tests its picture');
});

test('the helper copies a classic material as well as a node one', () => {
  const material = new MeshBasicNodeMaterial({ transparent: true, alphaTest: .25 });
  const copy = cloneNodeMaterial(material);
  assert.equal(copy.alphaTest, .25);
  assert.equal(copy.transparent, true);
  assert.notEqual(copy, material, 'the copy is a material of its own');
});

test('every node material the renderer clones goes through the helper', () => {
  for (const direct of [/template\.clone\(\)/u, /effectTemplates\[kind\]\.clone\(\)/u, /original\.clone\(\)/u]) {
    assert.doesNotMatch(renderer, direct, 'a sprite, model or effect material was cloned without its alpha test');
  }
  assert.equal(renderer.match(/cloneNodeMaterial\(/gu)?.length, 3, 'the three clone sites, and no more');
});
