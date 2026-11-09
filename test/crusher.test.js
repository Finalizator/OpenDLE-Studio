import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts, advanceSectors } from '../shared/world-motion.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { upgradeCrusherRules } from '../shared/doom-specials.js';

/**
 * A 48-unit doorway like the one in MAP04: floor 24, ceiling 72, neighbours at 72, with a
 * walk-over line carrying Doom's silent crush-and-raise piston (type 141).
 */
function pistonRoom({ special = 141, ceiling = 72, neighbours = 72 } = {}) {
  const p = createProject();
  p.events = [];
  p.map.vertices = [[-192, -96], [-32, -96], [32, -96], [192, -96], [-192, 96], [-32, 96], [32, 96], [192, 96]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  p.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: neighbours, light: 160, sky: false, tag: 0 },
    { id: 's1', floorHeight: 24, ceilingHeight: ceiling, light: 144, sky: false, tag: 14 },
    { id: 's2', floorHeight: 0, ceilingHeight: neighbours, light: 160, sky: false, tag: 0 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    [0, 1, 's0'], [1, 5, 's0', 's1'], [5, 4, 's0'], [4, 0, 's0'],
    [1, 2, 's1'], [2, 6, 's1', 's2'], [6, 5, 's1'], [2, 3, 's2'], [3, 7, 's2'], [7, 6, 's2'],
  ].map(([a, b, right, left], index) => ({
    id: `w${index}`, a: `v${a}`, b: `v${b}`, right: side(right), left: left ? side(left) : null,
    solid: !left, height: 128, color: '#888888', special: 0, tag: 0,
  }));
  // A walk-over trigger standing in the first room, aimed at the doorway's tag. It has to be a
  // line the player can actually walk through, so it sits across the room's floor.
  p.map.vertices.push({ id: 'v8', x: -120, y: -96 }, { id: 'v9', x: -120, y: 96 });
  p.map.walls.push({ id: 'trigger', a: 'v8', b: 'v9', right: side('s0'), left: side('s0'), solid: false,
    height: 128, color: '#888888', special, tag: 14 });
  p.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -168, y: 0, angle: 0 }];
  installEngineScripts(p);
  installWorldScripts(p, []);
  validateProject(p);
  return p;
}

const ceilingOf = (state, id = 's1') => state.sectors.find(sector => sector.id === id).ceilingHeight;

/** Walks the player forward across the trigger line, the way the game moves them. */
function crossLine(project, state, tics = 20) {
  const keys = new Set(['KeyW']);
  for (let tic = 0; tic < tics; tic++) stepRuntime(project, state, 1 / 35, keys, new Set());
  keys.clear();
  return state.player.x;
}

test('a crush-and-raise piston travels all the way to the floor, not to the next ceiling', () => {
  const project = pistonRoom();
  const rule = project.events.find(event => event.name.includes('trigger'));
  assert.ok(rule, 'the line became a rule');
  const action = rule.actions.find(action => action.type === 'moveSector');
  assert.equal(action.height, 24, 'Doom crushes down to the sector floor');
  assert.equal(action.returnHeight, 72, 'and rises back to the ceiling it started at');
  assert.equal(action.returnMode, 'cycle', 'the piston repeats for as long as the level runs');
  assert.equal(action.bottomWait, 0, 'it reverses the instant it touches the floor');
  assert.equal(action.wait, 150 / 35, 'and rests Doom’s CEILWAIT of 150 tics at the top');
});

test('crossing the line sets the piston going, and it cycles on its own', () => {
  const project = pistonRoom();
  const state = createRuntime(project);
  const keys = new Set();
  const step = count => { for (let i = 0; i < count; i++) stepRuntime(project, state, 1 / 35, keys, new Set()); };
  step(5);
  assert.equal(ceilingOf(state), 72, 'still shut before the line is crossed');
  assert.ok(crossLine(project, state) > -120, 'the player walked past the line');
  assert.ok(state.sectorMotions.has('s1:ceilingHeight'), 'the piston is running');
  // Move the player out of the doorway so the crusher is free to close.
  state.entities.find(entity => entity.type === 'player').x = -120;
  state.player.x = -120;
  const heights = [];
  for (let tic = 0; tic < 420; tic++) { step(1); heights.push(ceilingOf(state)); }
  assert.equal(Math.min(...heights), 24, 'it closes onto the floor');
  assert.equal(Math.max(...heights), 72, 'and opens again');
  const reachedFloor = heights.indexOf(24), rose = heights.findIndex((height, index) => index > reachedFloor && height > 24);
  assert.ok(rose > reachedFloor, 'it comes back up after closing');
  const closedAgain = heights.findIndex((height, index) => index > rose + 10 && height === 24);
  assert.ok(closedAgain > 0, 'and comes down once more, so the movement repeats like an animation');
});

test('a crusher reverses on a thing instead of closing on it, like Doom', () => {
  const project = pistonRoom();
  const state = createRuntime(project);
  const keys = new Set();
  const step = count => { for (let i = 0; i < count; i++) stepRuntime(project, state, 1 / 35, keys, new Set()); };
  step(5);
  crossLine(project, state);
  // The player stays in the doorway: the ceiling must never reach them.
  state.entities.find(entity => entity.type === 'player').x = 0;
  state.player.x = 0;
  let lowest = Infinity;
  for (let tic = 0; tic < 420; tic++) { step(1); lowest = Math.min(lowest, ceilingOf(state)); }
  assert.ok(lowest > 24, `the piston stops above the player (lowest ${lowest})`);
  assert.ok(lowest < 72, 'but it did travel down towards them');
});

test('an imported crusher is repaired on the snapshot, without a re-import', () => {
  const project = pistonRoom();
  const rule = project.events.find(event => event.name.includes('trigger'));
  // What the old importer baked: the neighbouring ceiling less four, waited in tics.
  for (const action of rule.actions) {
    action.height = 68; action.wait = 4; action.returnMode = 'cycle'; action.returnHeight = 72;
    delete action.bottomWait;
  }
  assert.equal(upgradeCrusherRules(project), 1, 'the one piston is repaired');
  assert.equal(rule.actions[0].height, 24);
  assert.equal(rule.actions[0].bottomWait, 0);
  assert.equal(rule.actions[0].wait, 150 / 35);
  assert.equal(upgradeCrusherRules(project), 0, 'running it again changes nothing');
});

test('a line that is not a crusher is left alone', () => {
  // 44 is `W1 Ceiling Crush`: it lowers to the floor and stays, so it must not gain a cycle.
  const project = pistonRoom({ special: 44 });
  const rule = project.events.find(event => event.name.includes('trigger'));
  const action = rule.actions.find(action => action.type === 'moveSector');
  assert.equal(action.returnMode, 'stay');
  assert.equal(upgradeCrusherRules(project), 0, 'and the repair pass does not touch it');
});
