// A compiled map has to import as the level it is, not as a picture of one.
//
// The fixtures here are real BSP files, written byte by byte: a Quake 1 tree of six planes around a
// solid box, and a Quake 3 file with one six-sided brush. Small, but the layouts are the games' own —
// the plane, node, leaf, model, brush and side records sit at the offsets the formats put them at,
// which is what the reader is being tested against.

import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { bspInfo, bspEngine, parseBsp } from '../shared/bsp.js';
import { projectFromIdTechMap } from '../shared/idtech-map.js';
import { createProject, validateProject } from '../shared/project.js';
import { brushVertices, facePolygon } from '../shared/brushes.js';
import { collisionMesh, createPhysics } from '../shared/physics.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

const BOX = 128;
const ENTITIES = `{
"classname" "worldspawn"
"message" "Test Box"
}
{
"classname" "info_player_start"
"origin" "64 64 256"
"angle" "90"
}
`;

/**
 * The six planes that bound the solid box.
 *
 * A BSP node plane splits space and the walk to a leaf keeps one side of it, so the node planes are
 * written facing the solid space. A brush's planes are the other way round — every one of them points
 * outward and the brush is behind all of them — which is why the two lists differ.
 */
const boxPlanes = () => [
  [[1, 0, 0], 0], [[-1, 0, 0], -BOX],
  [[0, 1, 0], 0], [[0, -1, 0], -BOX],
  [[0, 0, 1], 0], [[0, 0, -1], -BOX],
];
const outwardBoxPlanes = () => [
  [[-1, 0, 0], 0], [[1, 0, 0], BOX],
  [[0, -1, 0], 0], [[0, 1, 0], BOX],
  [[0, 0, -1], 0], [[0, 0, 1], BOX],
];

/** Quake 1's file: a version, then fifteen lumps, then the payloads in lump order. */
function packQuake(payloads, { version = 29 } = {}) {
  const directoryEnd = 4 + 15 * 8;
  let offset = directoryEnd;
  const directory = payloads.map(payload => {
    const lump = { offset, length: payload.length };
    offset += payload.length;
    return lump;
  });
  const header = Buffer.alloc(directoryEnd);
  header.writeInt32LE(version, 0);
  directory.forEach((lump, index) => {
    header.writeInt32LE(lump.offset, 4 + index * 8);
    header.writeInt32LE(lump.length, 8 + index * 8);
  });
  return Buffer.concat([header, ...payloads]);
}

/**
 * A Quake 1 world of solid boxes.
 *
 * Each node splits space on one of a box's planes: its back child is the air outside the box, and
 * its front child is the next plane, so the only way to the solid leaf is through the front of all
 * six. That is the one convex piece of solid space each model has, and the hull it is reached with is
 * the box those planes enclose. A second box is a second *model*: a door, or a platform — every
 * Half-Life brush entity is one.
 */
function quakeBox({ models = 1 } = {}) {
  const payloads = Array.from({ length: 15 }, () => Buffer.alloc(0));
  const doors = Array.from({ length: models - 1 }, (unused, index) => index + 1);
  payloads[0] = Buffer.from(`${ENTITIES}${doors.map(index => `{\n"classname" "func_door"\n"model" "*${index}"\n}\n`).join('')}`, 'latin1');

  const planes = Buffer.alloc(models * 6 * 20), nodes = Buffer.alloc(models * 6 * 24);
  for (let model = 0; model < models; model++) {
    // Every model's box is the same box around its own origin, which is how a compiler writes a
    // door: the geometry sits where the door is, not at the world origin.
    boxPlanes().forEach(([normal, distance], index) => {
      const at = (model * 6 + index) * 20;
      normal.forEach((value, axis) => planes.writeFloatLE(value, at + axis * 4));
      planes.writeFloatLE(distance, at + 12);
    });
    for (let index = 0; index < 6; index++) {
      const at = (model * 6 + index) * 24;
      nodes.writeInt32LE(index, at);
      nodes.writeInt16LE(index === 5 ? -1 : model * 6 + index + 1, at + 4);
      nodes.writeInt16LE(-2, at + 6);
    }
  }
  payloads[1] = planes;
  payloads[5] = nodes;
  const leafs = Buffer.alloc(2 * 24);
  leafs.writeInt32LE(-2, 0);
  leafs.writeInt32LE(-1, 24);
  payloads[10] = leafs;
  const modelsLump = Buffer.alloc(models * 64);
  for (let model = 0; model < models; model++) {
    const at = model * 64;
    [0, 0, 0].forEach((value, axis) => modelsLump.writeFloatLE(value, at + axis * 4));
    [BOX, BOX, BOX].forEach((value, axis) => modelsLump.writeFloatLE(value, at + 12 + axis * 4));
    modelsLump.writeInt32LE(model * 6, at + 36);
  }
  payloads[14] = modelsLump;
  return packQuake(payloads);
}

