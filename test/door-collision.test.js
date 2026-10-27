import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { executeSpecial } from '../shared/line-specials.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/**
 * Room A (west) | door sector | room B (east). The door starts closed (ceiling on the
 * floor) and moves through a line special, which is how every imported map works.
 */
function doorway({ special = 202, args = [2, 32, 0, 16, 0], zdoom = true } = {}) {
  const project = createProject();
  project.events = [];
  const points = { v1: [-256, -32], v2: [-64, -32], v3: [-64, 32], v4: [-256, 32],
    v5: [64, -32], v6: [64, 32], v7: [256, -32], v8: [256, 32] };
  project.map.vertices = Object.entries(points).map(([id, [x, y]]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  const walls = [['v1', 'v2', 'roomA'], ['v2', 'v3', 'roomA', 'door'], ['v3', 'v4', 'roomA'], ['v4', 'v1', 'roomA'],
    ['v2', 'v5', 'door'], ['v5', 'v6', 'door', 'roomB'], ['v6', 'v3', 'door'],
    ['v5', 'v7', 'roomB'], ['v7', 'v8', 'roomB'], ['v8', 'v6', 'roomB']];
  project.map.walls = walls.map(([a, b, front, back], index) => ({
    id: `wall${index}`, a, b, height: 256, color: '#888888', solid: !back,
    ...(index === 1 ? { special, args, ...(zdoom ? { specialFormat: 'zdoom' } : {}) } : {}),
    right: side(front), ...(back ? { left: side(back) } : {}),
  }));
  project.map.sectors = [
    { id: 'roomA', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
    { id: 'door', floorHeight: 0, ceilingHeight: 0, light: 255, sky: false, tag: 2 },
    { id: 'roomB', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
  ];
  project.map.entities = [{ ...project.map.entities[0], x: -200, y: 0, angle: 0 }];
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  const door = () => state.sectors.find(sector => sector.id === 'door');
  const tick = (count = 1, keys = new Set()) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, keys);
  };
  const use = () => executeSpecial(project, state, special, args, { activator: 'player', line: 'wall1' });
  return { project, state, door, tick, use };
}

test('a sector moved by a line special updates its collision, so the player can walk through', t => {
  const scene = doorway({ args: [2, 32, 0, 16, 0] });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  assert.equal(scene.door().ceilingHeight, 0, 'the door starts closed');
  // Closed: walking east must stop at the doorway.
  scene.tick(120, new Set(['KeyW']));
  assert.ok(scene.state.player.x < -64, `blocked while closed (x=${scene.state.player.x})`);
  scene.use();
  scene.tick(60);
  assert.ok(scene.door().ceilingHeight > 100, `the door opened (${scene.door().ceilingHeight})`);
  // The collision world must follow the moved sector, not only event-declared movers.
  scene.tick(180, new Set(['KeyW']));
  assert.ok(scene.state.player.x > 64, `walked through the open door (x=${scene.state.player.x})`);
});

test('the door collision closes again with the sector', t => {
  const scene = doorway({ args: [2, 32, 0, 8, 0] });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  scene.use();
  scene.tick(60);
  assert.ok(scene.door().ceilingHeight > 100);
  // Return to the closed height and try to walk back in from the east side.
  scene.tick(300);
  assert.equal(scene.door().ceilingHeight, 0, 'the door closed again');
  scene.state.player.x = 120; scene.state.player.y = 0;
  scene.state.physics.teleport(scene.state.entities.find(entity => entity.type === 'player').id, 120, 0);
  scene.state.player.angle = Math.PI;
  scene.tick(120, new Set(['KeyW']));
  assert.ok(scene.state.player.x > 64, `blocked by the closed door (x=${scene.state.player.x})`);
});

test('Generic_Door reads kind and delay from the arguments GZDoom documents', t => {
  // tag, speed 8, kind 0 (open, wait, close), delay 16 octics (2 s), no lock
  const scene = doorway({ args: [2, 8, 0, 16, 0] });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  scene.use();
  const motion = [...scene.state.sectorMotions.values()][0];
  assert.equal(motion.wait, 2, 'a delay argument is octics (a/8 seconds)');
  // Speed 8 units per tic is divided by 8: 1 unit per tic, 35 units per second.
  assert.equal(motion.speed, 35);
  scene.tick(200);
  assert.ok(scene.door().ceilingHeight > 100, 'open');
  scene.tick(90);
  assert.ok(scene.door().ceilingHeight > 100, 'still open through the 2 s delay');
  scene.tick(420);
  assert.equal(scene.door().ceilingHeight, 0, 'closed after the delay');
});

test('the same door without a rework reads a fast speed without snapping shut', t => {
  // The real map's door: speed 82, kind 0, delay 34 octics.
  const scene = doorway({ args: [2, 82, 0, 34, 0] });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  scene.use();
  const motion = [...scene.state.sectorMotions.values()][0];
  assert.equal(motion.speed, 82 / 8 * 35, 'GZDoom divides a door speed by eight');
  assert.equal(motion.wait, 34 / 8, 'and reads the delay in octics');
  const heights = [];
  for (let frame = 0; frame < 40; frame++) { scene.tick(1); heights.push(Math.round(scene.door().ceilingHeight)); }
  const openedAt = heights.findIndex(height => height > 100);
  assert.ok(openedAt > 1, `the door animates instead of snapping (${heights.slice(0, 6).join(',')})`);
  assert.ok(openedAt < 40, 'but it still opens promptly');
});

test('an unknown Generic_Door kind is ignored like GZDoom ignores it', t => {
  const scene = doorway({ args: [2, 8, 9, 16, 0] });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  assert.equal(scene.use(), 0);
  assert.equal(scene.state.sectorMotions.size, 0);
});

test('a special without ZDoom arguments uses Doom own door speed and wait', t => {
  // Classic maps move geometry through imported event rules, but ACS LSPEC can still
  // ask for an old-style special, which must not run at ZDoom's unit scale.
  const scene = doorway({ special: 12, args: [2, 0, 0, 0, 0], zdoom: false });
  t.after(() => scene.state.physics.dispose());
  scene.tick(10);
  assert.equal(scene.use(), 1);
  const motion = [...scene.state.sectorMotions.values()][0];
  assert.equal(motion.speed, 2 * 35, 'VDOORSPEED is two units per tic');
  assert.equal(motion.returnMode, 'return');
  assert.ok(Math.abs(motion.wait - 150 / 35) < 1e-9, 'VDOORWAIT keeps it open for 150 tics');
  scene.tick(120);
  assert.ok(scene.door().ceilingHeight > 100);
});
