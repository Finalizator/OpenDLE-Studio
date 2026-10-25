import test from 'node:test';
import assert from 'node:assert/strict';
import { importedGameplayGaps } from '../public/gameplay-readiness.js';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';

test('legacy WAD projects report missing gameplay instead of appearing ready after a service restart', () => {
  const project = createProject();
  project.map.entities[0].doomType = 1;
  project.events = [];
  assert.deepEqual(importedGameplayGaps(project), ['HUD', 'sound playback', 'complete weapon starter', 'enemy combat starter', 'sprite animations']);
  installEngineScripts(project);
  assert.deepEqual(importedGameplayGaps(project), ['sprite animations']);
});
test('authored non-Doom projects do not require the Doom gameplay starter', () => {
  assert.deepEqual(importedGameplayGaps(createProject()), []);
});
