import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { newScene, addSceneObject } from '../shared/scenes.js';
import {
  exportNodeFile, parseNodeFile, nodeFileText, applyNodeFile, layoutContainer,
} from '../shared/node-file.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const sprite = (id = 'sprite_a') => ({ id, kind: 'sprite', name: 'A', width: 32, height: 32, src: PNG });

test('a camera follow target outside the node is dropped, not left dangling', () => {
  const scene = newScene('Source');
  const cam = addSceneObject(scene, { name: 'Cam', x: 0, y: 0, type: 'camera', cameraFollow: 'outside_target' });
  const document = exportNodeFile(scene, cam.id, { assets: [sprite()] });
  const written = document.nodes.find(node => node.id === cam.id);
  assert.equal(written.cameraFollow, undefined, 'the file must not name a target it does not carry');
  assert.match(document.warnings.join(' '), /target/);
  assert.doesNotThrow(() => parseNodeFile(nodeFileText(document)), 'the file is still readable');
  const target = newScene('Destination');
  applyNodeFile(target, parseNodeFile(nodeFileText(document)));
  const copy = target.entities.find(node => node.name === 'Cam');
  assert.equal(copy.cameraFollow, undefined, 'the imported camera follows nothing rather than a missing id');
});

test('an actor target outside the node is dropped, not left dangling', () => {
  const scene = newScene('Source');
  const imp = addSceneObject(scene, { name: 'Imp', x: 0, y: 0, targetId: 'other_monster' });
  const document = exportNodeFile(scene, imp.id, { assets: [sprite()] });
  const written = document.nodes.find(node => node.id === imp.id);
  assert.equal(written.targetId, undefined, 'the file must not name a target it does not carry');
  assert.match(document.warnings.join(' '), /target/);
  const target = newScene('Destination');
  applyNodeFile(target, parseNodeFile(nodeFileText(document)));
  const copy = target.entities.find(node => node.name === 'Imp');
  assert.equal(copy.targetId, undefined, 'the imported actor targets nothing rather than a missing id');
});

test('a camera target inside the node travels and is remapped on import', () => {
  const scene = newScene('Source');
  const chased = addSceneObject(scene, { name: 'Runner', x: 32, y: 0 });
  const cam = addSceneObject(scene, { name: 'Cam', x: 0, y: 0, type: 'camera', cameraFollow: 'Runner' });
  const document = exportNodeFile(scene, scene.id, { assets: [sprite()] });
  const written = document.nodes.find(node => node.id === cam.id);
  assert.equal(written.cameraFollow, chased.id, 'a name target inside the node is rewritten to its id');
  const target = newScene('Destination');
  applyNodeFile(target, parseNodeFile(nodeFileText(document)));
  const copy = target.entities.find(node => node.name === 'Cam');
  assert.equal(target.entities.some(node => node.id === copy.cameraFollow), true, 'the follow target exists in the destination');
  assert.equal(copy.cameraFollow, target.entities.find(node => node.name === 'Runner').id);
});

test('a node whose sprite state names an uncarryable clip still round-trips', () => {
  const project = createProject();
  project.assets = [sprite('sprite_a')];
  project.spriteClips = [{ id: 'clip_walk', name: 'Walk', frames: ['sprite_a', 'missing_asset'] }];
  const walker = project.map.entities.find(item => item.type !== 'player');
  walker.name = 'Walker';
  walker.spriteStates = { stand: 'clip_walk' };
  const document = exportNodeFile(layoutContainer(project), walker.id, { assets: project.assets, clips: project.spriteClips });
  assert.deepEqual(document.clips, [], 'the clip cannot travel');
  assert.match(document.warnings.join(' '), /Missing sprite clips: clip_walk/);
  assert.doesNotThrow(() => parseNodeFile(nodeFileText(document)),
    'a file the exporter writes must be one its own parser accepts');
  const written = document.nodes.find(node => node.id === walker.id);
  assert.equal(written.spriteStates, undefined, 'the dangling sprite state is not written');
});

test('a hand-edited file whose command names a missing asset is rejected', () => {
  const scene = newScene('Source');
  const node = addSceneObject(scene, { name: 'N', x: 0, y: 0 });
  const document = exportNodeFile(scene, node.id, { assets: [sprite()], includeEvents: true });
  const forged = {
    ...document,
    events: [{
      id: 'forged', name: 'Forged', enabled: true, once: false, ownerId: node.id,
      condition: { type: 'onStart' }, conditions: [],
      actions: [{ type: 'playSound', assetId: 'missing_asset' }],
    }],
  };
  assert.throws(() => parseNodeFile(nodeFileText(forged)), /missing_asset/);
});
