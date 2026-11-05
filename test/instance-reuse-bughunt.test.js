import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import {
  addSceneObject, captureScene, instantiateScene, newScene, placeSceneObject,
} from '../shared/scenes.js';
import { planNodeFileInstall, exportNodeFile, applyNodeFile } from '../shared/node-file.js';
import { createSceneNode, transformSceneNodes } from '../shared/scene-nodes.js';
import { cloneEntitiesForPaste, upgradeSceneInstances, sceneInstanceOf } from '../shared/entity-groups.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const sprite = (id, width = 32, height = 32) =>
  ({ id, kind: 'sprite', name: 'Picture', width, height, src: PNG });

test('scene capture does not treat an expression type as an external object id', () => {
  const project = createProject();
  project.map.entities.push({ id: 'enemy_a', name: 'Enemy A', type: 'enemy', x: 0, y: 0, angle: 0 });
  project.events = [{ id: 'count_enemies', condition: { type: 'always' }, actions: [
    { type: 'setEntityPosition', entityId: 'enemy_a', x: { expr: 'count("enemy")' }, y: 0 },
  ] }];

  const scene = captureScene(project, ['enemy_a']);

  assert.deepEqual(scene.events.map(event => event.id), ['count_enemies']);
});

test('portable node export does not drop scripts that count an object type', () => {
  const scene = newScene('Count');
  const enemy = addSceneObject(scene, { id: 'enemy_a', name: 'Enemy A', type: 'enemy' });
  scene.events = [{ id: 'count_enemies', ownerId: enemy.id, condition: { type: 'always' }, actions: [
    { type: 'setEntityPosition', entityId: enemy.id, x: { expr: 'count("enemy")' }, y: 0 },
  ] }];

  const document = exportNodeFile(scene, enemy.id);

  assert.deepEqual(document.events.map(event => event.id), ['count_enemies']);
});

test('scene capture clears external entity targets but preserves special targets', () => {
  const project = createProject();
  project.map.entities.push(
    { id: 'camera_a', name: 'Camera A', type: 'camera', x: 0, y: 0, angle: 0, cameraFollow: 'outside' },
    { id: 'camera_b', name: 'Camera B', type: 'camera', x: 32, y: 0, angle: 0, cameraFollow: '$player' },
  );

  const scene = captureScene(project, ['camera_a', 'camera_b']);

  assert.equal(scene.entities.find(entity => entity.id === 'camera_a').cameraFollow, undefined);
  assert.equal(scene.entities.find(entity => entity.id === 'camera_b').cameraFollow, '$player');
});

test('scene copies remap entity fields that point at other copied nodes', () => {
  const scene = newScene('Targeting');
  const watcher = addSceneObject(scene, { id: 'watcher', name: 'Watcher', type: 'camera' });
  const target = addSceneObject(scene, { id: 'target', name: 'Target', type: 'enemy', parentId: watcher.id });
  watcher.targetId = target.id;
  watcher.cameraFollow = target.id;

  const copy = instantiateScene(scene, { prefix: 'instance_copy' });
  const copiedWatcher = copy.entities.find(entity => entity.name === watcher.name);
  const copiedTarget = copy.entities.find(entity => entity.name === target.name);

  assert.equal(copiedWatcher.targetId, copiedTarget.id);
  assert.equal(copiedWatcher.cameraFollow, copiedTarget.id);

  const document = exportNodeFile(scene, watcher.id);
  const destination = newScene('Destination');
  applyNodeFile(destination, document);
  const importedWatcher = destination.entities.find(entity => entity.name === watcher.name);
  const importedTarget = destination.entities.find(entity => entity.name === target.name);
  assert.equal(importedWatcher.targetId, importedTarget.id);
  assert.equal(importedWatcher.cameraFollow, importedTarget.id);
});

test('pasting related layout objects remaps their entity target fields together', () => {
  const project = createProject();
  const watcher = { id: 'watcher', name: 'Watcher', type: 'camera', x: 0, y: 0, angle: 0,
    cameraFollow: 'target', targetId: 'target' };
  const target = { id: 'target', name: 'Target', type: 'enemy', x: 16, y: 0, angle: 0 };
  project.map.entities.push(watcher, target);

  const copies = cloneEntitiesForPaste(project, [watcher, target], { x: 100, y: 100 });

  assert.equal(copies.entities[0].cameraFollow, copies.entities[1].id);
  assert.equal(copies.entities[0].targetId, copies.entities[1].id);
});

