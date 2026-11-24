// Which defaults a game's project is missing.
//
// This is the decision, kept apart from the installing so it can be tested without a browser. The
// bug it exists for: the shell called `installDefaultHUD` unconditionally, and that function refuses
// a project which already has a HUD — which is every project authored in the editor. An exported
// game then failed with "HUD already exists" before it drew a frame.

/** `{ hud, menus }`: true where the project has nothing and the game must supply a default. */
export function missingDefaults(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('The game data has no project document');
  }
  const hud = !project.hud;
  // A project with menus keeps them; one without gets the editable default set. `installGameMenu`
  // also builds a HUD when there is none, so the HUD is decided first.
  const menus = !project.gameMenus;
  return { hud, menus };
}
