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
  height: 8,
  speed: 1,
  // How wide a grid cell is, in map units: the surface is subdivided to this, so a small pool is
  // not hundreds of pointless vertices and a large sea still has waves.
  cell: 40,
});

/**
 * The swells, in map units.
 *
 * Three directions at incommensurate angles and wavelengths. Two would read as a corrugation and
 * four cost more than they add; at these ratios the interference is irregular enough that a
 * displaced surface does not look woven.
 */
export const WATER_SWELLS = Object.freeze([
  Object.freeze({ direction: [1, 0.32], length: 140, amplitude: .55, rate: .7 }),
  Object.freeze({ direction: [-0.45, 1], length: 87, amplitude: .3, rate: .95 }),
  Object.freeze({ direction: [0.75, -0.68], length: 53, amplitude: .15, rate: 1.3 }),
]);

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
    const k = (Math.PI * 2) / swell.length;
    sum += swell.amplitude * Math.sin((u * swell.direction[0] + v * swell.direction[1]) * k - time * swell.rate * speed);
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
    const k = (Math.PI * 2) / swell.length;
    const slope = swell.amplitude * k * Math.cos((u * swell.direction[0] + v * swell.direction[1]) * k - time * swell.rate * speed) * height;
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
  // One segment is a flat quad; beyond sixteen, a pool gets more triangles than it has pixels.
  const segments = Math.max(1, Math.min(16, Math.ceil(longest / cell)));
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
    water: { height: Number(water?.height ?? WAVE_DEFAULTS.height), speed: Number(water?.speed ?? WAVE_DEFAULTS.speed) },
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
