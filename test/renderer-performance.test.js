import test from 'node:test';
import assert from 'node:assert/strict';
import { createSectorIndex, sectorAt, containsPoint, sectorGeometry, surfaceMaterials } from '../shared/sectors.js';
import { wallSegments } from '../shared/runtime.js';
import { createSpriteIndex, spriteIndex, clipFrame, spriteView, spriteAsset, setSpriteState } from '../shared/sprite-animation.js';
import { createFrameStats, createDatasetWriter, createFrameBudget } from '../shared/perf.js';
import { readFileSync } from 'node:fs';

// Reference implementations of the pre-index behaviour, kept here so the indexed
// helpers are compared against the exact semantics they replaced.
function referenceSectorAt(sectors, x, y) {
  return sectors.find(sector => {
    const b = sector.bounds;
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && containsPoint(sector.rings, x, y);
  });
}

function gridSectors(columns, rows, size = 64) {
  const sectors = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const minX = column * size, minY = row * size;
    const rings = [[{ x: minX, y: minY }, { x: minX + size, y: minY }, { x: minX + size, y: minY + size }, { x: minX, y: minY + size }]];
    sectors.push({ id: `s${row}_${column}`, rings, floorHeight: 0, ceilingHeight: 128, light: 160,
      bounds: { minX, minY, maxX: minX + size, maxY: minY + size } });
  }
  return sectors;
}

test('sector index answers exactly like the linear scan while probing far fewer sectors', () => {
  const sectors = gridSectors(40, 40);
  const index = createSectorIndex(sectors);
  const random = (() => { let seed = 1234567; return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296; })();
  for (let probe = 0; probe < 4000; probe++) {
    const x = random() * 40 * 64 * 1.2 - 500, y = random() * 40 * 64 * 1.2 - 500;
    assert.equal(index.at(x, y), referenceSectorAt(sectors, x, y), `probe ${x},${y}`);
    assert.equal(sectorAt(sectors, x, y), referenceSectorAt(sectors, x, y), 'cached helper matches');
  }
  const largest = Math.max(...index.cells.map(cell => cell.length));
  assert.ok(largest < sectors.length / 8, `grid buckets stay small (${largest} of ${sectors.length})`);
  assert.ok(index.oversized.length < sectors.length / 8, 'few sectors need the oversized fallback');
});

test('sector index keeps array order for overlapping sectors and tolerates tiny maps', () => {
  const big = { id: 'big', rings: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]],
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, floorHeight: 0, ceilingHeight: 64 };
  const small = { id: 'small', rings: [[{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }]],
    bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 }, floorHeight: 8, ceilingHeight: 40 };
  for (const sectors of [[big, small], [small, big]]) {
    const index = createSectorIndex(sectors);
    assert.equal(index.at(15, 15), referenceSectorAt(sectors, 15, 15));
    assert.equal(index.at(15, 15), sectors[0], 'first sector in array order wins');
    assert.equal(index.at(15, 15).id, sectors[0].id);
  }
  for (const sectors of [[], [big], [{ ...big, bounds: { minX: 5, minY: 5, maxX: 5, maxY: 5 } }]]) {
    assert.equal(createSectorIndex(sectors).at(12, 12), referenceSectorAt(sectors, 12, 12));
  }
});

test('sector index stays live when a moving sector changes height', () => {
  const sectors = gridSectors(4, 4);
  const index = createSectorIndex(sectors);
  const target = sectors[5];
  target.floorHeight = 64;
  assert.equal(index.at(70, 70).floorHeight, 64);
  assert.equal(sectorAt(sectors, 70, 70).floorHeight, 64);
});

function spriteProject() {
  const rotations = Array.from({ length: 8 }, (_, view) => ({ assetId: `SPR${view}`, flip: view > 4 }));
  return {
    assets: [
      { id: 'GUARD', name: 'GUARDA1', width: 40, height: 56, offsetX: 20, offsetY: 56, rotations },
      { id: 'WALKA', name: 'WALKA0', width: 40, height: 56, offsetX: 20, offsetY: 56 },
      { id: 'WALKB', name: 'WALKB0', width: 40, height: 56, offsetX: 20, offsetY: 56 },
      { id: 'SPR0', name: 'SPR00', width: 40, height: 56, offsetX: 20, offsetY: 56 },
      { id: 'SPR1', name: 'SPR10', width: 40, height: 56, offsetX: 20, offsetY: 56 },
    ],
    spriteClips: [
      { id: 'walk', name: 'walk', frames: ['WALKA', 'WALKB'], seconds: .2, loop: true },
      { id: 'attack', name: 'attack', frames: ['WALKA', 'WALKB'], seconds: .2, loop: false },
    ],
  };
}

