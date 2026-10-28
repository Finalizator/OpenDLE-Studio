import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newScene, addSceneObject, reparentSceneObject } from '../shared/scenes.js';
import { newJoint, newJointId } from '../shared/joints.js';
import { newPanel, validatePanel, panelPhysics, curtainStrips, PANEL_DEFAULTS } from '../shared/panel.js';
import { createProject, validateProject, validateEntity } from '../shared/project.js';
import {
  NODE_FILE_FORMAT, NODE_FILE_VERSION, exportNodeFile, nodeFileText, parseNodeFile, validateNodeFile,
  applyNodeFile, planNodeFileInstall, nodeFileName,
} from '../shared/node-file.js';
import { entityRepresentation, liveProjectPlan } from '../shared/entity-visuals.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const sprite = (id = 'sprite_a', name = 'A') => ({ id, kind: 'sprite', name, width: 32, height: 32, src: PNG });
const panels = () => newPanel({ width: 30, height: 192, opacity: .4 });

const body = (kind = 'dynamic') => ({ body: kind, shape: 'box', width: 32, height: 32, depth: 32, radius: 16,
  mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: false });

function nodeScene() {
  const scene = newScene('Source');
  const frame = addSceneObject(scene, { name: 'Frame', x: 100, y: 50, spriteAsset: 'sprite_a', physics: body('fixed') });
  const lid = addSceneObject(scene, { name: 'Lid', x: 116, y: 50, parentId: frame.id, spriteAsset: 'sprite_a', physics: body() });
  return { scene, frame, lid };
}

/* ------------------------------------------------------------------ panels */

