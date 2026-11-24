// Regressions from the 50-bug hunt: screens, checkpoints, and the id Tech importer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime } from '../shared/runtime.js';
import { buildVanillaActors } from '../shared/actors.js';
import { setGameScreen, gameSettings } from '../shared/game-settings.js';
import { setArray } from '../shared/arrays.js';
import { parseIdTechMap } from '../shared/idtech-map.js';
import { checkpointDocument, applyCheckpoint } from '../shared/game-checkpoint.js';

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

test('hunt 50: a checkpoint keeps the inventory the player had', () => {
  const p = project();
  setArray(p, 'grid', { rows: 2, columns: 2 });
  const saved = createRuntime(p, { settings: gameSettings() });
  saved.inventory.weapons.add('shotgun');
  saved.inventory.keys.add('blueCard');
  saved.inventory.selectedWeapon = 'shotgun';
  saved.inventory.backpack = true;
  saved.arrays.grid[1][0] = 9;
  saved.playerStats.shells = 12;
  saved.weaponActor = 'thing';
  saved.weaponSlot = 'pistol';
  saved.weaponAttack = { kind: 'hitscan', damage: [5, 1] };
  const text = JSON.stringify(checkpointDocument(saved, 'MAP01'));

  const loaded = createRuntime(p, { settings: gameSettings() });
  applyCheckpoint(loaded, JSON.parse(text));
  // Before: the document carried the inventory as two Sets — which JSON turned into `{}` — and the
  // restore never looked at it, so a loaded game handed the player a pistol and no keys.
  assert.deepEqual([...loaded.inventory.weapons].sort(), ['fist', 'pistol', 'shotgun']);
  assert.equal(loaded.inventory.keys.has('blueCard'), true);
  assert.equal(loaded.inventory.selectedWeapon, 'shotgun');
  assert.equal(loaded.inventory.backpack, true);
  assert.equal(loaded.arrays.grid[1][0], 9, 'a live array edit survives the save');
  assert.equal(loaded.playerStats.shells, 12);
  // The weapon machine is re-entered on the next tic instead of finishing a pre-save animation.
  assert.equal(loaded.weaponActor, null);
  assert.equal(loaded.weaponAttack, null);
  assert.equal(loaded.weaponTriggerHeld, false);
});

test('hunt 50: a checkpoint cannot conjure weapons, keys or grids this game does not have', () => {
  const p = project();
  setArray(p, 'grid', { rows: 2, columns: 2 });
  const loaded = createRuntime(p, { settings: gameSettings() });
  applyCheckpoint(loaded, {
    kind: 'opendle-checkpoint', version: 1,
    inventory: { weapons: ['shotgun', 'banana'], keys: ['blueCard', 'skeletonKey'], selectedWeapon: 'banana', backpack: 1 },
    arrays: { grid: [[1, 2], [3, 4]], ghost: [[9]] },
    playerStats: { health: 50, shells: 'many' },
  });
  assert.deepEqual([...loaded.inventory.weapons], ['shotgun'], 'only known weapons are kept');
  assert.deepEqual([...loaded.inventory.keys], ['blueCard']);
  assert.equal(loaded.inventory.selectedWeapon, 'pistol', 'an unknown selection leaves the current weapon');
  assert.deepEqual(loaded.arrays.grid, [[1, 2], [3, 4]]);
  assert.equal(loaded.arrays.ghost, undefined, 'a grid this level does not have is ignored');
  assert.equal(loaded.playerStats.health, 50);
  assert.equal(typeof loaded.playerStats.shells, 'number', 'a non-numeric stat is not written');
  assert.throws(() => applyCheckpoint(loaded, { kind: 'other' }), /not a checkpoint/);
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
