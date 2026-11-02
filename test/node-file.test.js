import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newScene, addSceneObject, reparentSceneObject } from '../shared/scenes.js';
import { newJoint, newJointId } from '../shared/joints.js';
import { newPanel, validatePanel, panelPhysics, curtainStrips, PANEL_DEFAULTS } from '../shared/panel.js';
import { createPath } from '../shared/paths.js';
import { createProject, validateProject, validateEntity } from '../shared/project.js';
import {
  NODE_FILE_FORMAT, NODE_FILE_VERSION, exportNodeFile, nodeFileText, parseNodeFile, validateNodeFile,
  applyNodeFile, planNodeFileInstall, nodeFileName, layoutContainer,
} from '../shared/node-file.js';
import { entityRepresentation, liveProjectPlan } from '../shared/entity-visuals.js';
import { knownCommandTypes } from '../shared/engine-script.js';

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

// A layout object is a node in everything but where its table lives, so the same file can be a
// library of ready-made things — an enemy with its health, a truck with its model — and not only a
// part of a scene.
test('a layout object exports as a file, and the script travels only when asked for', () => {
  const project = createProject();
  project.assets = [sprite()];
  const entity = project.map.entities.find(item => item.type !== 'player');
  entity.spriteAsset = 'sprite_a';
  entity.variables = { health: 5 };
  project.events = [
    { id: 'own', name: 'Own rule', enabled: true, once: false, ownerId: entity.id,
      condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'addVariable', variable: 'score', value: 1 }] },
    { id: 'other', name: 'Someone else', enabled: true, once: false, ownerId: project.map.entities.find(item => item.type === 'player').id,
      condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'addVariable', variable: 'score', value: 1 }] },
  ];
  const layout = layoutContainer(project);
  assert.equal(layout.id, 'layout');

  const withScript = exportNodeFile(layout, entity.id, { assets: project.assets, includeEvents: true });
  assert.deepEqual(withScript.events.map(event => event.id), ['own'], 'only the object\'s own rule');
  assert.deepEqual(withScript.script, { available: 1, included: 1 });
  assert.deepEqual(withScript.assets.map(asset => asset.id), ['sprite_a'], 'the artwork comes along');
  assert.equal(withScript.nodes[0].variables.health, 5);
  assert.doesNotThrow(() => parseNodeFile(nodeFileText(withScript)), 'the file is a valid .node document');

  const withoutScript = exportNodeFile(layout, entity.id, { assets: project.assets, includeEvents: false });
  assert.deepEqual(withoutScript.events, []);
  assert.deepEqual(withoutScript.script, { available: 1, included: 0 });
  assert.match(withoutScript.warnings.join(' '), /visual script was not included/);

  // A route and a layout group belong to the layout, not to the object: the file cannot carry
  // them without dangling, so they are dropped and reported instead.
  entity.path = { id: 'route', speed: 64 };
  entity.groupId = 'group_a';
  project.paths = [createPath({ id: 'route', name: 'Route', points: [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 64, y: 0 },
  ] })];
  project.map.entityGroups = [{ id: 'group_a', name: 'Group' }];
  validateProject(project);
  const stripped = exportNodeFile(layoutContainer(project), entity.id, { assets: project.assets });
  assert.equal(stripped.nodes[0].path, undefined);
  assert.equal(stripped.nodes[0].groupId, undefined);
  assert.match(stripped.warnings.join(' '), /route was not included/);
  assert.match(stripped.warnings.join(' '), /group was not included/);
});

