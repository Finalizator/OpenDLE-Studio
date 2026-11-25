// Regressions from the 50-bug hunt: screens, checkpoints, and the id Tech importer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime } from '../shared/runtime.js';
import { buildVanillaActors } from '../shared/actors.js';
import { setGameScreen, gameSettings } from '../shared/game-settings.js';
import { setArray } from '../shared/arrays.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { createSaveStore } from '../shared/player-saves.js';
import { saveFileDocument, serializeSaveFile, parseSaveFile } from '../shared/save-files.js';
import { parseIdTechMap } from '../shared/idtech-map.js';

function project() {
  const p = createProject();
  p.events = [];
  p.actors = buildVanillaActors();
  installEngineScripts(p, { includeHUD: false });
  return p;
}

test('hunt 50: Escape leaves the pause screen', () => {
  const state = createRuntime(project(), { gameMode: true, screen: 'playing' });
  setGameScreen(state, 'pause');
  // Before: entering pause cleared the menu history, and `return` fell back to "pause", so the key
  // that opened the pause menu could not close it — the player was stuck until they clicked Resume.
  setGameScreen(state, 'return');
  assert.equal(state.gameScreen, 'playing');
  assert.equal(state.hasGame, true);
});

test('hunt 50: return from a submenu still goes back to the pause screen, then to play', () => {
  const state = createRuntime(project(), { gameMode: true, screen: 'playing' });
  setGameScreen(state, 'pause');
  setGameScreen(state, 'options');
  setGameScreen(state, 'return');
  assert.equal(state.gameScreen, 'pause');
  setGameScreen(state, 'return');
  assert.equal(state.gameScreen, 'playing');
});

