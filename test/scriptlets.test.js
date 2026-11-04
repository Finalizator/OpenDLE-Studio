import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { ENGINE_SCRIPTLETS, installScriptlet, removeScriptlet, scriptletById } from './scriptlet-library.js';
import { buildSurfTestMap } from '../scriptlets/source-movement.js';
import { newScene, addSceneObject } from '../shared/scenes.js';
import { newJoint } from '../shared/joints.js';
import { createCue, createTimesheet } from '../shared/timesheet.js';
import { createScriptletRegistry, validateScriptlet } from '../shared/scriptlets.js';

const wallWalking = () => ENGINE_SCRIPTLETS.find(scriptlet => scriptlet.id === 'wall-walking');

test('scriptlet module validation rejects malformed metadata and asynchronous callbacks', () => {
  const valid = wallWalking();
  for (const value of [undefined, [], null, {}, { ...valid, id: '../bad' }, { ...valid, name: '' },
    { ...valid, summary: null }, { ...valid, detail: ' ' }, { ...valid, rules: -1 }, { ...valid, rules: 1.5 },
    { ...valid, install: null }, { ...valid, remove: async () => true }, { ...valid, installed: function* () {} },
    { ...valid, build: 'not a function' }, { ...valid, buildDetail: 123 }]) {
    assert.throws(() => validateScriptlet(value));
  }
  assert.equal(validateScriptlet(valid), valid);
});

test('scriptlet registries stay isolated and never import remote or malformed manifest entries', async () => {
  const first = createScriptletRegistry(), second = createScriptletRegistry();
  const url = `/scriptlets/custom.js?v=${'a'.repeat(64)}`;
  let imports = 0;
  const importModule = async () => { imports++; return { default: wallWalking() }; };
  await first.load([{ name: 'custom.js', url }, { name: 'remote.js', url: 'https://example.com/remote.js' }, null], importModule);
  assert.equal(imports, 1);
  assert.equal(first.scriptlets.length, 1);
  assert.deepEqual(first.errors.map(error => error.name), ['remote.js', 'Unknown file']);
  assert.deepEqual(second.scriptlets, []);
  assert.throws(() => second.scriptletById('wall-walking'), /Unknown engine scriptlet/);
  await assert.rejects(first.load(undefined), /files list/);
  assert.equal(first.scriptlets.length, 1, 'a failed manifest must not silently pretend loading succeeded');
});

test('a slower folder refresh cannot overwrite newer scriptlet results', async () => {
  const registry = createScriptletRegistry();
  const files = [{ name: 'custom.js', url: `/scriptlets/custom.js?v=${'a'.repeat(64)}` }];
  let finish;
  const slow = registry.load(files, () => new Promise(resolve => { finish = resolve; }));
  await registry.load([]);
  finish({ default: wallWalking() });
  await slow;
  assert.deepEqual(registry.scriptlets, []);
  assert.deepEqual(registry.errors, []);
});

test('invalid custom callback results fail explicitly instead of reporting a successful project edit', async () => {
  const registry = createScriptletRegistry();
  const files = [{ name: 'custom.js', url: `/scriptlets/custom.js?v=${'a'.repeat(64)}` }];
  for (const result of [undefined, 'missing_sheet', Promise.resolve('sheet')]) {
    await registry.load(files, async () => ({ default: { ...wallWalking(), install: () => result } }));
    assert.throws(() => registry.installScriptlet(createProject(), 'wall-walking'), /installed event sheet id/);
  }
  for (const result of [undefined, 1, Promise.resolve(true)]) {
    await registry.load(files, async () => ({ default: { ...wallWalking(), remove: () => result } }));
    assert.throws(() => registry.removeScriptlet(createProject(), 'wall-walking'), /boolean synchronously/);
  }
});

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

