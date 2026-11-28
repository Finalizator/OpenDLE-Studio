/**
 * Water bodies: the volume, the swim model and what a brush becomes when it is one.
 *
 * The interesting property is not "a brush can be tagged water" — it is that the *same* record
 * decides the swimmer's speed in the editor, in the playtest and in the export, and that a water
 * brush stops being solid everywhere it used to be. These tests pin the maths a GPU-free test can
 * see, plus one real Rapier scene where a player in a pool has to end up floating rather than
 * standing on the water or falling through it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createBoxBrush, brushSurfaceAt, brushVolumes, isWaterBrush, setBrushKind } from '../shared/brushes.js';
import { createPhysics, collisionMesh } from '../shared/physics.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import {
  WATER_DEFAULTS, buoyancyFraction, currentAt, swimLevel, swimTarget, waterAt, waterFromPreset,
  waterPresets, waterSettings, waterSpeedScale, waterVolumes,
} from '../shared/water.js';
import { WATER_SHADER_NAME, waterShaderId, waterShaderTemplate, waterUniforms } from '../shared/shaders.js';
import { readFileSync } from 'node:fs';
import { parseShaderSource } from '../shared/shader-language.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/** A pool from the floor to `top`, around the player's spawn. */
function pool(top = 96, patch = {}) {
  const project = createProject();
  project.events = [];
  const brush = createBoxBrush(project, { x: -260, y: -96, z: 0, width: 160, depth: 192, height: top });
  setBrushKind(project, brush.id, 'water', patch);
  return { project, brushId: brush.id };
}

test('a water body is a brush kind, and its settings fill in from the defaults', () => {
  const { project, brushId } = pool(96, { color: '#2f9fc4' });
  const brush = project.map.brushes.find(entry => entry.id === brushId);
  assert.equal(isWaterBrush(brush), true);
  assert.equal(isWaterBrush(project.map.brushes[0]), true);
  assert.equal(waterSettings(brush).color, '#2f9fc4');
  assert.equal(waterSettings(brush).buoyancy, WATER_DEFAULTS.buoyancy);
  assert.deepEqual(waterSettings(brush).current, { x: 0, y: 0, z: 0 });
  // Turning it solid again forgets nothing: the record is kept for the next time it is water.
  setBrushKind(project, brushId, 'solid');
  assert.equal(isWaterBrush(brush), false);
  assert.equal(brush.water.color, '#2f9fc4');
  validateProject(project);
});

test('the water line is the top of the brush, and a point under it knows how deep', () => {
  const { project, brushId } = pool();
  const volumes = waterVolumes(project.map.brushes);
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].id, brushId);
  assert.equal(volumes[0].surfaceZ, 96);
  const shallow = waterAt(volumes, [-180, 0, 80]);
  assert.equal(shallow.depth, 16);
  assert.equal(shallow.settings.buoyancy, WATER_DEFAULTS.buoyancy);
  assert.equal(waterAt(volumes, [-180, 0, 100]), null, 'above the water line is dry');
  assert.equal(waterAt(volumes, [400, 0, 10]), null, 'outside the pool is dry');
});

test("Doom's waterlevel: ankles is 1, past the middle is 2, a head under is 3", () => {
  const { project } = pool();
  const volumes = waterVolumes(project.map.brushes);
  const at = feet => swimLevel(volumes, { x: -180, y: 0, feet, height: 56 });
  assert.equal(at(96), null, 'standing on the surface is dry');
  assert.equal(at(80).level, 1, '16 units of water is over the ankles');
  assert.equal(at(50).level, 2, 'water past the middle of the body');
  assert.equal(at(20).level, 3, 'a head under the surface');
  assert.equal(at(20).under, 1);
  assert.equal(at(80).surfaceZ, 96);
});

test('a swimmer goes where they look, floats with buoyancy and sinks when it is thin', () => {
  const settings = { ...WATER_DEFAULTS, buoyancy: 1, sinkSpeed: 90, swimSpeed: 200, drag: 3 };
  const idle = swimTarget({ level: 3, settings });
  assert.equal(idle, 0, 'doing nothing in neutral water holds the depth');
  assert.equal(swimTarget({ level: 3, settings, jump: true }), 200, 'a stroke pushes up');
  assert.equal(swimTarget({ level: 2, settings, jump: true }), 200, 'a stroke works past the waist too');
  const up = swimTarget({ level: 3, settings, pitch: .5, forward: 1 });
  const down = swimTarget({ level: 3, settings, pitch: -.5, forward: 1 });
  assert.ok(up > idle && down < idle, 'the view points the way');
  assert.equal(swimTarget({ level: 3, settings, pitch: -.5, forward: -1 }), up, 'backing up reverses the look');
  const floating = swimTarget({ level: 3, settings: { ...settings, buoyancy: 1.5 } });
  assert.ok(floating > idle, 'more buoyancy lifts');
  assert.equal(swimTarget({ level: 3, settings: { ...settings, buoyancy: .5 } }), -60, 'less buoyancy sinks');
  assert.ok(swimTarget({ level: 3, settings: { ...settings, buoyancy: 0 } }) >= -90, 'and never faster than sinkSpeed');
  // Water over the ankles has no vertical model of its own: wading keeps the body's weight.
  assert.equal(swimTarget({ level: 1, settings }), null);
});

