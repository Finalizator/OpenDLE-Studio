import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPath, createPathPoint, segmentCount, samplePath, segmentPoint, pathLength, pointAlong,
  sampleLengths, pathBounds, PATH_STEPS, MAX_PATHS, MAX_PATH_POINTS,
} from '../shared/paths.js';
import { createProject, validateProject } from '../shared/project.js';

const point = (x, y, curve = 1, z = 0) => createPathPoint({ id: `p${x}_${y}`, x, y, z, curve });

/** Distance from a point to the straight line through `a` and `b`, in map units. */
function offLine(sample, a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.abs((b.x - a.x) * (a.y - sample.y) - (a.x - sample.x) * (b.y - a.y)) / length;
}

/** How far the drawn curve strays from the straight lines between its waypoints. */
function bend(path) {
  const points = path.points, samples = samplePath(path, { steps: 16 });
  return Math.max(...samples.map(sample => Math.min(...points.slice(1)
    .map((to, index) => offLine(sample, points[index], to)))));
}

test('two points make a straight line whatever their curvature says', () => {
  const path = createPath({ points: [point(0, 0), point(100, 0)] });
  assert.equal(segmentCount(path), 1);
  const samples = samplePath(path, { steps: 8 });
  assert.equal(samples.length, 9);
  assert.deepEqual(samples[0], { x: 0, y: 0, z: 0 });
  assert.deepEqual(samples.at(-1), { x: 100, y: 0, z: 0 });
  for (const sample of samples) assert.ok(Math.abs(sample.y) < 1e-9, `stayed on the line: ${sample.y}`);
  // And the tangent rule gives the same answer for both curvature settings.
  for (const curve of [0, 0.5, 1]) {
    const straight = createPath({ points: [point(0, 0, curve), point(100, 0, curve)] });
    for (const sample of samplePath(straight, { steps: 4 })) assert.ok(Math.abs(sample.y) < 1e-9);
  }
});

test('a corner point passes through itself and leaves both segments straight', () => {
  const path = createPath({ points: [point(0, 0, 0), point(100, 100, 0), point(200, 0, 0)] });
  const corner = segmentPoint(path.points, 0, 1);
  assert.ok(Math.abs(corner.x - 100) < 1e-9 && Math.abs(corner.y - 100) < 1e-9, 'segment ends on the point');
  // Nothing on either segment strays off its own straight line.
  for (const [segment, a, b] of [[0, path.points[0], path.points[1]], [1, path.points[1], path.points[2]]]) {
    for (let step = 1; step < 8; step++) {
      assert.ok(offLine(segmentPoint(path.points, segment, step / 8), a, b) < 1e-9, 'straight segment');
    }
  }
});

test('a smooth point sweeps wide of the corner it would otherwise make', () => {
  const smooth = createPath({ points: [point(0, 0), point(100, 100), point(200, 0)] });
  const corner = createPath({ points: [point(0, 0, 0), point(100, 100, 0), point(200, 0, 0)] });
  // Halfway along the first segment the smooth version has risen above the straight chord.
  const chord = { x: 50, y: 50 };
  const smoothMid = segmentPoint(smooth.points, 0, 0.5);
  const cornerMid = segmentPoint(corner.points, 0, 0.5);
  assert.ok(Math.abs(cornerMid.x - chord.x) < 1e-9 && Math.abs(cornerMid.y - chord.y) < 1e-9);
  assert.ok(Math.hypot(smoothMid.x - chord.x, smoothMid.y - chord.y) > 5,
    `the smooth curve leaves the chord: ${JSON.stringify(smoothMid)}`);
});

