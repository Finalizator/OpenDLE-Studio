import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from './shared/project.js';
import { createRuntime, stepRuntime } from './shared/runtime.js';
import { createPhysics } from './shared/physics.js';
import { buildSurfTestMap } from './shared/scriptlets.js';
import { surfRampSurface } from './shared/engine-script.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(p => new Vector2(p.x, p.y)), holes.map(r => r.map(p => new Vector2(p.x, p.y))));
const project = buildSurfTestMap(createProject());
const ramp = project.map.entities.find(e => e.id === project.sourceMovementRamps[0]);
const s = surfRampSurface(ramp);
const low = s.lowEdgeX, high = s.highEdgeX, y0 = ramp.y - ramp.physics.depth / 2, y1 = ramp.y + ramp.physics.depth / 2;
const start = project.map.entities.find(e => e.type === 'player');
console.log('room', project.map.vertices.map(v => `${v.x},${v.y}`).join(' '), 'ceiling', project.map.sectors[0].ceilingHeight);
console.log('ramp  low', low.toFixed(0), 'high', high.toFixed(0), 'y', y0.toFixed(0), '..', y1.toFixed(0),
  'surface low', s.heightAt(low).toFixed(0), 'high', s.heightAt(high).toFixed(0));
console.log('start', start.x.toFixed(0), start.y.toFixed(0), start.elevation.toFixed(0), 'angle', start.angle);
for (const id of project.sourceMovementRamps) {
  const r = project.map.entities.find(e => e.id === id);
  const rs = surfRampSurface(r);
  console.log('  ramp', id, 'x', rs.lowEdgeX.toFixed(0), '..', rs.highEdgeX.toFixed(0), 'y', (r.y - r.physics.depth / 2).toFixed(0), '..', (r.y + r.physics.depth / 2).toFixed(0),
    'surface', rs.heightAt(rs.lowEdgeX).toFixed(0), '->', rs.heightAt(rs.highEdgeX).toFixed(0), 'tilt', r.modelTilt.roll);
}
const bridge = project.map.entities.find(e => e.id === 'surf_bridge');
console.log('  bridge top', bridge.physics.height, 'x', bridge.x, 'width', bridge.physics.width);

function make() {
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.physics = createPhysics(project, state, R, triangulate);
  return state;
}

// 1. slide from the spawn
{
  const state = make();
  stepRuntime(project, state, 1 / 60, new Set());
  const z0 = state.player.z;
  let airborne = 0, top = 0, penetration = 0; const trail = [];
  for (let i = 0; i < 90; i++) {
    stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
    const p = state.player;
    if (!state.physics.grounded) airborne++;
    top = Math.max(top, state.speed || 0);
    if (p.x > Math.min(low, high) && p.x < Math.max(low, high)) penetration = Math.max(penetration, s.heightAt(p.x) - p.z);
    if (i % 12 === 0) trail.push(`${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`);
  }
  console.log('1. slide from spawn   ', trail.join(' '), `| airborne ${airborne} | top ${top.toFixed(0)} | deepest ${penetration.toFixed(1)} | final z ${state.player.z.toFixed(0)}`);
  state.physics.dispose();
}

// 2. the whole loop: slide down, walk back up the return ramp, cross the bridge, ride again
{
  const back = project.map.entities.find(e => e.id === 'surf_return_ramp');
  const backSurface = surfRampSurface(back);
  const state = make();
  const walkTo = (fx, fy) => {
    let stuck = 0, last = null;
    for (let i = 0; i < 900; i++) {
      const p = state.player, dx = fx - p.x, dy = fy - p.y;
      if (Math.hypot(dx, dy) < 24) return { reached: true, tics: i };
      state.player.angle = Math.atan2(dy, dx) * 180 / Math.PI;
      stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
      const now = `${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`;
      if (now === last) stuck++; else stuck = 0;
      last = now;
      if (stuck > 60) return { reached: false, tics: i, at: now };
    }
    return { reached: false, at: `${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}` };
  };
  const steps = [];
  // slide down
  for (let i = 0; i < 80; i++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  steps.push(`after slide ${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`);
  // to the bottom of the return ramp, then up it
  steps.push('to return ramp: ' + JSON.stringify(walkTo(backSurface.lowEdgeX + 60, back.y)));
  steps.push('up the ramp: ' + JSON.stringify(walkTo(backSurface.highEdgeX + 20, back.y)));
  steps.push(`top of return ramp ${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`);
  // across the bridge to the surf ramp
  steps.push('across bridge: ' + JSON.stringify(walkTo(ramp.x, -150)));
  steps.push(`back on the surf ramp ${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`);
  // and down again
  state.player.angle = 0;
  for (let i = 0; i < 80; i++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  steps.push(`second slide ends ${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`);
  console.log('2. the loop\n   ' + steps.join('\n   '));
  state.physics.dispose();
}

// 3. penetration over every input combination, from the spawn
for (const keys of [['KeyW'], ['KeyS'], ['KeyA'], ['KeyD'], ['KeyW','KeyA'], ['KeyW','KeyD'], ['KeyS','KeyA'], ['KeyS','KeyD'], []]) {
  const state = make();
  let deepest = 0, belowFloor = 0;
  for (let i = 0; i < 150; i++) {
    stepRuntime(project, state, 1 / 60, new Set(keys));
    const p = state.player;
    if (p.x > Math.min(low, high) && p.x < Math.max(low, high) && p.y > y0 && p.y < y1) deepest = Math.max(deepest, s.heightAt(p.x) - p.z);
    if (p.z < -1 && state.physics.grounded) belowFloor++;
  }
  console.log(`3. ${keys.join('+') || 'idle'}`.padEnd(22), `deepest ${deepest.toFixed(1)} | below floor ${belowFloor} | final ${state.player.x.toFixed(0)},${state.player.y.toFixed(0)},${state.player.z.toFixed(0)}`);
  state.physics.dispose();
}

// 4. jump heights from the floor, several frame rates
{
  const byFps = {};
  for (const fps of [35, 60, 144]) {
    const apices = [];
    for (let trial = 0; trial < 3; trial++) {
      const state = make();
      state.physics.teleport('player', 380, 200, 0);
      for (let i = 0; i < 20; i++) stepRuntime(project, state, 1 / fps, new Set());
      const ground = state.player.z;
      stepRuntime(project, state, 1 / fps, new Set(['Space']), new Set(['Space']));
      let peak = state.player.z;
      for (let i = 0; i < fps; i++) { stepRuntime(project, state, 1 / fps, new Set()); peak = Math.max(peak, state.player.z); }
      apices.push(+(peak - ground).toFixed(1));
      state.physics.dispose();
    }
    byFps[fps] = apices;
  }
  console.log('4. jump apex by fps   ', JSON.stringify(byFps));
}
