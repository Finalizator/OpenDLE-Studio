import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdTechMap, idTechContent, applyIdTechMap, projectFromIdTechMap } from '../shared/idtech-map.js';
import { createProject, validateProject } from '../shared/project.js';
import { brushVertices, brushBounds, brushGeometry, createBoxBrush, facePlane } from '../shared/brushes.js';
import { brushUvAxes, brushFaceUv } from '../shared/uv.js';

const add = (a, b) => a.map((value, index) => value + b[index]);
const sub = (a, b) => a.map((value, index) => value - b[index]);
const scale = (a, factor) => a.map(value => value * factor);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const length = Math.hypot(...a) || 1; return scale(a, 1 / length); };

// A 64-unit cube written the standard Quake way: three plane points, texture, five numbers.
const CUBE_FACES = `( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick1 0 0 0 1 1
( 0 0 0 ) ( 0 0 64 ) ( 0 64 64 ) brick1 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 0 64 ) brick1 0 0 0 1 1
( 64 64 0 ) ( 64 0 0 ) ( 64 0 64 ) brick1 0 0 0 1 1
( 64 64 64 ) ( 0 64 64 ) ( 0 0 64 ) brick1 0 0 0 1 1
( 64 64 64 ) ( 64 0 64 ) ( 0 0 64 ) brick1 0 0 0 1 1`;

// The same cube as a real .map would write it (points clockwise seen from outside).
const QUAKE_MAP = `{
"classname" "worldspawn"
"message" "Test Hall"
"wad" "gfx/base.wad"
{
( 0 64 0 ) ( 64 64 0 ) ( 64 64 64 ) brick1 0 0 0 1 1
( 0 0 64 ) ( 64 0 64 ) ( 64 0 0 ) brick1 0 0 0 1 1
( 0 0 0 ) ( 0 64 0 ) ( 0 64 64 ) brick1 16 0 0 1 1
( 64 0 64 ) ( 64 64 64 ) ( 64 64 0 ) brick1 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) floor1 0 0 0 1 1
( 0 64 64 ) ( 64 64 64 ) ( 64 0 64 ) ceiling1 0 0 0 1 1
}
}
{
"classname" "info_player_start"
"origin" "32 32 24"
"angle" "90"
}
{
"classname" "light"
"origin" "32 32 48"
"light" "300"
}
{
"classname" "monster_army"
"origin" "8 8 16"
}`;

test('the standard dialect reads entities, brushes, textures and offsets', () => {
  const parsed = parseIdTechMap(QUAKE_MAP, { name: 'test.map' });
  assert.equal(parsed.entities.length, 4);
  assert.equal(parsed.format, 'standard');
  assert.deepEqual(parsed.stats, { entities: 4, brushes: 1, faces: 6, primitives: 0 });
  const worldspawn = parsed.entities[0];
  assert.equal(worldspawn.properties.classname, 'worldspawn');
  assert.equal(worldspawn.properties.message, 'Test Hall');
  const faces = worldspawn.brushes[0].faces;
  assert.equal(faces.length, 6);
  assert.equal(faces[0].texture, 'brick1');
  assert.equal(faces[2].offsetX, 16);
});

test('comments, tabs and quoted names with spaces are handled', () => {
  const text = `// this whole line is a comment
{
  "classname" "worldspawn"

  // brush 0
  {
    ( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) "textures/base/brick one" 0 0 0 1 1
    ( 0 0 0 ) ( 0 0 64 ) ( 0 64 64 ) brick 0 0 0 1 1
    ( 0 0 0 ) ( 64 0 0 ) ( 64 0 64 ) brick 0 0 0 1 1
    ( 64 64 0 ) ( 64 0 0 ) ( 64 0 64 ) brick 0 0 0 1 1
    ( 64 64 64 ) ( 0 64 64 ) ( 0 0 64 ) brick 0 0 0 1 1
    ( 64 64 64 ) ( 64 0 64 ) ( 0 0 64 ) brick 0 0 0 1 1
  }
}`;
  const parsed = parseIdTechMap(text);
  assert.equal(parsed.entities[0].brushes[0].faces[0].texture, 'textures/base/brick one');
});

