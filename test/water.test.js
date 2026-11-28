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
import { WATER_SHADER_NAME, WATER_SHADER_REVISION, refreshShippedShaders, shadertoyFromDownload, waterShaderId, waterShaderTemplate, waterUniforms } from '../shared/shaders.js';
import { WATER_SWELLS, WAVE_DEFAULTS, WAVE_GRAVITY, animateWaterSurface, buildWaterSurface, swellRate, waterHeight, waterSlope, waterSurfaceData } from '../shared/water-surface.js';
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

test('a water body draws its top surface only, unless it was asked to show its volume', async () => {
  const { project } = pool();
  const brush = project.map.brushes[0];
  // Six faces as a solid; the pool draws one of them.
  const { batchBrushes } = await import('../shared/brush-batch.js');
  const waterOnly = batchBrushes(project.map.brushes);
  assert.equal([...waterOnly.batches.values()].length, 1, 'one batch: the top');
  // Turn the volume back on and all six faces are there.
  setBrushKind(project, brush.id, 'water', { surfaceOnly: false });
  const whole = batchBrushes(project.map.brushes);
  const faces = [...whole.batches.values()].reduce((sum, batch) => sum + batch.ranges.length, 0);
  assert.equal(faces, 6, 'a volume meant to be seen from the side draws every face');
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
  assert.equal(shader.builtin, 'water', 'the shader knows it is one of the engine\'s');
  assert.equal(shader.revision, WATER_SHADER_REVISION);
  parseShaderSource(shader.source, shader.uniforms);
  // Water only: the one thing the shipped effect samples is the level behind it, which is what it
  // refracts. There is no land, shoreline or backdrop painted into it.
  assert.equal([...waterShaderTemplate.matchAll(/iChannel\d/g)].every(match => match[0] === 'iChannel0'), true);
  assert.doesNotMatch(waterShaderTemplate.replace(/\/\/.*$/gm, ''), /shore|land|mountain|terrain/i);
  // Called again, it is the same shader, and an edit the mapper made to it is *theirs*: the
  // upgrade path is the revision (see the test below), not a refresh on every call.
  shader.source = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }';
  assert.equal(waterShaderId(project), id);
  assert.equal(project.shaders.length, 1);
  assert.equal(project.shaders[0].source, 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }');
  shader.source = waterShaderTemplate;
  validateProject(project);
});

