import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { cutLevelGeometry, geometryBrush, geometryEdges, snapGeometryPoint } from '../shared/geometry-cut.js';
import { containsPoint, sectorAt, sectorGeometry, sectorShapes } from '../shared/sectors.js';
import { createPhysics } from '../shared/physics.js';
import { createRuntime } from '../shared/runtime.js';
import { floorHeightAt } from '../shared/three-d-floors.js';
import { applyTool } from '../server/tools.js';
import { ProjectStore } from '../server/store.js';

const near = (a, b, message = '') => assert.ok(Math.abs(a - b) < .002, `${message}: ${a} != ${b}`);
const signedArea = ring => ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;
const area = project => sectorGeometry(project).reduce((sum, sector) => sum + sectorShapes(sector.rings).reduce((total, shape) =>
  total + Math.abs(signedArea(shape.outer)) - shape.holes.reduce((holes, ring) => holes + Math.abs(signedArea(ring)), 0), 0), 0);
const rect = { a: { x: -64, y: -64, z: 64 }, b: { x: 64, y: -64, z: 64 }, end: { x: 0, y: 128, z: 0 } };
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

function assertTopology(project, expectedArea = 768 * 512) {
  validateProject(project);
  const sectors = sectorGeometry(project), vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex])), keys = new Set();
  near(area(project), expectedArea, 'no overlapping floors or lost map area');
  for (const wall of project.map.walls) {
    const a = vertices.get(wall.a), b = vertices.get(wall.b);
    const key = [JSON.stringify([a.x, a.y]), JSON.stringify([b.x, b.y])].sort().join('/');
    assert.ok(!keys.has(key), 'a boundary has one linedef, not overlapping copies'); keys.add(key);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1e-5, 'no collapsed edges');
    for (const vertex of project.map.vertices) {
      if (vertex.id === wall.a || vertex.id === wall.b) continue;
      const t = ((vertex.x - a.x) * (b.x - a.x) + (vertex.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      if (t <= 1e-6 || t >= 1 - 1e-6) continue;
      assert.ok(Math.hypot(vertex.x - a.x - t * (b.x - a.x), vertex.y - a.y - t * (b.y - a.y)) > 1e-5,
        'no unsplit T junctions');
    }
  }
  for (const sector of sectors) assert.ok(sector.rings.length > 0, 'every sector has a closed boundary');
}
function platform() {
  const project = createProject(); project.map.sectors[0].ceilingHeight = 256;
  const result = cutLevelGeometry(project, { mode: 'tunnel', a: { x: -96, y: -80 }, b: { x: 96, y: -80 },
    end: { x: 0, y: 80, z: 0 }, clearance: 256 });
  project.map.sectors.find(sector => sector.id === result.sectorIds[0]).floorHeight = 96;
  return { project, platformId: result.sectorIds[0] };
}

test('cut snaps to vertices first, then projects exactly onto diagonal edges before using the grid', () => {
  const project = createProject();
  const vertex = snapGeometryPoint(project, { x: -380, y: -250 });
  assert.equal(vertex.kind, 'vertex'); assert.equal(vertex.x, -384); assert.equal(vertex.y, -256);
  const edge = snapGeometryPoint(project, { x: 3, y: -252 });
  assert.equal(edge.kind, 'edge'); assert.equal(edge.x, 3); assert.equal(edge.y, -256);
  project.map.vertices[1].y = -128;
  const diagonal = snapGeometryPoint(project, { x: 1, y: -190 }, { tolerance: 12, grid: 64 });
  assert.equal(diagonal.kind, 'edge'); near(diagonal.y, -256 + (diagonal.x + 384) / 6);
  const grid = snapGeometryPoint(project, { x: 39, y: 42 });
  assert.equal(grid.kind, 'grid'); assert.equal(grid.x, 32); assert.equal(grid.y, 48);
  const { project: raised } = platform();
  const top = snapGeometryPoint(raised, { x: 2, y: 80 });
  assert.equal(top.z, 96, '2D edge snapping prefers the raised ledge, not the lower adjacent floor');
  assert.ok(geometryEdges(raised).some(edge => edge.a.z === 96));
  const ledge = raised.map.sectors.find(sector => sector.floorHeight === 96);
  ledge.ceilingHeight = 192;
  ledge.threeDFloors = [{ type: 1, solid: true, thin: false, bottom: 160, top: 176 }];
  const allEdges = geometryEdges(raised, { ceilings: true });
  for (const [height, surface] of [[192, 'ceiling'], [176, 'floor']]) {
    const edges = allEdges.filter(edge => edge.a.z === height);
    assert.equal(edges.length, 4);
    assert.ok(edges.every(edge => edge.sectorId === ledge.id && edge.surface === surface));
  }
});

