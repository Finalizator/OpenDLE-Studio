/**
 * GZDoom's light modes, as the numbers MAPINFO `lightmode` uses.
 *
 * Doom's own lighting is not linear: the software renderer picked one of 32 colormaps, so a
 * sector at light 128 came out at roughly a fifth of full brightness, and 0 was black. GZDoom
 * keeps that behaviour as a *mode*, and a mod's MAPINFO selects it per map — Lullaby sets
 * `lightmode = 2` on every one of its maps, which is the difference between "dark room" and
 * "black rectangle".
 */
export const LIGHT_MODES = { standard: 0, bright: 1, doom: 2, dark: 3, legacy: 4, software: 8 };

/** Modes that use Doom's crushed brightness curve. */
const DARK_MODES = new Set([2, 3, 4, 8]);

/**
 * `CalcLightLevel` from GZDoom's hw_lighting.cpp: the light a surface is drawn with.
 *
 * `relative` is the surface's own light offset (a wall's +16 from fake contrast, for example).
 */
export function surfaceLight(lightLevel, mode = 0, relative = 0) {
  const level = Number.isFinite(lightLevel) ? lightLevel : 0;
  if (level <= 0) return 0;
  let light;
  if (DARK_MODES.has(mode) && level < 192) {
    if (level > 100) {
      light = Math.round(192 - (192 - level) * 1.87);
      if (light + relative < 20) light = 20 + (light + relative - 20) / 5;
      else light += relative;
    } else light = (level + relative) / 5;
  } else light = level + relative;
  return Math.max(1, Math.min(255, light));
}

/** The brightness a renderer multiplies a surface's colour by, from that light. */
export function surfaceBrightness(lightLevel, mode = 0, relative = 0) {
  return Math.max(.03, surfaceLight(lightLevel, mode, relative) / 255);
}