test('a water surface is a grid that rides the swells, and its shape is the shader\'s', () => {
  const square = [[0, 0, 0], [64, 0, 0], [64, 0, 64], [0, 0, 64]];
  const surface = buildWaterSurface(square, { uvAt: ([x, , z]) => [x / 64, z / 64], water: { cell: 16 } });
  assert.ok(surface, 'a quad becomes a grid');
  assert.ok(surface.positions.length / 3 > 4, `subdivided, not a quad (${surface.positions.length / 3} vertices)`);
  assert.equal(surface.index.length % 3, 0);

  // The two triangles of the fan share the diagonal between them instead of each keeping a copy of
  // it. A vertex that only knows its own triangle gets a shading normal bent halfway towards it, so
  // an unwelded surface draws a crease along every fan edge — visible as a straight line across a
  // pool that should be smooth. Ten vertices a triangle, four of them on the diagonal.
  const welded = buildWaterSurface(square, { uvAt: ([x, , z]) => [x / 64, z / 64], water: { cell: 32 } });
  assert.equal(welded.positions.length / 3, 16, `${welded.positions.length / 3} vertices, not 20`);
  assert.equal(welded.index.length % 3, 0);
  assert.ok(welded.index.every(at => at >= 0 && at < welded.positions.length / 3), 'every index names a welded vertex');

  // The height field is a sum of swells: it is not constant, and it moves with time.
  assert.notEqual(waterHeight(10, 10, 0), waterHeight(90, 40, 0));
  assert.notEqual(waterHeight(10, 10, 0), waterHeight(10, 10, 1));
  // The slope is that field's derivative, which is what the normal is built from.
  const epsilon = .01;
  const slope = waterSlope(40, 20, .5);
  assert.ok(Math.abs(slope[0] - (waterHeight(40 + epsilon, 20, .5) - waterHeight(40 - epsilon, 20, .5)) / (2 * epsilon)) < 1e-6);
  // Seven swells in two tiers, at seven wavelengths: the long ones lift the whole surface and set its
  // scale, the medium ones chop the crests. Every one of them moves the mesh, so every one has to be
  // fine enough for the grid — and none is a harmonic of another, because two directions alone draw
  // straight parallel crests across a whole pool, which is what the surface looked like when it was
  // combed.
  assert.equal(WATER_SWELLS.length, 7);
  assert.equal(WATER_SWELLS.filter(swell => swell.tier === 'large').length, 4);
  assert.equal(WATER_SWELLS.filter(swell => swell.tier === 'medium').length, 3);
  assert.equal(new Set(WATER_SWELLS.map(swell => swell.length)).size, 7);
  // No one swell may carry the surface: a dominant wavelength is a visible ridge that runs straight
  // across the pool, however many smaller ones ride on it.
  const tallest = Math.max(...WATER_SWELLS.map(swell => swell.amplitude));
  const total = WATER_SWELLS.reduce((sum, swell) => sum + swell.amplitude, 0);
  assert.ok(tallest / total < 0.2, `${(tallest / total).toFixed(2)} of the height is one swell`);
  for (const swell of WATER_SWELLS) {
    assert.ok(swell.length >= WAVE_DEFAULTS.cell * 3, `a ${swell.length}-unit swell needs a grid finer than ${WAVE_DEFAULTS.cell}`);
  }
  // Deep-water dispersion: a long swell travels faster than a short one, and every swell crosses a
  // wavelength in well under two seconds. The first version took nine, which is a slow picture of
  // water rather than water.
  const [longest, shortest] = [WATER_SWELLS[0], WATER_SWELLS[WATER_SWELLS.length - 1]];
  // Phase speed — how fast a crest travels — is what a wave looks like, not its angular frequency.
  const speedOf = length => swellRate(length) / ((Math.PI * 2) / length);
  assert.ok(speedOf(longest.length) > speedOf(shortest.length),
    `${speedOf(longest.length).toFixed(0)} vs ${speedOf(shortest.length).toFixed(0)} units/s`);
  assert.ok(speedOf(longest.length) > 60, 'a swell crosses the room rather than crawling');
  for (const swell of WATER_SWELLS) {
    const period = (Math.PI * 2) / swellRate(swell.length);
    assert.ok(period < 1, `${swell.length} units takes ${period.toFixed(2)}s to pass`);
  }

  // The geometry really moves.
  const geometry = {
    attributes: { position: { array: Float32Array.from(surface.positions), needsUpdate: false } },
    userData: { waterSurface: waterSurfaceData(surface.positions, surface.uvs, [0, 1, 0], { height: 8, speed: 1 }) },
  };
  const before = Float32Array.from(geometry.attributes.position.array);
  assert.equal(animateWaterSurface(geometry, 1.5), true);
  assert.ok(geometry.attributes.position.needsUpdate);
  let moved = 0;
  for (let index = 1; index < before.length; index += 3) if (Math.abs(before[index] - geometry.attributes.position.array[index]) > 1e-4) moved++;
  assert.ok(moved > 2, `${moved} vertices of ${before.length / 3} ride the swell`);
});

