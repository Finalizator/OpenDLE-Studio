import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { embedVideoFile, VIDEO_MAX_BYTES, videoMimeForFile } from '../shared/media-assets.js';
import { entityMediaAssetIds, isNonvisualMediaNode, MEDIA_NODE_DEFAULTS, NODE_KINDS } from '../shared/media-nodes.js';
import { addSceneObject, newScene } from '../shared/scenes.js';
import { applyNodeFile, exportNodeFile, parseNodeFile, planNodeFileInstall } from '../shared/node-file.js';
import { projectZipEntries, packProject, unpackProject } from '../server/project-folder.js';
import { readProjectArchive } from '../server/project-archive.js';
import { createZipArchive } from '../server/export-build.js';
import { createWorldNodeObject, createWorldTerminalController, gameplayCrosshairVisible, runtimeQuaternionToMapZUp, setWorldNodePose } from '../public/world-media.js';
import { installEngineScripts, defaultEngineCommand } from '../shared/engine-script.js';
import { modelOrientation } from '../shared/entity-visuals.js';
import { createEntityAudioRuntime } from '../public/audio.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { nextSignal, emitSignal } from '../shared/signals.js';
import { captureGameSave, restoreGameSave, gameSaveIdentity } from '../shared/save-game.js';

const uri = (mime, data = 'AA==') => `data:${mime};base64,${data}`;
const soundAsset = (id = 'sound_a', data = 'AQ==') => ({ id, name: 'Loop', kind: 'sound', src: uri('audio/wav', data) });
const videoAsset = (id = 'video_a', data = 'Ag==') => ({ id, name: 'Display', kind: 'video', format: 'mp4', src: uri('video/mp4', data) });
const textureAsset = { id: 'texture_a', name: 'Picture', kind: 'texture', width: 1, height: 1,
  src: 'data:image/png;base64,AAAA' };

test('sound components do not hide assigned artwork or gameplay entities', () => {
  const sound = { type: 'decoration', nodeKind: 'sound', sound: MEDIA_NODE_DEFAULTS.sound };
  assert.equal(isNonvisualMediaNode(sound), true);
  for (const patch of [{ modelAsset: 'model' }, { spriteAsset: 'image' }, { type: 'enemy' }, { type: 'light' }]) {
    assert.equal(isNonvisualMediaNode({ ...sound, ...patch }), false);
    assert.equal(createWorldNodeObject(THREE, { ...sound, ...patch }), null);
  }
});

function mediaProject() {
  const project = createProject();
  project.assets = [soundAsset(), videoAsset(), textureAsset];
  const node = project.map.entities[1];
  node.nodeKind = 'terminal';
  node.spriteAsset = textureAsset.id;
  node.spritePlane = { ...MEDIA_NODE_DEFAULTS.spritePlane };
  node.sound = { ...MEDIA_NODE_DEFAULTS.sound, assetId: 'sound_a' };
  node.projector = { ...MEDIA_NODE_DEFAULTS.projector, assetId: 'video_a' };
  node.terminal = { ...MEDIA_NODE_DEFAULTS.terminal, buttons: [{ label: 'Open door', value: 1 }] };
  node.mesh = { ...MEDIA_NODE_DEFAULTS.mesh, shape: 'sphere' };
  return project;
}

test('ordinary entities validate media components and the full nodeKind vocabulary', () => {
  const project = mediaProject();
  assert.deepEqual(entityMediaAssetIds(project.map.entities[1]), ['sound_a', 'video_a']);
  assert.deepEqual(NODE_KINDS, ['node3d', 'marker', 'mesh', 'sprite', 'sound', 'projector', 'terminal', 'panel', 'light', 'zone', 'enemy', 'pickup', 'ramp', 'camera']);
  assert.doesNotThrow(() => validateProject(project));
  project.map.entities[1].projector.assetId = 'sound_a';
  assert.throws(() => validateProject(project), /image or video/);
  project.map.entities[1].projector.assetId = 'missing';
  assert.throws(() => validateProject(project), /unknown asset/);
  project.map.entities[1].projector.assetId = 'video_a';
  project.map.entities[1].nodeKind = 'arbitrary';
  assert.throws(() => validateProject(project), /Unknown node kind/);
  project.map.entities[1].nodeKind = 'mesh';
  project.map.entities[1].mesh.shape = 'triangle';
  assert.throws(() => validateProject(project), /Unknown mesh shape/);
});

