import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newScene, addSceneObject, removeSceneObjects, duplicateSceneObject, reparentSceneObject,
  moveSceneObject, renameSceneObject, sceneChildren, sceneDepths, sceneSubtree, sceneDescendants,
  instantiateScene, captureScene, MAX_SCENE_ENTITIES,
  sceneAssetUse, setSceneObjectAsset, addSceneObjectFromAsset, addSceneObjectFromEntity, nestScene, sceneArtwork,
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
  assert.deepEqual(result, { removed: 3, events: 1, joints: 0 });
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
  // Godot's 2D/3D toggle: a top-down blueprint and a real 3D viewport over the same nodes.
  assert.match(editor, /function render3d\(/);
  assert.match(editor, /state\.view3d = button\.dataset\.sceneView === '3d'/);
  assert.match(editor, /function orbitEye\(\)/);
  assert.match(editor, /kind: right \? 'dolly' : 'orbit'/);
  // The 3D tab hands the drawing to the viewport instead of painting boxes on the canvas.
  assert.match(editor, /render3d\(\);/);
  // The app's CSP refuses inline style *attributes*, so indentation and the dock popup are
  // classes. CSSOM property writes are allowed, and the menu positioning and the drag
  // ghost need them (the layout editor already moves its own drag ghost the same way).
  assert.equal(/setAttribute\('style'|\.style\.cssText/.test(editor), false, 'no style attribute writes');
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

/* ------------------------------------------------------------------ assets */

const SPRITE = { id: 'asset_imp', kind: 'sprite', name: 'Imp', width: 40, height: 56, src: 'data:image/png;base64,AA==' };
const MODEL = { id: 'asset_crate', kind: 'model', name: 'Crate.glb', preview: 'data:image/png;base64,BB==' };
const SOUND = { id: 'asset_boom', kind: 'sound', name: 'Boom' };

test('an asset decides whether a node shows a sprite or a model', () => {
  assert.equal(sceneAssetUse(SPRITE), 'sprite');
  assert.equal(sceneAssetUse({ ...SPRITE, kind: 'flat' }), 'sprite');
  assert.equal(sceneAssetUse(MODEL), 'model');
  assert.equal(sceneAssetUse(SOUND), null);
  assert.equal(sceneAssetUse(null), null);
});

test('assigning a sprite or a model replaces the other kind of artwork', () => {
  const scene = newScene('Props');
  const node = addSceneObject(scene, { name: 'Crate' });
  assert.match(setSceneObjectAsset(scene, node.id, SPRITE), /Sprite Imp set on Crate/);
  assert.equal(node.spriteAsset, SPRITE.id);
  assert.match(setSceneObjectAsset(scene, node.id, MODEL), /Model Crate.glb set on Crate/);
  assert.equal(node.modelAsset, MODEL.id);
  // The sprite stays as the fallback artwork, exactly like the layout editor.
  assert.equal(node.spriteAsset, SPRITE.id);
  // Going back to a sprite drops the model so the node is not geometry any more.
  setSceneObjectAsset(scene, node.id, SPRITE);
  assert.equal(node.modelAsset, undefined);
  assert.throws(() => setSceneObjectAsset(scene, node.id, SOUND), /not a picture or a model/);
  assert.throws(() => setSceneObjectAsset(scene, 'node_missing', SPRITE), /no longer exists/);
});

test('dropping an asset places a node named after it, reusing names', () => {
  const scene = newScene('Props');
  const first = addSceneObjectFromAsset(scene, SPRITE, { x: 32, y: 64 });
  assert.equal(first.name, 'Imp');
  assert.equal(first.type, 'decoration');
  assert.equal(first.spriteAsset, SPRITE.id);
  assert.deepEqual([first.x, first.y], [32, 64]);
  const second = addSceneObjectFromAsset(scene, SPRITE, { x: 0, y: 0 });
  assert.equal(second.name, 'Imp 2');
  const model = addSceneObjectFromAsset(scene, MODEL, { x: 8, y: 8 });
  // The file extension never becomes part of the node name.
  assert.equal(model.name, 'Crate');
  assert.equal(model.modelAsset, MODEL.id);
  assert.equal(model.modelScale, 32);
  assert.throws(() => addSceneObjectFromAsset(scene, SOUND, { x: 0, y: 0 }), /not a picture or a model/);
  assert.throws(() => addSceneObjectFromAsset(scene, SPRITE, { x: Number.NaN, y: 0 }), /inside the scene view/);
});

test('a layout object can be dragged into a scene as a copy', () => {
  const scene = newScene('Props');
  const source = { id: 'pickup_cell', type: 'pickup', name: 'Energy cell', x: -128, y: 96, angle: 90, spriteAsset: SPRITE.id };
  const copy = addSceneObjectFromEntity(scene, source, { x: 16, y: 16 });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, 'Energy cell');
  assert.equal(copy.type, 'pickup');
  assert.deepEqual([copy.x, copy.y], [16, 16]);
  assert.equal(copy.spriteAsset, SPRITE.id);
  assert.equal(scene.entities.length, 1);
  assert.throws(() => addSceneObjectFromEntity(scene, { id: 'player_1', type: 'player', name: 'Player' }, { x: 0, y: 0 }),
    /cannot contain the player/);
});

test('nesting a scene copies its nodes under one group and re-parents them inside it', () => {
  const target = newScene('Level');
  const source = newScene('Door');
  const frame = addSceneObject(source, { name: 'Frame', x: 0, y: 0 });
  const panel = addSceneObject(source, { name: 'Panel', x: 32, y: 0, parentId: frame.id });
  const { group, ids } = nestScene(target, source, { x: 128, y: 64 });
  assert.equal(group.name, 'Door');
  assert.equal(ids.length, 2);
  const [copiedFrame, copiedPanel] = target.entities.slice(1);
  assert.notEqual(copiedFrame.id, frame.id);
  assert.equal(copiedFrame.parentId, group.id);
  assert.equal(copiedPanel.parentId, copiedFrame.id);
  // Coordinates are moved to the drop point and stay absolute inside the scene.
  assert.deepEqual([copiedFrame.x, copiedFrame.y], [128, 64]);
  assert.deepEqual([copiedPanel.x, copiedPanel.y], [160, 64]);
  assert.equal(copiedPanel.id, ids[1]);
  assert.throws(() => nestScene(target, target, { x: 0, y: 0 }), /cannot be placed inside itself/);
  assert.throws(() => nestScene(target, newScene('Empty'), { x: 0, y: 0 }), /has no objects to place/);
});

test('scene artwork reports the picture and the world size each node draws', () => {
  const assets = [SPRITE, MODEL];
  const sprite = sceneArtwork({ spriteAsset: SPRITE.id, spriteScale: 2 }, assets);
  assert.equal(sprite.kind, 'sprite');
  assert.equal(sprite.src, SPRITE.src);
  assert.deepEqual([sprite.width, sprite.height], [80, 112]);
  const model = sceneArtwork({ modelAsset: MODEL.id, modelScale: 48 }, assets);
  assert.equal(model.kind, 'model');
  assert.equal(model.src, MODEL.preview);
  assert.deepEqual([model.width, model.height], [48, 48]);
  assert.equal(sceneArtwork({}, assets), null);
  assert.equal(sceneArtwork({ spriteAsset: 'asset_gone' }, assets), null);
});

test('a scene built from dropped assets and nested scenes validates', () => {
  const project = createProject();
  const props = newScene('Props');
  addSceneObjectFromAsset(props, SPRITE, { x: 0, y: 0 });
  const nested = newScene('Nested');
  addSceneObjectFromAsset(nested, SPRITE, { x: 16, y: 16 });
  const outer = newScene('Outer');
  nestScene(outer, nested, { x: 64, y: 64 });
  project.assets = [SPRITE];
  project.scenes = [props, nested, outer];
  assert.doesNotThrow(() => validateProject(project));
});

test('the editor has one context menu and one searchable asset picker', () => {
  const menu = readFileSync(new URL('../public/context-menu.js', import.meta.url), 'utf8');
  assert.match(menu, /export function contextMenu\(/);
  assert.match(menu, /export function closeContextMenu\(/);
  // Positioned with CSSOM writes, which the CSP allows; style attributes are refused.
  assert.equal(/setAttribute\('style'|\.style\.cssText/.test(menu), false, 'no style attribute writes');
  const picker = readFileSync(new URL('../public/asset-picker.js', import.meta.url), 'utf8');
  assert.match(picker, /export function openAssetPicker\(/);
  // An imported game carries about 1500 sprites, so the list is bounded and searchable
  // instead of one <select> option per asset.
  assert.match(picker, /const ROW_LIMIT = 200;/);
  assert.match(picker, /Showing \$\{matches\.length\} of \$\{total\} assets/);
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /openAssetPicker\(\{/);
  // Assigning artwork goes through the shared helper, so a sprite drops the model.
  assert.match(editor, /setSceneObjectAsset\(/);
  assert.match(editor, /function bindDropping\(/);
  assert.match(editor, /addSceneObjectFromAsset\(/);
  assert.match(editor, /nestScene\(/);
  // The view draws the assigned artwork instead of an anonymous box.
  assert.match(editor, /artworkImage\(artworkOf\(entity\)\?\.src\)/);
  assert.match(editor, /view3d\?\.groundPoint\(event\.clientX, event\.clientY\)/);
});

test('right click answers on the layout, in the 3D view and on every list', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function installContextMenus\(\)/);
  for (const list of ['asset-list', 'event-list', 'sector-list', 'scene-objects']) {
    assert.match(app, new RegExp(`\\$\\('${list}'\\)\\.addEventListener\\('contextmenu'`), `${list} has a context menu`);
  }
  assert.match(app, /for \(const id of \['entities', 'project-objects'\]\)/);
  assert.match(app, /\$\(id\)\.addEventListener\('contextmenu'/);
  assert.match(app, /function mapCanvasMenu\(/);
  assert.match(app, /menu: \(event, picked\) => mapViewMenu\(event, picked\)/);
  // A right click is told apart from a right-drag pan, so panning does not open menus.
  assert.match(app, /finished\.kind === 'pan' && finished\.button === 2 && !finished\.moved/);
  const scene = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  assert.match(scene, /if \(!completed\.moved\) \{/);
  assert.match(scene, /callbacks\.menu\?\.\(event/);
  const logs = readFileSync(new URL('../public/playtest-log-panel.js', import.meta.url), 'utf8');
  assert.match(logs, /Playtest session actions/);
  assert.match(logs, /Log entry actions/);
});

test('the 3D view flies with WASD by default and keeps the orbit camera as an option', () => {
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  // The layout's 3D movement is the default here too: Fly, with Orbit beside it.
  assert.match(editor, /camera: 'fly',/);
  assert.match(editor, /function setCameraMode\(mode\)/);
  assert.match(editor, /function flyDirection\(\)/);
  assert.match(editor, /function frameFlyFromOrbit\(\)/);
  assert.match(editor, /function orbitFromFly\(\)/);
  // Right-drag looks around, and a right click that never moved still opens the menu.
  assert.match(editor, /kind: right \? 'look' : 'none'/);
  assert.match(editor, /state\.fly\.yaw = drag\.yaw \+ dx \* \.003/);
  assert.match(editor, /drag\.kind === 'look'\) && !drag\.moved/);
  // WASD/QE walking with the layout view's four-times Shift boost and capped frame step.
  assert.match(editor, /const speed = state\.fly\.speed \* Math\.min\(dt, \.05\)/);
  assert.match(editor, /\* \(keys\.has\('ShiftLeft'\) \|\| keys\.has\('ShiftRight'\) \? 4 : 1\)/);
  assert.match(editor, /if \(state\.camera === 'fly' && state\.keys\.size\) moveFly\(dt\);/);
  // The wheel sets the fly speed, exactly like the layout view.
  assert.match(editor, /state\.fly\.speed = Math\.max\(16, Math\.min\(8192, state\.fly\.speed \* Math\.exp\(-event\.deltaY \* \.001\)\)\)/);
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /data-scene-camera="fly" class="active" aria-pressed="true"/);
  assert.match(page, /data-scene-camera="orbit"/);
  // The frame loop has to hand the editor its delta time, or the camera would jitter.
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /sceneObjectEditor\?\.frame\(dt\)/);
});
