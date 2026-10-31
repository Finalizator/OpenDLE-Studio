/**
 * ZDoom 3D floors, as a `Sector_Set3DFloor` (160) line describes them.
 *
 * The line's first argument tags the sectors that receive the floor, and the sector on the
 * line's front side is the *control* sector whose planes the floor copies. GZDoom's
 * `P_Add3DFloor` is the reference for which control plane becomes which surface: the
 * control sector's **floor** is the bottom of the 3D floor and its **ceiling** is the top,
 * which is why a mapper raises the control sector's ceiling to lift a platform. The line's
 * own sidedef supplies the edge texture — middle by default, upper with flag 16 and lower
 * with flag 32.
 */

export const THREE_D_FLOOR_SPECIAL = 160;

/**
 * Type bits, from `specials.cpp`: 0 is Vavoom's, 1 is solid, 2 is swimmable and 3 is
 * non-solid. Only a solid floor carries weight; the rest are surfaces you pass through.
 * Bit 8 is stripped before the type is read because GZDoom uses it to mark "thin floor".
 */
const TYPE_SOLID = 1;
const FLAG_NOSHADE = 1;
const FLAG_THINFLOOR = 8;
const FLAG_UPPERTEXTURE = 16;
const FLAG_LOWERTEXTURE = 32;

/** One 3D floor, ready to draw, or null when the line does not describe one. */
export function threeDFloorFromWall(wall, sectorsById) {
  if (!wall || wall.special !== THREE_D_FLOOR_SPECIAL) return null;
  const args = wall.args;
  // A Doom-format line has no argument bytes, so it cannot describe a 3D floor at all.
  if (!Array.isArray(args) || args.length < 2) return null;
  const tag = Number(args[0]) | 0;
  if (!tag) return null;
  const side = wall.right || wall.left;
  const control = side && sectorsById.get(side.sectorId);
  if (!control) return null;
  const type = (Number(args[1]) | 0) & ~FLAG_THINFLOOR;
  const flags = Number(args[2]) | 0;
  const given = Number(args[3]);
  const alpha = Number.isFinite(given) ? Math.max(0, Math.min(255, given)) : 255;
  const thin = Boolean(flags & FLAG_THINFLOOR);
  const sideTexture = flags & FLAG_UPPERTEXTURE ? side.upper
    : flags & FLAG_LOWERTEXTURE ? side.lower : side.middle;
  return {
    controlId: control.id,
    tag,
    type: type & 3,
    solid: (type & 3) === TYPE_SOLID,
    // `flat` is a lump name in the import and an asset id by the time this runs, so the
    // control sector's own material fields are copied rather than re-resolved.
    bottom: thin ? control.ceilingHeight : control.floorHeight,
    top: control.ceilingHeight,
    bottomFlat: thin ? control.ceilingAsset : control.floorAsset,
    topFlat: control.ceilingAsset,
    side: sideTexture || null,
    // `FF_NOSHADE` leaves the edge at full brightness; otherwise the control sector's
    // light is the one the floor is drawn with.
    light: flags & FLAG_NOSHADE ? 255 : control.light ?? 160,
    alpha,
  };
}

/**
 * Attach every `Sector_Set3DFloor` line of a map to the sectors it tags.
 *
 * The special is geometry, not an action: GZDoom zeroes it once the map is loaded, so it
 * cannot fire again at run time. The same is done here, which also keeps it out of the
 * "unknown line special" report.
 */
export function applyThreeDFloors(map) {
  const sectors = map?.sectors || [];
  if (!sectors.length || !map?.walls) return [];
  const byId = new Map(sectors.map(sector => [sector.id, sector]));
  const applied = [];
  for (const wall of map.walls) {
    const floor = threeDFloorFromWall(wall, byId);
    if (!floor) continue;
    let targets = 0;
    for (const sector of sectors) {
      if (sector.tag !== floor.tag) continue;
      (sector.threeDFloors ||= []).push({ ...floor });
      targets++;
    }
    if (!targets) continue;
    wall.special = 0;
    applied.push({ lineId: wall.id, tag: floor.tag, targets, floor });
  }
  // Lowest first, so a sector with stacked floors draws and collides from the ground up.
  for (const sector of sectors) sector.threeDFloors?.sort((a, b) => a.top - b.top);
  return applied;
}

/**
 * The floor an object at height `z` stands on.
 *
 * A solid 3D floor is a floor like any other: the highest one at or below the object wins,
 * and an object above them all rests on the highest. Objects with no height of their own
 * (`z` undefined) keep the sector's own floor, which is what the editor shows.
 */
export function floorHeightAt(sector, z) {
  const base = sector?.floorHeight ?? 0;
  const tops = (sector?.threeDFloors || []).filter(floor => floor.solid && floor.top > base).map(floor => floor.top);
  if (!tops.length || !Number.isFinite(z)) return base;
  let best = base;
  for (const height of tops) if (height <= z && height > best) best = height;
  return best;
}
