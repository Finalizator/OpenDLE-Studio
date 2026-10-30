// Engine scriptlets are ready-made rule sets a creator can install into any project:
// the visual-scripting equivalent of a macro. Each entry installs ordinary editable
// events (and, where it needs one, its own engine sheet), so everything a scriptlet
// produces can be inspected, changed or deleted like hand-written rules.

import { installEngineScripts, installWallWalkDemo, installSprayScriptlet, installSourceMovementScriptlet,
  addSurfRamp, surfRampGeometry, surfRampSurface, WALL_WALK_SHEET, SPRAY_SHEET, SOURCE_MOVEMENT_SHEET } from './engine-script.js';
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
 * A new, empty project that is a surf map: a surf ramp to slide down, a walkable ramp back up, and
 * a bridge at the top joining them, so the run can be repeated without leaving the map.
 *
 * Installing the movement rules into an imported WAD drops ramps into whatever geometry is
 * already there, which on a real map means two ramps jammed against a wall. A map built for
 * surfing is small and empty, so this replaces the whole project. Everything it produces is
 * ordinary — sectors, walls, scene objects — so it can be reshaped like any other map.
 *
 * Six things about the shape are not free choices, and each was a bug before it was measured:
 *
 * - **The player starts on the ramp.** A surface steeper than 45.573 degrees is never ground, so
 *   it can only be started on or landed on. A player leaving a platform at the run speed flies
 *   over a 50 degree ramp entirely — the surface drops at 320·tan50 = 381 units a second and
 *   nothing pulls them after it.
 * - **No two ramps share an edge.** Two meeting at their low edges make a groove narrower than
 *   the player's own body, so they jam in it; two meeting at their high edges leave a crack
 *   between tilted boxes that a strafing player drops through. The two ramps here are in
 *   separate lanes, joined at the top by a flat bridge.
 * - **The ramps are seated on the floor** (`seat: true`), so each is a wedge rather than a plank
 *   floating a thickness above the ground with a gap a player can walk into — which is what
 *   "I fell through the ramp" looked like.
 * - **The way back is standable.** The return ramp is 30 degrees, which is under the 45.573 the
 *   engine calls ground, so it can be walked up with friction instead of slid down.
 * - **Everything fits inside the room.** The room outline is the collision, so a ramp that comes
 *   out through a wall is one the player slides into the wall.
 * - **Nothing is a lip.** The bridge's top is exactly the height of both ramps' high edges, which
 *   `surfRampSurface` reads off the ramps themselves.
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
  const ceiling = 320;
  room.ceilingHeight = ceiling;
  room.light = 192;
  const bounds = { x: 450, y: 300 };
  for (const vertex of project.map.vertices) {
    vertex.x = Math.sign(vertex.x) * bounds.x;
    vertex.y = Math.sign(vertex.y) * bounds.y;
  }
  for (const wall of project.map.walls) wall.height = ceiling;

  const lane = 150, depth = 240;
  // The surf ramp descends towards +x from its high edge at x = -100, the left-hand one.
  const surf = addSurfRamp(project, { x: -100 + surfRampGeometry().run / 2, y: -lane, angle: 0,
    slope: 50, depth, seat: true });
  const surfSurface = surfRampSurface(surf);
  const top = surfSurface.highHeight;
  // The way back: the same height over a 30 degree slope, which the engine calls ground, so it
  // is walked up rather than slid down. It rises towards -x to the bridge.
  const backWidth = top / Math.sin(30 * Math.PI / 180);
  const backRun = backWidth * Math.cos(30 * Math.PI / 180);
  const back = addSurfRamp(project, { x: surfSurface.highEdgeX - 40 + backRun / 2, y: lane, angle: 0,
    slope: 30, width: backWidth, depth, seat: true, id: 'surf_return_ramp' });
  const backSurface = surfRampSurface(back);
  // The bridge across the two lanes, spanning exactly the gap between the two high edges and
  // level with them, so both joins are flush: one ramp's high edge, the bridge, the other's.
  const bridgeX = (surfSurface.highEdgeX + backSurface.highEdgeX) / 2;
  const bridgeWidth = Math.abs(surfSurface.highEdgeX - backSurface.highEdgeX);
  project.map.entities.push({ id: 'surf_bridge', name: 'Bridge', type: 'decoration',
    x: bridgeX, y: 0, angle: 0,
    physics: { body: 'fixed', shape: 'box', width: bridgeWidth, height: top, depth: lane * 2 + depth,
      radius: 8, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true } });

  // Standing on the surf ramp, a little way down from its high edge, facing the way it falls.
  // Far enough down the slope that the whole 12-unit capsule is on the face: the ridge is a sharp
  // edge on a hull, and standing on it with part of the capsule past it caught the player on the
  // end face instead of the slope. Started a little above the surface for the same reason.
  const inset = 40;
  const startX = surfSurface.highEdgeX + inset;
  const start = project.map.entities.find(entity => entity.type === 'player');
  Object.assign(start, { x: startX, y: -lane, angle: 0, elevation: surfSurface.heightAt(startX) + 8 });
  // On the floor at the bottom, where the slide ends.
  const cell = project.map.entities.find(entity => entity.type === 'pickup');
  if (cell) Object.assign(cell, { x: surfSurface.lowEdgeX + 60, y: 0, elevation: 0 });
  project.sourceMovementRamps = [surf.id, back.id];
  project.sourceMovementSurfRamp = surf.id;
  project.surfBridge = 'surf_bridge';
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
    + 'and the player slides along it — that is a surf ramp, and the ramps this installs are '
    + 'scene objects of their own type with an angle, length, width and height you can edit. '
    + 'Every constant is a field on the '
    + '"source_movement" rule: gravity, jump speed, run speed, accelerate, airaccelerate, friction, '
    + 'stop speed and the air speed cap. Raise airaccelerate to 100 for the feel of a surf server.',
  rules: 2,
  install(project) { return installSourceMovementScriptlet(project); },
  // A second action: build a whole new map to surf in, rather than adding ramps to whatever
  // geometry this project already has.
  build(project) { return buildSurfTestMap(project); },
  buildLabel: 'Build a new empty surf map',
  buildDetail: 'Replaces the whole project with a new, empty room, a surf ramp to slide down, a '
    + 'walkable ramp back up and a bridge between them, and puts the player on the surf ramp — the '
    + 'quickest way to try surfing. Undo restores what was open before.',
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
