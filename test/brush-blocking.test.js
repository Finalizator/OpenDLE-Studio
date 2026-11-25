// A brush is a wall to everything that is not the player's physics body.
//
// Sight, monster steps, bullets and missiles all ask `geometryDistance`, which traced sectors and
// walls only — so a Doom level with brushes drawn in it had monsters looking straight through them
// and every shot passing through a brush wall. A brush level with no sectors had nothing in the way
// anywhere. The one exception a mapper can ask for is a passthrough brush.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { brushVolumes, createBoxBrush } from '../shared/brushes.js';
import { volumeDistance } from '../shared/brush-trace.js';
import { advanceProjectiles, canSeePlayer, geometryDistance, launchProjectile, moveEnemy, SIGHT_RANGE } from '../shared/combat.js';
import { collisionMesh } from '../shared/physics.js';

const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/** One room 400 by 200 with the player on the right and a monster on the left. */
function room({ brush = null } = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-200, -100], [200, -100], [200, 100], [-200, 100]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's0', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 }];
  const side = () => ({ sectorId: 's0', offsetX: 0, offsetY: 0 });
  project.map.walls = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b], index) => ({
    id: `w${index}`, a: `v${a}`, b: `v${b}`, right: side(), left: null,
    solid: true, height: 128, color: '#888888', special: 0, tag: 0,
  }));
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: 120, y: 0, angle: 180 },
    { id: 'imp', type: 'enemy', name: 'DoomImp', doomType: 3001, x: -120, y: 0, angle: 0, health: 60 },
  ];
  project.map.brushes = [];
  let wall = null;
  if (brush) wall = createBoxBrush(project, { x: -16, y: -100, z: 0, width: 32, depth: 200, height: 128 });
  if (brush === 'passable') wall.passable = true;
  validateProject(project);
  return { project, wall };
}

function runtimeOf(project) {
  const state = createRuntime(project);
  const monster = state.entities.find(entity => entity.id === 'imp');
  return { state, monster };
}

test('a solid brush wall hides the player from a monster, and a passthrough brush does not', () => {
  const open = runtimeOf(room().project);
  assert.equal(canSeePlayer(open.state, open.monster, SIGHT_RANGE), true, 'nothing between them');

  const solid = runtimeOf(room({ brush: true }).project);
  assert.equal(canSeePlayer(solid.state, solid.monster, SIGHT_RANGE), false, 'the brush wall hides the player');

  const passable = runtimeOf(room({ brush: 'passable' }).project);
  assert.equal(canSeePlayer(passable.state, passable.monster, SIGHT_RANGE), true, 'a passthrough brush hides nothing');
});

test('a monster does not walk through a brush, and does through a passthrough one', () => {
  const solid = runtimeOf(room({ brush: true }).project);
  for (let step = 0; step < 240; step++) moveEnemy(solid.state, solid.monster, 200, 1 / 60, solid.state.player);
  assert.ok(solid.monster.x < -16, `stopped on the near side of the brush (x = ${solid.monster.x})`);

  const passable = runtimeOf(room({ brush: 'passable' }).project);
  for (let step = 0; step < 240; step++) moveEnemy(passable.state, passable.monster, 200, 1 / 60, passable.state.player);
  assert.ok(passable.monster.x > 32, `walked through the passthrough brush (x = ${passable.monster.x})`);
});

test('a missile stops at a brush instead of flying through it', () => {
  const solid = runtimeOf(room({ brush: true }).project);
  launchProjectile(solid.state, { speed: 2000, damage: 20, diceSides: 1, radius: 0, color: '#66bbff' });
  for (let step = 0; step < 10; step++) advanceProjectiles(solid.state, .05);
  assert.equal(solid.state.entities.find(entity => entity.id === 'imp').health, 60, 'the monster behind the brush is unhurt');
  assert.equal(solid.state.projectiles.length, 0, 'the missile died on the brush');

  const passable = runtimeOf(room({ brush: 'passable' }).project);
  launchProjectile(passable.state, { speed: 2000, damage: 20, diceSides: 1, radius: 0, color: '#66bbff' });
  for (let step = 0; step < 10; step++) advanceProjectiles(passable.state, .05);
  assert.equal(passable.state.entities.find(entity => entity.id === 'imp').health, 40, 'it went through and hit');
});

test('a shot cannot leave the room through a brush wall', () => {
  const { state } = runtimeOf(room({ brush: true }).project);
  // From the player's eye towards the wall: 40 units is the brush's near face at x = 16.
  const distance = geometryDistance(state, { x: 120, y: 0, z: 42 }, { x: -1, y: 0, z: 0 }, 400);
  assert.ok(Math.abs(distance - 104) < .5, `the shot stops at the brush face (${distance})`);
});

test('the player is not pushed out of a passthrough brush, and is by a solid one', () => {
  // The room itself: four walls plus its floor and ceiling.
  const roomAlone = collisionMesh(room().project, triangulate).indices.length / 6;
  const solid = collisionMesh(room({ brush: true }).project, triangulate).indices.length / 6;
  assert.equal(solid - roomAlone, 6 * 2, 'a solid brush adds its six faces');
  const passable = collisionMesh(room({ brush: 'passable' }).project, triangulate).indices.length / 6;
  assert.equal(passable, roomAlone, 'a passthrough brush adds nothing');
});

test('the trace volume of a brush is its own box, and a ray enters where the box starts', () => {
  const { project } = room({ brush: true });
  const volumes = brushVolumes(project.map.brushes);
  assert.equal(volumes.length, 1);
  const [volume] = volumes;
  assert.equal(volume.minX, -16); assert.equal(volume.maxX, 16);
  assert.equal(volumeDistance(volume, { x: 100, y: 0, z: 40 }, { x: -1, y: 0, z: 0 }, 400), 84);
  assert.equal(volumeDistance(volume, { x: 100, y: 300, z: 40 }, { x: -1, y: 0, z: 0 }, 400), Infinity, 'a ray beside it misses');
  assert.equal(volumeDistance(volume, { x: 0, y: 0, z: 40 }, { x: -1, y: 0, z: 0 }, 400), Infinity,
    'a trace that starts inside answers nothing rather than zero, so a thing stuck in a wall can still act');
  assert.equal(brushVolumes([{ ...project.map.brushes[0], passable: true }]).length, 0, 'a passthrough brush is not a volume');
});
