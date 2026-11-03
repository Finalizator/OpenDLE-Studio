import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { createPath, createPathPoint, samplePath, sampleLengths, waypointDistances, pointAlong, pathSteps, pathReferences, removePath, pathSignature, bakePathRamp } from '../shared/paths.js';
import { pathSampler } from '../shared/path-motion.js';
import { addRamp, normalizeRamp } from '../shared/ramp.js';
import { pathRampFaces } from '../shared/path-ramp.js';
import { syncRampModels, faceNormal } from '../shared/ramp-model.js';
import { modelTriangles } from '../shared/model-geometry.js';
import { decodeDataURI, readModel, validateModelDocument } from '../shared/gltf.js';
import { createRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { captureScene } from '../shared/scenes.js';
import { exportNodeFile, validateNodeFile } from '../shared/node-file.js';
import { applyTool } from '../server/tools.js';
import { ProjectStore } from '../server/store.js';
import { rampProfile, rampProfileVertices, splitProfileEdge, editProfileVertex } from '../shared/ramp-profile.js';

const route = (options = {}) => createPath({ id: 'spine', name: 'Surf path', mode: 'smooth',
  points: [[-240, -180, 96], [240, -180, 128], [240, 180, 80], [-240, 180, 96]].map(([x, y, z], index) =>
    createPathPoint({ id: `p${index}`, x, y, z })), ...options });
const setup = (options = {}, rampOptions = {}) => {
  const project = createProject(), path = route(options);
  project.paths = [path];
  const ramp = addRamp(project, { pathId: path.id, profile: 'ridge', length: 24, slope: 50, ...rampOptions });
  return { project, path, ramp };
};
const mesh = (project, ramp) => {
  const asset = project.assets.find(asset => asset.id === ramp.modelAsset);
  const { json, binary } = readModel(decodeDataURI(asset.src), asset.format);
  validateModelDocument(json, binary.length);
  return modelTriangles(json, binary);
};
const near = (a, b, message) => assert.ok(Math.abs(a - b) < .002, `${message || ''}: ${a} != ${b}`);

test('all curve modes retain exact waypoints, height, arc-length indexing and closure', () => {
  for (const mode of ['straight', 'smooth', 'bezier', 'sine']) for (const closed of [false, true]) {
    const path = route({ mode, closed, steps: 24, softness: .65,
      sine: { amplitude: 48, height: 24, cycles: 3.5, phase: 40 } });
    path.points[1].handleIn = { x: -40, y: 120, z: 50 };
    path.points[1].handleOut = { x: 120, y: 30, z: -30 };
    const samples = samplePath(path), lengths = sampleLengths(samples), per = pathSteps(path);
    const { distances, total } = waypointDistances(path);
    assert.ok(samples.every(point => Object.values(point).every(Number.isFinite)));
    near(total, lengths.at(-1), `${mode} total`);
    path.points.forEach((point, index) => {
      assert.deepEqual(samples[index * per], { x: point.x, y: point.y, z: point.z });
      near(distances[index], lengths[index * per], `${mode} waypoint index`);
      const travelled = pointAlong(path, distances[index] / total);
      for (const axis of ['x', 'y', 'z']) near(travelled[axis], point[axis], `${mode} ${axis}`);
    });
    assert.deepEqual(samples.at(-1), samples[closed ? 0 : (path.points.length - 1) * per]);
  }
});

test('softness, explicit Bezier handles, sine controls and resolution change the actual shared curve', () => {
  const path = route(), sample = () => samplePath(path);
  const smooth = sample();
  path.softness = 0;
  assert.ok(sample().every((point, index) => {
    const segment = Math.min(Math.floor(index / 12), 2);
    const a = path.points[segment], b = path.points[segment + 1];
    return Math.abs((point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x)) < 1e-6;
  }));
  assert.notDeepEqual(smooth, sample());
  path.mode = 'bezier'; path.softness = 1;
  path.points[0].handleOut = { x: 100, y: -120, z: 90 };
  assert.ok(sample()[6].y < -180);
  assert.ok(sample()[6].z > 112);
  const sampler = pathSampler();
  let previous = sampler(path);
  for (const mutate of [
    () => { path.points[0].handleOut.y -= 30; },
    () => { path.softness = .5; },
    () => { path.mode = 'sine'; },
    () => { path.sine = { amplitude: 20, height: 30, cycles: 2, phase: 25 }; },
    () => { path.steps = 64; },
    () => { path.sine.phase = 70; },
    () => { path.points[0].steps = 128; },
  ]) {
    mutate();
    const next = sampler(path);
    assert.notEqual(next.samples, previous.samples, 'runtime sampling invalidates for every curve control');
    assert.deepEqual(next.samples, samplePath(path), 'runtime and editor sampling agree');
    previous = next;
  }
  assert.equal(sampler(path), previous, 'unchanged curves reuse the same sampling');
  const wave = route({ mode: 'sine', sine: { amplitude: 40, height: 20, cycles: 16 } });
  assert.equal(pathSteps(wave), 256, 'high frequency waves cannot alias away at default resolution');
});

test('the 3D editor invalidates its path overlay for every curve and face-density setting', () => {
  const source = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  const start = source.indexOf('function pathsSignature()');
  const end = source.indexOf('\n  /**', start);
  const path = route(), context = vm.createContext({ project: { paths: [path] }, selected: null, curveSignature: pathSignature });
  const signature = vm.runInContext(`(${source.slice(start, end)})`, context);
  let key = signature();
  for (const mutate of [
    () => { path.mode = 'bezier'; }, () => { path.softness = .4; },
    () => { path.points[1].handleIn = { x: -40, y: 80, z: 30 }; },
    () => { path.sine = { amplitude: 100 }; }, () => { path.steps = 30; },
    () => { path.points[1].steps = 8; },
  ]) {
    mutate();
    assert.notEqual(signature(), key);
    key = signature();
  }
});

test('new curve settings and collision modes are strictly validated', () => {
  const { project, ramp } = setup();
  for (const changes of [{ mode: 'random' }, { softness: 2 }, { steps: 2.5 }, { steps: 1000 },
    { sine: { cycles: Infinity } }, { sine: { cycles: 0 } }, { sine: { amplitude: NaN } }]) {
    const copy = structuredClone(project);
    Object.assign(copy.paths[0], changes);
    assert.throws(() => validateProject(copy));
  }
  const bad = structuredClone(project);
  bad.paths[0].points[0].handleOut = { x: 1, y: 2 };
  assert.throws(() => validateProject(bad), /handleOut z/);
  for (const steps of [0, -1, 257, 1.5, '12', NaN]) {
    const copy = structuredClone(project);
    copy.paths[0].points[0].steps = steps;
    assert.throws(() => validateProject(copy), /density/);
  }
  ramp.physics.body = 'dynamic';
  assert.throws(() => validateProject(project), /fixed model body/);
});

test('mixed per-span face densities produce exact triangle counts and waypoint distances', () => {
  for (const closed of [false, true]) {
    const { project, path, ramp } = setup({ closed, steps: 24 }, { length: 64 });
    path.points[0].steps = 8; path.points[1].steps = 16;
    path.points[3].steps = 4;
    const expected = 8 + 16 + 24 + (closed ? 4 : 0);
    const samples = samplePath(path), lengths = sampleLengths(samples);
    assert.equal(samples.length, expected + 1);
    const { distances, total } = waypointDistances(path);
    for (const [index, offset] of [0, 8, 24, 48].entries()) {
      near(distances[index], lengths[offset], `waypoint ${index}`);
      const travelled = pointAlong(path, distances[index] / total);
      for (const axis of ['x', 'y', 'z']) near(travelled[axis], path.points[index][axis]);
    }
    syncRampModels(project);
    assert.equal(mesh(project, ramp).indices.length / 3, expected * 6 + (closed ? 0 : 2));
    assertClosedMesh(mesh(project, ramp));
    assert.equal(samplePath(path, { steps: 2 }).length, (closed ? 4 : 3) * 2 + 1, 'explicit sampling overrides span counts');
    const saved = JSON.parse(JSON.stringify(project));
    validateProject(saved);
    assert.equal(saved.paths[0].points[0].steps, 8);
    delete path.points[0].steps;
    assert.equal(samplePath(path).length, expected + 1 + 16, 'reset uses the current default density');
  }
});

test('more faces subdivide straight mitered bends without folding or changing their footprint', () => {
  for (const closed of [false, true]) {
    let bounds;
    for (const steps of [1, 4, 64, 256]) {
      const { project, ramp } = setup({ closed, mode: 'straight', steps });
      const triangles = mesh(project, ramp);
      assertClosedMesh(triangles);
      const box = [0, 1, 2].map(axis => {
        const values = [...triangles.positions].filter((_, index) => index % 3 === axis);
        return [Math.min(...values), Math.max(...values)];
      });
      if (bounds) assert.deepEqual(box, bounds, 'density changes tessellation, not the mitered outline');
      bounds = box;
    }
  }
});

function assertClosedMesh(triangles) {
  const { positions, indices } = triangles, edges = new Map();
  const vertex = index => [...positions.slice(index * 3, index * 3 + 3)];
  let volume = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [...indices.slice(index, index + 3)].map(vertex);
    const [a, b, c] = vertices;
    const cross = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    assert.ok(Math.hypot(...cross) > 1e-5, 'no degenerate surf triangles');
    volume += a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    vertices.forEach((point, corner) => {
      const start = point.join(','), end = vertices[(corner + 1) % 3].join(',');
      const key = [start, end].sort().join('/');
      const list = edges.get(key) || [];
      list.push(`${start}/${end}`); edges.set(key, list);
    });
  }
  for (const [edge, faces] of edges) {
    assert.equal(faces.length, 2, `watertight edge ${edge}`);
    assert.notEqual(faces[0], faces[1], 'shared edges have opposite winding');
  }
  assert.ok(volume > 0, 'the mesh shell faces outward');
}