function referenceView(project, state, entity, viewer) {
  const animation = state.spriteAnimations.get(entity.id);
  const clipId = animation?.clipId || entity.spriteStates?.stand;
  let assetId = entity.spriteAsset;
  if (clipId) {
    const clip = project.spriteClips.find(clip => clip.id === clipId);
    const elapsed = animation ? state.time - animation.start : state.time;
    const duration = clip.frames.length * clip.seconds;
    const time = clip.loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 1e-8);
    if (clip.frames[Math.floor(time / clip.seconds)]) assetId = clip.frames[Math.floor(time / clip.seconds)];
  }
  const rotations = project.assets.find(asset => asset.id === assetId)?.rotations;
  if (!rotations) return { assetId, flip: false };
  const bearing = Math.atan2(viewer.y - entity.y, viewer.x - entity.x) * 180 / Math.PI;
  const rotation = ((Math.floor(((entity.angle || 0) - bearing + 22.5) / 45) % 8) + 8) % 8;
  return { assetId: rotations[rotation].assetId, flip: Boolean(rotations[rotation].flip) };
}

test('sprite index resolves clips, rotation views and flips exactly like the linear lookups', () => {
  const project = spriteProject();
  const index = createSpriteIndex(project);
  const state = { time: 0, player: { x: 0, y: 0 }, spriteAnimations: new Map(), };
  const entity = { id: 'guard', type: 'enemy', angle: 0, x: 64, y: 0, spriteAsset: 'GUARD', spriteStates: { stand: 'walk' } };
  for (let step = 0; step < 40; step++) {
    state.time = step * .05;
    for (let facing = 0; facing < 16; facing++) {
      entity.angle = facing * 22.5;
      for (const [viewerX, viewerY] of [[0, 0], [128, 0], [-64, 96], [64, -96]]) {
        const indexed = index.view(state, entity, { x: viewerX, y: viewerY });
        assert.deepEqual({ assetId: indexed.assetId, flip: indexed.flip },
          referenceView(project, state, entity, { x: viewerX, y: viewerY }), `step ${step} facing ${facing}`);
        assert.equal(index.view(state, entity, { x: viewerX, y: viewerY }), indexed, 'view reuses one scratch object');
      }
    }
  }
  assert.equal(index.frame('walk', 0), index.frame('walk', 0), 'frame reuses one scratch object');
  assert.deepEqual({ ...index.frame('walk', 0) }, { assetId: 'WALKA', finished: false });
  assert.equal(index.frame('walk', .25).assetId, 'WALKB');
  assert.deepEqual({ ...index.frame('attack', 10) }, { assetId: 'WALKB', finished: true });
  assert.equal(clipFrame(project, 'missing', 0), null, 'unknown clips still report null');
  assert.equal(clipFrame(project, 'walk', .25).assetId, 'WALKB');
});

test('public sprite helpers keep working through the cached index and refresh with the project', () => {
  const project = spriteProject();
  const state = { time: .25, player: { x: 0, y: 0 }, spriteAnimations: new Map() };
  const entity = { id: 'guard', type: 'enemy', angle: 0, x: 64, y: 0, spriteAsset: 'GUARD', spriteStates: { stand: 'walk', death: 'attack' } };
  const cached = spriteIndex(project);
  assert.equal(spriteIndex(project), cached, 'the index is cached per project');
  assert.equal(spriteAsset(project, state, entity), 'WALKB');
  assert.deepEqual(spriteView(project, state, entity), referenceView(project, state, entity));
  setSpriteState(project, state, entity, 'death');
  state.time = 100;
  assert.deepEqual(spriteView(project, state, entity), referenceView(project, state, entity));
  project.spriteClips.push({ id: 'extra', name: 'extra', frames: ['SPR0'], seconds: 1, loop: true });
  assert.notEqual(spriteIndex(project), cached, 'adding clips rebuilds the index');
  assert.equal(clipFrame(project, 'extra', 0).assetId, 'SPR0');
});