test('the Valve dialect keeps its explicit texture axes', () => {
  const text = `{
"classname" "worldspawn"
{
( 0 64 0 ) ( 64 64 0 ) ( 64 64 64 ) brick1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 0 0 64 ) ( 64 0 64 ) ( 64 0 0 ) brick1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 0 0 0 ) ( 0 64 0 ) ( 0 64 64 ) brick1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 64 0 64 ) ( 64 64 64 ) ( 64 64 0 ) brick1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) floor1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 0 64 64 ) ( 64 64 64 ) ( 64 0 64 ) ceiling1 [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
}
}`;
  const parsed = parseIdTechMap(text);
  assert.equal(parsed.format, 'valve');
  const face = parsed.entities[0].brushes[0].faces[0];
  assert.deepEqual(face.axes.u, [1, 0, 0, 0]);
  assert.deepEqual(face.axes.v, [0, -1, 0, 0]);
});

test('a Quake 3 Valve face is read from its texture axes', () => {
  // The form TrenchBroom itself writes for Quake 3 (writeQuake3ValveMap in its own test suite).
  const text = `{
"classname" "worldspawn"
{
( -32 -32 -32 ) ( -32 -31 -32 ) ( -32 -32 -31 ) none [ 0 -1 0 0 ] [ 0 0 -1 0 ] 0 1 1
( -32 -32 -32 ) ( -32 -32 -31 ) ( -31 -32 -32 ) none [ 1 0 0 0 ] [ 0 0 -1 0 ] 0 1 1
( 32 32 32 ) ( 32 33 32 ) ( 33 32 32 ) none [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 32 32 32 ) ( 32 32 33 ) ( 32 33 32 ) none [ 0 1 0 0 ] [ 0 0 -1 0 ] 0 1 1
}
}`;
  const parsed = parseIdTechMap(text);
  const face = parsed.entities[0].brushes[0].faces[0];
  assert.deepEqual(face.axes.u, [0, -1, 0, 0]);
  assert.deepEqual(face.axes.v, [0, 0, -1, 0]);
  assert.equal(face.texture, 'none');
  assert.equal(parsed.format, 'valve');
});

test('a Doom 3 / Quake 4 brushDef plane form is refused, not misread', () => {
  // The same word, a different format: two plane vectors instead of three points. Reading it as a
  // Quake 3 primitive would invent geometry, so it is named and skipped.
  const text = `{
"classname" "worldspawn"
{
brushDef
{
( ( 1 0 0 0 ) ( 0 1 0 0 ) ) brick 0 0 0 1 1
}
}
}`;
  const parsed = parseIdTechMap(text, { name: 'prim.map' });
  assert.equal(parsed.entities[0].primitives, 1);
  assert.equal(parsed.entities[0].brushes.length, 0);
  assert.ok(parsed.warnings.some(warning => /Doom 3 \/ Quake 4.* not a Quake 3 brush primitive/i.test(warning)), parsed.warnings.join('\n'));
});

/**
 * A brush primitive cube whose faces carry real texture bases: each face's two axes lie in its
 * plane, are rotated away from the paraxial frame by `turn`, and have their own lengths, so the
 * conversion cannot pass by returning the defaults.
 *
 * The geometry comes from the editor's own box so the six planes really enclose a volume — the
 * legacy fixture above has a duplicated top plane and no side, which is fine as text but is not a
 * brush.
 */
function primitiveCube({ turn = 30, uRepeat = 1 / 32, vRepeat = 1 / 128, mirror = false } = {}) {
  const project = { map: { brushes: [] } };
  const brush = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  const lines = [];
  const bases = [];
  for (const entry of brushGeometry(brush).faces) {
    const [a, b, c] = entry.points.slice(0, 3);
    const frame = brushUvAxes(entry.plane.normal);
    const theta = turn * Math.PI / 180;
    const u = add(scale(frame.u, Math.cos(theta) * uRepeat), scale(frame.v, Math.sin(theta) * uRepeat));
    const v = mirror
      ? add(scale(frame.u, -Math.sin(theta) * vRepeat), scale(frame.v, -Math.cos(theta) * vRepeat))
      : add(scale(frame.u, -Math.sin(theta) * vRepeat), scale(frame.v, Math.cos(theta) * vRepeat));
    bases.push({ u, v });
    lines.push(`( ${a.join(' ')} ) ( ${b.join(' ')} ) ( ${c.join(' ')} ) ( ( ${u.join(' ')} ) ( ${v.join(' ')} ) ) common/caulk 0 0 0`);
  }
  return { text: `{\n"classname" "worldspawn"\n{\nbrushDef\n{\n${lines.join('\n')}\n}\n}\n}`, bases };
}

