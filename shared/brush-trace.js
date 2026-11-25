/**
 * The ray test a brush trace uses.
 *
 * This module deliberately imports nothing: `geometryDistance` is on the path every actor and
 * every weapon takes, and the modules it lives among already form an import cycle through
 * `project.js`. `brushVolumes`, which needs the brush geometry, lives in `shared/brushes.js` and
 * is called once by `createRuntime`.
 */

/**
 * How far along a ray a volume begins, or `Infinity` when the ray misses it.
 *
 * This is the ray clipped against every half-space at once: each plane either bounds where the ray
 * goes in or where it comes out, and a brush is hit when the way in is still before the way out.
 * A trace that starts inside a brush answers `Infinity` rather than zero — the same choice the wall
 * trace makes, because a thing standing in a wall must still be able to see, shoot and step out of
 * it, and answering zero would freeze it there.
 */
export function volumeDistance(volume, origin, direction, limit) {
  const { planes } = volume;
  // A caller that only knows the horizontal direction (the monster step search builds its eight
  // from cos/sin alone) leaves `z` undefined, and a plane with a vertical normal would then make
  // every comparison NaN and the brush unhittable.
  const dx = direction.x, dy = direction.y, dz = direction.z || 0;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  let enter = 0, exit = limit;
  for (let index = 0; index < planes.length; index += 4) {
    const nx = planes[index], ny = planes[index + 1], nz = planes[index + 2], distance = planes[index + 3];
    const denominator = nx * dx + ny * dy + nz * dz;
    const offset = distance - (nx * ox + ny * oy + nz * oz);
    if (Math.abs(denominator) < 1e-9) {
      // Parallel to the plane: either the whole ray is inside that half-space or none of it is.
      if (offset < 0) return Infinity;
      continue;
    }
    const crossing = offset / denominator;
    if (denominator < 0) { if (crossing > enter) enter = crossing; }
    else if (crossing < exit) exit = crossing;
    if (enter > exit) return Infinity;
  }
  return enter > 1e-5 && enter < exit ? enter : Infinity;
}
