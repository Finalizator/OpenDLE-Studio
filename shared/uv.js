/**
 * Texture coordinates for map surfaces.
 *
 * Doom stretches one texel over one map unit on walls, and one 64x64 flat over 64
 * units. `scale` is the per-surface pixel-density control: 2 covers twice the map
 * distance with the same artwork (larger texels), 0.5 twice as fine.
 */

/** UVs for one wall quad: bottom-left, bottom-right, top-right, top-left. */
export function wallQuadUv({ length, bottom, top, referenceTop, offsetX = 0, offsetY = 0,
  textureWidth = 64, textureHeight = 64, scale = 1, flip = false }) {
  const tw = textureWidth * scale, th = textureHeight * scale;
  const u0 = offsetX / tw, u1 = (offsetX + length) / tw;
  const v0 = 1 - (referenceTop - bottom + offsetY) / th;
  const v1 = 1 - (referenceTop - top + offsetY) / th;
  // A back sidedef is drawn with its two ends swapped so the face points into the back
  // sector; Doom still runs U from the linedef's start to its end on *both* sides, so the
  // back reads mirrored rather than repeating the front's artwork.
  return flip ? [u1, v0, u0, v0, u0, v1, u1, v1] : [u0, v0, u1, v0, u1, v1, u0, v1];
}

/** UV for a point on a floor or ceiling plane. */
export function flatUv(x, y, { textureWidth = 64, textureHeight = 64, scale = 1 } = {}) {
  return [x / (textureWidth * scale), y / (textureHeight * scale)];
}
