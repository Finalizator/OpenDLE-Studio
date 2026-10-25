import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { recoverProject } from '../public/project-recovery.js';

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
