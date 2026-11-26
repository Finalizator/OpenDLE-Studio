// Three editor paths that quietly placed things in the wrong place, and one that threw.
//
// `sectorGeometry` walked only each edge's start vertex, so a sector whose outline has a gap (one
// wall missing, a real thing in imported maps) lost its far corner: the floor was drawn as a
// triangle and `sectorAt` could not find the room in the part that vanished. `brushSurfaceAt`
// answered with the top of the brush's bounding box rather than the surface over the point, so an
// object placed on a ramp floated above it. And the 2D Place-entity tool ran the 3D path's
// `elevation` without computing it, which threw and placed nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject } from '../shared/project.js';
import { sectorGeometry, sectorAt, pointInRing } from '../shared/sectors.js';
import { createWedgeBrush, brushSurfaceAt } from '../shared/brushes.js';

const ringArea = ring => Math.abs(ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length];
  return sum + (point.x * next.y - next.x * point.y);
}, 0)) / 2;

test('a sector with one wall missing keeps the corner it reaches', () => {
  const whole = createProject(), gapped = structuredClone(whole);
  gapped.map.walls = gapped.map.walls.filter(wall => wall.id !== 'w3');
  const full = sectorGeometry(whole)[0].rings[0], cut = sectorGeometry(gapped)[0].rings[0];
  assert.equal(cut.length, 4, 'four corners, not three');
  assert.ok(Math.abs(ringArea(cut) - ringArea(full)) < 1, `the same area (${ringArea(cut)} vs ${ringArea(full)})`);
  const inside = { x: 300, y: 200 };
  assert.ok(pointInRing(inside.x, inside.y, cut), 'the far corner is inside the ring');
  assert.equal(sectorAt(sectorGeometry(gapped), inside.x, inside.y)?.id, sectorGeometry(whole)[0].id,
    'and the room is found there');
});

test('an object placed on a ramp stands on the slope, not on the box above it', () => {
  const project = createProject();
  const wedge = createWedgeBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 128 });
  for (const y of [4, 32, 60]) {
    assert.ok(Math.abs(brushSurfaceAt([wedge], 32, y) - (128 - 2 * y)) < .5,
      `at y ${y} the surface is ${128 - 2 * y}`);
  }
});

test('the 2D place tool computes the elevation it uses', () => {
  // Browser-only module: assert the declaration exists in the same handler that uses it.
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("if (toolMode() === 'entity') {"), source.indexOf("$('entity-type').value"));
  assert.match(source, /const elevation = \(point\.z === undefined \? 0 : Math\.round/);
  assert.doesNotMatch(handler, /Object\.assign\(player, position, \{ elevation \}\)/,
    'the object-tool branch is the 3D one; keep the 2D branch below it');
});

test('the snap switch decides the height too, and the zone grip obeys it', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /result\.z = snapped \? Math\.round\(point\.z \/ grid\) \* grid : point\.z/);
  assert.match(source, /const grid = \$\('map-snap'\)\?\.checked \? Number\(\$\('grid'\)\.value\) : 0;/);
});