const fitsProjection = (brush, bases) => {
  for (const [index, face] of brush.faces.entries()) {
    const plane = facePlane(face);
    const { u, v } = bases[index];
    for (const point of [[0, 0, 0], [12, -34, 56], [64, 64, 0], [-8, 8, 8]]) {
      const [s, t] = brushFaceUv(face, plane.normal, point);
      assert.ok(Math.abs(s - dot(point, u)) < 1e-9, `face ${index} s ${s} != ${dot(point, u)}`);
      assert.ok(Math.abs(t - dot(point, v)) < 1e-9, `face ${index} t ${t} != ${dot(point, v)}`);
    }
  }
};

test('a Quake 3 brushDef brush keeps its geometry and its texture basis', () => {
  const { text, bases } = primitiveCube();
  const parsed = parseIdTechMap(text, { name: 'cube.map' });
  assert.equal(parsed.format, 'primitive');
  assert.equal(parsed.stats.primitives, 1);
  assert.equal(parsed.entities[0].primitives, 1);
  assert.equal(parsed.entities[0].brushes.length, 1, 'a brush primitive is a brush, not something to skip');
  assert.equal(parsed.entities[0].brushes[0].faces.length, 6);

  const content = idTechContent(parsed);
  assert.equal(content.brushes.length, 1);
  const brush = content.brushes[0];
  assert.ok(brushVertices(brush).length >= 8);
  assert.ok(brush.faces.every(face => face.uvBasis?.u?.length === 3), 'every face keeps the basis the file gave it');
  // The projection the file asked for is what the face produces, exactly: s = dot(p, u), t = dot(p, v).
  fitsProjection(brush, bases);
  // The inspector's numbers are the paraxial equivalent, inside the range the validator allows.
  for (const face of brush.faces) {
    assert.ok(Number.isFinite(face.rotation) && Math.abs(face.rotation) <= 360);
    assert.ok(Math.abs(face.scaleX) >= .05 && Math.abs(face.scaleX) <= 16);
    assert.ok(Math.abs(face.scaleY) >= .05 && Math.abs(face.scaleY) <= 16);
  }
});

test('a rotated basis with unequal scales is kept exactly, not fitted', () => {
  // Rotation and scale cannot express this pair (the scales differ and the pair is turned), which is
  // why a brush primitive keeps its basis instead of being converted away.
  const { text, bases } = primitiveCube({ turn: 37, uRepeat: 1 / 32, vRepeat: 1 / 128 });
  const content = idTechContent(parseIdTechMap(text, { name: 'turned.map' }));
  fitsProjection(content.brushes[0], bases);
});

test('a mirrored basis keeps the mirror', () => {
  const { text, bases } = primitiveCube({ mirror: true });
  const content = idTechContent(parseIdTechMap(text, { name: 'mirror.map' }));
  assert.equal(content.warnings.some(warning => /fitted/.test(warning)), false, content.warnings.join('\n'));
  fitsProjection(content.brushes[0], bases);
});

test('a sheared basis and a texel shift survive the import', () => {
  // A sheared pair has no rotation/scale form at all; the basis is kept verbatim, shift included.
  const sheared = `{
"classname" "worldspawn"
{
brushDef
{
( -64 64 64 ) ( 64 -64 64 ) ( -64 -64 64 ) ( ( 0.015625 0 0.0078125 8 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( -64 64 64 ) ( 64 64 -64 ) ( 64 64 64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( 64 64 64 ) ( 64 -64 -64 ) ( 64 -64 64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( 64 64 -64 ) ( -64 -64 -64 ) ( 64 -64 -64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( 64 -64 -64 ) ( -64 -64 64 ) ( 64 -64 64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( -64 -64 64 ) ( -64 64 -64 ) ( -64 64 64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
}
}
}`;
  const content = idTechContent(parseIdTechMap(sheared, { name: 'shear.map' }));
  assert.equal(content.brushes.length, 1, 'the brush is kept');
  const face = content.brushes[0].faces.find(entry => entry.uvBasis.u.length === 4);
  assert.ok(face, 'the shifted axis is kept as written');
  assert.deepEqual(face.uvBasis.u, [0.015625, 0, 0.0078125, 8]);
  const plane = facePlane(face);
  const [s, t] = brushFaceUv(face, plane.normal, [0, 0, 0]);
  assert.equal(s, 8, 'the shift is a texel offset on the axis');
  assert.equal(t, 0);
  const [s2] = brushFaceUv(face, plane.normal, [64, 0, 0]);
  assert.ok(Math.abs(s2 - (64 * 0.015625 + 8)) < 1e-9);
});

