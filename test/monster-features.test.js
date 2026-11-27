import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { ACTIONS, hurtActor, explodeAt, restoreBlocking } from '../shared/actor-runtime.js';
import { spritePlacement } from '../shared/entity-visuals.js';
import { importActors } from '../shared/actors.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

// The campaign's own actor table: these tests are about the monsters the game ships, not fixtures.
const campaign = new URL('../data/projects/imported-wad-game/actors.json', import.meta.url);
const table = existsSync(campaign) ? JSON.parse(readFileSync(campaign, 'utf8')) : null;
const ACTOR_TABLE = table ? table.actors || table : [];
const skip = ACTOR_TABLE.length ? false : 'the imported campaign is not on this machine';

/** A 1024-unit square room with the player at the west wall and one monster in the middle. */
function room(monsterName) {
  const project = installEngineScripts(createProject());
  project.actors = structuredClone(ACTOR_TABLE);
  project.events = [];
  project.map.vertices = [[-512, -512], [512, -512], [512, 512], [-512, 512]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 256, light: 200, sky: false, tag: 0 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 256, color: '#888888', solid: true }));
  const actor = project.actors.find(candidate => candidate.name.toLowerCase() === monsterName.toLowerCase());
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: -300, y: 0, angle: 0 },
    { id: 'm1', type: 'enemy', name: monsterName, actorId: actor.id, x: 0, y: 0, angle: 180, elevation: 0 },
  ];
  const state = createRuntime(project, { screen: 'playing' });
  state.hasGame = true;
  const monster = state.entities.find(entity => entity.id === 'm1');
  monster.health = actor.health;
  return { project, state, monster, actor };
}

const ctxFor = (project, state, entity, actor) => ({ project, state, entity, actor, args: [], named: {} });
const run = (project, state, tics) => { for (let tic = 0; tic < tics; tic++) stepRuntime(project, state, 1 / 35, new Set()); };
const label = (entity, actor) => Object.entries(actor.states.labels)
  .find(([, index]) => index === entity.actorState?.index)?.[0];

test('the Mancubus throws two shots per attack, fanned by FATSPREAD', { skip }, () => {
  const { project, state, monster, actor } = room('Fatso');
  monster.targetId = '$player';
  monster.angle = 180;
  for (const [name, expected] of [['A_FatAttack1', [11.25, 22.5]], ['A_FatAttack2', [-11.25, -22.5]],
    ['A_FatAttack3', [-5.625, 5.625]]]) {
    state.projectiles.length = 0;
    ACTIONS[name](ctxFor(project, state, monster, actor));
    assert.equal(state.projectiles.length, 2, `${name} throws Doom's two FatShots`);
    // The angle is a rotation of the Mancubus's own facing, which `A_FaceTarget` has just set.
    const facing = monster.angle * Math.PI / 180;
    const offsets = state.projectiles.map(shot => {
      const delta = Math.atan2(shot.dy, shot.dx) - facing;
      return Math.atan2(Math.sin(delta), Math.cos(delta)) * 180 / Math.PI;
    });
    for (const [index, offset] of expected.entries())
      assert.ok(Math.abs(offsets[index] - offset) < .01, `${name} shot ${index} at ${offsets[index].toFixed(2)} degrees`);
  }
});

