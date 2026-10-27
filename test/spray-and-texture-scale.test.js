import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { wallQuadUv, flatUv } from '../shared/uv.js';
import { parseUDMF, udmfRecords } from '../shared/udmf.js';
import { installScriptlet, ENGINE_SCRIPTLETS } from '../shared/scriptlets.js';

test('surface texture scale changes how much map space one tile covers', () => {
  const tile = { textureWidth: 64, textureHeight: 64 };
  // A 64-unit floor spans exactly one tile at scale 1 and half a tile at scale 2.
  assert.deepEqual(flatUv(64, 64, tile), [1, 1]);
  assert.deepEqual(flatUv(64, 64, { ...tile, scale: 2 }), [.5, .5]);
  assert.deepEqual(flatUv(64, 64, { ...tile, scale: .5 }), [2, 2]);
  const wall = { length: 128, bottom: 0, top: 64, referenceTop: 64, ...tile };
  assert.deepEqual(wallQuadUv(wall), [0, 0, 2, 0, 2, 1, 0, 1]);
  assert.deepEqual(wallQuadUv({ ...wall, scale: 2 }), [0, .5, 1, .5, 1, 1, 0, 1]);
  // Offsets stay in texels of the unscaled artwork, so scaling does not move a seam.
  const shifted = wallQuadUv({ ...wall, offsetX: 32, offsetY: 16, scale: 2 });
  assert.deepEqual(shifted, [.25, .375, 1.25, .375, 1.25, .875, .25, .875]);
});

test('texture scale is validated per sector and per wall side', () => {
  const project = createProject();
  validateProject(project);
  project.map.sectors[0].textureScale = 2;
  project.map.walls[0].right.textureScale = .5;
  validateProject(project);
  for (const bad of [0, -1, 100, '2']) {
    project.map.sectors[0].textureScale = bad;
    assert.throws(() => validateProject(project), /Surface texture scale/);
  }
  delete project.map.sectors[0].textureScale;
  project.map.walls[0].right.textureScale = 0;
  assert.throws(() => validateProject(project), /Wall texture scale/);
});

test('UDMF x/y texture scales import as one uniform surface scale', () => {
  const document = parseUDMF([
    'namespace = "zdoom";',
    'sector { texturefloor = "FLOOR1"; xscale = 2.0; yscale = 2.0; }',
    'sector { texturefloor = "FLOOR1"; }',
    'sidedef { sector = 0; texturemiddle = "WALL1"; scalex_mid = 0.5; scaley_mid = 0.5; }',
  ].join('\n'));
  const records = udmfRecords(document);
  assert.equal(records.sectors[0].textureScale, 2);
  assert.equal(records.sectors[1].textureScale, undefined, 'a default scale stays unset');
  assert.equal(records.sides[0].textureScale, .5);
});

function sprayProject() {
  const project = createProject();
  project.events = [];
  // A 512-unit room with the player at the centre facing +x; one image to spray.
  project.map.entities = project.map.entities.filter(entity => entity.type === 'player');
  project.map.entities[0].x = 0; project.map.entities[0].y = 0; project.map.entities[0].angle = 0;
  project.assets = [{ id: 'asset_spray', name: 'SPRAY', kind: 'sprite', width: 32, height: 16,
    offsetX: 0, offsetY: 0, src: 'data:image/png;base64,AA==' }];
  return project;
}

test('the spray scriptlet installs one editable key-pressed rule that paints a wall', async () => {
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  assert.ok(ENGINE_SCRIPTLETS.some(scriptlet => scriptlet.id === 'spray'));
  const project = sprayProject();
  installScriptlet(project, 'spray');
  validateProject(project);
  const sheet = project.eventSheets.find(sheet => sheet.name === 'Spray (CS-style)');
  assert.ok(sheet);
  const rule = project.events.find(event => event.sheetId === sheet.id);
  assert.equal(rule.condition.type, 'keyPressed');
  assert.equal(rule.condition.key, 'KeyT');
  assert.equal(rule.actions[0].type, 'sprayImage');
  assert.equal(rule.actions[0].assetId, 'asset_spray');
  // Both the binding and the artwork are ordinary editable values.
  rule.condition.key = 'KeyR'; rule.actions[0].assetId = 'asset_spray';
  validateProject(project);

  const state = createRuntime(project);
  // A solid wall 32 units in front of the player, in the direction they face.
  state.walls.push({ id: 'target', solid: true, start: { x: 32, y: -64 }, end: { x: 32, y: 64 } });
  stepRuntime(project, state, 1 / 35, new Set(), new Set(['KeyR']));
  const decal = state.impacts.find(effect => effect.decal);
  assert.ok(decal, 'a decal was added');
  assert.equal(decal.decal.assetId, 'asset_spray');
  assert.ok(Math.abs(decal.x - 32) < 1, `the decal sits on the wall, at x=${decal.x}`);
  assert.equal(decal.z, 48, 'it is painted at eye height on the wall when looking straight ahead');
  assert.ok(decal.until > state.time, 'it expires instead of piling up forever');
});

