import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  DOOM_FRICTION, MAXBOB, PLAYER_SPEED, VIEW_BOB_STEP, advanceMomentum, bobFor, momentumSpeed, terminalSpeed,
  thrustFor, thrustTowards, turnStep, weaponBob, viewBob,
} from '../shared/player-motion.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { importWad } from '../server/import.js';

// The numbers in shared/player-motion.js come from GZDoom traces; these tests pin the model
// they describe, so a future change to it fails here rather than in a playtest.
test('Doom' + String.fromCharCode(39) + 's thrust and friction reach the speeds GZDoom was measured at', () => {
  const settle = (input, options) => {
    let momentum = { x: 0, y: 0, z: 0 };
    const thrust = thrustFor(input, options);
    for (let tic = 0; tic < 400; tic++) momentum = advanceMomentum(momentum, { x: thrust.forward, y: 0, z: thrust.side });
    return Math.hypot(momentum.x, momentum.z);
  };
  // A walk settles at 8.333 units a tic and a run at twice that: the values the trace of a
  // demo holding forward settles at in GZDoom, and 291.6 / 583.2 units a second.
  assert.ok(Math.abs(settle({ forward: 1 }) - 8.3333) < .001, `walk ${settle({ forward: 1 })}`);
  assert.ok(Math.abs(settle({ forward: 1 }, { run: true }) - 16.6667) < .001);
  assert.ok(Math.abs(settle({ side: 1 }) - 8) < .001, 'strafe is its own, slightly lower speed');
  assert.ok(Math.abs(terminalSpeed() * 35 - PLAYER_SPEED.walk) < .01, 'the sheet asks for the measured speed');
});

test('the first tic of a walk is one thrust, and releasing the key coasts down by friction', () => {
  let momentum = advanceMomentum({ x: 0, y: 0, z: 0 }, { x: thrustFor({ forward: 1 }).forward, y: 0, z: 0 });
  // GZDoom reports 0.781 for the first tic of a walk: one thrust, no friction applied yet.
  assert.ok(Math.abs(momentum.x - 0.78125) < 1e-9, `first tic ${momentum.x}`);
  const held = momentum.x;
  for (let tic = 0; tic < 5; tic++) momentum = advanceMomentum(momentum, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(momentum.x - held * DOOM_FRICTION ** 5) < 1e-9, 'coasting multiplies by friction');
  // Below Doom's stop speed the momentum is dropped rather than left creeping for ever.
  for (let tic = 0; tic < 60; tic++) momentum = advanceMomentum(momentum, { x: 0, y: 0, z: 0 });
  assert.equal(momentum.x, 0);
});

test('airborne momentum keeps its speed and gains only a 256th of the thrust', () => {
  const thrust = { x: thrustFor({ forward: 1 }).forward, y: 0, z: 0 };
  let ground = { x: 0, y: 0, z: 0 };
  for (let tic = 0; tic < 20; tic++) ground = advanceMomentum(ground, thrust);
  const airborne = advanceMomentum(ground, thrust, { grounded: false });
  assert.ok(airborne.x > ground.x && airborne.x - ground.x < ground.x * .01, 'a jump keeps its speed');
});

test('a scripted speed becomes the thrust that settles at it', () => {
  const thrust = thrustTowards({ forward: 300 });
  let momentum = { x: 0, y: 0, z: 0 };
  for (let tic = 0; tic < 400; tic++) momentum = advanceMomentum(momentum, { x: thrust.forward, y: 0, z: 0 });
  assert.ok(Math.abs(momentum.x * 35 - 300) < .5, `settles at ${momentum.x * 35} units a second`);
  assert.ok(Math.abs(momentumSpeed({ x: 1, y: 0, z: 0 }).x - 35) < 1e-9, 'a tic is a 35th of a second');
});

test('a held turn starts at half rate and the state machine turns it the Doom way', () => {
  const slow = turnStep(0), fast = turnStep(10);
  assert.ok(Math.abs(slow - fast / 2) < 1e-9, 'the first six tics are half speed');
  assert.ok(Math.abs(fast * 65536 / (2 * Math.PI) - 640) < 1e-9, 'and then 640/65536 of a turn');
});

test('the weapon and the view bob with the player' + String.fromCharCode(39) + 's speed, capped at 16', () => {
  assert.equal(bobFor({ x: 0, y: 0, z: 0 }), 0, 'standing still does not bob');
  // `movebob` is a quarter, so a walk of 4.57 units a tic bobs by 5.2 and only a run reaches
  // the cap of 16. Leaving the quarter out made a walking weapon swing three times too far.
  assert.ok(Math.abs(bobFor({ x: 4.571, y: 0, z: 0 }) - 5.22) < .01);
  assert.equal(bobFor({ x: 8.333, y: 0, z: 0 }), MAXBOB);
  assert.ok(Math.abs(bobFor({ x: 2, y: 1, z: 0 }) - 1.25) < 1e-9);
  // GZDoom's own trace: walking, it reported bob = 10.9 while the player moved 6.6 units a
  // tic. That is the same formula, and this pins it.
  assert.ok(Math.abs(bobFor({ x: 6.6, y: 0, z: 0 }) - 10.89) < .02);
  // Doom swings the weapon on a cosine in x and a sine in y, so it is furthest sideways when
  // it is level, and level when it is furthest sideways.
  const level = weaponBob(10, 1);
  assert.ok(Math.abs(level.x - 10) < 1e-9 && Math.abs(level.y) < 1e-9, 'starts level and to the side');
  const swung = weaponBob(10, 17);
  assert.ok(swung.y > 9 && swung.y <= 10, `swung to ${swung.y}`);
  assert.deepEqual(weaponBob(0, 40), { x: 0, y: 0 }, 'no speed, no swing');
  assert.equal(viewBob(0, 40), 0);
  // `ViewBobSpeed 20` makes the view swing eighteen degrees a tic, six times faster than the
  // third of a degree this used before.
  assert.ok(Math.abs(viewBob(16, 30) - 16 * Math.sin(30 * 18 * Math.PI / 180) * .5) < 1e-9);
  assert.ok(Math.abs(VIEW_BOB_STEP - 18) < 1e-9);
});

test('a shot that hits a wall leaves a mark on it, and enough shots do not grow without end', { skip: !existsSync(fixtureWad()) }, () => {
  const project = importWad(readFileSync(fixtureWad()), 'MAP01').project;
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  for (let i = 0; i < 40; i++) stepRuntime(project, state, 1 / 35, new Set());
  const marks = () => state.impacts.filter(effect => effect.decal?.assetId === 'builtin:bullethole');
  // Face each wall in turn and fire; the pistol hits nothing in an empty corridor, so the
  // bullet lands on the wall behind.
  for (const degrees of [0, 90, 180, 270]) {
    state.player.angle = degrees * Math.PI / 180;
    for (let i = 0; i < 24; i++) stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
  }
  assert.ok(marks().length >= 4, `four directions left ${marks().length} marks`);
  const mark = marks().at(-1);
  assert.equal(mark.decal.corners.length, 4, 'the mark is a clipped quad on the wall face');
  for (const corner of mark.decal.corners) assert.ok(corner.every(Number.isFinite));
});

function fixtureWad() {
  return new URL('../Projects/freedoom2.wad', import.meta.url);
}
