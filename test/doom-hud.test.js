import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createDoomAssets } from '../shared/doom-assets.js';
import { importDoomHUD, installDoomInventoryScripts } from '../shared/doom-hud.js';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hudBinding, hudText } from '../shared/hud.js';
import { encodeImage, importWad } from '../server/import.js';
import { ProjectStore } from '../server/store.js';
import { applyTool } from '../server/tools.js';
import { ammoMaximum } from '../shared/player-state.js';
import { installEngineSounds } from '../shared/sound.js';

const wadPath = new URL('../Projects/freedoom2.wad', import.meta.url);
const step = (project, state, pressed = [], keys = []) => stepRuntime(project, state, 1 / 35, new Set(keys), new Set(pressed));
function syntheticPatch(width = 2, height = 3, offsetX = 0, offsetY = 0, color = 32) {
  const bytes = Buffer.alloc(8 + width * 4 + width * (height + 5));
  bytes.writeUInt16LE(width, 0); bytes.writeUInt16LE(height, 2); bytes.writeInt16LE(offsetX, 4); bytes.writeInt16LE(offsetY, 6);
  for (let x = 0; x < width; x++) {
    const start = 8 + width * 4 + x * (height + 5);
    bytes.writeUInt32LE(start, 8 + x * 4); bytes[start] = 0; bytes[start + 1] = height;
    bytes.fill(color, start + 3, start + 3 + height); bytes[start + 4 + height] = 255;
  }
  return bytes;
}
function fixture(missing = [], corrupt) {
  const records = new Map([['PLAYPAL', Buffer.from(Array.from({ length: 768 }, (_, i) => Math.floor(i / 3)))]]);
  for (const [name, w, h] of [['STBAR', 320, 32], ['STARMS', 38, 32], ['STTPRCNT', 13, 16]]) records.set(name, syntheticPatch(w, h));
  for (const prefix of ['STTNUM', 'STYSNUM', 'STGNUM']) for (let i = 0; i < 10; i++) records.set(`${prefix}${i}`, syntheticPatch(prefix === 'STTNUM' ? 13 : 4, prefix === 'STTNUM' ? 16 : 6, 0, 0, i + 20));
  for (let i = 0; i < 9; i++) records.set(`STKEYS${i}`, syntheticPatch(7, 5));
  for (let pain = 0; pain < 5; pain++) {
    for (let frame = 0; frame < 3; frame++) records.set(`STFST${pain}${frame}`, syntheticPatch(24, 29, -5, -2, 70 + pain * 3 + frame));
    for (const prefix of ['STFTL', 'STFTR']) records.set(`${prefix}${pain}0`, syntheticPatch(26, 30, -3, -1));
    for (const prefix of ['STFOUCH', 'STFEVL', 'STFKILL']) records.set(`${prefix}${pain}`, syntheticPatch(24, 30, -5, -2));
  }
  for (const name of ['STFGOD0', 'STFDEAD0']) records.set(name, syntheticPatch(24, 30, -5, -2));
  for (const name of missing) records.delete(name);
  if (corrupt) records.get(corrupt).writeUInt32LE(0xffffffff, 8);
  const combined = Buffer.concat([...records.values()]);
  let start = 0;
  const lumps = [...records].map(([name, bytes]) => { const lump = { name, start, size: bytes.length }; start += bytes.length; return lump; });
  const assets = createDoomAssets({ buffer: combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.length), lumps }, encodeImage);
  const project = installEngineScripts(createProject(), { includeHUD: false });
  project.assets = assets.assets;
  installEngineSounds(project);
  importDoomHUD(project, assets);
  validateProject(project);
  return { project, assets };
}
function addRule(project, actions, condition = { type: 'onStart' }, conditions = []) {
  project.events.push({ id: `custom_${project.events.length}`, enabled: true, once: false, condition, conditions, actions });
}
test('WAD status-bar import creates editable classic coordinates and actual palette-decoded digit/face atlases', () => {
  const { project } = fixture();
  const hud = project.hud;
  assert.equal(hud.width, 320); assert.equal(hud.height, 200); assert.equal(hud.reserveBottom, 32);
  const bar = hud.elements.find(element => element.name === 'Status bar');
  assert.deepEqual([bar.x, bar.y, bar.width, bar.height], [-160, -32, 320, 32]);
  const health = hud.elements.find(element => element.name === 'Health');
  assert.equal(health.x + health.width, 90); assert.equal(health.y, 3); assert.equal(health.maxLength, 3);
  const font = hud.fonts.find(font => font.name.includes('large'));
  const atlas = PNG.sync.read(Buffer.from(project.assets.find(asset => asset.id === font.assetId).src.split(',')[1], 'base64'));
  assert.deepEqual([atlas.width, atlas.height], [130, 16]);
  assert.deepEqual([...atlas.data.subarray(13 * 4, 13 * 4 + 4)], [21, 21, 21, 255]);
  const face = hud.elements.find(element => element.name === 'Player face');
  const faces = PNG.sync.read(Buffer.from(project.assets.find(asset => asset.id === face.assetId).src.split(',')[1], 'base64'));
  assert.equal(faces.data[(2 * faces.width + 5) * 4], 70);
  assert.equal(faces.data[3], 0, 'signed face offsets leave the correct transparent margin');
  assert.equal(hud.animations.length, 5); assert.equal(hud.animations[0].tracks[0].easing, 'step');
  assert.ok(project.eventGroups.some(group => group.name === 'Face expression priority'));
  assert.ok(project.eventGroups.some(group => group.name === 'Face frames and idle animation'));
  assert.ok(project.events.filter(event => event.id.startsWith('wad_hud_')).every(event =>
    project.eventGroups.some(group => group.id === event.groupId && group.sheetId === event.sheetId)));
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).hud, hud);
});
test('missing optional HUD art reports omissions and incomplete digits fall back explicitly', () => {
  const { project, assets } = fixture(['STTNUM7', 'STKEYS3', 'STFOUCH2']);
  assert.equal(project.hud.fonts.length, 1);
  assert.ok([...assets.warnings].some(warning => warning.includes('STTNUM7')));
  assert.ok([...assets.warnings].some(warning => warning.includes('STKEYS3')));
  assert.ok([...assets.warnings].some(warning => warning.includes('STFOUCH2')));
  const fallback = fixture(['STBAR']);
  assert.ok([...fallback.assets.warnings].some(warning => warning.includes('No STBAR')));
  assert.ok(fallback.project.hud.elements.some(element => element.name === 'HEALTH value'));
});
test('malformed present HUD patches fail import rather than silently substituting unrelated artwork', () => {
  const { assets } = fixture();
  assert.throws(() => assets.atlas('BAD', []), /1-256/);
  assert.throws(() => assets.atlas('STBAR', ['STBAR']), /Duplicate/);
  assert.throws(() => fixture([], 'STBAR'), /Unterminated|bounds/);
});
test('weapon, slot, key, reserve and capacity bindings reflect real runtime inventory', () => {
  const { project } = fixture(), state = createRuntime(project);
  step(project, state);
  assert.equal(hudBinding('ammo', state), 50);
  assert.equal(hudBinding('slot:2', state), 1); assert.equal(hudBinding('slot:3', state), 0);
  assert.equal(hudBinding('key:blueCard', state), 0);
  state.inventory.keys.add('blueCard'); assert.equal(hudBinding('key:blueCard', state), 1);
  state.inventory.weapons.add('superShotgun'); assert.equal(hudBinding('slot:3', state), 1);
  state.inventory.selectedWeapon = 'superShotgun'; state.playerStats.shells = 12;
  assert.equal(hudBinding('ammo', state), 12);
  state.inventory.selectedWeapon = 'fist'; assert.equal(hudBinding('ammo', state), '');
  assert.equal(hudText(project.hud.elements.find(element => element.name === 'Capacity cells'), state), '300');
  assert.equal(hudBinding('maxRockets', state), 50);
});
test('imported face rules animate idle, change pain bands and prioritize weapon, damage, attack, god and death', () => {
  const { project } = fixture(), state = createRuntime(project), face = project.hud.elements.find(element => element.name === 'Player face');
  step(project, state);
  assert.equal(state.hudState.elements.get(face.id).frame, 0);
  for (let i = 0; i < 20; i++) step(project, state);
  assert.equal(state.hudState.elements.get(face.id).frame, 1);
  addRule(project, [{ type: 'setWeaponOwned', weapon: 'shotgun', owned: 'yes' }], { type: 'keyPressed', key: 'KeyE' });
  step(project, state, ['KeyE']); step(project, state); assert.equal(state.face, 'grin');
  assert.equal(state.hudState.elements.get(face.id).frame, 6);
  addRule(project, [{ type: 'damagePlayer', damage: 10, direction: 'left' }], { type: 'keyPressed', key: 'KeyF' });
  step(project, state, ['KeyF']); step(project, state); assert.equal(state.face, 'left');
  assert.equal(state.hudState.elements.get(face.id).frame, 4);
  state.playerStats.health = 40; step(project, state); assert.equal(state.face, 'ouch');
  assert.equal(state.hudState.elements.get(face.id).frame, 3 * 8 + 5);
  for (let i = 0; i < 80; i++) step(project, state);
  assert.equal(state.face, 'idle');
  assert.ok(state.hudState.elements.get(face.id).frame >= 24 && state.hudState.elements.get(face.id).frame <= 26);
  for (let i = 0; i < 80; i++) step(project, state, [], ['Mouse0']);
  assert.equal(state.face, 'rampage');
  state.playerStats.invulnerable = 1; step(project, state); assert.equal(state.face, 'god');
  state.playerStats.health = 0; step(project, state); assert.equal(state.face, 'dead');
  assert.equal(state.hudState.playing.size, 0);
});
test('inventory commands validate, enforce ownership, cap ammo and double backpack capacities only once', () => {
  let { project } = fixture();
  project = applyTool(project, 'events_add_rule', { condition: { type: 'onStart' }, actions: [
    { type: 'setWeaponOwned', weapon: 'shotgun', owned: 'yes' }, { type: 'selectWeapon', weapon: 'shotgun' },
    { type: 'setKeyOwned', key: 'redSkull', owned: 'yes' }, { type: 'addAmmo', ammo: 'shells', amount: 500 },
    { type: 'giveBackpack' }, { type: 'giveBackpack' }, { type: 'addAmmo', ammo: 'shells', amount: 500 },
  ] }).project;
  const state = createRuntime(project); step(project, state);
  assert.equal(state.inventory.selectedWeapon, 'shotgun'); assert.ok(state.inventory.keys.has('redSkull'));
  assert.equal(state.playerStats.shells, 100); assert.equal(state.playerStats.maxShells, 100);
  addRule(project, [{ type: 'selectWeapon', weapon: 'bfg' }], { type: 'always' });
  assert.throws(() => step(project, state), /unowned/);
  const invalid = fixture().project;
  addRule(invalid, [{ type: 'setKeyOwned', key: 'fake', owned: 'yes' }]); assert.throws(() => validateProject(invalid), /key/);
});
function pickupProject(types) {
  const base = createProject(); base.events = [];
  const project = installEngineScripts(base, { includeHUD: false });
  project.assets = project.assets.filter(asset => asset.kind === 'sound'); project.environment.weaponAsset = null;
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  for (const [index, type] of types.entries()) project.map.entities.push({ id: `pickup_${index}`, name: 'Pickup', type: 'pickup',
    x: -180, y: 0, angle: 0, doomType: type });
  installDoomInventoryScripts(project); validateProject(project);
  return project;
}
test('editable imported pickup rules collect ammo, weapons, all keys, armor and backpacks without hidden collection code', () => {
  const project = pickupProject([2007, 2001, 5, 6, 13, 40, 39, 38, 2018, 8]), state = createRuntime(project);
  step(project, state);
  assert.equal(state.playerStats.bullets, 70); assert.equal(state.playerStats.shells, 12);
  assert.equal(state.playerStats.maxBullets, 400);
  assert.equal(state.inventory.keys.size, 6); assert.ok(state.inventory.backpack);
  assert.ok(state.inventory.weapons.has('shotgun')); assert.equal(state.inventory.selectedWeapon, 'shotgun');
  assert.equal(state.playerStats.armor, 100); assert.equal(state.entities.filter(entity => entity.type === 'pickup').length, 0);
  const x = state.player.x;
  step(project, state, ['Digit2'], ['KeyW']);
  assert.equal(state.inventory.selectedWeapon, 'pistol'); assert.ok(state.player.x > x);
});
test('pickup scripts preserve full health/ammo pickups, isolate per-instance needs and do not collect at a distance', () => {
  const project = pickupProject([2011, 2012, 2013, 2007]), state = createRuntime(project);
  state.entities.at(-1).x = 100; step(project, state);
  assert.equal(state.playerStats.health, 200, 'soul sphere can raise health above 100');
  assert.equal(state.entities.filter(entity => entity.type === 'pickup').length, 3);
  state.playerStats.health = 50; state.playerStats.bullets = 200;
  state.entities.at(-1).x = -180; step(project, state);
  assert.equal(state.playerStats.health, 85); assert.equal(state.playerStats.bullets, 200);
  assert.equal(state.entities.filter(entity => entity.type === 'pickup').length, 1);
  const another = pickupProject([2007, 2007]), other = createRuntime(another); step(another, other);
  assert.equal(other.playerStats.bullets, 70);
});
test('pickup reach uses axis overlap and vertical limits, rejects walls, and remains editable and validated', () => {
  for (const [dx, dy, z, blocked, collects] of [
    [35, 35, 32, false, true], [36, 0, 0, false, false], [0, 36, 0, false, false],
    [30, 0, 56, false, true], [30, 0, 57, false, false], [30, 0, -8, false, true],
    [30, 0, -9, false, false], [30, 0, 0, true, false],
  ]) {
    const p = pickupProject([2014]), s = createRuntime(p), item = s.entities.find(e => e.type === 'pickup');
    item.x = s.player.x + dx; item.y = s.player.y + dy; item.z = z; s.player.z = 0;
    if (blocked) s.walls.push({ solid: true, start: { x: s.player.x + 15, y: -40 }, end: { x: s.player.x + 15, y: 40 } });
    step(p, s);
    assert.equal(!s.entities.includes(item), collects, JSON.stringify({ dx, dy, z, blocked }));
  }
  for (const patch of [{ distance: -1 }, { height: Infinity }, { below: -1 }, { entityId: 'missing' }]) {
    const p = pickupProject([2014]);
    const reach = p.events.flatMap(e => e.conditions || []).find(c => c.type === 'playerReachesEntity');
    Object.assign(reach, patch);
    assert.throws(() => validateProject(p));
  }
});
test('Doom pickup and selection rules fire shotgun shells instead of pistol bullets with a shared refire gate', () => {
  const project = pickupProject([2001]), state = createRuntime(project);
  step(project, state);
  const bullets = state.playerStats.bullets, shells = state.playerStats.shells;
  for (let i = 0; i < 30; i++) step(project, state, [], ['Mouse0']);
  assert.equal(state.playerStats.bullets, bullets); assert.equal(state.playerStats.shells, shells - 1);
  step(project, state, ['Digit2']); step(project, state, [], ['Mouse0']);
  assert.equal(state.playerStats.bullets, bullets, 'switching cannot bypass the shared weapon cooldown');
  for (let i = 0; i < 10; i++) step(project, state);
  step(project, state, [], ['Mouse0']);
  assert.equal(state.playerStats.bullets, bullets - 1);
});
test('WAD HUD and inventory references reject unknown bindings, image mappings and invalid state commands', () => {
  for (const change of [
    p => { p.hud.elements[0].visibilityBinding = 'key:missing'; },
    p => { p.hud.elements[0].maxLength = 0; },
    p => { p.hud.reserveBottom = 200; },
    p => { p.environment.weaponAssets = { fakeWeapon: null }; },
    p => { p.environment.weaponAssets = { pistol: 'missing' }; },
    p => { addRule(p, [{ type: 'damagePlayer', damage: 10, direction: 'up' }]); },
    p => { addRule(p, [{ type: 'setPlayerFace', expression: 'fake' }]); },
  ]) { const { project } = fixture(); change(project); assert.throws(() => validateProject(project)); }
});
test('Freedoom status bar imports with its artwork on MAP01 and survives disk persistence and runtime reset', { skip: !existsSync(wadPath) }, () => {
  const { project, warnings } = importWad(readFileSync(wadPath), 'MAP01');
  assert.equal(project.playerControl, 'events');
  assert.ok(project.assets.some(asset => asset.name === 'STBAR'));
  assert.ok(project.hud.elements.some(element => element.name === 'Player face'));
  assert.equal(project.hud.fonts.length, 2); assert.equal(project.hud.animations.length, 5);
  assert.ok(!warnings.some(warning => /Missing HUD|Incomplete .*HUD/.test(warning)));
  const state = createRuntime(project); step(project, state);
  assert.equal(hudText(project.hud.elements.find(element => element.name === 'Selected weapon ammo'), state), '50');
  state.inventory.keys.add('redCard'); assert.equal(createRuntime(project).inventory.keys.size, 0);
  for (const ammo of ['bullets', 'shells', 'rockets', 'cells']) assert.ok(state.playerStats[ammoMaximum(ammo)] > 0);
  const directory = mkdtempSync(join(tmpdir(), 'opendle-doom-hud-'));
  try {
    const path = join(directory, 'project.json');
    new ProjectStore(path).update(project, 0);
    assert.deepEqual(new ProjectStore(path).snapshot().project.hud, project.hud);
  } finally { rmSync(directory, { recursive: true }); }
});
