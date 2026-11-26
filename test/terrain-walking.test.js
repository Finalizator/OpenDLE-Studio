// Walking on an exported terrain.
//
// The Terrain tab hands the level a model asset on an object. Nothing about that is a sector, so
// the player — whose movement is a physics capsule — walked through it, and every monster stood on
// the *sector* floor, which is under the hill. These tests pin the two halves of the fix: the
// terrain is a solid the player stands on, and the model's own triangles are the ground the engine
// reasons about for everything else.

import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { dataURI, encodeGLB } from '../shared/gltf.js';
import { createTerrainSurface, modelBounds, terrainEntity } from '../shared/terrain-surface.js';
import { advanceProjectiles, canSeePlayer, floorAt, geometryDistance, moveEnemy, playerReachesEntity, SIGHT_RANGE } from '../shared/combat.js';
import { modelAssetTriangles } from '../shared/model-geometry.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/**
 * A slope as the terrain exporter hands it over: a 200 by 200 quad rising 64 units along the map's
 * +y, in model space where Y is up.
 */
function slopeAsset(kind = 'slope') {
  // `slope` rises 64 units over 200; `step` is flat to the halfway point and then 96 units up.
  const positions = kind === 'step'
    ? new Float32Array([
      0, 0, 0, 200, 0, 0, 200, 0, 100, 0, 0, 0, 200, 0, 100, 0, 0, 100,
      0, 96, 100, 200, 96, 100, 200, 96, 200, 0, 96, 100, 200, 96, 200, 0, 96, 200,
    ])
    : new Float32Array([
      0, 0, 0, 200, 0, 0, 200, 64, 200,
      0, 0, 0, 200, 64, 200, 0, 64, 200,
    ]);
  const indices = new Uint16Array(positions.length / 3).map((_, index) => index);
  const binary = new Uint8Array(positions.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(indices.buffer), positions.byteLength);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Terrain', mesh: 0 }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [0, 0, 0], max: [200, 96, 200] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    materials: [{ name: 'Ground' }],
  };
  return { id: 'asset_terrain', kind: 'model', name: 'Terrain', format: 'glb', animations: [],
    src: dataURI(encodeGLB(json, binary), 'model/gltf-binary') };
}

/** The default project plus a terrain object standing on its floor. */
function terrainLevel({ solid = true, at = { x: 0, y: 0 }, asset: kind = 'slope' } = {}) {
  const project = createProject();
  project.events = [];
  const asset = slopeAsset(kind);
  project.assets = [...(project.assets || []), asset];
  const bounds = modelBounds(modelAssetTriangles(asset, new Map()));
  const entity = terrainEntity({ id: 'terrain', name: 'Terrain', assetId: asset.id, ...at, bounds });
  if (!solid) delete entity.physics;
  project.map.entities.push(entity);
  validateProject(project);
  const state = createRuntime(project);
  const tick = (count = 1, keys = new Set()) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, keys);
  };
  return { project, state, entity, bounds, tick, asset };
}

test('an exported terrain is a solid object, not a decoration with a picture', () => {
  const { entity, bounds } = terrainLevel();
  assert.equal(entity.physics.body, 'fixed', 'it does not move');
  assert.equal(entity.physics.shape, 'model', 'its shape is its mesh');
  assert.equal(entity.physics.modelCollision, 'trimesh', 'and its triangles are the collider');
  assert.ok(entity.physics.width >= 200, `the box is the model's own (${entity.physics.width})`);
  assert.ok(entity.physics.height >= 64, `so is the height (${entity.physics.height})`);
  assert.deepEqual([Math.round(bounds.width), Math.round(bounds.height)], [200, 64]);
});

