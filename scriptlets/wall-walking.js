import { findScriptletSheet, installScriptletRules, removeScriptletSheet, scriptletRuleCount } from '../shared/scriptlets.js';

export const WALL_WALK_SHEET = 'Wall walking (experiment)';
const ID = 'wall-walking';

export function installWallWalkDemo(project) {
  const gravity = mode => ({ type: 'setPlayerGravity', mode, reach: 8 });
  const rules = [
    { name: 'demo_hint', condition: { type: 'onStart' }, conditions: [],
      actions: [{ type: 'showMessage', message: 'Wall walking: jump at a wall or ceiling to walk on it. Hold F to drop back.' }] },
    { name: 'walk_on_walls', condition: { type: 'playerTouchingSurface', surface: 'wall' },
      conditions: [{ type: 'playerAirborne', state: 'airborne' }], actions: [gravity('wall')] },
    { name: 'walk_on_ceilings', condition: { type: 'playerTouchingSurface', surface: 'ceiling' },
      conditions: [{ type: 'playerAirborne', state: 'airborne' }], actions: [gravity('ceiling')] },
    { name: 'back_to_world_gravity', condition: { type: 'playerTouchingSurface', surface: 'floor' },
      conditions: [], actions: [gravity('world')] },
    { name: 'drop_to_world_gravity', condition: { type: 'keyHeld', key: 'KeyF' }, conditions: [], actions: [gravity('world')] },
  ];
  return installScriptletRules(project, { id: ID, name: WALL_WALK_SHEET, sheetId: 'engine_wall_walk' },
    rules.map(rule => ({ ...rule, id: `engine_${rule.name}` })));
}

export function removeWallWalkDemo(project) {
  return removeScriptletSheet(project, WALL_WALK_SHEET, ID);
}

export default {
  id: ID,
  name: 'Wall walking',
  summary: 'Jump at a wall or ceiling to turn gravity onto it and walk on that surface.',
  detail: 'Adds the "Wall walking (experiment)" engine sheet: touching a wall or ceiling while airborne rotates the player gravity onto it, touching a real floor or holding F returns to normal gravity. Uses only the shared Player conditions and actions, so it works in any project.',
  rules: 5,
  install: installWallWalkDemo,
  remove: removeWallWalkDemo,
  installed(project) { return scriptletRuleCount(project, WALL_WALK_SHEET, ID); },
  present(project) { return Boolean(findScriptletSheet(project, WALL_WALK_SHEET, ID)); },
};
