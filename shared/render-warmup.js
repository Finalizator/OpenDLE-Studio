// Three's `compileAsync` projects the scene exactly like a rendered frame, so it
// only builds pipelines for objects that are visible and inside the camera frustum.
// On a big imported map that leaves most of the world to compile the first time the
// player looks at it, which is the multi-second freeze that shows up mid-game. These
// helpers force culling and visibility off for the warm-up pass and restore exactly
// what was changed, so rendering afterwards is untouched.

const isDrawable = object => Boolean(object?.isMesh || object?.isSprite || object?.isLine || object?.isPoints);

/** Make every drawable under `roots` eligible for the warm-up pass. */
export function uncullDrawables(roots) {
  const cleared = [];
  for (const root of roots) root?.traverse?.(object => {
    if (!isDrawable(object) || object.frustumCulled === false) return;
    object.frustumCulled = false;
    cleared.push(object);
  });
  return cleared;
}

/** Undo `uncullDrawables`; only the objects it changed are touched. */
export function restoreCulling(objects) {
  for (const object of objects) object.frustumCulled = true;
}

/** Show objects hidden by the app (unselected weapon overlays) for the warm-up. */
export function revealForWarmup(objects) {
  const hidden = [];
  for (const object of objects) {
    if (!object || object.visible) continue;
    object.visible = true;
    hidden.push(object);
  }
  return hidden;
}

export function restoreVisibility(objects) {
  for (const object of objects) object.visible = false;
}