test('single and ridge profiles generate watertight GLBs, open end caps and welded closed seams', () => {
  for (const profile of ['single', 'ridge']) for (const closed of [false, true]) for (const facing of ['left', 'right']) {
    const { project, path, ramp } = setup({ closed }, { profile, facing });
    validateProject(project);
    const triangles = mesh(project, ramp), segments = samplePath(path).length - 1;
    assert.equal(triangles.indices.length / 3, segments * 6 + (closed ? 0 : 2));
    assertClosedMesh(triangles);
    assert.equal(ramp.physics.modelCollision, 'trimesh');
  }
});

test('zero-length waypoints are merged, while vertical spines, reversals, folds and excess detail are explicit errors', () => {
  const path = route({ mode: 'straight' });
  path.points.splice(1, 0, { ...path.points[0], id: 'duplicate' });
  const { project, ramp } = setup();
  assertClosedMesh((() => {
    project.paths = [path]; syncRampModels(project); return mesh(project, ramp);
  })());
  path.points[1].z++;
  assert.throws(() => syncRampModels(project), /vertical-only/);
  const reversal = route({ mode: 'straight' });
  reversal.points[2] = { ...reversal.points[0], id: 'reverse' };
  assert.throws(() => setup(reversal), /reverses too sharply/);
  assert.throws(() => setup({}, { length: 1000 }), /too wide/);
  const points = Array.from({ length: 100 }, (_, index) => createPathPoint({ id: `p${index}`, x: index * 32, y: 0 }));
  assert.throws(() => setup({ points, steps: 64 }), /at most 4096/);
});

