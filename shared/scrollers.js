/**
 * Boom's wall texture scrollers, specials 100-103.
 *
 * These four slots are `LS_NOP` placeholders in GZDoom's line-special table, which reads as
 * "does nothing" if that table is all you look at. The map loader acts on them first:
 * `maploader/specials.cpp` turns the line into a `DScroller` on the *front* sidedef, so a wall
 * whose picture never changes still slides its texture coordinate along.
 *
 * Lullaby's title map puts `special = 101, arg0 = 32` on all 78 of its mountain walls. GZDoom
 * slides them half a texel per tic; without this the ridges stand still.
 */

/** Tics per second, the rate a map's scrollers advance at in Doom. */
export const TICRATE = 35;

/** The wall scrolling specials, in Boom's numbering. */
export const WALL_SCROLLS = new Set([100, 101, 102, 103]);

/** Slot bits, as `Scroll_Texture_*` passes them in `args[1]`. */
const PARTS = { top: 1, mid: 2, bottom: 4 };

/**
 * Which texture slots a scroller moves.
 *
 * `specials.cpp` runs `args[1]` through `SCROLLTYPE`, which returns 7 (all three slots) for
 * any value that is zero or negative or carries bits outside `top|mid|bottom`, and otherwise
 * the value itself. So the common `arg1 = 0` scrolls everything the sidedef shows.
 */
export function scrolledSlots(args) {
  const parts = Number(args?.[1]) || 0;
  const mask = parts <= 0 || (parts & ~7) ? 7 : parts;
  return Object.keys(PARTS).filter(slot => mask & PARTS[slot]);
}

/**
 * The texture speed a line's special gives its front sidedef, as a UV offset per tic.
 *
 * The speed is `args[0] / 64` texels per tic, rightwards and downwards taking the negative,
 * and it is added to the texture offset — so it is divided by the same tiled size the
 * sidedef's own offset is (`textureWidth * scale`), not by the texture's raw width, or a
 * scaled wall would scroll at the wrong rate.
 *
 * Returns `null` when the line does not scroll `slot` at all.
 */
export function wallScroll(wall, { textureWidth = 64, textureHeight = 64, scale = 1, slot = 'mid' } = {}) {
  const special = Number(wall?.special);
  if (!WALL_SCROLLS.has(special)) return null;
  if (!scrolledSlots(wall?.args).includes(slot)) return null;
  const speed = Number(wall?.args?.[0]) || 0;
  if (!speed) return null;
  const texels = speed / 64;
  const u = special === 100 ? texels : special === 101 ? -texels : 0;
  const v = special === 102 ? texels : special === 103 ? -texels : 0;
  const tw = (textureWidth || 64) * scale, th = (textureHeight || 64) * scale;
  return { u: u / tw, v: v / th };
}

/** The texture offset a scroller has added after `tics` tics. */
export function scrolledUv(scroll, tics) {
  return { u: scroll.u * tics, v: scroll.v * tics };
}
