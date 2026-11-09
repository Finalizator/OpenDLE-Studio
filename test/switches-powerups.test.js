import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installWorldScripts } from '../shared/world-motion.js';
import { advanceSwitches, pressSwitch, switchPairs, wallCanBePressed, wallCanBeShot, wallSwitchRepeats } from '../shared/switches.js';
import { advanceDamage, advancePowerups, damageTint, powerupTint, recordDamage, screenTint, POWERUP_SECONDS,
  PICKUP_FLASHES, PICKUP_FLASH_SECONDS, flashTint, pickupFlash, startPickupFlash, advanceScreenFlash } from '../shared/player-state.js';
import { doomPickups, installDoomInventoryScripts, upgradePickupMessages } from '../shared/doom-hud.js';
import { damagePlayer } from '../shared/combat.js';
import { importWadMap, readWad, switchesFromLump } from '../shared/wad.js';
import { thingName } from '../shared/dehacked.js';
import { encodeImage } from '../server/import.js';

const tick = (p, s, count = 1, keys = [], pressed = []) => {
  for (let i = 0; i < count; i++) stepRuntime(p, s, 1 / 35, new Set(keys), i ? new Set() : new Set(pressed));
};

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const texture = (id, name) => ({ id, kind: 'texture', name, src: PIXEL, width: 1, height: 1 });

/** Two pictures that form a switch pair, and one that is just a wall. */
const switchAssets = () => [texture('tex_sw1', 'SW1BRCOM'), texture('tex_sw2', 'SW2BRCOM'), texture('tex_wall', 'BROWN1')];

const stateStub = () => ({ walls: [], spentSwitches: new Set(), switchReverts: [], worldRevision: 0, sounds: [] });

function room() {
  const p = createProject();
  p.events = [];
  p.assets = switchAssets();
  p.map.vertices = [[-192, -96], [-32, -96], [32, -96], [192, -96], [-192, 96], [-32, 96], [32, 96], [192, 96]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  p.map.sectors = [0, 1, 2].map(index => ({ id: `s${index}`, floorHeight: 0, ceilingHeight: index === 1 ? 0 : 128, light: 255, sky: false, tag: index }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    [0, 1, 's0'], [1, 5, 's0', 's1', 1], [5, 4, 's0'], [4, 0, 's0'],
    [1, 2, 's1'], [2, 6, 's1', 's2'], [6, 5, 's1'], [2, 3, 's2'], [3, 7, 's2'], [7, 6, 's2'],
  ].map(([a, b, right, left, special = 0], index) => ({ id: `w${index}`, a: `v${a}`, b: `v${b}`,
    right: side(right), left: left ? side(left) : null, solid: !left, height: 128, color: '#888888', special, tag: 0 }));
  // The door line is a switch: pressing E from the corridor shows the on picture.
  p.map.walls[1].right.middle = 'tex_sw1';
  p.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -60, y: 0, angle: 0 }];
  installEngineScripts(p);
  installWorldScripts(p, []);
  validateProject(p);
  return p;
}

test('a switch pair is the SW1/SW2 pair of the artwork names', () => {
  const project = createProject();
  project.assets = switchAssets();
  const pairs = switchPairs(project);
  assert.equal(pairs.on.get('tex_sw1'), 'tex_sw2', 'off picture turns on');
  assert.equal(pairs.off.get('tex_sw2'), 'tex_sw1', 'and back again');
  assert.equal(pairs.on.size, 1);
  assert.equal(switchPairs(project), pairs, 'the table is built once per project');
});

