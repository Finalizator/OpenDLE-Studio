import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { useWall } from '../shared/world-motion.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });

/**
 * Cells laid out along x and open to each other in the order they are listed. An
 * opening is a plain passage unless it is listed as blocked (a line with the blocking
 * flag) or as a door (a line carrying a special), which a real map has in front of a
 * door.
 */
function corridor(cells, { blocked = [], doors = [], physics = true } = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [];
  project.map.sectors = cells.map(cell => ({ id: cell.id, floorHeight: 0, ceilingHeight: cell.ceiling, light: 160, sky: false, tag: 0 }));
  project.map.walls = [];
  const corner = (id, x, y) => { project.map.vertices.push({ id, x, y }); return id; };
  cells.forEach((cell, index) => {
    const a = corner(`c${index}a`, cell.from, -64), b = corner(`c${index}b`, cell.to, -64);
    const c = corner(`c${index}c`, cell.to, 64), d = corner(`c${index}d`, cell.from, 64);
    const wall = (id, from, to) => project.map.walls.push({ id, a: from, b: to, height: 128, color: '#888888', solid: true, special: 0, right: side(cell.id) });
    wall(`w${index}s`, a, b); wall(`w${index}n`, c, d);
    if (index === 0) wall(`w${index}w`, d, a);
    if (index === cells.length - 1) { wall(`w${index}e`, b, c); return; }
    project.map.walls.push({ id: `open${index}`, a: b, b: c, height: 128, color: '#888888',
      solid: blocked.includes(index), special: doors.includes(index) ? 1 : 0,
      right: side(cell.id), left: side(cells[index + 1].id) });
  });
  project.map.entities = [{ ...project.map.entities[0], x: cells[0].from + 56, y: 0, angle: 0 }];
  validateProject(project);
  const state = createRuntime(project);
  if (physics) state.physics = createPhysics(project, state, R, triangulate);
  const tick = (count = 1, keys = new Set()) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, keys);
  };
  return { project, state, tick, dispose: () => state.physics?.dispose() };
}

test('a gap exactly as tall as the player is walkable, like Doom P_CheckPosition', t => {
  // Doom only refuses a gap smaller than the player height, so the 56 unit niche in
  // front of the MAP01 exit sign must not stop the player.
  const scene = corridor([
    { id: 'roomA', from: -256, to: -64, ceiling: 128 },
    { id: 'niche', from: -64, to: 0, ceiling: 56 },
    { id: 'roomB', from: 0, to: 256, ceiling: 128 },
  ]);
  t.after(scene.dispose);
  scene.tick(4);
  scene.tick(200, new Set(['KeyW']));
  assert.ok(scene.state.player.x > 0, `walked through the 56 unit niche (x=${Math.round(scene.state.player.x)})`);
});

test('a gap under the player height still blocks', t => {
  const scene = corridor([
    { id: 'roomA', from: -256, to: -64, ceiling: 128 },
    { id: 'niche', from: -64, to: 0, ceiling: 48 },
    { id: 'roomB', from: 0, to: 256, ceiling: 128 },
  ]);
  t.after(scene.dispose);
  scene.tick(4);
  scene.tick(200, new Set(['KeyW']));
  assert.ok(scene.state.player.x < -64, `blocked by the 48 unit niche (x=${Math.round(scene.state.player.x)})`);
});

// The player stands in the first cell with a blocked line 20 units ahead and a door
// line 50 units ahead, both inside the 64 unit use reach.
function useScene() {
  const scene = corridor([
    { id: 'roomA', from: -256, to: -100, ceiling: 128 },
    { id: 'niche', from: -100, to: -70, ceiling: 128 },
    { id: 'roomB', from: -70, to: 256, ceiling: 128 },
  ], { blocked: [0], doors: [1], physics: false });
  scene.state.player.x = -120; scene.state.player.y = 0; scene.state.player.angle = 0;
  return scene;
}

test('use reports the nearest wall and the nearest wall that carries a special', t => {
  const used = useWall(useScene().state);
  assert.equal(used.use, 'open0', 'a blocked line in front is the nearest wall');
  assert.equal(used.special, 'open1', 'but the door line behind it is what gets used');
});

test('use finds a door line the player is not aiming at, from the Doom use box', t => {
  const scene = useScene();
  // Standing beside the door and looking away from it: Doom activates every line in
  // reach, so the press must not need a perfect aim.
  scene.state.player.x = -80; scene.state.player.angle = Math.PI;
  assert.equal(useWall(scene.state).special, 'open1');
  // Out of reach: nothing is activated.
  scene.state.player.x = 100;
  assert.equal(useWall(scene.state).special, null);
});
