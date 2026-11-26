// MAP30's finale, end to end.
//
// Doom's last boss is three classes with no MF_MONSTER between them: a head that is shot until it
// dies, an invisible eye that spits skull cubes at marker spots, and the spots themselves. The
// classes' own states call A_Brain*, so the engine runs the fight from the data — these tests use
// the same state records an import produces and watch the whole sequence happen.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createProject, validateProject } from '../shared/project.js';
import { buildVanillaActors, isBossBrainActor } from '../shared/actors.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hurtActor } from '../shared/actor-runtime.js';

const action = name => ({ name, args: [], named: {} });
const frame = (sprite, letter, duration, actions, label) =>
  ({ kind: 'frame', sprite, letter, duration, bright: false, actions, label });
const loop = label => ({ kind: 'loop', target: null, targetIndex: 0, label });
const wait = (label, targetIndex) => ({ kind: 'wait', target: null, targetIndex, label });
const stop = label => ({ kind: 'stop', target: null, label });

/** An actor record in the shape the DECORATE compiler produces, labels included. */
const actorOf = (name, doomedNum, health, frames, flags = {}) => ({
  id: `actor_${name.toLowerCase()}`, name, doomedNum, health, flags, radius: 16, height: 40, speed: 10,
  alpha: 1, renderStyle: 'Normal', spritePrefixes: [], sounds: {},
  states: { frames, labels: Object.fromEntries(frames.map((entry, index) => [entry.label, index]).reverse()) },
});

const bossActors = () => [
  actorOf('BossBrain', 88, 250, [
    frame('BBRN', 'A', -1, [], 'Spawn'),
    stop('Spawn'),
    frame('BBRN', 'B', 36, [action('A_BrainPain')], 'Pain'),
    { kind: 'goto', target: 'Spawn', targetIndex: 0, label: 'Pain' },
    frame('BBRN', 'A', 6, [action('A_BrainScream')], 'Death'),
    frame('BBRN', 'A', 10, [], 'Death'),
    frame('BBRN', 'A', 10, [], 'Death'),
    frame('BBRN', 'A', -1, [action('A_BrainDie')], 'Death'),
    stop('Death'),
  ], { SOLID: true, SHOOTABLE: true }),
  actorOf('BossEye', 89, 0, [
    frame('SSWV', 'A', 10, [action('A_Look')], 'Spawn'),
    loop('Spawn'),
    frame('SSWV', 'A', 6, [action('A_BrainAwake')], 'See'),
    frame('SSWV', 'A', 6, [action('A_BrainSpit')], 'See'),
    wait('See', 3),
  ], { NOBLOCKMAP: true, NOSECTOR: true, LOOKALLAROUND: true }),
  actorOf('BossTarget', 87, 0, [stop('Spawn')], { NOBLOCKMAP: true, NOSECTOR: true }),
  actorOf('SpawnShot', 90, 0, [
    frame('BOSF', 'A', 3, [action('A_SpawnSound')], 'Spawn'),
    frame('BOSF', 'B', 3, [action('A_SpawnFly')], 'Spawn'),
    frame('BOSF', 'C', 3, [action('A_SpawnFly')], 'Spawn'),
    loop('Spawn'),
  ], { NOCLIP: true, MISSILE: true, NOGRAVITY: true }),
  actorOf('SpawnFire', 91, 0, [frame('FIRE', 'A', 4, [], 'Spawn'), stop('Spawn')], { NOBLOCKMAP: true }),
  // The spawn table resolves names, so a replaced class would be the one that appears.
  { ...buildVanillaActors().find(actor => actor.name === 'DoomImp'), flags: { ...buildVanillaActors().find(actor => actor.name === 'DoomImp').flags } },
];

function bossLevel() {
  const project = createProject();
  project.events = [];
  project.actors = bossActors();
  project.map.entities.push(
    // Sight needs to pass through the level, so everything stands in the start room rather than
    // in the void where the default project's sector ends.
    { id: 'brain', name: 'BossBrain', type: 'decoration', doomType: 88, x: 200, y: 0, angle: 0 },
    { id: 'eye', name: 'BossEye', type: 'decoration', doomType: 89, x: 100, y: 0, angle: 180 },
    { id: 'spot1', name: 'BossTarget', type: 'decoration', doomType: 87, x: 300, y: 0, angle: 0 },
    { id: 'spot2', name: 'BossTarget', type: 'decoration', doomType: 87, x: -300, y: 0, angle: 0 },
  );
  validateProject(project);
  const state = createRuntime(project);
  const finish = [], heard = [];
  state.finishLevel = exit => finish.push(exit);
  // The runtime drains `state.sounds` every frame (the audio layer consumes them), so a sound is
  // only observable on the tic it was played.
  const tick = () => { stepRuntime(project, state, 1 / 35, new Set()); for (const sound of state.sounds) heard.push(sound.name); };
  return { project, state, tick, finish, heard };
}