/** A PWAD holding nothing but one SWITCHES lump of 20-byte records. */
function switchLumpWad(pairs) {
  const records = pairs.length * 20;
  const buffer = new ArrayBuffer(12 + records + 16);
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  bytes.set([0x50, 0x57, 0x41, 0x44], 0);             // PWAD
  view.setUint32(4, 1, true); view.setUint32(8, 12 + records, true);
  const name = (text, at) => { for (let index = 0; index < 8 && index < text.length; index++) bytes[at + index] = text.charCodeAt(index); };
  pairs.forEach(([off, on], index) => {
    const at = 12 + index * 20;
    name(off, at); name(on, at + 9);
  });
  const directory = 12 + records;
  view.setUint32(directory, 12, true);            // lump start
  view.setUint32(directory + 4, records, true);   // lump size
  name('SWITCHES', directory + 8);
  return buffer;
}

test('a Boom SWITCHES lump declares pairs that do not follow the naming', () => {
  const wad = readWad(switchLumpWad([['LEVEROFF', 'LEVERON'], ['SW1BRCOM', 'SW2BRCOM']]), { allowNoMaps: true });
  assert.deepEqual(switchesFromLump(wad), [{ off: 'LEVEROFF', on: 'LEVERON' }, { off: 'SW1BRCOM', on: 'SW2BRCOM' }]);
  assert.deepEqual(switchesFromLump({ lumps: [] }), []);
});

test('a one-shot switch keeps its on picture and refuses a second press', () => {
  const project = createProject();
  project.assets = switchAssets();
  const state = stateStub();
  const wall = { id: 'w1', special: 103, right: { upper: 'tex_wall', middle: 'tex_sw1', lower: null }, left: null };
  state.walls.push(wall);

  assert.equal(wallSwitchRepeats(wall), false, '103 is a once-only line type');
  assert.equal(pressSwitch(project, state, wall, { repeat: false }), true);
  assert.equal(wall.right.middle, 'tex_sw2');
  assert.equal(wall.right.upper, 'tex_wall', 'only the switch picture changes');
  assert.deepEqual(state.sounds.map(sound => sound.name), ['DSSWTCHN']);
  assert.equal(pressSwitch(project, state, wall, { repeat: false }), false, 'a used one-shot switch cannot be pressed again');
  assert.equal(wall.right.middle, 'tex_sw2');
});

test('a repeatable switch turns on, and turns itself back off a second later', () => {
  const project = createProject();
  project.assets = switchAssets();
  const state = stateStub();
  const wall = { id: 'w2', special: 62, right: { middle: 'tex_sw1' }, left: null };
  state.walls.push(wall);

  assert.equal(wallSwitchRepeats(wall), true, '62 is a repeatable lift');
  assert.equal(pressSwitch(project, state, wall, { repeat: true }), true);
  assert.equal(wall.right.middle, 'tex_sw2');
  assert.equal(state.switchReverts.length, 1);
  assert.equal(pressSwitch(project, state, wall, { repeat: true }), false, 'already on is left alone');
  advanceSwitches(state, .5);
  assert.equal(wall.right.middle, 'tex_sw2', 'still showing the on picture half a second later');
  advanceSwitches(state, .6);
  assert.equal(wall.right.middle, 'tex_sw1', 'and the off picture back a second after the press');
  assert.deepEqual(state.sounds.map(sound => sound.name), ['DSSWTCHN', 'DSSWTCHX']);
});

test('a switch picture is not touched on a wall with no special, or on the back side', () => {
  const project = createProject();
  project.assets = switchAssets();
  const state = stateStub();
  const plain = { id: 'w3', special: 0, right: { middle: 'tex_sw1' }, left: null };
  const back = { id: 'w4', special: 62, right: null, left: { middle: 'tex_sw1' } };
  state.walls.push(plain, back);
  assert.equal(pressSwitch(project, state, plain, { repeat: false }), false);
  assert.equal(pressSwitch(project, state, back, { repeat: false }), false);
  assert.equal(plain.right.middle, 'tex_sw1');
  assert.equal(back.left.middle, 'tex_sw1');
  assert.deepEqual(state.sounds, []);
});

