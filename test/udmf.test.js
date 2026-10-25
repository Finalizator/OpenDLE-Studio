import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseUDMF, udmfRecords } from '../shared/udmf.js';
import { importWadMap, readWad } from '../shared/wad.js';
import { validateProject } from '../shared/project.js';
import { inspectPackage, readLocalPackage, importPackage, localWadBytes } from '../server/packages.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { ProjectStore } from '../server/store.js';
import { createApp } from '../server/index.js';
import { createPhysics } from '../shared/physics.js';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';

const source = `
namespace="zdoom";
custom_global="preserved";
vertex { x=-128.25; y=-128.5; }
vertex { x=128.75; y=-128.5; }
vertex { x=128.75; y=128.5; }
vertex { x=-128.25; y=128.5; }
sector { heightfloor=-4.5; heightceiling=128.25; texturefloor="-"; textureceiling="F_SKY1"; lightlevel=300; special=9; id=3; rotationfloor=45; }
sidedef { sector=0; offsetx=1.25; offsety=-2.5; texturemiddle="-"; }
linedef { v1=0; v2=1; sidefront=0; blocking=true; dontpegtop=true; special=80; arg0=1; }
linedef { v1=1; v2=2; sidefront=0; }
linedef { v1=2; v2=3; sidefront=0; }
linedef { v1=3; v2=0; sidefront=0; }
thing { x=0.25; y=-0.5; height=3.5; angle=90; type=1; }
thing { x=20.25; y=0; type=2011; single=true; skill4=true; }
thing { x=30; y=0; type=2012; single=false; skill4=true; }
`;
function map(text, extra = []) {
  const textBytes = Buffer.from(text), marker = 'CUSTOM';
  const lumps = [[marker, Buffer.alloc(0)], ['TEXTMAP', textBytes], ...extra, ['ENDMAP', Buffer.alloc(0)]];
  const directory = 12 + lumps.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  const buffer = Buffer.alloc(directory + lumps.length * 16);
  buffer.write('PWAD'); buffer.writeUInt32LE(lumps.length, 4); buffer.writeUInt32LE(directory, 8);
  let start = 12;
  for (const [index, [name, bytes]] of lumps.entries()) {
    bytes.copy(buffer, start);
    buffer.writeUInt32LE(start, directory + index * 16); buffer.writeUInt32LE(bytes.length, directory + index * 16 + 4);
    buffer.write(name, directory + index * 16 + 8); start += bytes.length;
  }
  return readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
}
test('UDMF parser handles comments, signed fractions/exponents/hex, strings, booleans, repeated fields and custom blocks', () => {
  const document = parseUDMF(`// comment
    namespace = "ZDoom"; /* block */
    vertex { x=-1.25e2; y=+0x10; user_label="a;{}\\\\b\\"c"; }
    custom { value=true; value=false; note="a\\nb\\t"; }`);
  assert.equal(document.namespace, 'zdoom');
  assert.deepEqual(document.blocks[0].properties, { x: -125, y: 16, user_label: 'a;{}\\b"c' });
  assert.equal(document.blocks[1].properties.value, false);
  assert.equal(document.blocks[1].properties.note, 'a\nb\t');
});
test('UDMF parser rejects malformed, executable, nested, excessive and prototype-like input', () => {
  for (const text of ['', 'namespace="unknown";', 'namespace="zdoom"; /*', 'namespace="zdoom"; vertex{x=eval(1);}',
    'namespace="zdoom"; vertex{x=1e999;}', 'namespace="zdoom"; vertex{x=1}',
    'namespace="zdoom"; vertex{child{}}', 'namespace="zdoom"; __proto__="x";',
    'namespace="zdoom"; vertex{constructor=true;}', 'namespace="zdoom"; x="unterminated'])
    assert.throws(() => parseUDMF(text), /UDMF/);
  assert.throws(() => parseUDMF(' '.repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
  assert.throws(() => parseUDMF(`namespace="zdoom";${'thing{}'.repeat(5001)}`), /limits/);
});
test('native UDMF import retains fractional geometry, sector heights, side offsets, blocking flags, elevations and source fields', () => {
  const { project, warnings } = importWadMap(map(source, [['BEHAVIOR', Buffer.from([0, 1, 2])]]), 'CUSTOM');
  validateProject(project);
  assert.deepEqual(project.map.vertices[0], { id: 'v0', x: -128.25, y: 128.5 });
  assert.equal(project.map.sectors[0].floorHeight, -4.5);
  assert.equal(project.map.sectors[0].ceilingHeight, 128.25);
  assert.equal(project.map.sectors[0].light, 255);
  assert.equal(project.map.sectors[0].sky, true);
  assert.equal(project.map.walls[0].right.offsetX, 1.25);
  assert.equal(project.map.walls[0].right.offsetY, -2.5);
  assert.equal(project.map.walls[0].flags, 9);
  assert.equal(project.map.entities[0].angle, -90);
  assert.equal(project.map.entities[0].elevation, 3.5);
  assert.equal(project.map.entities[0].y, 0.5);
  assert.equal(project.map.entities.length, 2);
  assert.equal(project.importSource.globals.custom_global, 'preserved');
  assert.equal(project.importSource.blocks.find(block => block.type === 'linedef').properties.arg0, 1);
  assert.ok(warnings.some(warning => warning.includes('sector.rotationfloor')));
  assert.ok(warnings.some(warning => warning.includes('ACS/dialogue')));
  assert.ok(warnings.some(warning => warning.includes('lightlevel')));
  const store = new ProjectStore(); store.update(project, 0);
  const saved = store.snapshot().project;
  saved.map.vertices[0].x = -100;
  assert.equal(saved.importSource.blocks[0].properties.x, -128.25, 'source snapshot is not live editable geometry');
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(saved))).importSource, project.importSource);
  const state = createRuntime(saved); stepRuntime(saved, state, 1 / 35, new Set());
  assert.equal(state.inventory.selectedWeapon, 'pistol');
});
test('UDMF semantic validation rejects invalid references, missing required numbers and wrong field types', () => {
  for (const text of [source.replace('v1=0', 'v1=999'), source.replace('sector=0', 'sector=-1'),
    source.replace('v1=0', 'v1=-1'), source.replace('x=-128.25;', ''), source.replace('blocking=true', 'blocking=1'),
    source.replace('sidefront=0', 'sidefront=0.5'), source.replace('texturefloor="-"', 'texturefloor=false')])
    assert.throws(() => importWadMap(map(text), 'CUSTOM'), /invalid|UDMF|references/);
  assert.throws(() => udmfRecords(parseUDMF(source.replace('heightfloor=-4.5', 'heightfloor=-99999'))), /invalid/);
});
test('UDMF import provenance rejects oversized or executable values on project reload', () => {
  const { project } = importWadMap(map(source), 'CUSTOM');
  project.importSource.blocks[0].properties.x = {};
  assert.throws(() => validateProject(project), /bounded scalars/);
  project.importSource.blocks[0].properties.x = 1;
  project.importSource.format = 'execute';
  assert.throws(() => validateProject(project), /format/);
});
test('native fractional UDMF geometry feeds real Rapier floors, movement and wall collision', async t => {
  await R.init();
  const { project } = importWadMap(map(source), 'CUSTOM'), state = createRuntime(project);
  state.physics = createPhysics(project, state, R, (outer, holes) => ShapeUtils.triangulateShape(
    outer.map(p => new Vector2(p.x, p.y)), holes.map(ring => ring.map(p => new Vector2(p.x, p.y)))));
  t.after(() => state.physics.dispose());
  for (let i = 0; i < 90; i++) stepRuntime(project, state, 1 / 60, new Set());
  assert.equal(state.physics.grounded, true);
  assert.ok(Math.abs(state.player.z + 4.5) < 1, `fractional floor z=${state.player.z}`);
  const y = state.player.y;
  for (let i = 0; i < 120; i++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  assert.ok(state.player.y < y - 20);
  assert.ok(state.player.y > -129 && state.player.y < -100, `wall collision y=${state.player.y}`);
});
test('authenticated standalone WAD upload imports UDMF source and saves/reloads native geometry', async t => {
  const store = new ProjectStore(), { app } = createApp({ store, token: 'udmf-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`, bytes = map(source, [['PLAYPAL', Buffer.alloc(768, 100)]]).buffer;
  const response = await fetch(`${url}/api/import/wad?map=CUSTOM`, { method: 'POST',
    headers: { Authorization: 'Bearer udmf-test', 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes) });
  assert.equal(response.status, 200, await response.clone().text());
  const { project } = await response.json();
  validateProject(project); assert.equal(project.importSource.format, 'udmf');
  const save = await fetch(`${url}/api/project`, { method: 'PUT',
    headers: { Authorization: 'Bearer udmf-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ project, revision: 0 }) });
  assert.equal(save.status, 200);
  assert.deepEqual(store.snapshot().project.importSource, project.importSource);
});
test('all supplied Ascent and Furdoom UDMF maps import as native editable projects', async t => {
  const root = new URL('../Projects/', import.meta.url).pathname;
  if (!existsSync(`${root}/freedoom2.wad`)) { t.skip('No user-supplied base IWAD'); return; }
  const baseBytes = localWadBytes(root, 'freedoom2.wad');
  for (const [name, count] of [['ascentoftitan-1-1', 12], ['Furdoom/furdoom_v0.1.1.pk3', 17]]) {
    if (!existsSync(`${root}/${name}`)) continue;
    const files = await readLocalPackage(root, name), maps = inspectPackage(files).maps;
    assert.equal(maps.length, count);
    for (const item of maps) {
      const { project } = importPackage(files, { map: item.id, baseBytes });
      assert.equal(project.importSource.namespace, 'zdoom', item.id);
      assert.ok(project.map.vertices.length > 3, item.id);
      assert.ok(project.map.entities.some(entity => entity.type === 'player'), item.id);
      if (project.hud.sources?.length) {
        assert.ok(project.hud.sources.some(source => /sbarinfo/i.test(source.name)), item.id);
        assert.ok(project.hud.elements.some(element => element.binding === 'health'), item.id);
        assert.ok(project.eventGroups.some(group => group.name === 'Imported SBARINFO'), item.id);
      } else assert.equal(project.hud.fonts.filter(font => font.name !== 'Imported menu small font').length, 2, item.id);
      validateProject(project);
    }
  }
});
