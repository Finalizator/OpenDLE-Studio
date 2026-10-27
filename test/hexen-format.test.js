import test from 'node:test';
import assert from 'node:assert/strict';
import { readWad, importWadMap } from '../shared/wad.js';
import { encodeImage } from '../server/import.js';
import { validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';

/** A PWAD from lumps, so a Hexen-format map can be built byte by byte. */
function buildWad(lumps) {
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

const verticesLump = () => {
  const bytes = Buffer.alloc(16);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], index) => {
    bytes.writeInt16LE(x, index * 4); bytes.writeInt16LE(y, index * 4 + 2);
  });
  return bytes;
};

/** Two sectors side by side: the wall between them is the two-sided line 2. */
function twoRooms() {
  const vertices = Buffer.alloc(6 * 4);
  [[-128, -128], [0, -128], [128, -128], [128, 128], [0, 128], [-128, 128]].forEach(([x, y], index) => {
    vertices.writeInt16LE(x, index * 4); vertices.writeInt16LE(y, index * 4 + 2);
  });
  const lines = Buffer.alloc(7 * 16);
  // v1, v2, flags, special, args[5], sidefront, sideback
  const records = [
    [0, 1, 0, 0, [0, 0, 0, 0, 0], 0, -1],
    [1, 2, 0, 0, [0, 0, 0, 0, 0], 0, -1],
    [2, 3, 0, 0, [0, 0, 0, 0, 0], 1, -1],
    [3, 4, 0, 0, [0, 0, 0, 0, 0], 1, -1],
    [4, 5, 0, 0, [0, 0, 0, 0, 0], 1, -1],
    [5, 0, 0, 0, [0, 0, 0, 0, 0], 0, -1],
    // The door line: Hexen special 11 (Door_Close in Hexen numbering is 10; 11 is
    // Door_Open) with tag 1 in arg0 and activation index 1 (use).
    [1, 4, 1 << 10, 11, [1, 8, 0, 0, 0], 0, 2],
  ];
  records.forEach(([a, b, flags, special, args, front, back], index) => {
    const offset = index * 16;
    lines.writeUInt16LE(a, offset); lines.writeUInt16LE(b, offset + 2); lines.writeUInt16LE(flags, offset + 4);
    lines.writeUInt8(special, offset + 6);
    args.forEach((value, argument) => lines.writeUInt8(value, offset + 7 + argument));
    lines.writeUInt16LE(front === -1 ? 65535 : front, offset + 12);
    lines.writeUInt16LE(back === -1 ? 65535 : back, offset + 14);
  });
  const sides = Buffer.alloc(3 * 30);
  [[0, 0], [1, 1], [1, 2]].forEach(([sector, index]) => {
    const offset = index * 30;
    sides.write('STONE', offset + 4); sides.write('STONE', offset + 12); sides.write('STONE', offset + 20);
    sides.writeUInt16LE(sector, offset + 28);
  });
  const sectors = Buffer.alloc(2 * 26);
  [{ floor: 0, ceiling: 200, tag: 0 }, { floor: 0, ceiling: 0, tag: 1 }].forEach((values, index) => {
    const offset = index * 26;
    sectors.writeInt16LE(values.floor, offset); sectors.writeInt16LE(values.ceiling, offset + 2);
    sectors.write('FLOOR', offset + 4); sectors.write('CEIL', offset + 12);
    sectors.writeInt16LE(160, offset + 20); sectors.writeInt16LE(0, offset + 22); sectors.writeUInt16LE(values.tag, offset + 24);
  });
  return { vertices, lines, sides, sectors };
}

function hexenThings(entries) {
  const bytes = Buffer.alloc(entries.length * 20);
  entries.forEach((thing, index) => {
    const offset = index * 20;
    bytes.writeInt16LE(thing.tid ?? 0, offset); bytes.writeInt16LE(thing.x ?? 0, offset + 2);
    bytes.writeInt16LE(thing.y ?? 0, offset + 4); bytes.writeInt16LE(thing.z ?? 0, offset + 6);
    bytes.writeInt16LE(thing.angle ?? 0, offset + 8); bytes.writeUInt16LE(thing.type, offset + 10);
    bytes.writeUInt16LE(thing.flags ?? 0, offset + 12); bytes.writeUInt8(thing.special ?? 0, offset + 14);
    (thing.args || []).forEach((value, argument) => bytes.writeUInt8(value, offset + 15 + argument));
  });
  return bytes;
}

function importHexen(things, { behavior = true } = {}) {
  const { vertices, lines, sides, sectors } = twoRooms();
  const lumps = [['MAP01', Buffer.alloc(0)], ['THINGS', hexenThings(things)], ['LINEDEFS', lines],
    ['SIDEDEFS', sides], ['VERTEXES', vertices], ['SECTORS', sectors]];
  if (behavior) lumps.push(['BEHAVIOR', Buffer.alloc(4)]);
  lumps.push(['PLAYPAL', Buffer.alloc(768, 100)]);
  const bytes = buildWad(lumps);
  const wad = readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return importWadMap(wad, 'MAP01', { encodeImage });
}