test('live regeneration retains transforms, updates every shape control and prunes only unused meshes', () => {
  const { project, path, ramp } = setup();
  let old = ramp.modelAsset;
  syncRampModels(project);
  assert.equal(old, ramp.modelAsset, 'unchanged parameters reuse their asset');
  ramp.x += 100; ramp.y += 40; ramp.angle = 25; ramp.elevation += 50;
  const placement = [ramp.x, ramp.y, ramp.angle, ramp.elevation];
  for (const mutate of [
    () => { path.points[1].z += 20; }, () => { path.mode = 'straight'; },
    () => { path.mode = 'bezier'; path.points[1].handleOut = { x: 80, y: 80, z: 40 }; },
    () => { normalizeRamp(ramp, { slope: 60 }); }, () => { normalizeRamp(ramp, { length: 16 }); },
    () => { normalizeRamp(ramp, { profile: 'single' }); }, () => { normalizeRamp(ramp, { facing: 'left' }); },
  ]) {
    mutate(); syncRampModels(project);
    assert.notEqual(ramp.modelAsset, old);
    assert.ok(!project.assets.some(asset => asset.id === old));
    assert.deepEqual([ramp.x, ramp.y, ramp.angle, ramp.elevation], placement);
    old = ramp.modelAsset;
  }
  project.game = { levels: [{ data: { map: { entities: [{ modelAsset: old }] } }, assetIds: [old] }] };
  path.points[1].z += 30; syncRampModels(project);
  assert.ok(project.assets.some(asset => asset.id === old), 'dormant campaign meshes survive regeneration');
});

