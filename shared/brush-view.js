// Orthographic view math, shared by the 2D layout and its tests.
//
// The editor has three 2D views: Top looks down Z, Front looks down Y and Side looks down X.
// Every one of them draws the same world from a different pair of axes, and every edit has to be
// translated back into world space. Doing that translation in one place is what keeps a drag in
// Front behaving exactly like the same drag in Top — the bug this module exists to prevent was a
// drag measured from world x/y, which discarded every Front and Side move.

/** The two world axis indices a view uses: [across, up]. */
export const VIEW_AXES = { xy: [0, 1, 2], xz: [0, 2, 1], yz: [1, 2, 0] };

export function viewAxes(projection) {
  return VIEW_AXES[projection] || VIEW_AXES.xy;
}

/** The world axis a view looks along. */
export function viewDepthAxis(projection) {
  return viewAxes(projection)[2];
}

/** A world point (array or {x,y,z}) projected into the view's own 2D coordinates. */
export function projectWorld(projection, point) {
  const [x, y, z] = Array.isArray(point)
    ? point
    : [point.x || 0, point.y || 0, point.z || 0];
  if (projection === 'xz') return { u: x, v: z };
  if (projection === 'yz') return { u: y, v: z };
  return { u: x, v: y };
}

/** The world point a view coordinate stands for, at `depth` along the axis the view looks down. */
export function unprojectWorld(projection, u, v, depth = 0) {
  if (projection === 'xz') return [u, depth, v];
  if (projection === 'yz') return [depth, u, v];
  return [u, v, depth];
}

/**
 * The world translation a drag of `(du, dv)` in a view stands for.
 *
 * The depth axis is untouched: dragging sideways in Front moves the brush in X and Z, never in Y,
 * which is what makes the three views agree with each other.
 */
export function viewDeltaToWorld(projection, du, dv) {
  const [uAxis, vAxis] = viewAxes(projection);
  const offset = [0, 0, 0];
  offset[uAxis] = du;
  offset[vAxis] = dv;
  return offset;
}

/**
 * The bounds a brush gets when it is dragged out in a view.
 *
 * Top already provides a floor outline, so the height falls back to `depth`; Front and Side
 * provide a height, so the axis the view looks down gets that fallback instead.
 */
export function brushBoundsFromView(projection, a, b, depth = 128) {
  const u0 = Math.min(a.u, b.u), v0 = Math.min(a.v, b.v);
  const width = Math.abs(b.u - a.u), height = Math.abs(b.v - a.v);
  if (projection === 'xz') return { x: u0, y: 0, z: v0, width, depth, height };
  if (projection === 'yz') return { x: 0, y: u0, z: v0, width: depth, depth: width, height };
  return { x: u0, y: v0, z: 0, width, depth: height, height: depth };
}

/** A 2D point snapped to the grid, in the view's own coordinates. */
export function snapViewPoint(view, grid, enabled = true) {
  const round = value => enabled && grid ? Math.round(value / grid) * grid : Math.round(value);
  return { u: round(view.u), v: round(view.v) };
}
