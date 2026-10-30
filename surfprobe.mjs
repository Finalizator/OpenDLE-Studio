import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from './shared/project.js';
import { createRuntime, stepRuntime } from './shared/runtime.js';
import { createPhysics } from './shared/physics.js';
import { addSurfRamp, surfRampSurface } from './shared/engine-script.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(p => new Vector2(p.x, p.y)), holes.map(r => r.map(p => new Vector2(p.x, p.y))));

// A single big ramp in a big room: the simplest possible surf setup.
function build() {
  const project = createProject();
  project.events = [];
  project.map.sectors[0].ceilingHeight = 640;
  for (const v of project.map.vertices) { v.x = Math.sign(v.x) * 1200; v.y = Math.sign(v.y) * 1200; }
  for (const w of project.map.walls) w.height = 640;
  project.map.entities = project.map.entities.filter(e => e.type === 'player');
  // 50 degrees, descends towards +x, 512 wide along the slope, 1024 deep across it.
  const ramp = addSurfRamp(project, { x: 0, y: 0, slope: 50, width: 512, depth: 1024, seat: true });
  const surface = surfRampSurface(ramp);
  return { project, ramp, surface };
}

function trial(label, { startT, startY, keys, angle, tics = 90 }) {
  const { project, ramp, surface } = build();
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.motionModel = 'source';
  state.physics = createPhysics(project, state, R, triangulate);
  const x = surface.lowEdgeX + (surface.highEdgeX - surface.lowEdgeX) * startT;
  state.physics.teleport('player', x, startY, surface.heightAt(x) + 4);
  state.player.angle = angle;
  for (let i = 0; i < 5; i++) stepRuntime(project, state, 1 / 60, new Set());
  let contactTics = 0, top = 0; const trail = [];
  for (let i = 0; i < tics; i++) {
    stepRuntime(project, state, 1 / 60, new Set(keys));
    const p = state.player;
    if (!state.physics.grounded) contactTics++;
    top = Math.max(top, state.speed || 0);
    if (i % 15 === 0) trail.push(`${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`);
  }
  const p = state.player;
  console.log(`${label.padEnd(38)} ${trail.join(' ')} | airborne ${contactTics} | top ${top.toFixed(0)} | end ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`);
  state.physics.dispose();
}

const g = surfRampSurface(build().ramp);
console.log('ramp: low edge', g.lowEdgeX.toFixed(0), 'high', g.highEdgeX.toFixed(0), 'rise', (g.highHeight - g.lowHeight).toFixed(0));
// Near the TOP of the ramp (the high edge is the low-x one), travelling along it in +y.
trial('ride along the ramp (+y)', { startT: 0.9, startY: -460, keys: ['KeyW'], angle: 90 });
trial('ride along the ramp (-y)', { startT: 0.9, startY: 460, keys: ['KeyW'], angle: 270 });
trial('stand still near the top', { startT: 0.9, startY: 0, keys: [], angle: 0 });
trial('push into the slope (-x)', { startT: 0.9, startY: -460, keys: ['KeyW'], angle: 180 });
trial('push down the slope (+x)', { startT: 0.9, startY: -460, keys: ['KeyW'], angle: 0 });