test('an object file imports into a layout without disturbing the layout it joins', () => {
  const source = createProject();
  source.assets = [sprite()];
  const original = source.map.entities.find(item => item.type !== 'player');
  original.name = 'Crate';
  original.spriteAsset = 'sprite_a';
  source.events = [{ id: 'own', name: 'Own rule', enabled: true, once: false, ownerId: original.id,
    condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'addVariable', variable: 'score', value: 1 }] }];
  const document = exportNodeFile(layoutContainer(source), original.id, { assets: source.assets });

  // The destination project has its own objects, its own events and no such artwork.
  const destination = createProject();
  const before = destination.map.entities.length;
  const install = planNodeFileInstall(document, { assets: destination.assets || [] });
  const container = layoutContainer(destination);
  const added = applyNodeFile(container, document, {
    x: 256, y: -128, assetRemap: install.assetRemap, shaderRemap: install.shaderRemap,
    maxEntities: 100000, maxEvents: 100000,
  });
  destination.assets = [...(destination.assets || []), ...install.addAssets];
  destination.map.joints = container.joints;
  destination.events = container.events;

  assert.equal(destination.map.entities.length, before + 1, 'the copy joins the layout');
  const copy = destination.map.entities.find(item => item.id === added.root);
  assert.equal(copy.name, 'Crate');
  assert.deepEqual([copy.x, copy.y], [256, -128], 'it lands where the importer put it');
  assert.equal(copy.spriteAsset, 'sprite_a', 'its artwork came with it');
  assert.equal(destination.events.filter(event => event.ownerId === copy.id).length, 1, 'and so did its rule');
  assert.doesNotThrow(() => validateProject(destination), 'the result is a valid project');
});

/** The clip a node paints with, so a file can be asked to carry it. */
const torchClip = (id = 'clip_torch') => ({ id, name: 'Torch', frames: ['sprite_a', 'sprite_b'], seconds: .1, loop: true });

test('a grouped node saves on its own when its group stays behind', () => {
  // Saving a child offers the child only: its parent is not carried, so the file must not name it.
  const { scene, lid } = nodeScene();
  const document = exportNodeFile(scene, lid.id, { assets: [sprite()] });
  assert.equal(document.nodes.length, 1);
  assert.equal(document.nodes[0].parentId, undefined, 'a parent the file does not hold is dropped');
  assert.match(document.warnings.join(' '), /parent group was not included/);
  assert.doesNotThrow(() => parseNodeFile(nodeFileText(document)), 'the file it writes is one it can read');
  const target = newScene('Target');
  const added = applyNodeFile(target, parseNodeFile(nodeFileText(document)), {});
  assert.equal(target.entities.find(item => item.id === added.root)?.parentId, undefined);
});

test('a sprite clip travels with the node that paints with it', () => {
  const project = createProject();
  project.assets = [sprite('sprite_a'), sprite('sprite_b', 'B')];
  const clips = [torchClip()];
  const torch = project.map.entities.find(item => item.type !== 'player');
  torch.name = 'Torch';
  torch.spriteAsset = 'sprite_a';
  torch.spriteStates = { stand: 'clip_torch' };

  const document = exportNodeFile(layoutContainer(project), torch.id, { assets: project.assets, clips });
  assert.deepEqual(document.clips.map(clip => clip.id), ['clip_torch'], 'the clip is in the file');
  assert.deepEqual(document.assets.map(asset => asset.id).sort(), ['sprite_a', 'sprite_b'], 'and so are its frames');
  assert.deepEqual(document.warnings, [], 'nothing is reported missing');

  // A destination with no clips at all still ends up valid, because the clip came along.
  const destination = createProject();
  const install = planNodeFileInstall(parseNodeFile(nodeFileText(document)), { assets: destination.assets || [] });
  assert.equal(install.addClips.length, 1);
  assert.equal(install.addAssets.length, 2);
  destination.assets = [...(destination.assets || []), ...install.addAssets];
  destination.spriteClips = [...(destination.spriteClips || []), ...install.addClips];
  applyNodeFile(layoutContainer(destination), parseNodeFile(nodeFileText(document)), {
    assetRemap: install.assetRemap, clipRemap: install.clipRemap, maxEntities: 100000,
  });
  assert.doesNotThrow(() => validateProject(destination));
  assert.equal(destination.map.entities.find(item => item.name === 'Torch').spriteStates.stand, 'clip_torch');

  // A clip the project does not have cannot be carried, and the file says so rather than
  // writing a state the destination would reject.
  const orphan = exportNodeFile(layoutContainer(project), torch.id, { assets: project.assets, clips: [] });
  assert.deepEqual(orphan.clips, []);
  assert.match(orphan.warnings.join(' '), /Missing sprite clips: clip_torch/);
});

