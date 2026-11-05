import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cloneProjectForEdit, createProject, validateProject } from '../shared/project.js';
import { draftProject, recoverProject, writeProjectDraft } from '../public/project-recovery.js';
import { createProjectAutosave } from '../public/project-autosave.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function between(start, end) {
  const index = source.indexOf(start);
  assert.notEqual(index, -1, start);
  const stop = source.indexOf(end, index);
  assert.notEqual(stop, -1, end);
  return source.slice(index, stop);
}

// Minimal studio-shell fixture: enough DOM/storage to run save/reload/draft plumbing
// without a browser. Mirrors the harness used by project-persistence.test.js.
function fixture(api = async () => {}) {
  const elements = new Map(), storage = new Map(), notices = [], timers = new Map();
  let timerId = 0;
  const project = createProject(); project.title = 'First';
  const context = vm.createContext({
    project, projectId: 'first', revision: 1, projectTemporary: false, dirty: false, editVersion: 1,
    cloneProjectForEdit, UNDO_DEEP_GAME_STEPS: 10, undoDepthFor: () => 10,
    documentGeneration: 1, documentSession: { projectId: 'first', revision: 1, temporary: false },
    projectOperationBusy: false, projectOperationPending: null, liveEditState: null,
    draftSkipNoted: false, history: [], future: [], scenePose: null,
    cutResets: 0, cutTool: { cancel() { context.cutResets++; } },
    selection: null, scriptScope: '$all', sceneObjectEditor: null, openSceneIds: [], activeSceneId: null,
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, hidden: true, textContent: '',
        addEventListener: () => {} });
      return elements.get(id);
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    status: (message, error = false) => notices.push({ message, error }),
    api, validateProject, draftProject, recoverProject, writeProjectDraft,
    confirm: () => true,
    draftTooLarge: () => (context.project.assets?.length || 0) > 300 || (context.project.game?.levels.length || 0) > 4,
    historyLimit: () => 10, syncRampModels() {}, render() {}, clearDraft() {}, fitMap() {}, renderSceneObjectTabs() {},
    upgradePickupReach: () => false, upgradeSceneInstances: () => false, refreshProjects: async () => {},
    badgeText: () => context.dirty ? 'Unsaved' : 'Saved',
    createProjectAutosave: options => createProjectAutosave({ ...options,
      setTimer: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimer: id => timers.delete(id) }),
    document: { activeElement: null, addEventListener: () => {} },
    window: { addEventListener: () => {} },
    guard: fn => fn,
  });
  vm.runInContext([
    between('const projectAutosave =', '// The Project tree').replace('const projectAutosave =', 'projectAutosave ='),
    between('function persistDraft()', 'function clearDraft()'),
    between('function bindProject(', '/** How many steps'),
    between('function commit(', '/** Stored projects, newest first'),
    between('/** A 409 the editor can answer itself', '/**\n * Drains'),
    between("$('projects').addEventListener", "$('undo').addEventListener"),
    between('window.opendleSaveBeforeClose =', 'async function start()'),
  ].join('\n'), context);
  return { context, elements, storage, notices, timers };
}

test('a reload that discards edits removes the browser draft so discarded edits cannot silently return on the next startup', async () => {
  const original = createProject(); original.title = 'First';
  const { context, storage } = fixture(async () =>
    ({ project: structuredClone(original), projectId: 'first', revision: 1, temporary: false }));
  // Edit: the draft is the only durable copy of the change.
  const edited = structuredClone(original); edited.title = 'Discarded edit';
  context.commit(edited, 'edit');
  assert.equal(context.dirty, true);
  assert.ok(storage.has('opendle-draft'), 'the edit was backed up as a draft');

  await context.reloadProject(false);

  assert.equal(context.dirty, false, 'the server project loaded cleanly');
  assert.equal(context.project.title, 'First', 'the edit was discarded');
  assert.equal(storage.has('opendle-draft'), false, 'the discarded draft no longer waits to auto-restore');
  assert.equal(recoverProject(
    { project: structuredClone(original), projectId: 'first', revision: 1 },
    storage.get('opendle-draft') ?? null, null).recovery, 'none',
    'the next startup finds no stale draft to resurrect');
});

test('cancelling a reload keeps the draft, and a reload without edits does not disturb an unrelated draft', async () => {
  const original = createProject(); original.title = 'First';
  const { context, storage } = fixture(async () =>
    ({ project: structuredClone(original), projectId: 'first', revision: 1, temporary: false }));
  const edited = structuredClone(original); edited.title = 'Kept edit';
  context.commit(edited, 'edit');
  context.confirm = () => false;
  await context.reloadProject(false);
  assert.equal(context.dirty, true, 'cancelled discard keeps the edits');
  assert.ok(storage.has('opendle-draft'), 'cancelled discard keeps the draft backup');
});
