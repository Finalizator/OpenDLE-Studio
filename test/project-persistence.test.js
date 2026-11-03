import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import { cloneProjectForEdit, createProject, validateProject } from '../shared/project.js';
import { draftProject, recoverProject, writeProjectDraft } from '../public/project-recovery.js';
import { upgradeSceneInstances } from '../shared/entity-groups.js';
import { createProjectAutosave } from '../public/project-autosave.js';
import { ProjectStore } from '../server/store.js';
import { createApp } from '../server/index.js';
import { PNG } from 'pngjs';

function manyAssets() {
  const src = `data:image/png;base64,${PNG.sync.write(new PNG({ width: 1, height: 1 })).toString('base64')}`;
  return Array.from({ length: 301 }, (_, index) =>
    ({ id: `autosave_asset_${index}`, name: `Texture ${index}`, kind: 'texture', width: 1, height: 1, src }));
}

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function between(start, end) {
  const index = source.indexOf(start);
  assert.notEqual(index, -1, start);
  const stop = source.indexOf(end, index);
  assert.notEqual(stop, -1, end);
  return source.slice(index, stop);
}
function fixture(api = async () => {}) {
  const elements = new Map(), storage = new Map(), notices = [], timers = new Map(), listeners = new Map();
  let timerId = 0;
  const project = createProject(); project.title = 'First';
  const context = vm.createContext({
    project, projectId: 'first', revision: 1, projectTemporary: false, dirty: true, editVersion: 1,
    cloneProjectForEdit, UNDO_DEEP_GAME_STEPS: 10, undoDepthFor: () => 10,
    documentGeneration: 1, documentSession: { projectId: 'first', revision: 1, temporary: false },
    projectOperationBusy: false, projectOperationPending: null, liveEditState: null,
    draftSkipNoted: false, history: [], future: [], scenePose: null,
    cutResets: 0, cutTool: { cancel() { context.cutResets++; } },
    selection: null, scriptScope: '$all', sceneObjectEditor: null, openSceneIds: [], activeSceneId: null,
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, hidden: true, textContent: '',
        addEventListener: (event, handler) => listeners.set(`${id}:${event}`, handler) });
      return elements.get(id);
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    status: (message, error = false) => notices.push({ message, error }),
    api, validateProject, draftProject, recoverProject, writeProjectDraft, upgradeSceneInstances, confirm: () => true,
    draftTooLarge: () => (context.project.assets?.length || 0) > 300 || (context.project.game?.levels.length || 0) > 4,
    historyLimit: () => 10, syncRampModels() {}, render() {}, clearDraft() {}, fitMap() {}, renderSceneObjectTabs() {},
    upgradePickupReach: () => false, refreshProjects: async () => {}, badgeText: () => context.dirty ? 'Unsaved' : 'Saved',
    createProjectAutosave: options => createProjectAutosave({ ...options,
      setTimer: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimer: id => timers.delete(id) }),
    document: { activeElement: null, addEventListener: (event, handler) => listeners.set(`document:${event}`, handler) },
    window: { addEventListener: (event, handler) => listeners.set(`window:${event}`, handler) },
    guard: fn => fn,
  });
  vm.runInContext([
    between('const projectAutosave =', '// The Project tree').replace('const projectAutosave =', 'projectAutosave ='),
    between('function persistDraft()', 'function clearDraft()'),
    between('function bindProject(', '/** How many steps'),
    between('function commit(', '/** Stored projects, newest first'),
    between('async function saveProject()', '/**\n * Drains'),
    between("$('projects').addEventListener", "$('undo').addEventListener"),
    between('window.opendleSaveBeforeClose =', 'async function start()'),
  ].join('\n'), context);
  return { context, elements, storage, notices, timers, listeners };
}
function liveFixture() {
  const result = fixture();
  vm.runInContext(between('function editHistoryLimit(', 'function renderLive('), result.context);
  result.context.renderLive = () => {};
  return result;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a late save response cannot bind a newly opened document to the previous project', async () => {
  const request = deferred();
  const { context, elements, storage } = fixture(() => request.promise);
  const original = context.historySnapshot();
  const saving = context.saveProject();
  const replacement = createProject(); replacement.title = 'Second';
  context.replace(replacement, 'Opened second');
  assert.equal(JSON.parse(storage.get('opendle-draft')).projectId, null, 'replacement is detached before draft storage');
  request.resolve({ projectId: 'first', revision: 2, temporary: false });
  await assert.rejects(saving, /different document/);
  assert.equal(context.project.title, 'Second');
  assert.equal(context.projectId, null);
  assert.equal(context.revision, 0);
  assert.equal(context.dirty, true);
  assert.equal(elements.get('save').disabled, false);
  context.restoreHistory(original);
  assert.equal(context.projectId, 'first');
  assert.equal(context.revision, 2, 'undo back to the saved document uses the completed save revision');
});