test('an object\'s script keeps the sheet and group it was written in', () => {
  const source = createProject();
  source.assets = [sprite()];
  const pickup = source.map.entities.find(item => item.type !== 'player');
  pickup.name = 'Pickup';
  pickup.spriteAsset = 'sprite_a';
  pickup.variables = { taken: 0 };
  const sheet = { id: `object_${pickup.id}_0`, name: 'Pickup script', section: 'object', enabled: true, phase: 'afterPhysics' };
  const group = { id: `${sheet.id}_group`, name: 'Pickup logic', sheetId: sheet.id, enabled: true };
  source.eventSheets = [sheet];
  source.eventGroups = [group];
  // A second object the file does not carry: a rule naming it cannot travel.
  const rival = { ...structuredClone(pickup), id: 'entity_rival', name: 'Rival' };
  source.map.entities.push(rival);
  source.events = [
    { id: 'take', name: 'Take it', enabled: true, once: true, sheetId: sheet.id, groupId: group.id, ownerId: pickup.id,
      condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'addObjectVariable', entityId: pickup.id, variable: 'taken', value: 1 }] },
    // A parent that names the player cannot travel; its child has to go with it, or the file
    // would describe a sub-event whose parent does not exist.
    { id: 'loud', enabled: true, once: false, sheetId: sheet.id, groupId: group.id, ownerId: pickup.id,
      condition: { type: 'always' }, conditions: [], actions: [{ type: 'setEntityPosition', entityId: rival.id, x: 0, y: 0 }] },
    { id: 'child', enabled: true, once: false, sheetId: sheet.id, groupId: group.id, ownerId: pickup.id, parentId: 'loud',
      condition: { type: 'always' }, conditions: [], actions: [] },
  ];
  validateProject(source);
  const document = exportNodeFile(layoutContainer(source), pickup.id, {
    assets: source.assets, eventSheets: source.eventSheets, eventGroups: source.eventGroups,
  });
  assert.deepEqual(document.events.map(event => event.id), ['take'], 'only the script that stays inside the object travels');
  assert.match(document.warnings.join(' '), /parent rule was left out/);
  assert.deepEqual(document.sheets.map(item => item.name), ['Pickup script']);
  assert.deepEqual(document.groups.map(item => item.name), ['Pickup logic']);
  const parsed = parseNodeFile(nodeFileText(document));
  assert.doesNotThrow(() => validateNodeFile(parsed));

  // It lands in a project that has never heard of that sheet, and the project stays valid.
  const destination = createProject();
  const plan = planNodeFileInstall(parsed, { assets: destination.assets || [] });
  destination.assets = [...(destination.assets || []), ...plan.addAssets];
  destination.eventSheets = [...(destination.eventSheets || []), ...plan.addSheets];
  destination.eventGroups = [...(destination.eventGroups || []), ...plan.addGroups];
  applyNodeFile(layoutContainer(destination), parsed, { assetRemap: plan.assetRemap,
    sheetRemap: plan.sheetRemap, groupRemap: plan.groupRemap, maxEntities: 100000, maxEvents: 100000 });
  assert.doesNotThrow(() => validateProject(destination), 'the import is valid where it lands');
  const landed = destination.events.find(event => event.actions.some(action => action.type === 'addObjectVariable'));
  const landedSheet = destination.eventSheets.find(item => item.id === landed.sheetId);
  assert.equal(landedSheet?.name, 'Pickup script', 'the rule rejoined a sheet of that name');
  assert.equal(destination.eventGroups.find(item => item.id === landed.groupId)?.sheetId, landedSheet.id, 'and its group follows the sheet');
  assert.notEqual(landed.actions[0].entityId, pickup.id, 'the action points at the copy');

  // Importing the same file twice rejoins the sheet rather than duplicating it.
  const again = planNodeFileInstall(parsed, { assets: destination.assets || [], spriteClips: destination.spriteClips || [],
    eventSheets: destination.eventSheets || [], eventGroups: destination.eventGroups || [] });
  assert.deepEqual([again.addSheets.length, again.addGroups.length, again.addAssets.length], [0, 0, 0]);
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