test('path deletion, baking, scene capture and portable nodes retain exact mesh collision without dangling paths', () => {
  const { project, ramp } = setup();
  const original = ramp.modelAsset;
  const scene = captureScene(project, [ramp.id]);
  assert.equal(scene.entities[0].type, 'decoration');
  assert.equal(scene.entities[0].ramp, undefined);
  assert.equal(scene.entities[0].modelAsset, original);
  const file = exportNodeFile({ id: 'portable', name: 'Portable', entities: [ramp], events: [] }, ramp.id, { assets: project.assets });
  validateNodeFile(file);
  assert.ok(!JSON.stringify(file).includes('"pathId"'));
  assert.equal(file.nodes[0].modelAsset, original);
  assert.equal(pathReferences(project, 'spine').ramps[0], ramp);
  assert.equal(removePath(project, 'spine').ramps, 1);
  assert.equal(ramp.type, 'decoration'); assert.equal(ramp.ramp, undefined);
  syncRampModels(project); validateProject(project);
  assert.equal(ramp.modelAsset, original);
  assert.equal(ramp.physics.modelCollision, 'trimesh');
  assert.equal(bakePathRamp(ramp), false);
});

const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

test('real Rapier triangle collision matches every curved face and leaves concave space empty', async () => {
  await R.init();
  const { project, path, ramp } = setup();
  project.map.sectors[0].floorHeight = 32;
  // Binding on a nonzero floor still puts the ramp base at the path's world Z.
  const { bindRampPath } = await import('../shared/ramp.js');
  Object.assign(ramp, { z: 500, rotation: { x: 0, y: 1, z: 0, w: 0 }, modelOffset: [10, 20, 30],
    path: { id: path.id }, modelSpin: { rotating: true } });
  bindRampPath(project, ramp, path.id);
  for (const key of ['z', 'rotation', 'modelOffset', 'modelSpin', 'path']) assert.equal(ramp[key], undefined);
  near(ramp.elevation, path.points[0].z - 32, 'floor-relative anchor');
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.physics = createPhysics(project, state, R, triangulate);
  try {
    const collider = state.physics.bodies.get(ramp.id).collider(0);
    assert.equal(collider.shapeType(), R.ShapeType.TriMesh);
    const faces = pathRampFaces(path, ramp.ramp);
    for (const face of faces.filter(face => face.name === 'surf')) {
      const centre = [0, 1, 2].map(axis => (face.corners[0][axis] + face.corners[1][axis] + face.corners[2][axis]) / 3);
      const x = centre[0] + ramp.x, y = centre[2] + ramp.y, z = centre[1] + path.points[0].z;
      const ray = new R.Ray({ x: x / 64, y: (z + 200) / 64, z: y / 64 }, { x: 0, y: -1, z: 0 });
      const hit = collider.castRayAndGetNormal(ray, 400 / 64, true);
      assert.ok(hit, 'every visible surf face is solid');
      near(z + 200 - hit.timeOfImpact * 64, z, 'collider matches triangle height');
      const normal = faceNormal(face.corners);
      assert.ok(hit.normal.y > 0 && normal[1] > 0);
    }
    const empty = new R.Ray({ x: 0, y: 500 / 64, z: 0 }, { x: 0, y: -1, z: 0 });
    assert.equal(collider.castRay(empty, 1000 / 64, true), -1, 'no convex hull fills the U-shaped centre');
  } finally { state.physics.dispose(); }
});

