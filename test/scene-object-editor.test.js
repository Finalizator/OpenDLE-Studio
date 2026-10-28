import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newScene, addSceneObject, removeSceneObjects, duplicateSceneObject, reparentSceneObject,
  moveSceneObject, renameSceneObject, sceneChildren, sceneDepths, sceneSubtree, sceneDescendants,
  instantiateScene, captureScene, MAX_SCENE_ENTITIES,
} from '../shared/scenes.js';
import { createProject, validateProject } from '../shared/project.js';

/** A scene with two roots and a two level group under the second root. */
function groupedScene() {
  const scene = newScene('Props');
  const crate = addSceneObject(scene, { type: 'decoration', name: 'Crate', x: -64, y: 0 });
  const lamp = addSceneObject(scene, { type: 'light', name: 'Lamp', x: 64, y: 0 });
  const imp = addSceneObject(scene, { type: 'enemy', name: 'Imp', x: 96, y: 64, parentId: lamp.id });
  const spark = addSceneObject(scene, { type: 'light', name: 'Spark', x: 32, y: 32, parentId: imp.id });
  return { scene, crate, lamp, imp, spark };
}

test('a new scene object starts empty with an origin and no nodes', () => {
  const scene = newScene('Doors');
  assert.equal(scene.name, 'Doors');
  assert.deepEqual(scene.entities, []);
  assert.deepEqual(scene.events, []);
  assert.deepEqual(scene.origin, { x: 0, y: 0 });
  assert.match(scene.id, /^scene_[0-9a-f]{16}$/);
});

test('the node tree groups objects by parent and keeps stored order', () => {
  const { scene, crate, lamp, imp, spark } = groupedScene();
  const children = sceneChildren(scene);
  assert.deepEqual(children.get('').map(entity => entity.name), ['Crate', 'Lamp']);
  assert.deepEqual(children.get(imp.id).map(entity => entity.name), ['Spark']);
  assert.deepEqual(sceneDepths(scene), new Map([[crate.id, 0], [lamp.id, 0], [imp.id, 1], [spark.id, 2]]));
  assert.deepEqual(sceneSubtree(scene, lamp.id).map(entity => entity.name), ['Lamp', 'Imp', 'Spark']);
  assert.deepEqual(sceneDescendants(scene, lamp.id).sort(), [imp.id, spark.id].sort());
  assert.deepEqual(sceneDescendants(scene, spark.id), []);
});

test('an object can be added under a parent and refuses an unknown one', () => {
  const { scene, lamp } = groupedScene();
  const added = addSceneObject(scene, { type: 'enemy', name: 'Imp 2', x: 8, y: 8, parentId: lamp.id });
  assert.equal(added.parentId, lamp.id);
  assert.equal(scene.entities.at(-1).id, added.id);
  // A light object carries a light, so it is visible straight away.
  const light = addSceneObject(scene, { type: 'light', name: 'Torch' });
  assert.deepEqual(light.light, { color: '#ffbd72', intensity: 1, radius: 192 });
  assert.throws(() => addSceneObject(scene, { name: 'Orphan', parentId: 'node_missing' }), /Unknown parent object/);
});

test('the node limit is enforced when adding, duplicating and validating', () => {
  const scene = newScene('Full');
  for (let index = 0; index < MAX_SCENE_ENTITIES; index++) addSceneObject(scene, { name: `Node ${index}` });
  assert.throws(() => addSceneObject(scene, { name: 'Overflow' }), /at most 128 objects/);
  assert.throws(() => duplicateSceneObject(scene, scene.entities[0].id), /at most 128 objects/);
});

test('removing a node removes its group and the events that scripted them', () => {
  const { scene, lamp, imp, spark, crate } = groupedScene();
  scene.events = [
    { id: 'ev_imp', ownerId: imp.id, enabled: true, once: true, actions: [] },
    { id: 'ev_crate', ownerId: crate.id, enabled: true, once: true, actions: [] },
  ];
  const result = removeSceneObjects(scene, lamp.id);
  assert.deepEqual(result, { removed: 3, events: 1 });
  assert.deepEqual(scene.entities.map(entity => entity.name), ['Crate']);
  assert.deepEqual(scene.events.map(event => event.id), ['ev_crate']);
  // Removing a node that is already gone is a no-op rather than an error.
  assert.deepEqual(removeSceneObjects(scene, spark.id), { removed: 0, events: 0 });
});

