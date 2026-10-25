import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { PNG } from 'pngjs';
import { readPackageArchive, readLocalPackage, packageLibrary, inspectPackage, importPackage, localWadBytes } from '../server/packages.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { createProject, validateProject } from '../shared/project.js';
import { wavSound } from '../shared/sound.js';

function archive(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes, options = {}] of entries) {
    const filename = Buffer.from(name), method = options.method ?? 8;
    const packed = method === 0 ? bytes : deflateRawSync(bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(options.flags || 0, 8); directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(options.crc ?? crc32(bytes), 16); directory.writeUInt32LE(packed.length, 20);
    directory.writeUInt32LE(options.size ?? bytes.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(options.attributes || 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, packed); central.push(directory, filename);
    offset += header.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function wad(lumps) {
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
  return bytes;
}
function mapWad(marker = 'ROOMONE') {
  const things = Buffer.alloc(10); things.writeUInt16LE(1, 6); things.writeUInt16LE(7, 8);
  const vertices = Buffer.alloc(16), lines = Buffer.alloc(56);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], index) => {
    vertices.writeInt16LE(x, index * 4); vertices.writeInt16LE(y, index * 4 + 2);
    lines.writeUInt16LE(index, index * 14); lines.writeUInt16LE((index + 1) % 4, index * 14 + 2);
    lines.writeUInt16LE(65535, index * 14 + 12);
  });
  const side = Buffer.alloc(30); side.write('WALL', 20);
  const sector = Buffer.alloc(26); sector.writeInt16LE(128, 2); sector.write('STONE', 4); sector.write('STONE', 12);
  return wad([[marker, Buffer.alloc(0)], ['THINGS', things], ['LINEDEFS', lines], ['SIDEDEFS', side],
    ['VERTEXES', vertices], ['SECTORS', sector]]);
}
const png = () => PNG.sync.write({ width: 2, height: 2, data: Buffer.from(Array(4).fill([255, 40, 10, 255]).flat()) });
const base = () => wad([['PLAYPAL', Buffer.alloc(768, 100)]]);
test('per-package MENUDEF and menu artwork translate into editable game-specific menu controls', async () => {
  const files = await readPackageArchive(archive([...entries(), ['menudef', Buffer.from(`
ListMenu "MainMenu"
{
  Position 30, 40
  PatchItem "MYLOGO", "n", "SkillMenu"
  TextItem "Game-specific settings", "o", "CustomOptions"
}
OptionMenu "CustomOptions"
{
  Slider "Effects", "snd_sfxvolume", 0, 1, 0.1
  Command "Unsupported command", "unknown_command"
}`)], ['graphics/mylogo.png', png()]]));
  assert.ok(files.has('menudef'), 'extensionless definition is retained by the archive reader');
  const { project, warnings } = importPackage(files, { map: 'maps/room.wad#ROOMONE', baseBytes: base() });
  assert.ok(project.gameMenus.sources.some(source => source.name === 'menudef'));
  assert.ok(project.hud.elements.some(element => element.name === 'Game-specific settings'));
  assert.ok(project.hud.elements.some(element => element.name === 'MYLOGO' &&
    project.assets.find(asset => asset.id === element.assetId)?.name === 'MYLOGO'));
  assert.ok(warnings.some(warning => warning.includes('unknown_command')));
  assert.ok(project.events.some(event => event.condition.type === 'hudClicked' &&
    event.actions.some(action => action.type === 'adjustGameSetting')));
  validateProject(project);
});
test('PK3 and directory readers retain sound bytes; filename overrides bind native weapon effects and custom sounds remain editable', async t => {
  const wave = Buffer.from(wavSound(new Uint8Array(100).fill(128), 11025).split(',')[1], 'base64');
  const content = [...entries(), ['sounds/dspistol.wav', wave], ['sounds/custom/grunt.wav', wave], ['sndinfo', Buffer.from('grunt/attack sounds/custom/grunt')]];
  const zipped = await readPackageArchive(archive(content));
  assert.deepEqual(zipped.get('sounds/dspistol.wav').data, wave);
  const projectRoot = directory(t);
  for (const [path, bytes] of content) {
    const absolute = join(projectRoot, 'Game', path);
    mkdirSync(join(absolute, '..'), { recursive: true }); writeFileSync(absolute, bytes);
  }
  const unpacked = await readLocalPackage(projectRoot, 'Game');
  assert.deepEqual(unpacked.get('sounds/dspistol.wav').data, wave);
  for (const files of [zipped, unpacked]) {
    const { project, warnings } = importPackage(files, { map: 'auto', baseBytes: base() });
    const pistol = project.assets.find(asset => asset.kind === 'sound' && asset.name === 'DSPISTOL');
    assert.equal(pistol.generated, undefined); assert.equal(pistol.src, wavSound(new Uint8Array(100).fill(128), 11025));
    assert.ok(project.assets.some(asset => asset.kind === 'sound' && asset.name === 'GRUNT'));
    assert.ok(warnings.some(warning => warning.includes('SNDINFO')));
    validateProject(JSON.parse(JSON.stringify(project)));
  }
  zipped.get('sounds/dspistol.wav').data = Buffer.from('invalid wave data');
  assert.throws(() => importPackage(zipped, { map: 'auto', baseBytes: base() }), /Invalid.*wav/);
});
const entries = () => [['textures/wall.png', png()], ['flats/stone.png', png()], ['graphics/stbar.png', png()],
  ['maps/room.wad', mapWad()], ['zscript.txt', Buffer.from('not executed')]];
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'opendle-packages-'));
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}
test('PK3 reads stored/Deflate resources, classifies custom map markers and imports images without executing scripts', async () => {
  const files = await readPackageArchive(archive([...entries(), ['graphics/extra.png', png(), { method: 0 }]]));
  const inspection = inspectPackage(files);
  assert.equal(inspection.images.length, 4);
  assert.deepEqual(inspection.maps.map(map => [map.marker, map.format, map.supported]), [['ROOMONE', 'Doom', true]]);
  assert.ok(inspection.warnings.some(warning => /zscript/.test(warning)));
  const { assets } = importPackage(files, { paths: ['textures/wall.png', 'graphics/extra.png'] });
  assert.deepEqual(assets.map(asset => [asset.kind, asset.width, asset.height]), [['texture', 2, 2], ['sprite', 2, 2]]);
  const project = createProject(); project.assets = assets; validateProject(project);
});
test('classic PK3 map merges base IWAD palette and package PNG resources into editable geometry/HUD', async () => {
  const files = await readPackageArchive(archive(entries()));
  const { project, warnings } = importPackage(files, { map: 'maps/room.wad#ROOMONE', baseBytes: base() });
  validateProject(project);
  assert.equal(project.map.walls.length, 4);
  assert.ok(project.map.walls[0].right.middle);
  assert.ok(project.map.sectors[0].floorAsset);
  const floor = project.assets.find(asset => asset.id === project.map.sectors[0].floorAsset);
  assert.deepEqual([...PNG.sync.read(Buffer.from(floor.src.split(',')[1], 'base64')).data.subarray(0, 4)], [255, 40, 10, 255]);
  assert.ok(project.hud.elements.some(element => element.name === 'WAD status-bar artwork'));
  assert.ok(project.events.some(event => event.actions.some(action => action.type === 'selectWeapon')));
  assert.ok(warnings.some(warning => /Missing HUD/.test(warning)));
  assert.throws(() => importPackage(files, { map: 'maps/room.wad#ROOMONE' }), /PLAYPAL/);
});
test('automatic mod import chooses declared episode entry, title and base requirement without image selections', async () => {
  const files = await readPackageArchive(archive([...entries(),
    ['maps/titlemap.wad', mapWad('TITLEMAP')],
    ['gameinfo.txt', Buffer.from('StartupTitle="Example Mod"\nIWAD="DOOM2.WAD"')],
    ['mapinfo.txt', Buffer.from('// episode TITLEMAP\ninclude "episodes.txt"')],
    ['episodes.txt', Buffer.from('episode room { name="Main"; }\nmap room "Example" {}')],
  ]));
  const inspection = inspectPackage(files);
  assert.equal(inspection.game.title, 'Example Mod');
  assert.equal(inspection.game.requiredBase, 'DOOM2.WAD');
  assert.equal(inspection.game.entryMap, 'maps/room.wad#ROOMONE');
  const result = importPackage(files, { map: 'auto', baseBytes: base() });
  assert.equal(result.project.title, 'Example Mod');
  assert.equal(result.entry.path, 'maps/room.wad');
  assert.equal(result.entry.mapCount, 2);
  validateProject(result.project);
});
test('automatic mod import reports missing declared maps and cyclic metadata includes terminate', async () => {
  const files = await readPackageArchive(archive([...entries(),
    ['mapinfo.txt', Buffer.from('include "mapinfo.txt"\nepisode MISSING {}')],
  ]));
  assert.match(inspectPackage(files).game.entryError, /declares entry map MISSING/);
  assert.throws(() => importPackage(files, { map: 'auto', baseBytes: base() }), /declares entry map MISSING/);
  const assetsOnly = await readPackageArchive(archive([['textures/wall.png', png()]]));
  assert.throws(() => importPackage(assetsOnly, { map: 'auto' }), /needs a base game/);
});
test('UDMF package maps resolve long texture paths into valid native image IDs without losing fractional geometry', async () => {
  const text = `namespace="zdoom";
    ${[[-128.25, -128], [128.25, -128], [128.25, 128], [-128.25, 128]].map(([x, y]) => `vertex{x=${x};y=${y};}`).join('')}
    sector{heightceiling=128;texturefloor="textures/nested/wall.png";}
    sidedef{sector=0;texturemiddle="nested/wall";}
    ${[0, 1, 2, 3].map(i => `linedef{v1=${i};v2=${(i + 1) % 4};sidefront=0;}`).join('')}
    thing{x=0;y=0;type=1;}`;
  const files = await readPackageArchive(archive([
    ['textures/nested/wall.png', png()], ['maps/room.wad', wad([['ROOM', Buffer.alloc(0)], ['TEXTMAP', Buffer.from(text)], ['ENDMAP', Buffer.alloc(0)]])],
  ]));
  const { project } = importPackage(files, { map: 'maps/room.wad#ROOM', baseBytes: base() });
  assert.equal(project.map.vertices[0].x, -128.25);
  assert.ok(project.map.sectors[0].floorAsset);
  assert.ok(project.map.walls[0].right.middle);
  assert.equal(project.importSource.format, 'udmf');
  validateProject(project);
});
test('UDMF maps are enabled for native geometry import while binary Hexen maps remain explicitly rejected', async () => {
  const files = await readPackageArchive(archive([
    ['maps/custom.wad', wad([['CUSTOM', Buffer.alloc(0)], ['TEXTMAP', Buffer.from('namespace="zdoom";')], ['ENDMAP', Buffer.alloc(0)]])],
    ['maps/hexen.wad', wad([['MAP01', Buffer.alloc(0)], ['THINGS', Buffer.alloc(20)], ['BEHAVIOR', Buffer.alloc(0)]])],
    ['textures/wall.png', png()],
  ]));
  const inspection = inspectPackage(files);
  assert.deepEqual(inspection.maps.map(map => map.format), ['UDMF', 'Hexen']);
  assert.equal(inspection.maps[0].supported, true); assert.equal(inspection.maps[1].supported, false);
  assert.throws(() => importPackage(files, { map: inspection.maps[1].id }), /Hexen.*not supported/);
  assert.equal(importPackage(files, { paths: ['textures/wall.png'] }).assets.length, 1);
});
test('PK3 validation rejects traversal, duplicate paths, symlinks, encryption, CRC corruption and expansion bombs', async () => {
  for (const entry of [
    ['../textures/a.png', png()], ['textures\\a.png', png()],
    ['textures/a.png', png(), { flags: 1 }], ['textures/a.png', png(), { method: 99 }],
    ['textures/a.png', png(), { attributes: 0xa0000000 }],
    ['textures/a.png', png(), { crc: 0 }], ['textures/a.png', png(), { size: 129 * 1024 * 1024 }],
  ]) await assert.rejects(readPackageArchive(archive([entry])));
  await assert.rejects(readPackageArchive(archive([['textures/A.png', png()], ['textures/a.png', png()]])), /Duplicate/);
  await assert.rejects(readPackageArchive(Buffer.from('not a zip')));
  const files = await readPackageArchive(archive([...entries(), ['textures/nested/wall.png', png()]]));
  const result = importPackage(files, { map: 'maps/room.wad#ROOMONE', baseBytes: base() });
  assert.ok(result.warnings.some(warning => /WALL.*replaces/.test(warning)));
});
test('package image validation checks selection, PNG dimensions/CRC, legacy palettes and signed PNG offsets', async () => {
  const bytes = png(), chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8); chunk.write('grAb', 4); chunk.writeInt32BE(-5, 8); chunk.writeInt32BE(3, 12);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
  const withOffsets = Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
  const patch = Buffer.alloc(18);
  patch.writeUInt16LE(1); patch.writeUInt16LE(1, 2); patch.writeInt16LE(-2, 4); patch.writeInt16LE(3, 6);
  patch.writeUInt32LE(12, 8); patch[13] = 1; patch[15] = 5; patch[17] = 255;
  const files = await readPackageArchive(archive([['sprites/testa0.png', withOffsets], ['graphics/legacy.png', patch],
    ['flats/legacy.lmp', Buffer.alloc(4096, 5)],
    ['graphics/bad.jpg', Buffer.from([255, 216, 255])]]));
  const image = importPackage(files, { paths: ['sprites/testa0.png'] }).assets[0];
  assert.equal(image.offsetX, -5); assert.equal(image.offsetY, 3);
  for (const paths of [[], ['missing'], ['sprites/testa0.png', 'sprites/testa0.png']])
    assert.throws(() => importPackage(files, { paths }), /Select|Unknown/);
  assert.throws(() => importPackage(files, { paths: ['graphics/legacy.png'] }), /base IWAD/);
  const legacy = importPackage(files, { paths: ['graphics/legacy.png', 'flats/legacy.lmp'], baseBytes: base() }).assets;
  assert.deepEqual(legacy.map(asset => [asset.width, asset.height, asset.offsetX, asset.offsetY]), [[1, 1, -2, 3], [64, 64, 0, 0]]);
  assert.deepEqual([...PNG.sync.read(Buffer.from(legacy[0].src.split(',')[1], 'base64')).data], [100, 100, 100, 255]);
  assert.throws(() => importPackage(files, { paths: ['graphics/bad.jpg'] }), /Unsupported/);
  const huge = Buffer.from(bytes); huge.writeUInt32BE(2049, 16);
  const largeFiles = await readPackageArchive(archive([['textures/huge.png', huge]]));
  assert.throws(() => importPackage(largeFiles, { paths: ['textures/huge.png'] }), /dimensions/);
});
test('local library discovers nested PK3s, unpacked packages and base WADs without following symlinks', async t => {
  const root = directory(t);
  mkdirSync(join(root, 'bundle')); mkdirSync(join(root, 'unpacked/textures'), { recursive: true });
  writeFileSync(join(root, 'bundle/mod.pk3'), archive(entries())); writeFileSync(join(root, 'bundle/base.wad'), base());
  writeFileSync(join(root, 'unpacked/textures/wall.png'), png());
  symlinkSync(root, join(root, 'link'));
  const library = packageLibrary(root);
  assert.deepEqual(library.packages.map(item => item.name), ['bundle/mod.pk3', 'unpacked']);
  assert.deepEqual(library.wads, ['bundle/base.wad']);
  assert.equal(inspectPackage(await readLocalPackage(root, 'unpacked')).images.length, 1);
  assert.deepEqual(localWadBytes(root, 'bundle/base.wad'), base());
  await assert.rejects(readLocalPackage(root, '../escape'), /Unsafe/);
  await assert.rejects(readLocalPackage(root, 'link/unpacked'), /symlinks/);
  symlinkSync(join(root, 'bundle/base.wad'), join(root, 'unpacked/textures/link.lmp'));
  await assert.rejects(readLocalPackage(root, 'unpacked'), /symlinks/);
});
test('authenticated HTTP supports local/upload inspection, image batches and classic map import without mutating saved project', async t => {
  const root = directory(t), bytes = archive(entries());
  writeFileSync(join(root, 'mod.pk3'), bytes); writeFileSync(join(root, 'base.wad'), base());
  const store = new ProjectStore(), { app } = createApp({ store, token: 'package-test', projectsDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer package-test', 'Content-Type': 'application/json' };
  const json = async (path, body) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  assert.equal((await fetch(`${url}/api/packages`)).status, 401);
  const inspection = await json('/api/packages/inspect', { name: 'mod.pk3' });
  const local = await json('/api/import/local-package', { name: 'mod.pk3', paths: ['textures/wall.png'] });
  const binary = { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' };
  const uploaded = await fetch(`${url}/api/packages/upload/inspect`, { method: 'POST', headers: binary, body: bytes });
  assert.deepEqual(await uploaded.json(), inspection);
  const batch = await fetch(`${url}/api/import/package?images=0`, { method: 'POST', headers: binary, body: bytes });
  assert.deepEqual((await batch.json()).assets, local.assets);
  const imported = await json('/api/import/local-package', { name: 'mod.pk3', map: inspection.maps[0].id, base: 'base.wad' });
  validateProject(imported.project);
  const uploadedMap = await fetch(`${url}/api/import/package?map=${encodeURIComponent(inspection.maps[0].id)}&base=base.wad`,
    { method: 'POST', headers: binary, body: bytes });
  assert.deepEqual((await uploadedMap.json()).project, imported.project);
  assert.equal(store.snapshot().revision, 0);
  assert.equal((await fetch(`${url}/api/import/package?images=nope`, { method: 'POST', headers: binary, body: bytes })).status, 400);
});
test('supplied Furdoom and Ascent packages expose UDMF geometry import and actual texture images', async () => {
  const root = new URL('../Projects/', import.meta.url).pathname;
  for (const [name, count] of [['Furdoom/furdoom_v0.1.1.pk3', 17], ['ascentoftitan-1-1', 12]]) {
    if (!existsSync(join(root, name))) continue;
    const files = await readLocalPackage(root, name), inspection = inspectPackage(files);
    assert.equal(inspection.maps.length, count);
    if (name === 'ascentoftitan-1-1') {
      assert.equal(inspection.game.requiredBase, 'DOOM2.WAD');
      assert.equal(inspection.game.entryMap, 'maps/map01.wad#MAP01');
      assert.equal(inspection.game.title, 'Ascent of Titan');
    }
    assert.ok(inspection.maps.every(map => map.format === 'UDMF' && map.supported));
    const paths = inspection.images.filter(path => path.startsWith('textures/') && path.endsWith('.png')).slice(0, 3);
    const imported = importPackage(files, { paths });
    const project = createProject(); project.assets = imported.assets; validateProject(project);
    assert.equal(project.assets.length, 3);
  }
});
