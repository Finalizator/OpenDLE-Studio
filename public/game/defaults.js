// The menus and HUD a game expects, added in memory for a project that has none.
//
// The editor's playtest does this on the document it plays; an exported game has no editor, so it
// has to do the same — but only where something is missing. `missingDefaults` is the decision and
// `defaults-model.js` is where it is tested.

import { installDefaultHUD } from '/shared/hud.js';
import { installGameMenu } from '/shared/game-menu.js';
import { missingDefaults } from './defaults-model.js';

/**
 * Gives `project` the menus and HUD it needs to be playable, and touches nothing it already has.
 *
 * Returns what had to be added, which is what the shell reports for a bug report.
 */
export function installGameDefaults(project, { installMenu = installGameMenu, installHUD = installDefaultHUD } = {}) {
  const missing = missingDefaults(project);
  if (missing.hud) installHUD(project);
  if (missing.menus) installMenu(project);
  return missing;
}