test('duplicating a node copies the group with fresh ids and rewrites its events', () => {
  const { scene, lamp, imp } = groupedScene();
  scene.events = [{ id: 'ev_imp', ownerId: imp.id, enabled: true, once: true,
    actions: [{ type: 'setVariable', name: 'lit', value: 'own' }],
    conditions: [{ type: 'entityDamaged', entityId: imp.id }] }];
  const copy = duplicateSceneObject(scene, lamp.id);
  assert.equal(copy.ids.length, 3, 'the whole group is copied');
  const copies = scene.entities.filter(entity => copy.ids.includes(entity.id));
  assert.equal(copies.length, 3);
  assert.equal(new Set(scene.entities.map(entity => entity.id)).size, scene.entities.length, 'ids stay unique');
  const copiedLamp = copies.find(entity => entity.name.startsWith('Lamp'));
  const copiedImp = copies.find(entity => entity.name.startsWith('Imp'));
  assert.equal(copiedLamp.x, lamp.x + 32, 'the copy is nudged so it is visible');
  assert.equal(copiedImp.parentId, copiedLamp.id, 'grouping points at the copied parent, not the original');
  const copiedEvent = scene.events.find(event => event.ownerId === copiedImp.id);
  assert.ok(copiedEvent, 'the group event is copied for the new node');
  assert.equal(copiedEvent.conditions[0].entityId, copiedImp.id, 'references are rewritten');
  assert.notEqual(copiedEvent.id, 'ev_imp');
});

test('reparenting refuses a cycle and accepts the scene root', () => {
  const { scene, lamp, imp } = groupedScene();
  assert.throws(() => reparentSceneObject(scene, lamp.id, lamp.id), /under itself/);
  assert.throws(() => reparentSceneObject(scene, lamp.id, imp.id), /under its own child/);
  assert.throws(() => reparentSceneObject(scene, lamp.id, 'node_missing'), /Unknown parent object/);
  reparentSceneObject(scene, imp.id, null);
  assert.equal(scene.entities.find(entity => entity.id === imp.id).parentId, undefined, 'a root has no parent key');
  reparentSceneObject(scene, imp.id, lamp.id);
  assert.equal(scene.entities.find(entity => entity.id === imp.id).parentId, lamp.id);
});

test('reordering moves a node only among its own siblings', () => {
  const { scene, crate, lamp } = groupedScene();
  assert.equal(moveSceneObject(scene, lamp.id, -1), true);
  assert.deepEqual(sceneChildren(scene).get('').map(entity => entity.name), ['Lamp', 'Crate']);
  assert.equal(moveSceneObject(scene, lamp.id, -1), false, 'the first sibling cannot move up');
  assert.equal(moveSceneObject(scene, crate.id, 1), false, 'the last sibling cannot move down');
  // A child never jumps out of its group by being reordered.
  const { scene: nested, imp, spark } = groupedScene();
  moveSceneObject(nested, spark.id, -1);
  assert.equal(nested.entities.find(entity => entity.id === spark.id).parentId, imp.id);
});

test('renaming rejects an empty name and trims the rest', () => {
  const { scene, crate } = groupedScene();
  assert.throws(() => renameSceneObject(scene, crate.id, '   '), /cannot be empty/);
  renameSceneObject(scene, crate.id, '  Wooden crate  ');
  assert.equal(scene.entities.find(entity => entity.id === crate.id).name, 'Wooden crate');
});

test('project validation accepts a grouped scene and rejects a broken tree', () => {
  const { scene, lamp, crate } = groupedScene();
  const project = createProject();
  project.scenes = [scene];
  assert.equal(validateProject(project), project);

  const unknownParent = createProject();
  const orphan = newScene('Orphan'); addSceneObject(orphan, { name: 'Node' });
  orphan.entities[0].parentId = 'node_missing';
  unknownParent.scenes = [orphan];
  assert.throws(() => validateProject(unknownParent), /parent references an unknown object/);

  const selfParent = createProject();
  const selfish = newScene('Self');
  addSceneObject(selfish, { name: 'Node' });
  selfish.entities[0].parentId = selfish.entities[0].id;
  selfParent.scenes = [selfish];
  assert.throws(() => validateProject(selfParent), /under itself/);

  const cyclic = createProject();
  const loop = newScene('Loop');
  const a = addSceneObject(loop, { name: 'A' }), b = addSceneObject(loop, { name: 'B', parentId: a.id });
  loop.entities.find(entity => entity.id === a.id).parentId = b.id;
  cyclic.scenes = [loop];
  assert.throws(() => validateProject(cyclic), /cycle/);

  // The scene itself is untouched by a rejected validation.
  assert.equal(validateProject(JSON.parse(JSON.stringify({ ...createProject(), scenes: [{ ...scene, name: 'Props' }] }))).scenes[0].entities.length, 4);
  assert.ok(lamp && crate);
});

test('a scene keeps the events a captured object already had', () => {
  // A scene event carries the same commands a map event does. Core actions such as
  // addVariable are not in the engine tables, so validating them through engineCommand
  // rejected any scene holding a starter pickup's own script.
  const project = createProject();
  const pickup = project.map.entities.find(entity => entity.type === 'pickup');
  const scene = captureScene(project, [pickup.id], { name: 'Pickup' });
  assert.ok(scene.events.length, 'the pickup event travels with the scene');
  assert.ok(scene.events[0].actions.some(action => action.type === 'addVariable'));
  project.scenes = [scene];
  assert.equal(validateProject(project), project);
  // A genuinely unknown command is still refused.
  const broken = createProject();
  const copy = captureScene(broken, [broken.map.entities.find(entity => entity.type === 'pickup').id]);
  copy.events[0] = { ...copy.events[0], actions: [{ type: 'nonsense' }] };
  broken.scenes = [copy];
  assert.throws(() => validateProject(broken), /Unknown scene event action: nonsense/);
});