test('the shader is told the real surface and the real camera, not a guess from the screen', () => {
  // The first water shader worked out an "eye" from the pixel's place on the viewport. Every
  // highlight then followed the *screen* rather than the wave, which drew long parallel stripes
  // across the water at any angle. A surface effect is handed where the pixel is, which way its
  // surface faces and where the camera stands, and nothing has to be guessed.
  assert.ok(waterShaderTemplate.includes('normalize(surfaceNormal)'));
  assert.ok(waterShaderTemplate.includes('normalize(eyePosition - worldPosition)'));
  assert.ok(!/view - 0\.5/.test(waterShaderTemplate), 'no fake eye from the viewport');
  // The swell table belongs to the mesh; the shader must not carry a second copy that can drift.
  for (const swell of WATER_SWELLS) {
    assert.ok(!waterShaderTemplate.includes(`6.2831853 / ${swell.length}.0`), `${swell.length} is the mesh's`);
  }
  // What the mesh cannot carry it does, in world space.
  assert.ok(waterShaderTemplate.includes('worldPosition.xz'));
  // The look is modelled on the Godot ocean shader the user supplied: three ripple layers blended
  // at falling weights, choppiness on their tilt, and exponential absorption of the water column.
  // A single family of sines reads as corrugation, and flat tint reads as a blue picture.
  assert.equal((waterShaderTemplate.match(/rippleLayer\(worldPosition\.xz/g) || []).length, 3,
    'three ripple layers, not one repeating pattern');
  assert.match(waterShaderTemplate, /\* 0\.5\b[\s\S]*\* 0\.25\b/, 'blended at falling weights');
  assert.ok(waterShaderTemplate.includes('detail *= chop'), 'choppiness tilts the surface');
  assert.match(waterShaderTemplate, /exp\(-[\d.]+ \* column\)/, 'the water column absorbs exponentially');
  assert.match(waterShaderTemplate, /pow\(1\.0 - facing, fresnel\)/, 'fresnel is the dial it says it is');
  // Godot reads the scene depth to know how much water is in the way. A surface effect here is
  // handed no depth buffer, so the column has to be derived from the view or not exist at all.
  assert.ok(!/DEPTH_TEXTURE|depthTexture/.test(waterShaderTemplate), 'no depth texture to sample');
  // Every dial has to be read by the shader, or it is a slider that does nothing. The two that are
  // not are the mesh's, and the mesh reads them.
  const unused = Object.keys(waterUniforms).filter(name => !new RegExp(`\\b${name}\\b`).test(waterShaderTemplate));
  assert.deepEqual(unused.sort(), ['waveHeight', 'waveSpeed'], 'every other dial drives the shading');
});

test('the play view and the editor build a brush surface through one function', () => {
  // Two renderers draw brushes — the game's and the editor's 3D view — and a water body that looked
  // like water in one of them only would be a preview that lies. Both go through `brushSurface`,
  // and both hand the renderer the same clock for the swells.
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(render, /function brushSurface\(\{ shaderId, base, water \}\)/);
  assert.match(render, /const water = isWaterBrush\(brush\) \? waterSettings\(brush\) : null/);
  assert.match(render, /const \{ material: surfaceMaterial, waves \} = brushSurface\(\{ shaderId, base: baseMaterial, water \}\)/);
  assert.match(render, /if \(screenMaterials\.has\(surfaceMaterial\)\) screenObjects\.add\(mesh\)/,
    'a shader that reads the screen gets the background pass drawn');
  assert.match(render, /mesh\.onBeforeRender = \(\) => animateWaterSurface\(buffer, engineWaterTime\(\)\)/,
    'the swells are moved as the surface is drawn, whoever asked for the frame');
  assert.match(render, /const engineWaterTime = \(\) => \(editor \? performance\.now\(\) \/ 1000/,
    'the editor has no game clock, so it animates on its own');
  assert.match(render, /\n      brushSurface,/, 'and the editor can use it too');
  const scene = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  assert.match(scene, /view\.brushSurface\(\{ shaderId: surface\?\.shaderId \|\| '', base, water: surface\?\.water \|\| null \}\)/);
  assert.match(scene, /mesh\.onBeforeRender = \(\) => view\.animateWater\?\.\(mesh\)/, 'the editor hands its water to the renderer to move');
  assert.match(scene, /view\.trackScreen\?\.\(mesh, built\.material\)/, 'and the refraction gets its background pass');
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
