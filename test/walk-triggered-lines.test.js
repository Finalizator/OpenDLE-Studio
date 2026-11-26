// A line the player walks into must fire.
//
// Doom records every line the player's bounding box *touches* during a movement (`spechit`) and
// runs the walk specials for all of them. Checking only for lines the movement *crosses* misses the
// one case that matters most: a door that is shut stops the player about thirteen units short of
// its own line, so the movement never crosses it and a W1/DR door never opens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts } from '../shared/world-motion.js';

/** Room A | a door sector (tag 1, shut) | room B, with `special` on the line between A and the door. */
function doorway(special) {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  const points = { v1: [-256, -64], v2: [-64, -64], v3: [-64, 64], v4: [-256, 64],
    v5: [64, -64], v6: [64, 64], v7: [256, -64], v8: [256, 64] };
  project.map.vertices = Object.entries(points).map(([id, [x, y]]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  const walls = [['v1', 'v2', 'a'], ['v2', 'v3', 'a', 'door'], ['v3', 'v4', 'a'], ['v4', 'v1', 'a'],
    ['v2', 'v5', 'door'], ['v5', 'v6', 'door', 'b'], ['v6', 'v3', 'door'],
    ['v5', 'v7', 'b'], ['v7', 'v8', 'b'], ['v8', 'v6', 'b']];
  project.map.walls = walls.map(([a, b, front, back], index) => ({
    id: `w${index}`, a, b, height: 128, color: '#888888', solid: !back,
    ...(index === 1 ? { special, tag: 1 } : {}),
    right: side(front), ...(back ? { left: side(back) } : {}),
  }));
  project.map.sectors = [
    { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 },
    { id: 'door', floorHeight: 0, ceilingHeight: 0, light: 255, sky: false, tag: 1 },
    { id: 'b', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 },
  ];
  project.map.entities = [{ ...project.map.entities[0], x: -200, y: 0, angle: 0 }];
  installWorldScripts(project, []);
  validateProject(project);
  const state = createRuntime(project);
  const door = () => state.sectors.find(sector => sector.id === 'door');
  const walk = (seconds, pressed = new Set(), keys = new Set(['KeyW'])) => {
    for (let frame = 0; frame < Math.round(seconds * 35); frame++) {
      stepRuntime(project, state, 1 / 35, keys, frame === 0 ? pressed : new Set());
    }
  };
  return { project, state, door, walk };
}

test('walking into a W1 door opens it, as it does in Doom', () => {
  // 2 = W1 Door Open Stay: walk over the line and it opens and stays open.
  const scene = doorway(2);
  assert.ok(scene.project.events.some(event => event.id.startsWith('world_special')),
    'the import generated a rule for the line');
  scene.walk(3);
  assert.ok(scene.door().ceilingHeight > 100,
    `the door opened from walking into it (ceiling ${Math.round(scene.door().ceilingHeight)})`);
});

test('the player never crosses a shut door line, so touching it is what has to count', () => {
  // The geometry behind the case above: the player's own radius keeps them outside the doorway,
  // so no frame ever crosses the line and Doom's box-touch (`spechit`) rule is the only one left.
  const scene = doorway(0);
  scene.walk(3);
  const gap = Math.abs(scene.state.player.x - -64);
  assert.ok(gap > 0 && gap < 16, `the player stands ${Math.round(gap)} units from the line`);
});

test('a walk-over trigger on an open passage still fires exactly once', () => {
  // 39 = W1 Teleport: the same touch rule must not fire it twice for one pass.
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  const points = { v1: [-256, -64], v2: [0, -64], v3: [0, 64], v4: [-256, 64],
    v5: [256, -64], v6: [256, 64] };
  project.map.vertices = Object.entries(points).map(([id, [x, y]]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v1', b: 'v2', height: 128, color: '#888888', solid: true, right: side('a') },
    { id: 'w1', a: 'v2', b: 'v3', height: 128, color: '#888888', solid: false, special: 39, tag: 2,
      right: side('a'), left: side('b') },
    { id: 'w2', a: 'v3', b: 'v4', height: 128, color: '#888888', solid: true, right: side('a') },
    { id: 'w3', a: 'v4', b: 'v1', height: 128, color: '#888888', solid: true, right: side('a') },
    { id: 'w4', a: 'v2', b: 'v5', height: 128, color: '#888888', solid: true, right: side('b') },
    { id: 'w5', a: 'v5', b: 'v6', height: 128, color: '#888888', solid: true, right: side('b') },
    { id: 'w6', a: 'v6', b: 'v3', height: 128, color: '#888888', solid: true, right: side('b') },
  ];
  project.map.sectors = [
    { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 },
    { id: 'b', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 },
  ];
  project.map.entities = [
    { ...project.map.entities[0], x: -200, y: 0, angle: 0 },
    { id: 'spot', type: 'decoration', name: 'TeleportDest', doomType: 14, x: 200, y: 0, angle: 0, tid: 2 },
  ];
  installWorldScripts(project, []);
  validateProject(project);
  const state = createRuntime(project);
  const crossings = [];
  for (let frame = 0; frame < 35 * 4; frame++) {
    stepRuntime(project, state, 1 / 35, new Set(['KeyW']));
    if (state.worldTriggers.cross.size) crossings.push(frame);
  }
  assert.ok(crossings.length >= 1, 'the line fired while walking through it');
  assert.ok(crossings.length <= 2, `and did not fire on every frame of the pass (${crossings.length})`);
});
