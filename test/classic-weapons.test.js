import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { buildVanillaActors, importActors, classFamily, actorIndex } from '../shared/actors.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { weaponActor } from '../shared/actor-runtime.js';
import { weaponEventActors } from '../shared/weapon-script.js';

const SLOTS = ['fist', 'pistol', 'shotgun', 'superShotgun', 'chaingun', 'rocketLauncher', 'plasmaRifle', 'bfg', 'chainsaw'];

function plainProject() {
  const project = createProject();
  project.events = [];
  project.actors = buildVanillaActors();
  // A little missile artwork, the way a WAD supplies it, so flight clips exist.
  project.assets = ['PLSSA0', 'PLSSB0', 'MISLA0', 'BFS1A0', 'BFS1B0', 'BAL1A0'].map(name =>
    ({ id: `asset_${name}`, name, kind: 'sprite', width: 16, height: 16, offsetX: 8, offsetY: 16,
      src: 'data:image/png;base64,iVBORw0KGgo=' }));
  installEngineScripts(project, { includeHUD: false });
  return project;
}

/**
 * The same project with the generated weapon rules removed.
 *
 * Those rules are the shipped translation of each weapon (see shared/weapon-script.js);
 * these tests are about the DECORATE machine underneath, which a player gets back by
 * deleting them, so they are taken out here rather than fought with.
 */
function machineOnly(project) {
  const sheet = project.eventSheets.find(entry => entry.name === 'Weapons');
  project.events = project.events.filter(event => event.sheetId !== sheet?.id);
  return project;
}

function armed(project) {
  const state = createRuntime(project);
  state.hasGame = true;
  for (const slot of SLOTS) state.inventory.weapons.add(slot);
  // The starting-inventory rules run once, on the first tic; let them finish so a
  // deliberately full clip is not overwritten mid-measurement.
  stepRuntime(project, state, 1 / 35, new Set());
  Object.assign(state.playerStats, { bullets: 999, shells: 999, rockets: 999, cells: 999 });
  state.playerStats.invulnerable = 100000;
  state.player.angle = 0;
  return state;
}

/** Holds the trigger for a number of tics and reports what was spent. */
function hold(project, state, slot, tics) {
  state.inventory.selectedWeapon = slot;
  state.weaponActor = null; state.weaponSlot = null;
  const before = { ...state.playerStats };
  for (let tic = 0; tic < tics; tic++) stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
  const spent = Object.fromEntries(['bullets', 'shells', 'rockets', 'cells']
    .filter(ammo => before[ammo] !== state.playerStats[ammo]).map(ammo => [ammo, before[ammo] - state.playerStats[ammo]]));
  return spent;
}

test('a plain WAD import carries the classic weapons, projectiles and effects', () => {
  const actors = buildVanillaActors();
  const index = actorIndex(actors);
  const weapons = actors.filter(actor => actor.flags.WEAPON);
  assert.deepEqual(weapons.map(actor => actor.name).sort(),
    ['BFG9000', 'Chaingun', 'Chainsaw', 'Fist', 'Pistol', 'PlasmaRifle', 'RocketLauncher', 'Shotgun', 'SuperShotgun']);
  for (const slot of SLOTS) assert.ok(weaponActor({ actors }, slot), `${slot} resolves an actor`);
  assert.equal(index.byName.get('shotgun').weaponAmmoType, 'Shell');
  assert.equal(index.byName.get('bfg9000').weaponAmmoUse, 40);
  assert.equal(index.byName.get('supershotgun').weaponAmmoUse, 2);
  assert.equal(index.byName.get('fist').weaponAmmoType, null);
  // Labels the weapon machine drives.
  assert.deepEqual(Object.keys(index.byName.get('pistol').states.labels),
    ['Ready', 'Deselect', 'Select', 'Fire', 'Flash', 'LightDone']);
  for (const missile of ['Rocket', 'PlasmaBall', 'BFGBall', 'DoomImpBall', 'RevenantTracer']) {
    const actor = index.byName.get(missile.toLowerCase());
    assert.ok(actor?.flags.MISSILE, `${missile} is a projectile actor`);
    assert.ok(actor.states.labels.Spawn !== undefined && actor.states.labels.Death !== undefined);
  }
  // The explosion and the spray live in the projectiles' own Death states.
  const deathActions = name => index.byName.get(name).states.frames
    .filter(frame => frame.label === 'Death').flatMap(frame => (frame.actions || []).map(action => action.name));
  assert.deepEqual(deathActions('rocket'), ['A_Explode']);
  assert.deepEqual(deathActions('bfgball'), ['A_BFGSpray']);
  assert.deepEqual(deathActions('revenanttracer'), []);
  assert.ok(index.byName.get('revenanttracer').states.frames.some(frame => frame.actions?.some(a => a.name === 'A_Tracer')));
  for (const effect of ['BFGExtra', 'BulletPuff', 'RevenantTracerSmoke']) assert.ok(index.byName.get(effect.toLowerCase()), effect);
});

