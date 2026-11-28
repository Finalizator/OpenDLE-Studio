/**
 * The water surface's fine detail, as a texture.
 *
 * Both water shaders the engine ships are ports of shaders that read their small-scale ripples from
 * a texture rather than computing them per pixel: the pool's is a ripple-simulation target, the sea's
 * is an FFT spectrum. Neither exists here, but *what they hold* is the same thing — a height field
 * and its slope, tiled — and a surface effect can be handed a texture like any other.
 *
 * The texels are laid out the way those shaders read them, so their own sampling code works
 * unchanged: **R is the height, G and B are the slope in x and z, A is the slope variance**. The
 * field is a sum of waves whose wavenumbers are whole numbers across the tile, which makes it tile
 * exactly: what the shader scrolls and repeats has no seam, because there is nothing at the edge
 * that is not also at the other edge.
 */

/** Side length of the generated texture. 256 is what the pool's simulation used. */
export const SPECTRUM_SIZE = 256;

/** A small deterministic generator, so every machine and every build gets the same sea. */
function random(seed, step) {
  return ((seed >>> step) % 9973) / 9973;
}

/**
 * One wave in the spectrum: a whole number of wavelengths across the tile in each axis, a direction,
 * an amplitude and a phase. Whole numbers are what make the tile seamless.
 */
function wave(index) {
  const seed = (index * 2654435761) >>> 0;
  const across = 1 + Math.floor(random(seed, 3) * 11);
  const along = 1 + Math.floor(random(seed, 7) * 11);
  const turn = random(seed, 11) * Math.PI * 2;
  const length = Math.hypot(across, along) || 1;
  return {
    // Whole numbers, always: a half wavelength across the tile is a seam, and a seam in a texture the
    // shader scrolls is a visible line of damage travelling across the water.
    kx: Math.round(across * Math.cos(turn) + (random(seed, 13) - .5)),
    kz: Math.round(along * Math.sin(turn) + (random(seed, 17) - .5)),
    // Long waves carry more height and less slope, as gravity waves do.
    amplitude: 1 / Math.pow(length, 1.35),
    phase: random(seed, 19) * Math.PI * 2,
  };
}

/**
 * The waves that make the texture. Twenty at unrelated directions is enough that no two crests line
 * up into a visible ridge — which is the whole reason a texture beats two sine families.
 */
export const SPECTRUM_WAVES = Object.freeze(Array.from({ length: 20 }, (_, index) => wave(index)));

const TAU = Math.PI * 2;

/** The height, its slope in x and z, and the slope variance at one point of the tile. */
export function spectrumAt(u, v, waves = SPECTRUM_WAVES) {
  let height = 0, slopeX = 0, slopeZ = 0, variance = 0;
  for (const wave of waves) {
    const phase = TAU * (wave.kx * u + wave.kz * v) + wave.phase;
    const swing = Math.cos(phase);
    height += wave.amplitude * Math.sin(phase);
    slopeX += wave.amplitude * TAU * wave.kx * swing;
    slopeZ += wave.amplitude * TAU * wave.kz * swing;
    variance += (wave.amplitude * TAU * Math.hypot(wave.kx, wave.kz)) ** 2 * .5;
  }
  return [height, slopeX, slopeZ, variance];
}

/**
 * The texture itself: RGBA floats, tileable, normalised so a shader can turn the slopes into a
 * normal without further scaling.
 */
export function buildWaterSpectrum(size = SPECTRUM_SIZE) {
  const data = new Float32Array(size * size * 4);
  let tallest = 0, steepest = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const [height, slopeX, slopeZ, variance] = spectrumAt(column / size, row / size);
      tallest = Math.max(tallest, Math.abs(height));
      steepest = Math.max(steepest, Math.abs(slopeX), Math.abs(slopeZ));
      const at = (row * size + column) * 4;
      data[at] = height;
      data[at + 1] = slopeX;
      data[at + 2] = slopeZ;
      data[at + 3] = variance;
    }
  }
  const heightScale = tallest > 0 ? .5 / tallest : 1;
  const slopeScale = steepest > 0 ? .35 / steepest : 1;
  // The variance channel is the slope variance, and the shaders use it to widen their glint lobe.
  // Its absolute size is a property of the sea being described, so the channel is normalised to a
  // mean of 0.004 — a plausible open-water slope variance — rather than left at whatever twenty
  // waves happen to sum to.
  let varianceTotal = 0;
  for (let at = 0; at < data.length; at += 4) varianceTotal += data[at + 3] * slopeScale * slopeScale;
  const varianceMean = varianceTotal / (data.length / 4);
  const varianceScale = varianceMean > 0 ? .004 / varianceMean : 1;
  for (let at = 0; at < data.length; at += 4) {
    data[at] *= heightScale;
    data[at + 1] *= slopeScale;
    data[at + 2] *= slopeScale;
    // The variance has to travel with the slopes it describes, or the glint lobe it widens is off by
    // the square of the normalisation.
    data[at + 3] *= slopeScale * slopeScale * varianceScale;
  }
  return { size, data };
}