test('MP4 and WebM files become bounded embedded assets with no external URL references', async () => {
  const file = (name, type, bytes = [0, 1, 2]) => ({
    name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  });
  assert.equal(videoMimeForFile(file('screen.MP4', '')), 'video/mp4');
  assert.equal(videoMimeForFile(file('scene.webm', 'video/webm')), 'video/webm');
  const asset = await embedVideoFile(file('scene.webm', 'video/webm'), 'video_new');
  assert.equal(asset.kind, 'video');
  assert.equal(asset.format, 'webm');
  assert.equal(asset.src, uri('video/webm', 'AAEC'));
  await assert.rejects(embedVideoFile(file('screen.mp4', 'video/webm'), 'bad'), /extension does not match/);
  assert.throws(() => videoMimeForFile({ name: 'large.mp4', type: 'video/mp4', size: VIDEO_MAX_BYTES + 1 }), /64 MiB/);
  assert.throws(() => videoMimeForFile(file('stream.m3u8', 'application/vnd.apple.mpegurl')), /local MP4 or WebM/);
});

test('video assets survive project folder save and reopen with their MIME and bytes', () => {
  const project = mediaProject();
  const packed = packProject(project, { revision: 3 });
  const videoFile = packed.files.find(file => file.path.endsWith('.mp4'));
  assert.ok(videoFile);
  assert.equal(packed.document.project.assets.find(asset => asset.id === 'video_a').src, undefined);
  const unpacked = unpackProject(structuredClone(packed.document), path => packed.files.find(file => file.path === path)?.bytes || null);
  assert.equal(unpacked.project.assets.find(asset => asset.id === 'video_a').src, uri('video/mp4', 'Ag=='));
  assert.doesNotThrow(() => validateProject(unpacked.project));
});

test('portable project archives carry video MIME and payloads through export/import', async () => {
  const project = mediaProject();
  const archive = createZipArchive(projectZipEntries(project), new Date('2026-01-01T00:00:00Z'));
  const reopened = await readProjectArchive(archive);
  assert.equal(reopened.project.assets.find(asset => asset.id === 'video_a').src, uri('video/mp4', 'Ag=='));
  assert.doesNotThrow(() => validateProject(reopened.project));
});

test('node files carry embedded sound and video references and remap conflicting ids', () => {
  const source = newScene('Media scene');
  const node = addSceneObject(source, {
    name: 'Media terminal', x: 8, y: 12, nodeKind: 'projector',
    sound: { ...MEDIA_NODE_DEFAULTS.sound, assetId: 'sound_a' },
    projector: { ...MEDIA_NODE_DEFAULTS.projector, assetId: 'video_a' },
  });
  const document = parseNodeFile(JSON.stringify(exportNodeFile(source, node.id,
    { assets: [soundAsset(), videoAsset()] })));
  assert.deepEqual(document.assets.map(asset => asset.id).sort(), ['sound_a', 'video_a']);
  const plan = planNodeFileInstall(document, {
    assets: [soundAsset('sound_a', 'Aw=='), videoAsset('video_a', 'BA==')],
  });
  assert.equal(plan.addAssets.length, 2);
  const imported = newScene('Destination');
  // applyNodeFile performs the remapping; the scene receives fresh IDs and both assets travel in the plan.
  applyNodeFile(imported, document, { assetRemap: plan.assetRemap });
  assert.notEqual(imported.entities[0].sound.assetId, 'sound_a');
  assert.notEqual(imported.entities[0].projector.assetId, 'video_a');
  assert.deepEqual(new Set(plan.addAssets.map(asset => asset.id)), new Set([
    imported.entities[0].sound.assetId, imported.entities[0].projector.assetId,
  ]));
});

