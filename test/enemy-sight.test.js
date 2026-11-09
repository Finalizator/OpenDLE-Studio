import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts } from '../shared/world-motion.js';
import { canSeePlayer, canSeeTarget, checkMeleeRange, enemyAttackChance, SIGHT_RANGE, sightEyeHeight } from '../shared/combat.js';

/**
 * Two rooms joined by a doorway, so a sight line can be opened and shut.
 *
 * `doorway` is the middle sector's ceiling, which is what a shut door is: the opening between
 * the two sectors is empty, and the trace is blocked there. `middleFloor` raises the passage
 * into a ledge, which is the other half of Doom's sight test.
 */
function twoRooms({ doorway = 0, middleFloor = 0, playerX = 60, width = 192 } = {}) {
  const p = createProject();
  p.events = [];
  const half = width / 2;
  p.map.vertices = [[-half, -96], [-32, -96], [32, -96], [half, -96], [-half, 96], [-32, 96], [32, 96], [half, 96]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  p.map.sectors = [0, 1, 2].map(index => ({
    id: `s${index}`, floorHeight: index === 1 ? middleFloor : 0,
    ceilingHeight: index === 1 ? doorway : 128, light: 255, sky: false, tag: index,
  }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    [0, 1, 's0'], [1, 5, 's0', 's1'], [5, 4, 's0'], [4, 0, 's0'],
    [1, 2, 's1'], [2, 6, 's1', 's2'], [6, 5, 's1'], [2, 3, 's2'], [3, 7, 's2'], [7, 6, 's2'],
  ].map(([a, b, right, left], index) => ({
    id: `w${index}`, a: `v${a}`, b: `v${b}`, right: side(right), left: left ? side(left) : null,
    solid: !left, height: 128, color: '#888888', special: 0, tag: 0,
  }));
  p.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: playerX, y: 0, angle: 180 },
    { id: 'imp', type: 'enemy', name: 'DoomImp', doomType: 3001, x: -60, y: 0, angle: 0, health: 60 },
  ];
  installEngineScripts(p);
  installWorldScripts(p, []);
  validateProject(p);
  return p;
}

function runtimeOf(project) {
  const state = createRuntime(project);
  state.player.z = 0;
  const monster = state.entities.find(entity => entity.id === 'imp');
  return { state, monster };
}

test('a monster does not see a player through a shut door, and does when it opens', () => {
  const shut = runtimeOf(twoRooms({ doorway: 0 }));
  assert.equal(canSeePlayer(shut.state, shut.monster, SIGHT_RANGE), false, 'the doorway is shut');
  assert.equal(checkMeleeRange(shut.state, shut.monster), false, 'and it is not in reach');

  const open = runtimeOf(twoRooms({ doorway: 128 }));
  assert.equal(canSeePlayer(open.state, open.monster, SIGHT_RANGE), true, 'the doorway is open');
});

test('the sight check is a trace, so a wall between two rooms hides the player', () => {
  const p = twoRooms({ doorway: 128 });
  const { state, monster } = runtimeOf(p);
  // The same layout with the doorway's opening taken away: the two-sided line between the rooms
  // now spans no height at all, which is what a wall is to `P_CheckSight`.
  state.sectors.find(sector => sector.id === 's1').ceilingHeight = 0;
  assert.equal(canSeePlayer(state, monster, SIGHT_RANGE), false, 'nothing passes a sealed line');
});

test('a monster on a lower floor cannot see over a ledge it would have to look through', () => {
  // The passage's floor is 64 up; both eyes are at 42 and 106, and the line crosses the wall
  // below the top of the step, so the step is what the monster sees.
  const hidden = runtimeOf(twoRooms({ doorway: 128, middleFloor: 64 }));
  assert.equal(canSeePlayer(hidden.state, hidden.monster, SIGHT_RANGE), false);

  // A doorway with no step lets the same sight line through.
  const flat = runtimeOf(twoRooms({ doorway: 128, middleFloor: 0 }));
  assert.equal(canSeePlayer(flat.state, flat.monster, SIGHT_RANGE), true);
});

test('sight runs from three quarters of the way up the body, as Doom traces it', () => {
  const { state, monster } = runtimeOf(twoRooms({ doorway: 128 }));
  assert.equal(sightEyeHeight(state, monster), 42, 'a 56-unit monster looks from 42 up');
  assert.equal(sightEyeHeight(state, state.player), 42, 'and looks at the player\'s eye, not their feet');
  state.player.z = 24;
  assert.equal(sightEyeHeight(state, state.player), 66, 'which rises with the player');
});

test('a monster cannot punch a player it cannot see, even standing next to them', () => {
  // Both are inside melee reach of each other, but the shut doorway is between them.
  const { state, monster } = runtimeOf(twoRooms({ doorway: 0, playerX: -20, width: 192 }));
  monster.x = -45;
  assert.ok(Math.hypot(state.player.x - monster.x, state.player.y - monster.y) < 64, 'in reach');
  assert.equal(checkMeleeRange(state, monster), false, 'but not in sight, so there is nothing to hit');

  state.sectors.find(sector => sector.id === 's1').ceilingHeight = 128;
  assert.equal(checkMeleeRange(state, monster), true, 'once the doorway opens the punch lands');
});

test('the attack decision asks for sight first, so a monster stops firing at a wall', () => {
  const shut = runtimeOf(twoRooms({ doorway: 0 }));
  assert.equal(enemyAttackChance(shut.state, shut.monster), false, 'no sight, no shot');

  const open = runtimeOf(twoRooms({ doorway: 128 }));
  // At this range Doom's distance roll always allows the shot, so the result is the sight test.
  assert.equal(enemyAttackChance(open.state, open.monster), true, 'in sight, it fires');
});

test('a melee-only monster answers through P_CheckMeleeRange, never a missile roll', () => {
  const p = twoRooms({ doorway: 128 });
  const { state } = runtimeOf(p);
  const demon = state.entities.find(entity => entity.id === 'imp');
  demon.doomType = 3002;
  demon.name = 'Demon';
  // In sight but far away: a demon has no missile state in Doom, so it never fires.
  assert.equal(enemyAttackChance(state, demon), false, 'out of reach, so it holds still');
  demon.x = state.player.x - 30;
  assert.equal(enemyAttackChance(state, demon, { missile: false, melee: true }), true,
    'in reach and in sight, it bites');
});

test('a target just beyond a doorway is visible at any distance, because Doom has no sight radius', () => {
  // A long room: 6000 units, far past the 2048 this engine used to stop at.
  const { state, monster } = runtimeOf(twoRooms({ doorway: 128, width: 12000, playerX: 6000 }));
  assert.equal(canSeeTarget(state, monster, state.player, SIGHT_RANGE), true);
  assert.equal(canSeeTarget(state, monster, state.player, 2048), false, 'unless a caller caps it');
});

test('a monster looks at whoever is hunting it, not always the player', () => {
  const { state, monster } = runtimeOf(twoRooms({ doorway: 128 }));
  // In the same room as the monster, on the other side of it from the doorway.
  const other = { id: 'other', type: 'enemy', x: -80, y: 40, z: 0, health: 30 };
  monster.targetId = 'other';
  state.entities.push(other);
  // The player is behind the shut line, the other monster is beside it: the demon may reach it.
  state.sectors.find(sector => sector.id === 's1').ceilingHeight = 0;
  assert.equal(canSeeTarget(state, monster, state.player, SIGHT_RANGE), false, 'the player is hidden');
  assert.equal(canSeeTarget(state, monster, other, SIGHT_RANGE), true, 'the neighbour is not');
});
