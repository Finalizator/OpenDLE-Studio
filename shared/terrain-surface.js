import { modelAssetTriangles } from './model-geometry.js';

/**
 * The walkable surface of a model.
 *
 * A terrain leaves the Terrain tab as a model asset on an object, and nothing about it is a
 * sector — so every ground query in the engine answered with the *sector* floor. The player, whose
 * movement is a physics capsule, walked on the model if it was solid; a monster, whose height came
 * from `floorAt`, stood inside the hill it was looking at, and a pickup placed on a slope could not
 * be reached because the reach test puts the item on the sector's floor.
 *
 * This module turns the triangles of a solid model into a height lookup: one grid over the model's
 * footprint, with the triangles that fall in each cell. It is built once per level from the same
 * mesh the renderer draws, so the surface the engine walks on is the surface the person can see.
 *
 * Only triangles count. A model with collision left on the box it would fall back to is a shape
 * without a surface of its own, and pretending otherwise would put monsters in mid-air.
 */

/** How much of the model's own space one map unit is along each axis, as the renderer scales it. */
const MODEL_UNIT = 32;

const cellSize = 16;

/** A centroid-bucketed index of triangles, so a vertical query touches a handful of them. */
function indexTriangles(positions, indices, { offsetX, offsetY, scale }) {
  const triangles = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxHeight = -Infinity;
  for (let at = 0; at + 8 < positions.length; at += 9) {
    // The model is Y-up; the map is Z-up, which is the same swap the renderer and the physics
    // collider make (`y` becomes height, `z` becomes map depth).
    const x0 = positions[at] * scale + offsetX, y0 = positions[at + 2] * scale + offsetY, h0 = positions[at + 1] * scale;
    const x1 = positions[at + 3] * scale + offsetX, y1 = positions[at + 5] * scale + offsetY, h1 = positions[at + 4] * scale;
    const x2 = positions[at + 6] * scale + offsetX, y2 = positions[at + 8] * scale + offsetY, h2 = positions[at + 7] * scale;
    minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
    minY = Math.min(minY, y0, y1, y2); maxY = Math.max(maxY, y0, y1, y2);
    maxHeight = Math.max(maxHeight, h0, h1, h2);
    triangles.push({ x0, y0, h0, x1, y1, h1, x2, y2, h2 });
  }
  if (!triangles.length || !Number.isFinite(minX)) return null;
  const columns = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells = new Map();
  const cell = (column, row) => {
    const key = row * columns + column;
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, bucket = []);
    return bucket;
  };
  for (const triangle of triangles) {
    const fromColumn = Math.max(0, Math.floor((Math.min(triangle.x0, triangle.x1, triangle.x2) - minX) / cellSize));
    const toColumn = Math.min(columns - 1, Math.floor((Math.max(triangle.x0, triangle.x1, triangle.x2) - minX) / cellSize));
    const fromRow = Math.max(0, Math.floor((Math.min(triangle.y0, triangle.y1, triangle.y2) - minY) / cellSize));
    const toRow = Math.min(rows - 1, Math.floor((Math.max(triangle.y0, triangle.y1, triangle.y2) - minY) / cellSize));
    for (let row = fromRow; row <= toRow; row++) for (let column = fromColumn; column <= toColumn; column++) cell(column, row).push(triangle);
  }
  return { minX, maxX, minY, maxY, maxHeight, columns, rows, cells, triangles: triangles.length, indices };
}

/** The height where a vertical line through (x, y) meets one triangle, or null. */
function heightOn(triangle, x, y) {
  const { x0, y0, h0, x1, y1, h1, x2, y2, h2 } = triangle;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return null;
  const a = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area;
  const b = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area;
  const c = 1 - a - b;
  // A hair of tolerance: a point exactly on an edge or a vertex belongs to the surface, and
  // refusing it leaves a one-unit hole in the ground that a monster can fall into.
  if (a < -1e-6 || b < -1e-6 || c < -1e-6) return null;
  return a * h0 + b * h1 + c * h2;
}