test('shared factories make centered planes with bottom-anchored poses and correctly oriented mesh primitives', () => {
  const plane = createWorldNodeObject(THREE, {
    spritePlane: { width: 64, height: 40, billboard: false, opacity: .5, doubleSided: true },
  });
  plane.geometry.computeBoundingBox();
  assert.equal(plane.nodeKind, 'spritePlane');
  assert.equal(plane.geometry.boundingBox.min.y, -20);
  assert.equal(plane.geometry.boundingBox.max.y, 20);
  assert.equal(plane.material.opacity, .5);
  setWorldNodePose(plane, { x: 0, y: 0, z: 10, spritePlane: { height: 40 } });
  assert.equal(plane.object.position.y + plane.geometry.boundingBox.min.y, 10);
  const zUpPlane = createWorldNodeObject(THREE, {
    spritePlane: { width: 64, height: 40, billboard: false, opacity: 1, doubleSided: true },
  }, { upAxis: 'z' });
  zUpPlane.geometry.computeBoundingBox();
  setWorldNodePose(zUpPlane, { x: 0, y: 0, z: 10, spritePlane: { height: 40 } }, 0, modelOrientation, { upAxis: 'z' });
  assert.equal(zUpPlane.object.position.z + zUpPlane.geometry.boundingBox.min.z, 10);
  const texturedPlane = createWorldNodeObject(THREE, {
    spritePlane: { width: 64, height: 40, billboard: false, opacity: 1, doubleSided: true },
  }, { texture: new THREE.Texture() });
  assert.equal(texturedPlane.material.transparent, true);
  assert.equal(texturedPlane.material.depthWrite, false);

  const mesh = createWorldNodeObject(THREE, {
    mesh: { shape: 'box', width: 32, height: 48, depth: 16, color: '#8aa2c8', opacity: 1 },
  }, { upAxis: 'z' });
  mesh.geometry.computeBoundingBox();
  assert.deepEqual(mesh.geometry.boundingBox.getSize(new THREE.Vector3()).toArray(), [32, 16, 48]);
  const entity = { x: 5, y: 7, z: 10, angle: 90, modelTilt: { pitch: 30, roll: 20 }, mesh: { height: 48 } };
  setWorldNodePose(mesh, entity, 0, modelOrientation, { upAxis: 'z' });
  assert.deepEqual(mesh.object.position.toArray(), [5, 7, 34]);
  const expectedMapOrientation = runtimeQuaternionToMapZUp(modelOrientation(entity));
  mesh.object.quaternion.toArray().forEach((value, index) => {
    assert.ok(Math.abs(value - expectedMapOrientation[index]) < 1e-10);
  });

  const runtimeNode = createWorldNodeObject(THREE, {
    spritePlane: { width: 64, height: 40, billboard: false, opacity: 1, doubleSided: true },
  });
  const runtimeEntity = { x: 5, y: 7, z: 10, angle: 90, modelTilt: { pitch: 30, roll: 20 }, spritePlane: { height: 40 } };
  setWorldNodePose(runtimeNode, runtimeEntity, 0, modelOrientation);
  assert.deepEqual(runtimeNode.object.position.toArray(), [5, 30, 7]);
  assert.equal(runtimeNode.object.quaternion.length(), 1);
});

