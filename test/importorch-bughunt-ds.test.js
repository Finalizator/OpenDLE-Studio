import test from 'node:test';
import assert from 'node:assert/strict';
import { importWad } from '../server/import.js';
import { readWad, importWadGame } from '../shared/wad.js';

/** Builds a minimal valid Doom-format PWAD byte buffer from [name, Buffer] lumps. */
function wad(lumps) {
  const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
  const bytes = Buffer.alloc(directory + lumps.length * 16);
  bytes.write('PWAD'); bytes.writeUInt32LE(lumps.length, 4); bytes.writeUInt32LE(directory, 8);
  let offset = 12;
  lumps.forEach(([name, data], index) => {
    data.copy(bytes, offset);
    const entry = directory + index * 16;
    bytes.writeUInt32LE(offset, entry); bytes.writeUInt32LE(data.length, entry + 4);
    bytes.write(name, entry + 8, 8);
    offset += data.length;
  });
  return bytes;
}

/** The classic lump set for one playable Doom map with a player-one start. */
function mapLumps(id) {
  const vertices = Buffer.alloc(16), lines = Buffer.alloc(56), things = Buffer.alloc(10),
    side = Buffer.alloc(30), sector = Buffer.alloc(26);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
    lines.writeUInt16LE(i, i * 14); lines.writeUInt16LE((i + 1) % 4, i * 14 + 2);
    lines.writeUInt16LE(65535, i * 14 + 12);
  });
  lines.writeUInt16LE(11, 6); things.writeUInt16LE(1, 6); things.writeUInt16LE(7, 8);
  sector.writeInt16LE(128, 2);
  side.write('-', 4); side.write('-', 12); side.write('-', 20); sector.write('-', 4); sector.write('-', 12);
  return [[id, Buffer.alloc(0)], ['THINGS', things], ['LINEDEFS', lines],
    ['SIDEDEFS', side], ['VERTEXES', vertices], ['SECTORS', sector]];
}

const palette = () => Buffer.alloc(768, 100);
const actorNames = project => (project.actors || []).map(actor => actor.name);

test('importorch 01: full-game import does not mutate the caller actor source list across levels', () => {
  const bytes = wad([
    ['PLAYPAL', palette()],
    ['DECORATE', Buffer.from('actor FooFromWadA 10000 { height 56 }')],
    ['MAPINFO', Buffer.from('map MAP01 "A" { next = "MAP02" }')],
    ...mapLumps('MAP01'), ...mapLumps('MAP02'),
  ]);
  const shared = [{ name: 'gzdoom.pk3:decorate/base.txt', text: 'actor GzBase 20000 { height 20 }' }];
  importWad(bytes, undefined, { actorSources: shared, title: 'A' });
  assert.equal(shared.length, 1, 'the caller-owned actor source list must not be appended to');
  assert.deepEqual(shared.map(source => source.name), ['gzdoom.pk3:decorate/base.txt']);
});

test('importorch 01b: a later import using the same shared source list does not inherit earlier actors', () => {
  const wadA = wad([
    ['PLAYPAL', palette()],
    ['DECORATE', Buffer.from('actor FooFromWadA 10000 { height 56 }')],
    ...mapLumps('MAP01'), ...mapLumps('MAP02'),
  ]);
  const shared = [{ name: 'gzdoom.pk3:decorate/base.txt', text: 'actor GzBase 20000 { height 20 }' }];
  importWad(wadA, undefined, { actorSources: shared, title: 'A' });
  const wadB = wad([['PLAYPAL', palette()], ...mapLumps('MAP01')]);
  const resultB = importWad(wadB, undefined, { actorSources: shared, title: 'B' });
  assert.ok(!actorNames(resultB.project).includes('FooFromWadA'),
    `second import leaked the first WAD's actor: ${actorNames(resultB.project).join(', ')}`);
});

test('importorch 02: campaign entry honours the first declared MAPINFO episode', () => {
  const bytes = wad([
    ['PLAYPAL', palette()],
    ['MAPINFO', Buffer.from('clearepisodes\nepisode MAP02 { name "Real Start" }')],
    ...mapLumps('MAP01'), ...mapLumps('MAP02'), ...mapLumps('MAP03'),
  ]);
  const { project } = importWad(bytes);
  assert.equal(project.game.entry, 'MAP02');
});

test('importorch 02b: MAP01 stays the default entry when no episode moves the campaign', () => {
  const bytes = wad([['PLAYPAL', palette()], ...mapLumps('MAP01'), ...mapLumps('MAP02')]);
  assert.equal(importWad(bytes).project.game.entry, 'MAP01');
});

test('importorch 03: a game above 128 levels is accepted up to the engine level limit', () => {
  const lumps = [['PLAYPAL', palette()]];
  for (let n = 1; n <= 129; n++) lumps.push(...mapLumps(`MAP${String(n).padStart(2, '0')}`));
  const bytes = wad(lumps);
  const { project } = importWad(bytes);
  assert.equal(project.game.levels.length, 129);
});
