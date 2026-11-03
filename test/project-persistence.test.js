import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProject, validateProject } from '../shared/project.js';
import { draftProject, recoverProject, writeProjectDraft } from '../public/project-recovery.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function between(start, end) {
  const index = source.indexOf(start);
  assert.notEqual(index, -1, start);
  const stop = source.indexOf(end, index);
  assert.notEqual(stop, -1, end);
  return source.slice(index, stop);
}
function fixture(api = async () => {}) {
  const elements = new Map(), storage = new Map(), notices = [];
  const project = createProject(); project.title = 'First';
  const context = vm.createContext({
    project, projectId: 'first', revision: 1, projectTemporary: false, dirty: true, editVersion: 1,
    documentGeneration: 1, documentSession: { projectId: 'first', revision: 1, temporary: false },
    projectOperationBusy: false, draftSkipNoted: false, history: [], future: [], scenePose: null,
    cutResets: 0, cutTool: { cancel() { context.cutResets++; } },
    selection: null, scriptScope: '$all', sceneObjectEditor: null, openSceneIds: [], activeSceneId: null,
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, hidden: true, textContent: '' });
      return elements.get(id);
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    status: (message, error = false) => notices.push({ message, error }),
    api, validateProject, draftProject, recoverProject, writeProjectDraft, confirm: () => true,
    draftTooLarge: () => (context.project.assets?.length || 0) > 300 || (context.project.game?.levels.length || 0) > 4,
    historyLimit: () => 10, syncRampModels() {}, render() {}, clearDraft() {}, fitMap() {}, renderSceneObjectTabs() {},
    upgradePickupReach: () => false, refreshProjects: async () => {}, badgeText: () => context.dirty ? 'Unsaved' : 'Saved',
  });
  vm.runInContext([
    between('function persistDraft()', 'function clearDraft()'),
    between('function bindProject(', '/** How many steps'),
    between('function commit(', '/** Stored projects, newest first'),
    between('async function saveProject()', '/**\n * Drains'),
  ].join('\n'), context);
  return { context, elements, storage, notices };
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