/** A storage a test can inspect: the same four methods the game's save store uses. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    data,
  };
}

test('hunt 50: a save slot keeps the inventory, the arrays and the level the player was on', () => {
  const p = project();
  setArray(p, 'grid', { rows: 2, columns: 2 });
  const played = createRuntime(p, { settings: gameSettings(), screen: 'playing' });
  played.hasGame = true;
  played.inventory.weapons.add('shotgun');
  played.inventory.keys.add('blueCard');
  played.inventory.selectedWeapon = 'shotgun';
  played.inventory.backpack = true;
  played.arrays.grid[1][0] = 9;
  played.playerStats.shells = 12;
  played.weaponActor = 'thing';
  played.weaponSlot = 'pistol';
  played.weaponAttack = { kind: 'hitscan', damage: [5, 1] };

  const store = createSaveStore(memoryStorage(), { identity: 'probe-game' });
  store.writeSlot(1, captureGameSave(p, played, 'probe-game'));
  const record = JSON.parse(JSON.stringify(store.readSlot(1)));

  // Before: the slot was answered with "save slots belong to the studio" and nothing was written, so
  // a player's progress was gone at the next launch. The record itself used to be a shape that
  // turned the inventory's Sets into `{}` and dropped the live arrays.
  const loaded = restoreGameSave(p, record, 'probe-game').runtime;
  assert.deepEqual([...loaded.inventory.weapons].sort().filter(name => name !== 'fist'),
    ['pistol', 'shotgun'].filter(name => name !== 'fist'), 'the weapons the player had');
  assert.equal(loaded.inventory.keys.has('blueCard'), true);
  assert.equal(loaded.inventory.selectedWeapon, 'shotgun');
  assert.equal(loaded.inventory.backpack, true);
  assert.equal(loaded.arrays.grid[1][0], 9, 'a live array edit survives the save');
  assert.equal(loaded.playerStats.shells, 12);
  assert.equal(loaded.gameScreen, 'playing', 'a load resumes the game, it does not open a menu');
});

test('hunt 50: the save screen lists what each slot holds, and a damaged slot says so', () => {
  const store = createSaveStore(memoryStorage(), { identity: 'probe-game' });
  assert.deepEqual(store.slotLabels(), ['', '', '', '', '', '']);
  const p = project();
  const played = createRuntime(p, { settings: gameSettings(), screen: 'playing' });
  played.hasGame = true;
  store.writeSlot(2, captureGameSave(p, played, 'probe-game'));
  const labels = store.slotLabels();
  assert.equal(labels[0], '');
  assert.match(labels[1], /^Level \/ /, labels[1]);
  // A hand-edited slot is reported by name instead of reading as empty and then refusing to load.
  store.writeFile('placeholder', 'x');
  store.writeSlot(3, captureGameSave(p, played, 'probe-game'));
  const key = [...store.fileNames(), 'unused'];
  assert.ok(key.length > 0);
  const raw = memoryStorage();
  const broken = createSaveStore(raw, { identity: 'probe-game' });
  raw.setItem('opendle-game:probe-game:slot:4', '{not json');
  assert.match(broken.slotLabels()[3], /^Damaged: /, broken.slotLabels()[3]);
  assert.throws(() => broken.readSlot(4), /damaged/);
});

test('hunt 50: a save cannot conjure a weapon, and a tampered record is refused', () => {
  const p = project();
  const played = createRuntime(p, { settings: gameSettings(), screen: 'playing' });
  played.hasGame = true;
  played.inventory.weapons.add('shotgun');
  const record = JSON.parse(JSON.stringify(captureGameSave(p, played, 'probe-game')));
  // Hand-editing a record is caught by its checksum, not by trusting the fields.
  record.snapshot.entityLookup = null;
  assert.throws(() => restoreGameSave(p, record, 'probe-game'), /checksum/);
  // A record from another game is refused by name.
  assert.throws(() => restoreGameSave(p, JSON.parse(JSON.stringify(captureGameSave(p, played, 'probe-game'))), 'other-game'),
    /different game/);
  assert.throws(() => createSaveStore(memoryStorage(), { identity: 'probe-game' }).readSlot(9), /no save slot 9/);
});

test('hunt 50: a whole-game save file is the same envelope the studio writes', () => {
  const p = project();
  const played = createRuntime(p, { settings: gameSettings(), screen: 'playing' });
  played.hasGame = true;
  const record = captureGameSave(p, played, 'probe-game');
  const store = createSaveStore(memoryStorage(), { identity: 'probe-game' });
  store.writeFile('checkpoint', serializeSaveFile(saveFileDocument({
    kind: 'game', name: 'checkpoint', identity: 'probe-game', levelId: null, record })));
  const document = parseSaveFile(store.readFile('checkpoint'));
  assert.equal(document.kind, 'game');
  assert.deepEqual(store.fileNames(), ['checkpoint']);
  // The same document the studio's Save files dialog reads: a player can move a save between them.
  assert.equal(document.record.identity, 'probe-game');
  assert.equal(typeof document.record.checksum, 'string');
  assert.doesNotThrow(() => restoreGameSave(p, document.record, 'probe-game'));
});

test('hunt 50: a truncated .map is refused with the line it was opened on', () => {
  const box = '( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick 0 0 0 1 1\n';
  // Before: the loops ended at end-of-file and the entity was accepted, so a cut-off download
  // imported as a complete level with whatever geometry had arrived.
  assert.throws(() => parseIdTechMap('{ "classname" "worldspawn"', { name: 'a.map' }),
    /line 1: expected "}" to close the entity/);
  assert.throws(() => parseIdTechMap(`{ "classname" "worldspawn"\n{\n${box}`, { name: 'b.map' }),
    /line 2: expected "}" to close the brush/);
  assert.throws(() => parseIdTechMap('{ "classname" "worldspawn" } { "classname" "light"', { name: 'c.map' }),
    /expected "}"/);
  // A complete file still parses, and so does an entity with no brushes.
  const complete = `{ "classname" "worldspawn"\n{\n${box}}\n}`;
  assert.equal(parseIdTechMap(complete, { name: 'd.map' }).entities.length, 1);
  assert.equal(parseIdTechMap('{ "classname" "light" "origin" "0 0 0" }', { name: 'e.map' }).entities.length, 1);
});
