import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createProject, cloneProjectForEdit, removeEntity, validateProject } from '../shared/project.js';
import { newScene, placeSceneInstance, instantiateScene, captureScene } from '../shared/scenes.js';
import { createSceneNode, transformSceneNodes } from '../shared/scene-nodes.js';
import {
  cloneEntitiesForPaste, createSceneInstanceGroup, layoutEntityIds, layoutSelection, membersOf,
  pruneGroups, sceneInstanceOf, ungroup, upgradeSceneInstances,
} from '../shared/entity-groups.js';
import { dragSelection, transformSelection } from '../shared/scene-edit.js';
import { entityOrigin, modelOrientation, entityRepresentation, entityMediaSignature, liveProjectPlan } from '../shared/entity-visuals.js';
import { createWorldNodeObject, setWorldNodePose } from '../public/world-media.js';
import { sectorAt, sectorGeometry } from '../shared/sectors.js';
import { applyNodeFile, exportNodeFile, layoutContainer, nodeFileText, parseNodeFile } from '../shared/node-file.js';
import { moveEntityToFloor } from '../public/editor-drop.js';
import { packProject, unpackProject } from '../server/project-folder.js';
import { stripEntityReferences } from '../shared/references.js';

function fixture() {
  const project = createProject(), scene = newScene('Access terminal');
  const terminal = createSceneNode(scene, 'keypad', { id: 'terminal', x: 5, y: 7, elevation: 32, angle: 180 });
  const chassis = createSceneNode(scene, 'box', { id: 'chassis', x: 5, y: 11, elevation: 30, parentId: terminal.id });
  chassis.mesh.width = 52; chassis.mesh.height = 68; chassis.mesh.depth = 6;
  scene.events = [{ id: 'submitted_rule', name: 'Submitted', ownerId: terminal.id, enabled: true, once: false,
    condition: { type: 'onSignal', entityId: terminal.id, signal: 'submitted' }, conditions: [],
    actions: [{ type: 'emitSignal', entityId: terminal.id, signal: 'submitted', value: 'chassis' }] }];
  project.scenes = [scene];
  const placed = placeSceneInstance(project, scene, { x: 64, y: 64 });
  return { project, scene, placed, terminal: placed.entities[0], chassis: placed.entities[1] };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('placed scenes select one stable root from any part and preserve source hierarchy', () => {
  const { project, scene, placed, terminal, chassis } = fixture();
  assert.equal(placed.group.kind, 'scene');
  assert.equal(placed.group.rootId, terminal.id);
  assert.equal(chassis.parentId, terminal.id);
  assert.equal(sceneInstanceOf(project, chassis.id), placed.group);
  const picked = layoutSelection(project, { kind: 'entity', id: chassis.id });
  assert.equal(picked.id, terminal.id);
  assert.deepEqual(picked.group, [terminal.id, chassis.id]);
  assert.deepEqual(layoutEntityIds(project, [chassis.id]), picked.group);
  assert.equal(scene.entities[1].parentId, 'terminal', 'source is not modified');
  assert.doesNotThrow(() => validateProject(project));
});

test('a scene instance is atomic when selected with loose objects or another instance', () => {
  const { project, scene, terminal, chassis } = fixture();
  const second = placeSceneInstance(project, scene, { x: -128, y: 0 });
  const loose = project.map.entities.find(entity => entity.type !== 'player' && !entity.groupId);
  const ids = layoutEntityIds(project, [chassis.id, second.entities[1].id, loose.id]);
  assert.equal(ids.length, 5);
  assert.ok(ids.includes(terminal.id) && ids.includes(second.group.rootId));
  const selected = layoutSelection(project, { kind: 'entity', id: chassis.id, group: ids });
  const before = structuredClone(project);
  dragSelection(project, before, selected, 'move', { x: 32 }, 32);
  for (const id of ids) near(project.map.entities.find(entity => entity.id === id).x,
    before.map.entities.find(entity => entity.id === id).x + 27);
  const secondBaseline = structuredClone(project);
  dragSelection(project, secondBaseline, { kind: 'entity', id: loose.id, group: ids }, 'move', { y: 17 }, 1);
  for (const id of ids) near(project.map.entities.find(entity => entity.id === id).y,
    secondBaseline.map.entities.find(entity => entity.id === id).y + 17);
});

test('moving an off-grid scene from any part carries every part exactly once, including height', () => {
  const { project, chassis, terminal } = fixture();
  const before = structuredClone(project), selected = { kind: 'entity', id: chassis.id };
  const saved = JSON.stringify(before);
  for (let frame = 0; frame < 3; frame++) {
    dragSelection(project, before, selected, 'move', { x: 31, y: -31, z: 31 }, 32);
    const root = project.map.entities.find(entity => entity.id === terminal.id);
    const child = project.map.entities.find(entity => entity.id === chassis.id);
    assert.deepEqual([root.x, root.y, root.elevation], [96, 32, 64]);
    assert.deepEqual([child.x - root.x, child.y - root.y, child.elevation - root.elevation], [0, 4, -2]);
  }
  assert.equal(JSON.stringify(before), saved, 'the drag baseline stays immutable');
});

test('grid-free placement preserves fractional positions for loose objects and complete scene instances', () => {
  const { project, terminal, chassis } = fixture();
  const baseline = structuredClone(project);
  dragSelection(project, baseline, { kind: 'entity', id: chassis.id }, 'move', { x: .125, y: .75, z: .25 }, 0);
  for (const entity of [terminal, chassis]) {
    const before = baseline.map.entities.find(item => item.id === entity.id);
    near(entity.x, before.x + .125); near(entity.y, before.y + .75); near(entity.elevation, before.elevation + .25);
  }
  const loose = project.map.entities.find(entity => !entity.groupId && entity.type !== 'player');
  const before = { ...loose };
  dragSelection(project, structuredClone(project), { kind: 'entity', id: loose.id }, 'move', { x: .125, z: .75 }, 0);
  near(loose.x, before.x + .125);
  near(loose.elevation, (before.elevation || 0) + .75);
  assert.doesNotThrow(() => validateProject(project));
});

test('layout transforms preserve world-space assembly offsets across different sector floors', () => {
  const { project, terminal, chassis } = fixture();
  // Moving out of the raised room must not change the assembly's world height.
  const room = project.map.sectors[0];
  room.floorHeight = 24;
  chassis.z = 92; chassis.elevation = 68;
  const before = structuredClone(project);
  transformSelection(project, { kind: 'entity', id: chassis.id }, 'move', { x: 1000, z: 16 }, 1);
  const height = (target, id) => {
    const entity = target.map.entities.find(entity => entity.id === id);
    return entityOrigin(entity, sectorAt(sectorGeometry(target), entity.x, entity.y)?.floorHeight || 0)[1];
  };
  near(height(project, terminal.id), height(before, terminal.id) + 16);
  near(height(project, chassis.id), height(before, chassis.id) + 16);
  near(height(project, chassis.id) - height(project, terminal.id), height(before, chassis.id) - height(before, terminal.id));
  assert.doesNotThrow(() => validateProject(project));
});

test('rotation, uniform scale and inspector moves act on the whole instance', () => {
  const { project, terminal, chassis } = fixture();
  transformSelection(project, { kind: 'entity', id: chassis.id }, 'rotate', { angle: 90 }, 0);
  near(chassis.x - terminal.x, -4); near(chassis.y - terminal.y, 0);
  near(chassis.angle, 90); near(terminal.angle, -90);
  transformSelection(project, { kind: 'entity', id: chassis.id }, 'scale', { scale: 2 }, 0);
  near(chassis.x - terminal.x, -8);
  assert.equal(terminal.terminal.width, 96); assert.equal(chassis.mesh.width, 104);
  transformSelection(project, { kind: 'entity', id: chassis.id }, 'move', { x: 11, z: 9 }, 1);
  near(chassis.x - terminal.x, -8);
  near(chassis.elevation - terminal.elevation, -4);
  assert.throws(() => transformSelection(project, { kind: 'entity', id: chassis.id }, 'form', { sizes: { width: 8 } }, 1), /scene editor/);
  assert.doesNotThrow(() => validateProject(project));
});

test('scene transforms move internal joint anchors and preserve undo snapshots', () => {
  const { project, terminal, chassis } = fixture();
  for (const entity of [terminal, chassis]) entity.physics = { body: 'fixed', shape: 'box', width: 16, depth: 16, height: 16 };
  project.map.joints = [{ id: 'link', type: 'fixed', a: terminal.id, b: chassis.id, anchor: { x: 69, y: 73, z: 32 } }];
  const draft = cloneProjectForEdit(project);
  transformSelection(draft, { kind: 'entity', id: chassis.id }, 'move', { x: 16, z: 8 }, 1);
  assert.deepEqual(draft.map.joints[0].anchor, { x: 85, y: 73, z: 40 });
  assert.deepEqual(project.map.joints[0].anchor, { x: 69, y: 73, z: 32 });
  assert.equal(project.map.entities.find(entity => entity.id === terminal.id).x, 69);
});

test('floor drops move a scene instance, never just its root or grabbed child', () => {
  const { project, terminal, chassis } = fixture();
  const gap = chassis.elevation - terminal.elevation;
  assert.match(moveEntityToFloor(project, chassis.id, 128, -64), /Access terminal/);
  assert.deepEqual([terminal.x, terminal.y, terminal.elevation], [128, -64, 0]);
  assert.deepEqual([chassis.x, chassis.y, chassis.elevation], [128, -60, gap]);
});

test('copy and paste retain each instance and remap its scripts, without modifying original signals', () => {
  const { project, scene, placed, terminal } = fixture();
  const other = placeSceneInstance(project, scene, { x: -200, y: 0 });
  const loose = project.map.entities.find(entity => entity.type !== 'player' && !entity.groupId);
  const source = [...placed.entities, ...other.entities, loose];
  const copied = cloneEntitiesForPaste(project, source, { x: 200, y: 200 });
  project.map.entities.push(...copied.entities);
  project.events.push(...copied.events);
  assert.equal(copied.events.length, 2);
  assert.equal(new Set(copied.entities.slice(0, 4).map(entity => entity.groupId)).size, 2);
  const root = copied.entities[0], child = copied.entities[1];
  assert.equal(sceneInstanceOf(project, child.id).rootId, root.id);
  assert.equal(child.parentId, root.id);
  assert.equal(copied.entities[4].groupId, undefined);
  assert.equal(copied.events[0].ownerId, root.id);
  assert.equal(copied.events[0].condition.entityId, root.id);
  assert.equal(copied.events[0].actions[0].value, 'chassis', 'signal payload is literal');
  assert.equal(project.events.find(event => event.ownerId === terminal.id).condition.entityId, terminal.id);
  assert.throws(() => cloneEntitiesForPaste(project, [placed.entities[0]], null), /whole scene instance/);
  assert.doesNotThrow(() => validateProject(project));
});

test('single-node scenes survive pruning, copy and persistence as scene instances', () => {
  const project = createProject(), scene = newScene('One node');
  createSceneNode(scene, 'keypad');
  const placed = placeSceneInstance(project, scene);
  pruneGroups(project);
  assert.equal(sceneInstanceOf(project, placed.group.rootId), placed.group);
  const copy = cloneEntitiesForPaste(project, placed.entities, null);
  project.map.entities.push(...copy.entities);
  assert.equal(sceneInstanceOf(project, copy.entities[0].id).kind, 'scene');
  const packed = packProject(project, { revision: 1 });
  const reopened = unpackProject(packed.document, path => packed.files.find(file => file.path === path)?.bytes).project;
  assert.equal(sceneInstanceOf(reopened, placed.group.rootId).name, 'One node');
  assert.doesNotThrow(() => validateProject(reopened));
});

test('layout node imports and exports carry the entire instance, scene editor imports remain editable', () => {
  const document = parseNodeFile(readFileSync(new URL('../public/examples/access-terminal.node', import.meta.url), 'utf8'));
  const project = createProject();
  const added = applyNodeFile(layoutContainer(project), document, { x: 64, y: 64 });
  const instance = sceneInstanceOf(project, added.ids[1]);
  assert.equal(instance.rootId, added.root);
  const exported = parseNodeFile(nodeFileText(exportNodeFile(layoutContainer(project), added.ids[1])));
  assert.equal(exported.nodes.length, added.ids.length + 1, 'a whole-instance wrapper includes all parts');
  const target = newScene('Editable');
  applyNodeFile(target, document);
  assert.ok(target.entities.every(entity => entity.groupId === undefined), 'scene-editor children are not locked');
  const child = target.entities[1], baseline = structuredClone(target);
  transformSceneNodes(target, baseline, child.id, 'move', { x: 16 }, 0);
  assert.equal(target.entities[0].x, baseline.entities[0].x);
  assert.equal(child.x, baseline.entities[1].x + 16);
  const captured = captureScene(project, added.ids);
  assert.ok(captured.entities.every(entity => entity.groupId === undefined));
  assert.doesNotThrow(() => validateProject(project));
});

test('older hierarchy imports and identifiable flattened placements are recovered once', () => {
  const { scene } = fixture(), project = createProject();
  const old = instantiateScene(scene, { prefix: 'instance_0123456789abcdef' });
  for (const entity of old.entities) delete entity.parentId;
  project.map.entities.push(...old.entities);
  project.scenes = [scene];
  const child = { id: 'old_chassis', type: 'decoration', name: 'Chassis', x: 4, y: 0, angle: 0, parentId: 'old_terminal' };
  project.map.entities.push({ id: 'old_terminal', type: 'decoration', name: 'Old terminal', x: 0, y: 0, angle: 0 }, child);
  assert.equal(upgradeSceneInstances(project), 2);
  assert.equal(sceneInstanceOf(project, child.id).rootId, 'old_terminal');
  assert.equal(sceneInstanceOf(project, old.entities[1].id).sceneId, scene.id);
  assert.equal(upgradeSceneInstances(project), 0);
  ungroup(project, sceneInstanceOf(project, child.id).id);
  assert.equal(upgradeSceneInstances(project), 0, 'explicit ungrouping is not undone on reload');
  assert.equal(sceneInstanceOf(project, child.id), null);
  assert.doesNotThrow(() => validateProject(project));
});

test('unrelated loose objects are never guessed into a scene instance', () => {
  const project = createProject();
  const before = structuredClone(project.map.entities);
  assert.equal(upgradeSceneInstances(project), 0);
  assert.deepEqual(project.map.entities, before);
  assert.equal(project.map.entityGroups, undefined);
  assert.throws(() => createSceneInstanceGroup(project, ['missing'], {}), /root and all/);
});

test('deleting an instance removes sibling-owned references before deleting any part', () => {
  const { project, terminal, chassis } = fixture();
  chassis.signals = ['done'];
  project.events.push({ id: 'sibling_script', name: 'Script on chassis', ownerId: chassis.id, enabled: true, once: false,
    condition: { type: 'onSignal', entityId: terminal.id, signal: 'submitted' }, conditions: [],
    actions: [{ type: 'emitSignal', entityId: chassis.id, signal: 'done', value: '' }] });
  const ids = layoutEntityIds(project, [terminal.id]);
  stripEntityReferences(project, ids);
  for (const id of ids) removeEntity(project, id);
  assert.ok(project.map.entities.every(entity => !ids.includes(entity.id)));
  assert.equal(project.map.entityGroups.length, 0);
  assert.ok(project.events.every(event => !ids.includes(event.ownerId)));
  assert.doesNotThrow(() => validateProject(project));
});

test('scene outlines measure actual media geometry at its current authored pose, before the next frame', () => {
  const { project, chassis } = fixture();
  chassis.angle = 90;
  const worldNode = createWorldNodeObject(THREE, chassis);
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  const start = source.indexOf('function boundsOfEntity(id)');
  const end = source.indexOf('for (const entity of project.map.entities)', start);
  const boundsOfEntity = runInNewContext(`${source.slice(start, end)}\nboundsOfEntity;`, {
    project, THREE, worldNodes: new Map([[chassis.id, worldNode]]),
    sectorIndex: { at: () => ({ floorHeight: 16 }) }, setWorldNodePose, modelOrientation,
  });
  let box = boundsOfEntity(chassis.id);
  const size = box.getSize(new THREE.Vector3());
  near(size.x, 6); near(size.y, 68); near(size.z, 52);
  near(box.min.y, chassis.elevation + 16);
  chassis.x += 100; chassis.elevation += 8;
  box = boundsOfEntity(chassis.id);
  near(box.getCenter(new THREE.Vector3()).x, chassis.x);
  near(box.min.y, chassis.elevation + 16);
  worldNode.geometry.dispose(); worldNode.material.dispose();
});

test('moving an instance reuses media geometry, while scaling or changing artwork replaces it', () => {
  const { placed, terminal, chassis } = fixture();
  const signatures = new Map(placed.entities.map(entity => [entity.id, entityMediaSignature(entity)]));
  const options = { hasModel: () => true, drawn: id => signatures.has(id) ? 'media' : null,
    drawnMedia: id => signatures.get(id) };
  assert.equal(entityRepresentation(terminal), 'media');
  assert.equal(entityRepresentation(chassis), 'media');
  for (let frame = 0; frame < 5; frame++) {
    terminal.x += 8; chassis.x += 8;
    terminal.angle += 15; chassis.angle += 15;
    const plan = liveProjectPlan(placed.entities, options);
    assert.deepEqual(plan.add, []); assert.deepEqual(plan.swap, []);
  }
  chassis.mesh.width *= 2;
  assert.deepEqual(liveProjectPlan(placed.entities, options).swap, [chassis.id]);
  terminal.terminal.width *= 2;
  assert.deepEqual(liveProjectPlan(placed.entities, options).swap, [terminal.id, chassis.id]);
  assert.deepEqual(liveProjectPlan([{ ...terminal, terminal: undefined, spriteAsset: 'picture' }], options).swap, [terminal.id]);
});