test('wading is slower than walking, and swimming is the slowest', () => {
  const settings = { ...WATER_DEFAULTS, speedScale: .5 };
  assert.equal(waterSpeedScale(0, settings), 1);
  assert.ok(waterSpeedScale(1, settings) > waterSpeedScale(2, settings));
  assert.ok(waterSpeedScale(2, settings) > waterSpeedScale(3, settings));
  assert.ok(Math.abs(waterSpeedScale(3, settings) - .5) < 1e-9, 'at the deepest the water has its whole say');
  assert.deepEqual(currentAt({ current: { x: 8, y: 0, z: 0 } }), { x: 8, y: 0, z: 0 });
});

test('a body floats where the water holds the share of it that displaces its weight', () => {
  const { project } = pool();
  const volumes = waterVolumes(project.map.brushes);
  assert.equal(buoyancyFraction(volumes, [-180, 0, 96]).fraction, .5, 'centre at the water line is half in');
  assert.equal(buoyancyFraction(volumes, [-180, 0, 20]).fraction, 1, 'well under the surface is all in');
  assert.equal(buoyancyFraction(volumes, [-180, 0, 140]).fraction, 0, 'well above the surface is dry');
  const partial = buoyancyFraction(volumes, [-180, 0, 88]).fraction;
  assert.ok(partial > .5 && partial < 1, 'the band is a smooth share, not a switch');
});

test('a water brush is not an obstacle: no collision, no trace volume, no surface to stand on', () => {
  const { project } = pool();
  const brush = project.map.brushes[0];
  // A bare map, so the only geometry that could collide is the brush itself.
  project.map.walls = [];
  project.map.sectors = [];
  assert.equal(brushVolumes(project.map.brushes).length, 0, 'bullets and sight pass through');
  assert.equal(collisionMesh(project, triangulate, { sectors: [] }).positions.length, 0, 'nothing to walk into');
  assert.equal(brushSurfaceAt(project.map.brushes, -180, 0), null, 'objects are not placed on top of the water');
  // The same brush as a solid one is all three of those things again.
  setBrushKind(project, brush.id, 'solid');
  assert.equal(brushVolumes(project.map.brushes).length, 1);
  assert.ok(collisionMesh(project, triangulate, { sectors: [] }).positions.length > 0);
  assert.equal(brushSurfaceAt(project.map.brushes, -180, 0), 96);
});

test('presets are a starting point written into the brush, not a link to a table', () => {
  const presets = waterPresets();
  assert.ok(presets.length >= 4);
  const sludge = waterFromPreset('sludge');
  assert.equal(sludge.color, '#4c5b2a');
  assert.ok(sludge.buoyancy < 1, 'sludge does not hold anything up');
  assert.deepEqual(sludge.current, { x: 0, y: 0, z: 0 });
  assert.deepEqual(waterFromPreset('nothing').color, WATER_DEFAULTS.color);
});

