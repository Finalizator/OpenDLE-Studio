import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, cloneProjectForEdit, validateProject } from '../shared/project.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function withImage() {
  const project = createProject();
  project.assets = [];
  project.assets.push({ id: 'img_test', name: 'Test', kind: 'texture', format: 'png', width: 1, height: 1, src: PNG });
  return project;
}

test('fast validation accepts whatever full validation accepts for embedded artwork', () => {
  const project = withImage();
  validateProject(project);
  validateProject(project, { fast: true });
  validateProject(project, { fast: true });
});

test('fast validation screens artwork that was replaced, and full validation re-checks everything', () => {
  const project = withImage();
  validateProject(project, { fast: true });
  project.assets[0] = { ...project.assets[0], src: 'data:image/png;base64,not-base64!!' };
  assert.throws(() => validateProject(project, { fast: true }), /embedded PNG images/);
  project.assets[0] = { ...project.assets[0], src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' };
  assert.throws(() => validateProject(project, { fast: true }), /embedded PNG images/);
  const same = withImage();
  validateProject(same, { fast: true });
  same.assets[0].src = 'data:image/png;base64,@@@';
  assert.throws(() => validateProject(same), /embedded PNG images/);
});

test('fast validation still enforces cumulative artwork budgets', () => {
  const project = withImage();
  // One 16 MiB payload, referenced by every copy: the budget is measured on the
  // summed lengths, so this asserts the total without holding it many times over.
  const src = `data:image/png;base64,${'A'.repeat(15 * 1024 * 1024)}`;
  project.assets[0].src = src;
  validateProject(project, { fast: true });
  for (let index = 0; index < 13; index++) {
    project.assets.push({ ...project.assets[0], id: `img_copy_${index}`, name: `Copy ${index}` });
  }
  assert.throws(() => validateProject(project, { fast: true }), /Embedded image budget exceeded/);
});

test('fast validation still rejects duplicate and unknown asset references', () => {
  const project = withImage();
  project.assets.push({ ...project.assets[0] });
  assert.throws(() => validateProject(project, { fast: true }), /Duplicate ID/);
  const unknown = withImage();
  unknown.map.sectors[0].floorAsset = 'img_missing';
  assert.throws(() => validateProject(unknown, { fast: true }), /unknown asset/);
});

test('edit snapshots share campaign data but stay isolated from geometry and asset edits', () => {
  const project = withImage();
  project.game = { version: 1, entry: 'MAP01', active: 'MAP01',
    levels: [{ id: 'MAP01', name: 'One', assetIds: [], next: null, secretNext: null, data: { map: structuredClone(project.map) } }] };
  const next = cloneProjectForEdit(project);
  assert.equal(next.game, project.game);
  assert.equal(next.assets[0], project.assets[0]);
  assert.notEqual(next.assets, project.assets);
  next.map.sectors[0].floorHeight += 64;
  next.assets.push({ ...project.assets[0], id: 'img_added', name: 'Added' });
  assert.notEqual(next.map.sectors[0].floorHeight, project.map.sectors[0].floorHeight);
  assert.equal(project.assets.length, 1);
  validateProject(next);
});

test('campaign edits can deep copy shared level data on demand', () => {
  const project = withImage();
  project.game = { version: 1, entry: 'MAP01', active: 'MAP01',
    levels: [{ id: 'MAP01', name: 'One', assetIds: [], next: null, secretNext: null, data: { map: structuredClone(project.map) } }] };
  const next = cloneProjectForEdit(project, { deepGame: true });
  assert.notEqual(next.game, project.game);
  next.game.levels[0].name = 'Renamed';
  next.game.levels[0].data.map.sectors[0].light = 12;
  assert.equal(project.game.levels[0].name, 'One');
  assert.notEqual(project.game.levels[0].data.map.sectors[0].light, 12);
});
