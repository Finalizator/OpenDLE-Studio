// The attack action pointers of the classic cast, on a room with a player in it.
//
// A pointer that does not exist is not an error in this engine: the frame runs, the name is
// recorded as unsupported, and nothing happens. That is how the Spider Mastermind — the biggest
// boss in Doom II — came to stand in front of the player firing nothing, and how killing a Pain
// Elemental stopped producing the three Lost Souls it is famous for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { runActions } from '../shared/actor-runtime.js';

const action = name => ({ name, args: [], named: {} });
const frame = (sprite, letter, duration, actions, label) => ({ kind: 'frame', sprite, letter, duration, bright: false, actions, label });
const stop = label => ({ kind: 'stop', target: null, label });
const labels = frames => Object.fromEntries(frames.map((entry, index) => [entry.label, index]).reverse());

/** An actor record shaped the way the DECORATE compiler leaves one. */
const actorOf = (name, health, states, flags = {}) => ({
  id: `actor_${name.toLowerCase()}`, name, doomedNum: null, health, flags,
  radius: 20, height: 56, speed: 8, alpha: 1, renderStyle: 'Normal', spritePrefixes: [], sounds: {},
  states: { frames: states, labels: labels(states) },
});

/** One open room, a player on the right, a monster on the left. */
function room(monsterName, { distance = 120, actions = ['A_Look'] } = {}) {
  const project = createProject();
  project.events = [];
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: 0, y: 0, angle: 180 },
    { id: 'monster', type: 'enemy', name: monsterName, actorName: monsterName, x: -distance, y: 0, angle: 0, health: 100 },
  ];
  project.map.entities = [{ ...project.map.entities[0], x: 0 }, { ...project.map.entities[1] }];
  project.actors = [actorOf(monsterName, 100, [
    frame('TNT1', 'A', 10, actions.map(action), 'Spawn'),
    stop('Spawn'),
    frame('TNT1', 'A', 1, [], 'See'),
    stop('See'),
    frame('TNT1', 'A', 10, [action('A_PainDie')], 'Death'),
    stop('Death'),
  ], { MONSTER: true, SHOOTABLE: true, SOLID: true })];
  validateProject(project);
  const state = createRuntime(project);
  const monster = state.entities.find(entity => entity.id === 'monster');
  const tick = (count = 1) => { for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 35, new Set()); };
  return { project, state, monster, tick };
}

test('the Spider Mastermind attack the imported states call actually fires', () => {
  for (const name of ['A_SPosAttackUseAtkSound', 'A_SposAttackUseAtkSound']) {
    const { project, state, monster, tick } = room('SpiderMastermind');
    tick();
    const before = state.playerStats.health;
    // Pointed at the player, so the three hitscan pellets are aimed at them.
    monster.angle = Math.atan2(state.player.y - monster.y, state.player.x - monster.x) * 180 / Math.PI;
    runActions(project, state, monster, project.actors[0], [{ name, args: [], named: {} }]);
    assert.ok(state.playerStats.health < before, `${name} hurt the player (${before} -> ${state.playerStats.health})`);
    assert.equal(state.actorUnsupported?.has(name) ?? false, false, `${name} is a real action`);
    assert.ok(state.sounds.some(sound => /DSSHOTGN/i.test(sound.name)), 'and it is heard');
  }
});

test('A_SpidRefire stops firing at something it can no longer see', () => {
  const { project, state, monster, tick } = room('SpiderMastermind');
  tick();
  state.playerStats.health = 100;
  // Behind a wall would be a longer test; no sight at all is the same branch, and it is the one
  // that keeps a monster from shooting through a level.
  state.player.x = 100000; state.player.y = 100000;
  runActions(project, state, monster, project.actors[0], [{ name: 'A_SpidRefire', args: [], named: {} }]);
  assert.equal(monster.stateLabel, 'See', 'back to the walk state');
});

test('the Revenant punch lands in melee range and not outside it', () => {
  const near = room('Revenant', { distance: 40 });
  near.tick();
  near.monster.angle = 0;
  const before = near.state.playerStats.health;
  runActions(near.project, near.state, near.monster, near.project.actors[0], [{ name: 'A_SkelFist', args: [], named: {} }]);
  assert.ok(near.state.playerStats.health < before, `the punch hurt (${before} -> ${near.state.playerStats.health})`);
  assert.ok(near.state.sounds.some(sound => /skeleton\/melee/i.test(sound.name)), 'with its own sound');

  const far = room('Revenant', { distance: 200 });
  far.tick();
  far.monster.angle = 0;
  const untouched = far.state.playerStats.health;
  runActions(far.project, far.state, far.monster, far.project.actors[0], [{ name: 'A_SkelFist', args: [], named: {} }]);
  assert.equal(far.state.playerStats.health, untouched, 'and out of reach nothing happens');
});

test('a dead Pain Elemental lets three Lost Souls out', () => {
  const project = createProject();
  project.events = [];
  project.map.entities = [
    { ...project.map.entities[0], x: 0, y: 0 },
    { id: 'pain', type: 'enemy', name: 'PainElemental', actorName: 'PainElemental', x: 200, y: 0, angle: 0, health: 100 },
  ];
  project.actors = [
    actorOf('PainElemental', 100, [
      frame('TNT1', 'A', 10, [], 'Spawn'), stop('Spawn'),
      frame('TNT1', 'A', 4, [action('A_PainDie')], 'Death'), stop('Death'),
    ], { MONSTER: true, SHOOTABLE: true, SOLID: true }),
    actorOf('LostSoul', 100, [
      frame('TNT1', 'A', 10, [], 'Spawn'), stop('Spawn'),
      frame('TNT1', 'A', 10, [], 'See'), stop('See'),
    ], { MONSTER: true, SHOOTABLE: true, SOLID: true }),
  ];
  validateProject(project);
  const state = createRuntime(project);
  const pain = state.entities.find(entity => entity.id === 'pain');
  for (let frame = 0; frame < 4; frame++) stepRuntime(project, state, 1 / 35, new Set());
  const before = state.entities.filter(entity => entity.actorName === 'LostSoul').length;
  assert.equal(before, 0, 'nothing spawned while it was alive');
  pain.health = 0;
  for (let frame = 0; frame < 10; frame++) stepRuntime(project, state, 1 / 35, new Set());
  const souls = state.entities.filter(entity => entity.actorName === 'LostSoul');
  assert.equal(souls.length, 3, 'three of them, as Doom does');
  assert.equal(pain.solid, false, 'and the corpse stops blocking');
});

test('the heavy monsters make their own noises', () => {
  const sounds = {
    A_SkelWhoosh: /skeleton\/swing/i, A_Metal: /spider\/walk/i, A_BabyMetal: /baby\/walk/i,
    A_Hoof: /cyber\/hoof/i, A_FatRaise: /fatso\/raiseguns/i,
  };
  for (const [name, pattern] of Object.entries(sounds)) {
    const { project, state, monster, tick } = room('Fatso');
    tick();
    runActions(project, state, monster, project.actors[0], [{ name, args: [], named: {} }]);
    assert.ok(state.sounds.some(sound => pattern.test(sound.name)), `${name} is heard`);
  }
});