function fakeTerminalDocument() {
  const labels = [];
  const context = {
    fillRect() {}, strokeRect() {}, fillText(text) { labels.push(text); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
  return { labels,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return { getContext: () => context, style: { cursor: '' }, focus() { this.focused = true; } };
    },
  };
}

test('keypad configuration rejects codes that its digit controls cannot enter', () => {
  const project = mediaProject(), terminal = project.map.entities[1].terminal;
  terminal.code = 'OPEN';
  assert.throws(() => validateProject(project), /Terminal code must contain only digits/);
  terminal.code = '0123';
  assert.doesNotThrow(() => validateProject(project));
});

test('terminal CanvasTexture keypad grants access and configured buttons set only data variables', () => {
  const project = mediaProject(), terminal = project.map.entities[1].terminal;
  const object = createWorldNodeObject(THREE, { terminal }, { document: fakeTerminalDocument() });
  const { canvas } = object.terminal;
  const textureVersion = object.terminal.texture.version;
  const clickAt = (x, y) => object.terminal.hit(x / canvas.width, 1 - y / canvas.height, { variables: project.variables });
  const digit = (value, x, y) => clickAt(x, y);
  // The number keys form a 3x3 grid; its first row starts at y=250 for the default 512x384 surface.
  digit('1', 90, 250); digit('2', 255, 250); digit('3', 420, 250);
  digit('4', 90, 288);
  assert.equal(clickAt(420, 364), true, 'Enter is the last keypad key');
  assert.equal(object.terminal.unlocked, true);
  assert.equal(project.variables.terminalUnlocked, 1);
  // The post-unlock action button is drawn above the keypad.
  assert.equal(clickAt(100, 190), true);
  assert.equal(project.variables.terminalUnlocked, 1);
  assert.ok(object.terminal.texture.version > textureVersion);

  const terminalDocument = fakeTerminalDocument();
  createWorldNodeObject(THREE, { terminal: { ...terminal, mode: 'terminal', buttons: [] } }, { document: terminalDocument });
  assert.ok(terminalDocument.labels.includes('> login _'));
  assert.ok(terminalDocument.labels.includes('Run'));
});

test('terminal focus operates its projected texture without creating a popup or mounting its canvas', () => {
  const document = fakeTerminalDocument(), focusTarget = { style: { cursor: 'crosshair' }, focus() {} };
  const ui = createWorldNodeObject(THREE, { terminal: MEDIA_NODE_DEFAULTS.terminal }, { document }).terminal;
  const entity = { id: 'terminal', x: 0, y: 0, terminal: MEDIA_NODE_DEFAULTS.terminal };
  const state = { gameScreen: 'playing', player: { x: 0, y: 0, z: 0 } };
  document.createElement = () => { throw new Error('Terminal interaction must not create DOM UI'); };
  const controller = createWorldTerminalController({ document, focusTarget, state, getEntity: () => entity });
  const before = ui.texture.version;
  assert.equal(controller.open({ terminal: ui }, entity), true);
  assert.equal(focusTarget.style.cursor, 'crosshair', 'screen targeting never takes over the OS cursor');
  controller.pointer(.2, .5);
  assert.equal(controller.hit(90 / 512, 1 - 250 / 384), true);
  assert.ok(ui.texture.version > before);
  assert.equal(ui.canvas.parentElement, undefined);
  assert.equal(controller.close(), true);
  assert.equal(focusTarget.style.cursor, 'crosshair');
  assert.equal(state.worldTerminalActive, false);
  ui.dispose();
});

test('surface keypad stores local digits including leading zeros and emits even an incorrect submission', () => {
  const project = mediaProject(), entity = project.map.entities[1];
  entity.variables = { digits: '' }; entity.signals = ['submitted'];
  Object.assign(entity.terminal, { variable: null, inputVariable: 'digits', submitSignal: 'submitted', code: '0123' });
  validateProject(project);
  const state = createRuntime(project), target = state.entities.find(item => item.id === entity.id);
  const ui = createWorldNodeObject(THREE, { id: target.id, terminal: target.terminal, variables: target.variables },
    { document: fakeTerminalDocument() }).terminal;
  const click = (x, y) => ui.hit(x / ui.canvas.width, 1 - y / ui.canvas.height, state);
  click(255, 364); click(90, 250);
  assert.equal(target.variables.digits, '01');
  click(420, 364);
  assert.equal(ui.message, 'Access denied');
  assert.deepEqual(nextSignal(state), { entityId: target.id, signal: 'submitted', value: '01' });
  click(90, 364);
  assert.equal(target.variables.digits, '');
  click(255, 364); click(90, 250); click(255, 250); click(420, 250);
  click(420, 364);
  assert.equal(target.variables.digits, '0123');
  assert.equal(ui.unlocked, true);
  assert.deepEqual(nextSignal(state), { entityId: target.id, signal: 'submitted', value: '0123' });
  assert.equal(Object.hasOwn(state.variables, 'null'), false, 'signal-driven terminals do not write a global output');
  ui.dispose();
});

test('local terminal digits persist in a game save but queued signals do not replay', async () => {
  const project = mediaProject(), entity = project.map.entities[1];
  entity.variables = { digits: '' }; entity.signals = ['submitted'];
  Object.assign(entity.terminal, { variable: null, inputVariable: 'digits', submitSignal: 'submitted' });
  const state = createRuntime(project), target = state.entities.find(item => item.id === entity.id);
  target.variables.digits = '0042';
  emitSignal(state, target.id, 'submitted', '0042');
  const identity = await gameSaveIdentity(project);
  const record = captureGameSave(project, state, identity);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(record)), identity);
  assert.equal(restored.runtime.entities.find(item => item.id === entity.id).variables.digits, '0042');
  assert.equal(nextSignal(restored.runtime), null);
});