test('frame statistics track a rolling maximum and stall count without allocating', () => {
  const stats = createFrameStats({ window: 4, stallMs: 20 });
  for (const value of [10, 300, 12, 11]) stats.push(value);
  assert.deepEqual({ ...stats.summary(), mean: Math.round(stats.summary().mean * 100) / 100 },
    { frames: 4, window: 4, last: 11, max: 300, mean: 83.25, stalls: 1, stallMs: 20,
      sessionFrames: 4, sessionStalls: 1, worst: 300 });
  stats.push(13);
  assert.equal(stats.max, 300, 'the stall is still inside the window');
  stats.push(14);
  assert.equal(stats.max, 14, 'the stall leaves the window and the maximum recomputes');
  assert.equal(stats.stalls, 0);
  stats.push(40);
  assert.equal(stats.max, 40); assert.equal(stats.stalls, 1);
  assert.equal(stats.summary().last, 40);
  stats.reset();
  assert.deepEqual({ ...stats.summary() },
    { frames: 0, window: 4, last: 0, max: 0, mean: 0, stalls: 0, stallMs: 20, sessionFrames: 0, sessionStalls: 0, worst: 0 });
  for (const value of [Number.NaN, -5, Infinity]) stats.push(value);
  assert.equal(stats.max, 0, 'invalid samples are ignored');
});

test('dataset writer only touches the canvas when a value actually changed', () => {
  const dataset = {};
  let writes = 0;
  const canvas = { dataset: new Proxy(dataset, { set(target, key, value) { writes++; target[key] = value; return true; } }) };
  const write = createDatasetWriter(canvas);
  assert.equal(write('frameMs', 12.5), true);
  assert.equal(write('frameMs', '12.5'), false, 'equal values compare as the same string');
  assert.equal(write('triangles', 1200), true);
  assert.equal(dataset.frameMs, '12.5');
  assert.equal(dataset.triangles, '1200');
  assert.equal(writes, 2);
});

test('surface material index covers the door and lift faces that appear after a sector moves', () => {
  const project = {
    version: 1,
    environment: { floor: '#272c34' },
    map: {
      vertices: [{ id: 'v0', x: 0, y: 0 }, { id: 'v1', x: 128, y: 0 }, { id: 'v2', x: 128, y: 128 }, { id: 'v3', x: 0, y: 128 },
        { id: 'v4', x: 256, y: 0 }, { id: 'v5', x: 256, y: 128 }, { id: 'v6', x: 512, y: 0 }, { id: 'v7', x: 512, y: 128 }],
      sectors: [
        { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 160, floorAsset: 'FLOOR_A', ceilingAsset: 'CEIL_A' },
        { id: 'b', floorHeight: 0, ceilingHeight: 128, light: 96, floorAsset: 'FLOOR_B', ceilingAsset: 'CEIL_B' },
      ],
      walls: [
        { id: 'w1', a: 'v0', b: 'v1', color: '#9aa3ab', right: { sectorId: 'a', middle: 'WALL_A' } },
        { id: 'w2', a: 'v1', b: 'v2', color: '#9aa3ab', right: { sectorId: 'a', middle: 'DOOR', upper: 'UPPER_A', lower: 'LOWER_A' },
          left: { sectorId: 'b', middle: 'DOOR', upper: 'UPPER_B', lower: 'LOWER_B' } },
        { id: 'w3', a: 'v2', b: 'v3', color: '#9aa3ab', right: { sectorId: 'a', middle: 'WALL_A' } },
        { id: 'w4', a: 'v3', b: 'v0', color: '#9aa3ab', right: { sectorId: 'a', middle: 'WALL_A' } },
        { id: 'w5', a: 'v1', b: 'v4', color: '#9aa3ab', right: { sectorId: 'b', middle: 'WALL_B' } },
        { id: 'w6', a: 'v4', b: 'v5', color: '#9aa3ab', right: { sectorId: 'b', middle: 'WALL_B' } },
        { id: 'w7', a: 'v5', b: 'v2', color: '#9aa3ab', right: { sectorId: 'b', middle: 'WALL_B' } },
        { id: 'w8', a: 'v6', b: 'v7', color: '#808080', solid: true, height: 128, assetId: 'ROCK' },
      ],
      entities: [],
    },
    events: [], eventSheets: [], eventGroups: [], assets: [], spriteClips: [], hud: null, variables: {},
  };
  const geometry = sectorGeometry(project);
  const surfaces = surfaceMaterials(geometry, wallSegments(project), project.environment);
  const keys = new Set(surfaces.map(surface => `${surface.assetId}/${surface.level}/${surface.color}/${surface.masked}`));
  // Planes keep the height of their own sector, so the build already draws them.
  assert.ok(keys.has('FLOOR_A/160/#272c34/false'));
  assert.ok(keys.has('CEIL_B/96/#6d7680/false'));
  // Middle textures keep the front sector light, upper/lower faces of a closed door
  // only exist once it opens, so they must be warmed with the front light.
  assert.ok(keys.has('DOOR/160/#9aa3ab/true'));
  assert.ok(keys.has('DOOR/96/#9aa3ab/true'));
  assert.ok(keys.has('UPPER_A/160/#9aa3ab/false'));
  assert.ok(keys.has('LOWER_A/160/#9aa3ab/false'));
  assert.ok(keys.has('UPPER_B/96/#9aa3ab/false'));
  assert.ok(keys.has('LOWER_B/96/#9aa3ab/false'));
  assert.ok(keys.has('ROCK/255/#808080/false'));
  assert.equal(surfaces.length, keys.size, 'duplicate surfaces are collapsed');
  assert.deepEqual(surfaceMaterials([], [], {}), []);
});