test('selecting the scene root saves the whole scene as one group', () => {
  const scene = newScene('Whole');
  const frame = addSceneObject(scene, { name: 'Frame', x: 100, y: 50 });
  addSceneObject(scene, { name: 'Lid', x: 140, y: 50, parentId: frame.id });
  addSceneObject(scene, { name: 'Loose', x: 60, y: 90 });
  const document = exportNodeFile(scene, scene.id, {});
  validateNodeFile(document);
  parseNodeFile(nodeFileText(document));
  assert.equal(document.name, 'Whole');
  const root = document.nodes[0];
  assert.equal(root.name, 'Whole');
  assert.equal(root.parentId, undefined);
  // Every top-level node hangs under the wrapper, so the import is one object again.
  for (const node of document.nodes.slice(1)) assert.equal(node.parentId !== undefined, true);
  assert.deepEqual(document.nodes.map(node => [node.name, node.x, node.y]),
    [['Whole', 0, 0], ['Frame', 100, 50], ['Lid', 140, 50], ['Loose', 60, 90]]);
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
  // The download is one shared helper now, so a layout object and a scene node are saved the
  // same way — and the blob is revoked after the click rather than during it.
  assert.match(editor, /downloadNodeFile\(document, fileName\)/);
  assert.match(readFileSync(new URL('../public/export-object.js', import.meta.url), 'utf8'),
    /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);
  // Saving asks whether the visual script travels, the same question a layout object's export asks.
  assert.match(editor, /askObjectExport\(\{ name: name \|\| 'Node'/);
  assert.match(editor, /includeEvents: answer\.includeEvents/);
  assert.match(editor, /function importNodeFile\(point = null\)/);
  assert.match(editor, /picker\.accept = NODE_FILE_EXTENSION;/);
  assert.match(editor, /label: 'Save as a \.node file'/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function importNodeDocument\(document, options = \{\}\)/);
  assert.match(app, /planNodeFileInstall\(document/);
  assert.match(app, /applyNodeFile\(scene, document, \{ \.\.\.options/);
});

// A file written before the facing stopped turning the mesh stores the pose the old renderer drew,
// so its angle has to be moved over on the way in — otherwise the node lands visibly turned.
test('a node file written under the old facing meaning lands looking the same', () => {
  const scene = newScene('Source');
  const truck = addSceneObject(scene, { name: 'Truck', x: 0, y: 0, angle: 0, spriteAsset: 'sprite_a' });
  const document = exportNodeFile(scene, truck.id, { assets: [sprite()] });
  assert.equal(document.modelFacingSemantics, 2, 'what this build writes says which meaning it uses');
  // The old meaning: drawn at `angle - facing`, so this node looked as if it were at -90.
  const stale = structuredClone(document);
  delete stale.modelFacingSemantics;
  stale.nodes[0].modelFacing = 90;
  const target = newScene('Target');
  const added = applyNodeFile(target, parseNodeFile(nodeFileText(stale)), {});
  assert.equal(target.entities.find(item => item.id === added.root).angle, 270, 'angle - facing is what it used to look like');
  assert.equal(target.entities.find(item => item.id === added.root).modelFacing, 90, 'the declaration itself is kept');
  // A file from this build is taken as written.
  const current = newScene('Target');
  const same = applyNodeFile(current, parseNodeFile(nodeFileText(document)), {});
  assert.equal(current.entities.find(item => item.id === same.root).angle, 0);
});

test('an object file naming a command the destination lacks is stripped, not imported broken', () => {
  // A `.node` file can carry a rule written with an addon's action. Arriving in a project that does
  // not have that addon, the rule would make the project invalid, so the import drops the command,
  // says which, and drops the rule it emptied.
  const source = createProject();
  const crate = source.map.entities.find(item => item.type !== 'player');
  crate.name = 'Crate';
  source.events = [{ id: 'own', name: 'Sparkle on start', enabled: true, once: true, ownerId: crate.id,
    condition: { type: 'onStart' }, actions: [{ type: 'sparkle:burst', entityId: crate.id }] }];
  const document = exportNodeFile(layoutContainer(source), crate.id, { assets: source.assets });

  const destination = createProject();
  const container = layoutContainer(destination);
  const before = container.events.length;
  const added = applyNodeFile(container, document, { knownTypes: knownCommandTypes(destination), maxEntities: 100000, maxEvents: 100000 });
  destination.map.joints = container.joints;
  destination.events = container.events;
  assert.deepEqual(added.stripped.types, ['sparkle:burst'], 'the missing type is named');
  assert.equal(added.stripped.commands, 1);
  assert.equal(added.stripped.rules, 1, 'the rule it emptied is dropped rather than left without an action');
  assert.equal(container.events.filter(event => event.actions?.some(action => action.type === 'sparkle:burst')).length, 0);
  assert.equal(container.events.length, before, 'the layout keeps the rules it already had');
  assert.doesNotThrow(() => validateProject(destination), 'the result is valid, so the import is not wasted');

  // With the addon declaring the type, nothing is stripped and the rule arrives intact.
  const known = new Set([...knownCommandTypes(destination), 'sparkle:burst']);
  const second = createProject();
  const other = layoutContainer(second);
  const kept = applyNodeFile(other, document, { knownTypes: known, maxEntities: 100000, maxEvents: 100000 });
  second.events = other.events;
  assert.deepEqual(kept.stripped, { commands: 0, rules: 0, types: [] });
  assert.deepEqual(second.events.filter(event => event.name === 'Sparkle on start').map(event => event.actions.map(action => action.type)),
    [['sparkle:burst']]);
});

test('a rule that still says something keeps what is left when one command is unknown', () => {
  const source = createProject();
  const crate = source.map.entities.find(item => item.type !== 'player');
  source.events = [{ id: 'own', name: 'Mixed', enabled: true, once: false, ownerId: crate.id,
    condition: { type: 'onStart' }, conditions: [{ type: 'sparkle:check' }],
    actions: [{ type: 'addVariable', variable: 'score', value: 1 }, { type: 'sparkle:burst' }] }];
  const document = exportNodeFile(layoutContainer(source), crate.id, { assets: source.assets });

  const destination = createProject();
  const container = layoutContainer(destination);
  const added = applyNodeFile(container, document, { knownTypes: knownCommandTypes(destination), maxEntities: 100000, maxEvents: 100000 });
  destination.events = container.events;
  assert.deepEqual([...added.stripped.types].sort(), ['sparkle:burst', 'sparkle:check']);
  assert.equal(added.stripped.rules, 0, 'the surviving condition and action are still a rule');
  const landed = destination.events.find(event => event.name === 'Mixed');
  assert.deepEqual(landed.actions.map(action => action.type), ['addVariable']);
  assert.deepEqual(landed.conditions, [], 'the unknown condition is gone');
  assert.doesNotThrow(() => validateProject(destination));
});

test('a sub-event does not arrive without the rule that held it', () => {
  const source = createProject();
  const crate = source.map.entities.find(item => item.type !== 'player');
  source.events = [
    { id: 'parent', name: 'Parent', enabled: true, once: false, ownerId: crate.id,
      condition: { type: 'onStart' }, actions: [{ type: 'sparkle:burst' }] },
    { id: 'child', name: 'Child', enabled: true, once: false, ownerId: crate.id, parentId: 'parent',
      condition: { type: 'onStart' }, actions: [{ type: 'addVariable', variable: 'score', value: 1 }] },
  ];
  const document = exportNodeFile(layoutContainer(source), crate.id, { assets: source.assets });
  const destination = createProject();
  const container = layoutContainer(destination);
  const before = container.events.length;
  const added = applyNodeFile(container, document, { knownTypes: knownCommandTypes(destination), maxEntities: 100000, maxEvents: 100000 });
  destination.events = container.events;
  assert.equal(container.events.length, before, 'neither the emptied parent nor its orphaned child came');
  assert.equal(container.events.filter(event => ['Parent', 'Child'].includes(event.name)).length, 0);
  assert.equal(added.stripped.rules, 2);
});
