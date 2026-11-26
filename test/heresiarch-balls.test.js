import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { ACTIONS } from '../shared/actor-runtime.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';

const frame = (sprite, letter, duration, actions = [], label) => ({ kind: 'frame', sprite, letter, duration, actions,
  ...(label ? { label } : {}) });

/** The Heresiarch and its satellites, with the state layout the campaign's actor table has. */
function heresiarchProject() {
  const project = installEngineScripts(createProject());
  project.map.vertices = [[-512, -512], [512, -512], [512, 512], [-512, 512]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 512, light: 255, sky: false, tag: 0 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 512, color: '#888888', solid: true }));
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: -400, y: 0, angle: 0 },
    { id: 'boss1', type: 'enemy', x: 300, y: 0, angle: 180, elevation: 0, health: 5000, actorId: 'actor_heresiarch' },
  ];
  const ballStates = { labels: { Spawn: 0, Pain: 17, Death: 20 }, frames: [
    ...Array.from({ length: 16 }, (_, index) => frame('SBMP', 'ABCDEFGHIJKLMNOP'[index], 2,
      [{ name: 'A_SorcBallOrbit', args: [] }], index ? undefined : 'Spawn')),
    { kind: 'loop', label: 'Spawn' },
    frame('SBMP', 'A', 5, [{ name: 'A_SorcBallPop', args: [] }], 'Pain'),
    frame('SBMP', 'B', 2, [{ name: 'A_BounceCheck', args: [] }]),
    { kind: 'wait', label: 'Pain' },
    frame('SBS4', 'D', 5, [{ name: 'A_SorcBallExplode', args: [] }], 'Death'),
    frame('SBS4', 'E', 5, []),
    { kind: 'stop', label: 'Death' },
  ] };
  project.actors = [
    { id: 'actor_heresiarch', name: 'Heresiarch', flags: { MONSTER: true, COUNTKILL: true, NOBLOOD: true },
      health: 5000, speed: 16, radius: 40, height: 110,
      states: { labels: { Spawn: 0, See: 2, Missile: 4 }, frames: [
        frame('SORC', 'A', 3, [], 'Spawn'),
        frame('SORC', 'A', 2, [{ name: 'A_SorcSpinBalls', args: [] }]),
        frame('SORC', 'A', 10, [{ name: 'A_Chase', args: [] }], 'See'),
        { kind: 'loop', label: 'See' },
        frame('SORC', 'F', 6, [{ name: 'A_SpeedBalls', args: [] }], 'Missile'),
        { kind: 'stop' },
      ] } },
    ...['SorcBall1', 'SorcBall2', 'SorcBall3'].map((name, index) => ({ id: `actor_ball${index}`, name,
      flags: { MISSILE: true, NOGRAVITY: true }, health: 0, speed: 10, radius: 5, height: 5, states: ballStates })),
  ];
  const state = createRuntime(project, { screen: 'playing' });
  state.hasGame = true;
  return { project, state };
}

const ctxFor = (project, state, entity) => ({ project, state, entity, actor: null, args: [], named: {} });

/** Runs the actor machine for `tics` tics of 1/35 s. */
const run = (project, state, tics = 35) => {
  for (let tic = 0; tic < tics; tic++) stepRuntime(project, state, 1 / 35, new Set());
};