/** Quake 3's file: the ASCII magic, the version, seventeen lumps, then one six-sided brush. */
function quake3Box({ solid = true, material = 'textures/test/floor' } = {}) {
  const lumps = Array.from({ length: 17 }, () => Buffer.alloc(0));
  lumps[0] = Buffer.from(ENTITIES, 'latin1');
  const shader = Buffer.alloc(72);
  shader.write(material, 0, 'latin1');
  // The shader's contents: `CONTENTS_SOLID`, or nothing at all for a compiler volume like `hint`.
  shader.writeInt32LE(solid ? 1 : 0, 68);
  lumps[1] = shader;
  const planes = Buffer.alloc(6 * 16);
  outwardBoxPlanes().forEach(([normal, distance], index) => {
    const at = index * 16;
    normal.forEach((value, axis) => planes.writeFloatLE(value, at + axis * 4));
    planes.writeFloatLE(distance, at + 12);
  });
  lumps[2] = planes;
  const brushes = Buffer.alloc(12);
  brushes.writeInt32LE(0, 0);
  brushes.writeInt32LE(6, 4);
  lumps[8] = brushes;
  const sides = Buffer.alloc(6 * 8);
  for (let index = 0; index < 6; index++) {
    sides.writeInt32LE(index, index * 8);
    sides.writeInt32LE(0, index * 8 + 4);
  }
  lumps[9] = sides;
  const directoryEnd = 8 + 17 * 8;
  let offset = directoryEnd;
  const directory = lumps.map(payload => {
    const lump = { offset, length: payload.length };
    offset += payload.length;
    return lump;
  });
  const header = Buffer.alloc(directoryEnd);
  header.write('IBSP', 0, 'latin1');
  header.writeInt32LE(46, 4);
  directory.forEach((lump, index) => {
    header.writeInt32LE(lump.offset, 8 + index * 8);
    header.writeInt32LE(lump.length, 12 + index * 8);
  });
  return Buffer.concat([header, ...lumps]);
}

test('a Half-Life BSP header names its game, and one that is not a BSP is not called one', () => {
  const bytes = quakeBox();
  assert.equal(bspInfo(bytes).engine, 'Quake');
  assert.equal(bspInfo(quake3Box()).engine, 'Quake 3');
  assert.equal(bspEngine(29), 'Quake');
  assert.equal(bspEngine(31), null);
  assert.equal(bspInfo(Buffer.from('nothing like a bsp')), null);
  // A version that matches but whose lump directory points outside the file is not a BSP either.
  const broken = quakeBox();
  broken.writeInt32LE(999999, 4);
  assert.equal(bspInfo(broken), null);
  assert.throws(() => parseBsp(Buffer.from('not a map')), /not a compiled Quake map/);
});

test('a Quake world of solid space imports as a brush, with the map\'s own entities', () => {
  const parsed = parseBsp(quakeBox(), { name: 'box.bsp' });
  assert.equal(parsed.format, 'bsp');
  assert.deepEqual(parsed.bsp, { version: 29, game: 'Quake', models: 1, brushModels: 0 });
  assert.equal(parsed.stats.brushes, 1);
  assert.equal(parsed.stats.faces, 6);
  // The entity lump is the map's own text, so the keys the mapper typed survive.
  const player = parsed.entities.find(entity => entity.properties.classname === 'info_player_start');
  assert.deepEqual(player.properties.origin, '64 64 256');

  const project = projectFromIdTechMap(parsed, { createProject });
  validateProject(project);
  assert.equal(project.title, 'Test Box');
  assert.equal(project.map.brushes.length, 1);
  const corners = brushVertices(project.map.brushes[0]);
  assert.equal(corners.length, 8, 'the solid piece is the box the six planes enclose');
  for (const corner of corners) {
    for (const value of corner) assert.ok(Math.abs(value) < 1e-3 || Math.abs(value - BOX) < 1e-3,
      `a corner of the box, not of a broken plane set: ${corner}`);
  }
  const start = project.map.entities.find(entity => entity.type === 'player');
  assert.deepEqual([start.x, start.y, start.elevation], [64, 64, 256]);
});

