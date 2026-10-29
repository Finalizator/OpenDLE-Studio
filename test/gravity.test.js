import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import {
  PLAYER_CYLINDER, alignUp, eyePosition, headingDirection, playerBasis, playerCentre, surfaceKind, upVector, viewDirection,
} from '../shared/gravity.js';
import { createPhysics, validatePhysicsState } from '../shared/physics.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installWallWalkDemo, WALL_WALK_SHEET } from '../shared/engine-script.js';
import { projectUsesSurfaces } from '../shared/runtime.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

/**
 * Walks into the room's east wall and jumps there.
 *
 * Doom keeps the momentum a jump starts with and lets a player steer barely at all in the
 * air (`sv_aircontrol` is 1/256), so a jump from a standstill stays where it started. The
 * gravity rule fires on a wall the airborne capsule is still touching, which is the wall it
 * just jumped from.
 */
function jumpAtWall(state, tick) {
  // Long enough to reach the wall from the room's start and press against it.
  for (let frame = 0; frame < 240 && state.player.x < -25; frame++) tick(1, new Set(['KeyW']));
  // Jump there, and stop as soon as gravity has turned onto the wall: the loop used to
  // keep holding forward, and the player climbed the whole 256-unit room while it ran.
  for (let frame = 0; frame < 60 && state.player.up[2] > .9; frame++) {
    tick(1, new Set(['KeyW']), new Set(frame === 0 ? ['Space'] : []));
  }
}

