// A save taken after something dropped an item has to load.
//
// A monster's death drop is a clone of a *template*: when the level never placed an item of that
// kind, the dropper builds one on the spot and keeps it in the level's entity list. That template
// was never part of a save, and the loader validates every object against what it was made from — so
// a save taken after a single kill was refused whole, with "unknown entity drop_1", which is what a
// player saw as "could not start the level" after saving on the second map and walking a few steps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { buildVanillaActors } from '../shared/actors.js';
import { createRuntime } from '../shared/runtime.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { actorOf, dropItems } from '../shared/actor-runtime.js';

/** A level with a monster that drops something, and a player, the way an imported game has them. */
function level() {
  const project = createProject();
  project.events = [];
  project.actors = buildVanillaActors();
  project.map.entities = [
    { id: 'player', name: 'Player start', type: 'player', x: 0, y: 0, angle: 0 },
    { id: 'zombie', name: 'Zombieman', type: 'enemy', actorName: 'Zombieman', x: 128, y: 0, angle: 0, health: 20 },
  ];
  return project;
}

/** Plays far enough that a monster has died and left its item behind. */
function killed(project) {
  const state = createRuntime(project, { gameMode: true, screen: 'playing' });
  const zombie = state.entities.find(entity => entity.type === 'enemy');
  const spawned = dropItems(project, state, zombie, actorOf(project, zombie));
  assert.ok(spawned > 0, 'the monster drops something');
  return { state, spawned };
}

test('a save with a monster\'s dropped item loads into a fresh copy of the level', () => {
  const played = level();
  const { state, spawned } = killed(played);
  const drops = state.entities.filter(entity => String(entity.id).startsWith('drop_'));
  assert.equal(drops.length, spawned);
  // Before: this threw "unknown entity drop_1" against a fresh level, so the whole save was refused.
  const record = JSON.parse(JSON.stringify(captureGameSave(played, state, 'probe')));
  const restored = restoreGameSave(level(), record, 'probe').runtime;
  const loaded = restored.entities.filter(entity => String(entity.id).startsWith('drop_'));
  assert.deepEqual(loaded.map(entity => entity.id), drops.map(entity => entity.id), 'the items are still there');
  assert.deepEqual(loaded.map(entity => entity.name), drops.map(entity => entity.name));
});

test('a drop remembers the item it was made from, so its template can be rebuilt', () => {
  const played = level();
  const { state } = killed(played);
  const drop = state.entities.find(entity => String(entity.id).startsWith('drop_'));
  assert.equal(typeof drop.droppedFrom, 'string');
  assert.equal(drop.droppedFrom, 'Clip', 'the drop table names the item, not the template');
  // A save written before that field existed still loads: the drop's own name answers instead.
  delete drop.droppedFrom;
  const record = JSON.parse(JSON.stringify(captureGameSave(played, state, 'probe')));
  const restored = restoreGameSave(level(), record, 'probe').runtime;
  assert.equal(restored.entities.filter(entity => String(entity.id).startsWith('drop_')).length, 1);
});

test('a dropped item nothing can explain is still refused, by name', () => {
  const played = level();
  const { state } = killed(played);
  // A game whose actor table no longer knows the item: the save itself is consistent (it is captured
  // from a real state, so its checksum matches), but the loader has nothing to rebuild it from.
  const drop = state.entities.find(entity => String(entity.id).startsWith('drop_'));
  drop.droppedFrom = 'item_from_a_removed_mod';
  const record = JSON.parse(JSON.stringify(captureGameSave(played, state, 'probe')));
  // Refused rather than loaded with an object nothing describes — the same rule as any other entity.
  assert.throws(() => restoreGameSave(level(), record, 'probe'), /unknown entity drop_/);
});
