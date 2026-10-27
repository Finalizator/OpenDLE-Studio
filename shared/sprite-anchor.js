/**
 * Where a billboard's quad has to sit so the artwork's own anchor lands on the entity.
 *
 * Doom patches carry a left/top offset that marks the point of the image that belongs
 * on the thing's origin (its feet). Applying them to `sprite.center` depends on the
 * material implementing that shader feature; a sprite that silently keeps the default
 * centre is then drawn half-sunk in the floor. The offsets are converted into a
 * position shift instead, which every renderer path honours, and this is the one place
 * that maths lives.
 */
export function spriteAnchor({ width, height, offsetX = 0, offsetY = 0 }) {
  return { dx: width / 2 - offsetX, dy: offsetY - height / 2 };
}