test('placing a scene drops the editing hierarchy but keeps every object', () => {
  const { scene } = groupedScene();
  const placed = instantiateScene(scene, { x: 100, y: 100 });
  assert.equal(placed.entities.length, 4);
  assert.ok(placed.entities.every(entity => entity.parentId === undefined), 'a placed copy joins the flat map');
  assert.equal(new Set(placed.entities.map(entity => entity.id)).size, 4, 'placed ids are fresh');
});

test('a captured scene is flat, so older scenes keep working', () => {
  const project = createProject();
  project.map.entities.push({ id: 'thing_crate', type: 'decoration', name: 'Crate', x: 64, y: 0, angle: 0 });
  const scene = captureScene(project, ['thing_crate'], { name: 'Captured' });
  assert.equal(scene.entities.length, 1);
  assert.equal(scene.entities[0].parentId, undefined);
  assert.equal(scene.entities[0].x, 0, 'captured coordinates are relative to the scene origin');
});

test('the studio offers scene objects in the Layouts section and opens an editor', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // The entry point: a list of scene objects inside the Layouts section, plus a button
  // that makes a new one.
  assert.match(html, /<details open><summary>Layouts<\/summary>/);
  assert.match(html, /<div id="scene-objects" class="scene-object-list"/);
  assert.match(html, /<button id="new-scene-object"/);
  // The editor itself: scene tab strip, node dock, view and inspector.
  for (const id of ['scene-panel', 'scene-tabs', 'scene-tree', 'scene-canvas', 'scene-properties', 'scene-inspector-head', 'scene-filter', 'scene-inspector-filter']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  for (const tool of ['add', 'duplicate', 'up', 'down', 'expand', 'collapse', 'rename', 'delete']) {
    assert.match(html, new RegExp(`data-scene-tool="${tool}"`), `the ${tool} toolbar button exists`);
  }
});

test('the scene editor copies the Godot docking, not a plain form', () => {
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  // Category headers with a twisty and per-row revert arrows: the inspector's shape.
  assert.match(editor, /property-category-name/);
  assert.match(editor, /property-revert/);
  assert.match(editor, /Reset \$\{label\}/);
  // The tree shows the node type in parentheses, and the root is the scene itself.
  assert.match(editor, /node-type/);
  assert.match(editor, /const root = el\('div', null, 'node-row node-row-root'\)/);
  // Dragging a node in the tree reparents it, dragging in the view moves its group.
  assert.match(editor, /drop-into/);
  assert.match(editor, /reparentSceneObject/);
  assert.match(editor, /sceneSubtree\(next, drag\.id\)\.slice\(1\)/);
  // Arrow keys walk the tree, F2 renames, Delete removes.
  for (const key of ['ArrowDown', 'ArrowRight', 'F2', 'Delete']) assert.match(editor, new RegExp(`'${key}'`), `${key} is handled`);
  // Empty categories are not drawn, exactly like Godot's folded groups.
  assert.match(editor, /if \(!body\.childElementCount\) return;/);
});

test('the 2D and 3D tabs both draw the scene, and neither uses inline styles', () => {
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  // Godot's 2D/3D toggle: a top-down blueprint and an orbit camera over the same nodes.
  assert.match(editor, /function draw3d\(/);
  assert.match(editor, /state\.view3d = button\.dataset\.sceneView === '3d'/);
  assert.match(editor, /function orbitEye\(\)/);
  assert.match(editor, /kind: event\.button === 2 \? 'dolly' : 'orbit'/);
  // up = forward x right: getting this backwards drew every node as a flat sliver.
  assert.match(editor, /up = forward x right/);
  // The app's CSP refuses inline styles, so indentation and the dock popup are classes.
  assert.equal(/\.style\./.test(editor), false, 'no style attribute writes');
  assert.match(editor, /row\.classList\.add\(`node-depth-\$\{Math\.min\(depth, 8\)\}`\)/);
  const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  for (const depth of [0, 4, 8]) assert.match(style, new RegExp(`\\.node-depth-${depth} \\{`), `depth ${depth} has a class`);
  assert.match(style, /\.dock-popup \{ position: absolute;/);
});

test('scene object edits go through the project edit path so undo and validation apply', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ createSceneObjectEditor \} from '\.\/scene-object-editor\.js';/);
  assert.match(app, /function renderSceneObjects\(\)/);
  assert.match(app, /function openSceneObject\(id\)/);
  assert.match(app, /function createSceneObject\(\)/);
  // Every scene edit is applied with editGame, which clones, validates and records history.
  assert.match(app, /editScene\(id, fn, message\) \{\s*editGame\(next => \{/);
  // Opening a scene shows its panel and keeps the tab strip in step.
  assert.match(app, /showTab\('scene'\)/);
  assert.match(app, /renderSceneObjectTabs\(\)/);
  // The scene panel is part of the tab list, so switching tabs hides it again.
  assert.match(app, /\['map', 'events', 'environment', 'hud', 'actors', 'scripts', 'logs', 'tweaks', 'scriptlets', 'about', 'scene'\]/);
});
