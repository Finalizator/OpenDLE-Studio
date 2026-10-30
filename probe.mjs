import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from './shared/project.js';
import { createRuntime } from './shared/runtime.js';
import { createPhysics } from './shared/physics.js';
import { buildSurfTestMap } from './shared/scriptlets.js';
import { surfRampSurface } from './shared/engine-script.js';
await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(p => new Vector2(p.x, p.y)), holes.map(r => r.map(p => new Vector2(p.x, p.y))));
const project = buildSurfTestMap(createProject());
const state = createRuntime(project, { screen: 'playing', gameMode: true });
state.physics = createPhysics(project, state, R, triangulate);
const world = state.physics.world;
const ceiling = project.map.sectors[0].ceilingHeight;
for (const id of project.sourceMovementRamps) {
  const e = project.map.entities.find(x => x.id === id);
  const s = surfRampSurface(e);
  const probes = [];
  for (const t of [0.05, 0.5, 0.7, 0.9]) {
    const x = s.lowEdgeX + (s.highEdgeX - s.lowEdgeX) * t;
    const from = ceiling - 8;
    const hit = world.castRay(new R.Ray({ x: x / 64, y: from / 64, z: e.y / 64 }, { x: 0, y: -1, z: 0 }), from / 64 + 2, true);
    const parent = hit?.collider.parent();
    const at = parent ? ` at ${(parent.translation().x * 64).toFixed(0)},${(parent.translation().z * 64).toFixed(0)}` : '';
    probes.push(`x=${x.toFixed(0)} analytic ${s.heightAt(x).toFixed(0)} actual ${hit ? (from - hit.timeOfImpact * 64).toFixed(0) : 'miss'}${at}`);
  }
  console.log(id, 'edges', s.lowEdgeX.toFixed(0), '->', s.highEdgeX.toFixed(0), 'surface', s.lowHeight.toFixed(0), '->', s.highHeight.toFixed(0));
  console.log('  ' + probes.join(' | '));
}
