import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { importActors } from '../shared/actors.js';

const SOURCE = `
class TestSteam : Actor
{
  Default { Radius 4; Height 8; Speed 35; Damage 5; Projectile; }
  States
  {
  Spawn:
    STEA A 2 Bright A_SpawnItemEx("TestPuff", 0, 0, 0, 1, 0, 0, 0)
    Loop
  Death:
    STEA B 3 Bright
    Stop
  }
}

class TestPuff : Actor
{
  States
  {
  Spawn:
    PUFF A 3
    Stop
  }
}

class BulletPuff : Actor
{
  States
  {
  Spawn:
    PUFF B 3
    Stop
  }
}

class TestTracer : Actor
{
  Default { Radius 6; Height 8; Speed 10; Damage 10; Projectile; +SEEKERMISSILE; }
  States
  {
  Spawn:
    FATB A 2 Bright A_Tracer
    Loop
  Death:
    FBXP A 4 Bright
    Stop
  }
}

class TestRocket : Actor
{
  Default { Radius 11; Height 8; Speed 20; Damage 20; Projectile; }
  States
  {
  Spawn:
    MISL A 4 Bright
    Loop
  Death:
    MISL B 4 Bright A_Explode(128, 160)
    Stop
  }
}

class TestBfgBall : Actor
{
  Default { Radius 13; Height 8; Speed 25; Damage 100; Projectile; }
  States
  {
  Spawn:
    BFS1 A 4 Bright
    Loop
  Death:
    BFE1 A 4 Bright
    BFE1 B 4 Bright A_BFGSpray("TestPuff", 40, 15)
    Stop
  }
}

class Shotgun : Weapon
{
  Default { Weapon.AmmoType "Cell"; Weapon.AmmoUse 1; }
  States
  {
  Ready:
    GUNF A 1 A_WeaponReady
    Loop
  Fire:
    GUNF A 2 A_FireCustomMissile("TestSteam", 0, false, 0, -4)
    GUNF B 4
    Goto Ready
  AltFire:
    GUNF A 2 A_FireCustomMissile("TestBfgBall")
    GUNF B 30
    Goto Ready
  }
}
`;

const sprite = name => ({ id: `asset_${name}`, name, kind: 'sprite', width: 16, height: 16,
  offsetX: 8, offsetY: 16, src: 'data:image/png;base64,iVBORw0KGgo=' });

function fixture() {
  const warnings = [];
  const { actors } = importActors({ sources: [{ name: 'test.zs', text: SOURCE }], warnings });
  const project = createProject();
  project.events = [];
  project.actors = actors;
  project.assets = ['STEAA0', 'STEAB0', 'PUFFA0', 'PUFFB0', 'FATBA0', 'FBXPA0', 'MISLA0', 'MISLB0',
    'BFS1A0', 'BFE1A0', 'BFE1B0', 'GUNFA0', 'GUNFB0'].map(sprite);
  project.environment = { ...project.environment, sky: '#000000', skyAsset: null };
  const state = createRuntime(project);
  state.playerStats.health = 100;
  state.playerStats.cells = 50;
  state.inventory.weapons.add('shotgun');
  state.inventory.selectedWeapon = 'shotgun';
  state.player.angle = 0;
  state.player.pitch = 0;
  const enemy = (id, x, y, health = 500) => ({ id, type: 'enemy', name: id, actorId: null,
    x, y, z: 0, elevation: 0, health, radius: 20, height: 56, angle: 0 });
  return { project, state, actors, enemy, warnings };
}

/** The weapon slot resolves the project's own launcher by its AmmoType/pickup name. */
function launch(project, state, ticks = 6) {
  const keys = new Set(['Mouse0']);
  for (let tic = 0; tic < ticks; tic++) stepRuntime(project, state, 1 / 35, keys);
}