test('the Heresiarch spins three balls around its head', () => {
  const { project, state } = heresiarchProject();
  const boss = state.entities.find(entity => entity.id === 'boss1');
  ACTIONS.A_SorcSpinBalls(ctxFor(project, state, boss));
  const balls = state.entities.filter(entity => entity.orbit);
  assert.equal(balls.length, 3);
  assert.deepEqual(balls.map(ball => ball.name), ['SorcBall1', 'SorcBall2', 'SorcBall3']);
  // The ring is the caster's radius less twice a ball's, and the balls hang at head height.
  assert.deepEqual(balls.map(ball => ball.orbit.radius), [30, 30, 30]);
  assert.deepEqual(balls.map(ball => ball.orbit.offset), [0, 120, 240]);
  run(project, state, 35);
  for (const ball of balls) {
    const distance = Math.hypot(ball.x - boss.x, ball.y - boss.y);
    assert.ok(Math.abs(distance - 30) < 0.5, `ball ${ball.name} orbits at ${distance}`);
    assert.ok(Math.abs(ball.z - ((boss.z ?? 0) + 110)) < 0.5, `ball ${ball.name} is at head height`);
  }
  // The three keep roughly their spacing: they share one angle and each advances it before it reads
  // it, which is what GZDoom's balls do too, so the ring trails by a ball's step or two.
  const angleOf = ball => Math.atan2(ball.y - boss.y, ball.x - boss.x) * 180 / Math.PI;
  const spread = (a, b) => Math.abs(((angleOf(a) - angleOf(b)) % 360 + 540) % 360 - 180);
  for (const [a, b] of [[balls[0], balls[1]], [balls[1], balls[2]]])
    assert.ok(Math.abs(spread(a, b) - 120) < 45, `spacing ${spread(a, b)}`);
  // And the ring turns: two samples a few tics apart are in different places.
  const before = balls.map(ball => [ball.x, ball.y]);
  run(project, state, 5);
  assert.notDeepEqual(balls.map(ball => [ball.x, ball.y]), before);
  // `A_SpeedBalls` (the caster's Missile state) winds the ring up to 25 degrees a tic, `A_SlowBalls`
  // eases it back to the 7 it starts at, and `A_SorcBossAttack` starts it again.
  assert.equal(boss.sorcSpeed, 7, 'the ring starts at the initial speed');
  ACTIONS.A_SpeedBalls(ctxFor(project, state, boss));
  run(project, state, 20);
  assert.equal(boss.sorcSpeed, 25, `the ring spun up to ${boss.sorcSpeed}`);
  ACTIONS.A_SlowBalls(ctxFor(project, state, boss));
  run(project, state, 40);
  assert.equal(boss.sorcSpeed, 7, `the ring eased back to ${boss.sorcSpeed}`);
  // A_SorcBossAttack accelerates towards the initial speed, which is what "resume spinning" means:
  // a ring already at it stays there, exactly as GZDoom's `args[2] = INITIAL_SPEED` does.
  boss.sorcSpeed = 3;
  ACTIONS.A_SorcBossAttack(ctxFor(project, state, boss));
  run(project, state, 5);
  assert.ok(boss.sorcSpeed > 3, 'and starts turning again');
});

test('the balls survive a save and load again', () => {
  const { project, state } = heresiarchProject();
  const boss = state.entities.find(entity => entity.id === 'boss1');
  ACTIONS.A_SorcSpinBalls(ctxFor(project, state, boss));
  run(project, state, 10);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, 'balls')));
  const restored = restoreGameSave(project, record, 'balls').runtime;
  const balls = restored.entities.filter(entity => entity.orbit);
  assert.equal(balls.length, 3);
  assert.deepEqual(balls.map(ball => ball.orbit.of), ['boss1', 'boss1', 'boss1']);
});

test('killing the caster pops the balls, and five seconds later they burst', () => {
  const { project, state } = heresiarchProject();
  const boss = state.entities.find(entity => entity.id === 'boss1');
  ACTIONS.A_SorcSpinBalls(ctxFor(project, state, boss));
  const balls = state.entities.filter(entity => entity.orbit);
  boss.health = 0;
  run(project, state, 4);
  for (const ball of balls) {
    assert.equal(ball.orbit, null, 'a ball whose caster is dead leaves the ring');
    assert.ok(ball.sorcBounce, 'and is thrown clear with a bounce timer');
  }
  // Five seconds of bouncing at 35 tics a second, then the blast takes the ball out of the level.
  run(project, state, 35 * 6);
  for (const ball of balls) assert.equal(ball.removed, true, `${ball.name} bursts and is gone`);
  assert.equal(state.entities.some(entity => /^SorcBall/.test(entity.name || '')), false,
    'no satellite is left behind');
});
