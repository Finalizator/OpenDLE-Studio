import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { buildVanillaActors, importActors } from '../shared/actors.js';
import { analyseWeapon, weaponCycle, weaponEventActors, weaponScriptRules, weaponSlotOf } from '../shared/weapon-script.js';

const SLOTS = ['fist', 'pistol', 'shotgun', 'superShotgun', 'chaingun', 'rocketLauncher', 'plasmaRifle', 'bfg', 'chainsaw'];
const CAPACITY = { bullets: 200, shells: 50, rockets: 50, cells: 300 };
const AMMO = { fist: null, pistol: 'bullets', shotgun: 'shells', superShotgun: 'shells', chaingun: 'bullets',
  rocketLauncher: 'rockets', plasmaRifle: 'cells', bfg: 'cells', chainsaw: null };

/** A project with the vanilla actor table, the way a WAD import leaves one. */
function imported() {
  const project = createProject();
  project.events = [];
  project.actors = buildVanillaActors();
  installEngineScripts(project, { includeHUD: false });
  return project;
}

/** The same project with the generated weapon rules deleted — the states fire again. */
function bare(project = imported()) {
  const sheet = project.eventSheets.find(entry => entry.name === 'Weapons');
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  return project;
}

function armed(project, slot) {
  const state = createRuntime(project);
  state.hasGame = true;
  for (const name of SLOTS) state.inventory.weapons.add(name);
  state.inventory.selectedWeapon = slot;
  stepRuntime(project, state, 1 / 35, new Set());
  return state;
}

/** Ammo the weapon spends over `tics` frames of held trigger, refilled to capacity each frame. */
function spent(project, slot, tics = 700) {
  const state = armed(project, slot);
  const ammo = AMMO[slot];
  if (!ammo) return 0;
  let total = 0;
  for (let tic = 0; tic < tics; tic++) {
    state.playerStats[ammo] = CAPACITY[ammo];
    stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
    total += CAPACITY[ammo] - state.playerStats[ammo];
  }
  return total;
}

test('a weapon pass is measured in the tics its own frames add up to', () => {
  // The numbers GZDoom plays at: a pistol pass is 4+6+4 frames plus the tic A_ReFire
  // spends, so 15 tics a shot; the shotgun's reload makes its pass 38.
  const actors = buildVanillaActors();
  const cycle = name => weaponCycle(actors.find(actor => actor.name === name));
  assert.deepEqual([cycle('Pistol').tics, cycle('Pistol').shots.length], [15, 1]);
  assert.deepEqual([cycle('Shotgun').tics, cycle('Shotgun').shots.length], [38, 1]);
  assert.deepEqual([cycle('SuperShotgun').tics, cycle('SuperShotgun').shots.length], [58, 1]);
  assert.deepEqual([cycle('Chaingun').tics, cycle('Chaingun').shots.length], [9, 2], 'two shots a pass');
  assert.deepEqual([cycle('Chainsaw').tics, cycle('Chainsaw').shots.length], [9, 2]);
  assert.equal(cycle('RocketLauncher').tics, 21);
  assert.equal(cycle('PlasmaRifle').tics, 4);
  assert.equal(cycle('BFG9000').tics, 41);
  assert.equal(cycle('Fist').tics, 18);
  // A state that stops, or one the walk cannot follow, has no cadence to promise.
  assert.equal(weaponCycle({ states: { frames: [], labels: {} } }), null);
});

