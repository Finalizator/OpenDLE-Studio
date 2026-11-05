import test from 'node:test';
import assert from 'node:assert/strict';
import { readWad, importWadMap } from '../shared/wad.js';
import { validateProject } from '../shared/project.js';

/** A PWAD from lumps, so a UDMF or binary map can be built byte by byte. */
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

function udmfWad(text) {
  const bytes = buildWad([['CUSTOM', Buffer.alloc(0)], ['TEXTMAP', Buffer.from(text)],
    ['ENDMAP', Buffer.alloc(0)], ['PLAYPAL', Buffer.alloc(768, 100)]]);
  return readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

test('Doom-namespace UDMF specials keep classic numbering, so a DR door becomes a rule', () => {
  // namespace="doom" is the UDMF reserved namespace for vanilla-conformant maps:
  // line special 1 is DR Door Open Wait Close, not the ZDoom table's NOP at 1.
  const { project } = importWadMap(udmfWad(`namespace="doom";
    vertex { x=-128; y=-128; } vertex { x=0; y=-128; } vertex { x=128; y=-128; }
    vertex { x=128; y=128; } vertex { x=0; y=128; } vertex { x=-128; y=128; }
    sector { heightfloor=0; heightceiling=128; texturefloor="-"; textureceiling="-"; }
    sector { heightfloor=0; heightceiling=0; texturefloor="-"; textureceiling="-"; id=1; }
    sidedef { sector=0; texturemiddle="-"; }
    sidedef { sector=1; texturemiddle="-"; }
    linedef { v1=0; v2=1; sidefront=0; }
    linedef { v1=1; v2=2; sidefront=1; }
    linedef { v1=2; v2=3; sidefront=1; }
    linedef { v1=3; v2=4; sidefront=1; }
    linedef { v1=4; v2=5; sidefront=0; }
    linedef { v1=5; v2=0; sidefront=0; }
    linedef { v1=1; v2=4; sidefront=0; sideback=1; special=1; id=1; arg0=1; }
    thing { x=32; y=32; type=1; single=true; skill1=true; }`), 'CUSTOM');
  validateProject(project);
  const door = project.map.walls.find(wall => wall.special === 1);
  assert.ok(door, 'the door line imports');
  // Classic Doom lines are not run from the Hexen/ZDoom special table.
  assert.equal(door.specialFormat, undefined);
  // The classic translator turns DR Door Open Wait Close into an engine door rule.
  assert.ok(project.events.some(event => /door 1/.test(event.name)),
    `a DR door rule should be generated, got: ${project.events.map(event => event.name).join(', ')}`);
});

test('UDMF missilecross activation is kept as shoot, not silently defaulted to use', () => {
  const { project } = importWadMap(udmfWad(`namespace="zdoom";
    vertex { x=0; y=0; } vertex { x=64; y=0; } vertex { x=64; y=64; } vertex { x=0; y=64; }
    sector { heightfloor=0; heightceiling=128; texturefloor="-"; textureceiling="-"; }
    sidedef { sector=0; texturemiddle="-"; }
    linedef { v1=0; v2=1; sidefront=0; special=11; arg0=1; missilecross=true; }
    linedef { v1=1; v2=2; sidefront=0; }
    linedef { v1=2; v2=3; sidefront=0; }
    linedef { v1=3; v2=0; sidefront=0; }
    thing { x=32; y=32; type=1; single=true; skill1=true; }`), 'CUSTOM');
  validateProject(project);
  const line = project.map.walls.find(wall => wall.special === 11);
  assert.deepEqual(line.activationModes, ['shoot']);
});