test('terminal controller preserves pointer lock and closes on lifecycle changes', () => {
  const document = fakeTerminalDocument(), focusTarget = document.createElement('canvas');
  const state = { gameScreen: 'playing', player: { x: 0, y: 0, z: 0 } };
  let releases = 0;
  document.pointerLockElement = focusTarget;
  document.exitPointerLock = () => {
    releases++;
    document.pointerLockElement = null;
  };
  const entities = new Map();
  const entity = { id: 'terminal', x: 0, y: 0, z: 0, terminal: { range: 10, title: 'Terminal' } };
  entities.set(entity.id, entity);
  const clicks = [];
  const entry = { terminal: {
    canvas: document.createElement('canvas'),
    hit(u, v, runtimeState) {
      clicks.push([u, v]);
      runtimeState.variables.terminalUnlocked = 1;
    },
  } };
  const controller = createWorldTerminalController({
    document, focusTarget, state, getEntity: id => entities.get(id),
  });

  assert.equal(controller.open(entry, entity), true);
  assert.equal(releases, 0, 'screen interaction keeps mouse look captured');
  assert.equal(document.pointerLockElement, focusTarget);
  assert.equal(state.worldTerminalActive, true);
  assert.equal(state.worldTerminalId, entity.id);
  controller.hit(.5, .5);
  assert.deepEqual(clicks, [[.5, .5]]);
  assert.equal(state.variables.terminalUnlocked, 1);
  state.player.x = 10.1;
  controller.update();
  assert.equal(controller.active, false);
  assert.equal(state.worldTerminalActive, false);
  assert.equal(state.worldTerminalId, undefined);

  state.player.x = 0;
  assert.equal(controller.open(entry, entity), true);
  state.gameScreen = 'pause';
  controller.update();
  assert.equal(controller.active, false, 'leaving play closes the terminal');
  state.gameScreen = 'playing';
  assert.equal(controller.open(entry, entity), true);
  entities.delete(entity.id);
  controller.update();
  assert.equal(controller.active, false, 'removing the entity closes the terminal');
  entities.set(entity.id, entity);
  assert.equal(controller.open(entry, entity), true);
  controller.dispose();
  assert.equal(state.worldTerminalActive, false);
  assert.equal(controller.active, false);
});

test('terminal interaction never calls browser focus or pointer-lock APIs', () => {
  const document = fakeTerminalDocument(), focusTarget = document.createElement('canvas');
  const state = { gameScreen: 'playing', player: { x: 0, y: 0, z: 0 } };
  const entity = { id: 'terminal', x: 0, y: 0, terminal: { range: 160 } };
  document.pointerLockElement = focusTarget;
  document.exitPointerLock = () => { throw new Error('Screen interaction must not release pointer lock'); };
  focusTarget.focus = () => { throw new Error('Screen interaction must not steal focus'); };
  const controller = createWorldTerminalController({
    document, focusTarget, state, getEntity: () => entity,
  });
  assert.equal(controller.open({ terminal: { canvas: document.createElement('canvas') } }, entity), true);
  assert.equal(controller.close(), true);
  assert.equal(state.worldTerminalActive, false);
  assert.equal(controller.active, false);
});

