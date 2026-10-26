/**
 * Sky changes: ACS `ChangeSky(sky1, sky2)` names a new sky texture while the
 * level runs. The request is kept on the runtime state so it survives saves, and
 * the renderer swaps the sky image without rebuilding the scene.
 */

/** The sky name a runtime request names, accepting both the old and new shape. */
export function skyRequestName(request) {
  if (!request) return null;
  if (typeof request === 'string') return request.trim() || null;
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  return name || null;
}

/** The secondary name, used by sectors flagged sky2, which this engine does not model. */
export function skyRequestAlternate(request) {
  return request && typeof request === 'object' && typeof request.alt === 'string' && request.alt.trim()
    ? request.alt.trim() : null;
}

/** The image asset a sky name refers to, or null when the project has no such image. */
export function skyAssetFor(project, name) {
  const wanted = String(name || '').trim().toUpperCase();
  if (!wanted) return null;
  return (project.assets || []).find(asset => typeof asset.name === 'string' &&
    asset.name.toUpperCase() === wanted && ['sky', 'texture', 'image'].includes(asset.kind)) || null;
}

/**
 * Records `ChangeSky(first, second)` on the state. The second sky only matters to
 * sectors carrying the "sky2" flag, so it is kept for diagnostics rather than drawn.
 */
export function requestSky(state, first, second) {
  const name = String(first || '').trim();
  if (!name) return false;
  const alt = String(second || '').trim();
  // Only the fields the save format knows about are set: an unknown runtime field
  // makes a save unloadable, and the renderer compares names, not revisions.
  state.skyRequest = { name, alt: alt && alt !== name ? alt : null };
  return true;
}