test('only the lines Doom presses or shoots change their picture', () => {
  assert.equal(wallCanBePressed({ special: 1 }), true, 'DR is a press');
  assert.equal(wallCanBePressed({ special: 4 }), false, 'W1 is walked through, not pressed');
  assert.equal(wallCanBePressed({ special: 103 }), true, 'S1 is a press');
  assert.equal(wallCanBeShot({ special: 46 }), true, 'GR is shot');
  assert.equal(wallCanBeShot({ special: 1 }), false);
  assert.equal(wallCanBeShot({ special: 24 }), true, 'G1 is shot');
  assert.equal(wallCanBePressed({ special: 1, specialFormat: 'zdoom', activationModes: ['cross'] }), false);
  assert.equal(wallCanBePressed({ special: 1, specialFormat: 'zdoom', activationModes: ['use'] }), true);
});

test('E flips the switch line it uses, and the door behind it still works', () => {
  const p = room(), s = createRuntime(p);
  const door = p.map.walls[1];
  tick(p, s, 20, ['KeyW']);
  assert.equal(door.right.middle, 'tex_sw1', 'the switch is off until it is pressed');
  tick(p, s, 1, [], ['KeyE']);
  assert.equal(door.right.middle, 'tex_sw2', 'the press shows the on picture');
  assert.ok(s.sectorMotions.has('s1:ceilingHeight'), 'the door it is wired to opens');
  tick(p, s, 20);
  assert.equal(door.right.middle, 'tex_sw2', 'still on while the door moves');
  tick(p, s, 30);
  assert.equal(door.right.middle, 'tex_sw1', 'a repeatable line puts the picture back');
});

test('a script fade and a power-up tint are mixed, so neither hides the other', () => {
  const black = { red: 0, green: 0, blue: 0, amount: 1 };
  const white = powerupTint({ invulnerable: 20, berserk: 0, radiation: 0 }, 0);
  assert.deepEqual(screenTint(black, { invulnerable: 20 }, 0), black, 'a full fade covers the tint');
  assert.deepEqual(screenTint(null, { invulnerable: 20 }, 0), white, 'and no fade leaves it alone');
  const both = screenTint({ red: 0, green: 0, blue: 0, amount: .5 }, { invulnerable: 20 }, 0);
  assert.ok(both.amount > .5 && both.amount < 1, 'half a fade plus a tint is more than half');
  assert.ok(both.red > 0, 'and the white shows through the darkening');
});

test('a hit reddens the view, and the colour drains away like Doom damagecount', () => {
  const state = { time: 1, feedback: { damage: null, damageCount: 0 } };
  recordDamage(state, 20, 'front');
  assert.equal(state.feedback.damageCount, 20, 'a hit adds its damage');
  recordDamage(state, 200, 'front');
  assert.equal(state.feedback.damageCount, 100, 'and the count stops at 100, as in Doom');

  const hurts = damageTint(state.feedback.damageCount);
  assert.equal(hurts.red, 255); assert.ok(hurts.amount > .4, 'a heavy hit is a strong red');
  assert.ok(damageTint(8).amount < hurts.amount, 'a light hit is a light red');
  assert.equal(damageTint(0), null);

  advanceDamage(state, 1 / 35);
  assert.equal(state.feedback.damageCount, 99, 'one a tic, as P_PlayerThink drips it');
  advanceDamage(state, 5);
  assert.equal(state.feedback.damageCount, 0, 'and never below zero');

  // The red is laid over a power-up's tint, and under a script's fade.
  const both = screenTint(null, { invulnerable: 30 }, 0, 100);
  assert.ok(both.red > both.green, 'red over white is still red');
  assert.ok(both.amount > .5);
});