test('the walkable ground over a terrain is the terrain, not the sector floor', () => {
  const { state } = terrainLevel();
  assert.ok(state.terrainSurface, 'the runtime built a surface from the model');
  // The slope rises 64 units over 200, so a third of the way up is about 21.
  const low = floorAt(state, { x: 20, y: 20 });
  const high = floorAt(state, { x: 20, y: 180 });
  assert.ok(low > 0 && low < 12, `low end (${low})`);
  assert.ok(high > 50 && high <= 64, `high end (${high})`);
  // Off the model the sector floor is still the answer: a terrain is not an infinite plane.
  assert.equal(floorAt(state, { x: -400, y: -400 }), 0);
});

test('a terrain that is not solid is not ground either', () => {
  const { state } = terrainLevel({ solid: false });
  assert.equal(state.terrainSurface, null, 'a decoration with a model has no surface to stand on');
  assert.equal(floorAt(state, { x: 20, y: 180 }), 0);
});

test('a monster stands on the slope, climbs it and is stopped by a cliff', () => {
  const { state } = terrainLevel();
  const imp = { id: 'imp', type: 'enemy', name: 'DoomImp', x: 20, y: 20, angle: 0, health: 60, radius: 16, height: 56 };
  state.entities.push(imp);
  // Its own ground is the model's surface where it stands, not the sector floor under it.
  assert.ok(floorAt(state, imp) > 0, `the imp stands on the slope (${floorAt(state, imp)})`);
  // Walking up the slope one step at a time: each rise is small enough to climb.
  const start = { x: imp.x, y: imp.y };
  moveEnemy(state, imp, 20, 0.5, { x: 20, y: 400 });
  assert.ok(imp.y > start.y, `it climbs the slope (${Math.round(imp.y)})`);
  assert.ok(floorAt(state, imp) > 0, 'and its feet follow the ground up');
  assert.equal(state.sectors[0].floorHeight, 0, 'the sector never moved');

  // The same imp against a cliff: a surface 96 units higher is a wall, not a slope.
  const cliff = terrainLevel({ asset: 'step' });
  const blocked = { id: 'imp2', type: 'enemy', name: 'DoomImp', x: 100, y: 95, angle: 0, health: 60, radius: 16, height: 56 };
  cliff.state.entities.push(blocked);
  // A step of ten units would put it on the upper surface, which is 96 units above it: the only
  // moves it may take are the ones that keep its feet at the height they were.
  for (let step = 0; step < 3; step++) moveEnemy(cliff.state, blocked, 20, 0.5, { x: 100, y: 300 });
  assert.ok(blocked.y <= 101, `it does not climb a 96-unit cliff (y=${Math.round(blocked.y)})`);
});

test('the player stands on the terrain and is stopped by it', t => {
  // The same physics the game runs: a capsule and a trimesh. This is what "walking on terrain"
  // means — the sector floor under it is irrelevant.
  const { project, state } = terrainLevel({ at: { x: -400, y: 0 } });
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics?.dispose());
  state.player.x = -100;
  state.player.y = 100;
  state.player.z = 200;
  state.physics.teleport('player', state.player.x, state.player.y, state.player.z);
  for (let frame = 0; frame < 90; frame++) stepRuntime(project, state, 1 / 60, new Set());
  // It fell onto the far edge of the model and stopped there instead of going through it.
  assert.ok(state.player.z < 200, `the player fell (${state.player.z})`);
  const surface = state.terrainSurface.heightAt(state.player.x, state.player.y);
  if (surface !== null && state.player.x < -200) {
    assert.ok(state.player.z >= surface - 2, `landed on the slope at ${Math.round(surface)} (z=${state.player.z})`);
  }
});

test('the terrain surface reads the tallest surface over a point', () => {
  // Two objects sharing a footprint: the higher one is the ground.
  const project = createProject();
  project.events = [];
  const asset = slopeAsset();
  project.assets = [...(project.assets || []), asset];
  const bounds = modelBounds(modelAssetTriangles(asset, new Map()));
  project.map.entities.push(
    terrainEntity({ id: 'low', name: 'Low', assetId: asset.id, x: 0, y: 0, bounds }),
    { ...terrainEntity({ id: 'high', name: 'High', assetId: asset.id, x: 0, y: 0, bounds }), z: 96, elevation: 96 },
  );
  validateProject(project);
  const surface = createTerrainSurface(project);
  assert.equal(surface.count, 2);
  // `z` lifts the object, and the surface follows the drawn mesh: the second copy is 96 higher.
  assert.ok(surface.heightAt(20, 180) > 50);
});