test('a primitive beside a legacy brush keeps both brushes', () => {
  // Verbatim from TrenchBroom's own `tst_WorldReader.cpp` case "Brush primitive and legacy brush",
  // where the assertion is `childCount() == 1` and the primitive is dropped (their TODO 2427).
  // Here both survive — that is the point of reading the basis.
  const text = `{
"classname" "worldspawn"
{
brushDef
{
( -64 64 64 ) ( 64 -64 64 ) ( -64 -64 64 ) ( ( 0.015625 0 -0 ) ( -0 0.015625 0 ) ) common/caulk 0 0 0
( -64 64 64 ) ( 64 64 -64 ) ( 64 64 64 ) ( ( 0.015625 0 0 ) ( 0 0.015625 0 ) ) common/caulk 0 0 0
( 64 64 64 ) ( 64 -64 -64 ) ( 64 -64 64 ) ( ( 0.015625 0 -0 ) ( -0 0.015625 0 ) ) common/caulk 0 0 0
( 64 64 -64 ) ( -64 -64 -64 ) ( 64 -64 -64 ) ( ( 0.015625 0 -0 ) ( -0 0.015625 0 ) ) common/caulk 0 0 0
( 64 -64 -64 ) ( -64 -64 64 ) ( 64 -64 64 ) ( ( 0.015625 0 -0 ) ( -0 0.015625 0 ) ) common/caulk 0 0 0
( -64 -64 64 ) ( -64 64 -64 ) ( -64 64 64 ) ( ( 0.015625 0 -0 ) ( -0 0.015625 0 ) ) common/caulk 0 0 0
}
}
{
( 64 64 64 ) ( 64 -64 64 ) ( -64 64 64 ) common/caulk 0 0 0 1 1 134217728 0 0
( 64 64 64 ) ( -64 64 64 ) ( 64 64 -64 ) common/caulk 0 0 0 1 1 134217728 0 0
( 64 64 64 ) ( 64 64 -64 ) ( 64 -64 64 ) common/caulk 0 0 0 1 1 134217728 0 0
( -64 -64 -64 ) ( 64 -64 -64 ) ( -64 64 -64 ) common/caulk 0 0 0 1 1 134217728 0 0
( -64 -64 -64 ) ( -64 -64 64 ) ( 64 -64 -64 ) common/caulk 0 0 0 1 1 134217728 0 0
( -64 -64 -64 ) ( -64 64 -64 ) ( -64 -64 64 ) common/caulk 0 0 0 1 1 134217728 0 0
}
}`;
  const parsed = parseIdTechMap(text, { name: 'mixed.map' });
  assert.equal(parsed.entities[0].primitives, 1);
  assert.equal(parsed.entities[0].brushes.length, 2, 'both the primitive and the legacy brush are read');
  assert.equal(parsed.stats.entities, 1);
  assert.equal(parsed.format, 'mixed');
  const content = idTechContent(parsed);
  assert.equal(content.brushes.length, 2);
  // TrenchBroom's own fixture reuses one axis pair on all six faces, so on the ±X faces the basis
  // lies along their normal and projects to nothing. The basis is still kept as written, and the
  // inspector's numbers stay finite, so the face remains editable.
  const primitive = content.brushes.find(brush => brush.faces.some(face => face.uvBasis));
  assert.ok(primitive.faces.every(face => Number.isFinite(face.scaleX) && Number.isFinite(face.rotation)));
});

test('Quake 3 patches are counted and skipped, not fatal', () => {
  const text = `{
"classname" "worldspawn"
{
patchDef2
{
"textures/base/curve"
( 3 3 0 0 0 )
(
( ( 0 0 0 0 0 ) ( 0 0 0 0 0 ) ( 0 0 0 0 0 ) )
)
}
}
}`;
  const parsed = parseIdTechMap(text);
  assert.equal(parsed.entities[0].patches, 1);
  assert.ok(parsed.warnings.some(warning => /patch/i.test(warning)));
});

