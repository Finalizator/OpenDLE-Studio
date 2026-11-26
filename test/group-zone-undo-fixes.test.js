// Four unrelated mistakes, each found by probing a module against its own stated contract.
//
// Copying an object with a long name produced a name past the 100-character limit, so the paste was
// refused. An object that carries both a mesh node and a round area reported the mesh's width and
// depth for a volume its area tests with the radius. A capsule shorter than its own diameter was
// tested as a 96-unit box while the editor drew (and Rapier built) a 400-unit sphere. And the undo
// budget weighed a menu tree by `.length` — undefined, because it is an object — while charging
// every snapshot for a campaign the snapshots share.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, cloneProjectForEdit } from '../shared/project.js';
import { cloneEntitiesForPaste } from '../shared/entity-groups.js';
import { readInstanceProperty } from '../shared/instance-properties.js';
import { areaVolume, areaContains } from '../shared/areas.js';
import { snapshotWeight, undoDepthFor } from '../shared/undo-depth.js';

test('copying an object with a long name keeps the copy inside the name limit', () => {
  const project = createProject();
  project.map.entities.push({ id: 'a', name: 'Y'.repeat(98), type: 'decoration', x: 0, y: 0, angle: 0 });
  validateProject(project);
  const { entities } = cloneEntitiesForPaste(project, [project.map.entities.at(-1)], { x: 100, y: 100 });
  assert.ok(entities[0].name.length <= 100, `the copy is named ${entities[0].name.length} characters`);
  project.map.entities.push(...entities);
  validateProject(project);
});

test('a round area reports the dimensions its volume is tested with', () => {
  const project = createProject();
  const area = { shape: 'sphere', width: 96, height: 400, depth: 96, radius: 200 };
  const meshed = { id: 'b', type: 'decoration', x: 0, y: 0, angle: 0, area,
    mesh: { shape: 'box', width: 64, height: 64, depth: 64, color: '#ffffff' } };
  assert.equal(readInstanceProperty(project, null, meshed, 'width'), 400);
  assert.equal(readInstanceProperty(project, null, meshed, 'depth'), 400);
});

test('a capsule is never shorter than its diameter, so the drawn zone is the tested zone', () => {
  const zone = { id: 'z', type: 'zone', x: 0, y: 0, angle: 0,
    area: { shape: 'capsule', width: 96, height: 96, depth: 96, radius: 200 } };
  const volume = areaVolume(zone, 0);
  assert.ok(Math.abs(volume.half.height - 200) < .001, `the half height is ${volume.half.height}`);
  // A player whose feet are at 150 stands inside the capsule the editor draws.
  assert.ok(areaContains(volume, { x: 0, y: 0, z: 150 }));
});

test('the undo budget weighs the menu text a snapshot copies', () => {
  const project = createProject();
  project.events = [];
  project.gameMenus = { version: 1, screens: ['main'], entry: 'main', elementIds: [], sources: [] };
  validateProject(project);
  const before = snapshotWeight(project);
  project.gameMenus.sources = [{ name: 'MENUDEF.txt', source: 'x'.repeat(200000) }];
  validateProject(project);
  assert.ok(snapshotWeight(project) > before + 40, `200 KB of menu text weighs something (${snapshotWeight(project) - before})`);
});

test('a campaign gets the same undo depth as the same map on its own', () => {
  const make = levels => {
    const project = createProject();
    project.map.vertices = Array.from({ length: 1200 }, (_, index) => ({ id: `v${index}`, x: index, y: 0 }));
    project.map.walls = Array.from({ length: 1200 }, (_, index) => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 1200}`,
      height: 128, color: '#888888', solid: true, right: { sectorId: 'room', offsetX: 0, offsetY: 0 } }));
    project.map.sectors = Array.from({ length: 300 }, (_, index) => ({ id: index ? `s${index}` : 'room',
      floorHeight: 0, ceilingHeight: 128, light: 200, sky: false }));
    if (levels) project.game = { active: 'MAP01', levels: Array.from({ length: levels }, (_, index) => ({ id: `MAP${index}`,
      name: `MAP${index}`, data: { map: { vertices: [], walls: [], sectors: [], entities: [] } } })) };
    return project;
  };
  const single = make(0), campaign = make(32);
  assert.equal(cloneProjectForEdit(campaign).game, campaign.game, 'the campaign is shared, not copied');
  assert.equal(undoDepthFor(campaign), undoDepthFor(single));
});