test('A_FireCustomMissile fires the class the mod names, with its own offsets and no ammo use', () => {
  const { project, state } = fixture();
  const before = state.playerStats.cells;
  launch(project, state, 4);
  assert.equal(state.playerStats.cells, before, 'useammo false spends no ammo');
  const shot = state.projectiles[0];
  assert.ok(shot, 'the named class became the projectile');
  assert.equal(shot.actorName, 'TestSteam', 'no placeholder missile');
  assert.equal(shot.actorId, 'actor_teststeam');
  assert.equal(shot.damage, 5, 'damage comes from the actor definition');
  assert.equal(shot.speed, 35 * 35, 'speed comes from the actor definition');
  assert.ok(shot.clipId, 'the projectile draws the actor frames');
  const floor = 0;
  assert.ok(Math.abs(shot.z - (floor + 40 - 4)) < 1.5, `spawnheight lowers the spawn (z ${shot.z})`);
  assert.equal(shot.radius, 0, 'no invented splash radius');
});

test('a missile runs its own states while it flies, spawning its trail', () => {
  const { project, state, enemy } = fixture();
  // The renderer reads the clip list once at start-up, so a trail actor's clip has
  // to exist before the first shot rather than when the missile first spawns it.
  assert.ok((project.spriteClips || []).some(clip => clip.id === 'clip_actor_actor_testpuff_effect'),
    'trail clips are installed when the runtime is created');
  state.entities.push(enemy('far', 600, 0));
  launch(project, state, 20);
  assert.ok(state.impacts.length >= 3, `trail effects spawned (${state.impacts.length})`);
  const trail = state.impacts[0];
  assert.equal(trail.clipId, 'clip_actor_actor_testpuff_effect', 'the trail actor animates');
  assert.ok((trail.vx || 0) > 0, 'trail particles drift');
});

test('A_Tracer homes a seeking missile onto its target', () => {
  const { project, state, enemy } = fixture();
  // A tracer fired by the player at an enemy to its left: the missile starts along
  // the aim line and must curve toward it.
  const target = enemy('seekerTarget', 300, 200);
  state.entities.push(target);
  state.projectiles.push({ id: ++state.projectileSequence, ownerId: '$player', actorId: 'actor_testtracer',
    actorName: 'TestTracer', tracerId: target.id, x: 0, y: 0, z: 40, dx: 1, dy: 0, dz: 0,
    speed: 10 * 35, damage: 10, diceSides: 8, radius: 0, age: 0, color: '#66bbff' });
  const before = Math.atan2(state.projectiles[0].dy, state.projectiles[0].dx);
  // Smoke lives three tics, so it is checked while the tracer is still homing.
  for (let tic = 0; tic < 5; tic++) stepRuntime(project, state, 1 / 35, new Set());
  const live = state.projectiles[0];
  assert.ok(live, 'the tracer is still flying');
  const after = Math.atan2(live.dy, live.dx);
  assert.ok(after > before, `the tracer turned toward the target (${before.toFixed(3)} -> ${after.toFixed(3)})`);
  assert.ok(state.impacts.some(effect => effect.clipId === 'clip_actor_actor_bulletpuff_effect'), 'and left smoke');
});

test('A_BFGSpray sweeps its cone and damages what the rays reach', () => {
  const { project, state, enemy } = fixture();
  // The ball hits the blocker in front of it, and its Death-state spray reaches
  // the two targets beside the impact.
  const blocker = enemy('blocker', 300, 0);
  const left = enemy('left', 380, -80);
  const right = enemy('right', 380, 80);
  const behind = enemy('behind', -400, 0);
  state.entities.push(blocker, left, right, behind);
  state.projectiles.push({ id: ++state.projectileSequence, ownerId: '$player', actorId: 'actor_testbfgball',
    actorName: 'TestBfgBall', x: 32, y: 0, z: 40, dx: 1, dy: 0, dz: 0, speed: 25 * 35,
    damage: 100, diceSides: 8, radius: 0, age: 0, color: '#66bbff', clipId: 'clip_actor_actor_testbfgball_fly' });
  let sawSpray = false;
  for (let tic = 0; tic < 20; tic++) {
    stepRuntime(project, state, 1 / 35, new Set());
    sawSpray ||= state.impacts.some(effect => effect.clipId === 'clip_actor_actor_testpuff_effect');
  }
  assert.equal(state.projectiles.length, 0, 'the ball detonated on the blocker');
  assert.ok(left.health < 500, 'the left target is sprayed');
  assert.ok(right.health < 500, 'the right target is sprayed');
  assert.equal(behind.health, 500, 'something behind the ball is outside the cone');
  for (const target of [left, right]) {
    const damage = 500 - target.health;
    // Each ray that strikes a target rolls 15 dice of 1..8, and several rays can
    // strike the same target, exactly as in GZDoom.
    assert.ok(damage >= 15 && damage <= 120 * 4, `spray damage is a sum of dice rolls (${damage})`);
  }
  assert.ok(sawSpray, 'the spray actor is drawn on each struck target');
});

