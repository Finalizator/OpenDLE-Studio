import test from 'node:test';
import assert from 'node:assert/strict';
import { createPath, createPathPoint, pathLength } from '../shared/paths.js';
import { advancePathMotion, followPath, pathDistance, pathFollowSettings, pathSampler, PATH_MODES } from '../shared/path-motion.js';

const point = (x, y, curve = 1, z = 0) => createPathPoint({ id: `p${x}_${y}_${curve}_${z}`, x, y, z, curve });

/** A square loop 100 units on a side, starting at the origin and running along +x. */
const square = (closed = true) => createPath({
  id: 'route', name: 'Route', closed,
  points: [point(0, 0, 0), point(100, 0, 0), point(100, 100, 0), point(0, 100, 0)],
});

const project = path => ({ paths: [path] });
const follower = (settings) => ({ id: 'model1', type: 'decoration', name: 'Model', x: 0, y: 0, angle: 0, path: settings });

test('a loop wraps, a ping-pong reflects and a one-way trip stops', () => {
  assert.equal(pathDistance(0, 400, 'loop'), 0);
  assert.equal(pathDistance(400, 400, 'loop'), 0, 'a full loop is back at the start');
  assert.equal(pathDistance(450, 400, 'loop'), 50);
  assert.equal(pathDistance(-50, 400, 'loop'), 350, 'negative progress is legal and wraps');
  // Ping-pong covers the route twice before repeating, so it runs back along it.
  assert.equal(pathDistance(400, 400, 'pingpong'), 400);
  assert.equal(pathDistance(450, 400, 'pingpong'), 350);
  assert.equal(pathDistance(800, 400, 'pingpong'), 0);
  // Once never runs past the end, however far it is advanced.
  assert.equal(pathDistance(450, 400, 'once'), 400);
  assert.equal(pathDistance(0, 0, 'loop'), 0, 'a path with no length has no travel');
});

test('settings fill in the defaults and reject nonsense', () => {
  assert.deepEqual(pathFollowSettings({ id: 'route' }),
    { id: 'route', speed: 64, mode: 'loop', faceDirection: true, startAt: 0, yawOffset: 0 });
  assert.equal(pathFollowSettings({ id: 'route', speed: 'fast' }).speed, 64, 'a broken speed falls back');
  assert.equal(pathFollowSettings({ id: 'route', mode: 'spiral' }).mode, 'loop');
  assert.equal(pathFollowSettings({ id: 'route', faceDirection: false }).faceDirection, false);
  assert.equal(pathFollowSettings({ id: 'route', startAt: 2 }).startAt, 1, 'a start offset is clamped');
  assert.equal(pathFollowSettings({ id: 'route', startAt: -1 }).startAt, 0);
  assert.deepEqual(PATH_MODES, ['loop', 'pingpong', 'once']);
});

test('a follower stands on the curve and faces the way it is going', () => {
  const path = square();
  const east = followPath(path, 50);
  assert.ok(Math.abs(east.x - 50) < 1e-6 && Math.abs(east.y) < 1e-6, 'halfway along the first side');
  assert.ok(Math.abs(east.angle) < 1e-6, 'travelling along +x is angle 0');
  // A corner point with no curvature keeps the sides straight, so a quarter of the way round is
  // the second corner and the heading has turned a right angle.
  const corner = followPath(path, 100);
  assert.ok(Math.abs(corner.x - 100) < 1e-6 && Math.abs(corner.y) < 1e-6);
  const north = followPath(path, 150);
  assert.ok(Math.abs(north.x - 100) < 1e-6 && Math.abs(north.y - 50) < 1e-6, 'halfway up the second side');
  assert.ok(Math.abs(north.angle - 90) < 1e-6, 'travelling along +y is angle 90');
  assert.equal(followPath(createPath({ id: 'x', points: [point(0, 0)] }), 10), null, 'one waypoint is not a route');
});

test('height comes with the route', () => {
  const stair = createPath({ id: 'stair', name: 'Stair', points: [point(0, 0, 0, 0), point(100, 0, 0, 64)] });
  // Distance is measured along the curve in three dimensions, so climbing costs travel: this
  // route is longer than its 100-unit footprint, and the end is reached at its own length.
  const length = followPath(stair, 0).length;
  assert.ok(length > 100, `a climbing route is longer than its footprint: ${length}`);
  assert.equal(followPath(stair, 0).z, 0);
  assert.equal(followPath(stair, length, { mode: 'once' }).z, 64, 'the end of a one-way trip');
  assert.ok(Math.abs(followPath(stair, length / 2).z - 32) < 1e-6);
  // Looping, that same distance is the start again — a loop has no end to arrive at.
  assert.equal(followPath(stair, length).z, 0);
});

test('advancing moves the model at its own speed and turns it', () => {
  const path = square();
  const state = { entities: [follower({ id: 'route', speed: 100, mode: 'loop' })], time: 0 };
  advancePathMotion(project(path), state, 0.5);
  const model = state.entities[0];
  assert.ok(Math.abs(model.x - 50) < 1e-6, `100 units/s for half a second: ${model.x}`);
  assert.ok(Math.abs(model.angle) < 1e-6, 'and faces along the route');
  advancePathMotion(project(path), state, 0.5);
  assert.ok(Math.abs(model.x - 100) < 1e-6, 'a second later it is at the corner');
  // The route is 400 long, so four more seconds brings it back to the start.
  advancePathMotion(project(path), state, 3);
  assert.ok(Math.abs(model.x) < 1e-6 && Math.abs(model.y) < 1e-6, `looped back: ${model.x}, ${model.y}`);
});