test('power-up clocks count down, and the screen tint follows them', () => {
  const stats = { invulnerable: 1, berserk: 0, radiation: 0 };
  advancePowerups({ playerStats: stats }, .4);
  assert.ok(Math.abs(stats.invulnerable - .6) < 1e-9);
  advancePowerups({ playerStats: stats }, 5);
  assert.equal(stats.invulnerable, 0, 'a clock never runs backwards past zero');

  assert.equal(powerupTint({ invulnerable: 0, berserk: 0, radiation: 0 }), null);
  assert.equal(powerupTint({ invulnerable: 0, berserk: 0, radiation: 0, invisible: 30 }), null, 'the blur sphere has no tint');

  const white = powerupTint({ invulnerable: 10, berserk: 0, radiation: 0 }, 0);
  assert.equal(white.red, 255); assert.equal(white.green, 255); assert.equal(white.blue, 255);
  assert.ok(white.amount > .1 && white.amount < .4);
  const red = powerupTint({ invulnerable: 0, berserk: POWERUP_SECONDS.berserk, radiation: 0 });
  assert.ok(red.red === 255 && red.amount > .3, 'berserk reddens the view');
  const green = powerupTint({ invulnerable: 0, berserk: 0, radiation: 30 });
  assert.ok(green.green > green.red && green.green > green.blue, 'the suit is green');
});

test('taking damage shows the red in play, and it fades on its own', () => {
  const p = room(), s = createRuntime(p);
  tick(p, s, 2);
  damagePlayer(s, 25);
  assert.equal(s.playerStats.health, 75);
  assert.ok(s.feedback.damageCount >= 24, 'the hit is on the screen');
  assert.ok(screenTint(s.screenFadeNow, s.playerStats, s.time, s.feedback.damageCount).red === 255);
  const peak = s.feedback.damageCount;
  tick(p, s, 35);
  assert.ok(s.feedback.damageCount < peak, `the red is draining: ${s.feedback.damageCount} of ${peak}`);
  tick(p, s, 60);
  assert.equal(s.feedback.damageCount, 0, 'and the view is clear again');
});

test('the power-up pickups are always taken and start their clock', () => {
  const pickups = new Map(doomPickups().map(([type, actions, needs]) => [type, { actions, needs }]));
  for (const [type, stat] of [[2022, 'invulnerable'], [2023, 'berserk'], [2024, 'invisible'], [2025, 'radiation']]) {
    const pickup = pickups.get(type);
    assert.ok(pickup, `${type} is a pickup`);
    assert.deepEqual(pickup.needs, [], 'Doom always takes a power-up, even while it runs');
    assert.ok(pickup.actions.some(action => action.type === 'setPlayerStat' && action.stat === stat), `${stat} is set`);
  }
  const berserk = pickups.get(2023).actions.find(action => action.stat === 'health');
  assert.deepEqual(berserk.value, { expr: 'max(player("health"), 100)' }, 'berserk raises health to 100 but never lowers it');

  const p = room();
  p.map.entities.push({ id: 'invuln', type: 'pickup', name: 'Invulnerability', doomType: 2022, x: -60, y: 0, angle: 0 });
  installDoomInventoryScripts(p);
  validateProject(p);
  const s = createRuntime(p);
  tick(p, s, 2);
  assert.ok(s.playerStats.invulnerable > POWERUP_SECONDS.invulnerable - 1, 'touching the sphere starts the clock');
  assert.ok(!s.entities.some(entity => entity.id === 'invuln'), 'and takes the item');
  assert.ok(powerupTint(s.playerStats, s.time), 'the view is tinted while it runs');
});

test('every pickup says what it was, the way Doom announces an item', () => {
  const p = room();
  p.map.entities.push({ id: 'medikit', type: 'pickup', name: 'Medikit', doomType: 2014, x: -60, y: 0, angle: 0 });
  installDoomInventoryScripts(p);
  validateProject(p);
  const collect = p.events.find(event => event.name === 'Doom pickup 2014 / collect');
  assert.deepEqual(collect.actions[0], { type: 'showMessage', message: 'Picked up a medikit.' },
    'the message comes before the health is given');
  const s = createRuntime(p);
  tick(p, s, 2);
  assert.equal(s.message, 'Picked up a medikit.', 'taking the item prints its message');
  assert.ok(!s.entities.some(entity => entity.id === 'medikit'), 'and the item is gone');
});

