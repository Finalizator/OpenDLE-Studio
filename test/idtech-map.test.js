import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdTechMap, idTechContent, applyIdTechMap, projectFromIdTechMap } from '../shared/idtech-map.js';
import { createProject, validateProject } from '../shared/project.js';
import { brushVertices, brushBounds } from '../shared/brushes.js';

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
  assert.deepEqual(parsed.stats, { entities: 4, brushes: 1, faces: 6 });
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

test('a Quake 3 brushDef primitive is skipped with a warning, as TrenchBroom does', () => {
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
  assert.ok(parsed.warnings.some(warning => /brush primitive skipped/i.test(warning)));
  assert.equal(parsed.entities[0].brushes.length, 0);
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
