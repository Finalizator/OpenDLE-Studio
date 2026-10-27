import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { ENGINE_SCRIPTLETS, installScriptlet, removeScriptlet, scriptletById } from '../shared/scriptlets.js';

const wallWalking = () => ENGINE_SCRIPTLETS.find(scriptlet => scriptlet.id === 'wall-walking');

test('scriptlets install editable rules of their own and report what they added', () => {
  const project = createProject();
  const before = project.events.length;
  const sheetId = installScriptlet(project, 'wall-walking');
  assert.ok(sheetId, 'installing returns the sheet to open');
  assert.equal(project.events.length, before + 5);
  assert.equal(wallWalking().installed(project), 5);
  assert.equal(scriptletById('wall-walking').id, 'wall-walking');
  assert.doesNotThrow(() => validateProject(project));
  // Every generated rule uses commands any project can author.
  for (const event of project.events.filter(event => event.sheetId === sheetId)) {
    assert.ok(['playerTouchingSurface', 'playerAirborne', 'keyHeld', 'onStart'].includes(event.condition.type), event.condition.type);
  }
});

test('reinstalling replaces only the scriptlet own rules, and removing leaves no trace', () => {
  const project = createProject();
  const untouched = { id: 'mine', enabled: true, once: false, condition: { type: 'always' }, conditions: [], actions: [] };
  project.events.push(untouched);
  installScriptlet(project, 'wall-walking');
  const sheetId = installScriptlet(project, 'wall-walking');
  assert.equal(project.events.filter(event => event.sheetId === sheetId).length, 5, 'no duplicated rules');
  assert.ok(project.events.some(event => event.id === 'mine'), 'hand-written rules survive');
  assert.equal(removeScriptlet(project, 'wall-walking'), true);
  assert.equal(wallWalking().installed(project), 0);
  assert.equal(project.eventSheets.some(sheet => sheet.id === sheetId), false);
  // The starter project ships two rules of its own; the scriptlet adds or leaves none.
  assert.deepEqual(project.events.map(event => event.id), ['welcome', 'collect', 'mine']);
  assert.equal(removeScriptlet(project, 'wall-walking'), false, 'removing twice is harmless');
  assert.throws(() => installScriptlet(project, 'no-such-scriptlet'), /Unknown engine scriptlet/);
});

test('the scriptlets live in their own editor tab, not in the event sheet tree', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /<button data-tab="scriptlets">Engine scriptlets<\/button>/);
  assert.match(html, /<section id="scriptlets-panel"/);
  assert.ok(!html.includes('id="add-wall-walk"'), 'the generator must not sit in the event sheet tree');
  assert.ok(app.includes("if (tab === 'scriptlets') renderScriptlets();"));
});