test('a stalled frame reports which phase was slow, not just how long it took', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(render, /let frameUpdateMs = 0, frameDrawMs = 0, slowFrame = null/);
  assert.match(render, /frameUpdateMs = clock\(\) - frameStarted;/, 'update work is timed separately');
  assert.match(render, /frameDrawMs = clock\(\) - drawStarted;/, 'drawing is timed separately');
  // The snapshot is taken on the stall itself, so it describes the worst frame and
  // not whichever frame happened to come last.
  assert.match(render, /if \(elapsed >= frameStats\.stallMs\) slowFrame = \{/);
  for (const field of ['update', 'draw', 'rebuild', 'programs', 'textures', 'geometries', 'heapMb']) {
    assert.ok(render.includes(`${field}:`), `slow frame keeps ${field}`);
  }
  assert.match(render, /perf: \(\) => \(\{ \.\.\.frameStats\.summary\(\), slowFrame \}\)/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /slowFrame: perf\.slowFrame \? \{ \.\.\.perf\.slowFrame \} : null/,
    'the playtest log carries the breakdown');
});

test('the frame budget keeps the worst frame together with what it was doing', () => {
  const budget = createFrameBudget({ slowMs: 100 });
  assert.equal(budget.push(16, { step: 4, audio: 1, render: 9, hud: 1 }), null, 'a normal frame is not reported');
  assert.deepEqual(budget.push(240, { step: 20, audio: 2, render: 200, hud: 4 }),
    { ms: 240, step: 20, audio: 2, render: 200, hud: 4 });
  assert.equal(budget.slow, 1);
  // Only a new worst frame replaces the snapshot.
  budget.push(120, { step: 5, audio: 1, render: 100, hud: 2 });
  assert.equal(budget.slowest.render, 200);
  assert.equal(budget.worst, 240);
  assert.equal(budget.frames, 3);
  budget.reset();
  assert.equal(budget.slowest, null);
  assert.equal(budget.worst, 0);
});