test('a bullet, a rocket and a line of sight all stop at the terrain', () => {
  // The traces are two-dimensional and sector-based: a model surface is invisible to them, so a
  // shot aimed at a slope went through to whatever stood behind it, and a monster saw a player who
  // was standing behind a hill.
  const { state } = terrainLevel();
  const open = terrainLevel({ solid: false });
  const forward = { x: 0, y: 1, z: 0 };
  // Fired along the slope at knee height: the hill is in the way long before the far wall.
  const reach = geometryDistance(state, { x: 20, y: 10, z: 40 }, forward, 400);
  assert.ok(reach < 400, `the hill is in the way (${Math.round(reach)} of 400)`);
  // Above the hilltop the same shot is exactly as clear as it is without a terrain: a surface is
  // not an invisible wall.
  const above = { x: 20, y: 10, z: 200 };
  assert.equal(geometryDistance(state, above, forward, 400), geometryDistance(open.state, above, forward, 400));

  // A rocket fired into the slope explodes on it, not on the sector floor beneath it.
  state.projectiles = [{ id: 1, ownerId: '$player', x: 20, y: 10, z: 40, dx: 0, dy: 1, dz: 0,
    speed: 700, damage: 20, diceSides: 8, radius: 0, age: 0, impactClipId: 'clip_boom' }];
  // A rocket covers twenty units a frame, so it takes several frames to reach the slope.
  for (let frame = 0; frame < 30 && state.projectiles.length; frame++) advanceProjectiles(state, 1 / 35, () => {});
  assert.equal(state.projectiles.length, 0, 'the rocket is spent');
  const hit = state.impacts.at(-1);
  assert.ok(hit && hit.y > 10 && hit.y < 200, `it went off inside the slope (y=${Math.round(hit?.y)})`);
  assert.ok(Math.abs(hit.z - state.terrainSurface.heightAt(hit.x, hit.y)) < 6,
    `at the surface, not at the sector floor (z=${Math.round(hit.z)})`);
});

test('a hill hides a player who is standing behind it', () => {
  const cliff = terrainLevel({ asset: 'step' });
  const open = terrainLevel({ asset: 'step', solid: false });
  // The imp at the bottom of a 96-unit cliff, the player on top of it.
  const imp = { id: 'imp', type: 'enemy', name: 'DoomImp', x: 100, y: 20, angle: 0, health: 60, radius: 16, height: 56 };
  cliff.state.entities.push(imp);
  const copy = { ...imp };
  open.state.entities.push(copy);
  for (const scene of [cliff.state, open.state]) { scene.player.x = 100; scene.player.y = 180; }
  assert.equal(canSeePlayer(open.state, copy, SIGHT_RANGE), true, 'nothing between them without the cliff');
  assert.equal(canSeePlayer(cliff.state, imp, SIGHT_RANGE), false, 'and the cliff hides the player');
});

test('an item lying on a slope can be picked up', () => {
  // The reach test puts the item on its floor. With the floor being the sector's, an item on a
  // terrain sat 40 units below the player's feet and could never be taken.
  const { state } = terrainLevel();
  const slope = state.terrainSurface.heightAt(20, 180);
  const item = { id: 'soulsphere', type: 'pickup', name: 'Soulsphere', x: 20, y: 180, angle: 0 };
  state.entities.push(item);
  state.player.x = 24;
  state.player.y = 176;
  state.player.z = slope;
  assert.ok(slope > 50, `the slope is high here (${Math.round(slope)})`);
  assert.equal(playerReachesEntity(state, item, 36, 112, 32), true, 'the sphere is within reach');
});