test('a Quake brush model — a door — imports as brushes on its own entity', () => {
  const parsed = parseBsp(quakeBox({ models: 2 }), { name: 'door.bsp' });
  assert.equal(parsed.bsp.brushModels, 1);
  const worldspawn = parsed.entities.find(entity => entity.properties.classname === 'worldspawn');
  const door = parsed.entities.find(entity => entity.properties.classname === 'func_door');
  assert.equal(worldspawn.brushes.length, 1, 'the world keeps its own piece of solid space');
  assert.equal(door.brushes.length, 1, 'the door\'s model became its brushes');
  assert.equal(door.brushes[0].name, 'func_door');
  assert.equal(parsed.stats.brushes, 2);

  const project = projectFromIdTechMap(parsed, { createProject });
  validateProject(project);
  assert.equal(project.map.brushes.length, 2);
  assert.ok(project.map.entities.some(entity => entity.mapClassname === 'func_door'), 'the entity itself survives');
  assert.deepEqual(project.map.brushes.map(brush => brush.name).sort(), ['Brush 0', 'func_door']);
});

test('a Quake 3 brush lump imports as brushes and keeps its shader name', () => {
  const parsed = parseBsp(quake3Box(), { name: 'box3.bsp' });
  assert.deepEqual(parsed.bsp, { version: 46, game: 'Quake 3', brushModels: 0 });
  assert.equal(parsed.stats.brushes, 1);
  assert.equal(parsed.stats.faces, 6);
  const project = projectFromIdTechMap(parsed, { createProject });
  validateProject(project);
  const brush = project.map.brushes[0];
  assert.equal(brush.faces.length, 6);
  assert.deepEqual(new Set(brush.faces.map(face => face.textureName)), new Set(['textures/test/floor']));
  assert.equal(brush.visible, true);
  assert.equal(brushVertices(brush).length, 8);
  assert.equal(facePolygon(brush, 0).length, 4, 'every face of the box is a quad');
  // The stored points are the face, not a seed that merely defines its plane. Building them with
  // `faceFromPlane` gave every face of every brush from a compiled map three points one unit
  // apart: the planes were right, so this map walked and the derived geometry passed, while the
  // geometry itself was a thousand units wrong.
  for (const face of brush.faces) {
    assert.ok(face.points.length >= 3, 'a face has a polygon');
    for (const point of face.points) {
      for (const value of point) assert.ok(Math.abs(value) <= BOX + 1e-6, `a corner of the box: ${point}`);
    }
  }
});

test('a level made of brushes is walkable: the player lands on solid space, not through it', t => {
  const project = projectFromIdTechMap(parseBsp(quakeBox(), { name: 'box.bsp' }), { createProject });
  const mesh = collisionMesh(project, triangulate);
  assert.equal(mesh.indices.length / 6, 12, 'six quads, two triangles each');
  // No sectors means no stand-in floor at z = 0: the brushes are the only thing to stand on.
  for (let index = 1; index < mesh.positions.length; index += 3) assert.ok(mesh.positions[index] >= 0);

  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  for (let frame = 0; frame < 240; frame++) stepRuntime(project, state, 1 / 60, new Set(), new Set());
  assert.ok(state.physics.grounded, 'the player is standing on the box');
  const height = state.player.z;
  assert.ok(height > BOX * 0.5 && height <= BOX + 8, `landed on the box top (z = ${height})`);
});

test('a brush of tool materials is solid but not drawn', () => {
  // Quake 3's `clip` is invisible and solid; importing it visible would fill the level with slabs.
  const parsed = parseBsp(quake3Box({ material: 'textures/common/clip' }), { name: 'clip.bsp' });
  const project = projectFromIdTechMap(parsed, { createProject });
  assert.equal(project.map.brushes.length, 1);
  assert.equal(project.map.brushes[0].visible, false, 'invisible in the editor and the play view');
  // Invisible is not absent: it is still what the player is stopped by.
  assert.equal(collisionMesh(project, triangulate).indices.length, 6 * 6 * 2);
});

test('a Quake 3 compiler volume is not geometry: it is skipped by name', () => {
  const parsed = parseBsp(quake3Box({ solid: false }), { name: 'hint.bsp' });
  assert.equal(parsed.stats.brushes, 0);
  assert.ok(parsed.warnings.some(warning => /compiler volumes/.test(warning)), parsed.warnings);
});

test('a truncated file is refused by name instead of importing nothing', () => {
  const bytes = quake3Box();
  assert.throws(() => parseBsp(bytes.subarray(0, 60)), /not a compiled Quake map/);
});
