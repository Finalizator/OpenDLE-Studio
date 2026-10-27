import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { PNG } from 'pngjs';
import { readPackageArchive, readLocalPackage, packageLibrary, inspectPackage, importPackage, localWadBytes } from '../server/packages.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { createProject, validateProject } from '../shared/project.js';
import { wavSound, encodeSound } from '../shared/sound.js';
import { selectGameLevel } from '../shared/game-levels.js';
import { importActors, actorIndex } from '../shared/actors.js';

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
function mapWad(marker = 'ROOMONE', withPalette = false) {
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
    ['VERTEXES', vertices], ['SECTORS', sector], ...(withPalette ? [['PLAYPAL', Buffer.alloc(768, 100)]] : [])]);
}
const png = () => PNG.sync.write({ width: 2, height: 2, data: Buffer.from(Array(4).fill([255, 40, 10, 255]).flat()) });
const base = () => wad([['PLAYPAL', Buffer.alloc(768, 100)]]);
test('PK3 and directory FON2 fonts drive both MENUDEF and SBARINFO with portable glyph metrics', async t => {
  const font = Buffer.from([70, 79, 78, 50, 2, 0, 65, 66, 1, 0, 1, 0, 1, 0, 0, 0, 0, 255, 90, 30, 1, 1, 0, 255, 1]);
  const source = [...entries(), ['dbigfont.fon2', font], ['graphics/cursor01.png', png()],
    ['menudef', Buffer.from(`DefaultListMenu {
      Font "BigFont", "Untranslated"
      Selector "CURSOR01", -10, -2
    }
    ListMenu "MainMenu" {
      Position 40, 60
      TextItem "AB", "a", "SkillMenu"
    }`)],
    ['sbarinfo', Buffer.from('statusbar normal { drawstring DBIGFONT, untranslated, "AB", 10, 180; }')]];
  const root = directory(t);
  for (const [path, bytes] of source) {
    const absolute = join(root, 'FontGame', path);
    mkdirSync(join(absolute, '..'), { recursive: true }); writeFileSync(absolute, bytes);
  }
  for (const files of [await readPackageArchive(archive(source)), await readLocalPackage(root, 'FontGame')]) {
    const { project } = importPackage(files, { map: 'auto', baseBytes: base() });
    validateProject(project);
    const menu = project.hud.elements.find(item => item.name === 'AB');
    const hud = project.hud.elements.find(item => item.text === 'AB' && !project.gameMenus.elementIds.includes(item.id));
    const menuFont = project.hud.fonts.find(font => font.id === menu.fontId);
    const hudFont = project.hud.fonts.find(font => font.id === hud.fontId);
    assert.equal(menuFont.type, 'bitmap'); assert.equal(hudFont.type, 'bitmap');
    assert.equal(menuFont.assetId, hudFont.assetId);
    assert.deepEqual(menuFont.widths, [1, 1]);
    assert.deepEqual([hud.width, hud.height], [2, 2]);
    assert.equal(project.assets.filter(asset => asset.id === menuFont.assetId).length, 1);
    assert.ok(project.hud.elements.some(item => item.menuSelector));
  }
});
test('custom SBARINFO loads from WAD, PK3 and directories with extensionless relative includes', async t => {
  const content = [...entries(), ['SBARINFO', Buffer.from('#include "ui/entry"')],
    ['ui/entry', Buffer.from('#include "layout.custom"')],
    ['ui/layout.custom', Buffer.from('height 20; statusbar normal { drawimage "stbar", 0, 180; ininventory BlueCard { drawnumber 3, HUDFONT_DOOM, untranslated, health, 90, 180; } }')]];
  const root = directory(t);
  for (const [path, bytes] of content) {
    const absolute = join(root, 'Custom', path);
    mkdirSync(join(absolute, '..'), { recursive: true }); writeFileSync(absolute, bytes);
  }
  const zipped = await readPackageArchive(archive(content)), local = await readLocalPackage(root, 'Custom');
  for (const files of [zipped, local]) {
    assert.ok(files.get('ui/entry').data); assert.ok(files.get('ui/layout.custom').data);
    const { project } = importPackage(files, { map: 'auto', baseBytes: base() });
    assert.equal(project.hud.reserveBottom, 20);
    assert.deepEqual(project.hud.sources.map(source => source.name), ['sbarinfo', 'ui/entry', 'ui/layout.custom']);
    assert.ok(project.events.some(event => event.conditions?.some(condition => condition.type === 'keyOwned')));
    assert.equal(project.hud.elements.filter(element => !project.gameMenus.elementIds.includes(element.id)).length, 2);
    validateProject(JSON.parse(JSON.stringify(project)));
  }
  const { importWadMap, readWad } = await import('../shared/wad.js');
  const { encodeImage } = await import('../server/import.js');
  const combined = wad([['PLAYPAL', Buffer.alloc(768, 100)], ['SBARINFO', Buffer.from('#include "CUSTOM"')],
    ['CUSTOM', Buffer.from('statusbar normal { drawnumber 3, HUDFONT_DOOM, untranslated, health, 90, 180; }')]]);
  const resource = readWad(combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.length), { allowNoMaps: true });
  const mapBytes = mapWad(), map = readWad(mapBytes.buffer.slice(mapBytes.byteOffset, mapBytes.byteOffset + mapBytes.length));
  const bytes = Buffer.concat([Buffer.from(map.buffer), Buffer.from(resource.buffer)]);
  const imported = importWadMap({ buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    maps: map.maps, lumps: [...map.lumps, ...resource.lumps.map(lump => ({ ...lump, start: lump.start + map.buffer.byteLength }))] },
  'ROOMONE', { encodeImage });
  assert.ok(imported.project.hud.sources.some(source => source.name === 'WAD:CUSTOM'));
  assert.ok(imported.project.hud.elements.some(element => element.binding === 'health'));
  zipped.set('ui/entry', { size: 30, data: Buffer.from('#include "../outside"') });
  assert.throws(() => importPackage(zipped, { map: 'auto', baseBytes: base() }), /Unsafe package entry/);
});
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
  const root = mkdtempSync(join(process.cwd(), '.opendle-packages-'));
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}
test('DECORATE and ZSCRIPT includes are read, so included monsters and weapons exist', async t => {
  const content = [...entries(),
    ['DECORATE', Buffer.from('#include "actors/monsters.txt"\n#include "actors/weapons.txt"')],
    ['actors/monsters.txt', Buffer.from('actor IncludedImp : DoomImp 3005 { Health 90\n States { Spawn: TROO A 10 A_Look\n loop } }')],
    ['actors/weapons.txt', Buffer.from('#include "actors/weapons2.txt"')],
    ['actors/weapons2.txt', Buffer.from('actor IncludedShotgun : Shotgun 5101 { AmmoType "Shell" }')]];
  const { project } = importPackage(await readPackageArchive(archive(content)), { map: 'auto', baseBytes: base() });
  const names = project.actors.map(actor => actor.name);
  assert.ok(names.includes('IncludedImp'), 'a monster from an included file is imported');
  assert.ok(names.includes('IncludedShotgun'), 'and so is a weapon included from two levels deep');
  const imp = project.actors.find(actor => actor.name === 'IncludedImp');
  assert.equal(imp.doomedNum, 3005);
  // A missing include is reported instead of silently dropping the rest.
  const broken = [...entries(), ['DECORATE', Buffer.from('#include "actors/missing.txt"')]];
  const { project: partial, warnings } = importPackage(await readPackageArchive(archive(broken)), { map: 'auto', baseBytes: base() });
  assert.ok(warnings.some(warning => /#include "actors\/missing.txt" was not found/.test(warning)));
  assert.ok(partial.actors.length > 0, 'the import still succeeds with classic actors');
});
test('a replacement actor takes over the editor number of the class it replaces', () => {
  const sources = [{ name: 'DECORATE', text: 'actor FastZombie : ZombieMan replaces ZombieMan { Speed 12 }' }];
  const { actors, warnings } = importActors({ sources });
  const replacement = actors.find(actor => actor.name === 'FastZombie');
  assert.equal(replacement.doomedNum, 3004, 'thing 3004 spawns the replacement');
  assert.equal(replacement.replaces, 'ZombieMan');
  assert.ok(warnings.some(warning => /took over the editor number/.test(warning)));
  const index = actorIndex(actors);
  assert.equal(index.byDoomed.get(3004).name, 'FastZombie', 'the replaced class no longer owns the number');
});
test('flats of any square palette size decode, including modern 128 and 256 pixel ones', async () => {
  const { decodeFlat, flatSize } = await import('../shared/doom-assets.js');
  const palette = new Uint8Array(768).map((value, index) => index % 256);
  for (const size of [32, 64, 128, 256]) {
    const image = decodeFlat(new Uint8Array(size * size), palette);
    assert.deepEqual([image.width, image.height], [size, size]);
    assert.equal(image.pixels.length, size * size * 4);
    assert.equal(flatSize(new Uint8Array(size * size)), size);
  }
  assert.equal(flatSize(new Uint8Array(1000)), null);
  assert.throws(() => decodeFlat(new Uint8Array(1000), palette), /square palette image/);
  // A 128x128 flat used by a map imports as a 128x128 flat, not as garbage or a
  // missing-texture placeholder.
  const { importWadMap, readWad } = await import('../shared/wad.js');
  const { encodeImage } = await import('../server/import.js');
  const things = Buffer.alloc(10); things.writeUInt16LE(1, 6); things.writeUInt16LE(7, 8);
  const vertices = Buffer.alloc(16), lines = Buffer.alloc(56);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], index) => {
    vertices.writeInt16LE(x, index * 4); vertices.writeInt16LE(y, index * 4 + 2);
    lines.writeUInt16LE(index, index * 14); lines.writeUInt16LE((index + 1) % 4, index * 14 + 2);
    lines.writeUInt16LE(65535, index * 14 + 12);
  });
  const side = Buffer.alloc(30); side.write('BIGFLAT', 20);
  const sector = Buffer.alloc(26); sector.writeInt16LE(128, 2); sector.write('BIGFLAT', 4); sector.write('BIGFLAT', 12);
  const bytes = wad([['ROOMONE', Buffer.alloc(0)], ['THINGS', things], ['LINEDEFS', lines], ['SIDEDEFS', side],
    ['VERTEXES', vertices], ['SECTORS', sector], ['PLAYPAL', Buffer.alloc(768, 100)],
    ['F_START', Buffer.alloc(0)], ['BIGFLAT', Buffer.alloc(16384, 7)], ['F_END', Buffer.alloc(0)]]);
  const { project } = importWadMap(readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), 'ROOMONE', { encodeImage });
  const flat = project.assets.find(asset => asset.kind === 'flat' && asset.name === 'BIGFLAT');
  assert.ok(flat, 'the 128x128 flat was imported');
  assert.deepEqual([flat.width, flat.height], [128, 128]);
});
test('a TEXTURES definition composes a wall texture out of package patches', async () => {
  const solid = (width, height, [red, green, blue]) => PNG.sync.write({ width, height,
    data: Buffer.from(Array(width * height).fill([red, green, blue, 255]).flat()) });
  const source = [...entries(),
    ['TEXTURES', Buffer.from('// mod wall textures\nTexture "WALL", 4, 4 { Patch "PATCHA", 0, 0 Patch "PATCHB", 2, 0 }\n'
      + 'WallTexture "STEEL", 2, 4, XScale 2 { Patch "PATCHB", 0, 0 }\n')],
    ['patches/patcha.png', solid(2, 4, [255, 0, 0])],
    ['patches/patchb.png', solid(2, 4, [0, 0, 255])]];
  const { project } = importPackage(await readPackageArchive(archive(source)), { map: 'auto', baseBytes: base() });
  const wall = project.assets.find(asset => asset.kind === 'texture' && asset.name === 'WALL');
  assert.ok(wall, 'the TEXTURES defined wall texture was imported');
  assert.deepEqual([wall.width, wall.height], [4, 4]);
  const pixels = PNG.sync.read(Buffer.from(wall.src.split(',')[1], 'base64')).data;
  const at = (x, y) => [...pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [255, 0, 0, 255], 'the left half is the first patch');
  assert.deepEqual(at(3, 3), [0, 0, 255, 255], 'the right half is the patch placed at x=2');
  // A definition the map never uses stays lazy, and flat/sprite variants are accepted.
  assert.ok(!project.assets.some(asset => asset.name === 'STEEL'), 'unused textures are not composed');
});
test('pk7 and pke archives are offered, and a folder of only flats or patches is a package', async t => {
  const root = directory(t);
  writeFileSync(join(root, 'mod.pk7'), archive(entries()));
  writeFileSync(join(root, 'addon.pke'), archive(entries()));
  mkdirSync(join(root, 'PatchPack', 'patches'), { recursive: true });
  writeFileSync(join(root, 'PatchPack', 'patches', 'wall.png'), png());
  mkdirSync(join(root, 'FlatPack', 'flats'), { recursive: true });
  writeFileSync(join(root, 'FlatPack', 'flats', 'stone.png'), png());
  const library = packageLibrary(root);
  const names = library.packages.map(entry => `${entry.name}:${entry.type}`);
  assert.ok(names.includes('mod.pk7:pk3'), 'pk7 archives are listed');
  assert.ok(names.includes('addon.pke:pk3'), 'pke archives are listed');
  assert.ok(names.includes('PatchPack:directory'), 'a patches-only folder is a resource package');
  assert.ok(names.includes('FlatPack:directory'), 'a flats-only folder is a resource package');
  const files = await readPackageArchive(archive(entries()));
  assert.ok(files.get('textures/wall.png'), 'the archive still reads');
});
test('IPK3 standalone libraries inspect and import all packaged maps without unrelated base levels', async t => {
  const root = directory(t);
  const content = [...entries().filter(([path]) => !path.startsWith('maps/')),
    ['maps/map01.wad', mapWad('MAIN01')]];
  writeFileSync(join(root, 'game.ipk3'), archive(content));
  assert.deepEqual(packageLibrary(root).packages, [{ name: 'game.ipk3', type: 'pk3', standalone: true }]);
  const files = await readLocalPackage(root, 'game.ipk3');
  const inspection = inspectPackage(files);
  assert.equal(inspection.game.standalone, true);
  const { project, entry } = importPackage(files, { map: 'auto', fullGame: true,
    baseBytes: mapWad('MAP02', true) });
  assert.deepEqual(project.game.levels.map(level => level.id), ['MAP01']);
  assert.equal(entry.mapCount, 1);
  validateProject(project);
});
test('ClearEpisodes in included MAPINFO bounds campaigns while ordinary classic mods retain base maps', async () => {
  const content = [...entries().filter(([path]) => !path.startsWith('maps/')),
    ['maps/map01.wad', mapWad('MAIN01')], ['mapinfo', Buffer.from('include "metadata/campaign"')],
    ['metadata/campaign', Buffer.from('ClearEpisodes\nEpisode MAP01 { Name = "Standalone" }')]];
  const files = await readPackageArchive(archive(content));
  const options = { map: 'auto', fullGame: true, baseBytes: mapWad('MAP02', true) };
  const result = importPackage(files, options);
  assert.deepEqual(result.project.game.levels.map(level => level.id), ['MAP01']);
  files.delete('mapinfo'); files.delete('metadata/campaign');
  assert.deepEqual(importPackage(files, options).project.game.levels.map(level => level.id), ['MAP02', 'MAP01']);
});
test('standalone campaigns retain explicitly routed base destinations and reject unplayable maps without omission', async () => {
  const files = await readPackageArchive(archive([...entries().filter(([path]) => !path.startsWith('maps/')),
    ['maps/map01.wad', mapWad('MAIN01')],
    ['mapinfo', Buffer.from('ClearEpisodes\nEpisode MAP01 { Name = "Game" }\nMap MAP01 { Next = "MAP02" }')]]));
  files.standalone = true;
  const options = { map: 'auto', fullGame: true, baseBytes: mapWad('MAP02', true) };
  const result = importPackage(files, options);
  assert.deepEqual(result.project.game.levels.map(level => level.id), ['MAP01', 'MAP02']);
  assert.equal(result.project.game.levels[0].next, 'MAP02');
  const unsupported = wad([['BADMAP', Buffer.alloc(0)], ['THINGS', Buffer.alloc(0)],
    ['BEHAVIOR', Buffer.alloc(0)], ['LINEDEFS', Buffer.alloc(0)], ['SIDEDEFS', Buffer.alloc(0)],
    ['VERTEXES', Buffer.alloc(0)], ['SECTORS', Buffer.alloc(0)]]);
  files.set('maps/badmap.wad', { data: unsupported, size: unsupported.length });
  // Hexen format is read now, so a Hexen map with no real geometry fails as an
  // unplayable map (no player start) instead of being rejected as a format.
  assert.throws(() => importPackage(files, options), /Missing or malformed|exceeds|no player-one start/);
});
test('full package imports preserve large cutscene Ogg audio within explicit portable budgets', async () => {
  const bytes = Buffer.alloc(6_248_896); bytes.write('OggS');
  const files = await readPackageArchive(archive([...entries(), ['sounds/cutscene/final.ogg', bytes]]));
  const { project } = importPackage(files, { map: 'auto', fullGame: true, baseBytes: base() });
  const sound = project.assets.find(asset => asset.name === 'FINAL' && asset.kind === 'sound');
  assert.equal(Buffer.from(sound.src.split(',')[1], 'base64').length, bytes.length);
  validateProject(project);
  assert.throws(() => encodeSound(Buffer.alloc(8 * 1024 * 1024 + 1, 79), 'ogg'), /maximum 8 MiB/);
  assert.throws(() => encodeSound(Buffer.from('not an ogg stream'), 'ogg'), /Invalid/);
});
test('full package imports retain filename-based maps even with duplicate internal markers and declared routing', async t => {
  const content = [...entries().filter(([path]) => !path.startsWith('maps/')),
    ['maps/first.wad', mapWad('WRONG')], ['maps/second.wad', mapWad('WRONG')],
    ['mapinfo', Buffer.from('episode FIRST { name = "Game" }\ninclude "metadata/episodes"\nmap FIRST "First room" { next = "SECOND" }\nmap SECOND { next = EndGameC }')],
    ['metadata/episodes', Buffer.from('episode SECOND { name = "Second campaign" }')],
    ['menudef', Buffer.from('ListMenu "EpisodeMenu" {\nPosition 32, 64\nLineSpacing 20\n}\nListMenu "SkillMenu" {\nPosition 32, 64\n}')]];
  const root = directory(t);
  for (const [path, bytes] of content) {
    const absolute = join(root, 'Game', path);
    mkdirSync(join(absolute, '..'), { recursive: true }); writeFileSync(absolute, bytes);
  }
  for (const files of [await readPackageArchive(archive(content)), await readLocalPackage(root, 'Game')]) {
    const { project, entry } = importPackage(files, { map: 'auto', baseBytes: base(), fullGame: true });
    assert.deepEqual(project.game.levels.map(level => level.id), ['FIRST', 'SECOND']);
    assert.equal(entry.map, 'FIRST'); assert.equal(project.game.entry, 'FIRST');
    assert.equal(project.game.levels[0].next, 'SECOND'); assert.equal(project.game.levels[1].next, null);
    assert.deepEqual(project.gameMenus.episodes.map(episode => episode.levelId), ['FIRST', 'SECOND']);
    assert.ok(project.hud.elements.some(item => item.name === 'Second campaign' && item.interactive));
    assert.ok(project.hud.elements.some(item => item.name === 'Hurt me plenty' && item.interactive));
    selectGameLevel(project, 'SECOND'); validateProject(project);
    assert.equal(project.game.active, 'SECOND');
  }
});
test('PK3 reads stored/Deflate resources, classifies custom map markers and imports images without executing scripts', async () => {
  const files = await readPackageArchive(archive([...entries(), ['graphics/extra.png', png(), { method: 0 }]]));
  const inspection = inspectPackage(files);
  assert.equal(inspection.images.length, 4);
  assert.deepEqual(inspection.maps.map(map => [map.marker, map.format, map.supported]), [['ROOMONE', 'Doom', true]]);
  assert.ok(inspection.warnings.some(warning => /zscript/i.test(warning)),
    'actor definitions are imported as data and the limitation is reported');
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
  // Without a base IWAD there is no palette; this package is all PNG art, so it still
  // imports completely instead of failing on a palette it never needed.
  const withoutBase = importPackage(files, { map: 'maps/room.wad#ROOMONE' });
  assert.equal(withoutBase.project.map.walls.length, 4);
  assert.ok(withoutBase.project.map.walls[0].right.middle, 'package PNG art resolves without a palette');
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
test('UDMF and Hexen-format maps both import natively from a package', async () => {
  const files = await readPackageArchive(archive([
    ['maps/custom.wad', wad([['CUSTOM', Buffer.alloc(0)], ['TEXTMAP', Buffer.from('namespace="zdoom";')], ['ENDMAP', Buffer.alloc(0)]])],
    ['maps/hexen.wad', wad([['MAP01', Buffer.alloc(0)], ['THINGS', Buffer.alloc(20)], ['BEHAVIOR', Buffer.alloc(0)]])],
    ['textures/wall.png', png()],
  ]));
  const inspection = inspectPackage(files);
  assert.deepEqual(inspection.maps.map(map => map.format), ['UDMF', 'Hexen']);
  assert.equal(inspection.maps[0].supported, true);
  assert.equal(inspection.maps[1].supported, true, 'a binary Hexen map is importable now');
  assert.ok(inspection.warnings.some(warning => /Binary Hexen-format maps import natively/.test(warning)));
  // The fixture has a BEHAVIOR lump but no geometry, so it fails on the record layout
  // rather than on a format rejection.
  assert.throws(() => importPackage(files, { map: inspection.maps[1].id }), /Missing or malformed/);
  assert.equal(importPackage(files, { paths: ['textures/wall.png'] }).assets.length, 1);
});
test('PK3 validation rejects traversal, duplicate paths, symlinks, CRC corruption and expansion bombs', async () => {
  for (const entry of [
    ['../textures/a.png', png()], ['textures\\a.png', png()],
    ['textures/a.png', png(), { attributes: 0xa0000000 }],
    ['textures/a.png', png(), { crc: 0 }], ['textures/a.png', png(), { size: 129 * 1024 * 1024 }],
  ]) await assert.rejects(readPackageArchive(archive([entry])));
  // Entries this reader cannot decompress are skipped by name rather than failing the
  // archive: a mod with one LZMA or encrypted file still imports the rest.
  for (const [entry, label] of [[['textures/a.png', png(), { flags: 1 }], 'encrypted'],
    [['textures/a.png', png(), { method: 12 }], 'compression method 12']]) {
    const skipped = await readPackageArchive(archive([entry, ['textures/b.png', png()]]));
    assert.equal(skipped.get('textures/a.png').data, undefined, `${label} entries carry no data`);
    assert.ok(skipped.get('textures/b.png').data, 'the readable entry is kept');
    assert.ok(skipped.skippedEntries.some(name => name.includes(label)));
  }
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
  const huge = Buffer.from(bytes); huge.writeUInt32BE(4097, 16);
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
  writeFileSync(join(root, 'standalone.ipk3'), bytes);
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
  const standaloneInspection = await json('/api/packages/inspect', { name: 'standalone.ipk3' });
  assert.equal(standaloneInspection.game.standalone, true);
  const standalone = await json('/api/import/local-package', { name: 'standalone.ipk3', map: 'auto', base: 'base.wad' });
  assert.deepEqual(standalone.project.game.levels.map(level => level.id), ['ROOM']);
  validateProject(standalone.project);
  const local = await json('/api/import/local-package', { name: 'mod.pk3', paths: ['textures/wall.png'] });
  const binary = { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' };
  const uploaded = await fetch(`${url}/api/packages/upload/inspect`, { method: 'POST', headers: binary, body: bytes });
  assert.deepEqual(await uploaded.json(), inspection);
  const batch = await fetch(`${url}/api/import/package?images=0`, { method: 'POST', headers: binary, body: bytes });
  assert.deepEqual((await batch.json()).assets, local.assets);
  const imported = await json('/api/import/local-package', { name: 'mod.pk3', map: inspection.maps[0].id, base: 'base.wad' });
  validateProject(imported.project);
  assert.equal(imported.project.game.levels.length, 1);
  const uploadedMap = await fetch(`${url}/api/import/package?map=${encodeURIComponent(inspection.maps[0].id)}&base=base.wad&images=`,
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
