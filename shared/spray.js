import { eyePosition, viewDirection } from './gravity.js';
import { sectorAt } from './sectors.js';

/**
 * Where a spray aimed from the player's eyes lands on a wall, or null.
 *
 * The trace follows the full 3D look direction, so spraying while looking up or down
 * still lands on the wall under the crosshair, and the hit has to fall inside the
 * sector's floor/ceiling instead of passing over the wall into the room behind.
 * Besides the hit point it returns the wall it hit (`start`/`end`/`length` and the
 * `along` distance from `start`) plus the face's floor and ceiling, which is what
 * `clipDecalToFace` needs to keep the artwork on that wall; `normal` points back
 * towards the player.
 */
export function sprayTarget(state, distance = 96) {
  const player = state.player;
  const feet = Number.isFinite(player?.z) ? player.z
    : sectorAt(state.sectors, player?.x ?? 0, player?.y ?? 0)?.floorHeight ?? 0;
  const eye = eyePosition(player, feet);
  const direction = viewDirection(player);
  if (!(Math.hypot(direction[0], direction[1]) > 1e-6)) return null;
  let best = null;
  for (const wall of state.walls || []) {
    if (!wall.solid) continue;
    const ax = wall.start.x, ay = wall.start.y;
    const dx = wall.end.x - ax, dy = wall.end.y - ay;
    const cross = direction[0] * dy - direction[1] * dx;
    if (Math.abs(cross) < 1e-9) continue;
    const qx = ax - eye[0], qy = ay - eye[1];
    const along = (qx * dy - qy * dx) / cross;
    const u = (qx * direction[1] - qy * direction[0]) / cross;
    if (!(along > .5) || along > distance || u < 0 || u > 1) continue;
    if (best && along >= best.distance) continue;
    const x = eye[0] + direction[0] * along, y = eye[1] + direction[1] * along;
    const z = eye[2] + direction[2] * along;
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length, ny = dx / length;
    if (nx * direction[0] + ny * direction[1] > 0) { nx = -nx; ny = -ny; }
    // Sample just in front of the wall: the hit itself lies on the line between two
    // sectors, and the decal belongs to the side the player is standing on.
    const sector = sectorAt(state.sectors, x + nx, y + ny) || sectorAt(state.sectors, x, y)
      || sectorAt(state.sectors, eye[0], eye[1]);
    const floor = sector ? sector.floorHeight : -32768;
    const ceiling = sector ? Math.max(sector.ceilingHeight, floor + 1) : 32767;
    if (z < floor + 1 || z > ceiling - 1) continue;
    best = { x, y, z, normal: [nx, ny], distance: along,
      start: { x: ax, y: ay }, end: { x: wall.end.x, y: wall.end.y }, length,
      along: Math.hypot(x - ax, y - ay), floor, ceiling };
  }
  return best;
}

const DECAL_GAP = .5;

/**
 * The decal rectangle clipped to the wall face it was painted on.
 *
 * A spray is a rectangle in the wall's own plane: `along` runs from the wall's start,
 * `z` is height. Anything past the wall's ends, or above the ceiling and below the
 * floor, is cut away and the texture coordinates are cropped to match, so the artwork
 * never spills past the wall into the room — which a plain unclipped quad did.
 *
 * Returns `{ corners, uv, normal, cropped }` with the four world corners (bottom-left,
 * bottom-right, top-right, top-left) and their texture coordinates, or null when the
 * wall is too narrow or too short to show any of it.
 */
export function clipDecalToFace(target, { width, height }) {
  if (!target || !(width > 0) || !(height > 0)) return null;
  const { start, end, length, along, z, floor, ceiling, normal } = target;
  if (!(length > 0) || !start || !end || !normal) return null;
  const left = along - width / 2, right = along + width / 2;
  const bottom = z - height / 2, top = z + height / 2;
  const u0 = Math.max(0, left), u1 = Math.min(length, right);
  const v0 = Math.max(floor, bottom), v1 = Math.min(ceiling, top);
  if (u1 - u0 < .5 || v1 - v0 < .5) return null;
  const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length;
  const at = (alongWall, height_, gap) => [
    start.x + dx * alongWall + normal[0] * gap,
    start.y + dy * alongWall + normal[1] * gap,
    height_,
  ];
  return {
    normal: [normal[0], normal[1]],
    corners: [at(u0, v0, DECAL_GAP), at(u1, v0, DECAL_GAP), at(u1, v1, DECAL_GAP), at(u0, v1, DECAL_GAP)],
    // Crop the artwork instead of squeezing it into the space that is left.
    uv: [(u0 - left) / width, (v0 - bottom) / height,
      (u1 - left) / width, (v0 - bottom) / height,
      (u1 - left) / width, (v1 - bottom) / height,
      (u0 - left) / width, (v1 - bottom) / height],
    cropped: u0 > left + 1e-6 || u1 < right - 1e-6 || v0 > bottom + 1e-6 || v1 < top - 1e-6,
  };
}
