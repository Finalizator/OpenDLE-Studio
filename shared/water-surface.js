/**
 * The shape of a water surface.
 *
 * A water body drawn as one flat quad reads as a blue picture of water, however good the shader
 * on it is: nothing about it moves in the light, and nothing behind it moves either. So the top of
 * a water body is a **grid of vertices that rides the swells**, and the same swells are what the
 * shader shades and refracts the level through.
 *
 * The wave field lives here, in map units, and the shader carries the same three swells in its own
 * table — `waterShaderTemplate` in `shared/shaders.js`. That duplication is deliberate and pinned
 * by a test: the mesh has to be built in JavaScript and the normals have to be shaded in GLSL, so
 * the two have to agree on the numbers rather than on an abstraction neither can share.
 */

/** How far a surface rides the swells when nothing else is asked for. */
export const WAVE_DEFAULTS = Object.freeze({
  // Peak height of the biggest swell, in map units.
  height: 5,
  speed: 1,
  // How wide a grid cell is, in map units: the surface is subdivided to this, so a small pool is
  // not hundreds of pointless vertices and a large sea still has waves. It has to stay well under
  // the shortest *mesh* wavelength below, or the grid aliases into a moiré instead of a wave.
  cell: 16,
});

/**
 * A map unit is an inch, so this is the acceleration that decides how fast a swell travels:
 * `ω = sqrt(g · k)`, the dispersion relation deep water actually obeys.
 */
export const WAVE_GRAVITY = 981;

/**
 * The swells, in map units, as a wind sea at the scale of a room.
 *
 * Four waves: two carry the **mesh**, two only tilt the shading, because a ripple 14 units long
 * cannot be represented by a grid that is 16 units across — it would alias into a pattern that is
 * neither a wave nor a ripple. The two that move geometry are long enough for the grid to resolve.
 * Directions and wavelengths are incommensurate so the interference never settles into a weave.
 */
export const WATER_SWELLS = Object.freeze([
  Object.freeze({ direction: [1, 0.28], length: 96, amplitude: .55, shading: false }),
  Object.freeze({ direction: [-0.42, 1], length: 52, amplitude: .3, shading: false }),
  Object.freeze({ direction: [0.78, -0.62], length: 27, amplitude: .13, shading: true }),
  Object.freeze({ direction: [-0.9, -0.36], length: 14, amplitude: .07, shading: true }),
]);

/** How fast one swell travels, in radians per second: long waves are faster, as on real water. */
export function swellRate(length, speed = 1) {
  const k = (Math.PI * 2) / length;
  return Math.sqrt(WAVE_GRAVITY * k) * (Number(speed) || 1);
}

/**
 * The height of the water at a point of its own surface, in map units.
 *
 * `u` and `v` are the face's texture coordinates times the brush texture size (64), which is the
 * face's own world frame: the same numbers the shader reads out of its `uv`.
 */
export function waterHeight(u, v, time, waves = WAVE_DEFAULTS) {
  const height = Number(waves?.height ?? WAVE_DEFAULTS.height);
  const speed = Number(waves?.speed ?? WAVE_DEFAULTS.speed);
  if (!height || !speed) return 0;
  let sum = 0;
  for (const swell of WATER_SWELLS) {
    // Only the two long swells move the mesh; the short ones tilt the shading and nothing else.
    if (swell.shading) continue;
    const k = (Math.PI * 2) / swell.length;
    sum += swell.amplitude * Math.sin((u * swell.direction[0] + v * swell.direction[1]) * k - time * swellRate(swell.length, speed));
  }
  return sum * height;
}

/** The slope of the surface at that point, in map units of height per map unit across. */
export function waterSlope(u, v, time, waves = WAVE_DEFAULTS) {
  const height = Number(waves?.height ?? WAVE_DEFAULTS.height);
  const speed = Number(waves?.speed ?? WAVE_DEFAULTS.speed);
  if (!height || !speed) return [0, 0];
  let du = 0, dv = 0;
  for (const swell of WATER_SWELLS) {
    if (swell.shading) continue;
    const k = (Math.PI * 2) / swell.length;
    const slope = swell.amplitude * k * Math.cos((u * swell.direction[0] + v * swell.direction[1]) * k - time * swellRate(swell.length, speed)) * height;
    du += slope * swell.direction[0];
    dv += slope * swell.direction[1];
  }
  return [du, dv];
}

/** The texture size a brush face's UV is measured in, so `uv * 64` is the face's own frame. */
const FACE_UNITS = 64;