test('screen targeting draws a surface pointer only when its UV changes and clears it on leave', () => {
  const ui = createWorldNodeObject(THREE, { terminal: MEDIA_NODE_DEFAULTS.terminal }, { document: fakeTerminalDocument() }).terminal;
  const entity = { id: 'terminal', x: 0, y: 0, terminal: MEDIA_NODE_DEFAULTS.terminal };
  const state = { gameScreen: 'playing', player: { x: 0, y: 0, z: 0 } };
  const controller = createWorldTerminalController({ state, getEntity: () => entity });
  controller.open({ terminal: ui }, entity);
  const before = ui.texture.version;
  controller.pointer(.5, .5);
  assert.ok(ui.texture.version > before);
  const pointed = ui.texture.version;
  controller.pointer(.5, .5);
  assert.equal(ui.texture.version, pointed, 'stationary aim does not redraw the screen');
  controller.close();
  assert.ok(ui.texture.version > pointed, 'leaving removes the pointer from the surface');
  ui.dispose();
});

test('Interacting with screen blocks firing without blocking movement or normal input events', () => {
  const project = createProject();
  installEngineScripts(project);
  project.variables.screen = 0; project.variables.used = 0;
  project.events.push(
    { id: 'screen_condition', enabled: true, once: false, condition: defaultEngineCommand('interactingWithScreen'),
      actions: [{ type: 'addVariable', variable: 'screen', value: 1 }] },
    { id: 'screen_use', enabled: true, once: false, condition: { type: 'keyPressed', key: 'KeyE' },
      actions: [{ type: 'addVariable', variable: 'used', value: 1 }] });
  validateProject(project);
  const state = createRuntime(project);
  state.gameScreen = 'playing'; state.hudState.cursor = false; state.worldTerminalActive = true;
  const before = { x: state.player.x, y: state.player.y, ammo: state.playerStats.bullets };
  const keys = new Set(['KeyW', 'Mouse0', 'Mouse2']), pressed = new Set(['Mouse0', 'KeyE']);
  stepRuntime(project, state, .05, keys, pressed);
  assert.equal(state.variables.screen, 1);
  assert.equal(state.variables.used, 1);
  assert.notDeepEqual([state.player.x, state.player.y], [before.x, before.y]);
  assert.equal(state.playerStats.bullets, before.ammo);
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.lastShot, undefined);
  assert.equal(keys.has('Mouse0'), true, 'caller-owned inputs are unchanged');
  state.worldTerminalActive = false;
  stepRuntime(project, state, .05, new Set(['Mouse0']), new Set(['Mouse0']));
  assert.equal(state.variables.screen, 1);
  assert.ok(state.playerStats.bullets < before.ammo, 'weapon firing resumes off the screen');
});

test('crosshair is present without a HUD, defers to an authored one, and never covers a nearby targeted screen', () => {
  const project = createProject(), state = { gameScreen: 'playing', hud: false, hudState: { cursor: false } };
  assert.equal(gameplayCrosshairVisible(project, state), true);
  state.worldTerminalActive = true;
  assert.equal(gameplayCrosshairVisible(project, state), false);
  state.worldTerminalActive = false; state.hudState.cursor = true;
  assert.equal(gameplayCrosshairVisible(project, state), false);
  state.hudState.cursor = false; state.gameScreen = 'pause';
  assert.equal(gameplayCrosshairVisible(project, state), false);
  state.gameScreen = 'playing'; state.hud = true;
  project.hud = { elements: [{ id: 'custom_aim', name: 'Crosshair', visible: true, opacity: 1, display: 'game' }] };
  assert.equal(gameplayCrosshairVisible(project, state), false);
  project.hud.elements[0].visible = false;
  assert.equal(gameplayCrosshairVisible(project, state), true);
});

