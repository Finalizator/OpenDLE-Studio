import test from 'node:test';
import assert from 'node:assert/strict';
import { mainMenu, levelEntries, nextLevelId, optionRows, gameProgress, progressKey, skillLabel } from '../public/game/menu.js';
import { createProject } from '../shared/project.js';
import { GAME_SETTINGS } from '../shared/game-settings.js';

function campaign() {
  const project = createProject();
  project.title = 'Exported Hall';
  project.game = {
    version: 1, entry: 'hall', active: 'hall',
    levels: [
      { id: 'hall', name: 'The Hall', data: {}, assetIds: [], next: 'yard' },
      { id: 'yard', name: 'The Yard', data: {}, assetIds: [], next: null },
    ],
  };
  return project;
}

test('a game with levels offers new game, levels, options and quit', () => {
  const menu = mainMenu(campaign());
  assert.equal(menu.title, 'Exported Hall');
  assert.deepEqual(menu.actions.map(action => action.id), ['new', 'levels', 'options', 'quit']);
  assert.match(menu.subtitle, /2 levels/);
});

test('continue appears only when the remembered level still exists', () => {
  const project = campaign();
  const reached = gameProgress(project, { levelId: 'yard' });
  assert.deepEqual(reached, { levelId: 'yard', name: 'The Yard' });
  const menu = mainMenu(project, { progress: reached });
  assert.deepEqual(menu.actions.map(action => action.id), ['new', 'continue', 'levels', 'options', 'quit']);
  assert.match(menu.actions[1].hint, /The Yard/);
  // A level that was deleted since must not be resumed: the button would open nothing.
  assert.equal(gameProgress(project, { levelId: 'gone' }), null);
  assert.deepEqual(mainMenu(project, { progress: null }).actions.map(action => action.id), ['new', 'levels', 'options', 'quit']);
  assert.equal(gameProgress(project, null), null);
  assert.equal(gameProgress(project, 'nonsense'), null);
});

test('a single-level project offers play, not a level list', () => {
  const project = createProject();
  const menu = mainMenu(project);
  assert.deepEqual(menu.actions.map(action => action.id), ['new', 'options', 'quit']);
  assert.equal(menu.actions[0].label, 'Play');
  assert.equal(menu.subtitle, 'Single level');
  assert.equal(mainMenu(null).title, 'OpenDLE game');
});

test('the level list marks the start and what was reached', () => {
  const project = campaign();
  const entries = levelEntries(project, { progress: { levelId: 'yard', name: 'The Yard' } });
  assert.deepEqual(entries.map(entry => entry.id), ['hall', 'yard']);
  assert.equal(entries[0].current, true, 'the entry level is the one that runs');
  assert.match(entries[0].hint, /start/);
  assert.match(entries[1].hint, /reached/);
});

test('the campaign chain names the next level, and stops at the end', () => {
  const project = campaign();
  assert.equal(nextLevelId(project, 'hall'), 'yard');
  assert.equal(nextLevelId(project, 'yard'), null);
  assert.equal(nextLevelId(project, 'missing'), null);
  // A level that points at a level the game no longer has ends the campaign rather than crashing.
  project.game.levels[0].next = 'deleted';
  assert.equal(nextLevelId(project, 'hall'), null);
});

test('progress is remembered per game, so two exports do not share it', () => {
  assert.equal(progressKey('Exported Hall'), 'opendle-game-progress:Exported Hall');
  assert.notEqual(progressKey('One'), progressKey('Two'));
  assert.match(progressKey(''), /opendle-game-progress:/);
});

test('the options panel is built from the engine settings, in a sensible order', () => {
  const rows = optionRows({ volume: .3 }, GAME_SETTINGS);
  const names = rows.map(row => row.name);
  assert.ok(names.includes('masterVolume') && names.includes('sensitivity') && names.includes('difficulty'));
  assert.equal(names.indexOf('masterVolume') < names.indexOf('difficulty'), true);
  assert.equal(rows.find(row => row.name === 'volume').value, .3, 'the current value is shown');
  assert.equal(rows.find(row => row.name === 'volume').kind, 'range');
  assert.equal(rows.find(row => row.name === 'invertY').kind, 'toggle');
  assert.equal(rows.find(row => row.name === 'renderResolution').kind, 'choice');
  for (const row of rows) {
    if (row.kind !== 'range') continue;
    assert.ok(row.min < row.max, `${row.name} has a range`);
    assert.ok(Number(row.value) >= row.min && Number(row.value) <= row.max, `${row.name} starts inside its range`);
  }
  // A game package that predates a setting simply does not offer it.
  assert.deepEqual(optionRows({}, {}), []);
});

test('difficulty is named the way Doom names it, and clamps', () => {
  assert.equal(skillLabel(1), 'I am too young to die');
  assert.equal(skillLabel(4), 'Ultra-Violence');
  assert.equal(skillLabel(99), 'Nightmare!');
  assert.equal(skillLabel('junk'), 'Ultra-Violence');
});