/**
 * One water face as a grid of vertices that can be animated.
 *
 * `points` are the face's corners in the view's own axes (x, y up, z) and `uvAt(point)` gives the
 * texture coordinate at each, in the same frame `brushFaceUv` uses. The polygon is fan-triangulated
 * and each triangle is split into an `n` by `n` barycentric grid: `n` is chosen per face from its
 * longest edge, and the same `n` on every triangle means the shared edges of the fan agree, so the
 * surface has no cracks when it moves.
 */
export function buildWaterSurface(points, { uvAt, water = WAVE_DEFAULTS } = {}) {
  const count = points?.length || 0;
  if (count < 3 || typeof uvAt !== 'function') return null;
  const cell = Math.max(8, Number(water?.cell ?? WAVE_DEFAULTS.cell));
  let longest = 0;
  for (const point of points) {
    for (const other of points) longest = Math.max(longest, Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]));
  }
  // One segment is a flat quad. The cap keeps a sea of a thousand units from filling a buffer, but
  // it has to stay above twice the shortest *mesh* swell (96 units) or a big pool draws its waves
  // as long flat facets: at 16-unit cells that is 48 segments across.
  const segments = Math.max(1, Math.min(48, Math.ceil(longest / cell)));
  const positions = [], uvs = [], index = [];
  const at = point => {
    const [u, v] = uvAt(point);
    return { position: point, uv: [u, v] };
  };
  const corner = points.map(at);
  const push = ({ position, uv }) => {
    const vertex = positions.length / 3;
    positions.push(position[0], position[1], position[2]);
    uvs.push(uv[0], uv[1]);
    return vertex;
  };
  for (let triangle = 1; triangle < count - 1; triangle++) {
    const a = corner[0], b = corner[triangle], c = corner[triangle + 1];
    const grid = [];
    for (let row = 0; row <= segments; row++) {
      grid.push([]);
      for (let column = 0; column <= segments - row; column++) {
        const beta = column / segments, gamma = row / segments, alpha = 1 - beta - gamma;
        const position = [
          a.position[0] * alpha + b.position[0] * beta + c.position[0] * gamma,
          a.position[1] * alpha + b.position[1] * beta + c.position[1] * gamma,
          a.position[2] * alpha + b.position[2] * beta + c.position[2] * gamma,
        ];
        const uv = [
          a.uv[0] * alpha + b.uv[0] * beta + c.uv[0] * gamma,
          a.uv[1] * alpha + b.uv[1] * beta + c.uv[1] * gamma,
        ];
        grid[row].push(push({ position, uv }));
      }
    }
    for (let row = 0; row < segments; row++) {
      for (let column = 0; column < segments - row; column++) {
        const here = grid[row][column], right = grid[row][column + 1];
        index.push(here, right, grid[row + 1][column]);
        if (column + 1 < segments - row) index.push(right, grid[row + 1][column + 1], grid[row + 1][column]);
      }
    }
  }
  return { positions, uvs, index };
}

/**
 * The animation state of one water mesh: where every vertex sits when the water is still, and the
 * frame it moves in.
 *
 * The direction is the face's own normal, so an up-facing surface rises and falls and the underside
 * of the same water body does the same on its own side of the volume.
 */
export function waterSurfaceData(positions, uvs, direction = [0, 1, 0], water = WAVE_DEFAULTS) {
  return {
    base: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    direction: [direction[0] || 0, direction[1] || 0, direction[2] || 0],
    // Kept by reference, not copied: these are the shader's own live dials, so turning the height
    // up in the water look window moves the mesh in the same frame the shading changes. A copy
    // would be a snapshot of the settings at build time, and the two would drift the moment a
    // mapper touched a slider.
    water: water || WAVE_DEFAULTS,
  };
}

/**
 * Moves a water mesh to where the water is at `time`.
 *
 * Only the position is written: the shading normal comes from the same field, analytically, in the
 * shader, so recomputing vertex normals every frame would cost a pass over the mesh and change
 * nothing that is drawn.
 */
export function animateWaterSurface(geometry, time) {
  const data = geometry?.userData?.waterSurface;
  if (!data) return false;
  const position = geometry.attributes?.position;
  if (!position) return false;
  const array = position.array;
  const { base, uvs, direction, water } = data;
  for (let vertex = 0; vertex < base.length / 3; vertex++) {
    const height = waterHeight(uvs[vertex * 2] * FACE_UNITS, uvs[vertex * 2 + 1] * FACE_UNITS, time, water);
    array[vertex * 3] = base[vertex * 3] + direction[0] * height;
    array[vertex * 3 + 1] = base[vertex * 3 + 1] + direction[1] * height;
    array[vertex * 3 + 2] = base[vertex * 3 + 2] + direction[2] * height;
  }
  position.needsUpdate = true;
  return true;
}