test('a spray with nothing in reach or no chosen image reports instead of guessing', async () => {
  const { createRuntime, stepRuntime } = await import('../shared/runtime.js');
  const { sprayTarget } = await import('../shared/spray.js');
  const project = sprayProject();
  installScriptlet(project, 'spray');
  const state = createRuntime(project);
  // No solid wall nearby: nothing to paint on.
  assert.equal(sprayTarget(state, 96), null);
  stepRuntime(project, state, 1 / 35, new Set(), new Set(['KeyT']));
  assert.equal(state.impacts.filter(effect => effect.decal).length, 0);

  // An image the project does not contain explains itself and never stops the game:
  // a spray is configuration, not a fatal condition.
  project.events.find(event => event.actions[0].type === 'sprayImage').actions[0].assetId = 'asset_missing';
  const next = createRuntime(project);
  next.walls.push({ id: 'wall', solid: true, start: { x: 32, y: -64 }, end: { x: 32, y: 64 } });
  stepRuntime(project, next, 1 / 35, new Set(), new Set(['KeyT']));
  assert.match(next.message, /is not in this project/);
  assert.equal(next.impacts.filter(effect => effect.decal).length, 0);
  // No artwork chosen at all: the event says so instead of failing.
  project.events.find(event => event.actions[0].type === 'sprayImage').actions[0].assetId = '';
  const unset = createRuntime(project);
  unset.walls.push({ id: 'wall', solid: true, start: { x: 32, y: -64 }, end: { x: 32, y: 64 } });
  stepRuntime(project, unset, 1 / 35, new Set(), new Set(['KeyT']));
  assert.match(unset.message, /Choose an image asset/);
});

test('the spray action offers every imported image by name', async () => {
  const { imageFieldOptions } = await import('../shared/engine-script.js');
  assert.deepEqual(imageFieldOptions([['asset_spray', 'SPRAY (sprite 32x16)']]),
    [['', 'Choose an image asset'], ['asset_spray', 'SPRAY (sprite 32x16)']]);
  // The field must exist and be a choice, or the dialog renders a free-text box.
  const { ENGINE_ACTIONS } = await import('../shared/engine-script.js');
  const action = ENGINE_ACTIONS.find(entry => entry.type === 'sprayImage');
  assert.equal(action.fields.find(field => field.name === 'assetId').kind, 'image');
  // The dialog has to forward the library it is given: omitting it silently produced
  // an empty picker.
  const source = readFileSync(new URL('../public/event-sheet.js', import.meta.url), 'utf8');
  assert.match(source, /openCommandDialog\(\{[^}]*images = \[\]/);
  assert.match(source, /commandFields\(draft, \{[^}]*images/);
});

test('a billboard sits with the artwork anchor on the entity, not centred on it', async () => {
  const { spriteAnchor } = await import('../shared/sprite-anchor.js');
  // Doom's POSSA1 is 41x55 with left 18 / top 50: feet 5 units under the anchor.
  const anchor = spriteAnchor({ width: 41, height: 55, offsetX: 18, offsetY: 50 });
  assert.equal(anchor.dy, 22.5);
  assert.ok(Math.abs(0 + anchor.dy - 55 / 2 - (-5)) < 1e-9, 'the quad bottom is 5 units below the anchor');
  const centred = spriteAnchor({ width: 64, height: 64, offsetX: 32, offsetY: 32 });
  assert.deepEqual(centred, { dx: 0, dy: 0 }, 'a centred artwork is not moved');
});
