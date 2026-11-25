// "Put the maps in the Projects folder and press import" has to show the maps.
//
// The file picker only offers what the operating system gives it, so a folder of Quake and
// Half-Life maps looked empty: folders visible, files not. The studio now lists the folder itself,
// says what each file is, and imports both a `.map` source and a `.bsp` compiled from one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLocalMaps, readLocalMapFile, describeScan, bspInfo, bspEngine } from '../server/local-maps.js';
import { createZipArchive } from '../server/export-build.js';

/** A folder tree a test owns, cleaned up with the test. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'opendle-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
    return file;
  };
  return { root, write };
}

/** A BSP header of `version` with `lumps` empty lump directories, laid out like the real thing. */
function bspHeader(version, { magic = false, lumps = version >= 46 ? 17 : 15, trailing = 16 } = {}) {
  const directory = magic ? 8 : 4;
  const directoryEnd = directory + lumps * 8;
  const buffer = Buffer.alloc(directoryEnd + trailing);
  if (magic) buffer.write('IBSP', 0, 'latin1');
  buffer.writeInt32LE(version, magic ? 4 : 0);
  for (let index = 0; index < lumps; index++) {
    // Every lump sits after the directory, which is what a real header looks like.
    buffer.writeInt32LE(directoryEnd, directory + index * 8);
    buffer.writeInt32LE(index === 0 ? trailing : 0, directory + index * 8 + 4);
  }
  return buffer;
}

const MAP_TEXT = '{ "classname" "worldspawn" }\n';

test('a compiled BSP is identified by its version, and a file that is not one is not called one', () => {
  assert.equal(bspInfo(bspHeader(30)).engine, 'Half-Life');
  assert.equal(bspInfo(bspHeader(46)).engine, 'Quake 3');
  // Quake 2 and Quake 3 files start with the ASCII magic `IBSP` and put the version after it.
  assert.equal(bspInfo(bspHeader(46, { magic: true }))?.engine, 'Quake 3');
  assert.equal(bspInfo(bspHeader(38, { magic: true, lumps: 19 }))?.engine, 'Quake 2');
  assert.equal(bspEngine(29), 'Quake');
  assert.equal(bspEngine(38), 'Quake 2');
  assert.equal(bspEngine(31), null, 'an unknown version is not a BSP this engine knows');
  assert.equal(bspInfo(Buffer.from('not a bsp at all')), null);
  // A version that matches but whose lump directory points outside the file is not a BSP either.
  const broken = bspHeader(30);
  broken.writeInt32LE(999999, 4);
  assert.equal(bspInfo(broken), null);
});

test('the folder is listed: both a .map source and a compiled map are importable', async t => {
  const { root, write } = scratch(t);
  write('Maps/Half-Life/crossfire.bsp', bspHeader(30));
  write('Maps/Quake/quarry.map', MAP_TEXT);
  write('Maps/notes.txt', 'not a map');
  write('.hidden/secret.map', MAP_TEXT);
  const scan = await scanLocalMaps(root);
  const byPath = new Map(scan.entries.map(entry => [entry.path, entry]));
  assert.deepEqual([...byPath.keys()].sort(), ['Maps/Half-Life/crossfire.bsp', 'Maps/Quake/quarry.map'],
    'map files at any depth, no hidden folders, no other files');
  assert.equal(byPath.get('Maps/Quake/quarry.map').importable, true);
  const compiled = byPath.get('Maps/Half-Life/crossfire.bsp');
  assert.equal(compiled.importable, true);
  assert.equal(compiled.kind, 'bsp');
  assert.equal(compiled.holds, 'bsp');
  assert.equal(compiled.engine, 'Half-Life');
  assert.match(compiled.detail, /Half-Life BSP v30/);
  assert.match(compiled.detail, /imports as brushes/);
  // Sources come first, then compiled maps: the list is for acting on.
  assert.equal(scan.entries[0].path, 'Maps/Quake/quarry.map');
  assert.match(describeScan(scan), /2 map files .*2 importable, 1 compiled map/);
});