test('a campaign imported before the messages existed learns them without a re-import', () => {
  const p = room();
  p.eventSheets.push({ id: 'sheet_pickups', name: 'Pickups' });
  p.eventGroups.push({ id: 'group_pickups', name: 'Doom inventory pickups', sheetId: 'sheet_pickups', enabled: true,
    description: 'Imported editable inventory rules.' });
  p.events.push(
    { id: 'wad_inventory_0', name: 'Doom pickup 2018 / proximity', sheetId: 'sheet_pickups', groupId: 'group_pickups',
      enabled: true, once: false, forEachType: 'pickup', condition: { type: 'entityDoomType', entityId: '$self', doomType: 2018 },
      conditions: [], actions: [] },
    { id: 'wad_inventory_0_collect', name: 'Doom pickup 2018 / collect', sheetId: 'sheet_pickups', groupId: 'group_pickups',
      enabled: true, once: false, forEachType: 'pickup', parentId: 'wad_inventory_0', condition: { type: 'always' },
      actions: [{ type: 'setPlayerStat', stat: 'armor', value: 100 }, { type: 'removeEntity', entityId: '$self' }] },
    // An item Doom says nothing about is left alone.
    { id: 'wad_inventory_1_collect', name: 'Doom pickup 9999 / collect', sheetId: 'sheet_pickups', groupId: 'group_pickups',
      enabled: true, once: false, forEachType: 'pickup', condition: { type: 'always' },
      actions: [{ type: 'removeEntity', entityId: '$self' }] });

  assert.equal(upgradePickupMessages(p), 1, 'only the armored item gains a message');
  const collect = p.events.find(event => event.id === 'wad_inventory_0_collect');
  assert.deepEqual(collect.actions[0], { type: 'showMessage', message: 'Picked up the armor.' },
    'the message is first, so it reads before the item is taken');
  assert.equal(upgradePickupMessages(p), 0, 'running it again changes nothing');
});

test('an ordinary pickup flashes the view in its own colour', () => {
  // Every item the pickup table knows about answers on the screen, except the power-ups, which
  // already tint for as long as they run.
  const powerups = new Set([2022, 2023, 2025, 2045]);
  const missing = doomPickups().map(([type]) => type).filter(type => !powerups.has(type) && !pickupFlash(type));
  assert.deepEqual(missing, [], 'every non-power-up item has a flash colour');
  assert.equal(pickupFlash(2022), null, 'the sphere is left to its own tint');

  const p = room();
  p.map.entities.push({ id: 'armor', type: 'pickup', name: 'Armor', doomType: 2018, x: -60, y: 0, angle: 0 });
  installDoomInventoryScripts(p);
  validateProject(p);
  const s = createRuntime(p);
  assert.equal(s.screenFlash, null, 'nothing flashes before the item is taken');
  tick(p, s, 2);
  assert.ok(s.screenFlash, 'taking the armor starts a flash');
  const tint = screenTint(null, s.playerStats, s.time, 0, s.screenFlash);
  assert.ok(tint && tint.amount > .1, 'the flash is visible');
  assert.equal(PICKUP_FLASHES.get(2018)[2], 255, 'armor flashes blue');
  assert.equal(flashTint(s.screenFlash).red, 60, 'and it is the color the table names');
  const started = s.screenFlash.amount;
  tick(p, s, Math.ceil(PICKUP_FLASH_SECONDS * 30));
  assert.ok(!s.screenFlash || flashTint(s.screenFlash) === null || flashTint(s.screenFlash).amount < started / 2,
    'and it fades away');
  assert.ok(s.playerStats.armor > 0, 'the armor itself was taken');
});

