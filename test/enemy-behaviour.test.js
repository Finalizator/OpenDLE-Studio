import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { parseDecorate } from '../shared/decorate.js';
import { importActors } from '../shared/actors.js';
import { actorOf, actorStateOf, actorTic, hurtActor, setActorState, actionSupported, unsupportedActorActions, runActions } from '../shared/actor-runtime.js';
import { canSeeTarget } from '../shared/combat.js';
import { executeSpecial } from '../shared/line-specials.js';
import { createRuntime, stepRuntime, settleGroundActors } from '../shared/runtime.js';

const DECORATE = `
actor Guard 20001
{
  Health 60
  Speed 8
  PainChance 0
  Radius 20
  Height 56
  ReactionTime 8
  Monster
  SeeSound "guard/sight"
  PainSound "guard/pain"
  States
  {
  Spawn:
    POSS AB 10 A_Look
    Loop
  See:
    POSS AABBCCDD 3 A_Chase
    Loop
  Melee:
  Missile:
    POSS E 8 A_FaceTarget
    POSS F 3 A_PosAttack
    POSS F 8 A_PosAttack
    Goto See
  Pain:
    POSS H 2 A_Pain
    Goto See
  Death:
    POSS I 8 A_Scream
    POSS J 8 A_NoBlocking
    POSS K 5
    POSS L -1
    Stop
  }
}
actor Hardy : Guard
{
  Health 100
  PainChance 256
}
`;

function room(configure = () => {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [['a', -512, -512], ['b', 512, -512], ['c', 512, 512], ['d', -512, 512]]
    .map(([id, x, y]) => ({ id, x, y }));
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 128, color: '#888888', solid: true,
    right: { sectorId: 'room', offsetX: 0, offsetY: 0 },
  }));
  project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false }];
  const imported = importActors({ sources: [{ name: 'test.dec', text: DECORATE }], warnings: [] });
  project.actors = imported.actors;
  project.map.entities = [
    { ...project.map.entities.find(entity => entity.type === 'player'), x: 0, y: 0, angle: 0 },
    { id: 'guard', type: 'enemy', name: 'Guard', actorName: imported.actors.find(actor => actor.name === 'Guard').name,
      x: 200, y: 0, elevation: 0, angle: 180, health: 60 },
  ];
  configure(project);
  validateProject(project);
  const state = createRuntime(project);
  return { project, state };
}

test('a bare number survives action parsing, so A_Jump keeps its chance', () => {
  const text = ['actor Brancher 20002', '{', '  States', '  {', '  Missile:',
    '    TNT1 A 1 A_Jump(128, "High", "Low")', '  High:', '    TNT1 A 1 A_PosAttack', '  Low:',
    '    TNT1 A 1 A_CPosAttack', '  }', '}'].join('\n');
  const parsed = parseDecorate(text, { source: 'test.dec' });
  const action = parsed.actors[0].states[0].frames[0].action;
  assert.deepEqual(action.args, [128, 'High', 'Low'], 'the chance argument used to be dropped');
});

test('a monster fires the projectile class it declares, not the built-in one', () => {
  const { project, state } = room(project => {
    // A mod that renamed the imp ball: the built-in name resolves to nothing here.
    project.actors.push({ ...project.actors[0], id: 'actor_renamedball', name: 'RenamedBall', parent: 'Actor', doomedNum: null,
      replaces: null, projectile: null, health: 1000, damage: 8, radius: 6, height: 8, speed: 10,
      states: { frames: [{ kind: 'frame', sprite: 'BAL1', letter: 'A', duration: -1, actions: [] }], labels: {} },
      spritePrefixes: ['BAL1'], flags: { PROJECTILE: true, MISSILE: true }, sounds: {}, drops: [] });
    project.actors.find(actor => actor.name === 'Guard').projectile = 'RenamedBall';
  });
  const guard = state.entities.find(entity => entity.id === 'guard');
  guard.angle = 180;
  const actor = actorOf(project, guard);
  assert.equal(actor.projectile, 'RenamedBall');
  runActions(project, state, guard, actor, [{ name: 'A_TroopAttack', args: [] }]);
  const missile = state.projectiles.find(projectile => projectile.ownerId === 'guard');
  assert.ok(missile, 'the monster fired something');
  assert.equal(project.actors.find(item => item.id === missile.actorId)?.name, 'RenamedBall',
    'the declared class is used, so a renamed projectile is not a silent miss');
  // A monster that declares nothing still uses the class the action was written for.
  const plain = room();
  const plainGuard = plain.state.entities.find(entity => entity.id === 'guard');
  const plainActor = actorOf(plain.project, plainGuard);
  plainActor.projectile = null;
  runActions(plain.project, plain.state, plainGuard, plainActor, [{ name: 'A_TroopAttack', args: [] }]);
  const fallback = plain.state.projectiles.find(projectile => projectile.ownerId === 'guard');
  assert.equal(fallback?.actorName, 'DoomImpBall', 'without a declaration the class the action names is used');
});
test('imported monsters only see what is in front of them unless LOOKALLAROUND', () => {
  const project = createProject();
  project.events = [];
  project.map.entities.push({ id: 'monster', type: 'enemy', name: 'M', x: 100, y: 0, elevation: 0, angle: 0, health: 20, actorName: 'Guard' });
  project.map.entities[0].x = 0; project.map.entities[0].y = 0;
  const state = createRuntime(project);
  const entity = state.entities.find(item => item.id === 'monster');
  // Facing away from the player: 180 degrees does not see it, 360 does.
  entity.angle = 0;
  assert.equal(canSeeTarget(state, entity, state.player, 2048, 180), false);
  assert.equal(canSeeTarget(state, entity, state.player, 2048, 360), true);
});

