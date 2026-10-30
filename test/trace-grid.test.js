import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryDistance } from '../shared/combat.js';
import { containsPoint } from '../shared/sectors.js';
import { createTraceGrid, forEachCellAlong, traceGrid } from '../shared/trace-grid.js';

// A 512-unit lattice of rooms. Every wall is shared by two sectors and the cells are
// small enough that a ray only reaches a handful of them, so the grid has to prune.
function rooms() {
  const walls = [], sectors = [], size = 400, step = 512;
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    const id = `sector${row}-${column}`, x = column * step, y = row * step;
    sectors.push({
      id, floorHeight: (row + column) % 3 === 0 ? 0 : 32, ceilingHeight: 128, sky: (row + column) % 5 === 0,
      rings: [[{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }]],
      bounds: { minX: x, maxX: x + size, minY: y, maxY: y + size },
    });
    const corners = [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
    const neighbour = (rowOffset, columnOffset) => {
      const r = row + rowOffset, c = column + columnOffset;
      return r >= 0 && r < 4 && c >= 0 && c < 4 ? `${r}-${c}` : null;
    };
    for (let edge = 0; edge < 4; edge++) {
      const start = corners[edge], end = corners[(edge + 1) % 4];
      const other = [neighbour(-1, 0), neighbour(0, 1), neighbour(1, 0), neighbour(0, -1)][edge];
      walls.push({
        id: `${id}-edge${edge}`, start, end, solid: false, flags: edge === 1 ? 64 : 0,
        right: { sectorId: id }, left: other ? { sectorId: `sector${other}` } : null,
      });
    }
  }
  // One sector covering the whole lattice: too large to file in cells, so every trace
  // has to consult it directly.
  sectors.push({
    id: 'outdoor', floorHeight: -24, ceilingHeight: 512, sky: false,
    rings: [[{ x: -800, y: -800 }, { x: 2400, y: -800 }, { x: 2400, y: 2400 }, { x: -800, y: 2400 }]],
    bounds: { minX: -800, maxX: 2400, minY: -800, maxY: 2400 },
  });
  return { walls, sectors };
}

// The exhaustive sweep the grid replaces; kept here so the test states the contract.
function referenceDistance(state, origin, direction, range, movement = false) {
  const sectors = new Map(state.sectors.map(sector => [sector.id, sector]));
  let nearest = range;
  for (const wall of state.walls) {
    const sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
    const cross = direction.x * sy - direction.y * sx;
    if (Math.abs(cross) < 1e-9) continue;
    const qx = wall.start.x - origin.x, qy = wall.start.y - origin.y;
    const distance = (qx * sy - qy * sx) / cross, u = (qx * direction.y - qy * direction.x) / cross;
    if (distance <= 1e-5 || distance >= nearest || u < 0 || u > 1) continue;
    const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
    const height = origin.z + (direction.z || 0) * distance;
    if (!(movement && wall.solid) && front && back && height > Math.max(front.floorHeight, back.floorHeight) && height < Math.min(front.ceilingHeight, back.ceilingHeight)) continue;
    if (!front && !back && !wall.solid) continue;
    nearest = distance;
  }
  if (Math.abs(direction.z || 0) > 1e-9) for (const sector of state.sectors) {
    let distance = (sector.floorHeight - origin.z) / direction.z;
    if (distance > 1e-5 && distance < nearest && containsPoint(sector.rings, origin.x + direction.x * distance, origin.y + direction.y * distance)) nearest = distance;
    if (sector.sky) continue;
    distance = (sector.ceilingHeight - origin.z) / direction.z;
    if (distance > 1e-5 && distance < nearest && containsPoint(sector.rings, origin.x + direction.x * distance, origin.y + direction.y * distance)) nearest = distance;
  }
  return nearest;
}