test('a pickup flash and the red of a hit share the view without hiding each other', () => {
  const state = { screenFlash: null, time: 0 };
  startPickupFlash(state, 2007);
  assert.ok(state.screenFlash, 'the ammo flash starts');
  const both = screenTint(null, { invulnerable: 0, berserk: 0, radiation: 0 }, 0, 60, state.screenFlash);
  assert.ok(both, 'the view is tinted');
  // The hit is drawn over the pickup, so the red still dominates a strong hit.
  const hitOnly = damageTint(60);
  assert.ok(both.amount > hitOnly.amount, 'both layers show, the hit being the stronger one');
  advanceScreenFlash(state, PICKUP_FLASH_SECONDS);
  assert.equal(state.screenFlash, null, 'the flash is over');
});

test('the light-amplification visor brightens the view instead of tinting it', () => {
  const pickups = new Map(doomPickups().map(([type, actions, needs]) => [type, { actions, needs }]));
  const visor = pickups.get(2045);
  assert.ok(visor, 'the visor is a pickup');
  assert.deepEqual(visor.needs, [], 'Doom always takes a power-up');
  assert.ok(visor.actions.some(action => action.type === 'setPlayerStat' && action.stat === 'lightamp'),
    'the visor starts its own clock');

  const p = room();
  p.map.entities.push({ id: 'visor', type: 'pickup', name: 'Visor', doomType: 2045, x: -60, y: 0, angle: 0 });
  installDoomInventoryScripts(p);
  validateProject(p);
  const s = createRuntime(p);
  tick(p, s, 2);
  assert.ok(s.playerStats.lightamp > POWERUP_SECONDS.lightamp - 1, 'the clock runs for two minutes');
  assert.equal(powerupTint(s.playerStats, s.time), null, 'the visor leaves the colours alone');
  assert.equal(s.playerStats.berserk, 0, 'and starts nothing else');
});

test('berserk raises health to 100 without lowering a higher one', () => {
  const p = room();
  p.map.entities.push({ id: 'berserk', type: 'pickup', name: 'Berserk', doomType: 2023, x: 4096, y: 0, angle: 0 });
  installDoomInventoryScripts(p);
  validateProject(p);
  const s = createRuntime(p);
  // The engine's own start rule sets the opening stats, so the item is only walked into after it.
  tick(p, s, 2);
  s.playerStats.health = 150;
  const pickup = s.entities.find(entity => entity.id === 'berserk');
  pickup.x = s.player.x; pickup.y = s.player.y;
  tick(p, s, 2);
  assert.equal(s.playerStats.health, 150, 'a player above 100 keeps their health');
  assert.ok(s.playerStats.berserk > 0, 'and still gains the strength');
});

const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
test('an import keeps the switch pairs its ANIMDEFS declares, and imports both pictures',
  { skip: !existsSync(freedoom) }, () => {
    const file = readFileSync(freedoom);
    const wad = readWad(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const { project, warnings } = importWadMap(wad, 'MAP01', { encodeImage, images: new Map(),
      animDefsSources: ['switch doom 1 SW1BROWN on pic SW2BROWN tics 0'] });
    assert.deepEqual(project.switches, [{ off: 'SW1BROWN', on: 'SW2BROWN' }]);
    const names = new Set(project.assets.map(asset => asset.name.toUpperCase()));
    // The map shows only one half of the pair, so the other half is imported for the press.
    assert.ok(names.has('SW1BROWN') && names.has('SW2BROWN'), 'both pictures are imported');
    assert.equal(switchPairs(project).on.size, 1);
    assert.deepEqual(warnings.filter(warning => /switch/i.test(warning)), []);
  });

test('Doom power-ups are identified by their own thing numbers', () => {
  assert.equal(thingName(2022), 'InvulnerabilitySphere');
  assert.equal(thingName(2023), 'Berserk');
  assert.equal(thingName(2024), 'BlurSphere');
  assert.equal(thingName(2025), 'RadSuit');
  assert.equal(thingName(2045), 'Infrared');
});