test('a rocket explodes from its Death state instead of an invented radius', () => {
  const { project, state, enemy } = fixture();
  const origin = state.player.x + 40;
  const direct = enemy('direct', origin + 80, 0);
  const splash = enemy('splash', origin + 80, 100);
  state.entities.push(direct, splash);
  state.projectiles.push({ id: ++state.projectileSequence, ownerId: '$player', actorId: 'actor_testrocket',
    actorName: 'TestRocket', x: origin, y: 0, z: 40, dx: 1, dy: 0, dz: 0, speed: 20 * 35,
    damage: 20, diceSides: 8, radius: 0, age: 0, color: '#66bbff', clipId: 'clip_actor_actor_testrocket_fly',
    impactClipId: 'clip_actor_actor_testrocket_impact' });
  const playerHealth = state.playerStats.health;
  for (let tic = 0; tic < 20; tic++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.projectiles.length, 0, 'the rocket is gone');
  assert.ok(direct.health < 500, 'the rocket damaged what it flew into');
  assert.ok(splash.health < 500, 'A_Explode from the Death state reached what it did not touch');
  assert.ok(state.playerStats.health < playerHealth, 'and the blast hurt the player standing next to it');
});

test('a weapon that names a class the project does not have does not fire a placeholder', () => {
  const { project, state } = fixture();
  const weapon = project.actors.find(actor => actor.name === 'Shotgun');
  const fire = weapon.states.frames.find(frame => (frame.actions || []).some(action => action.name === 'A_FireCustomMissile'));
  fire.actions = [{ name: 'A_FireCustomMissile', args: ['"NoSuchMissile"'] }];
  launch(project, state, 4);
  assert.equal(state.projectiles.length, 0);
  assert.deepEqual([...state.missileGaps], ['NoSuchMissile'], 'the gap is recorded for the playtest log');
});

test('a live missile and its state machine survive saving and loading', async () => {
  const { captureGameSave, restoreGameSave, gameSaveIdentity } = await import('../shared/save-game.js');
  const { project, state } = fixture();
  state.hasGame = true;
  launch(project, state, 6);
  assert.ok(state.projectiles.length, 'a missile is in flight');
  const identity = await gameSaveIdentity(project);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, identity)));
  const restored = restoreGameSave(project, record, identity);
  const missile = restored.runtime.projectiles[0];
  assert.equal(missile.actorName, 'TestSteam');
  assert.ok(missile.actorState, 'the missile keeps its own state machine');
  assert.equal(typeof missile.actorState.index, 'number');
});

test('a player missile flies where the player looks, not where they aim vertically', () => {
  const { project, state } = fixture();
  state.player.angle = Math.PI / 2;
  state.player.pitch = 0.6;
  launch(project, state, 4);
  const shot = state.projectiles[0];
  assert.ok(Math.abs(shot.dx) < .01, `no sideways drift (dx ${shot.dx.toFixed(3)})`);
  assert.ok(Math.abs(shot.dy - Math.cos(0.6)) < .01, 'it flies along the facing angle');
  assert.ok(Math.abs(shot.dz - Math.sin(0.6)) < .01, 'and climbs with the pitch');
});
