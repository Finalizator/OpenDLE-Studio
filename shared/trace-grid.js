/**
 * A uniform grid over a level's walls and sectors, for ray traces.
 *
 * A sight check or a bullet trace used to test every wall in the level: on an imported
 * campaign level that is 55,000 segments per trace, and a firefight asks for thousands of
 * traces a second, so each shot stalled the frame. The floor and ceiling planes were just
 * as bad — every trace that was not perfectly level walked all 13,000 sectors, and since a
 * long trace only prunes the far planes, it was worst exactly when it mattered.
 *
 * This buckets both into fixed cells and walks only the cells a ray actually crosses, which
 * is how Doom's blockmap does it. A sector whose bounding box would fill too many cells is
 * kept on a list that every trace consults instead of being duplicated across the map.
 *
 * The grid is derived from the wall array and cached against it; a rebuilt level gets a
 * fresh array and therefore a fresh grid.
 */

const CELL = 128;
const MAX_COLUMNS = 512;
const MAX_SECTOR_CELLS = 64;

const grids = new WeakMap();

export function traceGrid(state) {
  const walls = state.walls || [];
  const sectors = state.sectors || [];
  const cached = grids.get(walls);
  if (cached && cached.count === walls.length && cached.first === walls[0] && cached.last === walls[walls.length - 1]
    && cached.sectorCount === sectors.length && cached.sectorFirst === sectors[0]) return cached;
  const grid = createTraceGrid(walls, sectors);
  grids.set(walls, grid);
  return grid;
}

export function createTraceGrid(walls, sectors = []) {
  const count = walls.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const wall of walls) { grow(wall.start.x, wall.start.y); grow(wall.end.x, wall.end.y); }
  for (const sector of sectors) {
    const b = sector.bounds;
    if (!b) continue;
    grow(b.minX, b.minY); grow(b.maxX, b.maxY);
  }
  const usable = Number.isFinite(minX) && maxX > minX && maxY > minY;
  // A level that spans more than MAX_COLUMNS cells gets coarser cells rather than a
  // grid too large to walk; 512 x 512 buckets is already far more than a blockmap.
  const cellSize = usable ? Math.max(CELL, Math.ceil(Math.max(maxX - minX, maxY - minY) / MAX_COLUMNS)) : CELL;
  const columns = usable ? Math.ceil((maxX - minX) / cellSize) + 1 : 1;
  const rows = usable ? Math.ceil((maxY - minY) / cellSize) + 1 : 1;
  const wallCells = Array.from({ length: columns * rows }, () => []);
  const sectorCells = Array.from({ length: columns * rows }, () => []);
  for (let index = 0; index < count; index++) {
    const wall = walls[index];
    const x0 = Math.min(wall.start.x, wall.end.x), x1 = Math.max(wall.start.x, wall.end.x);
    const y0 = Math.min(wall.start.y, wall.end.y), y1 = Math.max(wall.start.y, wall.end.y);
    const column0 = clampCell((x0 - minX) / cellSize, columns), column1 = clampCell((x1 - minX) / cellSize, columns);
    const row0 = clampCell((y0 - minY) / cellSize, rows), row1 = clampCell((y1 - minY) / cellSize, rows);
    for (let row = row0; row <= row1; row++) for (let column = column0; column <= column1; column++) wallCells[row * columns + column].push(wall);
  }
  const oversizedSectors = [];
  for (const sector of sectors) {
    const b = sector.bounds;
    if (!b) { oversizedSectors.push(sector); continue; }
    const column0 = clampCell((b.minX - minX) / cellSize, columns), column1 = clampCell((b.maxX - minX) / cellSize, columns);
    const row0 = clampCell((b.minY - minY) / cellSize, rows), row1 = clampCell((b.maxY - minY) / cellSize, rows);
    if ((column1 - column0 + 1) * (row1 - row0 + 1) > MAX_SECTOR_CELLS) { oversizedSectors.push(sector); continue; }
    for (let row = row0; row <= row1; row++) for (let column = column0; column <= column1; column++) sectorCells[row * columns + column].push(sector);
  }
  return {
    cellSize, minX, minY, maxX, maxY, columns, rows, walls: wallCells, sectors: sectorCells, oversizedSectors,
    count, first: walls[0], last: walls[count - 1], sectorCount: sectors.length, sectorFirst: sectors[0],
  };
}

function clampCell(value, length) {
  const cell = Math.floor(value);
  return !Number.isFinite(cell) || cell < 0 ? 0 : cell >= length ? length - 1 : cell;
}

/**
 * Walks the cells a ray crosses, nearest first.
 *
 * `visit(walls, sectors, exit)` is handed the contents of one cell and the distance at
 * which the ray leaves it; returning true stops the walk. A wall or sector is stored in
 * every cell its bounding box touches, so anything hit inside a visited cell is tested.
 */
export function forEachCellAlong(grid, originX, originY, directionX, directionY, range, visit) {
  let column = clampCell((originX - grid.minX) / grid.cellSize, grid.columns);
  let row = clampCell((originY - grid.minY) / grid.cellSize, grid.rows);
  const stepX = directionX > 0 ? 1 : directionX < 0 ? -1 : 0;
  const stepY = directionY > 0 ? 1 : directionY < 0 ? -1 : 0;
  const cellSize = grid.cellSize;
  let tMaxX = stepX ? ((column + (stepX > 0 ? 1 : 0)) * cellSize + grid.minX - originX) / directionX : Infinity;
  let tMaxY = stepY ? ((row + (stepY > 0 ? 1 : 0)) * cellSize + grid.minY - originY) / directionY : Infinity;
  const tDeltaX = stepX ? cellSize / Math.abs(directionX) : Infinity;
  const tDeltaY = stepY ? cellSize / Math.abs(directionY) : Infinity;
  for (;;) {
    const exit = Math.min(tMaxX, tMaxY);
    const index = row * grid.columns + column;
    const walls = grid.walls[index], sectors = grid.sectors[index];
    if ((walls.length || sectors.length) && visit(walls, sectors, exit)) return;
    if (!(exit <= range)) return;
    if (tMaxX <= tMaxY) {
      column += stepX;
      tMaxX += tDeltaX;
      if (column < 0 || column >= grid.columns) return;
    } else {
      row += stepY;
      tMaxY += tDeltaY;
      if (row < 0 || row >= grid.rows) return;
    }
  }
}