test('a WAD import writes each weapon into the Weapons sheet, and its states stop firing', () => {
  // The engine's rule is that gameplay is in the event sheets. An imported weapon is
  // therefore translated from its own DECORATE states (shared/weapon-script.js) instead of
  // running invisibly inside the actor machine.
  const project = createProject();
  project.actors = buildVanillaActors();
  installEngineScripts(project, { includeHUD: false });
  const sheet = project.eventSheets.find(entry => entry.name === 'Weapons');
  const rules = project.events.filter(event => event.sheetId === sheet.id);
  assert.deepEqual(rules.map(rule => rule.name).sort(), [...SLOTS].sort());
  for (const rule of rules) {
    assert.ok(rule.weaponActor, `${rule.name} names the actor whose states wrote it`);
    // Present the states, fire the shot, wait the cadence — the same shape the engine's
    // own table uses, with an ammo spend in front of it when the weapon needs one.
    const types = rule.actions.map(action => action.type);
    const animation = types.indexOf('weaponAnimation');
    assert.ok(animation >= 0, `${rule.name} still runs its own state for the sound and flash`);
    assert.equal(types.at(-1), 'startTimer', `${rule.name} waits the cadence its frames add up to`);
    const shots = types.slice(animation + 1, -1);
    assert.ok(shots.length >= 1 && shots.every(type => ['hitscan', 'launchProjectile'].includes(type)),
      `${rule.name} fires the shot its state fires`);
  }
  assert.deepEqual(weaponEventActors(project).sort(), ['bfg9000', 'chaingun', 'chainsaw', 'fist', 'pistol',
    'plasmarifle', 'rocketlauncher', 'shotgun', 'supershotgun']);
  const bare = createProject();
  installEngineScripts(bare, { includeHUD: false });
  assert.ok(bare.events.some(event => event.name === 'superShotgun'),
    'a project without an actor table still gets the engine table');
  assert.deepEqual(weaponEventActors(bare), [], 'and nothing is marked as fired by a rule');
});

test('screen interaction suppresses classic weapon fire and ammo consumption until aim leaves', () => {
  const project = plainProject(), state = armed(project);
  state.worldTerminalActive = true;
  for (const slot of SLOTS) {
    const projectiles = state.projectiles.length;
    assert.deepEqual(hold(project, state, slot, 60), {}, `${slot} does not spend ammo at a screen`);
    assert.equal(state.projectiles.length, projectiles, `${slot} does not emit a projectile`);
  }
  assert.equal(state.lastShot, undefined);
  state.worldTerminalActive = false;
  assert.ok(hold(project, state, 'pistol', 60).bullets > 0, 'normal weapon input resumes off the screen');
});