test('curvature is per waypoint: the bend is only as strong as the point that allows it', () => {
  // An L: the only interesting waypoint is the corner in the middle.
  const smooth = createPath({ points: [point(0, 0, 1), point(100, 0, 1), point(100, 100, 1)] });
  const halfway = createPath({ points: [point(0, 0, 1), point(100, 0, 0.5), point(100, 100, 1)] });
  const corner = createPath({ points: [point(0, 0, 1), point(100, 0, 0), point(100, 100, 1)] });
  assert.ok(bend(smooth) > bend(halfway), `less curvature bends less: ${bend(smooth)} vs ${bend(halfway)}`);
  assert.ok(bend(halfway) > bend(corner), `a corner bends least: ${bend(halfway)} vs ${bend(corner)}`);
  assert.ok(bend(corner) < 1e-9, 'a corner point lies exactly on the straight lines');
  // The same corner, smoothed, rounds off on the inside of the turn.
  assert.ok(bend(smooth) > 5);
});

test('the curve passes exactly through every waypoint', () => {
  const path = createPath({ points: [point(0, 0), point(64, 96), point(160, 32), point(220, 140)] });
  const samples = samplePath(path, { steps: 10 });
  for (const waypoint of path.points) {
    assert.ok(samples.some(sample => Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y) < 1e-9),
      `sample sits on waypoint ${waypoint.x},${waypoint.y}`);
  }
});

test('height is curved as well as the ground position', () => {
  // Rising ground, flat ground, higher ground: a straight run in x and y whose height still
  // has to be smooth, which per-axis Hermite gives and a straight lerp would not.
  const path = createPath({ points: [point(0, 0, 1, 0), point(100, 0, 1, 64), point(200, 0, 1, 128)] });
  const samples = samplePath(path, { steps: 8 });
  assert.equal(samples[0].z, 0);
  assert.equal(samples.at(-1).z, 128);
  for (let index = 1; index < samples.length; index++) assert.ok(samples[index].z >= samples[index - 1].z - 1e-9, 'height never dips');
  assert.equal(segmentPoint(path.points, 0, 1).z, 64, 'the waypoint height is reached exactly');
  assert.ok(Math.abs(segmentPoint(path.points, 0, 0.25).z - 16) > .5, 'and the quarter point is not the straight lerp');
  // Mid-segment the height bulges above the straight chord (96), which is what "curved"
  // has to mean for the vertical axis too.
  assert.ok(segmentPoint(path.points, 1, 0.5).z > 96, 'the rise is curved, not a straight lerp');
});

test('a closed path comes back to its first point and has a segment per point', () => {
  const loop = createPath({ closed: true, points: [point(0, 0), point(100, 0), point(100, 100), point(0, 100)] });
  assert.equal(segmentCount(loop), 4);
  const samples = samplePath(loop, { steps: 6 });
  assert.equal(samples.length, 4 * 6 + 1);
  assert.deepEqual(samples.at(-1), { x: 0, y: 0, z: 0 });
  assert.equal(segmentCount(createPath({ points: [point(0, 0), point(10, 0), point(20, 0)] })), 2);
  assert.equal(segmentCount(createPath({ points: [point(0, 0)] })), 0);
});

test('length is measured along the curve, not along the chords', () => {
  const straight = createPath({ points: [point(0, 0, 0), point(300, 0, 0)] });
  assert.ok(Math.abs(pathLength(straight) - 300) < 1e-9, `straight length ${pathLength(straight)}`);
  const curve = createPath({ points: [point(0, 0), point(150, 150), point(300, 0)] });
  assert.ok(pathLength(curve) > 300, 'a curve is longer than the distance between its ends');
  const lengths = sampleLengths(samplePath(straight));
  assert.equal(lengths[0], 0);
  assert.ok(Math.abs(lengths.at(-1) - 300) < 1e-9);
});