test('straight, reversed and diagonal sector cuts weld both sides without moving or losing geometry', () => {
  for (const [a, b] of [[{ x: 0, y: -256 }, { x: 0, y: 256 }],
    [{ x: 384, y: 256 }, { x: -384, y: -256 }], [{ x: -300, y: -256 }, { x: 384, y: 180 }]]) {
    const project = createProject(), entities = structuredClone(project.map.entities);
    project.map.sectors[0].tag = 11;
    const result = cutLevelGeometry(project, { mode: 'cut', a, b });
    assertTopology(project);
    assert.equal(project.map.sectors.length, 2);
    assert.equal(result.sectorIds.length, 1);
    assert.ok(project.map.sectors.every(sector => sector.tag === 11 && sector.floorHeight === 0 && sector.ceilingHeight === 128));
    const portal = project.map.walls.find(wall => wall.right && wall.left);
    assert.equal(portal.solid, false);
    assert.deepEqual(project.map.entities, entities);
    assert.ok(project.map.sectors.some(sector => sector.id === 'room0'), 'old explicit sector references remain valid');
  }
});

test('subdividing sectors preserves linedef specials, tags, sidedef properties and texture continuity', () => {
  const project = createProject(), original = project.map.walls[0];
  Object.assign(original, { special: 10, tag: 7, specialFormat: 'zdoom', args: [7, 16, 0, 0, 0], flags: 16 });
  Object.assign(original.right, { offsetX: 5, offsetY: 3, slots: { top: { offsetX: 17, offsetY: 11 } } });
  cutLevelGeometry(project, { mode: 'cut', a: { x: 0, y: -256 }, b: { x: 0, y: 256 } });
  const pieces = project.map.walls.filter(wall => wall.special === 10);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].id, original.id);
  for (const piece of pieces) {
    assert.equal(piece.tag, 7); assert.equal(piece.flags, 16); assert.deepEqual(piece.args, [7, 16, 0, 0, 0]);
    assert.equal(piece.right.offsetY, 3);
  }
  assert.deepEqual(pieces.map(piece => piece.right.offsetX), [5, 389]);
  assert.deepEqual(pieces.map(piece => piece.right.slots.top.offsetX), [17, 401]);
  assertTopology(project);
});

test('stair brushes create exact tread heights, shared risers and one outside sector with a hole', () => {
  for (const steps of [1, 4, 12, 64]) for (const direction of [1, -1]) {
    const project = createProject(); project.map.sectors[0].ceilingHeight = 256;
    const brush = { a: { x: -64, y: -64, z: direction > 0 ? 64 : 0 }, b: { x: 64, y: -64 },
      end: { x: 0, y: 128, z: direction > 0 ? 0 : 64 }, steps };
    const result = cutLevelGeometry(project, { mode: 'stairs', ...brush });
    near(area(project), 768 * 512);
    validateProject(project);
    assert.equal(result.sectorIds.length, steps);
    for (let index = 0; index < steps; index++) {
      const point = { x: 0, y: -64 + 192 * (index + .5) / steps };
      const expected = brush.a.z + (brush.end.z - brush.a.z) * (index + 1) / steps;
      near(sectorAt(sectorGeometry(project), point.x, point.y).floorHeight, expected);
    }
    if (steps <= 12) assertTopology(project);
    assert.equal(project.map.entities.length, 2, 'stairs are map sectors, not entity boxes');
  }
});