test('pain interrupts a monster according to its PainChance', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const actor = actorOf(project, guard);
  assert.ok(actor, 'the monster resolved its actor');
  assert.equal(actor.painChance, 0);
  setActorState(project, guard, 'See');
  for (let hit = 0; hit < 20; hit++) hurtActor(project, state, guard, 1, state.player);
  assert.notEqual(guard.stateLabel, 'Pain', 'PainChance 0 never flinches');
  guard.health = 60;
  guard.actorId = actorOf(project, guard) && project.actors.find(item => item.name === 'Hardy').id;
  for (let hit = 0; hit < 5; hit++) hurtActor(project, state, guard, 1, state.player);
  assert.equal(guard.stateLabel, 'Pain', 'PainChance 256 always flinches');
  assert.equal(actorStateOf(guard).reactionTime, 0, 'pain clears the reaction delay');
});

test('damage from one monster makes the victim fight back instead of the player', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const rival = { id: 'rival', type: 'enemy', name: 'Rival', x: 260, y: 0, elevation: 0, angle: 180, health: 60,
    actorName: guard.actorName };
  state.entities.push(rival);
  hurtActor(project, state, guard, 5, rival);
  assert.equal(guard.targetId, 'rival', 'the guard now hunts the rival');
  hurtActor(project, state, guard, 5, state.player);
  assert.equal(guard.targetId, '$player', 'a player hit wins the target back');
  // A dead monster drops its target and stops blocking.
  guard.health = 1;
  guard.solid = true;
  hurtActor(project, state, guard, 10, state.player);
  assert.equal(guard.health, 0);
  assert.equal(guard.solid, false);
});

test('a monster takes the actor it is fighting as its target when it chases', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const rival = { id: 'rival', type: 'enemy', name: 'Rival', x: 260, y: 0, elevation: 0, angle: 180, health: 60,
    actorName: guard.actorName };
  state.entities.push(rival);
  setActorState(project, guard, 'See');
  hurtActor(project, state, guard, 1, rival);
  const startX = guard.x;
  for (let tic = 0; tic < 30; tic++) actorTic(project, state, guard);
  assert.ok(guard.x > startX, 'the guard walked towards its rival, not the player');
});

test('a step of gameplay lets a guard shoot the player it sees', () => {
  const { project, state } = room(project => { project.map.entities[1].angle = 180; });
  const guard = state.entities.find(entity => entity.id === 'guard');
  setActorState(project, guard, 'Missile');
  const before = state.playerStats.health;
  for (let frame = 0; frame < 90; frame++) stepRuntime(project, state, 1 / 60, new Set());
  assert.ok(state.playerStats.health < before, 'the guard landed a shot');
});

test('the reported gaps stay honest about what monsters can run', () => {
  // Monsters execute the shared table, so a decision action is supported there; a
  // weapon has its own switch, so the same name is still a gap for weapons.
  assert.equal(actionSupported('A_Jump', false), true);
  assert.equal(actionSupported('A_JumpIf', false), true);
  assert.equal(actionSupported('A_DefinitelyNotReal', false), false);
  for (const type of unsupportedActorActions(createProject()).map(gap => gap.name))
    assert.equal(actionSupported(type, false), false, `${type} is reported but supported`);
});

test('an actor left below its sector floor is moved back up and reported', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  // A spawn spot or a scripted teleport can hand out a height that is inside the
  // floor; the sprite would be drawn buried in it.
  guard.z = -40;
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(guard.z, 0, 'the actor stands on the sector floor again');
  assert.deepEqual(state.groundCorrections.first, { name: 'Guard', id: 'guard', below: 40 });
  assert.equal(state.groundCorrections.count, 1);
});

test('an actor above its floor and a physics body are left alone', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  guard.z = 24;
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(guard.z, 24, 'a height above the floor is never pulled down');
  assert.equal(state.groundCorrections, undefined);
  // Rigid bodies are simulated by Rapier, which already rests them on the floor, so
  // the correction must not fight the solver.
  const body = { ...guard, id: 'crate', z: -40, physics: { body: 'dynamic' } };
  settleGroundActors({ ...state, entities: [body] });
  assert.equal(body.z, -40);
  assert.equal(settleGroundActors(Object.assign(state, { entities: [{ ...guard, z: -12 }] })), undefined);
});

test('Thing_Spawn places the new actor on the sector floor, not at the spawner height', () => {
  const { project, state } = room();
  const spot = state.entities.find(entity => entity.id === 'guard');
  spot.tid = 7;
  spot.z = 96; // the spot was raised earlier, so its own height is not the floor
  const spawned = [];
  executeSpecial(project, state, 135, [7, 20001, 0, 0, 0], {
    spawn: options => { spawned.push(options); return 1; },
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].z, 0, 'the actor spawns on the floor');
});