test('speed zero and a missing route leave the model alone', () => {
  const path = square();
  const still = { entities: [follower({ id: 'route', speed: 0 })], time: 0 };
  still.entities[0].x = 25;
  advancePathMotion(project(path), still, 1);
  assert.equal(still.entities[0].x, 0, 'a follower with no speed still stands on its start point');
  const orphan = { entities: [follower({ id: 'missing', speed: 100 })], time: 0 };
  orphan.entities[0].x = 42;
  assert.equal(advancePathMotion(project(path), orphan, 1), 0);
  assert.equal(orphan.entities[0].x, 42, 'a deleted route does not teleport the model to the origin');
});

test('face direction can be switched off, and the authored angle is kept', () => {
  const path = square();
  const state = { entities: [follower({ id: 'route', speed: 100, faceDirection: false })], time: 0 };
  state.entities[0].angle = 135;
  advancePathMotion(project(path), state, 1);
  assert.equal(state.entities[0].angle, 135, 'the object keeps the angle the mapper set');
  assert.ok(Math.abs(state.entities[0].x - 100) < 1e-6, 'but still travels');
});

test('a start offset spreads followers of one route apart', () => {
  const path = square();
  const state = { entities: [
    follower({ id: 'route', speed: 0 }),
    { ...follower({ id: 'route', speed: 0 }), id: 'model2', x: 0, y: 0, path: { id: 'route', speed: 0, startAt: 0.5 } },
  ], time: 0 };
  advancePathMotion(project(path), state, 0.016);
  assert.ok(Math.abs(state.entities[0].x) < 1e-6 && Math.abs(state.entities[0].y) < 1e-6);
  assert.ok(Math.abs(state.entities[1].x - 100) < 1e-6 && Math.abs(state.entities[1].y - 100) < 1e-6,
    `halfway round a square is the far corner: ${state.entities[1].x}, ${state.entities[1].y}`);
});

test('the player is never carried off by a route', () => {
  const path = square();
  const state = { entities: [{ id: 'player', type: 'player', name: 'Player', x: 5, y: 5, path: { id: 'route', speed: 100 } }], time: 0 };
  assert.equal(advancePathMotion(project(path), state, 1), 0);
  assert.deepEqual([state.entities[0].x, state.entities[0].y], [5, 5]);
});

test('the sampler caches by path, so two followers agree on its length', () => {
  const path = square();
  const forPath = pathSampler();
  const first = forPath(path), second = forPath(square());
  assert.equal(first, second, 'the same route samples once');
  assert.ok(Math.abs(first.lengths.at(-1) - 400) < 1e-6, `square length ${first.lengths.at(-1)}`);
  // Changing a waypoint invalidates it.
  path.points[1].x = 200;
  assert.notEqual(forPath(path), first);
  assert.ok(pathLength(square()) > 400);
});

test('a facing offset turns the model on top of the route direction', () => {
  const path = square();
  const state = { entities: [follower({ id: 'route', speed: 100, yawOffset: 90 })], time: 0 };
  advancePathMotion(project(path), state, 0.5);
  assert.ok(Math.abs(state.entities[0].angle - 90) < 1e-6, `along +x with a 90 degree offset: ${state.entities[0].angle}`);
  assert.equal(pathFollowSettings({ id: 'route', yawOffset: 'sideways' }).yawOffset, 0);
});

test('the runtime carries a model round its route, and the renderer reads it from there', async () => {
  const { createProject, validateProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const { entityOrigin } = await import('../shared/entity-visuals.js');
  const project = createProject();
  project.paths = [square()];
  const model = project.map.entities.find(entity => entity.type !== 'player');
  Object.assign(model, { type: 'decoration', x: 0, y: 0, angle: 0, path: { id: 'route', speed: 100, mode: 'loop' } });
  validateProject(project);

  const state = createRuntime(project);
  const entity = state.entities.find(item => item.id === model.id);
  // The square is 100 units a side, so one second at 100 units/s is exactly one side.
  for (let step = 0; step < 35; step++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(Math.abs(entity.x - 100) < 1, `one second along the first side: ${entity.x}`);
  assert.ok(Math.abs(entity.y) < 1, `still on the first side: ${entity.y}`);
  assert.ok(Math.abs(entity.angle) < 2, `facing along +x: ${entity.angle}`);
  // The renderer places a model from the entity's own position, so the walk is what is drawn.
  assert.deepEqual(entityOrigin(entity, 0), [entity.x, entity.z, entity.y]);
  // Half a second more is halfway up the second side, having turned to face it.
  for (let step = 0; step < 18; step++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(Math.abs(entity.x - 100) < 2, `on the second side: ${entity.x}`);
  assert.ok(entity.y > 30 && entity.y < 70, `climbing it: ${entity.y}`);
  assert.ok(Math.abs(entity.angle - 90) < 8, `turning to face +y: ${entity.angle}`);
});