test('the player frame defaults to world-up and stays orthogonal', () => {
  const basis = playerBasis();
  assert.deepEqual(basis.up, [0, 0, 1]);
  assert.deepEqual(basis.forward, [1, 0, 0]);
  assert.deepEqual(basis.right, [0, 1, 0]);
  // A wall normal turns "forward" to world-up, so the player looks up the wall.
  const wall = playerBasis([-1, 0, 0]);
  assert.ok(near(wall.forward[2], 1) && near(wall.right[1], 1));
  for (const up of [[0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [0.577, 0.577, 0.577]]) {
    const { up: axis, forward, right } = playerBasis(up);
    assert.ok(near(Math.hypot(...axis), 1));
    for (const vector of [forward, right]) assert.ok(near(vector.reduce((sum, value, index) => sum + value * axis[index], 0), 0));
    assert.ok(near(Math.hypot(...forward), 1) && near(Math.hypot(...right), 1));
  }
  // Broken input never leaves the player without a usable axis.
  assert.deepEqual(upVector(undefined), [0, 0, 1]);
  assert.deepEqual(upVector([0, 0, 0]), [0, 0, 1]);
  assert.deepEqual(upVector([0, 0, 2]), [0, 0, 1]);
});

test('touched surfaces are classified against world-up', () => {
  assert.equal(surfaceKind([0, 0, 1]), 'floor');
  assert.equal(surfaceKind([0, 0, -1]), 'ceiling');
  assert.equal(surfaceKind([-1, 0, 0]), 'wall');
  assert.equal(surfaceKind([0, 1, 0]), 'wall');
  assert.equal(surfaceKind([0.5, 0, 0.5]), 'floor', 'a 45 degree slope is still walkable');
  assert.equal(surfaceKind([0.9, 0, 0.436]), 'wall');
});

test('a gravity change keeps the direction the player was facing', () => {
  const player = { x: 0, y: 0, z: 0, angle: 0, pitch: 0, up: [0, 0, 1] };
  const facing = headingDirection(player);
  assert.ok(near(facing[0], 1));
  // Walking east into a wall whose normal points west: the wall becomes the floor.
  assert.equal(alignUp(player, [-1, 0, 0]), true);
  assert.deepEqual(player.up, [-1, 0, 0]);
  // Facing the wall is degenerate, so the view turns to look up that wall.
  const after = headingDirection(player);
  assert.ok(near(after[2], 1), `looked ${after}`);
  // Aligning again is a no-op, which keeps per-frame rules from jittering the view.
  const angle = player.angle;
  assert.equal(alignUp(player, [-1, 0, 0]), false);
  assert.equal(player.angle, angle);
  // A slanted surface keeps the world direction the player was looking at.
  const slanted = { x: 0, y: 0, z: 0, angle: 0, pitch: 0, up: [0, 0, 1] };
  alignUp(slanted, [0, .7071, .7071]);
  const turned = headingDirection(slanted);
  assert.ok(near(turned[0], 1) && near(turned[1], 0), `kept ${turned}`);
});

test('the eye follows the up axis and the view follows heading and pitch', () => {
  const player = { x: 100, y: -50, z: 10, angle: 0, pitch: 0, up: [0, 0, 1] };
  assert.deepEqual(eyePosition(player), [100, -50, 58]);
  assert.deepEqual(playerCentre(player), [100, -50, 38]);
  const forward = viewDirection(player);
  assert.ok(near(forward[0], 1) && near(forward[2], 0));
  // Standing on a wall, the eye is 20 units off the surface and looks along it.
  assert.deepEqual(eyePosition({ ...player, up: [-1, 0, 0] }), [80, -50, 10]);
  const onWall = viewDirection({ ...player, up: [-1, 0, 0] });
  assert.ok(near(onWall[2], 1), `looked ${onWall}`);
  // Pitch is measured from the player's horizon, so it tilts away from the surface.
  const up = viewDirection({ ...player, up: [-1, 0, 0], pitch: Math.PI / 2 });
  assert.ok(near(up[0], -1), `looked ${up}`);
});

function roomScene(t, configure = () => {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [['a', -128, -128], ['b', 0, -128], ['c', 0, 128], ['d', -128, 128]]
    .map(([id, x, y]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 256, color: '#888888', solid: true, right: side('s0'),
  }));
  project.map.sectors = [{ id: 's0', floorHeight: 0, ceilingHeight: 256, light: 255, sky: false }];
  project.map.entities = [{ ...project.map.entities[0], x: -40, y: 0, angle: 0 }];
  configure(project);
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const tick = (count = 1, keys = new Set(), pressed = new Set()) => {
    for (let i = 0; i < count; i++) stepRuntime(project, state, 1 / 60, keys, i === 0 ? pressed : new Set());
  };
  return { project, state, tick };
}

test('the wall-walking demo script is a valid project and posts the right surfaces', t => {
  const { project, state, tick } = roomScene(t, p => { installWallWalkDemo(p); });
  const sheet = project.eventSheets.find(item => item.name === WALL_WALK_SHEET);
  assert.ok(sheet, 'demo sheet installed');
  assert.equal(project.events.filter(event => event.sheetId === sheet.id).length, 5);
  // Reinstalling replaces only the demo's own rules.
  installWallWalkDemo(project);
  assert.equal(project.events.filter(event => event.sheetId === sheet.id).length, 5);
  tick(30);
  assert.equal(state.physics.grounded, true);
  assert.ok(state.surfaces.some(surface => surface.kind === 'floor'), 'standing on the floor is reported');
  assert.deepEqual(state.player.up, [0, 0, 1]);
});

test('jumping at a wall turns gravity onto it and the player can walk up the wall', t => {
  const { state, tick } = roomScene(t, p => { installWallWalkDemo(p); });
  tick(30);
  const startZ = state.player.z;
  // Jump east into the wall; the demo rule turns gravity onto it while airborne.
  jumpAtWall(state, tick);
  assert.ok(state.player.up[0] < -.9, `gravity now points at the wall: ${state.player.up}`);
  assert.equal(state.player.up[2], 0);
  // The capsule rests on the wall surface, not inside it.
  assert.ok(state.player.x > -30 && state.player.x < -24, `capsule x=${state.player.x}`);
  // Holding forward now climbs the wall instead of pressing into it.
  const climbed = state.player.z;
  tick(45, new Set(['KeyW']));
  assert.ok(state.player.z > climbed + 40, `climbed from ${climbed} to ${state.player.z}`);
  assert.ok(state.player.x > -30 && state.player.x < -24, 'stayed on the wall');
  assert.ok(state.player.z > startZ, 'walking on the wall gained height');
});

test('touching the floor again restores world gravity', t => {
  const { state, tick } = roomScene(t, p => { installWallWalkDemo(p); });
  tick(30);
  jumpAtWall(state, tick);
  assert.ok(state.player.up[0] < -.9);
  // Walking back down the wall brings the real floor into reach, which flips gravity back.
  for (let frame = 0; frame < 240 && state.player.up[2] < .9; frame++) tick(1, new Set(['KeyS']));
  assert.deepEqual(state.player.up, [0, 0, 1]);
  tick(60);
  assert.ok(Math.abs(state.player.z) < 1, `back on the floor at ${state.player.z}`);
});

test('holding F drops the player back to normal gravity from anywhere', t => {
  const { state, tick } = roomScene(t, p => { installWallWalkDemo(p); });
  tick(30);
  jumpAtWall(state, tick);
  assert.ok(state.player.up[0] < -.9);
  tick(2, new Set(['KeyF']));
  assert.deepEqual(state.player.up, [0, 0, 1]);
  tick(120);
  assert.ok(Math.abs(state.player.z) < 1, `fell back to the floor at ${state.player.z}`);
});

test('surface probing only runs for projects whose events can read a surface', t => {
  const plain = roomScene(t);
  plain.tick(5);
  assert.equal(plain.state.surfaces, undefined, 'a project without surface rules never probes');
  assert.equal(projectUsesSurfaces(plain.project), false);

  const walking = roomScene(t, p => { installWallWalkDemo(p); });
  walking.tick(5);
  assert.ok(Array.isArray(walking.state.surfaces), 'the demo project probes every frame');
  assert.equal(projectUsesSurfaces(walking.project), true);

  // Gravity actions alone also need the contacts, even without a surface condition.
  const actionOnly = roomScene(t);
  actionOnly.project.events.push({ id: 'manual', sheetId: undefined, enabled: true, once: false,
    condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'setPlayerGravity', mode: 'world', reach: 8 }] });
  assert.equal(projectUsesSurfaces(actionOnly.project), true);
});

test('gravity orientation is part of the physics snapshot and is validated', t => {
  const { state, tick } = roomScene(t);
  tick(10);
  const snapshot = state.physics.saveState();
  assert.deepEqual(snapshot.up, [0, 0, 1]);
  assert.doesNotThrow(() => validatePhysicsState(snapshot, new Set(state.entities.map(entity => entity.id))));
  assert.doesNotThrow(() => validatePhysicsState({ ...snapshot, up: [-1, 0, 0] }, new Set(state.entities.map(entity => entity.id))));
  assert.throws(() => validatePhysicsState({ ...snapshot, up: [0, 0, 0] }),
    /Invalid physics save: invalid player up axis/);
});
