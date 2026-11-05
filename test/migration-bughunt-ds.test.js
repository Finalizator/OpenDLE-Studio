import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from '../server/store.js';
import { createProject } from '../shared/project.js';
import { MODEL_FACING_SEMANTICS } from '../shared/entity-visuals.js';
import { parseNodeFile, nodeFileText, applyNodeFile } from '../shared/node-file.js';

function scratch(t) {
  const directory = mkdtempSync(join(process.cwd(), '.migration-bughunt-ds-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A project whose one model-declaring object faces 90 while its artwork points 45° off. */
function facedProject(semantics) {
  const project = createProject();
  const truck = project.map.entities.find(entity => entity.type === 'pickup');
  Object.assign(truck, { type: 'decoration', name: 'Truck', angle: 90, modelFacing: 45 });
  project.modelFacingSemantics = semantics;
  return project;
}

/** A node file whose single node declares a 45° facing. */
function facedNodeDocument(semantics) {
  return {
    format: 'opendle-node', version: 1,
    modelFacingSemantics: semantics,
    name: 'Truck node', createdAt: new Date().toISOString(),
    origin: { x: 0, y: 0 },
    nodes: [{ id: 'truck', name: 'Truck', type: 'decoration', x: 0, y: 0, angle: 90, modelFacing: 45 }],
    joints: [], events: [],
    script: { available: 0, included: 0 },
    clips: [], sheets: [], groups: [], assets: [], shaders: [],
    warnings: [],
  };
}

// A marker this build does not know — a value this build never wrote — means an angle could mean
// something else again: opening it has to refuse, not subtract the facing as if it were an older
// document and then hide the marker.
test('a project with an unknown facing marker is refused, not silently re-migrated', t => {
  for (const marker of [1, 3]) {
    const directory = scratch(t);
    const file = join(directory, 'project.json');
    const project = facedProject(marker);
    writeFileSync(file, JSON.stringify({ project, revision: 1 }));
    assert.throws(() => new ProjectStore(file), /Unknown model facing semantics/, `marker ${marker} must be refused`);
  }
});

// The same unknown marker must not be allowed to slip in as an older document on the way in.
test('a node file with an unknown facing marker is refused instead of landing turned', () => {
  for (const marker of [1, 3]) {
    assert.throws(() => parseNodeFile(nodeFileText(facedNodeDocument(marker))),
      new RegExp(`modelFacingSemantics ${marker} is not supported`), `marker ${marker} must be refused`);
  }
});

// Guarding the future case must not break the two supported cases: a marker-less file (older) is
// moved over, and a file written by this build is taken as written.
test('supported facing markers still migrate or pass through', () => {
  // Older: the node looked as if it was at angle - facing = 45.
  const stale = facedNodeDocument(undefined);
  const target = { entities: [], joints: [] };
  applyNodeFile(target, parseNodeFile(nodeFileText(stale)), {});
  assert.equal(target.entities[0].angle, 45, 'angle - facing is the pose the old build drew');
  assert.equal(target.entities[0].modelFacing, 45, 'the declaration itself is kept');

  // Current: taken as written.
  const current = facedNodeDocument(MODEL_FACING_SEMANTICS);
  const same = { entities: [], joints: [] };
  applyNodeFile(same, parseNodeFile(nodeFileText(current)), {});
  assert.equal(same.entities[0].angle, 90, 'a file written by this build is taken as written');
});