test('classic weapon cadences come from their own frame durations', () => {
  const project = machineOnly(plainProject());
  const state = armed(project);
  // A_ReFire restarts Fire the tic its frame is entered, so the refire cycle is the
  // sum of the frames before it: pistol 4+6+4 = 14 tics, plasma 3+1, BFG 40.
  assert.deepEqual(hold(project, state, 'pistol', 100), { bullets: 7 });
  assert.deepEqual(hold(project, state, 'shotgun', 200), { shells: 6 });
  assert.deepEqual(hold(project, state, 'superShotgun', 200), { shells: 8 }, 'two shells per shot');
  assert.deepEqual(hold(project, state, 'chaingun', 40), { bullets: 9 });
  assert.deepEqual(hold(project, state, 'rocketLauncher', 100), { rockets: 5 });
  assert.deepEqual(hold(project, state, 'plasmaRifle', 100), { cells: 25 });
  assert.deepEqual(hold(project, state, 'bfg', 200), { cells: 200 }, 'forty cells per shot');
  assert.deepEqual(hold(project, state, 'chainsaw', 40), {}, 'the chainsaw needs no ammo');
  assert.deepEqual(hold(project, state, 'fist', 100), {});
});

test('the trigger is consumed by A_WeaponReady and A_ReFire decides refiring', () => {
  const project = machineOnly(plainProject());
  const state = armed(project);
  state.inventory.selectedWeapon = 'pistol';
  // Ready idles until the trigger is held, then enters Fire.
  for (let tic = 0; tic < 5; tic++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.playerStats.bullets, 999, 'nothing fires without the trigger');
  const fire = project.actors.find(actor => actor.name === 'Pistol').states.labels.Fire;
  stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
  assert.equal(state.weaponActor.index, fire, 'A_WeaponReady started the Fire state');

  // A single press is one shot: the trigger is consumed where A_WeaponReady sees it,
  // not every tic the weapon happens to be idle.
  const tap = armed(project);
  tap.inventory.selectedWeapon = 'pistol'; tap.weaponActor = null; tap.weaponSlot = null;
  const before = tap.playerStats.bullets;
  stepRuntime(project, tap, 1 / 35, new Set(['Mouse0']));
  for (let tic = 0; tic < 60; tic++) stepRuntime(project, tap, 1 / 35, new Set());
  assert.equal(before - tap.playerStats.bullets, 1, 'one press, one shot');
});

test('GZDoom base classes are recognised without gzdoom.pk3', () => {
  const { actors } = importActors({ sources: [{ name: 'mod.zs', text: `
class ModGun : DoomWeapon
{
  Default { Weapon.AmmoType "Cell"; Weapon.AmmoUse 1; }
  States { Ready: PLSG A 1 A_WeaponReady; Loop; Fire: PLSG A 3 A_FirePlasma; Goto Ready; }
}
class ModPlayer : DoomPlayer { Default { Health 100; } }
class ModAmmo : Ammo { Default { Inventory.Amount 20; } }
` }], warnings: [] });
  const index = actorIndex(actors);
  assert.equal(index.byName.get('modgun').flags.WEAPON, true, 'DoomWeapon is a weapon family');
  assert.equal(index.byName.get('modplayer').flags.PLAYERPAWN, true);
  assert.equal(index.byName.get('modammo').flags.AMMO, true);
  assert.equal(classFamily({ parent: 'HexenWeapon' }, new Map()), 'WEAPON');
});

test('a missile weapon fires its own projectile actor out of its states', () => {
  const project = plainProject();
  const state = armed(project);
  const target = { id: 'target', type: 'enemy', name: 'Target', x: state.player.x + 200, y: state.player.y,
    z: 0, elevation: 0, health: 5000, radius: 20, height: 56, angle: 180 };
  state.entities.push(target);
  state.inventory.selectedWeapon = 'plasmaRifle';
  let spawned = null;
  for (let tic = 0; tic < 40 && !spawned; tic++) {
    stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
    spawned = state.projectiles.at(-1) || null;
  }
  assert.ok(spawned, 'the plasma rifle launched its projectile');
  assert.equal(spawned.actorName, 'PlasmaBall', 'the projectile is the actor the weapon names');
  assert.equal(spawned.actorId, 'actor_plasmaball');
  assert.equal(spawned.speed, 25 * 35);
  assert.equal(spawned.clipId, 'clip_actor_actor_plasmaball_fly');
  assert.equal(target.health, 5000, 'the ball has not landed yet');
});