test('terminal supports twelve unlocked controls without rendering an overlapping keypad', () => {
  const terminal = { ...MEDIA_NODE_DEFAULTS.terminal, buttons: Array.from({ length: 12 }, (_, index) => ({
    label: `Action ${index + 1}`, value: index + 1,
  })) };
  const document = fakeTerminalDocument();
  const ui = createWorldNodeObject(THREE, { terminal }, { document }).terminal;
  const { canvas } = ui;
  const variables = {};
  const clickAt = (x, y) => ui.hit(x / canvas.width, 1 - y / canvas.height, { variables });
  const digit = (value, x, y) => clickAt(x, y);
  digit('1', 90, 250); digit('2', 255, 250); digit('3', 420, 250); digit('4', 90, 288);
  document.labels.length = 0;
  assert.equal(clickAt(420, 364), true);
  assert.equal(ui.unlocked, true);
  assert.ok(!document.labels.some(label => ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Clear', 'Enter'].includes(label)));

  const padding = 18, actionTop = 157, columns = 3, rows = 4, gap = 9;
  const width = (canvas.width - padding * 3 - gap * (columns - 1)) / columns;
  const height = (canvas.height - padding - actionTop - gap * (rows - 1)) / rows;
  for (let index = 0; index < terminal.buttons.length; index++) {
    const row = Math.floor(index / columns), column = index % columns;
    const x = padding * 1.5 + column * (width + gap) + width / 2;
    const y = actionTop + row * (height + gap) + height / 2;
    assert.equal(clickAt(x, y), true);
    assert.equal(variables.terminalUnlocked, index + 1);
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function fakeAudioContext({ decode = async () => ({ duration: 10 }) } = {}) {
  const sources = [], gains = [], panners = [];
  const context = {
    currentTime: 0,
    listener: { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } },
    decodeAudioData: decode,
    createBufferSource() {
      const source = { loop: false, startCalls: [], stopCalls: 0, connect() {}, disconnect() {},
        start(...args) { this.startCalls.push(args); }, stop() { this.stopCalls++; } };
      sources.push(source); return source;
    },
    createGain() {
      const gain = { gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} };
      gains.push(gain); return gain;
    },
    createPanner() {
      const panner = { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
        connect() {}, disconnect() {} };
      panners.push(panner); return panner;
    },
  };
  return { context, sources, gains, panners };
}

test('world sounds decode, attenuate, loop, pause/resume at offset, and dispose native nodes', async () => {
  const project = { assets: [soundAsset()] }, fake = fakeAudioContext();
  const errors = [], destination = { connect() {} };
  const audio = createEntityAudioRuntime(project, fake.context, destination, message => errors.push(message));
  const entity = { id: 'speaker', name: 'Speaker', x: 500, y: 0, sound: { assetId: 'sound_a', autoplay: true, loop: true, volume: .8, radius: 1000 } };
  const state = { gameScreen: 'playing', entities: [entity], player: { x: 0, y: 0, z: 0 } };
  audio.update(state); await flush();
  assert.equal(fake.sources.length, 1);
  assert.equal(fake.sources[0].loop, true);
  assert.ok(Math.abs(fake.gains[0].gain.value - .4) < 1e-10);
  assert.equal(fake.panners[0].positionX.value, 500);
  fake.context.currentTime = 2;
  state.player.x = 1200; audio.update(state);
  assert.ok(Math.abs(fake.gains[0].gain.value - .24) < 1e-10);
  state.gameScreen = 'pause'; audio.update(state);
  assert.equal(fake.sources[0].stopCalls, 1);
  state.gameScreen = 'playing'; fake.context.currentTime = 3; audio.update(state); await flush();
  assert.equal(fake.sources[1].startCalls[0][1], 2, 'pause resumes from the preserved loop offset');
  state.player.x = 5000; audio.update(state);
  assert.equal(fake.sources[1].stopCalls, 1, 'out-of-range sources stop');
  state.entities = []; audio.update(state);
  assert.equal(audio.activeSources, 0);
  audio.dispose();
  assert.deepEqual(errors, []);
});

test('world sound decode failures are visible and reported once', async () => {
  const fake = fakeAudioContext({ decode: async () => { throw new Error('unsupported codec'); } });
  const errors = [];
  const audio = createEntityAudioRuntime({ assets: [soundAsset()] }, fake.context, {}, message => errors.push(message));
  const state = { gameScreen: 'playing', player: { x: 0, y: 0 }, entities: [
    { id: 'speaker', x: 0, y: 0, sound: { assetId: 'sound_a', autoplay: true, radius: 100 } },
  ] };
  audio.update(state); await flush();
  audio.update(state); await flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unsupported codec/);
  audio.dispose();
});