test('edits made during save are backed up against the newly saved revision', async () => {
  const request = deferred(), requests = [];
  const { context, storage } = fixture((path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    return request.promise;
  });
  const saving = context.saveProject();
  context.project = { ...context.project, title: 'Newer edits' }; context.editVersion++;
  request.resolve({ projectId: 'first', revision: 2, temporary: false });
  await saving;
  assert.equal(requests[0].body.projectId, 'first');
  assert.equal(requests[0].body.project.title, 'First');
  const draft = JSON.parse(storage.get('opendle-draft'));
  assert.equal(draft.baseRevision, 2);
  assert.equal(draft.project.title, 'Newer edits');
  assert.equal(context.dirty, true);
  const recovered = recoverProject({ project: requests[0].body.project, projectId: 'first', revision: 2 },
    storage.get('opendle-draft'), null);
  assert.equal(recovered.recovery, 'restored');
  assert.equal(recovered.project.title, 'Newer edits');
});

test('overlapping save/open operations are rejected and failures unlock further saves', async () => {
  const request = deferred();
  let calls = 0;
  const { context } = fixture(() => { calls++; return request.promise; });
  const saving = context.saveProject();
  await assert.rejects(context.saveProject(), /already in progress/);
  await assert.rejects(context.reloadProject(), /already in progress/);
  assert.equal(calls, 1);
  request.resolve({ projectId: 'first', revision: 2, temporary: false });
  await saving;
  context.api = async () => { throw new Error('Disk full'); };
  await assert.rejects(context.saveProject(), /Disk full/);
  assert.equal(context.projectOperationBusy, false);
});

test('adoption keeps edits made in flight and updates their temporary draft identity', async () => {
  const request = deferred();
  const { context, storage } = fixture(() => request.promise);
  context.replace(createProject(), 'Imported');
  const storing = context.adoptDocument();
  context.project = { ...context.project, title: 'Edited during import' }; context.editVersion++;
  request.resolve({ projectId: 'temporary', revision: 3, temporary: true });
  await storing;
  assert.equal(context.projectId, 'temporary');
  assert.equal(context.revision, 3);
  assert.equal(context.dirty, true);
  const draft = JSON.parse(storage.get('opendle-draft'));
  assert.equal(draft.project.title, 'Edited during import');
  assert.equal(draft.projectId, 'temporary');
  assert.equal(draft.baseRevision, 3);
});

test('loading cannot overwrite an edit made while the response was pending', async () => {
  const request = deferred();
  const { context } = fixture(() => request.promise);
  const loading = context.reloadProject();
  context.project = { ...context.project, title: 'Keep my edits' }; context.editVersion++;
  request.resolve({ project: createProject(), projectId: 'other', revision: 4 });
  await assert.rejects(loading, /current edits were kept/);
  assert.equal(context.project.title, 'Keep my edits');
  assert.equal(context.projectId, 'first');
  assert.equal(context.dirty, true);
});

test('accepting a conflicting recovery draft detaches it from the server project', async () => {
  const saved = createProject(); saved.title = 'Saved second project';
  const { context, storage } = fixture(async () => ({ project: saved, projectId: 'second', revision: 9 }));
  const draft = createProject(); draft.title = 'Unsaved first project';
  writeProjectDraft(context.localStorage, draft, { projectId: 'first', baseRevision: 1 });
  await context.reloadProject(true);
  assert.equal(context.project.title, draft.title);
  assert.equal(context.projectId, null);
  assert.equal(context.revision, 0);
  assert.equal(context.dirty, true);
  assert.equal(draftProject(storage.get('opendle-draft')).title, draft.title);
});

test('undo across a document replacement restores its original binding, not the import binding', () => {
  const { context } = fixture();
  const original = context.historySnapshot();
  context.replace(createProject(), 'Imported');
  const imported = context.historySnapshot();
  context.bindProject({ projectId: 'temporary', revision: 4, temporary: true });
  context.restoreHistory(original);
  assert.equal(context.projectId, 'first');
  assert.equal(context.revision, 1);
  context.restoreHistory(imported);
  assert.equal(context.projectId, 'temporary');
  assert.equal(context.revision, 4);
  assert.equal(context.cutResets, 3, 'replacement and each history restore clear pending geometry cuts');
});

test('editing a large project does not delete a recoverable draft from another document', () => {
  const { context, storage } = fixture();
  context.persistDraft();
  const draft = storage.get('opendle-draft');
  context.project = { ...context.project, assets: Array(301).fill({}) };
  context.persistDraft();
  assert.equal(storage.get('opendle-draft'), draft);
});

