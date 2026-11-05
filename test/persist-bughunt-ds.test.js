import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, removeEntities } from '../shared/project.js';
import { captureScene, placeSceneInstance, newScene, addSceneObject, addSceneObjectFromEntity, duplicateSceneObject } from '../shared/scenes.js';
import { exportNodeFile } from '../shared/node-file.js';

test('captureScene drops an owned event that names an object outside the scene', () => {
  const project = createProject();
  project.map.entities.push(
    { id: 'lamp', name: 'Lamp', type: 'decoration', x: 0, y: 0, angle: 0 },
    { id: 'switch', name: 'Switch', type: 'decoration', x: 32, y: 0, angle: 0 },
  );
  project.events = [{ id: 'on_use', ownerId: 'lamp', enabled: true, once: false,
    condition: { type: 'always' },
    actions: [{ type: 'setEntityPosition', entityId: 'switch', x: 10, y: 0 }] }];

  const scene = captureScene(project, ['lamp']);

  assert.equal(scene.events.length, 0, 'an event that targets an outside object must not travel with the scene');
});

test('captureScene keeps an owned event whose commands stay inside the scene', () => {
  const project = createProject();
  project.map.entities.push(
    { id: 'lamp', name: 'Lamp', type: 'decoration', x: 0, y: 0, angle: 0 },
    { id: 'bulb', name: 'Bulb', type: 'decoration', x: 16, y: 0, angle: 0 },
  );
  project.events = [{ id: 'on_use', ownerId: 'lamp', enabled: true, once: false,
    condition: { type: 'always' },
    actions: [{ type: 'setEntityPosition', entityId: 'bulb', x: 10, y: 0 }] }];

  const scene = captureScene(project, ['lamp', 'bulb']);

  assert.equal(scene.events.length, 1);
});

test('a captured scene placed after its external target was deleted stays valid', () => {
  const project = createProject();
  project.map.entities.push(
    { id: 'lamp', name: 'Lamp', type: 'decoration', x: 0, y: 0, angle: 0 },
    { id: 'switch', name: 'Switch', type: 'decoration', x: 32, y: 0, angle: 0 },
  );
  project.events = [{ id: 'on_use', ownerId: 'lamp', enabled: true, once: false,
    condition: { type: 'always' },
    actions: [{ type: 'setEntityPosition', entityId: 'switch', x: 10, y: 0 }] }];
  project.scenes = [captureScene(project, ['lamp'])];

  removeEntities(project, ['switch']);
  placeSceneInstance(project, project.scenes[0], { x: 100, y: 100 });

  assert.doesNotThrow(() => validateProject(project));
});

test('dropping a grouped layout object into a scene does not carry its layout group', () => {
  const project = createProject();
  const source = newScene('Source');
  addSceneObject(source, { id: 'keypad', name: 'Keypad' });
  const placed = placeSceneInstance(project, source);
  const keypad = placed.entities[0];

  const dest = newScene('Dest');
  const copy = addSceneObjectFromEntity(dest, keypad, { x: 0, y: 0 });

  assert.equal(copy.groupId, undefined, 'a scene object must not carry a layout group id');

  const document = exportNodeFile(dest, copy.id);
  assert.ok(!document.warnings.some(warning => /layout group/.test(warning)),
    'exporting the node must not report a layout group it never had');
});

test('duplicating a scene object twice gives the copies distinct names', () => {
  const scene = newScene('Props');
  addSceneObject(scene, { id: 'lamp', name: 'Lamp' });

  duplicateSceneObject(scene, 'lamp');
  duplicateSceneObject(scene, 'lamp');

  assert.deepEqual(scene.entities.map(entity => entity.name), ['Lamp', 'Lamp copy', 'Lamp copy 2']);
});