test('an archive is listed for the map inside it, and only when it holds one', async t => {
  const { root, write } = scratch(t);
  const source = createZipArchive([{ path: 'maps/quarry.map', data: Buffer.from(MAP_TEXT) }], new Date('2026-01-01T00:00:00Z'));
  write('Maps/source-pack.zip', source);
  const compiled = createZipArchive([{ path: 'maps/13hell.bsp', data: bspHeader(46) }], new Date('2026-01-01T00:00:00Z'));
  write('Maps/Quake/map-13hell.pk3', compiled);
  // A Doom mod's pk3 holds neither, and burying the maps under it is what made the list useless.
  write('Maps/brightmaps.pk3', createZipArchive([{ path: 'textures/x.png', data: Buffer.from('x') }], new Date('2026-01-01T00:00:00Z')));
  const scan = await scanLocalMaps(root);
  const byPath = new Map(scan.entries.map(entry => [entry.path, entry]));
  assert.deepEqual([...byPath.keys()].sort(), ['Maps/Quake/map-13hell.pk3', 'Maps/source-pack.zip']);
  assert.equal(byPath.get('Maps/source-pack.zip').importable, true);
  assert.equal(byPath.get('Maps/source-pack.zip').entry, 'maps/quarry.map');
  assert.match(byPath.get('Maps/source-pack.zip').detail, /maps\/quarry\.map/);
  // A pk3 around a compiled map is that map, and the row says which game it is for.
  const packed = byPath.get('Maps/Quake/map-13hell.pk3');
  assert.equal(packed.importable, true);
  assert.equal(packed.holds, 'bsp');
  assert.equal(packed.entry, 'maps/13hell.bsp');
  assert.match(packed.detail, /maps\/13hell\.bsp — Quake 3 BSP v46/);
});

test('a map is read from the folder, and from inside a .pk3, without a file dialog', async t => {
  const { root, write } = scratch(t);
  write('Maps/Quake/quarry.map', MAP_TEXT);
  write('Maps/Half-Life/crossfire.bsp', bspHeader(30));
  write('Maps/source-pack.zip', createZipArchive([
    { path: 'maps/quarry.map', data: Buffer.from(MAP_TEXT) },
    { path: 'maps/shared.bsp', data: bspHeader(46) },
  ], new Date('2026-01-01T00:00:00Z')));
  assert.deepEqual(await readLocalMapFile(root, 'Maps/Quake/quarry.map'), { kind: 'map', name: 'quarry.map', text: MAP_TEXT });
  assert.equal((await readLocalMapFile(root, 'Maps/source-pack.zip', 'maps/quarry.map')).text, MAP_TEXT);
  // A compiled map comes back as bytes for the BSP reader, whichever way it was stored.
  const packed = await readLocalMapFile(root, 'Maps/source-pack.zip', 'maps/shared.bsp');
  assert.equal(packed.kind, 'bsp');
  assert.equal(bspInfo(packed.bytes).version, 46);
  assert.equal((await readLocalMapFile(root, 'Maps/Half-Life/crossfire.bsp')).kind, 'bsp');
  // The path is not a way out of the Projects folder, and not a way to read anything else.
  await assert.rejects(() => readLocalMapFile(root, '../outside.map'), /outside the Projects folder/);
  // Asking for an entry out of a plain `.map` is a caller mistake, and it says which file it could
  // not open rather than failing somewhere deeper.
  await assert.rejects(() => readLocalMapFile(root, 'Maps/Quake/quarry.map', 'maps/quarry.map'), /has no readable maps\/quarry\.map/);
  await assert.rejects(() => readLocalMapFile(root, 'Maps/source-pack.zip', 'maps/missing.map'), /has no readable maps\/missing\.map/);
});

test('a scan with nothing in it says so instead of failing', async t => {
  const { root } = scratch(t);
  const scan = await scanLocalMaps(root);
  assert.deepEqual(scan.entries, []);
  assert.match(describeScan(scan), /^0 map files/);
});