test('cancelled and rejected live drags preserve undo depth and the redo branch', () => {
  for (const action of ['cancel', 'reject', 'empty']) {
    const { context } = liveFixture();
    const original = context.project;
    context.history = Array.from({ length: 10 }, () => context.historySnapshot());
    const snapshots = [...context.history];
    const redo = context.historySnapshot(); context.future = [redo];
    if (action === 'cancel') context.liveApply(next => { next.title = 'Dragging'; });
    else if (action === 'reject') context.liveApply(() => { throw new Error('Rejected drag'); });
    else context.liveBegin();
    context.liveFinish(null, { revert: true });
    assert.equal(context.project, original);
    assert.deepEqual([...context.history], snapshots, `${action}: no oldest undo entry was evicted`);
    assert.deepEqual([...context.future], [redo], `${action}: redo remains available`);
  }
});

test('an accepted multi-frame live drag records exactly one original snapshot', () => {
  const { context, storage } = liveFixture();
  const original = context.project;
  context.future = [context.historySnapshot()];
  context.liveApply(next => { next.title = 'Frame one'; });
  context.liveApply(next => { next.title = 'Frame two'; });
  context.liveFinish('Moved');
  assert.equal(context.history.length, 1);
  assert.equal(context.history[0].project, original);
  assert.equal(context.future.length, 0);
  assert.equal(JSON.parse(storage.get('opendle-draft')).project.title, 'Frame two');
});

test('autosave coalesces edits and writes large projects even when browser backup is skipped', async () => {
  const requests = [];
  const { context, timers, storage } = fixture(async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    return { projectId: 'first', revision: 2, temporary: false };
  });
  context.project.assets = manyAssets();
  context.commit({ ...context.project, title: 'Large campaign edit one' });
  context.commit({ ...context.project, title: 'Large campaign edit two' });
  assert.equal(storage.has('opendle-draft'), false, 'large projects do not depend on localStorage');
  assert.equal(timers.size, 1, 'one idle save, not a save on every keystroke');
  const callback = [...timers.values()][0]; timers.clear(); callback();
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.project.title, 'Large campaign edit two');
  assert.ok(requests[0].body.project.assets.length > 300);
  assert.equal(context.dirty, false);
});

test('native close flushes edits immediately, including input blur and the final live drag position', async () => {
  const requests = [];
  const { context } = liveFixture();
  context.document.activeElement = { blur: () => { context.project.title = 'Final input value'; context.editVersion++; } };
  context.api = async (_path, options) => {
    requests.push(JSON.parse(options.body));
    return { projectId: 'first', revision: 2 };
  };
  context.liveApply(next => { next.title = 'Dragging'; });
  assert.equal(await context.window.opendleSaveBeforeClose(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].project.title, 'Final input value');
  assert.equal(context.dirty, false);
  assert.equal(context.history.length, 1);
});

test('close waits for an in-flight manual save and then saves edits made during that request', async () => {
  const first = deferred(), second = deferred(), requests = [];
  const { context } = fixture((path, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? first.promise : second.promise;
  });
  const manual = context.saveProject();
  context.commit({ ...context.project, title: 'Final edit while saving' });
  let closed = false;
  const closing = context.window.opendleSaveBeforeClose().then(value => { closed = value; });
  first.resolve({ projectId: 'first', revision: 2 });
  await manual; await setImmediate();
  assert.equal(closed, false, 'the earlier snapshot is not sufficient to close');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].revision, 2);
  assert.equal(requests[1].project.title, 'Final edit while saving');
  second.resolve({ projectId: 'first', revision: 3 });
  await closing;
  assert.equal(closed, true);
  assert.equal(context.dirty, false);
});

test('autosave never records an unfinished or cancelled drag that began during a pending save', async () => {
  const pending = deferred(), requests = [];
  const { context, timers } = liveFixture();
  context.api = async (_path, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? pending.promise : { projectId: 'first', revision: 3 };
  };
  context.persistDraft();
  let callback = [...timers.values()][0]; timers.clear(); callback();
  context.liveApply(next => { next.title = 'Uncommitted drag'; });
  pending.resolve({ projectId: 'first', revision: 2 });
  await setImmediate();
  assert.equal(requests.length, 1, 'saving waits until the live edit finishes');
  context.liveFinish(null, { revert: true });
  callback = [...timers.values()][0]; timers.clear(); callback();
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].project.title, 'First', 'the cancelled transient state never reaches disk');
});