test('a Lost Soul charges, and the slam hurts what it reaches', { skip }, () => {
  const { project, state, monster, actor } = room('LostSoul');
  monster.x = state.player.x + 120;
  monster.actorState = { index: actor.states.labels.See, tics: 1, target: null, threshold: 0, reactionTime: 0,
    moveDir: -1, flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  monster.targetId = '$player';
  const start = monster.x;
  ACTIONS.A_SkullAttack(ctxFor(project, state, monster, actor));
  assert.ok(monster.skullfly, 'the charge is a real flight, not a field nothing reads');
  run(project, state, 10);
  // 20 units a tic is Doom's `DEFSKULLSPEED`, which is far more than the 8 units its walk covers;
  // the charge ends on the player, who is 120 units away.
  const covered = start - monster.x;
  assert.ok(covered > 80, `the soul covered ${covered.toFixed(0)} units`);
  assert.ok(Math.hypot(monster.x - state.player.x, monster.y - state.player.y) <= 40, 'it reached the player');
  assert.equal(state.playerStats.health < 100, true, 'and the slam landed');
  assert.equal(monster.skullfly, null, 'the charge ends on contact');
});

test('a Pain Elemental spits a Lost Soul clear of its own body, and it charges', { skip }, () => {
  const { project, state, monster, actor } = room('PainElemental');
  monster.targetId = '$player';
  ACTIONS.A_PainAttack(ctxFor(project, state, monster, actor));
  const soul = state.entities.find(entity => entity.name === 'LostSoul');
  assert.ok(soul, 'a soul appeared');
  // `4 + (radius + soulradius) * 1.5`: 74.5 units ahead of the Elemental, not on top of it.
  const distance = Math.hypot(soul.x - monster.x, soul.y - monster.y);
  assert.ok(Math.abs(distance - (4 + (31 + 16) * 1.5)) < .5, `spat ${distance.toFixed(1)} units away`);
  assert.equal(soul.targetId, '$player', 'the soul knows what to hunt');
  assert.ok(soul.skullfly, 'and is already flying at the player');
});

test('a Cyberdemon and a Spider Mastermind shrug off a rocket that lands beside them', { skip }, () => {
  for (const name of ['Cyberdemon', 'SpiderMastermind']) {
    const { project, state, monster } = room(name);
    const full = monster.health;
    // A blast ten units away would take a fifth of a Baron's health; `+NORADIUSDMG` takes none.
    explodeAt(project, state, { x: monster.x + 10, y: monster.y, z: 0, name: 'Blast' }, 128, 128);
    assert.equal(monster.health, full, `${name} is immune to splash damage`);
    // A direct hit still hurts: the immunity is for radius damage only.
    hurtActor(project, state, monster, 100, null);
    assert.equal(monster.health, full - 100);
  }
});

test('a body killed by more than its own health comes apart in its XDeath state', { skip }, () => {
  for (const [name, damage, expected] of [['ZombieMan', 60, 'XDeath'], ['DoomImp', 150, 'XDeath'],
    ['ZombieMan', 25, 'Death'], ['BaronOfHell', 2100, 'Death']]) {
    const { project, state, monster, actor } = room(name);
    hurtActor(project, state, monster, damage, state.player);
    run(project, state, 1);
    assert.equal(label(monster, actor), expected, `${name} taking ${damage} dies in ${expected}`);
  }
  // Doom keeps the corpse's health negative: that is how it decides the gib in the first place.
  const { project, state, monster } = room('ZombieMan');
  hurtActor(project, state, monster, 60, state.player);
  assert.equal(monster.health, -40);
});

test('the Cacodemon answers both floor-clip actions, and the sprite is cut at the floor', { skip }, () => {
  const { project, state, monster, actor } = room('Cacodemon');
  ACTIONS.A_SetFloorClip(ctxFor(project, state, monster, actor));
  assert.equal(monster.floorClip, true);
  // A card whose bottom is 50 units under the floor keeps its top and loses the buried part.
  const asset = { width: 64, height: 100, offsetX: 0, offsetY: 100 };
  const plain = spritePlacement({ x: 0, y: 0, z: -50, spriteScale: 1 }, asset, 0);
  const clipped = spritePlacement({ x: 0, y: 0, z: -50, spriteScale: 1, floorClip: true }, asset, 0);
  assert.equal(plain.height, 100);
  assert.equal(clipped.height, 50, 'the buried half is not drawn');
  const plainTop = plain.centre.y + plain.height / 2, clippedTop = clipped.centre.y + clipped.height / 2;
  assert.ok(Math.abs(plainTop - clippedTop) < 1e-9, 'and the top of the sprite does not move');
  ACTIONS.A_UnSetFloorClip(ctxFor(project, state, monster, actor));
  assert.equal(monster.floorClip, false);
});

test('CommanderKeen hangs from the ceiling, as +SPAWNCEILING says', { skip }, () => {
  const { monster, actor } = room('CommanderKeen');
  assert.equal(actor.flags.SPAWNCEILING, true);
  assert.equal(monster.z, 256 - actor.height, 'placed against the ceiling, not on the floor');
});

test('an Archvile raises the corpse at its feet into its Raise state', { skip }, () => {
  const { project, state, monster, actor } = room('Archvile');
  const zombie = project.actors.find(candidate => candidate.name === 'ZombieMan');
  const corpse = { id: 'corpse', type: 'enemy', name: 'ZombieMan', actorId: zombie.id, actorName: 'ZombieMan',
    x: 32, y: 0, angle: 0, elevation: 0, health: -40, solid: false, noBlockmap: true };
  state.entities.push(corpse);
  corpse.actorState = { index: zombie.states.labels.Death, tics: 0, target: null, threshold: 0,
    reactionTime: 0, moveDir: -1, flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  monster.targetId = '$player';
  ACTIONS.A_VileChase(ctxFor(project, state, monster, actor));
  assert.equal(corpse.health, zombie.health, 'the corpse is whole again');
  assert.equal(label(corpse, zombie), 'Raise', 'and stands up through its Raise state');
  assert.equal(corpse.solid, true, 'blocking the level again');
  assert.equal(state.sounds.some(sound => sound.name === 'vile/raise'), true);
  assert.equal(label(monster, actor), 'Heal', 'the Archvile spends its Heal state doing it');
});

test('the Archvile fire tracks the player and bursts on them', { skip }, () => {
  const { project, state, monster, actor } = room('Archvile');
  monster.targetId = '$player';
  ACTIONS.A_VileStart(ctxFor(project, state, monster, actor));
  assert.equal(state.sounds.some(sound => sound.name === 'vile/start'), true, 'the wind-up sound is answered');
  ACTIONS.A_VileTarget(ctxFor(project, state, monster, actor));
  assert.ok(monster.vileFire, 'the flame is dropped on the target');
  assert.equal(Math.round(monster.vileFire.x), Math.round(state.player.x));
  // The flame follows the player while the Archvile can see them (`A_Fire`).
  state.player.y += 64;
  run(project, state, 2);
  assert.equal(Math.round(monster.vileFire.y), Math.round(state.player.y));
  // 20 straight down the line of sight, then 70 in a 70-unit radius at 24 units from the player.
  const before = state.playerStats.health;
  ACTIONS.A_VileAttack(ctxFor(project, state, monster, actor));
  assert.equal(before - state.playerStats.health, 66, '20 direct plus 46 of blast');
  assert.equal(monster.vileFire, null, 'the flame is spent');
});

test('a raised monster gets its collider back, so a corpse is not a wall forever', { skip }, () => {
  const { project, state, monster, actor } = room('Archvile');
  state.physics = createPhysics(project, state, R, triangulate);
  const zombie = project.actors.find(candidate => candidate.name === 'ZombieMan');
  const corpse = { id: 'corpse', type: 'enemy', name: 'ZombieMan', actorId: zombie.id, actorName: 'ZombieMan',
    x: 32, y: 0, angle: 0, elevation: 0, health: -40, solid: false, noBlockmap: true };
  state.entities.push(corpse);
  corpse.actorState = { index: zombie.states.labels.Death, tics: 0, target: null, threshold: 0,
    reactionTime: 0, moveDir: -1, flags: new Map(), inventory: new Map(), cooldown: 0, firedThisTic: false };
  monster.targetId = '$player';
  ACTIONS.A_VileChase(ctxFor(project, state, monster, actor));
  assert.equal(corpse.solid, true);
  // Raising the same corpse twice must not throw on a body that is already there.
  assert.doesNotThrow(() => restoreBlocking(state, corpse));
  assert.equal(corpse.health, zombie.health);
  state.physics.dispose();
});

test('a corpse class that starts in its parent\'s death frames compiles that way', () => {
  // `DeadShotgunGuy : ShotgunGuy { States { Spawn: Goto Super::Death+4; } }` is how Doom places a
  // body in a map. The table this campaign was imported with (before `Super::Label+N` was
  // resolved) gave those classes the *living* monster's states, so their Spawn was its See and
  // seven hanging corpses in the campaign hunted the player. The compiler gets it right now.
  const source = `
class ZombieMan : Actor
{
  States
  {
  Spawn:
    POSS AB 10 A_Look;
    Loop;
  See:
    POSS A 4 A_Chase;
    Loop;
  Death:
    POSS H 5;
    POSS I 5 A_Scream;
    POSS J 5 A_NoBlocking;
    POSS K 5;
    POSS L -1;
    Stop;
  }
}
class DeadZombieMan : ZombieMan
{
  Default { Skip_Super; DropItem "None"; }
  States
  {
  Spawn:
    Goto Super::Death+2;
  }
}
`;
  const actors = importActors({ sources: [{ name: 'dead.zs', text: source, language: 'zscript' }], warnings: [] }).actors;
  const dead = actors.find(actor => actor.name === 'DeadZombieMan');
  const spawn = dead.states.frames[dead.states.labels.Spawn];
  assert.equal(spawn.kind, 'goto');
  // `Super::Death` is the parent's corpse sequence, and `+2` is the frame that stops blocking.
  const target = dead.states.frames[spawn.targetIndex];
  assert.equal(target.kind, 'frame');
  assert.equal(dead.states.frames[dead.states.labels.Spawn].target, 'Super::Death+2');
  assert.notEqual(dead.states.labels.Spawn, dead.states.labels.See,
    'a corpse does not start in the living monster\'s See state');
});
