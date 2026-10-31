import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThreeDFloors, floorHeightAt, threeDFloorFromWall } from '../shared/three-d-floors.js';

// The numbers below are a real Lullaby TITLEMAP line: `Sector_Set3DFloor (2, 1, 0, 255, 0)`
// on a line whose front side is a control sector with floor 32 / flat ALLBLAKF and ceiling
// 48 / flat STAR2, drawn with a CYAGRA2 side. GZDoom's `P_Add3DFloor` makes the control
// floor the *bottom* plane and the control ceiling the *top* plane.
function titleMap() {
  const control = { id: 'sector0', tag: 7, floorHeight: 32, ceilingHeight: 48, floorAsset: 'allblkaf', ceilingAsset: 'star2', light: 192 };
  const island = { id: 'sector1', tag: 2, floorHeight: 0, ceilingHeight: 3072, floorAsset: 'allblkaf', ceilingAsset: 'allblkaf', light: 176 };
  const elsewhere = { id: 'sector2', tag: 0, floorHeight: 0, ceilingHeight: 128, floorAsset: null, ceilingAsset: null, light: 160 };
  const wall = { id: 'w0', a: 'v0', b: 'v1', special: 160, tag: 2, args: [2, 1, 0, 255, 0],
    right: { sectorId: 'sector0', middle: 'cyagra2', upper: 'upper', lower: 'lower' },
    left: null };
  return { sectors: [control, island, elsewhere], walls: [wall] };
}

test('a solid 3D floor is the control sector ceiling above its floor', () => {
  const map = titleMap();
  const applied = applyThreeDFloors(map);
  assert.equal(applied.length, 1, 'the line describes one 3D floor');
  const [floor] = map.sectors[1].threeDFloors;
  assert.equal(floor.bottom, 32, "the control sector's floor is the bottom plane");
  assert.equal(floor.top, 48, "the control sector's ceiling is the top plane");
  assert.equal(floor.bottomFlat, 'allblkaf', 'each plane keeps the control flat it came from');
  assert.equal(floor.topFlat, 'star2');
  assert.equal(floor.side, 'cyagra2', "the line's sidedef middle texture is the edge");
  assert.equal(floor.light, 192, 'the floor is lit by the control sector');
  assert.equal(floor.alpha, 255);
  assert.equal(floor.solid, true, 'type 1 is solid');
  assert.equal(map.sectors[1].threeDFloors.length, 1, 'only the tagged sector receives it');
  assert.equal(map.sectors[2].threeDFloors, undefined, 'an untagged sector is untouched');
  assert.equal(map.walls[0].special, 0, 'GZDoom clears the special once the map is loaded');
});

test('only a solid 3D floor carries weight', () => {
  const map = titleMap();
  applyThreeDFloors(map);
  const island = map.sectors[1];
  assert.equal(floorHeightAt(island, 64), 48, 'an object above the platform rests on it');
  assert.equal(floorHeightAt(island, 10), 0, 'below the platform the sector floor still counts');
  assert.equal(floorHeightAt(island, undefined), 0, 'an object with no height uses the sector floor');

  const water = titleMap();
  water.walls[0].args = [2, 2, 0, 200, 0];
  applyThreeDFloors(water);
  assert.equal(water.sectors[1].threeDFloors[0].solid, false, 'type 2 is swimmable, not solid');
  assert.equal(floorHeightAt(water.sectors[1], 64), 0, 'you fall through a swimmable 3D floor');
});

test('flags pick the edge texture and thin floors collapse to one plane', () => {
  const map = titleMap();
  map.walls[0].args = [2, 1, 16, 255, 0];
  assert.equal(threeDFloorFromWall(map.walls[0], new Map(map.sectors.map(s => [s.id, s]))).side, 'upper',
    'FF_UPPERTEXTURE draws the sidedef upper texture');
  map.walls[0].args = [2, 1, 32, 255, 0];
  assert.equal(threeDFloorFromWall(map.walls[0], new Map(map.sectors.map(s => [s.id, s]))).side, 'lower',
    'FF_LOWERTEXTURE draws the sidedef lower texture');
  map.walls[0].args = [2, 1, 8, 255, 0];
  const thin = threeDFloorFromWall(map.walls[0], new Map(map.sectors.map(s => [s.id, s])));
  assert.equal(thin.bottom, 48, 'FF_THINFLOOR puts the bottom on the control ceiling');
  assert.equal(thin.top, 48, 'and the top there as well');
  assert.equal(thin.topFlat, 'star2');
});

test('a line that cannot describe a 3D floor is left alone', () => {
  const map = titleMap();
  map.walls[0].args = undefined;                       // Doom-format line: no argument bytes
  assert.equal(applyThreeDFloors(map).length, 0);
  assert.equal(map.walls[0].special, 160, 'the special stays visible to the importer');
  map.walls[0].args = [0, 1, 0, 255, 0];               // tag 0 matches nothing in GZDoom either
  assert.equal(applyThreeDFloors(map).length, 0);
  map.walls[0].args = [9, 1, 0, 255, 0];               // a tag no sector carries
  assert.equal(applyThreeDFloors(map).length, 0);
});

// The collision mesh is what makes a 3D floor something you can walk on rather than
// something you can see. Heights reach it in Rapier's scale (a map unit is 1/64).
test('a solid 3D floor reaches the collision mesh at its own height', async () => {
  const THREE = await import('three');
  const { collisionMesh } = await import('../shared/physics.js');
  const triangulate = (outer, holes) => THREE.ShapeUtils.triangulateShape(
    outer.map(point => new THREE.Vector2(point.x, point.y)),
    holes.map(ring => ring.map(point => new THREE.Vector2(point.x, point.y))));
  const square = extra => ({ map: {
    vertices: [{ id: 'v0', x: 0, y: 0 }, { id: 'v1', x: 128, y: 0 }, { id: 'v2', x: 128, y: 128 }, { id: 'v3', x: 0, y: 128 }],
    sectors: [{ id: 'sector0', floorHeight: 0, ceilingHeight: 3072, sky: false, light: 176, ...extra }],
    walls: [['v0', 'v1'], ['v1', 'v2'], ['v2', 'v3'], ['v3', 'v0']].map(([a, b], index) => ({
      id: `w${index}`, a, b, right: { sectorId: 'sector0' }, left: null, solid: true, height: 3072 })),
  } });
  const plain = collisionMesh(square({}), triangulate).positions;
  const raised = collisionMesh(square({
    threeDFloors: [{ top: 48, bottom: 32, solid: true, topFlat: null, bottomFlat: null, side: null, light: 192, alpha: 255 }],
  }), triangulate).positions;
  assert.ok(raised.length > plain.length, 'the platform adds collision surfaces');
  const heights = new Set(Array.from(raised).filter((value, index) => index % 3 === 1).map(value => Math.round(value * 64)));
  assert.ok(heights.has(48), 'the top plane is at 48 map units');
  assert.ok(heights.has(32), 'the bottom plane is at 32 map units');
});