test('every imported weapon becomes a rule that spends and fires what its states did', () => {
  const project = imported();
  const sheet = project.eventSheets.find(entry => entry.name === 'Weapons');
  const rules = project.events.filter(event => event.sheetId === sheet.id);
  assert.deepEqual(rules.map(rule => rule.name).sort(), [...SLOTS].sort(), 'one rule per weapon slot');
  const shotgun = rules.find(rule => rule.name === 'shotgun');
  assert.deepEqual(shotgun.actions.find(action => action.type === 'addAmmo'), { type: 'addAmmo', ammo: 'shells', amount: -1 });
  assert.deepEqual(shotgun.actions.find(action => action.type === 'hitscan'),
    { type: 'hitscan', damage: 5, diceSides: 3, pellets: 7, spread: 11.25, range: 2048 });
  assert.equal(shotgun.actions.at(-1).seconds, 38 / 35, 'the cadence is the frames, not a guess');
  const bfg = rules.find(rule => rule.name === 'bfg');
  assert.deepEqual(bfg.actions.find(action => action.type === 'addAmmo'), { type: 'addAmmo', ammo: 'cells', amount: -40 });
  assert.equal(bfg.actions.find(action => action.type === 'launchProjectile').missile, 'BFGBall',
    'the projectile is the mod actor, so its explosion is the mod explosion');
  const chaingun = rules.find(rule => rule.name === 'chaingun');
  assert.equal(chaingun.actions.filter(action => action.type === 'hitscan').length, 2, 'a pass fires twice');
  assert.equal(chaingun.actions.at(-1).seconds, 9 / 35);
  // The chainsaw keeps the hit sound its states play, and its own swing sound.
  const saw = rules.find(rule => rule.name === 'chainsaw').actions.find(action => action.type === 'hitscan');
  assert.equal(saw.hitSound, 'weapons/sawhit');
  // A rule a player can read: it says where it came from.
  assert.match(shotgun.comment, /DECORATE states/);
  validateProject(project);
});

test('the rules fire at the same rate and for the same ammo as the state machine', () => {
  // Same window, same trigger. The rule's first shot comes at the start of the window
  // while the states spend a few tics raising the weapon, so the totals may differ by up
  // to one pass; anything more would be a change of rate.
  for (const slot of SLOTS) {
    const byRule = spent(imported(), slot), byStates = spent(bare(imported()), slot);
    // One pass of the weapon, in rounds: the BFG's is forty.
    const perPass = slot === 'superShotgun' ? 2 : slot === 'bfg' ? 40 : 1;
    assert.ok(Math.abs(byRule - byStates) <= perPass,
      `${slot} spends the same ammo (rules ${byRule}, states ${byStates})`);
    assert.ok(byRule > 0 || !AMMO[slot], `${slot} actually fires`);
  }
  // The pistol is exact over a longer window: 2000 tics at 15 a shot, the first at 0.
  assert.equal(spent(imported(), 'pistol', 2000), 134);
  assert.equal(spent(bare(imported()), 'pistol', 2000), 133, 'the states spend a few tics raising');
});

test('a translated weapon is fired by its rule and never by its states as well', () => {
  const project = imported();
  const state = armed(project, 'pistol');
  state.playerStats.bullets = 200;
  const withRule = spent(project, 'pistol', 300);
  // The same project with only the rules disabled: the states take over, at the same rate.
  const silenced = imported();
  for (const rule of silenced.events) if (rule.weaponActor) rule.enabled = false;
  const byStates = spent(silenced, 'pistol', 300);
  assert.equal(withRule, 20, '300 tics at 15 a shot');
  assert.equal(byStates, 20, 'one firing path, not two');
});

test('editing a rule changes the weapon, and deleting it gives the states back', () => {
  const project = imported();
  const pistol = project.events.find(event => event.name === 'pistol');
  // A creator doubles the damage and halves the rate: the weapon follows.
  pistol.actions.find(action => action.type === 'hitscan').damage = 10;
  pistol.actions.at(-1).seconds = 30 / 35;
  validateProject(project);
  const slow = spent(project, 'pistol', 300);
  assert.equal(slow, 10, '300 tics at 30 a shot, the first one included');

  const freed = imported();
  freed.events = freed.events.filter(event => event.name !== 'pistol');
  assert.deepEqual(weaponEventActors(freed), ['bfg9000', 'chaingun', 'chainsaw', 'fist', 'plasmarifle',
    'rocketlauncher', 'shotgun', 'supershotgun'], 'the pistol is the machine\'s again');
  assert.equal(spent(freed, 'pistol', 300), 20, 'and it fires at its own rate');
});

