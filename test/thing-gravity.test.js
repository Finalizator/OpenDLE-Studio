import test from 'node:test';
import assert from 'node:assert/strict';
import { stepThingGravity } from '../shared/actor-runtime.js';
import { TIC_RATE } from '../shared/actor-runtime.js';

// Lullaby's title map rains stars: 33 `Star` things are dropped at elevations up to 3700 and
// each carries `gravity = 0.2` or `0.3` in its UDMF block, which is GZDoom reading the
// `Gravity` actor property off the thing. `AActor::GetGravity` turns that into
// `sv_gravity * sector.gravity * actor.gravity * 0.00125` = 0.2 map units per tic squared.
function titleMap({ gravity = 0.2, elevation = 1600 } = {}) {
  const sector = { id: 'sector66', tag: 0, floorHeight: 0, ceilingHeight: 3712, light: 136, rings: [], bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } };
  const star = { id: 'thing1', name: 'Star', type: 'decoration', doomType: 10003, actorId: 'actor_star',
    actorName: 'Star', x: 50, y: 50, elevation, ...(gravity === 1 ? {} : { gravity }) };
  return {
    project: { actors: [{ id: 'actor_star', name: 'Star', doomedNum: 10003, flags: {}, radius: 48, height: 128 }] },
    state: { sectors: [sector], entities: [star], player: { x: -999, y: -999 } },
    star,
  };
}

/** Doom's numbers are rounded to the tic, and the sum of them drifts in the last bit. */
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not within 1e-6 of ${expected}`);
}

/** Runs `tics` tics at Doom's rate, the way the frame loop does. */
function runTics(project, state, tics) {
  for (let tic = 0; tic < tics; tic++) stepThingGravity(project, state, 1 / TIC_RATE);
}

test('a thing with gravity falls at the rate GZDoom traces', () => {
  // The numbers below are from GZDoom's own per-tic trace of TITLEMAP (`ODT <tic> watch`):
  // tic 1 z=1600.000 vz=-0.200, tic 35 z=1481.000 vz=-7.000, tic 70 z=1117.000 vz=-14.000.
  const { project, state, star } = titleMap();
  runTics(project, state, 1);
  assert.equal(star.z, 1600, 'the first tic moves nothing: Doom adds the old speed, then gravitates');
  close(star.fallSpeed, -0.2);
  runTics(project, state, 34);
  close(star.z, 1481);
  close(star.fallSpeed, -7);
  runTics(project, state, 35);
  close(star.z, 1117);
  close(star.fallSpeed, -14);
});

test('a heavier thing falls further in the same time', () => {
  const light = titleMap({ gravity: 0.2 });
  const heavy = titleMap({ gravity: 0.3 });
  runTics(light.project, light.state, 70);
  runTics(heavy.project, heavy.state, 70);
  assert.ok(heavy.star.z < light.star.z, 'the 0.3 thing is lower after the same 70 tics');
  close(light.star.fallSpeed, -14);
  close(heavy.star.fallSpeed, -21);
});

test('a thing with no gravity of its own falls a unit per tic squared', () => {
  const { project, state, star } = titleMap({ gravity: 1 });
  runTics(project, state, 10);
  close(star.fallSpeed, -10);
  // Sampled mid-fall, so the arithmetic is the sum 1 + 2 + … + 9, not a single step.
  close(star.z, 1600 - 45);
});

test('a star lands on the floor and stays there', () => {
  const { project, state, star } = titleMap({ elevation: 40 });
  for (let tic = 0; tic < 400; tic++) {
    stepThingGravity(project, state, 1 / TIC_RATE);
    assert.ok(star.z >= 0, 'it never sinks through the floor');
  }
  assert.equal(star.z, 0);
  assert.equal(star.fallSpeed, 0);
});

test('NOGRAVITY and FLOAT things hold their place', () => {
  for (const flag of ['NOGRAVITY', 'FLOAT']) {
    const { project, state, star } = titleMap();
    project.actors[0].flags = { [flag]: true };
    runTics(project, state, 70);
    // Untouched: no height of its own is invented, so the renderer keeps using the elevation
    // the map gave it.
    assert.equal(star.z, undefined, `${flag} keeps a thing where the map put it`);
    assert.equal(star.fallSpeed, 0);
  }
});

test('a thing whose actor cannot be resolved is left alone', () => {
  // Without an actor definition there is no way to know whether the thing has gravity, and
  // guessing would drop every prop on a map whose DECORATE could not be read.
  const { project, state, star } = titleMap();
  project.actors = [];
  runTics(project, state, 70);
  assert.equal(star.z, undefined);
});
