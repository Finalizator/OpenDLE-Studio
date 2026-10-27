// Engine scriptlets are ready-made rule sets a creator can install into any project:
// the visual-scripting equivalent of a macro. Each entry installs ordinary editable
// events (and, where it needs one, its own engine sheet), so everything a scriptlet
// produces can be inspected, changed or deleted like hand-written rules.

import { installWallWalkDemo, installSprayScriptlet, WALL_WALK_SHEET, SPRAY_SHEET } from './engine-script.js';

/** Removes the sheet and rules the wall-walking scriptlet installs. */
export function removeWallWalkDemo(project) {
  const sheet = (project.eventSheets || []).find(sheet => sheet.name === WALL_WALK_SHEET);
  if (!sheet) return false;
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  project.eventSheets = project.eventSheets.filter(item => item.id !== sheet.id);
  return true;
}

const wallWalking = {
  id: 'wall-walking',
  name: 'Wall walking',
  summary: 'Jump at a wall or ceiling to turn gravity onto it and walk on that surface.',
  detail: 'Adds the "Wall walking (experiment)" engine sheet: touching a wall or ceiling while airborne rotates the player gravity onto it, touching a real floor or holding F returns to normal gravity. Uses only the shared Player conditions and actions, so it works in any project.',
  rules: 5,
  install(project) { return installWallWalkDemo(project); },
  remove(project) { return removeWallWalkDemo(project); },
  installed(project) {
    const sheet = (project.eventSheets || []).find(sheet => sheet.name === WALL_WALK_SHEET);
    return sheet ? project.events.filter(event => event.sheetId === sheet.id).length : 0;
  },
};

/** Removes the sheet and rules the spray scriptlet installs. */
export function removeSpray(project) {
  const sheet = (project.eventSheets || []).find(sheet => sheet.name === SPRAY_SHEET);
  if (!sheet) return false;
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  project.eventSheets = project.eventSheets.filter(item => item.id !== sheet.id);
  return true;
}

const spray = {
  id: 'spray',
  name: 'Spray (Counter-Strike style)',
  summary: 'Press a key to paint an imported image onto the wall you are looking at.',
  detail: 'Adds the "Spray (CS-style)" engine sheet with one editable rule: "Key pressed" sprays the chosen '
    + 'image onto the wall under the crosshair, where it stays flat against the surface for a while. Pick the '
    + 'image from the action (any PNG, WebP or JPEG imported into the asset library) and rebind the key in the '
    + 'event\'s "Key pressed" condition. The spray fades after the action\'s duration and survives saving.',
  rules: 1,
  install(project) {
    if (!(project.assets || []).some(asset => !['sound', 'music', 'model', 'font'].includes(asset.kind)))
      throw new Error('Import an image (PNG, WebP or JPEG) into the asset library first: the spray needs artwork to paint.');
    return installSprayScriptlet(project);
  },
  remove(project) { return removeSpray(project); },
  installed(project) {
    const sheet = (project.eventSheets || []).find(sheet => sheet.name === SPRAY_SHEET);
    return sheet ? project.events.filter(event => event.sheetId === sheet.id).length : 0;
  },
};

export const ENGINE_SCRIPTLETS = [wallWalking, spray];

export function scriptletById(id) {
  const found = ENGINE_SCRIPTLETS.find(scriptlet => scriptlet.id === id);
  if (!found) throw new Error(`Unknown engine scriptlet: ${id}`);
  return found;
}

/** Installs a scriptlet by id; returns whatever its installer reports. */
export function installScriptlet(project, id) {
  return scriptletById(id).install(project);
}

export function removeScriptlet(project, id) {
  return scriptletById(id).remove(project);
}
