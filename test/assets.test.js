import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ShapeUtils, Vector2 } from 'three';
import { decodePatch, decodeFlat, patchNames, textureDefinitions, composeTexture } from '../shared/doom-assets.js';
import { sectorGeometry, sectorAt, sectorShapes, containsPoint } from '../shared/sectors.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { applyTool, jsonSchemaForTool, toolDefinitions } from '../server/tools.js';
import { encodeImage, importWad } from '../server/import.js';
import { ProjectStore } from '../server/store.js';
import { proposeChanges } from '../server/deepseek.js';

const palette = Uint8Array.from({ length: 768 }, (_, index) => Math.floor(index / 3));
function patchFixture() {
  const buffer = Buffer.alloc(25);
  buffer.writeUInt16LE(1, 0); buffer.writeUInt16LE(4, 2);
  buffer.writeInt16LE(-3, 4); buffer.writeInt16LE(4, 6); buffer.writeUInt32LE(12, 8);
  buffer.set([1, 2, 0, 10, 20, 0, 3, 1, 0, 30, 0, 255], 12);
  return buffer;
}
test('Doom patch posts decode palette colors, transparency and signed offsets', () => {
  const result = decodePatch(patchFixture(), palette);
  assert.deepEqual([result.width, result.height, result.offsetX, result.offsetY], [1, 4, -3, 4]);
  assert.deepEqual([...result.pixels], [0, 0, 0, 0, 10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255]);
  const png = PNG.sync.read(Buffer.from(encodeImage(result).split(',')[1], 'base64'));
  assert.equal(png.width, 1); assert.deepEqual([...png.data], [...result.pixels]);
});
test('patch reader rejects corrupt offsets, overflows, unterminated columns and oversized images', () => {
  for (const change of [
    buffer => buffer.writeUInt32LE(200, 8),
    buffer => buffer.writeUInt32LE(8, 8),
    buffer => { buffer[13] = 100; },
    buffer => { buffer[12] = 4; },
    buffer => { buffer[23] = 0; buffer[24] = 0; },
    buffer => buffer.writeUInt16LE(2049, 0),
  ]) {
    const buffer = patchFixture(); change(buffer);
    assert.throws(() => decodePatch(buffer, palette));
  }
  assert.throws(() => decodePatch(new Uint8Array(6), palette), /Truncated/);
});
test('tall patches resolve relative top deltas and retain transparent gaps', () => {
  const buffer = Buffer.alloc(23);
  buffer.writeUInt16LE(1, 0); buffer.writeUInt16LE(300, 2); buffer.writeUInt32LE(12, 8);
  buffer.set([200, 1, 0, 10, 0, 20, 1, 0, 30, 0, 255], 12);
  const result = decodePatch(buffer, palette);
  assert.equal(result.pixels[200 * 4], 10);
  assert.equal(result.pixels[220 * 4], 30);
  assert.equal(result.pixels[219 * 4 + 3], 0);
});
test('flats use first palette and require exact 64x64 bounds', () => {
  const flat = decodeFlat(new Uint8Array(4096).fill(60), palette);
  assert.deepEqual([flat.width, flat.height], [64, 64]);
  assert.deepEqual([...flat.pixels.slice(0, 4)], [60, 60, 60, 255]);
  assert.throws(() => decodeFlat(new Uint8Array(4095), palette), /4096/);
});
test('PNAMES/TEXTURE tables validate records and composite signed patch placements', () => {
  const names = Buffer.alloc(12); names.writeUInt32LE(1); names.write('PATCH', 4);
  assert.deepEqual(patchNames(names), ['PATCH']);
  const table = Buffer.alloc(40);
  table.writeUInt32LE(1); table.writeUInt32LE(8, 4); table.write('WALL', 8);
  table.writeUInt16LE(2, 20); table.writeUInt16LE(2, 22); table.writeUInt16LE(1, 28);
  table.writeInt16LE(1, 30); table.writeInt16LE(-1, 32);
  const [definition] = textureDefinitions(table, patchNames(names));
  const result = composeTexture(definition, name => {
    assert.equal(name, 'PATCH'); return decodePatch(patchFixture(), palette);
  });
  assert.deepEqual([...result.pixels.slice(4, 8)], [10, 10, 10, 255]);
  assert.deepEqual([...result.pixels.slice(12, 16)], [20, 20, 20, 255]);
  assert.equal(result.pixels[3], 0);
  assert.throws(() => textureDefinitions(table, []), /PNAMES/);
  table.writeUInt32LE(400, 4);
  assert.throws(() => textureDefinitions(table, ['PATCH']), /offset/);
  names.writeUInt32LE(1000);
  assert.throws(() => patchNames(names), /count/);
});
function imageAsset(id = 'image') {
  return { id, name: 'Synthetic', kind: 'flat', width: 1, height: 1,
    src: encodeImage({ width: 1, height: 1, pixels: Uint8Array.from([250, 80, 20, 255]) }) };
}
test('project visuals are portable and persistence retains assets, sectors, skybox and lights', () => {
  const project = createProject(); project.assets = [imageAsset()];
  project.map.sectors[0].floorAsset = 'image';
  project.map.entities[1].spriteAsset = 'image';
  project.map.entities.push({ id: 'light', name: 'Test lamp', type: 'light', x: 100, y: 100, angle: 0,
    light: { color: '#ffaa22', radius: 128, intensity: 1 } });
  project.environment.skybox = Object.fromEntries(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(face => [face, 'image']));
  validateProject(project);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  const directory = mkdtempSync(join(tmpdir(), 'opendle-assets-'));
  try {
    const path = join(directory, 'project.json');
    new ProjectStore(path).update(project, 0);
    assert.deepEqual(new ProjectStore(path).snapshot().project, project);
  } finally { rmSync(directory, { recursive: true }); }
});
test('visual validation rejects missing references, unsafe sources, invalid dimensions and excessive light', () => {
  for (const change of [
    project => { project.assets[0].src = 'https://remote.example/texture.png'; },
    project => { project.assets[0].width = 9000; },
    project => { project.map.sectors[0].floorAsset = 'missing'; },
    project => { project.map.sectors[0].light = 256; },
    project => { project.map.walls[0].right.middle = 'missing'; },
    project => { project.map.walls[0].right.sectorId = 'missing'; },
    project => { project.map.entities[1].spriteAsset = 'missing'; },
    project => { project.environment.weaponAsset = 'missing'; },
    project => { project.environment.skybox = { px: 'image' }; },
  ]) {
    const project = createProject(); project.assets = [imageAsset()]; change(project);
    assert.throws(() => validateProject(project));
  }
  const project = createProject();
  for (let i = 0; i < 17; i++) project.map.entities.push({ id: `light${i}`, name: 'Lamp', type: 'light', x: i, y: 0, angle: 0,
    light: { color: '#ffffff', radius: 128, intensity: 1 } });
  assert.throws(() => validateProject(project), /16 dynamic/);
});
test('sector boundaries deduplicate coincident vertices/edges but reject new open boundaries', () => {
  const project = createProject();
  const [sector] = sectorGeometry(project);
  assert.equal(sector.rings[0].length, 4);
  assert.equal(sectorAt([sector], 0, 0).id, 'room0');
  assert.equal(sectorAt([sector], 5000, 5000), undefined);
  project.map.vertices.push({ id: 'duplicate', x: -384, y: -256 });
  project.map.walls[0].a = 'duplicate';
  project.map.walls.push({ ...structuredClone(project.map.walls[0]), id: 'duplicateWall' });
  assert.equal(sectorGeometry(project)[0].rings[0].length, 4);
  project.map.walls = project.map.walls.filter(wall => wall.id !== 'w3');
  assert.throws(() => sectorGeometry(project), /open boundary/);
});
test('sector floor triangulation preserves holes and disjoint islands', () => {
  const ring = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
  const rings = [ring(0, 0, 100), ring(25, 25, 50), ring(200, 200, 20)];
  assert.equal(containsPoint(rings, 10, 10), true);
  assert.equal(containsPoint(rings, 50, 50), false);
  assert.equal(containsPoint(rings, 210, 210), true);
  let area = 0;
  for (const shape of sectorShapes(rings)) {
    const outer = shape.outer.map(point => new Vector2(point.x, point.y));
    const holes = shape.holes.map(ring => ring.map(point => new Vector2(point.x, point.y)));
    const triangles = ShapeUtils.triangulateShape(outer, holes);
    const points = [...outer, ...holes.flat()];
    for (const indices of triangles) {
      const [a, b, c] = indices.map(index => points[index]);
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    }
  }
  assert.equal(area, 10000 - 2500 + 400);
});
function portalProject(step = 16, ceiling = 128) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [
    { id: 'a', x: -128, y: -128 }, { id: 'b', x: 0, y: -128 }, { id: 'c', x: 0, y: 128 },
    { id: 'd', x: -128, y: 128 }, { id: 'e', x: 128, y: -128 }, { id: 'f', x: 128, y: 128 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [['a', 'b', 's0'], ['b', 'c', 's0', 's1'], ['c', 'd', 's0'], ['d', 'a', 's0'],
    ['b', 'e', 's1'], ['e', 'f', 's1'], ['f', 'c', 's1']].map(([a, b, front, back], i) => ({
    id: `wall${i}`, a, b, height: 128, color: '#888888', solid: !back, right: side(front), ...(back ? { left: side(back) } : {}),
  }));
  project.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
    { id: 's1', floorHeight: step, ceilingHeight: ceiling, light: 128, sky: false },
  ];
  project.map.entities[0].x = -40; project.map.entities[0].y = 0;
  validateProject(project);
  return project;
}
test('movement passes reachable portals but respects steps, headroom, closed and inverted doors', () => {
  for (const [height, ceiling, pass] of [[16, 128, true], [24, 128, true], [25, 128, false], [0, 55, false], [0, 0, false], [16, 0, false]]) {
    const project = portalProject(height, ceiling), state = createRuntime(project);
    for (let i = 0; i < 20; i++) stepRuntime(project, state, .05, new Set(['KeyW']));
    assert.equal(state.player.x > 0, pass, `step ${height} ceiling ${ceiling}`);
  }
});
test('new material/sector tools validate atomically and expose nullable provider schemas', () => {
  const project = createProject(); project.assets = [imageAsset()];
  const changed = applyTool(project, 'sector_update', { id: 'room0', light: 80, floorAsset: 'image' }).project;
  assert.equal(changed.map.sectors[0].light, 80); assert.equal(project.map.sectors[0].light, 208);
  assert.equal(applyTool(project, 'entity_set_visual', { id: 'pickup', spriteAsset: 'image' }).project.map.entities[1].spriteAsset, 'image');
  assert.throws(() => applyTool(project, 'entity_set_visual', { id: 'pickup', light: { color: '#ffffff', radius: 30, intensity: 1 } }), /Only light/);
  assert.throws(() => applyTool(project, 'sector_update', { id: 'room0', floorAsset: 'missing' }), /unknown asset/);
  const environment = applyTool(project, 'environment_set_visuals', { skyAsset: 'image', weaponAsset: 'image' }).project.environment;
  assert.equal(environment.skyAsset, 'image');
  const schema = jsonSchemaForTool(toolDefinitions.find(tool => tool.name === 'environment_set_visuals'));
  assert.deepEqual(schema.properties.skyAsset.anyOf, [{ type: 'string' }, { type: 'null' }]);
});
test('DeepSeek receives image metadata, not base64, and replacement drafts retain embedded images', async () => {
  const project = createProject(); project.assets = [imageAsset()];
  let calls = 0;
  const result = await proposeChanges({ project, prompt: 'Rename', apiKey: 'key', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(options.body.includes('data:image/png'), false);
    const summary = JSON.parse(request.messages[1].content).project;
    summary.title = 'Renamed with assets';
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'replacement', type: 'function', function: { name: 'project_replace', arguments: JSON.stringify({ project: summary }) } }] }
      : { role: 'assistant', content: 'Renamed.' } }] }) };
  } });
  assert.equal(result.project.title, 'Renamed with assets');
  assert.deepEqual(result.project.assets, project.assets);
});
const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
test('real Freedoom MAP01 imports bounded portable textures, sectors, skies, sprites, weapons and light', { skip: !existsSync(freedoom) }, () => {
  const { project, warnings } = importWad(readFileSync(freedoom), 'MAP01');
  validateProject(project);
  assert.equal(project.map.sectors.length, 130);
  assert.equal(project.map.walls.length, 653);
  const images = project.assets.filter(asset => asset.kind !== 'sound');
  assert.ok(images.length >= 200 && images.length < 1000);
  assert.ok(project.assets.filter(asset => asset.kind === 'sound').length > 90);
  for (const kind of ['texture', 'flat', 'sky', 'sprite', 'weapon']) assert.ok(project.assets.some(asset => asset.kind === kind), kind);
  const spawn = project.map.entities.find(entity => entity.type === 'player');
  assert.equal(sectorAt(sectorGeometry(project), spawn.x, spawn.y).floorHeight, 0);
  assert.ok(project.map.entities.some(entity => entity.light));
  assert.ok(project.environment.weaponAsset);
  assert.ok(JSON.stringify(project).length < 6 * 1024 * 1024);
  for (const asset of images) {
    const png = PNG.sync.read(Buffer.from(asset.src.split(',')[1], 'base64'));
    assert.equal(png.width, asset.width); assert.equal(png.height, asset.height);
  }
  assert.ok(!warnings.some(warning => /Missing (texture|flat|sprite)/.test(warning)));
});