test('a panel is clamped to something drawable', () => {
  const panel = newPanel({ width: 4000, opacity: 4, thickness: -3, color: 'not a color' });
  assert.equal(panel.width, 4000);
  assert.equal(panel.opacity, 1);
  assert.equal(panel.thickness, .5);
  assert.equal(panel.color, PANEL_DEFAULTS.color);
  assert.doesNotThrow(() => validatePanel(panel));
  assert.throws(() => validatePanel({ opacity: 2 }), /opacity must be a number between 0 and 1/);
  assert.throws(() => validatePanel({ color: '#12' }), /color must be #rrggbb/);
  assert.throws(() => validatePanel(null), /must be an object/);
});

test('a panel becomes a box collider of its own size', () => {
  const panel = panels();
  const physics = panelPhysics(panel);
  assert.equal(physics.shape, 'box');
  assert.deepEqual([physics.width, physics.height, physics.depth], [30, 192, 2]);
  assert.equal(physics.body, 'dynamic');
});

test('a curtain is a row of strips around the point it is dropped on', () => {
  const strips = curtainStrips({ x: 64, y: 128, width: 320, height: 192, stripWidth: 30, gap: 6 });
  assert.ok(strips.length >= 8, `got ${strips.length} strips`);
  const left = strips[0], right = strips[strips.length - 1];
  // Symmetric around the drop point, and the pitch is strip + gap.
  assert.ok(Math.abs((left.x - 64) + (right.x - 64)) <= 1, `${left.x} and ${right.x} are symmetric`);
  assert.equal(right.x - left.x, (strips.length - 1) * 36);
  assert.equal(left.y, 128);
  for (const strip of strips) {
    assert.equal(strip.panel.height, 192);
    assert.equal(strip.panel.width, 30);
    assert.match(strip.name, /Curtain strip \d+/);
  }
  // An angled curtain runs along its facing instead of along x.
  const angled = curtainStrips({ x: 0, y: 0, width: 320, angle: 90 });
  assert.ok(Math.abs(angled[0].x) <= 1, 'a 90 degree curtain spreads along y');
  assert.ok(Math.abs(angled[0].y) > Math.abs(angled[0].x));
});

test('a project validates panels, and a bad one is refused', () => {
  const project = createProject();
  project.map.entities[1].panel = panels();
  project.map.entities[1].physics = panelPhysics(panels());
  assert.doesNotThrow(() => validateProject(project));
  project.map.entities[1].panel = { opacity: 45 };
  assert.throws(() => validateProject(project), /opacity/);
});

test('panels are their own representation and swap in place', () => {
  assert.equal(entityRepresentation({ panel: panels() }), 'panel');
  assert.equal(entityRepresentation({ modelAsset: 'm' }), 'model');
  assert.equal(entityRepresentation({}), 'sprite');
  const plan = liveProjectPlan([{ id: 'a', panel: panels() }], {
    hasModel: () => false, drawn: id => (id === 'a' ? 'sprite' : null),
  });
  assert.deepEqual(plan.swap, ['a']);
  assert.deepEqual(plan.add, ['a']);
});

/* ------------------------------------------------------- per-object shaders */

test('an object may reference a shader of its own, and one that does not exist', () => {
  const project = createProject();
  project.shaders = [{ id: 'tint', name: 'Tint', language: 'glsl', uniforms: { strength: 1 },
    source: 'vec4 effect(vec4 color, vec2 uv, float time) { return vec4(color.rgb * strength, color.a); }' }];
  project.map.entities[1].shaderId = 'tint';
  assert.doesNotThrow(() => validateProject(project));
  project.map.entities[1].shaderId = 'missing';
  assert.throws(() => validateProject(project), /unknown shader missing/);
  delete project.map.entities[1].shaderId;
  project.scenes = [newScene('S')];
  project.scenes[0].entities.push({ id: 'node_a', name: 'A', type: 'decoration', x: 0, y: 0, angle: 0, shaderId: 'nope' });
  assert.throws(() => validateProject(project), /unknown shader nope/);
});

test('the renderers apply per-object shaders and draw panels', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(render, /function withEffectFor\(material, entity\)/);
  assert.match(render, /const effect = effectFor\(entity\?\.shaderId\)/);
  assert.match(render, /withEffectFor\(original\.clone\(\), entity\)/);
  assert.match(render, /function addPanel\(entity\)/);
  assert.match(render, /new THREE\.MeshPhysicalMaterial\(/);
  const view = readFileSync(new URL('../public/scene-3d-view.js', import.meta.url), 'utf8');
  assert.match(view, /function withShader\(material, entity\)/);
  assert.match(view, /compileGLSLEffect\(shader, \{ screen: screenTarget\.texture, resolution: effectResolution \}\)/);
  assert.match(view, /} else if \(entity\.panel\) \{/);
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /label: 'Shader'/);
  assert.match(editor, /rows\('Panel'/);
  assert.match(editor, /function addCurtain\(point = null\)/);
});

/* -------------------------------------------------------------- .node files */

test('a node file carries the group, its joints, artwork and shaders', () => {
  const { scene, frame, lid } = nodeScene();
  scene.joints = [newJoint({ type: 'fixed', a: frame.id, b: lid.id, anchor: { x: 108, y: 50, z: 16 } })];
  lid.shaderId = 'tint';
  const document = exportNodeFile(scene, frame.id, {
    assets: [sprite(), { id: 'other', kind: 'sprite', name: 'B', width: 8, height: 8, src: PNG }],
    shaders: [{ id: 'tint', name: 'Tint', language: 'glsl', source: 'vec4 effect(vec4 c, vec2 uv, float t) { return c; }' }],
  });
  assert.equal(document.format, NODE_FILE_FORMAT);
  assert.equal(document.version, NODE_FILE_VERSION);
  assert.equal(document.name, 'Frame');
  assert.equal(document.nodes.length, 2);
  // Coordinates are relative to the group's corner, so the file is placeable anywhere.
  assert.deepEqual(document.nodes.map(node => [node.x, node.y]), [[0, 0], [16, 0]]);
  assert.deepEqual(document.origin, { x: 100, y: 50 });
  assert.equal(document.joints.length, 1);
  assert.deepEqual([document.joints[0].anchor.x, document.joints[0].anchor.y], [8, 0]);
  // Only the artwork the node uses travels with it.
  assert.deepEqual(document.assets.map(asset => asset.id), ['sprite_a']);
  assert.deepEqual(document.shaders.map(shader => shader.id), ['tint']);
  assert.deepEqual(document.warnings, []);
  assert.doesNotThrow(() => parseNodeFile(nodeFileText(document)));
});

test('events travel with a node only when they stay inside it', () => {
  const { scene, frame, lid } = nodeScene();
  scene.events = [
    { id: 'inside', name: 'Inside', enabled: true, once: false, ownerId: frame.id,
      conditions: [], actions: [{ type: 'removeEntity', entityId: lid.id }] },
    { id: 'outside', name: 'Outside', enabled: true, once: false, ownerId: frame.id,
      conditions: [], actions: [{ type: 'nearEntity', entityId: 'someone_else', distance: 32 }] },
  ];
  const document = exportNodeFile(scene, frame.id, { assets: [sprite()] });
  assert.deepEqual(document.events.map(event => event.id), ['inside']);
  assert.match(document.warnings.join(' '), /1 event\(s\) left out/);
});

test('an invalid .node file is refused with a readable reason', () => {
  const { scene, frame } = nodeScene();
  const good = exportNodeFile(scene, frame.id, { assets: [sprite()] });
  const clone = () => structuredClone(good);
  const broken = [
    [{ ...clone(), format: 'something-else' }, /format must be/],
    [{ ...clone(), version: 99 }, /version 99 is not supported/],
    [{ ...clone(), nodes: [] }, /it has no nodes/],
    [{ ...clone(), assets: [] }, /Sprite sprite_a is not part of the file/],
    [(() => { const document = clone(); document.nodes[0].shaderId = 'tint'; document.shaders = []; return document; })(),
      /shader tint is not part of the file/],
  ];
  for (const [document, pattern] of broken) assert.throws(() => validateNodeFile(document), pattern);
  const cyclic = clone();
  cyclic.nodes[0].parentId = cyclic.nodes[1].id;
  cyclic.nodes[1].parentId = cyclic.nodes[0].id;
  assert.throws(() => validateNodeFile(cyclic), /cycle/);
  const dangling = clone();
  dangling.nodes[1].parentId = 'ghost';
  assert.throws(() => validateNodeFile(dangling), /unknown node/);
  assert.throws(() => parseNodeFile('{ not json'), /not JSON/);
  assert.throws(() => parseNodeFile(''), /is empty/);
});

test('importing a node places a fresh copy with remapped joints and events', () => {
  const { scene, frame, lid } = nodeScene();
  scene.joints = [newJoint({ type: 'fixed', a: frame.id, b: lid.id, anchor: { x: 108, y: 50, z: 16 } })];
  scene.events = [{ id: 'inside', enabled: true, once: false, ownerId: frame.id, conditions: [],
    actions: [{ type: 'removeEntity', entityId: lid.id }] }];
  const document = exportNodeFile(scene, frame.id, { assets: [sprite()] });

  const target = newScene('Target');
  const result = applyNodeFile(target, document, { x: 400, y: -200 });
  assert.equal(result.ids.length, 2);
  assert.equal(result.root, result.ids[0]);
  assert.deepEqual(target.entities.map(entity => [entity.name, entity.x, entity.y]), [['Frame', 400, -200], ['Lid', 416, -200]]);
  // Fresh ids, so importing the same file twice never collides.
  const second = applyNodeFile(target, document, { x: 0, y: 0 });
  assert.equal(new Set([...result.ids, ...second.ids]).size, 4);
  assert.equal(target.joints.length, 2);
  assert.notEqual(target.joints[1].id, target.joints[0].id);
  assert.equal(target.joints[1].a, second.ids[0]);
  // The copied event follows the copied object.
  assert.equal(target.events[1].ownerId, second.ids[0]);
  assert.equal(target.events[1].actions[0].entityId, second.ids[1]);
  // Grouping survives the copy, and the import as a whole validates.
  assert.equal(target.entities.find(entity => entity.id === second.ids[1]).parentId, second.ids[0]);
  const project = createProject();
  project.assets = [sprite()];
  project.scenes = [target];
  assert.doesNotThrow(() => validateProject(project));
});

test('an import can be rotated and grouped under an existing node', () => {
  const { scene, frame } = nodeScene();
  const document = exportNodeFile(scene, frame.id, { assets: [sprite()] });
  const target = newScene('Target');
  const host = addSceneObject(target, { name: 'Host', x: 0, y: 0 });
  const result = applyNodeFile(target, document, { x: 0, y: 0, parentId: host.id, degrees: 90 });
  const root = target.entities.find(entity => entity.id === result.root);
  assert.equal(root.parentId, host.id);
  // A quarter turn maps (x, y) to (-y, x).
  const lid = target.entities.find(entity => entity.name === 'Lid');
  assert.deepEqual([lid.x, lid.y], [0, 16]);
  assert.equal(lid.angle, 90);
});

test('importing reuses the destination artwork, and renames an id that clashes', () => {
  const { scene, frame } = nodeScene();
  const document = exportNodeFile(scene, frame.id, { assets: [sprite()] });
  const same = planNodeFileInstall(document, { assets: [sprite()] });
  assert.equal(same.addAssets.length, 0);
  assert.equal(same.assetRemap.size, 0);
  const clash = planNodeFileInstall(document, { assets: [{ ...sprite(), src: 'data:image/png;base64,AAAA' }] });
  assert.equal(clash.addAssets.length, 1);
  assert.ok(clash.assetRemap.has('sprite_a'));
  const renamed = clash.assetRemap.get('sprite_a');
  assert.match(renamed, /^[a-zA-Z0-9_-]+$/);
  const target = newScene('Target');
  applyNodeFile(target, document, { assetRemap: clash.assetRemap });
  assert.ok(target.entities.every(entity => entity.spriteAsset === renamed));

  const shaderDocument = { ...document, shaders: [{ id: 'tint', name: 'Tint', language: 'glsl', source: 'a' }] };
  const shaderClash = planNodeFileInstall(shaderDocument, { shaders: [{ id: 'tint', name: 'Tint', language: 'glsl', source: 'b' }] });
  assert.ok(shaderClash.shaderRemap.has('tint'));
  assert.equal(shaderClash.addShaders.length, 1);
});

test('the scene limit and file names behave', () => {
  const { scene, frame } = nodeScene();
  const document = exportNodeFile(scene, frame.id, { assets: [sprite()] });
  const target = newScene('Target');
  for (let index = 0; index < 127; index++) addSceneObject(target, { name: `Filler ${index}` });
  assert.throws(() => applyNodeFile(target, document, { x: 0, y: 0 }), /at most 128 objects/);
  assert.equal(nodeFileName('My Crate!'), 'My-Crate.node');
  assert.equal(nodeFileName(''), 'node.node');
  assert.equal(nodeFileName('a/b\\c*'), 'abc.node');
});

test('the studio offers saving and importing node files', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  // Both actions are visible buttons in the scene view's toolbar, not only menu entries.
  assert.match(html, /<button id="scene-save-node"[^>]*>Save \.node<\/button>/);
  assert.match(html, /<button id="scene-import-node"[^>]*>Import \.node<\/button>/);
  assert.match(editor, /dom\.saveNode\?\.addEventListener\('click', \(\) => runTool\('save-node'\)\)/);
  assert.match(editor, /dom\.importNode\?\.addEventListener\('click', \(\) => runTool\('import-node'\)\)/);
  // Saving needs a node, so the button is disabled on the scene root rather than failing.
  assert.match(editor, /dom\.saveNode\.disabled = !hasNode/);
  assert.match(editor, /function saveNodeFile\(nodeId\)/);
  assert.match(editor, /link\.download = name;/);
  assert.match(editor, /function importNodeFile\(point = null\)/);
  assert.match(editor, /picker\.accept = NODE_FILE_EXTENSION;/);
  assert.match(editor, /label: 'Save as a \.node file'/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function importNodeDocument\(document, options = \{\}\)/);
  assert.match(app, /planNodeFileInstall\(document/);
  assert.match(app, /applyNodeFile\(scene, document, \{ \.\.\.options/);
});