test('the Icon of Sin is a live actor even in a level imported before it was one', () => {
  const { state } = bossLevel();
  // Both classes come out of the level file typed as decorations; their states are the fight.
  assert.equal(state.entities.find(entity => entity.id === 'brain').type, 'enemy');
  assert.equal(state.entities.find(entity => entity.id === 'eye').type, 'enemy');
  assert.equal(state.entities.find(entity => entity.id === 'spot1').type, 'decoration');
  assert.equal(isBossBrainActor(state.entities.find(entity => entity.id === 'brain')), false,
    'the runtime works from the actor record, not from the entity');
});

test('the spitter wakes, aims a cube at a spot and the cube lands as a monster', () => {
  const { project, state, tick, heard } = bossLevel();
  const cube = () => state.entities.find(entity => entity.actorName === 'SpawnShot');
  // A_Look needs the player in front of the eye.
  for (let tic = 0; tic < 60 && !cube(); tic++) tick();
  const flying = cube();
  assert.ok(flying, 'the eye spat a cube');
  assert.ok(flying.flight, 'and the cube is on its way to a spot');
  assert.ok(['spot1', 'spot2'].includes(flying.bossTargetId), 'aimed at one of the marker spots');
  assert.equal(state.entities.filter(entity => entity.actorName === 'BossShot').length, 0);

  // Fly it out: the distance decides the flight time, so this is not a fixed frame count.
  const tics = flying.flight.tics;
  for (let tic = 0; tic < tics + 12 && cube(); tic++) tick();
  assert.equal(cube(), undefined, 'the cube is gone once it lands');
  const monster = state.entities.find(entity => entity.actorName === 'DoomImp' && entity.id.startsWith('spawned_'));
  assert.ok(monster, 'a monster stepped out of the fire');
  const spot = state.entities.find(entity => entity.id === flying.bossTargetId);
  const other = state.entities.find(entity => entity.id !== flying.bossTargetId && entity.doomType === 87);
  assert.ok(Math.hypot(monster.x - spot.x, monster.y - spot.y) < 24, 'at the spot it was aimed at');
  assert.ok(Math.hypot(monster.x - other.x, monster.y - other.y) > 200, 'and not at the other one');
  assert.ok(heard.some(name => /DSTELEPT/i.test(name)), 'with a teleport sound');
  assert.ok(project.actors.some(actor => actor.name === 'DoomImp'), 'from the project own table');
});

test('the head screams, explodes and ends the level when it is shot to death', () => {
  const { project, state, tick, finish, heard } = bossLevel();
  const brain = state.entities.find(entity => entity.id === 'brain');
  for (let tic = 0; tic < 4; tic++) tick();
  assert.equal(hurtActor(project, state, brain, 250, null), true, 'the brain can be shot');
  for (let tic = 0; tic < 40; tic++) tick();
  assert.deepEqual(finish, ['normal'], 'its last frame exits the level, like G_ExitLevel');
  assert.equal(state.bossDefeated, true);
  // The fixtures carry no artwork, so `spawnEffect` has nothing to draw with; the death scream's
  // own sound proves the sequence ran, and the effects path is covered by the projectile tests.
  assert.ok(heard.some(name => /DSBOSDTH/i.test(name)), 'the scream plays');
});

test('every boss action pointer the fight needs is implemented, not a stub', () => {
  // A stub that returns silently is how MAP30 came to do nothing at all: the states ran, and
  // nothing happened. Each name below must exist and must not be an empty body.
  const source = readFileSync(new URL('../shared/actor-runtime.js', import.meta.url), 'utf8');
  for (const name of ['A_BrainAwake', 'A_BrainSpit', 'A_BrainPain', 'A_BrainScream',
    'A_BrainExplode', 'A_BrainDie', 'A_SpawnSound', 'A_SpawnFly']) {
    const definition = new RegExp(`${name}\\(ctx\\) \\{[\\s\\S]*?\\n  \\},`);
    const body = source.match(definition);
    assert.ok(body, `${name} is implemented`);
    assert.doesNotMatch(body[0], new RegExp(`${name}\\((?:ctx)?\\) \\{\\},`), `${name} is not a stub`);
  }
});

test('the level exit the head calls is the same transition an exit line uses', () => {
  const source = readFileSync(new URL('../shared/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /Object\.defineProperty\(state, 'finishLevel'/);
  assert.match(source, /value: exit => beginIntermission\(project, state, exit === 'secret'\)/);
  // A function on the state is a save that cannot be written, so it must stay non-enumerable.
  assert.match(source, /enumerable: false, configurable: true, writable: true/);
});