test('a gridded geometry trace finds exactly what the exhaustive sweep finds', () => {
  const state = rooms();
  assert.ok(createTraceGrid(state.walls, state.sectors).oversizedSectors.some(sector => sector.id === 'outdoor'));
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let compared = 0;
  for (let iteration = 0; iteration < 600; iteration++) {
    const origin = { x: random() * 1900 - 50, y: random() * 1900 - 50, z: random() * 120 - 20 };
    const heading = random() * Math.PI * 2, pitch = random() * 1.2 - 0.6;
    const direction = { x: Math.cos(heading), y: Math.sin(heading), z: pitch };
    const length = Math.hypot(direction.x, direction.y, direction.z);
    direction.x /= length; direction.y /= length; direction.z /= length;
    for (const range of [48, 200, 700, 4096]) for (const movement of [false, true]) {
      assert.equal(geometryDistance(state, origin, direction, range, movement), referenceDistance(state, origin, direction, range, movement),
        `origin ${origin.x.toFixed(1)},${origin.y.toFixed(1)} range ${range} movement ${movement}`);
      compared++;
    }
  }
  assert.equal(compared, 4800);
});

test('a trace outside the level still sees every wall', () => {
  const state = rooms();
  const origin = { x: -3000, y: -3000, z: 40 };
  const target = { x: 800, y: 800, z: 40 };
  const dx = target.x - origin.x, dy = target.y - origin.y, dz = target.z - origin.z;
  const length = Math.hypot(dx, dy, dz);
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  assert.equal(geometryDistance(state, origin, direction, length + 1), referenceDistance(state, origin, direction, length + 1));
  assert.ok(geometryDistance(state, origin, direction, length + 1) < length, 'the wall between the origin and the target is reported');
});

test('the grid stores each wall only in the cells it touches and walks cells in order', () => {
  const { walls, sectors } = rooms();
  const grid = createTraceGrid(walls, sectors);
  assert.equal(grid.count, walls.length);
  assert.ok(grid.walls.length === grid.columns * grid.rows);
  const perCell = grid.walls.map(cell => cell.length);
  assert.ok(Math.max(...perCell) <= 8, `no cell should collect many walls, got ${Math.max(...perCell)}`);
  // A long wall is stored once per cell it crosses, and only in cells it crosses.
  for (let row = 0; row < grid.rows; row++) for (let column = 0; column < grid.columns; column++) {
    const x0 = grid.minX + column * grid.cellSize, y0 = grid.minY + row * grid.cellSize;
    for (const wall of grid.walls[row * grid.columns + column]) {
      const overlaps = Math.max(wall.start.x, wall.end.x) >= x0 && Math.min(wall.start.x, wall.end.x) <= x0 + grid.cellSize
        && Math.max(wall.start.y, wall.end.y) >= y0 && Math.min(wall.start.y, wall.end.y) <= y0 + grid.cellSize;
      assert.ok(overlaps, `${wall.id} is filed in a cell it does not reach`);
    }
  }
  assert.ok(perCell.reduce((sum, count) => sum + count, 0) <= walls.length * 4, 'walls are only repeated across the cells they cross');

  // A horizontal ray across the middle of the lattice crosses cells left to right.
  const visited = [];
  forEachCellAlong(grid, 10, 200, 1, 0, 2048, (bucket, cellSectors, exit) => { visited.push(exit); return false; });
  assert.ok(visited.length >= 4 && visited.length <= 20, `crossed ${visited.length} cells`);
  for (let index = 1; index < visited.length; index++) assert.ok(visited[index] > visited[index - 1], 'cells are visited in distance order');

  // Stopping early is what keeps a close hit cheap.
  let seen = 0;
  forEachCellAlong(grid, 10, 200, 1, 0, 2048, () => { seen++; return seen === 2; });
  assert.equal(seen, 2);

  // Sectors are filed alongside the walls, and the whole-lattice one is kept on the list
  // every trace consults rather than being copied into thousands of cells.
  assert.equal(grid.oversizedSectors.length, 1);
  const filed = new Set(grid.sectors.flat());
  assert.equal(filed.size, sectors.length - 1);
  assert.ok(!filed.has(grid.oversizedSectors[0]));

  // The same arrays always yield the same grid, and a rebuilt level a new one.
  const state = { walls, sectors };
  assert.equal(traceGrid(state), traceGrid(state));
  const rebuilt = rooms();
  assert.notEqual(traceGrid({ walls: rebuilt.walls, sectors: rebuilt.sectors }), traceGrid(state));
});
