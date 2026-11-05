import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { importActors } from '../shared/actors.js';
import {
  actorOf, actorStateOf, actorTic, setActorState, labelIndex, hurtActor, runActions, actorTarget,
} from '../shared/actor-runtime.js';
import { createRuntime } from '../shared/runtime.js';

// Actor state machines and their action functions: A_Look, A_Chase, A_FaceTarget,
// A_Pain, A_Scream, A_Fall, A_XScream, missile attacks, A_Explode, A_Jump (label,
// numeric and chance), A_ChangeFlag, A_SetSpeed, A_PlaySound, A_LookEx, custom-state
// jumps and their `fail`/fallback behaviour.
const DECORATE = `
actor Guard 20001
{
  Health 60
  Speed 8
  PainChance 256
  Radius 20
  Height 56
  Monster
  SeeSound "bug/sight"
  PainSound "bug/pain"
  DeathSound "bug/death"
  States
  {
  Spawn:
    POSS AB 10 A_Look
    Loop
  See:
    POSS AABBCCDD 3 A_Chase
    Loop
  Pain:
    POSS H 2
    POSS H 2 A_Pain
    Goto See
  Death:
    POSS I 8 A_Scream
    POSS J 8 A_NoBlocking
    POSS K -1
    Stop
  }
}

actor WakeGuard 20006
{
  Health 60
  Monster
  SeeSound "bug/sight"
  States
  {
  Spawn:
    POSS AB 10 A_Look
    Loop
  See:
    POSS A 3 A_PlaySound("bug/firstsee")
    POSS B 3 A_Chase
    Loop
  }
}

actor Branchy 20002
{
  Health 60
  Monster
  States
  {
  Spawn:
    TNT1 A 1 A_Jump(256, "High")
    Loop
  High:
    TNT1 A 1 A_PosAttack
    Goto Spawn
  Low:
    TNT1 A 1 A_CPosAttack
    Goto Spawn
  }
}

actor NumJump 20004
{
  Health 60
  Monster
  States
  {
  Spawn:
    TNT1 A 1 A_Jump(256, 2)
    TNT1 B 1 A_PlaySound("bug/skip")
    TNT1 C 1 A_PlaySound("bug/land")
    TNT1 D 1
    Goto Spawn
  }
}

actor ZeroJump 20005
{
  Health 60
  Monster
  States
  {
  Spawn:
    TNT1 A 1 A_Jump(0, "Never")
    Loop
  Never:
    TNT1 A 1 A_PosAttack
    Goto Spawn
  }
}

actor LookExy 20003
{
  Health 60
  Monster
  States
  {
  Spawn:
    TNT1 A 10 A_LookEx(0, 0, 0, 0, 360, "WakeUp")
    Loop
  WakeUp:
    TNT1 A 3 A_PlaySound("bug/woke")
    Goto Spawn
  }
}
`;

function room() {
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
    { id: 'guard', type: 'enemy', name: 'Guard', actorName: 'Guard', x: 200, y: 0, elevation: 0, angle: 180, health: 60 },
  ];
  validateProject(project);
  const state = createRuntime(project);
  return { project, state };
}

function spawn(project, state, name, at) {
  const actor = project.actors.find(item => item.name === name);
  const entity = { id: `spawn_${name}`, type: 'enemy', name, actorName: name, health: actor?.health || 20,
    x: at.x, y: at.y, elevation: 0, angle: at.angle ?? 0 };
  state.entities.push(entity);
  setActorState(project, entity, 'Spawn');
  return entity;
}

test('A_Jump to a state label lands on the label first frame, not the frame after it', () => {
  const { project, state } = room();
  const entity = spawn(project, state, 'Branchy', { x: 400, y: 0, angle: 0 });
  const actor = actorOf(project, entity);
  const target = labelIndex(actor, 'High');
  actorTic(project, state, entity);
  assert.equal(actorStateOf(entity).index, target,
    'a label jump must land on the label, otherwise the attack branch is skipped');
});

