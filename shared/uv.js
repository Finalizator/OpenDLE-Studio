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

// ---------------------------------------------------------------------------------------------------
// Brush faces
// ---------------------------------------------------------------------------------------------------

/** One texture repeat across a brush face, in world units at scale 1 — TrenchBroom's default. */
export const BRUSH_TEXTURE_SIZE = 64;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const length = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / length, a[1] / length, a[2] / length]; };

/**
 * The texture axes a face's plane implies, before rotation and scale.
 *
 * This is the frame TrenchBroom's face inspector works in, and it is the frame an imported texture
 * basis has to be expressed in, so the editor, the play view and the importer all share it.
 */
export function brushUvAxes(normal) {
  const basis = Math.abs(normal[0]) < .9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]);
  const u = normalize(basis);
  return { u, v: normalize(cross(normal, u)) };
}

/**
 * `[s, t]` in texture repeats for a world point on a brush face.
 *
 * The point is *not* reordered here: this file works in the project's own world axes, and the
 * renderers reorder for their own coordinate system when they push positions.
 */
export function brushFaceUv(face, normal, point) {
  // A face imported from a Quake 3 brush primitive keeps the basis the file gave it, exactly as
  // TrenchBroom's parallel texture system keeps its axes. Rotation and scale cannot express every
  // basis (a rotated one with unequal scales is not a rotation of a scaled frame), so the basis wins
  // while it is there; editing an offset, scale or rotation replaces it.
  const basis = face?.uvBasis;
  if (Array.isArray(basis?.u) && Array.isArray(basis?.v)
    && basis.u.length >= 3 && basis.v.length >= 3
    && [...basis.u, ...basis.v].every(Number.isFinite)) {
    return [dot(point, basis.u) + (Number(basis.u[3]) || 0), dot(point, basis.v) + (Number(basis.v[3]) || 0)];
  }
  const { u, v } = brushUvAxes(normal);
  // A negative scale mirrors the texture (project.js documents the range on the magnitude), which is
  // how a mirrored Quake 3 texture basis is stored, so the sign is kept here.
  const scaleX = Number(face?.scaleX) || 1;
  const scaleY = Number(face?.scaleY) || 1;
  const su = dot(point, u) / (BRUSH_TEXTURE_SIZE * scaleX);
  const sv = dot(point, v) / (BRUSH_TEXTURE_SIZE * scaleY);
  const turn = (Number(face?.rotation) || 0) * Math.PI / 180;
  const cosTurn = Math.cos(turn), sinTurn = Math.sin(turn);
  return [
    su * cosTurn - sv * sinTurn + (Number(face?.offsetX) || 0) / BRUSH_TEXTURE_SIZE,
    su * sinTurn + sv * cosTurn + (Number(face?.offsetY) || 0) / BRUSH_TEXTURE_SIZE,
  ];
}