test('removing grouped scriptlets removes their sheet groups and scene rules without invalidating the project', () => {
  for (const id of ['wall-walking', 'spray', 'source-movement']) {
    const project = createProject();
    project.assets = [{ id: 'picture', name: 'Picture', kind: 'sprite', width: 1, height: 1,
      src: 'data:image/png;base64,AAAA' }];
    const sheetId = installScriptlet(project, id);
    const group = { id: 'scriptlet_group', name: 'Customized rules', sheetId, enabled: true };
    project.eventGroups = [group];
    project.events.find(event => event.sheetId === sheetId).groupId = group.id;
    const scene = newScene('Reusable behavior');
    const node = addSceneObject(scene, { name: 'Node' });
    scene.events = [{ id: 'scene_rule', sheetId, groupId: group.id, ownerId: node.id, enabled: true, once: false,
      condition: { type: 'always' }, actions: [] }];
    project.scenes = [scene];
    validateProject(project);
    removeScriptlet(project, id);
    assert.deepEqual(project.eventGroups, [], id);
    assert.deepEqual(scene.events, [], 'scene rules cannot retain the deleted sheet or group');
    validateProject(project);
  }
});

test('scriptlet removal rejects externally referenced groups before changing any project data', () => {
  for (const scope of ['layout', 'scene', 'timeline']) {
    const project = createProject();
    const sheetId = installScriptlet(project, 'wall-walking');
    const group = { id: 'scriptlet_group', name: 'Customized rules', sheetId, enabled: true };
    project.eventGroups = [group];
    const actions = [{ type: 'setGroupActive', groupId: group.id, active: 'no' }];
    const rule = { id: 'outside', enabled: true, once: false, condition: { type: 'always' }, actions };
    if (scope === 'layout') project.events.push(rule);
    else if (scope === 'scene') project.scenes = [{ ...newScene('External'), events: [rule] }];
    else {
      const sheet = createTimesheet({ id: 'timeline' });
      sheet.cues.push(createCue({ id: 'cue', trackId: sheet.tracks[0].id, actions }));
      project.timesheets = [sheet];
    }
    validateProject(project);
    const before = structuredClone(project);
    assert.throws(() => removeScriptlet(project, 'wall-walking'), /groups referenced/, scope);
    assert.deepEqual(project, before, 'a refusal must be atomic');
  }
});

test('removing Source movement ramps clears their scripts and constraints through normal object deletion', () => {
  const project = createProject();
  buildSurfTestMap(project);
  const rampId = project.sourceMovementRamps[0];
  const other = project.map.entities.find(entity => entity.id !== rampId && entity.physics);
  project.map.joints = [newJoint({ a: rampId, b: other.id })];
  project.events.push({ id: 'ramp_script', ownerId: rampId, enabled: true, once: false,
    condition: { type: 'always' }, actions: [] },
  { id: 'ramp_gate', enabled: true, once: false, condition: { type: 'nearEntity', entityId: rampId, distance: 100 },
    actions: [{ type: 'showMessage', message: 'near ramp' }] });
  validateProject(project);
  removeScriptlet(project, 'source-movement');
  assert.ok(!project.events.some(event => ['ramp_script', 'ramp_gate'].includes(event.id)));
  assert.deepEqual(project.map.joints, []);
  assert.equal(project.sourceMovementSurfRamp, undefined);
  validateProject(project);
});

test('refusing Source scriptlet removal also preserves its ramps and metadata', () => {
  const project = createProject();
  buildSurfTestMap(project);
  const sheetId = project.eventSheets.find(sheet => sheet.name === 'Half-Life movement (Source)').id;
  project.eventGroups.push({ id: 'source_group', name: 'Source group', sheetId, enabled: true });
  project.events.push({ id: 'keep_source_group', enabled: true, once: false, condition: { type: 'always' },
    actions: [{ type: 'setGroupActive', groupId: 'source_group', active: 'no' }] });
  validateProject(project);
  const before = structuredClone(project);
  assert.throws(() => removeScriptlet(project, 'source-movement'), /groups referenced/);
  assert.deepEqual(project, before);
});

test('the scriptlets live in their own editor tab, not in the event sheet tree', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /<button data-tab="scriptlets">Engine scriptlets<\/button>/);
  assert.match(html, /<section id="scriptlets-panel"/);
  assert.ok(!html.includes('id="add-wall-walk"'), 'the generator must not sit in the event sheet tree');
  assert.ok(app.includes("if (tab === 'scriptlets') void refreshScriptlets();"));
  assert.match(html, /id="scriptlet-reload"/);
  assert.match(html, /id="scriptlet-errors"[^>]+role="alert"/);
});