test('a slow simulation step keeps the stage breakdown that explains it', async () => {
  const { createProject } = await import('../shared/project.js');
  const { createRuntime, stepRuntime, SLOW_STEP_MS } = await import('../shared/runtime.js');
  const project = createProject(), session = createRuntime(project);
  assert.equal(session.slowStep, null, 'a normal step is not recorded');
  // Every clock read advances 200 ms, so each stage looks like a stall without
  // needing a simulation slow enough to reproduce one.
  const realPerformance = globalThis.performance;
  let clock = 0;
  globalThis.performance = { now: () => (clock += 200) };
  try { stepRuntime(project, session, 1 / 60, new Set()); }
  finally { globalThis.performance = realPerformance; }
  const slow = session.slowStep;
  assert.ok(slow, 'a step over the threshold is kept');
  assert.ok(slow.ms >= SLOW_STEP_MS);
  for (const stage of ['interface', 'hud', 'sectors', 'use', 'rules', 'physics', 'afterRules', 'actors', 'projectiles', 'effects']) {
    assert.ok(stage in slow, `the step keeps its ${stage} stage`);
  }
  // Never part of a save: the accessor must stay out of JSON and out of key lists.
  assert.ok(!Object.keys(session).includes('slowStep'));
  assert.equal(JSON.stringify(session).includes('slowStep'), false);
});

test('the preview loop times the whole frame, not only the renderer', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // A pause in the physics step, the audio mixer or the HUD is invisible to the
  // renderer's own counters, so every section of the loop is timed.
  for (const part of ['step', 'audio', 'render', 'hud']) {
    assert.match(app, new RegExp(`frameParts\\.${part} = performance\\.now\\(\\)`), `the ${part} section is timed`);
  }
  assert.match(app, /if \(frameBudget\.push\(performance\.now\(\) - frameStart, frameParts\)\) reportSlowFrame\(\);/);
  // Tasks the browser runs between frames (garbage collection, decodes, layout) are
  // reported by the browser itself.
  assert.match(app, /new PerformanceObserver\(list =>/);
  assert.match(app, /watch\.observer\.observe\(\{ entryTypes: \['longtask'\] \}\)/);
  assert.match(app, /stopLongTasks\(\);/);
  // Both reach the playtest log, so a report explains the hitch without a profiler.
  assert.match(app, /slowestFrame: frameBudget\.slowest/);
  assert.match(app, /longTaskWorstMs: Math\.round\(longTaskWatch\.worst\)/);
  // A pause is a collection when the heap is huge, and a frozen tab when the page is
  // hidden: both are recorded next to the frame that stalled.
  assert.match(app, /heapMb: performance\.memory \?/);
  assert.match(app, /hidden: document\.hidden/);
  assert.match(app, /stepStages: runtime\?\.slowStep \?\? null/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
});

test('a play preview draws nothing for a thing that carries no artwork', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  // A grey placeholder billboard is right in the editor and wrong in a running game:
  // MAP02 puts a teleport destination 68 units in front of the player start, and Doom
  // draws nothing for it.
  assert.match(render, /if \(!editor && !entity\.spriteAsset\) \{/);
  assert.match(render, /unrenderable\.add\(entity\.id\);/);
  assert.match(render, /withoutArtwork\.push\(\{ id: entity\.id,/);
  // The log still names them, because missing artwork is an import problem.
  assert.match(render, /hiddenWithoutArtwork: unrenderable\.size/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /playtestLog\.once\('render:without-artwork'/);
});

test('a preview snapshot drops the levels it can never play', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // The other levels' data is most of an imported game and a level change rebuilds a
  // snapshot from the editor project, so the copy inside a running preview only made
  // the collector walk tens of megabytes every cycle.
  assert.match(app, /for \(const level of snapshot\.game\?\.levels \|\| \[\]\) \{/);
  assert.match(app, /if \(level\.id === snapshot\.game\.active\) continue;/);
  assert.match(app, /level\.data = \{\};/);
  // It has to happen after a save from another level has been restored into it.
  const restore = app.indexOf('restoreGameSave(snapshot, savedGame, identity)');
  const trim = app.indexOf('level.data = {};');
  assert.ok(restore > 0 && trim > restore, 'the snapshot is trimmed after the save is restored');
  // A slow frame reports the heap it started with, so a collection is recognisable.
  assert.match(app, /frameParts\.heapBefore = performance\.memory/);
});

test('the render buffer ignores a few pixels of layout wobble', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(render, /const RENDER_SIZE_TOLERANCE = 8;/);
  assert.match(render, /Math\.abs\(width - appliedWidth\) > RENDER_SIZE_TOLERANCE \|\| Math\.abs\(height - appliedHeight\) > RENDER_SIZE_TOLERANCE/);
  // A real resize must still get through on the first call.
  assert.match(render, /if \(!appliedWidth \|\| !appliedHeight\) return true;/);
});