test('an alt fire state becomes a Mouse2 rule', () => {
  const { actors } = importActors({ sources: [{ name: 'mod.zs', text: `
class PlasmaRifle : DoomWeapon
{
  Default { Weapon.AmmoType "Cell"; Weapon.AmmoUse 2; }
  States {
    Ready: PLSG A 1 A_WeaponReady;
    Loop;
    Fire: PLSG A 3 A_FirePlasma;
    PLSG A 0 A_ReFire;
    Goto Ready;
    AltFire: PLSG B 5 A_FireBullets(4, 3, 3, 8, 0);
    PLSG B 0 A_ReFire;
    Goto Ready;
  }
}
` }], warnings: [] });
  const project = createProject();
  project.events = [];
  project.actors = actors;
  installEngineScripts(project, { includeHUD: false });
  const rules = project.events.filter(event => event.weaponActor);
  const alt = rules.find(rule => rule.condition.key === 'Mouse2');
  assert.ok(alt, 'the alt fire is a rule of its own');
  assert.equal(alt.name, 'plasmaRifle alt fire');
  // A_FireBullets is (spread, diceSides, pellets, damage, ...), as the engine reads it.
  assert.deepEqual(alt.actions.find(action => action.type === 'hitscan'),
    { type: 'hitscan', damage: 8, diceSides: 3, pellets: 3, spread: 4, range: 2048 });
  assert.deepEqual(alt.actions.find(action => action.type === 'addAmmo'), { type: 'addAmmo', ammo: 'cells', amount: -2 });
  assert.equal(alt.actions.find(action => action.type === 'weaponAnimation').state, 'AltFire');
});

test('a weapon whose states cannot be written as one rule keeps its machine and is reported', () => {
  const { actors } = importActors({ sources: [{ name: 'mod.zs', text: `
class OddGun : DoomWeapon
{
  States {
    Ready: PLSG A 1 A_WeaponReady;
    Loop;
    Fire: PLSG A 2 A_FireBullets(1, 1, 1, 0, 0);
    PLSG A 2 A_FirePistol;
    PLSG A 0 A_ReFire;
    Goto Ready;
  }
}
` }], warnings: [] });
  const project = { actors, assets: [], map: { entities: [] }, events: [], eventSheets: [], eventGroups: [], game: null, variables: {} };
  const odd = actors.find(actor => actor.name === 'OddGun');
  assert.equal(weaponSlotOf(odd), null, 'a weapon with no slot has no key to select it by');
  const plan = analyseWeapon(project, odd);
  assert.equal(plan.expressible, false);
  assert.match(plan.reasons[0], /no weapon slot/);
  const { events, skipped } = weaponScriptRules(project);
  assert.equal(events.some(event => event.weaponActor === 'OddGun'), false, 'no rule fires it');
  assert.ok(skipped.some(item => item.name === 'OddGun'), 'and the reason is reported');
  assert.match(skipped.find(item => item.name === 'OddGun').reasons[0], /no weapon slot/);
});

test('a state that fires two different shots in one pass is reported, not half-written', () => {
  // One rule fires one kind of shot on one timer, so the analysis must refuse rather than
  // write a rule that fires half the weapon.
  const { actors } = importActors({ sources: [{ name: 'mod.zs', text: `
class Pistol : Pistol
{
  States {
    Ready: PISG A 1 A_WeaponReady;
    Loop;
    Fire: PISG A 2 A_FirePistol;
    PISG A 2 A_FireShotgun;
    PISG A 0 A_ReFire;
    Goto Ready;
  }
}
` }], warnings: [] });
  const project = { actors, assets: [], map: { entities: [] }, events: [], eventSheets: [], eventGroups: [], game: null, variables: {} };
  const plan = analyseWeapon(project, actors.find(actor => actor.name === 'Pistol'));
  assert.equal(plan.expressible, false);
  assert.match(plan.reasons[0], /more than one kind of shot/);
});

test('the studio offers the translation on an empty Weapons sheet instead of an invite to double-fire', async () => {
  // An imported game that predates the translation still has an empty sheet, and there
  // "add a condition and an action" invites a rule that fires a second shot on top of the
  // state machine. The sheet explains itself and offers the same rules the importer writes.
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ weaponScriptRules \} from '\/shared\/weapon-script\.js';/);
  const hint = /function appendEmptySheetHint\(parent, owner, sheet\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(hint, 'the empty sheet has its own hint');
  assert.match(hint[1], /sheet\.name !== 'Weapons'/, 'it is the Weapons sheet that explains itself');
  assert.match(hint[1], /actor\.flags\?\.WEAPON === true/, 'and only when the project has imported weapons');
  assert.match(hint[1], /weaponScriptRules\(next, \{ sheetId: target\.id, groupId: group\?\.id \}\)/,
    'the button writes the same rules the importer would');
  assert.match(hint[1], /Imported weapons translated into editable rules\./, 'the edit is one undo step');
  // The MCP tool exposes the same thing, so an agent can translate a project too.
  const tools = readFileSync(new URL('../server/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /name: 'weapons_translate'/);
  assert.match(tools, /case 'weapons_translate':/);
});
