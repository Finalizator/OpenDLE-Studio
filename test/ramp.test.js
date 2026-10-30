import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject, ENTITY_TYPES } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { addRamp, normalizeRamp, rampShape, RAMP_DEFAULTS, WEDGE_INDICES, wedgeCorners } from '../shared/ramp.js';
import { surfRampSurface } from '../shared/engine-script.js';

const surfaceOf = ramp => surfRampSurface(ramp);

test('a ramp is its own entity type, with the numbers a mapper edits', () => {
  assert.ok(ENTITY_TYPES.includes('ramp'), 'ramp is a placeable type');
  const project = createProject();
  const ramp = addRamp(project, { x: 64, y: -32 });
  assert.equal(ramp.type, 'ramp');
  assert.equal(ramp.name, 'Ramp');
  assert.deepEqual(Object.keys(ramp.ramp).sort(), ['facing', 'height', 'length', 'slope', 'width']);
  assert.doesNotThrow(() => validateProject(project));
});

test('editing the four numbers changes the geometry the engine uses', () => {
  const project = createProject();
  const ramp = addRamp(project, { x: 0, y: 0 });

  // The angle decides how steep it is: 50 degrees rises 256·tan50 over 256 of ground.
  normalizeRamp(ramp, { slope: 50 });
  let surface = surfaceOf(ramp);
  assert.ok(Math.abs(surface.highHeight - surface.lowHeight - 256 * Math.tan(50 * Math.PI / 180)) < .5,
    `rises ${(surface.highHeight - surface.lowHeight).toFixed(1)}`);
  // A wedge carries no tilt: its steepness is the number that built it, and a surface that steep
  // is not ground, which is what makes it surfable.
  assert.equal(ramp.physics.shape, 'wedge');
  assert.ok(ramp.ramp.slope > 45.573, 'a 50 degree ramp is not ground');
  assert.equal(ramp.physics.wedge.facing, 'right', 'and it falls towards +x');

  // A walkable ramp at the same length is a different shape, not merely a different number.
  normalizeRamp(ramp, { slope: 30 });
  assert.ok(ramp.ramp.slope < 45.573, 'a 30 degree ramp is ground');
  assert.ok(Math.abs(surfaceOf(ramp).highHeight - 256 * Math.tan(30 * Math.PI / 180)) < .5);

  // Length is the ground it covers, and it keeps the angle.
  normalizeRamp(ramp, { length: 512 });
  assert.equal(ramp.ramp.slope, 30);
  assert.ok(Math.abs(Math.abs(surfaceOf(ramp).lowEdgeX - surfaceOf(ramp).highEdgeX) - 512) < .5, 'covers 512');

  // Height is accepted as an edit too: asking for one keeps the angle and solves for the ground.
  normalizeRamp(ramp, { height: 100 });
  assert.equal(ramp.ramp.slope, 30);
  assert.ok(Math.abs(ramp.ramp.height - 100) < .5, `height ${ramp.ramp.height}`);
  assert.ok(Math.abs(ramp.ramp.length - 100 / Math.tan(30 * Math.PI / 180)) < .5, `covers ${ramp.ramp.length}`);

  // Width is across the slope, and facing flips which way it falls.
  normalizeRamp(ramp, { width: 512, facing: 'left' });
  assert.equal(ramp.physics.depth, 512);
  assert.equal(ramp.physics.wedge.facing, 'left', 'facing left falls the other way');
  assert.ok(surfaceOf(ramp).lowEdgeX < surfaceOf(ramp).highEdgeX, 'and falls towards -x now');
});

test('the collider, the tilt and the height are always derived, never set by hand', () => {
  const project = createProject();
  const ramp = addRamp(project, { slope: 45, length: 200, width: 128 });
  const shape = rampShape({ slope: 45, length: 200, width: 128 });
  assert.equal(ramp.physics.body, 'fixed');
  assert.equal(ramp.physics.shape, 'wedge');
  assert.ok(Math.abs(ramp.physics.width - shape.run) < .01, 'the hull is as wide as the ground it covers');
  assert.ok(Math.abs(ramp.physics.height - shape.rise) < .01, 'and as tall as it rises');
  assert.equal(ramp.physics.depth, 128);
  assert.deepEqual(ramp.modelTilt, { pitch: 0, roll: 0 }, 'nothing is tilted: the shape is the wedge');
  assert.equal(ramp.elevation, 0, 'its base is the floor');
  // The surface still meets the floor at its low edge, so there is no lip to climb.
  assert.ok(Math.abs(surfaceOf(ramp).lowHeight) < .5, `low edge at ${surfaceOf(ramp).lowHeight}`);
});

test('a ramp the map could not use is rejected, and the defaults are valid', () => {
  assert.equal(RAMP_DEFAULTS.slope, 50);
  for (const bad of [{ slope: 0 }, { slope: 90 }, { length: 0 }, { width: -1 }, { facing: 'up' }]) {
    const project = createProject();
    const ramp = addRamp(project, { x: 0, y: 0 });
    Object.assign(ramp.ramp, bad);
    assert.throws(() => validateProject(project), `rejects ${JSON.stringify(bad)}`);
  }
  // A ramp with no parameters — an object switched to the type by hand — is only rejected when
  // its parameters are present and wrong; with none it is simply a solid box.
  const project = createProject();
  project.map.entities.push({ id: 'bare', name: 'Bare', type: 'ramp', x: 0, y: 0, angle: 0 });
  assert.doesNotThrow(() => validateProject(project));
});

