import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cloneProjectData, cloneProjectForEdit, createProject, validateProject } from '../shared/project.js';
import { ENGINE_SCRIPTLETS, installScriptlet, removeScriptlet, scriptletById } from './scriptlet-library.js';
import { buildSurfTestMap, installSourceMovementScriptlet } from '../scriptlets/source-movement.js';
import { newScene, addSceneObject } from '../shared/scenes.js';
import { newJoint } from '../shared/joints.js';
import { createCue, createTimesheet } from '../shared/timesheet.js';
import { createScriptletRegistry, validateScriptlet } from '../shared/scriptlets.js';
import { LIMITS } from '../shared/limits.js';
import { isImageAsset } from '../shared/media-assets.js';

const wallWalking = () => ENGINE_SCRIPTLETS.find(scriptlet => scriptlet.id === 'wall-walking');
const withArtwork = () => {
  const project = createProject();
  project.assets = [{ id: 'picture', name: 'Picture', kind: 'sprite', width: 1, height: 1,
    src: 'data:image/png;base64,AAAA' }];
  return project;
};

function panelFixture(project, scriptletLibrary) {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const elements = new Map(), buttons = [], history = [];
  const element = () => ({ children: [], append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; } });
  const context = vm.createContext({
    project, scriptletLibrary, scriptletsLoading: false, scriptletsLoaded: true, scriptletLoadError: '',
    $: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    make: (tag, textContent) => ({ ...element(), tag, textContent }),
    button: (textContent, action) => { const result = { textContent, action }; buttons.push(result); return result; },
    cloneProjectData, cloneProjectForEdit, createProject,
    editHistoryLimit: () => 10, confirm: () => true, openScript() {},
    commit(next) { history.push(context.project); context.project = next; },
    render() {},
  });
  vm.runInContext([
    source.slice(source.indexOf('function edit('), source.indexOf('function editGame(')),
    source.slice(source.indexOf('function renderScriptlets('), source.indexOf('function showTab(')),
  ].join('\n'), context);
  context.renderScriptlets();
  return { context, elements, buttons, history };
}

test('renaming a built-in sheet does not detach its scriptlet or delete a different same-named sheet', () => {
  for (const scriptlet of ENGINE_SCRIPTLETS) {
    const project = withArtwork();
    const sheetId = installScriptlet(project, scriptlet.id);
    const sheet = project.eventSheets.find(item => item.id === sheetId), originalName = sheet.name;
    sheet.name = 'My renamed behavior';
    project.eventSheets.push({ id: 'unrelated_sheet', name: originalName, section: 'game',
      enabled: true, phase: 'afterPhysics' });
    project.events.push({ id: 'unrelated_rule', sheetId: 'unrelated_sheet', enabled: true, once: false,
      condition: { type: 'always' }, actions: [] });
    validateProject(project);
    assert.equal(scriptlet.installed(project), scriptlet.rules, scriptlet.id);
    assert.equal(installScriptlet(project, scriptlet.id), sheetId, 'reinstall the original renamed sheet');
    assert.equal(project.eventSheets.find(item => item.id === sheetId).name, 'My renamed behavior');
    validateProject(project);
    assert.equal(removeScriptlet(project, scriptlet.id), true);
    assert.ok(project.events.some(event => event.id === 'unrelated_rule'), 'same-named hand-authored sheet survives');
    assert.ok(!project.eventSheets.some(item => item.id === sheetId));
    validateProject(project);
  }
});

test('built-in generators avoid collisions with every globally validated project ID', () => {
  for (const scriptlet of ENGINE_SCRIPTLETS) {
    for (const collision of ['sheet', 'event']) {
      const project = withArtwork();
      const reference = withArtwork();
      const generatedSheet = installScriptlet(reference, scriptlet.id);
      const reserved = collision === 'sheet' ? generatedSheet : reference.events.find(event => event.sheetId === generatedSheet).id;
      project.assets[0].id = reserved;
      validateProject(project);
      installScriptlet(project, scriptlet.id);
      assert.doesNotThrow(() => validateProject(project), `${scriptlet.id}: ${collision} collides with artwork`);
    }
  }
});

