import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { draftProject, recoverProject, writeProjectDraft } from '../public/project-recovery.js';

test('startup restores unsaved gameplay at the same saved revision instead of silently loading geometry-only content', () => {
  const legacy = createProject(); legacy.events = [];
  const gameplay = installEngineScripts(structuredClone(legacy));
  const result = recoverProject({ project: legacy, revision: 1 }, JSON.stringify(gameplay), JSON.stringify({ baseRevision: 1 }));
  assert.equal(result.recovery, 'restored');
  assert.equal(result.dirty, true);
  assert.equal(result.project.playerControl, 'events');
  assert.ok(result.project.events.some(e => e.name === 'pistol'));
  assert.equal(legacy.events.length, 0);
});
test('a saved draft does not prompt or become dirty; missing drafts use the server project', () => {
  const project = createProject(), saved = { project, revision: 2 };
  for (const draft of [null, JSON.stringify(project)]) {
    const result = recoverProject(saved, draft, JSON.stringify({ baseRevision: 1 }));
    assert.equal(result.recovery, 'none'); assert.equal(result.dirty, false);
    assert.equal(result.project, project);
  }
});
test('conflicting revisions and old unversioned drafts require a user decision rather than overwriting either project', () => {
  const project = createProject(), draft = createProject(); draft.title = 'Unsaved gameplay';
  for (const metadata of [null, JSON.stringify({ baseRevision: 1 })]) {
    const result = recoverProject({ project, revision: 2 }, JSON.stringify(draft), metadata);
    assert.equal(result.recovery, 'conflict'); assert.equal(result.dirty, false);
    assert.equal(result.project, project); assert.equal(result.draft.title, draft.title);
  }
});
test('corrupt or invalid drafts surface a warning and remain recoverable without blocking the saved project', () => {
  const project = createProject();
  for (const draft of ['{broken', JSON.stringify({ version: 999 })]) {
    const result = recoverProject({ project, revision: 1 }, draft, null);
    assert.equal(result.recovery, 'invalid'); assert.match(result.warning, /could not be restored/);
    assert.equal(result.project, project);
  }
});

test('an explicitly unbound draft cannot silently replace a saved project at the same revision', () => {
  const project = createProject(), draft = createProject(); draft.title = 'New unsaved document';
  const result = recoverProject({ project, revision: 1, projectId: 'original' }, JSON.stringify(draft),
    JSON.stringify({ baseRevision: 1, projectId: null }));
  assert.equal(result.recovery, 'conflict');
  assert.equal(result.project, project);
});

test('draft data and identity are stored atomically, retaining the previous draft on quota failure', () => {
  const saved = createProject(), newer = createProject(); newer.title = 'New unsaved edits';
  const values = new Map(), storage = {
    setItem(key, value) { values.set(key, value); },
  };
  writeProjectDraft(storage, saved, { projectId: 'original', baseRevision: 7 });
  const previous = values.get('opendle-draft');
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => writeProjectDraft(storage, newer, { projectId: 'new', baseRevision: 1 }), /QuotaExceededError/);
  assert.equal(values.get('opendle-draft'), previous);
  assert.equal(draftProject(previous).title, saved.title);
  const result = recoverProject({ project: newer, revision: 1, projectId: 'new' }, previous,
    JSON.stringify({ baseRevision: 1, projectId: 'new' }));
  assert.equal(result.recovery, 'conflict', 'legacy metadata cannot relabel a new-format draft');
});