test('a failed scene-tree drop does not leave a partial reparent', () => {
  const scene = newScene('Tree');
  const originalParent = addSceneObject(scene, { id: 'parent_a', name: 'Original parent' });
  const otherParent = addSceneObject(scene, { id: 'parent_b', name: 'Other parent' });
  const child = addSceneObject(scene, { id: 'child', name: 'Child', parentId: originalParent.id });

  assert.throws(() => placeSceneObject(scene, child.id, otherParent.id, { before: 'missing' }), /reference node/);

  assert.equal(child.parentId, originalParent.id);
});

test('scene node scaling does not give a camera an unused sprite scale', () => {
  const scene = newScene('Camera');
  const camera = createSceneNode(scene, 'camera', { id: 'camera' });
  const baseline = structuredClone(scene);

  transformSceneNodes(scene, baseline, camera.id, 'scale', { scale: 2 });

  assert.equal(camera.spriteScale, undefined);
});

test('legacy flattened scene instances restore the actual hierarchy root', () => {
  const project = createProject();
  const source = newScene('Child before root');
  const root = addSceneObject(source, { id: 'root', name: 'Root' });
  const child = addSceneObject(source, { id: 'child', name: 'Child', parentId: root.id });
  source.entities = [child, root];
  const prefix = 'instance_0123456789abcdef';
  const flattened = instantiateScene(source, { prefix });
  for (const entity of flattened.entities) delete entity.parentId;
  project.scenes = [source];
  project.map.entities.push(...flattened.entities);

  assert.equal(upgradeSceneInstances(project), 1);
  assert.equal(sceneInstanceOf(project, `${prefix}_${root.id}`).rootId, `${prefix}_${root.id}`);
});

test('node-file installation does not reuse artwork with different dimensions', () => {
  const scene = newScene('Artwork');
  const node = addSceneObject(scene, { name: 'Picture', spriteAsset: 'picture' });
  const document = exportNodeFile(scene, node.id, { assets: [sprite('picture', 32, 32)] });

  const install = planNodeFileInstall(document, { assets: [sprite('picture', 64, 16)] });

  assert.equal(install.addAssets.length, 1);
  assert.ok(install.assetRemap.has('picture'));
});

test('node files carry and remap command groups and incompatible script metadata', () => {
  const scene = newScene('Script');
  const node = addSceneObject(scene, { name: 'Scripted node' });
  const sheet = { id: 'script_sheet', name: 'Script', section: 'game', enabled: true, phase: 'afterPhysics' };
  const controlSheet = { id: 'control_sheet', name: 'Control rules', section: 'game', enabled: true, phase: 'beforePhysics' };
  const groups = [
    { id: 'context_group', name: 'Context', sheetId: sheet.id, enabled: true },
    { id: 'control_group', name: 'Controls', sheetId: controlSheet.id, enabled: true },
  ];
  scene.events = [{ id: 'rule', ownerId: node.id, sheetId: sheet.id, groupId: 'context_group',
    condition: { type: 'groupActive', groupId: 'control_group' },
    actions: [{ type: 'showMessage', message: 'Hello' }] }];
  const document = exportNodeFile(scene, node.id, {
    eventSheets: [sheet, controlSheet], eventGroups: groups,
  });
  const install = planNodeFileInstall(document, {
    eventSheets: [{ ...sheet, enabled: false }, { ...controlSheet, enabled: false }],
    eventGroups: groups.map(group => ({ ...group, enabled: false })),
  });
  const destination = newScene('Destination');

  assert.deepEqual(document.groups.map(group => group.id).sort(), ['context_group', 'control_group']);
  assert.ok(install.sheetRemap.has(sheet.id));
  assert.ok(install.sheetRemap.has(controlSheet.id));
  assert.ok(install.groupRemap.has('context_group'));
  assert.ok(install.groupRemap.has('control_group'));
  applyNodeFile(destination, document, {
    sheetRemap: install.sheetRemap, groupRemap: install.groupRemap,
  });
  assert.equal(destination.events[0].sheetId, install.sheetRemap.get(sheet.id));
  assert.equal(destination.events[0].groupId, install.groupRemap.get('context_group'));
  assert.equal(destination.events[0].condition.groupId, install.groupRemap.get('control_group'));
  assert.ok(install.addSheets.some(item => item.id === install.sheetRemap.get(controlSheet.id)));
});

test('node-file validation rejects duplicate embedded asset ids', () => {
  const scene = newScene('Duplicate artwork');
  const node = addSceneObject(scene, { name: 'Picture', spriteAsset: 'picture' });
  const document = exportNodeFile(scene, node.id, { assets: [sprite('picture')] });
  document.assets.push({ ...sprite('picture'), name: 'Different payload', src: 'different' });

  assert.throws(() => planNodeFileInstall(document), /duplicate asset id/i);
});