test('the drawn wedge and the collided wedge are the same six corners', () => {
  // The player must never be stopped by a shape that is not the one on screen, so the corners
  // come from one place and everything that draws or collides a ramp reads them.
  for (const facing of ['right', 'left']) {
    const project = createProject();
    const ramp = addRamp(project, { x: 100, y: 0, facing, slope: 50, length: 256, width: 240 });
    const corners = wedgeCorners({ ...ramp.physics, facing: ramp.physics.wedge.facing });
    assert.equal(corners.length, 6);
    // A prism: two triangles, each with an edge on the floor and an apex at the ridge.
    for (const depthSign of [-1, 1]) {
      const side = corners.filter(corner => Math.sign(corner[2]) === depthSign);
      assert.equal(side.length, 3);
      const onFloor = side.filter(corner => corner[1] === 0);
      assert.equal(onFloor.length, 2, 'two corners of each triangle are on the floor');
      const ridge = side.find(corner => corner[1] !== 0);
      assert.ok(Math.abs(ridge[1] - ramp.physics.height) < 1e-9, 'the apex is the full rise');
      // The ridge is above the high edge, and the low edge is the one on the falling side.
      const surface = surfaceOf(ramp);
      const ridgeX = ridge[0] + ramp.x, floorXs = onFloor.map(corner => corner[0] + ramp.x).sort((a, b) => a - b);
      assert.ok(Math.abs(ridgeX - surface.highEdgeX) < 1e-6, `ridge ${ridgeX} over high edge ${surface.highEdgeX}`);
      assert.ok(Math.abs(floorXs[0] - Math.min(surface.lowEdgeX, surface.highEdgeX)) < 1e-6);
      assert.ok(Math.abs(floorXs[1] - Math.max(surface.lowEdgeX, surface.highEdgeX)) < 1e-6);
    }
    // And the base is centred on the ramp, so the wedge stands where the entity is: the extremes
    // of each horizontal axis are equal and opposite, and the depth is split evenly.
    for (const axis of [0, 2]) {
      const values = corners.map(corner => corner[axis]);
      assert.ok(Math.abs(Math.min(...values) + Math.max(...values)) < 1e-9, `axis ${axis} is centred`);
    }
  }
});

test('one winding for the wedge, so no consumer has to invent its own', () => {
  assert.equal(WEDGE_INDICES.length, 18);
  assert.equal(new Set(WEDGE_INDICES).size, 6, 'every corner is used');
  const corners = wedgeCorners({ width: 100, height: 50, depth: 80, facing: 'right' });
  // The first triangle is the surf face at -depth, and it must be a real triangle, not a sliver.
  for (let index = 0; index < WEDGE_INDICES.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map(offset => corners[WEDGE_INDICES[index + offset]]);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    assert.ok(area > 1, `triangle ${index / 3} has area ${area.toFixed(1)}`);
  }
});

/** The height the Rapier collider answers a downward ray at, in map units. */
function colliderHeightAt(state, x, y, above) {
  const ray = new R.Ray({ x: x / 64, y: (above + 96) / 64, z: y / 64 }, { x: 0, y: -1, z: 0 });
  const hit = state.physics.world.castRay(ray, 600 / 64, true);
  return hit ? above + 96 - hit.timeOfImpact * 64 : null;
}

test('the collider answers a downward ray at exactly the height the ramp claims', async () => {
  // The complaint that started this was a ramp whose collision began tens of units before the
  // ramp the player could see, because a tilted box reaches past its own face. A wedge does not,
  // and this is the check that says so: the surface the movement code believes in, the surface
  // the renderer draws, and the surface Rapier stops the player on are one surface.
  await R.init();
  const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
    holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
  for (const facing of ['right', 'left']) {
    const project = createProject();
    const ramp = addRamp(project, { x: 0, y: 0, facing, slope: 50, length: 256, width: 240 });
    // A ray from above has to reach the ramp, not stop at the room's ceiling.
    project.map.sectors[0].ceilingHeight = 512;
    validateProject(project);
    const state = createRuntime(project, { screen: 'playing', gameMode: true });
    state.physics = createPhysics(project, state, R, triangulate);
    const surface = surfaceOf(ramp);
    const low = Math.min(surface.lowEdgeX, surface.highEdgeX), high = Math.max(surface.lowEdgeX, surface.highEdgeX);
    for (const fraction of [.1, .3, .5, .7, .9]) {
      const x = low + (high - low) * fraction;
      const measured = colliderHeightAt(state, x, 0, surface.highHeight);
      const claimed = surface.heightAt(x);
      assert.ok(Math.abs(measured - claimed) < .5,
        `${facing}: collider at x ${x.toFixed(1)} answers ${measured?.toFixed(2)} where the surface is ${claimed.toFixed(2)}`);
    }
    // Nothing sticks out below the floor. A tilted box's buried lower corner did, and the
    // character controller found it: the player was lifted into the air before reaching the ramp.
    // Looking up from under the floor finds the floor and nothing else.
    for (const fraction of [.1, .3, .5, .7, .9]) {
      const x = low + (high - low) * fraction;
      const ray = new R.Ray({ x: x / 64, y: -100 / 64, z: 0 }, { x: 0, y: 1, z: 0 });
      const hit = state.physics.world.castRay(ray, 400 / 64, true);
      const height = hit ? -100 + hit.timeOfImpact * 64 : Infinity;
      assert.ok(height > -.5, `${facing}: nothing below the floor at x ${x.toFixed(1)}, found ${height.toFixed(2)}`);
    }
    state.physics.dispose();
  }
});