test('New/Open saves the prior document and the new document receives a separate persistent identity', async () => {
  const store = new ProjectStore(null), first = createProject(); first.title = 'Original';
  const saved = store.adopt(first);
  const { context } = fixture(async (path, options) => {
    const body = JSON.parse(options.body);
    return path === '/api/project/adopt' ? store.adopt(body.project, body.title)
      : store.update(body.project, body.revision, body.projectId);
  });
  context.project = first; context.bindProject(saved);
  context.commit({ ...first, title: 'Original edited before New' });
  const next = createProject(); next.title = 'New document';
  await context.replaceDocument(next, 'Opened new document');
  assert.equal(store.snapshot().project.title, 'Original edited before New');
  assert.equal(context.projectId, null);
  assert.equal(await context.window.opendleSaveBeforeClose(), true);
  assert.notEqual(context.projectId, saved.projectId);
  assert.equal(store.snapshot().project.title, 'New document');
  assert.equal(store.open(saved.projectId).project.title, 'Original edited before New');
});

test('failed automatic and close saves report errors, retain the document and allow retry', async () => {
  const { context, timers, notices, elements } = fixture(async () => { throw new Error('Disk full'); });
  context.persistDraft();
  const callback = [...timers.values()][0]; timers.clear(); callback();
  await setImmediate();
  assert.match(notices.at(-1).message, /Automatic save failed: Disk full/);
  assert.equal(context.dirty, true);
  await assert.rejects(context.window.opendleSaveBeforeClose(), /Disk full/);
  assert.equal(elements.get('editor-shell').inert, undefined, 'failed close releases the editing UI');
  assert.equal(context.dirty, true);
  context.api = async () => ({ projectId: 'first', revision: 2 });
  assert.equal(await context.window.opendleSaveBeforeClose(), true);
  assert.equal(context.dirty, false);
});

test('a project switch saves the previous project before opening the next one', async () => {
  const requests = [], second = createProject(); second.title = 'Second';
  const { context, elements, listeners } = fixture(async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    return path === '/api/projects/open' ? { project: second, projectId: 'second', revision: 4 }
      : { projectId: 'first', revision: 2 };
  });
  context.refreshProjects = async () => { context.$('projects').value = context.projectId; };
  context.$('projects').value = 'second';
  await listeners.get('projects:change')();
  assert.deepEqual(requests.map(request => request.path), ['/api/project', '/api/projects/open']);
  assert.equal(requests[0].body.project.title, 'First');
  assert.equal(context.projectId, 'second');
  assert.equal(elements.get('projects').value, 'second', 'saving the old project does not leave its picker value selected');
  assert.equal(elements.get('dirty').textContent, 'Saved');
});

test('a failed save prevents project replacement or switching instead of discarding edits', async () => {
  const { context, listeners } = fixture(async () => { throw new Error('Service unavailable'); });
  context.$('projects').value = 'second';
  await assert.rejects(listeners.get('projects:change')(), /Service unavailable/);
  await assert.rejects(context.replaceDocument(createProject(), 'New'), /Service unavailable/);
  assert.equal(context.project.title, 'First');
  assert.equal(context.dirty, true);
});

test('browser unload still warns while a project is unsaved or a disk operation is pending', () => {
  const { context, listeners } = fixture();
  let blocked = 0;
  const event = { preventDefault: () => { blocked++; } };
  const unload = listeners.get('window:beforeunload');
  unload(event);
  assert.equal(blocked, 1);
  context.dirty = false; context.projectOperationBusy = true; unload(event);
  assert.equal(blocked, 2);
  context.projectOperationBusy = false; unload(event);
  assert.equal(blocked, 2);
});

test('closing a large edited project persists through HTTP to its asset folder and survives server restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-close-persistence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'project.json'), store = new ProjectStore(file);
  const original = createProject(); original.title = 'Close persistence';
  const saved = store.adopt(original);
  const { app } = createApp({ store, token: 'close-save-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { context, storage } = fixture(async (path, options) => {
    const response = await fetch(url + path, { ...options,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer close-save-test' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  });
  context.project = structuredClone(original); context.bindProject(saved);
  const next = structuredClone(context.project);
  next.title = 'Edits survived closing'; next.variables.savedOnClose = 42;
  next.map.entities[0].x += 17;
  next.assets = manyAssets();
  context.commit(next, 'Large project edited');
  assert.equal(storage.has('opendle-draft'), false);
  assert.equal(await context.window.opendleSaveBeforeClose(), true);
  const reopened = new ProjectStore(file).snapshot();
  assert.equal(reopened.project.title, next.title);
  assert.equal(reopened.project.variables.savedOnClose, 42);
  assert.equal(reopened.project.map.entities[0].x, next.map.entities[0].x);
  assert.equal(reopened.project.assets.length, next.assets.length);
  assert.equal(reopened.projectId, saved.projectId);
  assert.equal(reopened.revision, saved.revision + 1);
});
