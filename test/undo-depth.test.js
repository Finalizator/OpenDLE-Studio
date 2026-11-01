import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import {
  snapshotWeight, undoDepthFor, UNDO_BUDGET_BYTES, UNDO_BYTES_PER_WEIGHT, UNDO_MAX_STEPS, UNDO_MIN_STEPS,
} from '../shared/undo-depth.js';

const level = (counts) => {
  const project = createProject();
  const { vertices = 4, walls = 4, sectors = 1, entities = 2, events = 0, hud = 0 } = counts;
  project.map.vertices = Array.from({ length: vertices }, (_, i) => ({ id: `v${i}`, x: i, y: 0 }));
  project.map.walls = Array.from({ length: walls }, (_, i) => ({ id: `w${i}`, a: `v${i % vertices}`, b: `v${(i + 1) % vertices}`,
    height: 128, color: '#888888', solid: true, right: { sectorId: 'room', offsetX: 0, offsetY: 0 } }));
  project.map.sectors = Array.from({ length: sectors }, (_, i) => ({ id: i ? `room${i}` : 'room', floorHeight: 0, ceilingHeight: 128, light: 200, sky: false }));
  project.map.entities = Array.from({ length: entities }, (_, i) => ({ id: `e${i}`, type: i ? 'enemy' : 'player', name: `E${i}`, x: i, y: 0, elevation: 0, angle: 0 }));
  project.events = Array.from({ length: events }, (_, i) => ({ id: `ev${i}`, name: `R${i}`, enabled: true, once: false,
    condition: { type: 'onStart' }, conditions: [], actions: [{ type: 'showMessage', message: 'hi' }] }));
  if (hud) project.hud = { ...project.hud, elements: Array.from({ length: hud }, (_, i) => ({ id: `h${i}`, type: 'label', name: `H${i}` })) };
  return project;
};

// The regression: an imported campaign was given three undo steps by shape alone, while its snapshots
// measured 90 KB each — 39 steps given up for a tenth of a megabyte.
test('a campaign with a small level gets the full history, not three steps', () => {
  const campaign = level({ vertices: 195, walls: 188, sectors: 29, entities: 60, events: 675, hud: 233 });
  campaign.game = { active: 'MAP07', levels: Array.from({ length: 32 }, (_, i) => ({ id: `MAP${i}`, name: `MAP${i}`, data: {} })) };
  const single = level({ vertices: 195, walls: 188, sectors: 29, entities: 60, events: 675, hud: 233 });
  assert.equal(undoDepthFor(campaign), UNDO_MAX_STEPS, 'a Doom 2 level snapshot is ~90 KB: keep a normal history');
  assert.equal(undoDepthFor(campaign), undoDepthFor(single), 'being a campaign changes nothing about what a step costs');
});

test('a megawad-sized level keeps only a few steps, and the budget holds', () => {
  const megawad = level({ vertices: 20000, walls: 20000, sectors: 5000, entities: 3000, events: 2000 });
  const depth = undoDepthFor(megawad);
  // Measured at 7.2 MB a snapshot: seven steps is the whole budget, and going deeper would be a
  // tab-killing history. A tenth of the size gets ten times the steps.
  assert.ok(depth <= 8, `a 20,000-wall level snapshots megabytes at a time, got ${depth}`);
  assert.ok(depth < undoDepthFor(level({ vertices: 200, walls: 200, sectors: 20, entities: 40, events: 40 })),
    'a bigger level keeps a shorter history');
  // Whatever the depth, the estimated history stays inside the budget, and a bigger level never
  // gets a deeper history than a smaller one.
  const sizes = [{ vertices: 4, walls: 4, sectors: 1, entities: 2 }, { vertices: 500, walls: 500, sectors: 40, entities: 80, events: 60 },
    { vertices: 4000, walls: 4000, sectors: 400, entities: 600, events: 200 }, megawad];
  let previous = Infinity;
  for (const counts of sizes) {
    const project = counts === megawad ? megawad : level(counts);
    const steps = undoDepthFor(project);
    assert.ok(steps >= UNDO_MIN_STEPS && steps <= UNDO_MAX_STEPS, `${steps} is inside 3-40`);
    assert.ok(steps <= previous, 'a heavier level never gets a deeper history');
    assert.ok(steps * UNDO_BYTES_PER_WEIGHT * snapshotWeight(project) <= UNDO_BUDGET_BYTES || steps === UNDO_MIN_STEPS,
      'the estimated history fits the budget (or the level is too big for it and the floor applies)');
    previous = steps;
  }
});

test('the weight counts what a snapshot copies and ignores what it shares', () => {
  const project = level({ vertices: 10, walls: 10, sectors: 2, entities: 4, events: 3 });
  const bare = snapshotWeight(project);
  // The actor table, the campaign and the asset payloads are shared between snapshots, so they add
  // nothing: only the level's own records move the estimate.
  project.actors = { A: { name: 'A', frames: Array.from({ length: 5000 }, () => ({ duration: 1 })) } };
  project.assets = Array.from({ length: 2219 }, (_, i) => ({ id: `a${i}`, kind: 'texture', src: 'data:image/png;base64,AA' }));
  project.game = { active: 'MAP01', levels: [{ id: 'MAP01', name: 'MAP01', data: {} }] };
  assert.ok(snapshotWeight(project) - bare < 300, 'shared tables barely register');
  const before = snapshotWeight(project);
  project.events = [...project.events, ...project.events];
  assert.equal(snapshotWeight(project) - before, 3 * 6, 'one more rule is one more thing to copy');
});