test('travel is even along the whole path, not per segment', () => {
  // One short segment then one long one: an even walker is halfway round the *distance*
  // after half the time, which per-segment interpolation would get badly wrong.
  const path = createPath({ points: [point(0, 0, 0), point(100, 0, 0), point(1000, 0, 0)], closed: false });
  // The route is 100 units long then 900, so quarter of the way is x = 250 and half is 500.
  const quarter = pointAlong(path, 0.25), half = pointAlong(path, 0.5), threeQuarters = pointAlong(path, 0.75);
  assert.ok(Math.abs(quarter.x - 250) < 1, `quarter at ${quarter.x}`);
  assert.ok(Math.abs(half.x - 500) < 1, `half at ${half.x}`);
  assert.ok(Math.abs(threeQuarters.x - 750) < 1, `three quarters at ${threeQuarters.x}`);
  assert.ok(Math.abs(half.angle) < 1e-9, 'travelling along +x is angle 0');
  assert.deepEqual(pointAlong(createPath({ points: [] }), 0.5), null, 'no points, no position');
});

test('bounds cover every waypoint', () => {
  const path = createPath({ points: [point(0, 0, 1, 0), point(64, 96, 1, 32), point(-32, 12, 1, 8)] });
  assert.deepEqual(pathBounds(path), { minX: -32, maxX: 64, minY: 0, maxY: 96, minZ: 0, maxZ: 32 });
  assert.equal(pathBounds(createPath()), null);
});

test('a path with one point is a place, not a line', () => {
  const path = createPath({ points: [point(40, 50, 1, 16)] });
  assert.equal(segmentCount(path), 0);
  assert.deepEqual(samplePath(path), [{ x: 40, y: 50, z: 16 }]);
  assert.ok(Math.abs(pathLength(path)) < 1e-9);
  assert.deepEqual(pointAlong(path, 0.5), { x: 40, y: 50, z: 16, angle: 0 });
});

test('sampling density defaults are stable, so drawn lines and gameplay agree', () => {
  assert.equal(PATH_STEPS, 12);
  const path = createPath({ points: [point(0, 0), point(100, 0), point(200, 100)] });
  assert.equal(samplePath(path).length, segmentCount(path) * PATH_STEPS + 1);
});

// The project model: a path is part of the layout, so it has to survive saving, loading and
// the edit validator rather than living only in the editor.

test('a new project has an empty path list, and paths validate', () => {
  const project = createProject();
  assert.deepEqual(project.paths, []);
  project.paths = [createPath({ ...point(0, 0), id: 'path_1', name: 'Patrol',
    points: [{ ...point(0, 0), id: 'a' }, { ...point(100, 0), id: 'b', curve: 0 }] })];
  validateProject(project);
  // The curve is what the editor writes, so the whole range has to be accepted.
  project.paths[0].points[1].curve = 0;
  validateProject(project);
  project.paths[0].points[1].curve = 1;
  validateProject(project);
});

test('the validator rejects paths that could not be drawn', () => {
  const base = () => {
    const project = createProject();
    project.paths = [createPath({ id: 'path_1', name: 'Patrol',
      points: [{ id: 'a', x: 0, y: 0, z: 0, curve: 1 }] })];
    return project;
  };
  const broken = change => { const project = base(); change(project.paths); return () => validateProject(project); };

  assert.throws(broken(paths => { paths.push({ ...paths[0] }); }), /Duplicate path ID/);
  assert.throws(broken(paths => { paths[0].closed = 'yes'; }), /closed/);
  assert.throws(broken(paths => { paths[0].points[0].curve = 2; }), /curvature/);
  assert.throws(broken(paths => { paths[0].points[0].curve = -0.1; }), /curvature/);
  assert.throws(broken(paths => { paths[0].points[0].x = 'left'; }), /Path point X/);
  assert.throws(broken(paths => { paths[0].points.push({ ...paths[0].points[0] }); }), /Duplicate ID in path/);
  assert.throws(broken(paths => { paths[0].points[0].id = 'not an id'; }), /invalid characters/);
  assert.throws(broken(paths => { paths[0].name = ''; }), /Path name/);
  assert.throws(broken(paths => { paths.push(...Array.from({ length: MAX_PATHS }, () => createPath({ id: 'x' }))); }), /Paths/);
  assert.throws(broken(paths => { paths[0].points = Array.from({ length: MAX_PATH_POINTS + 1 }, (_, index) => ({ id: `p${index}`, x: 0, y: 0 })); }), /Path points/);
});