/**
 * The ground of every solid model in the level.
 *
 * Returns null when there is nothing to walk on, so the hot paths can ask once and then forget.
 * `heightAt(x, y)` answers the highest surface over a point, or null where no model covers it.
 */
export function createTerrainSurface(project, cache) {
  const surfaces = [];
  for (const entity of project?.map?.entities || []) {
    const physics = entity.physics;
    if (!entity.modelAsset || !physics || physics.body === 'none' || physics.shape !== 'model') continue;
    // A hull collider is a solid approximation, not a surface: its triangles do not describe the
    // top of anything, and using them would float monsters over a box that is drawn differently.
    if (physics.modelCollision !== 'trimesh') continue;
    const asset = (project.assets || []).find(item => item.id === entity.modelAsset);
    if (!asset) continue;
    const triangles = modelAssetTriangles(asset, cache);
    if (!triangles) continue;
    const scale = (Number(entity.modelScale) || MODEL_UNIT) / MODEL_UNIT;
    const index = indexTriangles(triangles.positions, triangles.indices, { offsetX: entity.x || 0, offsetY: entity.y || 0, scale });
    if (index) surfaces.push({ entity, index });
  }
  if (!surfaces.length) return null;
  // The tallest point of the whole set: a trace that never goes below it cannot meet a hill, and
  // that is the check that keeps the extra work out of a level that has terrain but is not being
  // shot across.
  let maxHeight = -Infinity;
  for (const { index } of surfaces) maxHeight = Math.max(maxHeight, index.maxHeight ?? -Infinity);
  return {
    count: surfaces.length,
    maxHeight,
    /** The highest model surface over a map point, or null where no model stands. */
    heightAt(x, y) {
      let highest = null;
      for (const { index } of surfaces) {
        if (x < index.minX || x > index.maxX || y < index.minY || y > index.maxY) continue;
        const column = Math.min(index.columns - 1, Math.max(0, Math.floor((x - index.minX) / cellSize)));
        const row = Math.min(index.rows - 1, Math.max(0, Math.floor((y - index.minY) / cellSize)));
        for (const triangle of index.cells.get(row * index.columns + column) || []) {
          const height = heightOn(triangle, x, y);
          if (height !== null && (highest === null || height > highest)) highest = height;
        }
      }
      return highest;
    },
  };
}

/**
 * The object an exported terrain becomes in a level.
 *
 * It used to be a plain decoration carrying a model asset, which is invisible to the physics world:
 * the player walked through it and nothing stood on it. The same metadata that makes it walkable —
 * a fixed body with the model's own triangles — is what the height lookup above reads, so the
 * collider and the walking surface can never disagree.
 *
 * `bounds` comes from the mesh; the numbers are only used for the fallback box and for what the
 * editor draws as the object's size, since the triangles themselves are the collider.
 */
export function terrainEntity({ id, name, assetId, x = 0, y = 0, angle = 0, bounds }) {
  const width = Math.max(1, Math.round(bounds?.width ?? 1024));
  const depth = Math.max(1, Math.round(bounds?.depth ?? 1024));
  const height = Math.max(1, Math.round(bounds?.height ?? 256));
  // The radius is what the editor draws a selection by and what the fallback box uses; a model
  // whose triangles cannot be read is still a solid the size of its numbers.
  const radius = Math.max(4, Math.round(Math.min(width, depth) / 2));
  return {
    id, name, type: 'decoration', x, y, angle, modelAsset: assetId,
    physics: { body: 'fixed', shape: 'model', modelCollision: 'trimesh', width, height, depth, radius,
      mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true },
  };
}

/** The box a model occupies on the map, from its triangles and the object's own offset. */
export function modelBounds(triangles, { scale = 1, x = 0, y = 0 } = {}) {
  if (!triangles?.positions?.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = 0, maxZ = -Infinity;
  for (let at = 0; at + 2 < triangles.positions.length; at += 3) {
    const px = triangles.positions[at] * scale + x, py = triangles.positions[at + 2] * scale + y, pz = triangles.positions[at + 1] * scale;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  return { x: minX, y: minY, z: minZ, width: maxX - minX, depth: maxY - minY, height: maxZ - minZ };
}
