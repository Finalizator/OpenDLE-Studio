import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { morphEntity, unmorphEntity, tickMorphs } from '../shared/morph.js';
import { parseCameraTextures, bindCameraTexture } from '../shared/cameratextures.js';
import { ACTIONS } from '../shared/actor-runtime.js';

function actor(id, name, { health = 100, radius = 20, height = 56, sprite = 'MONS' } = {}) {
  return { id, name, flags: { MONSTER: true }, health, radius, height,
    states: { labels: { Spawn: 0 }, frames: [
      { kind: 'frame', sprite, letter: 'A', duration: 4, actions: [], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
    ] } };
}

function morphProject() {
  const project = createProject();
  project.events = [];
  project.actors = [actor('actor_imp', 'DoomImp'), actor('actor_pig', 'Pig', { health: 30, radius: 16, height: 32, sprite: 'PIGS' })];
  project.assets = ['MONSA0', 'PIGSA0'].map(name => ({ id: `asset_${name}`, name, kind: 'sprite',
    width: 24, height: 24, offsetX: 12, offsetY: 24, src: 'data:image/png;base64,iVBORw0KGgo=' }));
  project.map.entities.push({ id: 'imp1', name: 'Imp', type: 'enemy', doomType: 3001, x: 64, y: 64, angle: 0,
    health: 100, actorId: 'actor_imp', actorName: 'DoomImp', spriteAsset: 'asset_MONSA0' });
  return project;
}

test('a morph swaps the actor, keeps the entity and restores it on unmorph', () => {
  const project = morphProject();
  const state = createRuntime(project);
  const imp = state.entities.find(entity => entity.id === 'imp1');
  imp.health = 50;
  assert.equal(imp.spriteAsset, 'asset_MONSA0');

  assert.equal(morphEntity(project, state, imp, 'Pig'), true);
  assert.equal(imp.id, 'imp1', 'the entity object is reused so ids and bodies stay valid');
  assert.equal(imp.actorName, 'Pig');
  assert.equal(imp.actorId, 'actor_pig');
  assert.equal(imp.maxHealth, 30);
  assert.equal(imp.health, 15, 'health keeps its ratio');
  assert.equal(imp.radius, 16);
  assert.equal(imp.spriteAsset, 'asset_PIGSA0', 'the morphed actor supplies the frames');
  assert.ok(imp.morph, 'what was replaced is remembered');

  assert.equal(unmorphEntity(project, state, imp), true);
  assert.equal(imp.actorName, 'DoomImp');
  assert.equal(imp.health, 50);
  assert.equal(imp.maxHealth, 100);
  assert.equal(imp.spriteAsset, 'asset_MONSA0');
  assert.equal(imp.morph, null);
  assert.equal(unmorphEntity(project, state, imp), false, 'unmorphing twice is a no-op');
  assert.equal(morphEntity(project, state, imp, 'NoSuchActor'), false);
});

test('a timed morph expires on its own and a corpse is not restored', () => {
  const project = morphProject();
  const state = createRuntime(project);
  const imp = state.entities.find(entity => entity.id === 'imp1');
  morphEntity(project, state, imp, 'Pig', { duration: 35 });
  for (let frame = 0; frame < 20; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(imp.actorName, 'Pig', 'still morphed before the duration is up');
  for (let frame = 0; frame < 25; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(imp.actorName, 'DoomImp', 'the morph expired');

  morphEntity(project, state, imp, 'Pig', { duration: 35 });
  imp.health = 0;
  state.time += 5;
  tickMorphs(project, state);
  assert.equal(imp.actorName, 'Pig', 'a dead morph stays dead until forced');
  assert.equal(unmorphEntity(project, state, imp, true), true);
  assert.equal(imp.actorName, 'DoomImp');
});

test('morphing the player changes what the engine models and restores it', () => {
  const project = morphProject();
  const state = createRuntime(project);
  const player = state.entities.find(entity => entity.type === 'player');
  state.playerStats.health = 100;
  state.inventory.weapons.add('shotgun');
  state.inventory.selectedWeapon = 'shotgun';
  assert.equal(morphEntity(project, state, player, 'Pig', { duration: 35 }), true);
  assert.equal(state.playerStats.health, 30);
  assert.equal(state.playerMorph.name, 'Pig');
  tickMorphs(project, state);
  assert.equal(state.playerMorph.name, 'Pig', 'the duration has not run out yet');
  state.time += 4;
  tickMorphs(project, state);
  assert.equal(state.playerStats.health, 100, 'health comes back');
  assert.equal(state.inventory.selectedWeapon, 'shotgun');
  assert.equal(state.playerMorph, null);
});

test('the A_Morph and A_UnMorphActor actions drive the same morph', async () => {
  const project = morphProject();
  const state = createRuntime(project);
  const imp = state.entities.find(entity => entity.id === 'imp1');
  const ctx = { project, state, entity: imp, actor: project.actors[0], args: ['"Pig"', 0, 0], named: {} };
  ACTIONS.A_Morph(ctx);
  assert.equal(imp.actorName, 'Pig');
  ACTIONS.A_UnMorphActor({ ...ctx, args: [0, 1] });
  assert.equal(imp.actorName, 'DoomImp');
});

test('camera textures are declared by ANIMDEFS and bound to a camera thing', () => {
  const defs = parseCameraTextures([
    '// camera feeds\ncameratexture SECCAM 128 96\ncameratexture DARK 256 256 fit worldpanning\n' +
    'cameratexture seccam 64 64 // the later definition wins\n',
  ]);
  assert.deepEqual(defs.find(definition => definition.name === 'SECCAM'),
    { name: 'SECCAM', width: 64, height: 64, fit: false, worldPanning: false });
  assert.deepEqual(defs.find(definition => definition.name === 'DARK'),
    { name: 'DARK', width: 256, height: 256, fit: true, worldPanning: true });

  const project = createProject();
  project.events = [];
  project.cameraTextures = defs;
  project.map.entities.push({ id: 'cam1', name: 'Camera', type: 'decoration', tid: 7, x: 128, y: 64, angle: 90, elevation: 0 });
  validateProject(project);
  const state = createRuntime(project);
  assert.equal(bindCameraTexture(project, state, 7, 'seccam', 110), true, 'names are case-insensitive');
  assert.deepEqual(state.cameraTextures.get('SECCAM'), { cameraId: 'cam1', fov: 110 });
  assert.equal(bindCameraTexture(project, state, 7, 'NOPE', 90), false, 'an undeclared texture is refused');
  assert.equal(bindCameraTexture(project, state, 99, 'DARK', 90), false, 'an unknown camera is refused');

  const invalid = structuredClone(project);
  invalid.cameraTextures.push({ name: 'TOO_LONG_NAME', width: 64, height: 64 });
  assert.throws(() => validateProject(invalid), /camera texture name/i);
});

function importWad(lumps) {
  const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
  const bytes = Buffer.alloc(directory + lumps.length * 16);
  bytes.write('PWAD'); bytes.writeUInt32LE(lumps.length, 4); bytes.writeUInt32LE(directory, 8);
  let offset = 12;
  lumps.forEach(([name, data], index) => {
    data.copy(bytes, offset);
    const entry = directory + index * 16;
    bytes.writeUInt32LE(offset, entry); bytes.writeUInt32LE(data.length, entry + 4); bytes.write(name, entry + 8, 8);
    offset += data.length;
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('importing a map with ANIMDEFS reserves camera textures as editable assets', async () => {
  const { importWadMap, readWad } = await import('../shared/wad.js');
  const { encodeImage } = await import('../server/import.js');
  const things = Buffer.alloc(10); things.writeUInt16LE(1, 6); things.writeUInt16LE(7, 8);
  const vertices = Buffer.alloc(16), lines = Buffer.alloc(56);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], index) => {
    vertices.writeInt16LE(x, index * 4); vertices.writeInt16LE(y, index * 4 + 2);
    lines.writeUInt16LE(index, index * 14); lines.writeUInt16LE((index + 1) % 4, index * 14 + 2);
    lines.writeUInt16LE(65535, index * 14 + 12);
  });
  const sector = Buffer.alloc(26); sector.writeInt16LE(128, 2);
  const buffer = importWad([['MAP01', Buffer.alloc(0)], ['THINGS', things], ['LINEDEFS', lines],
    ['SIDEDEFS', Buffer.alloc(30)], ['VERTEXES', vertices], ['SECTORS', sector],
    ['PLAYPAL', Buffer.alloc(768, 100)],
    ['ANIMDEFS', Buffer.from('cameratexture MONITOR 192 128 fit\n')]]);
  const { project, warnings } = importWadMap(readWad(buffer), 'MAP01', { encodeImage, actors: false });
  validateProject(project);
  assert.deepEqual(project.cameraTextures, [{ name: 'MONITOR', width: 192, height: 128, fit: true, worldPanning: false }]);
  const surface = project.assets.find(asset => asset.name === 'MONITOR');
  assert.ok(surface, 'the camera surface is an editable texture asset');
  assert.equal(surface.camera, true);
  assert.deepEqual([surface.width, surface.height], [192, 128]);
  assert.match(warnings.join('\n'), /1 camera texture\(s\) declared/);
});

test('a morph and a camera binding survive saving and loading', async () => {
  const { captureGameSave, restoreGameSave, gameSaveIdentity } = await import('../shared/save-game.js');
  const project = morphProject();
  project.cameraTextures = [{ name: 'MONITOR', width: 64, height: 64, fit: false, worldPanning: false }];
  project.map.entities.push({ id: 'cam1', name: 'Camera', type: 'decoration', tid: 7, x: 0, y: 0, angle: 0, elevation: 32 });
  validateProject(project);
  const identity = await gameSaveIdentity(project);
  const state = createRuntime(project);
  const imp = state.entities.find(entity => entity.id === 'imp1');
  morphEntity(project, state, imp, 'Pig', { duration: 350 });
  assert.equal(bindCameraTexture(project, state, 7, 'MONITOR', 100), true);
  const record = captureGameSave(project, state, identity);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(record)), identity);
  const loaded = restored.runtime.entities.find(entity => entity.id === 'imp1');
  assert.equal(loaded.actorName, 'Pig', 'the morph is part of the save');
  assert.ok(loaded.morph, 'and so is what it will restore');
  assert.deepEqual([...restored.runtime.cameraTextures], [['MONITOR', { cameraId: 'cam1', fov: 100 }]]);
});
