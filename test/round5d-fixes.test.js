import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime } from '../shared/runtime.js';
import { ACTIONS, hurtActor, weaponAttackFor, actionSupported } from '../shared/actor-runtime.js';
import { advanceProjectiles } from '../shared/combat.js';

/** A square room with a player and nothing else; the caller adds what it wants to watch. */
function room(entities = []) {
  const project = installEngineScripts(createProject());
  project.map.vertices = [[-256, -256], [256, -256], [256, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 256, light: 255, sky: false, tag: 0 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 256, color: '#888888', solid: true }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -200, y: 0, angle: 0 }, ...entities];
  const state = createRuntime(project, { screen: 'playing' });
  state.hasGame = true;
  return { project, state };
}

const ctxFor = (project, state, entity, actor = null) => ({ project, state, entity, actor, args: [], named: {} });

test('a frozen corpse holds its frame far longer and stops blocking the level', () => {
  const { project, state } = room([{ id: 'guard1', type: 'enemy', x: 64, y: 0, angle: 180, health: 20 }]);
  const guard = state.entities.find(entity => entity.id === 'guard1');
  guard.actorState = { index: 0, tics: 5, target: null, threshold: 0, reactionTime: 0, moveDir: -1,
    flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  guard.solid = true;
  ACTIONS.A_FreezeDeath(ctxFor(project, state, guard));
  // GZDoom adds 75 + 3*(P_Random()&7) + 4 tics to the frame that calls it.
  assert.ok(guard.actorState.tics >= 84 && guard.actorState.tics <= 105, `tics ${guard.actorState.tics}`);
  assert.equal(guard.solid, false);
  assert.equal(guard.noBlockmap, true);
  assert.ok(state.sounds.some(sound => sound.name === 'misc/freeze'));
});

test('the ice body shatters and leaves the level', () => {
  const { project, state } = room([{ id: 'guard1', type: 'enemy', x: 64, y: 0, angle: 180, health: 0 }]);
  const guard = state.entities.find(entity => entity.id === 'guard1');
  guard.vx = 3;   // a body still sliding gets three tics of warning before it breaks up
  guard.actorState = { index: 0, tics: 8, target: null, threshold: 0, reactionTime: 0, moveDir: -1,
    flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  ACTIONS.A_FreezeDeathChunks(ctxFor(project, state, guard));
  assert.equal(guard.removed, undefined);
  ACTIONS.A_FreezeDeathChunks(ctxFor(project, state, guard));
  assert.equal(guard.removed, true);
  assert.ok(state.sounds.some(sound => sound.name === 'misc/freeze'));
});

test('Hexen keeps 64 corpses and destroys the oldest past that', () => {
  const sixtyFour = Array.from({ length: 64 }, (_, index) => ({ id: `corpse${index}`, type: 'enemy', x: -200 + index,
    y: 64, angle: 0, health: 0 }));
  const { project, state } = room(sixtyFour);
  for (const corpse of state.entities.filter(entity => entity.type === 'enemy'))
    ACTIONS.A_QueueCorpse(ctxFor(project, state, corpse));
  assert.equal(state.entities.filter(entity => entity.queuedCorpse).length, 64);
  assert.equal(state.entities.some(entity => entity.removed), false, '64 corpses fit in the queue');

  // The sixty-fifth pushes the oldest out, exactly as `while (corpsequeue.Size() >= size) Destroy()`.
  const last = room(Array.from({ length: 65 }, (_, index) => ({ ...sixtyFour[0], id: `corpse${index}`,
    x: -200 + index })));
  for (const corpse of last.state.entities.filter(entity => entity.type === 'enemy'))
    ACTIONS.A_QueueCorpse(ctxFor(last.project, last.state, corpse));
  const removed = last.state.entities.filter(entity => entity.removed);
  assert.deepEqual(removed.map(entity => entity.id), ['corpse0'], 'the oldest body goes first');
});

test('the player screams with the sound that matches the corpse', () => {
  const { project, state } = room();
  // The runtime clamps the player's health at zero, so the health the scream is chosen by is the
  // one the body died with: `-50` is Doom's boundary between a normal death and a mangled one.
  for (const [health, expected] of [[-10, '*death'], [-60, '*crazydeath'], [-150, '*xdeath']]) {
    state.sounds.length = 0;
    ACTIONS.A_PlayerScream({ ...ctxFor(project, state, state.player), entity: { ...state.player, health },
      actor: null });
    assert.ok(state.sounds.some(sound => sound.name === expected), `${health} must scream ${expected}`);
  }
  // A class that declares its own DeathSound is obeyed instead of Doom's picks.
  state.sounds.length = 0;
  ACTIONS.A_PlayerScream({ ...ctxFor(project, state, state.player), entity: { ...state.player, health: 0 },
    actor: { sounds: { death: 'player/male/death1' } } });
  assert.deepEqual(state.sounds.map(sound => sound.name), ['player/male/death1']);
});

test('a Stalker rises 96 above the floor instead of standing in front of the player', () => {
  const { project, state } = room([{ id: 'stalker1', type: 'enemy', x: 64, y: 0, angle: 180, elevation: 0,
    health: 90, height: 56, z: 0 }]);
  const stalker = state.entities.find(entity => entity.id === 'stalker1');
  stalker.actorState = { index: 0, tics: 5, target: null, threshold: 0, reactionTime: 0, moveDir: -1,
    flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  for (let tic = 0; tic < 200; tic++) ACTIONS.A_SentinelBob(ctxFor(project, state, stalker));
  assert.equal(stalker.z, 96);
  // `threshold` is A_SentinelBob's own pause flag: while it is set the height is left alone.
  stalker.actorState.threshold = 1;
  stalker.z = 40;
  ACTIONS.A_SentinelBob(ctxFor(project, state, stalker));
  assert.equal(stalker.z, 40);
});

test('the Centaur Lord shield takes no damage until the Lord drops it to charge', () => {
  const { project, state } = room([{ id: 'lord1', type: 'enemy', x: -170, y: 0, angle: 0, health: 250 }]);
  const lord = state.entities.find(entity => entity.id === 'lord1');
  ACTIONS.A_SetReflectiveInvulnerable(ctxFor(project, state, lord));
  assert.deepEqual([lord.invulnerable, lord.reflective], [true, true]);
  assert.equal(hurtActor(project, state, lord, 100, state.player), false);
  assert.equal(lord.health, 250, 'a shield up means no damage at all');
  // Inside melee range a roll under 32 drops the shield and sends the Lord into its Melee state.
  lord.states = { labels: { Melee: 0 }, frames: [{ kind: 'frame', sprite: 'CENT', letter: 'A', duration: 4, actions: [] }] };
  lord.actorId = null;
  let dropped = false;
  for (let attempt = 0; attempt < 64 && !dropped; attempt++) {
    ACTIONS.A_SetReflectiveInvulnerable(ctxFor(project, state, lord));
    ACTIONS.A_CentaurDefend(ctxFor(project, state, lord));
    dropped = lord.invulnerable === false;
  }
  assert.equal(dropped, true, 'the shield comes down when the Lord charges');
  ACTIONS.A_UnsetReflectiveInvulnerable(ctxFor(project, state, lord));
  assert.deepEqual([lord.invulnerable, lord.reflective], [false, false]);
});

test('a missile that reaches a reflective thing flies back the way it came', () => {
  const { state } = room([{ id: 'lord1', type: 'enemy', x: 64, y: 0, angle: 180, health: 250 }]);
  const lord = state.entities.find(entity => entity.id === 'lord1');
  lord.reflective = true;
  state.projectiles = [{ id: 1, ownerId: '$player', x: 0, y: 0, z: 32, dx: 1, dy: 0, dz: 0, age: 0,
    speed: 700, damage: 5, diceSides: 8, radius: 0 }];
  advanceProjectiles(state, 0.2, null, null);
  const [bounced] = state.projectiles;
  assert.ok(bounced, 'the shot is not consumed');
  assert.equal(bounced.ownerId, lord.id, 'and it belongs to the thing it bounced off');
  assert.equal(bounced.dx, -1, 'flying the other way');
  assert.equal(lord.health, 250);
});

test('A_FireOldBFG throws two plasma balls with their own spread and no autoaim', () => {
  assert.equal(actionSupported('A_FireOldBFG', true), true);
  const project = createProject();
  project.actors = ['PlasmaBall1', 'PlasmaBall2'].map((name, index) => ({ id: `actor_pb${index}`, name,
    flags: { MISSILE: true }, damage: 5, speed: 25, radius: 13, height: 8,
    states: { labels: { Spawn: 0 }, frames: [{ kind: 'frame', sprite: 'PLSS', letter: 'A', duration: 1, actions: [] }] } }));
  const { attack } = weaponAttackFor(project, 'A_FireOldBFG');
  assert.equal(attack.volley.length, 2);
  assert.deepEqual(attack.volley.map(shot => shot.missile), ['PlasmaBall1', 'PlasmaBall2']);
});