test('MCP edits rebuild ramps transactionally; disk save and reopen keep curves and exact generated meshes', t => {
  const { project, path, ramp } = setup();
  let result = applyTool(project, 'paths_set', { paths: [{ ...path, mode: 'straight' }] });
  assert.notEqual(result.project.map.entities.find(item => item.id === ramp.id).modelAsset, ramp.modelAsset);
  assert.equal(project.paths[0].mode, 'smooth', 'MCP never mutates its input');
  result = applyTool(result.project, 'ramp_generate', { pathId: path.id, id: ramp.id, length: 32, profile: 'single', slope: 55 });
  validateProject(result.project);
  assert.throws(() => applyTool(result.project, 'paths_set', { paths: [] }), /unknown path/);
  const directory = mkdtempSync(join(tmpdir(), 'opendle-path-ramps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'project.json'), store = new ProjectStore(file);
  const adopted = store.adopt(result.project);
  const edited = structuredClone(adopted.project);
  edited.paths[0].points[1].z += 16;
  const stale = edited.map.entities.find(item => item.id === ramp.id).modelAsset;
  const saved = store.update(edited, adopted.revision, adopted.projectId);
  assert.notEqual(saved.project.map.entities.find(item => item.id === ramp.id).modelAsset, stale, 'HTTP/store saves rebuild stale procedural assets too');
  const reopened = new ProjectStore(file).snapshot();
  assert.deepEqual(reopened.project, saved.project);
});

test('advanced standalone and path profiles are watertight solids, including concave toes and caps', () => {
  const custom = [{ x: -32, z: -4 }, { x: -32, z: 32 }, { x: -16, z: 32 }, { x: -16, z: 8 },
    { x: 16, z: 8 }, { x: 16, z: 32 }, { x: 32, z: 32 }, { x: 32, z: -4 }];
  for (const profile of ['single', 'ridge', 'custom']) for (const facing of ['left', 'right'])
    for (const closed of [false, true]) {
      const changes = { profile, facing, length: 24, topWidth: 12, footWidth: 16, baseThickness: 4,
        edgeStyle: 'round', edgeSize: 4, toeStyle: 'round', toeSize: 6, roundSegments: 6,
        ...(profile === 'custom' ? { vertices: splitProfileEdge(custom, 0) } : {}) };
      const { project, ramp, path } = setup({ closed }, changes);
      assertClosedMesh(mesh(project, ramp));
      const geometry = rampProfile(ramp.ramp);
      const segments = samplePath(path).length - 1;
      assert.equal(mesh(project, ramp).indices.length / 3,
        segments * geometry.vertices.length * 2 + (closed ? 0 : 2 * geometry.triangles.length));
      const standalone = addRamp(project, { ...changes, width: 128 });
      assertClosedMesh(mesh(project, standalone));
      validateProject(project);
      assert.equal(standalone.physics.modelCollision, 'trimesh');
    }
});

test('rounded profile normals join across fillets; bevel and cap boundaries keep hard normals', () => {
  for (const style of ['round', 'bevel']) {
    const { ramp, path } = setup({}, { edgeStyle: style, edgeSize: 6, roundSegments: 6 });
    const { vertices } = rampProfile(ramp.ramp), faces = pathRampFaces(path, ramp.ramp);
    for (let vertex = 0; vertex < vertices.length; vertex++) {
      const before = faces[(vertex - 1 + vertices.length) % vertices.length].normals[3], after = faces[vertex].normals[0];
      if (vertices[vertex].smooth) assert.deepEqual(before, after);
      else assert.notDeepEqual(before, after, 'hard corners are not smoothed into their neighbouring planes');
    }
  }
});

test('profile detail multiplies path detail but cannot exceed the mesh triangle budget', () => {
  const path = route({ steps: 256 });
  const options = { pathId: path.id, profile: 'ridge', length: 24, slope: 50, topWidth: 16, footWidth: 16,
    edgeStyle: 'round', edgeSize: 4, toeStyle: 'round', toeSize: 4, roundSegments: 16 };
  const project = createProject(); project.paths = [path];
  assert.throws(() => addRamp(project, options), /at most 65536 triangles/);
});

test('large valid rounded sweeps use 32-bit indices within the combined triangle budget', () => {
  const { project, ramp, path } = setup({ steps: 256, mode: 'straight' }, { topWidth: 12, footWidth: 16,
    baseThickness: 4, edgeStyle: 'round', edgeSize: 4, toeStyle: 'round', toeSize: 6, roundSegments: 8 });
  const asset = project.assets.find(asset => asset.id === ramp.modelAsset);
  const { json } = readModel(decodeDataURI(asset.src), asset.format);
  const primitive = json.meshes[0].primitives[0], indices = json.accessors[primitive.indices];
  assert.equal(indices.componentType, 5125);
  assert.equal(indices.count / 3, (samplePath(path).length - 1) * 80 + 76);
  assert.ok(json.accessors[primitive.attributes.POSITION].count > 65535);
});

test('Rapier matches flat tops, soft toes, rounded surfaces and custom concave face edits exactly', async () => {
  await R.init();
  const custom = [{ x: -64, z: -8 }, { x: -64, z: 64 }, { x: -24, z: 64 }, { x: -24, z: 16 },
    { x: 24, z: 16 }, { x: 24, z: 64 }, { x: 64, z: 64 }, { x: 64, z: -8 }];
  for (const options of [{ profile: 'ridge', topWidth: 32, footWidth: 48, baseThickness: 8,
    edgeStyle: 'round', edgeSize: 8, toeStyle: 'round', toeSize: 16 }, { profile: 'custom', vertices: custom }]) {
    const project = createProject(), ramp = addRamp(project, { ...options, length: 64, width: 128, slope: 45 });
    ramp.elevation = 32;
    const state = createRuntime(project, { screen: 'playing', gameMode: true });
    state.physics = createPhysics(project, state, R, triangulate);
    try {
      const collider = state.physics.bodies.get(ramp.id).collider(0);
      assert.equal(collider.shapeType(), R.ShapeType.TriMesh);
      const geometry = rampProfile(ramp.ramp), vertices = geometry.vertices;
      for (let index = 0; index < vertices.length; index++) {
        const a = vertices[index], b = vertices[(index + 1) % vertices.length];
        if (b.x <= a.x + 1e-6) continue;
        const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2 + 32;
        const ray = new R.Ray({ x: x / 64, y: (z + 200) / 64, z: 0 }, { x: 0, y: -1, z: 0 });
        const hit = collider.castRayAndGetNormal(ray, 400 / 64, true);
        assert.ok(hit); near(z + 200 - hit.timeOfImpact * 64, z, 'ray hits the actual profile, not a convex hull');
      }
      if (options.profile === 'custom') {
        const ray = new R.Ray({ x: 0, y: 200 / 64, z: 0 }, { x: 0, y: -1, z: 0 });
        near(200 - collider.castRay(ray, 400 / 64, true) * 64, 48, 'concave notch remains empty down to its authored plane');
      }
    } finally { state.physics.dispose(); }
  }
});

test('custom profile edits regenerate, persist, export and reject invalid MCP edits transactionally', t => {
  const project = createProject(), ramp = addRamp(project, { length: 64, width: 128 });
  const original = structuredClone(project);
  const vertices = editProfileVertex(splitProfileEdge(rampProfileVertices(ramp.ramp), 0), 1, { x: -12, z: 50 });
  const result = applyTool(project, 'ramp_set_profile', { id: ramp.id, profile: 'custom', vertices, roundSegments: 8 });
  assert.deepEqual(project, original);
  const edited = result.project.map.entities.find(item => item.id === ramp.id);
  assert.notEqual(edited.modelAsset, ramp.modelAsset); assertClosedMesh(mesh(result.project, edited));
  assert.deepEqual(edited.ramp.vertices, vertices);
  const snapshot = structuredClone(result.project);
  assert.throws(() => applyTool(result.project, 'ramp_set_profile',
    { id: ramp.id, profile: 'custom', vertices: [vertices[0], vertices[0], vertices[2]] }), /must not coincide/);
  assert.deepEqual(result.project, snapshot);
  assert.throws(() => applyTool(project, 'ramp_set_profile', { id: ramp.id, roundSegments: 1.5 }));
  const linkedProject = structuredClone(result.project);
  linkedProject.paths = [route()];
  const linked = applyTool(linkedProject, 'ramp_generate', { id: ramp.id, pathId: linkedProject.paths[0].id,
    profile: 'custom', vertices, roundSegments: 8 });
  const linkedRamp = linked.project.map.entities.find(item => item.id === ramp.id);
  assert.deepEqual(linkedRamp.ramp.vertices, vertices);
  const linkedScene = captureScene(linked.project, [ramp.id]);
  assert.equal(linkedScene.entities[0].ramp, undefined);
  assert.equal(linkedScene.entities[0].modelAsset, linkedRamp.modelAsset);
  const scene = captureScene(result.project, [edited.id], { id: 'profile_scene', name: 'Profile' });
  assert.deepEqual(scene.entities[0].ramp.vertices, vertices, 'standalone profiles stay editable inside reusable scenes');
  const portable = exportNodeFile(scene, edited.id, { assets: result.project.assets });
  validateNodeFile(portable);
  const directory = mkdtempSync(join(tmpdir(), 'opendle-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'project.json'), store = new ProjectStore(file), saved = store.adopt(result.project);
  const stale = structuredClone(saved.project), changed = stale.map.entities.find(item => item.id === ramp.id);
  changed.ramp.vertices[1].z -= 8;
  const updated = store.update(stale, saved.revision, saved.projectId);
  assert.notEqual(updated.project.map.entities.find(item => item.id === ramp.id).modelAsset, changed.modelAsset);
  assert.deepEqual(new ProjectStore(file).snapshot().project, updated.project);
  assert.deepEqual(stale.map.entities.find(item => item.id === ramp.id).modelAsset, changed.modelAsset, 'store regeneration never mutates its input');
});
