import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, ENTITY_TYPES } from '../shared/project.js';
import { addRamp, normalizeRamp, rampShape, RAMP_DEFAULTS } from '../shared/ramp.js';
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
