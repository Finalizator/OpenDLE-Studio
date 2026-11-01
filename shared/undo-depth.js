/**
 * How many undo steps a project keeps.
 *
 * An undo step costs one snapshot of the level being edited, and nothing else: `cloneProjectForEdit`
 * shares the actor table, the campaign and the asset payloads between snapshots and copies only the
 * array of asset references, so the price of a step is the map, the rules, the HUD and the timelines.
 * That is tens of kilobytes on an imported Doom 2 level and several megabytes on a megawad map.
 *
 * The depth therefore has to come from the level, not from what shape the project happens to have.
 * It used to: `game ? 3 : assets ? 10 : 40` gave an imported campaign three undo steps whatever its
 * size — measured at 90 KB per step on the Doom 2 import, so 39 of the 40 steps a project without a
 * campaign gets were given up for a tenth of a megabyte. A 55,000-wall map, on the other hand, costs
 * megabytes per step and still gets three, which is the right answer for a different reason.
 *
 * The estimate is a weight in records rather than bytes, because measuring bytes means serialising
 * the level on every edit. The weights were calibrated against real snapshots: an imported Doom 2
 * level measures ~14 bytes per weight unit and a map with two-sided walls on every linedef ~80, so
 * the budget uses the larger figure and errs towards a shallower history.
 */

/** How much history may be held, in bytes of live objects. */
export const UNDO_BUDGET_BYTES = 48 * 1024 * 1024;
/** The most a weight unit is assumed to cost, in bytes (calibrated on a 20,000-wall map). */
export const UNDO_BYTES_PER_WEIGHT = 80;
export const UNDO_MIN_STEPS = 3;
export const UNDO_MAX_STEPS = 40;
/**
 * Editing the campaign itself — routing, level names, entry map — deep-copies the whole game, which
 * on an imported megawad is a ten-megabyte snapshot where a map edit is a hundred kilobytes. Those
 * edits keep a short history of their own rather than filling the budget with campaign copies.
 */
export const UNDO_DEEP_GAME_STEPS = 6;

/**
 * What one snapshot of this project weighs, in weight units.
 *
 * Counts only — walking the level's arrays is free compared with copying them, and the multipliers
 * are what each record costs relative to a vertex (a sidedef-bearing wall and an event carry more
 * than a point).
 */
export function snapshotWeight(project) {
  const map = project?.map || {};
  return (map.vertices?.length || 0)
    + (map.walls?.length || 0) * 2
    + (map.sectors?.length || 0) * 2
    + (map.entities?.length || 0) * 4
    + (map.entityGroups?.length || 0) * 2
    + (project?.events?.length || 0) * 6
    + (project?.eventSheets?.length || 0) * 10
    + (project?.hud?.elements?.length || 0) * 4
    + (project?.hud?.animations?.length || 0) * 6
    + (project?.paths?.length || 0) * 20
    + (project?.timesheets?.length || 0) * 30
    + (project?.scenes?.length || 0) * 20
    + (project?.spriteClips?.length || 0) * 10
    + (project?.materialAnimations?.length || 0) * 4
    + (project?.gameMenus?.length || 0) * 20
    + (project?.game?.levels?.length || 0) * 40;
}

/** How many steps this project's history may hold: 3 for a megawad map, 40 for a small one. */
export function undoDepthFor(project) {
  const weight = Math.max(1, snapshotWeight(project));
  // Rounded down, so the history never exceeds the budget because of the last step.
  const steps = Math.floor(UNDO_BUDGET_BYTES / (UNDO_BYTES_PER_WEIGHT * weight));
  return Math.min(UNDO_MAX_STEPS, Math.max(UNDO_MIN_STEPS, steps));
}