test('reinstalling legacy built-ins adopts their existing sheet without losing its settings or groups', () => {
  for (const scriptlet of ENGINE_SCRIPTLETS) {
    const project = withArtwork();
    const sheetId = installScriptlet(project, scriptlet.id);
    const sheet = project.eventSheets.find(item => item.id === sheetId);
    delete sheet.scriptletId;
    sheet.enabled = false;
    project.eventGroups = [{ id: 'custom_group', name: 'Custom group', enabled: false, sheetId }];
    assert.equal(installScriptlet(project, scriptlet.id), sheetId);
    assert.equal(sheet.scriptletId, scriptlet.id);
    assert.equal(sheet.enabled, false);
    assert.equal(project.eventGroups[0].id, 'custom_group');
    validateProject(project);
  }
});

test('ambiguous legacy or tagged scriptlet sheets are refused before destructive edits', () => {
  for (const tagged of [false, true]) {
    for (const scriptlet of ENGINE_SCRIPTLETS) {
      const project = withArtwork();
      const sheetId = installScriptlet(project, scriptlet.id);
      const sheet = project.eventSheets.find(item => item.id === sheetId);
      if (!tagged) delete sheet.scriptletId;
      project.eventSheets.push({ ...sheet, id: 'duplicate_scriptlet_sheet' });
      validateProject(project);
      const before = structuredClone(project);
      assert.throws(() => installScriptlet(project, scriptlet.id), /Multiple event sheets/);
      assert.deepEqual(project, before);
      assert.throws(() => removeScriptlet(project, scriptlet.id), /Multiple event sheets/);
      assert.deepEqual(project, before);
    }
  }
});

test('Source movement reinstall tracks every generated ramp for subsequent removal', () => {
  const project = createProject();
  installSourceMovementScriptlet(project, { ramps: 2 });
  const first = [...project.sourceMovementRamps];
  installSourceMovementScriptlet(project, { ramps: 2 });
  assert.equal(project.sourceMovementRamps.length, 4);
  assert.ok(first.every(id => project.sourceMovementRamps.includes(id)));
  removeScriptlet(project, 'source-movement');
  assert.equal(project.map.entities.filter(entity => entity.type === 'ramp').length, 0);
  validateProject(project);
});

test('invalid or excessive Source ramp counts fail before modifying the sheet or map', () => {
  for (const ramps of [-1, 1.5, NaN, Infinity, '2', LIMITS.entities]) {
    const project = createProject(), before = structuredClone(project);
    assert.throws(() => installSourceMovementScriptlet(project, { ramps }), /ramp count/);
    assert.deepEqual(project, before);
  }
});

test('the Scriptlets panel can remove empty sheets and leftover Source ramps with no rules', () => {
  for (const scriptlet of ENGINE_SCRIPTLETS) {
    const project = withArtwork();
    const sheetId = installScriptlet(project, scriptlet.id);
    project.events = project.events.filter(event => event.sheetId !== sheetId);
    const fixture = panelFixture(project, { scriptlets: [scriptlet], errors: [], installScriptlet, removeScriptlet });
    const remove = fixture.buttons.find(button => button.textContent === 'Remove its rules');
    assert.ok(remove, `${scriptlet.id}: an empty sheet must still be removable`);
    remove.action();
    assert.ok(!fixture.context.project.eventSheets.some(sheet => sheet.id === sheetId));
  }
  const project = buildSurfTestMap(createProject());
  const sheet = project.eventSheets.find(sheet => sheet.name === 'Half-Life movement (Source)');
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  project.eventSheets = project.eventSheets.filter(item => item !== sheet);
  const scriptlet = scriptletById('source-movement');
  const fixture = panelFixture(project, { scriptlets: [scriptlet], errors: [], installScriptlet, removeScriptlet });
  const remove = fixture.buttons.find(button => button.textContent === 'Remove its rules');
  assert.ok(remove, 'ramps must remain removable after deleting the sheet manually');
  remove.action();
  assert.ok(!fixture.context.project.map.entities.some(entity => entity.type === 'ramp'));
  validateProject(fixture.context.project);
});

