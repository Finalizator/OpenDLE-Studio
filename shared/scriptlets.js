// Engine scriptlets are ready-made rule sets a creator can install into any project:
// the visual-scripting equivalent of a macro. Each entry installs ordinary editable
// events (and, where it needs one, its own engine sheet), so everything a scriptlet
// produces can be inspected, changed or deleted like hand-written rules.

import { installEngineScripts, installWallWalkDemo, installSprayScriptlet, installSourceMovementScriptlet,
  addSurfRamp, surfRampGeometry, WALL_WALK_SHEET, SPRAY_SHEET, SOURCE_MOVEMENT_SHEET } from './engine-script.js';
import { createProject } from './project.js';

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

/** Removes the sheet, rules and ramps the Half-Life movement scriptlet installs. */
export function removeSourceMovement(project) {
  const sheet = (project.eventSheets || []).find(sheet => sheet.name === SOURCE_MOVEMENT_SHEET);
  const ramps = new Set(project.sourceMovementRamps || []);
  if (ramps.size) project.map.entities = project.map.entities.filter(entity => !ramps.has(entity.id));
  delete project.sourceMovementRamps;
  if (!sheet) return ramps.size > 0;
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  project.eventSheets = project.eventSheets.filter(item => item.id !== sheet.id);
  return true;
}

/**
 * A new, empty project that is a surf map: one room, a raised ceiling, a player start and two
 * ramps facing each other.
 *
 * Installing the movement rules into an imported WAD drops ramps into whatever geometry is
 * already there, which on a real map means two ramps jammed against a wall. A map built for
 * surfing is small and empty, so this replaces the whole project: the room is the default one,
 * raised to a 256-unit ceiling, and the ramps sit in the middle with open floor either side.
 * Everything it produces is ordinary — sectors, walls, scene objects — so it can be reshaped
 * like any other map.
 */
export function buildSurfTestMap(project) {
  // A fresh project is already a valid room with a player start and the editable engine
  // sheets, so building on one means the result cannot be a map with no player or no rules.
  const fresh = installEngineScripts(createProject(), { organizeStarter: true });
  // Replace rather than merge: an imported project's actors, assets and events all describe a
  // map that is about to disappear, and validation rejects events pointing at nothing.
  for (const key of Object.keys(project)) delete project[key];
  Object.assign(project, fresh);
  const room = project.map.sectors[0];
  // A 50 degree ramp of the default width rises 98 units, so the default 128-unit room would
  // have the ramp poking through the ceiling.
  room.ceilingHeight = 256;
  room.light = 192;
  const start = project.map.entities.find(entity => entity.type === 'player');
  Object.assign(start, { x: -260, y: 0, angle: 0 });
  const geometry = surfRampGeometry();
  const created = [];
  for (const [index, side] of [1, -1].entries()) {
    created.push(addSurfRamp(project, {
      x: start.x + 260 + side * (geometry.run / 2 + 40), y: start.y, angle: 0, roll: side * 50 }));
  }
  project.sourceMovementRamps = created.map(ramp => ramp.id);
  installSourceMovementScriptlet(project, { ramps: 0 });
  project.title = 'Surf test map';
  return project;
}

const sourceMovement = {
  id: 'source-movement',
  name: 'Half-Life movement and surf',
  summary: 'Half-Life / Source movement — the acceleration, air-strafing and surf of the Source engine.',
  detail: 'Adds the "Half-Life movement (Source)" engine sheet and two surf ramps. The player moves '
    + 'the way Half-Life does: friction, ground acceleration and an air acceleration that can only '
    + 'add 30 units a second along the direction held, which is what makes air-strafing and bunny '
    + 'hopping work. A surface steeper than 45.6 degrees cannot be stood on, so it has no friction '
    + 'and the player slides along it — that is a surf ramp, and the two ramps this installs are '
    + 'ordinary scene objects you can move or delete. Every constant is a field on the '
    + '"source_movement" rule: gravity, jump speed, run speed, accelerate, airaccelerate, friction, '
    + 'stop speed and the air speed cap. Raise airaccelerate to 100 for the feel of a surf server.',
  rules: 2,
  install(project) { return installSourceMovementScriptlet(project); },
  // A second action: build a whole new map to surf in, rather than adding ramps to whatever
  // geometry this project already has.
  build(project) { return buildSurfTestMap(project); },
  buildLabel: 'Build a new empty surf map',
  buildDetail: 'Replaces the whole project with a new, empty room, two surf ramps and the movement '
    + 'rules — the quickest way to try surfing. Undo restores what was open before.',
  remove(project) { return removeSourceMovement(project); },
  installed(project) {
    const sheet = (project.eventSheets || []).find(sheet => sheet.name === SOURCE_MOVEMENT_SHEET);
    return sheet ? project.events.filter(event => event.sheetId === sheet.id).length : 0;
  },
};

export const ENGINE_SCRIPTLETS = [wallWalking, spray, sourceMovement];

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