test('a brush becomes a closed convex plane brush, with its texture name kept', () => {
  const parsed = parseIdTechMap(QUAKE_MAP, { name: 'test.map' });
  const content = idTechContent(parsed);
  assert.equal(content.brushes.length, 1);
  const brush = content.brushes[0];
  assert.equal(brushVertices(brush).length, 8);
  assert.equal(brush.faces.length, 6);
  assert.equal(brush.faces[0].textureName, 'brick1');
  const bounds = brushBounds(brush);
  assert.deepEqual([bounds.width, bounds.depth, bounds.height], [64, 64, 64]);
});

test('Quake entities become objects with their class and properties kept', () => {
  const parsed = parseIdTechMap(QUAKE_MAP, { name: 'test.map' });
  const content = idTechContent(parsed);
  const player = content.entities.find(entity => entity.type === 'player');
  assert.equal(player.mapClassname, 'info_player_start');
  assert.equal(player.x, 32);
  assert.equal(player.y, 32);
  assert.equal(player.angle, 90);
  const light = content.entities.find(entity => entity.type === 'light');
  assert.equal(light.mapClassname, 'light');
  const monster = content.entities.find(entity => entity.mapClassname === 'monster_army');
  assert.equal(monster.type, 'decoration');
});

test('a map with no player start gets one, and says so', () => {
  const text = QUAKE_MAP.replace(/info_player_start/, 'info_notnull');
  const content = idTechContent(parseIdTechMap(text, { name: 'noplayer.map' }));
  assert.equal(content.entities.filter(entity => entity.type === 'player').length, 1);
  assert.ok(content.warnings.some(warning => /player start/i.test(warning)));
});

test('an imported map is a valid brush-only project', () => {
  const parsed = parseIdTechMap(QUAKE_MAP, { name: 'test.map' });
  const project = projectFromIdTechMap(parsed, { createProject });
  assert.equal(project.title, 'Test Hall');
  assert.equal(project.map.walls.length, 0);
  assert.equal(project.map.brushes.length, 1);
  assert.equal(project.events.length, 0);
  const validated = validateProject(project);
  assert.equal(validated.map.brushes.length, 1);
  assert.equal(validated.mapSource.dialect, 'standard');
});

test('adding a map to an existing project keeps what was there and offsets the new geometry', () => {
  const project = createProject();
  const before = { walls: project.map.walls.length, brushes: (project.map.brushes || []).length };
  const parsed = parseIdTechMap(QUAKE_MAP, { name: 'test.map' });
  const content = applyIdTechMap(project, parsed, { offset: [1024, 0, 0] });
  assert.equal(project.map.walls.length, before.walls);
  assert.equal(project.map.brushes.length, before.brushes + 1);
  assert.equal(brushBounds(project.map.brushes.at(-1)).x, 1024);
  assert.equal(content.source.stats.brushes, 1);
  validateProject(project);
});

test('a malformed brush is skipped with a reason instead of breaking the import', () => {
  const text = `{
"classname" "worldspawn"
{
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) brick 0 0 0 1 1
}
}`;
  const content = idTechContent(parseIdTechMap(text, { name: 'flat.map' }));
  assert.equal(content.brushes.length, 0);
  assert.ok(content.warnings.some(warning => /skipped/i.test(warning)));
});

test('a broken file reports the line it broke on', () => {
  const text = `{
"classname" "worldspawn"
{
( 0 0 0 ) ( 64 0 0 )
}`;
  assert.throws(() => parseIdTechMap(text, { name: 'broken.map' }), /broken\.map: line \d+/);
});

test('the face list of a cube read both ways produces the same volume', () => {
  const clockwise = parseIdTechMap(QUAKE_MAP, { name: 'cw.map' });
  const reversed = clockwise.entities[0].brushes[0].faces.map(face => ({ ...face, points: [face.points[0], face.points[2], face.points[1]] }));
  const content = idTechContent(clockwise);
  const originalBounds = brushBounds(content.brushes[0]);
  const flipped = { ...clockwise, entities: [{ ...clockwise.entities[0], brushes: [{ faces: reversed }] }, ...clockwise.entities.slice(1)] };
  const flippedBounds = brushBounds(idTechContent(flipped).brushes[0]);
  assert.deepEqual(originalBounds, flippedBounds);
});
