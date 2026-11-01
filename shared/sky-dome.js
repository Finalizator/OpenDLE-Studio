// How a Doom sky picture is laid onto the sky dome.
//
// GZDoom builds a dome `10000` units across and `60` degrees tall (`SkyVertexDoom` in
// `hw_skydome.cpp`, `maxSideAngle = 60`), and then decides where the picture sits on it in
// `FSkyVertexBuffer::SetupMatrices`. That function has five branches by picture height, and a
// 128-row picture — every stock Doom sky, `SKY1` included — takes the `texh < 200` one: the dome
// is pushed **1250 units down** and squashed to `texh / 230`. Reading such a sky with the
// `200..240` branch instead (which the studio did, because that branch was the only one written)
// lifted the picture by 4100 units and stretched it, so the horizon sampled the bottom row while
// everything above it sampled the picture's dark upper band — the flat black sky seen through
// windows — and the mountains never appeared at all.
//
// The mapping is the same ellipsoid either way: a ray at elevation `e` meets the dome where
// `tan(e) = (scale * sin(a) + shift) / cos(a)`, so the dome angle `a` is
// `atan2(tan(e), scale) - asin(shift / hypot(tan(e), scale))` and the picture row follows from
// `a`. `shift` is the translate in the same units as `scale`, i.e. dome units over `10000`.

export const SKY_DOME_SCALE = 10000;
/** `maxSideAngle` — the dome is 60 degrees from horizon to zenith. */
export const SKY_DOME_DEGREES = 60;
/** `skyoffsetfactor` in `hw_skydome.cpp`. */
const SKY_OFFSET_FACTOR = 57;
const SMALL_SKY_SCALE = 1.2 * 1.17;

/**
 * `FSkyVertexBuffer::SetupMatrices`, for the y-scale the map did not provide.
 *
 * `tiled` is GZDoom's `LEVEL_FORCETILEDSKY`; a normal Doom level leaves it off, so a 128-row sky
 * takes the `texh < 200` branch. `offset` is the map's sky offset in rows (`texskyoffset`).
 */
export function skyDomeMapping(rows, { tiled = false, offset = 0 } = {}) {
  const height = Math.max(1, Number(rows) || 240);
  // Every translate is in sky model units, which are the dome's own (`scale` above): /10000.
  const shift = amount => amount / SKY_DOME_SCALE;
  switch (true) {
    case height <= 128 && tiled:
      return { scale: SMALL_SKY_SCALE, shift: shift((-40 + offset) * SKY_OFFSET_FACTOR), textureScale: 240 / height };
    case height < 128:
      return { scale: 128 / 230, shift: shift(-1250), textureScale: Math.floor(128 / height) };
    case height < 200:
      return { scale: height / 230, shift: shift(-1250), textureScale: 1 };
    case height <= 240:
      return { scale: 1 + ((height - 200) / 200) * 1.17,
        shift: shift((200 - height + offset) * SKY_OFFSET_FACTOR), textureScale: 1 };
    default:
      return { scale: SMALL_SKY_SCALE, shift: shift((-40 + offset) * SKY_OFFSET_FACTOR), textureScale: 240 / height };
  }
}

const degrees = value => value * Math.PI / 180;

/**
 * The dome angle a view elevation lands on, in degrees above the horizon.
 *
 * A view that looks up past the top of the dome clamps to it, exactly as the sketch of the dome
 * does: there is no geometry beyond 60 degrees.
 */
export function skyDomeAngle(rows, elevationDegrees, options = {}) {
  const { scale, shift: offset } = skyDomeMapping(rows, options);
  const slope = Math.tan(degrees(Number(elevationDegrees) || 0));
  const radius = Math.hypot(slope, scale);
  const angle = Math.atan2(slope, scale) - Math.asin(Math.max(-1, Math.min(1, offset / radius)));
  return Math.max(0, Math.min(degrees(SKY_DOME_DEGREES), angle)) * 180 / Math.PI;
}

/**
 * The picture's V coordinate (0 at the top row, 1 at the bottom) for a view elevation.
 *
 * A picture shorter than the dome covers (`textureScale` above 1) repeats, which is GZDoom's
 * `CLAMP_NONE` on the sky material: the top of a short sky wraps back in above the mountains.
 */
export function skyDomeV(rows, elevationDegrees, options = {}) {
  const { textureScale } = skyDomeMapping(rows, options);
  const raw = (1 - skyDomeAngle(rows, elevationDegrees, options) / SKY_DOME_DEGREES) * textureScale;
  if (textureScale === 1) return Math.max(.001, Math.min(.999, raw));
  return Math.max(.001, Math.min(.999, raw - Math.floor(raw)));
}