test('A_Jump numeric offset lands on the intended frame', () => {
  const { project, state } = room();
  const entity = spawn(project, state, 'NumJump', { x: 400, y: 0, angle: 0 });
  actorTic(project, state, entity);
  // Offsets count from the calling state: 2 from frame 0 is the third frame.
  assert.equal(actorStateOf(entity).index, 2, 'the numeric jump must land on the "bug/land" frame');
  actorTic(project, state, entity);
  assert.ok(state.sounds.some(sound => sound.name === 'bug/land'), 'the jumped-to frame runs its action');
  assert.ok(!state.sounds.some(sound => sound.name === 'bug/skip'), 'the skipped frame never runs');
});

test('waking from Spawn enters the first See frame and runs its action', () => {
  const { project, state } = room();
  const entity = spawn(project, state, 'WakeGuard', { x: 200, y: 0, angle: 180 });
  const actor = actorOf(project, entity);
  const see = labelIndex(actor, 'See');
  actorTic(project, state, entity);
  assert.equal(entity.stateLabel, 'See', 'the monster wakes on sight');
  assert.equal(actorStateOf(entity).index, see, 'the machine rests on the first See frame');
  actorTic(project, state, entity);
  assert.ok(state.sounds.some(sound => sound.name === 'bug/firstsee'),
    'the first See frame action runs instead of being skipped');
});

test('A_LookEx reads its arguments in GZDoom order: flags, distances, fov, seestate', () => {
  const { project, state } = room();
  const entity = spawn(project, state, 'LookExy', { x: 200, y: 0, angle: 180 });
  actorTic(project, state, entity);
  assert.equal(entity.stateLabel, 'WakeUp',
    'fov (argument 5) must be read as the view angle and "WakeUp" (argument 6) as the target state');
});

test('A_Jump with chance 0 never jumps', () => {
  const { project, state } = room();
  const entity = spawn(project, state, 'ZeroJump', { x: 400, y: 0, angle: 0 });
  const actor = actorOf(project, entity);
  const spawnIndex = labelIndex(actor, 'Spawn');
  runActions(project, state, entity, actor, [{ name: 'A_Jump', args: [0, 'Never'] }]);
  assert.equal(actorStateOf(entity).index, spawnIndex,
    'chance 0 means the branch is never taken, so the machine stays put');
});

test('A_ChangeFlag changes a live flag the actor AI reads', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const actor = actorOf(project, guard);
  setActorState(project, guard, 'Spawn');
  // Facing away from the player: without LOOKALLAROUND the 180 degree cone misses it.
  guard.angle = 0;
  runActions(project, state, guard, actor, [{ name: 'A_ChangeFlag', args: ['LOOKALLAROUND', true] }]);
  actorTic(project, state, guard);
  assert.equal(guard.stateLabel, 'See',
    'the flag change must be visible to A_Look so the monster sees behind itself');
});

test('A_ClearTarget makes the monster forget who it hunts', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const rival = { id: 'rival', type: 'enemy', name: 'Rival', x: 300, y: 0, elevation: 0, angle: 180, health: 60,
    actorName: 'Guard' };
  state.entities.push(rival);
  guard.targetId = 'rival';
  assert.equal(actorTarget(state, guard), rival, 'the guard starts by hunting the rival');
  runActions(project, state, guard, actorOf(project, guard), [{ name: 'A_ClearTarget', args: [] }]);
  assert.equal(actorTarget(state, guard), state.player, 'a cleared target falls back to the player, not a stale rival');
});

test('a monster plays its pain sound once, not from both the damage call and A_Pain', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  setActorState(project, guard, 'See');
  hurtActor(project, state, guard, 1, state.player);
  assert.equal(guard.stateLabel, 'Pain', 'PainChance 256 always flinches');
  for (let tic = 0; tic < 10; tic++) actorTic(project, state, guard);
  const painSounds = state.sounds.filter(sound => sound.name === 'bug/pain');
  assert.equal(painSounds.length, 1, 'the pain sound is emitted exactly once');
});

test('A_XScream plays the gib sound, not the death scream', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  runActions(project, state, guard, actorOf(project, guard), [{ name: 'A_XScream', args: [] }]);
  assert.ok(state.sounds.some(sound => sound.name === 'misc/gibbed'), 'the gib sound plays');
  assert.ok(!state.sounds.some(sound => sound.name === 'bug/death'), 'the death scream is reserved for A_Scream');
});
