import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { gameLevelAssetIds } from '../shared/game-levels.js';
import { skyRequestName, skyRequestAlternate, skyAssetFor, requestSky } from '../shared/sky.js';

const image = (id, name, kind = 'sky') => ({ id, name, kind, width: 256, height: 128, src: 'data:,' });

test('a sky request names the texture ChangeSky asked for', () => {
  assert.equal(skyRequestName({ name: 'SKY2', alt: 'SKY3' }), 'SKY2');
  assert.equal(skyRequestName('SKY1'), 'SKY1', 'saves written before the object shape still read');
  assert.equal(skyRequestName({ name: '  ' }), null);
  assert.equal(skyRequestName(null), null);
  assert.equal(skyRequestAlternate({ name: 'SKY2', alt: 'SKY3' }), 'SKY3');
  assert.equal(skyRequestAlternate({ name: 'SKY2', alt: null }), null);
  assert.equal(skyRequestAlternate('SKY2'), null);
});

test('a sky name resolves to the image asset, case-insensitively', () => {
  const project = createProject();
  project.assets = [image('asset_SKY1', 'SKY1'), image('asset_SKY3', 'SKY3'), image('asset_wall', 'BRICK1', 'texture'),
    { id: 'asset_sound', name: 'SKY2', kind: 'sound', src: 'data:,' }];
  assert.equal(skyAssetFor(project, 'SKY1').id, 'asset_SKY1');
  assert.equal(skyAssetFor(project, 'sky3').id, 'asset_SKY3', 'names are case-insensitive');
  assert.equal(skyAssetFor(project, 'BRICK1').id, 'asset_wall', 'a wall texture is a valid sky, as in GZDoom');
  assert.equal(skyAssetFor(project, 'SKY2'), null, 'a sound that happens to share the name is not artwork');
  assert.equal(skyAssetFor(project, ''), null);
  assert.equal(skyAssetFor(project, 'SKY9'), null);
});

test('ChangeSky records the request on the runtime state', () => {
  const state = {};
  assert.equal(requestSky(state, '', 'SKY2'), false, 'an empty primary name changes nothing');
  assert.equal(state.skyRequest, undefined);
  assert.equal(requestSky(state, 'SKY2', 'SKY3'), true);
  assert.deepEqual(state.skyRequest, { name: 'SKY2', alt: 'SKY3' });
  requestSky(state, 'SKY1', 'SKY1');
  assert.deepEqual(state.skyRequest, { name: 'SKY1', alt: null }, 'identical names are not stored twice');
});

test('every sky image travels with a level, so a script can switch to one', () => {
  const project = createProject();
  project.assets = [image('asset_SKY1', 'SKY1'), image('asset_SKY2', 'SKY2'), image('asset_wall', 'BRICK1', 'texture')];
  const ids = gameLevelAssetIds(project);
  assert.ok(ids.includes('asset_SKY1') && ids.includes('asset_SKY2'), 'skies load even when nothing references them');
  assert.equal(ids.includes('asset_wall'), false, 'an unused wall texture still does not load');
});

test('a sky change survives saving and loading', async () => {
  const { captureGameSave, restoreGameSave, gameSaveIdentity } = await import('../shared/save-game.js');
  const project = createProject();
  project.events = [];
  const identity = await gameSaveIdentity(project);
  const state = createRuntime(project);
  requestSky(state, 'SKY2', 'SKY4');
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, identity)));
  const restored = restoreGameSave(project, record, identity);
  assert.deepEqual(restored.runtime.skyRequest, { name: 'SKY2', alt: 'SKY4' });
});