test('stairs attach to a partial ledge, splitting its edge and opening only edited portals', () => {
  const { project, platformId } = platform();
  const originalWalls = project.map.walls.filter(wall => wall.right?.sectorId === platformId || wall.left?.sectorId === platformId);
  for (const wall of originalWalls) { wall.solid = true; wall.flags = 3; }
  const result = cutLevelGeometry(project, { mode: 'stairs', a: { x: -64, y: 80, z: 96 },
    b: { x: 64, y: 80, z: 96 }, end: { x: 0, y: 240, z: 0 }, steps: 6 });
  assertTopology(project);
  const stairIds = new Set(result.sectorIds);
  const attached = project.map.walls.filter(wall => [wall.right?.sectorId, wall.left?.sectorId].includes(platformId) &&
    [wall.right?.sectorId, wall.left?.sectorId].some(id => stairIds.has(id)));
  assert.equal(attached.length, 1); assert.equal(attached[0].solid, false); assert.equal(attached[0].flags & 3, 0);
  const untouched = project.map.walls.find(wall => wall.id === originalWalls[0].id);
  assert.equal(untouched.solid, true, 'unrelated blocking lines do not become passable');
});

test('shared cutter authoring keeps settings and pending points, reports failures and commits only complete operations', () => {
  const elements = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.value = ''; elements.push(this); }
    append(child) {
      child.parentElement = this; this.children.push(child);
      if (this.tag === 'select' && this.children.length === 1) this.value = child.value;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  }
  const source = readFileSync(new URL('../public/geometry-cut-tool.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/, '').replace('export function createGeometryCutTool', 'function createGeometryCutTool');
  const create = runInNewContext(`${source}\ncreateGeometryCutTool`, {
    geometryBrush, document: { createElement: tag => new Element(tag) },
  });
  let active = true;
  const host = new Element('div'), project = createProject(), messages = [], commits = [];
  project.map.sectors[0].ceilingHeight = 256;
  const tool = create(host, { active: () => active, changed() {}, status: (...args) => messages.push(args),
    apply(options) { cutLevelGeometry(project, options); commits.push(options); } });
  const input = label => elements.find(element => element.attributes['aria-label'] === label);
  const mode = input('Cut operation');
  tool.sync(); assert.equal(host.hidden, false);
  tool.click({ x: 0, y: 0, kind: 'grid' });
  assert.equal(tool.drawing, false); assert.match(messages.at(-1)[0], /must snap/);
  mode.value = 'stairs'; mode.events.change();
  tool.click({ ...rect.a, kind: 'edge' }); tool.click({ ...rect.b, kind: 'edge' });
  input('Stair steps').value = '0'; input('Stair steps').events.input();
  tool.hover({ ...rect.end, kind: 'grid' });
  assert.match(tool.preview().error, /between 1 and 64/);
  const baseline = structuredClone(project);
  tool.click({ ...rect.end, kind: 'grid' });
  assert.equal(tool.drawing, true); assert.equal(commits.length, 0); assert.deepEqual(project, baseline);
  input('Stair steps').value = '6'; input('Stair steps').events.input();
  assert.equal(tool.preview().segments.length, 36);
  tool.click({ ...rect.end, kind: 'grid' });
  assert.equal(commits.length, 1); assert.equal(project.map.sectors.length, 7); assert.equal(tool.drawing, false);
  tool.click({ ...rect.a, kind: 'edge' }); tool.back(); assert.equal(tool.drawing, false);
  tool.click({ ...rect.a, kind: 'edge' }); tool.cancel(); assert.equal(tool.drawing, false);
  tool.click({ ...rect.a, kind: 'edge' }); mode.value = 'tunnel'; mode.events.change();
  assert.equal(tool.drawing, false);
  active = false; tool.sync(); tool.click({ ...rect.a, kind: 'edge' });
  assert.equal(host.hidden, true); assert.equal(tool.drawing, false);
});

test('rotated and boundary-aligned stair brushes partition concave and holed sectors without overlaps', () => {
  for (const brush of [{ a: { x: -80, y: -80, z: 64 }, b: { x: 16, y: -144 }, end: { x: 128, y: 144, z: 0 } },
    { a: { x: -384, y: -256, z: 64 }, b: { x: 384, y: -256 }, end: { x: 0, y: 256, z: 0 } }]) {
    const { project } = platform();
    cutLevelGeometry(project, { mode: 'stairs', ...brush, steps: 4 });
    assertTopology(project);
    const sectors = sectorGeometry(project);
    for (let y = -247; y < 256; y += 37) for (let x = -377; x < 384; x += 41)
      assert.equal(sectors.filter(sector => containsPoint(sector.rings, x, y)).length, 1, 'sampled map space belongs to exactly one sector');
  }
});

test('tunnels retain overhead platform slabs and objects, with real headroom and open entrances', () => {
  const { project } = platform();
  project.map.entities.push({ id: 'above', type: 'decoration', name: 'Above tunnel', x: 0, y: 0, angle: 0, elevation: 8 });
  cutLevelGeometry(project, { mode: 'tunnel', a: { x: -32, y: -128, z: 0 }, b: { x: 32, y: -128 },
    end: { x: 0, y: 128, z: 0 }, clearance: 64 });
  assertTopology(project);
  const sectors = sectorGeometry(project), inside = sectorAt(sectors, 0, 0);
  assert.equal(inside.floorHeight, 0); assert.equal(inside.ceilingHeight, 256);
  assert.equal(sectorAt(sectors, 0, 110).ceilingHeight, 256, 'open approaches must not acquire artificial tunnel roofs');
  assert.equal(inside.threeDFloors.length, 1);
  assert.equal(inside.threeDFloors[0].bottom, 64); assert.equal(inside.threeDFloors[0].top, 96);
  assert.equal(floorHeightAt(inside, 100), 96);
  assert.equal(floorHeightAt(inside, 32), 0);
  const above = project.map.entities.find(entity => entity.id === 'above');
  assert.equal(above.z, 104); assert.equal(above.elevation, 8);
});

test('invalid cuts, crossed holes, impossible headroom and existing slabs are rejected atomically', () => {
  const project = createProject();
  const snapshot = structuredClone(project);
  for (const options of [{ mode: 'cut', a: { x: 0, y: 0 }, b: { x: 0, y: 256 } },
    { mode: 'cut', a: { x: -384, y: -256 }, b: { x: 384, y: -256 } },
    { mode: 'stairs', ...rect, steps: 0 }, { mode: 'stairs', ...rect, steps: 1.5 },
    { mode: 'stairs', ...rect, end: rect.a }, { mode: 'stairs', ...rect, startHeight: 128, endHeight: 256 },
    { mode: 'tunnel', ...rect, clearance: NaN }, { mode: 'tunnel', a: rect.a, b: rect.b }]) {
    assert.throws(() => cutLevelGeometry(project, options), /Geometry cut:/);
    assert.deepEqual(project, snapshot);
  }
  const { project: raised } = platform();
  const copy = structuredClone(raised);
  const shifted = structuredClone(raised);
  for (const vertex of shifted.map.vertices) if (Math.abs(vertex.x) <= 96 && Math.abs(vertex.y) <= 80) vertex.x += 160;
  assert.throws(() => cutLevelGeometry(shifted, { mode: 'cut', a: { x: -384, y: 0 }, b: { x: 384, y: 0 } }), /hole|boundary/);
  assert.deepEqual(raised, copy);
  assert.throws(() => cutLevelGeometry(raised, { mode: 'tunnel', ...rect, clearance: 100 }), /clearance intersects/);
  assert.deepEqual(raised, copy);
  raised.map.sectors[0].threeDFloors = [{ bottom: 32, top: 48, solid: true }];
  assert.throws(() => cutLevelGeometry(raised, { mode: 'tunnel', ...rect }), /existing solid 3D floor/);
});

test('real Rapier collision follows stair tread heights and an unobstructed under-platform passage', async () => {
  await R.init();
  for (const mode of ['stairs', 'tunnel']) {
    const { project } = platform();
    if (mode === 'stairs') cutLevelGeometry(project, { mode, a: { x: -64, y: 80, z: 96 }, b: { x: 64, y: 80 },
      end: { x: 0, y: 240, z: 0 }, steps: 6 });
    else cutLevelGeometry(project, { mode, a: { x: -32, y: -128 }, b: { x: 32, y: -128 }, end: { x: 0, y: 128, z: 0 }, clearance: 64 });
    const state = createRuntime(project);
    state.physics = createPhysics(project, state, R, triangulate);
    try {
      const cast = (origin, direction, distance) => state.physics.world.castRay(new R.Ray(
        { x: origin.x / 64, y: origin.z / 64, z: origin.y / 64 }, { x: direction.x, y: direction.z, z: direction.y }),
      distance / 64, true);
      if (mode === 'stairs') {
        for (let index = 0; index < 6; index++) {
          const hit = cast({ x: 0, y: 80 + 160 * (index + .5) / 6, z: 200 }, { x: 0, y: 0, z: -1 }, 220);
          assert.ok(hit); near(200 - hit.timeOfImpact * 64, 96 - 16 * (index + 1));
        }
      } else {
        const opening = cast({ x: 0, y: -120, z: 32 }, { x: 0, y: 1, z: 0 }, 240);
        assert.equal(opening, null, 'neither old solid walls nor overlapping copies block the tunnel');
        const roof = cast({ x: 0, y: 0, z: 32 }, { x: 0, y: 0, z: 1 }, 100);
        assert.ok(roof); near(32 + roof.timeOfImpact * 64, 64);
        const top = cast({ x: 0, y: 0, z: 200 }, { x: 0, y: 0, z: -1 }, 220);
        assert.ok(top); near(200 - top.timeOfImpact * 64, 96, 'platform top survives the tunnel');
        const side = cast({ x: 0, y: 0, z: 32 }, { x: 1, y: 0, z: 0 }, 100);
        assert.ok(side); near(side.timeOfImpact * 64, 32);
      }
    } finally { state.physics.dispose(); }
  }
});

test('MCP cuts are transactional and persist their exact topology on disk', t => {
  const project = createProject(), snapshot = structuredClone(project);
  const result = applyTool(project, 'geometry_cut', { mode: 'stairs', ...rect, steps: 4 });
  assertTopology(result.project); assert.deepEqual(project, snapshot);
  assert.throws(() => applyTool(project, 'geometry_cut', { mode: 'cut', a: rect.a, b: rect.b }), /snap/);
  assert.deepEqual(project, snapshot);
  const directory = mkdtempSync(join(tmpdir(), 'opendle-cut-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'project.json'), store = new ProjectStore(file);
  const saved = store.adopt(result.project);
  assert.deepEqual(new ProjectStore(file).snapshot().project, saved.project);
});

test('brush footprint uses the clicked edge orientation rather than world axes', () => {
  const a = { x: 0, y: 0 }, b = { x: 64, y: 64 };
  const brush = geometryBrush({ a, b, end: { x: -64, y: 64 }, steps: 4 });
  near(brush.width, Math.sqrt(8192)); near(brush.depth, Math.sqrt(8192));
  assert.deepEqual(brush.outline.slice(0, 2), [a, b]);
  near(brush.outline[2].x, 0); near(brush.outline[2].y, 128);
});