test('a water body validates, and a bad one says which number is wrong', () => {
  const { project } = pool(96, { buoyancy: 2 });
  validateProject(project);
  const brush = project.map.brushes[0];
  brush.water.buoyancy = -1;
  assert.throws(() => validateProject(project), /buoyancy/);
  brush.water.buoyancy = 1;
  brush.kind = 'lava';
  assert.throws(() => validateProject(project), /Brush kind/);
  brush.kind = 'water';
  brush.shaderId = 'no-such-shader';
  assert.throws(() => validateProject(project), /unknown shader/);
  delete brush.shaderId;
  brush.faces[0].shaderId = 'no-such-shader';
  assert.throws(() => validateProject(project), /unknown shader/);
  delete brush.faces[0].shaderId;
  brush.water.color = 'blue';
  assert.throws(() => validateProject(project), /#rrggbb/);
});

test('the water shader ships with the engine, parses, and is refreshed rather than frozen', () => {
  const project = createProject();
  const id = waterShaderId(project);
  const shader = project.shaders.find(entry => entry.id === id);
  assert.equal(shader.name, WATER_SHADER_NAME);
  assert.deepEqual(shader.uniforms, { ...waterUniforms });
  parseShaderSource(shader.source, shader.uniforms);
  // Water only: the shipped effect paints the surface and samples nothing else, so there is no
  // land, shoreline or backdrop it could be showing through.
  assert.doesNotMatch(waterShaderTemplate, /iChannel|texture\(/);
  assert.doesNotMatch(waterShaderTemplate.replace(/\/\/.*$/gm, ''), /shore|land|mountain|terrain/i);
  // Called again, it is the same shader — and an old copy in a project is brought up to date.
  shader.source = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }';
  assert.equal(waterShaderId(project), id);
  assert.equal(project.shaders.length, 1);
  assert.equal(project.shaders[0].source, waterShaderTemplate);
  validateProject(project);
});

test('the play view and the editor build a brush surface through one function', () => {
  // Two renderers draw brushes — the game's and the editor's 3D view — and a water body that looked
  // like water in one of them only would be a preview that lies. Both go through `brushSurface`.
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(render, /function brushSurface\(\{ shaderId, base, water \}\)/);
  assert.match(render, /const water = isWaterBrush\(brush\) \? waterSettings\(brush\) : null/);
  assert.match(render, /const surfaceMaterial = brushSurface\(\{ shaderId, base: baseMaterial, water \}\)/);
  assert.match(render, /if \(screenMaterials\.has\(surfaceMaterial\)\) screenObjects\.add\(mesh\)/,
    'a shader that reads the screen gets the background pass drawn');
  assert.match(render, /\n      brushSurface,/, 'and the editor can use it too');
  const scene = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  assert.match(scene, /view\.brushSurface\(\{ shaderId: surface\?\.shaderId \|\| '', base, water: surface\?\.water \|\| null \}\)/);
});

test('a crate dropped into a pool floats instead of lying on the bottom', async t => {
  const project = createProject();
  project.events = [];
  const brush = createBoxBrush(project, { x: -260, y: -96, z: 0, width: 160, depth: 192, height: 96 });
  setBrushKind(project, brush.id, 'water', { buoyancy: 1.6 });
  const crate = project.map.entities.find(entity => entity.type !== 'player');
  // A dynamic box the size of a crate, dropped in the pool but away from the player's spawn —
  // the character controller shoves anything it appears inside, which would push the crate out of
  // the water and turn this into a test of the controller.
  crate.x = -225; crate.y = 60; crate.z = 8;
  crate.physics = { body: 'dynamic', shape: 'box', width: 24, height: 32, depth: 24, radius: 12,
    mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true };
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const tick = (count = 1) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, new Set(), new Set());
  };
  tick(900);
  const live = state.entities.find(entity => entity.id === crate.id);
  // It starts on the pool floor at 8 and the water line is 96: floating means it climbed well off
  // the floor and settled under the surface rather than passing through it.
  assert.ok(live.z > 40, `the crate floated up to ${Number(live.z).toFixed(1)}`);
  assert.ok(live.z < 120, `and did not fly out of the water (${Number(live.z).toFixed(1)})`);
});

test('a player dropped into a pool floats near the surface instead of standing on it', async t => {
  const project = createProject();
  project.events = [];
  // A pool deep enough to be under the surface at the spawn, with the water line at 96.
  const brush = createBoxBrush(project, { x: -260, y: -96, z: 0, width: 160, depth: 192, height: 96 });
  setBrushKind(project, brush.id, 'water', { buoyancy: 1.4, sinkSpeed: 40 });
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const tick = (count = 1) => {
    for (let index = 0; index < count; index++) stepRuntime(project, state, 1 / 60, new Set(), new Set());
  };
  tick(2);
  // The pool is the whole depth of the room, so the player spawns standing on its floor with the
  // water line well over their head.
  assert.equal(state.waterLevel, 3, 'head under the water line');
  // A buoyant pool carries the player up until the water line is at their shoulders, and then
  // holds them there: the level falls to 2 and gravity and buoyancy meet.
  tick(180);
  assert.ok(state.player.z > 55, `the swimmer rose to ${state.player.z.toFixed(1)}`);
  assert.ok(state.player.z < 100, `and did not climb out of the pool (${state.player.z.toFixed(1)})`);
  assert.ok(state.waterLevel >= 1, `floating with the surface at the chest, not under it (${state.waterLevel})`);
});