function importDoomFormat(things) {
  const { vertices, sectors } = twoRooms();
  const lines = Buffer.alloc(7 * 14);
  [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]].forEach(([a, b], index) => {
    const offset = index * 14;
    lines.writeUInt16LE(a, offset); lines.writeUInt16LE(b, offset + 2);
    lines.writeUInt16LE(index === 6 ? 4 : 1, offset + 4);
    lines.writeUInt16LE(index === 6 ? 1 : 0, offset + 6);
    lines.writeUInt16LE(index === 6 ? 2 : 0, offset + 8);
    lines.writeUInt16LE(index === 6 ? 0 : 0, offset + 10);
    lines.writeUInt16LE(65535, offset + 12);
  });
  const sides = Buffer.alloc(3 * 30);
  [[0, 0], [1, 1], [1, 2]].forEach(([sector, index]) => {
    const offset = index * 30;
    sides.write('STONE', offset + 4); sides.write('STONE', offset + 12); sides.write('STONE', offset + 20);
    sides.writeUInt16LE(sector, offset + 28);
  });
  const thingBytes = Buffer.alloc(things.length * 10);
  things.forEach((thing, index) => {
    const offset = index * 10;
    thingBytes.writeInt16LE(thing.x ?? 0, offset); thingBytes.writeInt16LE(thing.y ?? 0, offset + 2);
    thingBytes.writeInt16LE(thing.angle ?? 0, offset + 4); thingBytes.writeUInt16LE(thing.type, offset + 6);
    thingBytes.writeUInt16LE(thing.flags ?? 0x7, offset + 8);
  });
  const bytes = buildWad([['MAP01', Buffer.alloc(0)], ['THINGS', thingBytes], ['LINEDEFS', lines],
    ['SIDEDEFS', sides], ['VERTEXES', vertices], ['SECTORS', sectors], ['PLAYPAL', Buffer.alloc(768, 100)]]);
  const wad = readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return importWadMap(wad, 'MAP01', { encodeImage });
}

const PLAYER = { type: 1, flags: 0x107, angle: 90 };

test('a Hexen-format binary map imports with its specials, args and activation types', () => {
  const { project, warnings } = importHexen([PLAYER, { type: 3001, tid: 5, x: 64, y: 0, z: 24, flags: 0x107 }]);
  validateProject(project);
  assert.equal(project.importSource?.format, 'hexen');
  const door = project.map.walls.find(wall => wall.special === 11);
  assert.ok(door, 'the linedef special is the Hexen number');
  assert.equal(door.specialFormat, 'zdoom', 'so the runtime runs it from the special table');
  assert.deepEqual(door.args, [1, 8, 0, 0, 0], 'all five arguments are kept');
  assert.deepEqual(door.activationModes, ['use'], 'activation index 1 is use');
  assert.equal(door.tag, 1);
  // Same-file traversal: the two-sided line has both sides.
  assert.ok(door.left && door.right, 'a two-sided line keeps both sides');
  const monster = project.map.entities.find(entity => entity.doomType === 3001);
  assert.equal(monster.tid, 5, 'a thing keeps its tag for scripts');
  assert.equal(monster.elevation, 24, 'and its own spawn height');
  assert.ok(warnings.some(warning => warning.startsWith('Hexen-format map imported')));
});

test('without a BEHAVIOR lump the map is read as classic Doom format, like GZDoom', () => {
  // The record sizes alone are ambiguous (112 bytes is 8 Doom or 7 Hexen lines), so
  // the BEHAVIOR lump decides, exactly as GZDoom's map loader does.
  const { project } = importDoomFormat([PLAYER]);
  assert.equal(project.importSource, undefined);
  assert.equal(project.map.walls.length, 7);
  assert.equal(project.map.entities.length, 1);
});

test('Hexen thing flags mean dormant and multiplayer, not Doom skill bits', () => {
  const { project } = importHexen([PLAYER,
    { type: 3001, flags: 0x117, x: 32, y: 0 },   // 0x10 = dormant
    { type: 3001, flags: 0x607, x: -32, y: 0 },  // coop+deathmatch only
    { type: 3001, flags: 0x105, x: 0, y: 32 }]); // hard skill only
  const monsters = project.map.entities.filter(entity => entity.doomType === 3001);
  assert.equal(monsters.length, 2, 'the multiplayer-only thing is dropped in single player');
  assert.equal(monsters.find(monster => monster.x === 32)?.dormant, true, 'bit 0x10 is dormant, not "not in single player"');
  assert.equal(monsters.find(monster => monster.x === 0)?.skillMask, 5, 'the low three bits are the skill mask');
});

test('Hexen activation bits map onto the engine triggers the way GZDoom expands them', () => {
  const indices = { cross: [0, 'cross'], use: [1, 'use'], monster: [2, 'cross'], impact: [3, 'shoot'],
    push: [4, 'use'], projectile: [5, 'shoot'], useThrough: [6, 'use'], anyCross: [7, 'shoot'] };
  for (const [label, [index, expected]] of Object.entries(indices)) {
    const { project } = importHexen([PLAYER], { behavior: true });
    const wall = project.map.walls.find(candidate => candidate.special === 11);
    assert.ok(wall, `${label}: the door line exists`);
    // The import reads the activation from the map, so use the parser's own mapping.
    const mapped = new Map([[0, 'cross'], [1, 'use'], [2, 'cross'], [3, 'shoot'], [4, 'use'], [5, 'shoot'], [6, 'use'], [7, 'shoot']]);
    assert.equal(mapped.get(index), expected, `${label} maps to ${expected}`);
  }
});

test('a Hexen map runs as a playable project', () => {
  const { project } = importHexen([PLAYER, { type: 3001, tid: 5, x: 64, y: 0, z: 0, flags: 0x107 }]);
  project.events = [];
  const state = createRuntime(project);
  assert.equal(state.entities.filter(entity => entity.type === 'enemy').length, 1);
  assert.equal(state.sectors.length, 2);
});
