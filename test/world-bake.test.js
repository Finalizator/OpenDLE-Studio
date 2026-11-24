import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { addRoom } from '../shared/project.js';
import { bakeLevelGeometry, bakeWorldGlb } from '../shared/world-bake.js';
import { readModel } from '../shared/gltf.js';

test('world bake keeps editable source metrics and emits a valid GLB', () => {
  const project = createProject();
  addRoom(project, { x: -128, y: -128, width: 256, depth: 256 });
  const geometry = bakeLevelGeometry(project);
  assert.ok(geometry.triangles.length >= 6);
  assert.equal(geometry.sectors, project.map.sectors.length);
  assert.equal(geometry.walls, project.map.walls.length);

  const bytes = bakeWorldGlb(project);
  assert.equal(bytes.length, new DataView(bytes.buffer).getUint32(8, true));
  const glb = readModel(bytes, 'glb');
  assert.equal(glb.json.asset.version, '2.0');
  assert.equal(glb.json.meshes[0].primitives[0].attributes.POSITION, 0);
  assert.equal(glb.json.nodes[0].extras.editableSource, true);
  assert.equal(glb.json.nodes[0].extras.sectors, project.map.sectors.length);
});