test('custom install and removal cannot mutate live shared campaign data when the edit fails', () => {
  for (const operation of ['install', 'remove']) {
    const project = withArtwork();
    project.actors = { definitions: [{ name: 'Original actor' }] };
    project.game = { levels: [{ name: 'Original level' }] };
    const before = structuredClone(project);
    const scriptlet = { ...wallWalking(), installed: () => operation === 'remove' ? 1 : 0 };
    const mutate = draft => {
      draft.assets[0].name = 'Leaked asset';
      draft.actors.definitions[0].name = 'Leaked actor';
      draft.game.levels[0].name = 'Leaked level';
      throw new Error('Custom callback failed');
    };
    const fixture = panelFixture(project, { scriptlets: [scriptlet], errors: [],
      installScriptlet: mutate, removeScriptlet: mutate });
    const action = fixture.buttons.find(button => button.textContent === (operation === 'install' ? 'Add to project' : 'Remove its rules'));
    assert.throws(() => action.action(), /Custom callback failed/);
    assert.deepEqual(project, before, `${operation}: a refused edit must not change the live document`);
    assert.equal(fixture.history.length, 0);
  }
});

test('successful custom scriptlet edits leave their undo snapshots isolated', () => {
  const project = withArtwork();
  project.actors = { definitions: [{ name: 'Original actor' }] };
  project.game = { levels: [{ name: 'Original level' }] };
  const before = structuredClone(project);
  const fixture = panelFixture(project, { scriptlets: [wallWalking()], errors: [],
    installScriptlet(draft) {
      draft.assets[0].name = 'New asset';
      draft.actors.definitions[0].name = 'New actor';
      draft.game.levels[0].name = 'New level';
      return 'new_sheet';
    } });
  fixture.buttons.find(button => button.textContent === 'Add to project').action();
  assert.deepEqual(fixture.history[0], before, 'undo must preserve all original data');
  assert.equal(fixture.context.project.assets[0].name, 'New asset');
});

test('spray artwork selection and its image field never mistake imported videos for images', () => {
  const project = withArtwork();
  const video = { id: 'movie', name: 'Movie', kind: 'video', format: 'mp4', src: 'data:video/mp4;base64,AAAA' };
  project.assets.unshift(video);
  validateProject(project);
  const sheetId = installScriptlet(project, 'spray');
  const action = project.events.find(event => event.sheetId === sheetId).actions[0];
  assert.equal(action.assetId, 'picture');
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const options = vm.runInNewContext(`${source.slice(source.indexOf('function imageAssetOptions()'),
    source.indexOf('function readEngineTweaks()'))}\nimageAssetOptions()`, { project, isImageAsset });
  assert.deepEqual(Array.from(options, option => option[0]), ['picture'], 'the image action picker excludes movies too');
  action.assetId = video.id;
  assert.throws(() => validateProject(project), /imported image asset/);
  const onlyVideo = createProject();
  onlyVideo.assets = [video];
  const before = structuredClone(onlyVideo);
  assert.throws(() => installScriptlet(onlyVideo, 'spray'), /Import an image/);
  assert.deepEqual(onlyVideo, before);
});

test('invalid custom presence callbacks are reported without breaking other scriptlet cards', () => {
  const project = withArtwork();
  const broken = { ...wallWalking(), id: 'broken', name: 'Broken', present: () => 1 };
  const fixture = panelFixture(project, { scriptlets: [broken, wallWalking()], errors: [] });
  assert.equal(fixture.buttons.length, 1, 'the valid scriptlet still has its install button');
  assert.match(fixture.elements.get('scriptlet-errors').children[0].textContent, /Broken: present.*boolean/);
  assert.equal(project.events.length, 2);
});

test('scriptlet module validation rejects malformed metadata and asynchronous callbacks', () => {
  const valid = wallWalking();
  for (const value of [undefined, [], null, {}, { ...valid, id: '../bad' }, { ...valid, name: '' },
    { ...valid, summary: null }, { ...valid, detail: ' ' }, { ...valid, rules: -1 }, { ...valid, rules: 1.5 },
    { ...valid, install: null }, { ...valid, remove: async () => true }, { ...valid, installed: function* () {} },
    { ...valid, build: 'not a function' }, { ...valid, buildDetail: 123 }, { ...valid, present: null },
    { ...valid, present: async () => true }]) {
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
