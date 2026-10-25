import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu, menuScreen } from '../shared/game-menu.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hudBinding } from '../shared/hud.js';

function project(definitions = []) {
  return installGameMenu(installEngineScripts(createProject()), null, definitions);
}
function click(p, s, name) {
  stepRuntime(p, s, 0, new Set());
  const item = p.hud.elements.find(item => item.name === name && item.interactive &&
    s.hudState.elements.get(item.id).visible);
  assert.ok(item, `${name} on ${s.gameScreen}`);
  s.hudState.clicked.add(item.id); stepRuntime(p, s, 0, new Set());
}
test('save/load pages are editable interface events with six persistent slot bindings', () => {
  const p = project(); validateProject(p);
  for (const name of ['save', 'load', 'save_confirm']) assert.ok(p.gameMenus.screens.includes(name));
  const s = createRuntime(p, { screen: 'pause' });
  s.saveSlots[0] = 'MAP01 / 02:04';
  click(p, s, 'Load game');
  assert.equal(s.gameScreen, 'load');
  assert.equal(hudBinding('game:save1', s), 'MAP01 / 02:04');
  assert.equal(hudBinding('game:save2', s), 'Empty slot');
  click(p, s, 'Load slot 2');
  assert.deepEqual(s.menuRequests, []);
  assert.match(s.saveStatus, /empty/);
  click(p, s, 'Load slot 1');
  assert.deepEqual(s.menuRequests, [{ type: 'load', slot: 1 }]);
});
test('save requests require a living running game and overwrites use native confirmation', () => {
  const p = project(), s = createRuntime(p, { screen: 'title' });
  click(p, s, 'Save game'); click(p, s, 'Save slot 1');
  assert.deepEqual(s.menuRequests, []); assert.match(s.saveStatus, /living game/);
  s.hasGame = true; s.saveSlots[0] = 'Old save';
  click(p, s, 'Save slot 1');
  assert.equal(s.gameScreen, 'save_confirm'); assert.deepEqual(s.menuRequests, []);
  click(p, s, 'Cancel');
  assert.equal(s.gameScreen, 'save'); assert.deepEqual(s.menuRequests, []);
  click(p, s, 'Save slot 1'); click(p, s, 'Overwrite save');
  assert.deepEqual(s.menuRequests, [{ type: 'save', slot: 1 }]);
  assert.equal(s.pendingSaveSlot, null);
});
test('original SaveGameMenu/LoadGameMenu templates populate native slots using authored coordinates', () => {
  const p = project([{ name: 'MENUDEF', source: `ListMenu "MainMenu" {
    TextItem "Save", "s", "SaveGameMenu"
    TextItem "Load", "l", "LoadGameMenu"
  }
  ListMenu "SaveGameMenu" {
    Position 40, 50
    LineSpacing 18
  }
  ListMenu "LoadGameMenu" {
    Position 45, 55
    LineSpacing 16
  }` }]);
  validateProject(p);
  assert.equal(menuScreen('SaveGameMenu'), 'save');
  assert.equal(menuScreen('LoadGameMenu'), 'load');
  for (const [name, x, y] of [['Save slot 2', 40, 68], ['Load slot 2', 45, 71]]) {
    const item = p.hud.elements.find(item => item.name === name);
    assert.equal(item.x, x * p.hud.width / 320);
    assert.equal(item.y, y * p.hud.height / 200);
    assert.ok(p.gameMenus.elementIds.includes(item.id));
  }
  const s = createRuntime(p, { screen: 'title' });
  click(p, s, 'Load');
  assert.equal(s.gameScreen, 'load');
  const event = p.events.find(event => event.actions.some(action => action.type === 'loadGame'));
  event.actions.find(action => action.type === 'loadGame').slot = 1.5;
  assert.throws(() => validateProject(p), /integer/);
});

test('long original menu labels preserve display text while metadata names remain portable', () => {
  const label = 'A long original game menu description '.repeat(4);
  const p = project([{ name: 'MENUDEF', source: `OptionMenu "MainMenu" {
    StaticText "${label}"
    Submenu "${label}", "LoadGameMenu"
  }` }]);
  validateProject(p);
  assert.ok(p.hud.elements.some(element => element.text === label && element.name.length === 100));
  assert.ok(p.events.every(event => !event.name || event.name.length <= 100));
});
