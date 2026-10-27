import { eyePosition, viewDirection } from './gravity.js';
import { sectorAt } from './sectors.js';

/**
 * Where a spray aimed from the player's eyes lands on a wall, or null.
 *
 * The trace follows the full 3D look direction, so spraying while looking up or down
 * still lands on the wall under the crosshair, and the hit has to fall inside the
 * sector's floor/ceiling instead of passing over the wall into the room behind.
 * `angle` is the wall's own direction, which is how the decal is turned to lie flat
 * against it; `normal` points back towards the player.
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
    const sector = sectorAt(state.sectors, x, y) || sectorAt(state.sectors, eye[0], eye[1]);
    const floor = sector ? sector.floorHeight : -32768;
    const ceiling = sector ? Math.max(sector.ceilingHeight, floor + 1) : 32767;
    if (z < floor + 1 || z > ceiling - 1) continue;
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length, ny = dx / length;
    if (nx * direction[0] + ny * direction[1] > 0) { nx = -nx; ny = -ny; }
    best = { x, y, z, angle: Math.atan2(dy, dx), normal: [nx, ny], distance: along, wallId: wall.id };
  }
  return best;
}
